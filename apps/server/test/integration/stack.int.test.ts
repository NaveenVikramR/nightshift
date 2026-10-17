/**
 * Integration test against the local docker stack (demo-target, Prometheus,
 * Alertmanager). Run: npm run stack:up && npm run test:integration
 *
 * Uses the REAL HTTP clients, the real service catalog (config/nightshift.yaml)
 * and the real ingest deploy source, with in-memory stores.
 */
import { appendFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpAlertmanagerClient } from '../../src/clients/alertmanager.js';
import {
  DeploySourceRouter,
  GitHubDeploySource,
  IngestDeploySource,
} from '../../src/clients/deploys.js';
import { HttpPrometheusClient } from '../../src/clients/prometheus.js';
import { loadServiceConfig } from '../../src/serviceConfig.js';
import { explainIncident, type ExplainData } from '../../src/tools/explain_incident.js';
import { getServiceHealth } from '../../src/tools/get_service_health.js';
import { listActiveAlerts } from '../../src/tools/list_active_alerts.js';
import type { ToolDefinition, ToolDeps } from '../../src/tools/types.js';
import { InMemoryAuditLog } from '../fakes/inMemoryAuditLog.js';
import { AdminApiExecutor } from '../../src/domain/actions/executors/adminApi.js';
import { ExecutorRegistry } from '../../src/domain/actions/executors/registry.js';
import type { ActionExecutor } from '../../src/domain/actions/executors/types.js';
import { confirmAction, type ConfirmData } from '../../src/tools/confirm_action.js';
import { prepareAction, type PreparedData } from '../../src/tools/prepare_action.js';
import { createPostureScanner } from '../../src/domain/posture/index.js';
import { InMemoryPendingActionStore } from '../fakes/fakeActions.js';
import { InMemorySecurityStore } from '../fakes/fakeSecurity.js';
import { InMemoryDeployStore } from '../fakes/fakeDeploys.js';
import {
  InMemoryAckStore,
  InMemoryIncidentStore,
  InMemorySilenceStore,
} from '../fakes/memoryStores.js';
import { ALICE, BOB, invoke } from '../fakes/toolDeps.js';

const infraEnv = resolve(__dirname, '../../../../infra/.env');
if (existsSync(infraEnv)) process.loadEnvFile(infraEnv);
const DEMO = process.env['DEMO_TARGET_URL'] ?? 'http://127.0.0.1:18080';
const TOKEN = process.env['DEMO_ADMIN_TOKEN'] ?? '';

const deployStore = new InMemoryDeployStore();
/** Tests move this forward to pass time-based limits (e.g. 1 scan per minute) without sleeping. */
let clockOffsetMs = 0;
const clock = () => new Date(Date.now() + clockOffsetMs);
const catalog = loadServiceConfig(resolve(__dirname, '../../config/nightshift.yaml'), process.env);

/** The real admin-API executor, wrapped to count executions. */
const adminCfg = catalog.executors['demo-admin']!;
if (adminCfg.type !== 'admin_api') throw new Error('demo-admin must be an admin_api executor');
const realAdmin = new AdminApiExecutor('demo-admin', adminCfg.url, TOKEN, adminCfg.timeoutMs);
const executions: string[] = [];
const countingAdmin: ActionExecutor = {
  name: realAdmin.name,
  type: realAdmin.type,
  supports: (a) => realAdmin.supports(a),
  state: (s) => realAdmin.state(s),
  execute: async (a) => {
    executions.push(a.action);
    return realAdmin.execute(a);
  },
};
const deps: ToolDeps = {
  audit: new InMemoryAuditLog(),
  prometheus: new HttpPrometheusClient(catalog.prometheus.url, catalog.prometheus.timeoutMs),
  alertmanager: new HttpAlertmanagerClient(
    catalog.alertmanager.url,
    catalog.alertmanager.timeoutMs,
  ),
  services: catalog.services,
  acks: new InMemoryAckStore(),
  silences: new InMemorySilenceStore(),
  deploys: new DeploySourceRouter({
    ingest: new IngestDeploySource(deployStore),
    github: new GitHubDeploySource(catalog.github.apiUrl, undefined, catalog.github.timeoutMs),
  }),
  incidents: new InMemoryIncidentStore(),
  executors: new ExecutorRegistry(new Map([['demo-admin', countingAdmin]])),
  deployLog: deployStore,
  pendingActions: new InMemoryPendingActionStore(),
  security: new InMemorySecurityStore(),
  posture: createPostureScanner({
    security: catalog.security,
    services: catalog.services,
    prometheus: new HttpPrometheusClient(catalog.prometheus.url, catalog.prometheus.timeoutMs),
    githubApiUrl: catalog.github.apiUrl,
    githubToken: undefined,
    now: () => new Date(),
  }),
  timeZone: catalog.display.timeZone,
  now: clock,
  serverVersion: 'integration',
  startedAt: new Date(),
};

async function chaos(path: string): Promise<void> {
  const res = await fetch(`${DEMO}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`demo-target ${path} -> ${res.status}`);
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await probe().catch(() => undefined);
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  if (!TOKEN)
    throw new Error('DEMO_ADMIN_TOKEN missing: create infra/.env (see infra/.env.example)');
  for (const [name, url] of [
    ['demo-target', `${DEMO}/healthz`],
    ['Prometheus', `${catalog.prometheus.url}/-/ready`],
    ['Alertmanager', `${catalog.alertmanager.url}/-/ready`],
  ] as const) {
    const ok = await fetch(url)
      .then((r) => r.ok)
      .catch(() => false);
    if (!ok) throw new Error(`${name} is not reachable at ${url}. Run: npm run stack:up`);
  }
  await chaos('/admin/reset');
});

afterAll(async () => {
  await chaos('/admin/reset').catch(() => undefined);
});

describe('live stack', () => {
  it('Prometheus scrapes demo-target', async () => {
    const up = await deps.prometheus.instant('up{job="demo-target"}');
    expect(up[0]?.value).toBe(1);
  });

  it('provider_outage fires CircuitBreakerOpen and HighErrorRate, and the tools report it', async () => {
    await chaos('/admin/chaos/provider_outage');

    const alerts = await waitFor('outage alerts to fire', async () => {
      const all = await deps.alertmanager.listAlerts();
      const names = all
        .filter((a) => a.labels['service'] === 'payments-api')
        .map((a) => a.labels['alertname']);
      return names.includes('CircuitBreakerOpen') && names.includes('HighErrorRate')
        ? all
        : undefined;
    });
    expect(alerts.length).toBeGreaterThanOrEqual(2);

    const list = await invoke(listActiveAlerts as unknown as ToolDefinition, deps, {}, BOB);
    expect(list.isError).toBe(false);
    expect(list.speak).toMatch(/^Critical: \d+ alerts are firing\. Worst is /);

    const health = await invoke(
      getServiceHealth as unknown as ToolDefinition,
      deps,
      { service: 'payments' },
      BOB,
    );
    expect(health.data['status']).toBe('critical');
    expect(health.speak).toMatch(
      /^Critical: payments API has errors at \d+ percent and razorpay breaker open/,
    );
  });

  it('after reset the service reports healthy again', async () => {
    await chaos('/admin/reset');
    const health = await waitFor('payments to recover', async () => {
      const r = await invoke(
        getServiceHealth as unknown as ToolDefinition,
        deps,
        { service: 'payments' },
        BOB,
      );
      return r.data['status'] === 'healthy' ? r : undefined;
    });
    expect(health.speak).toMatch(/^Payments API is healthy/);
  });

  it('bad_deploy: explain_incident blames the deploy and the razorpay breaker', async () => {
    const payments = catalog.services.find((s) => s.name === 'payments-api')!;
    const deployedAt = new Date();
    // What POST /events/deploy stores for a CI deploy (the route itself is unit-tested).
    await deployStore.insertOnce({
      source: 'integration-ci',
      externalId: `int-${deployedAt.getTime()}`,
      service: payments.name,
      environment: payments.deploys?.environment ?? 'production',
      version: 'v1.4.2',
      commitSha: null,
      commitMessage: 'tune payment retry config',
      author: 'ci',
      status: 'success',
      deployedAt,
    });
    await chaos('/admin/chaos/bad_deploy?delaySeconds=20');

    // Wait for alerts that started after this deploy (older ones may still be resolving).
    await waitFor('bad_deploy alerts to fire', async () => {
      const fresh = (await deps.alertmanager.listAlerts()).filter(
        (a) => a.labels['service'] === 'payments-api' && a.startsAt >= deployedAt,
      );
      const names = fresh.map((a) => a.labels['alertname']);
      return names.includes('HighErrorRate') && names.includes('CircuitBreakerOpen')
        ? true
        : undefined;
    });

    const r = await invoke<ExplainData>(
      explainIncident as unknown as ToolDefinition,
      deps,
      { service: 'payments' },
      BOB,
    );
    expect(r.isError).toBe(false);
    expect(new Set(r.data.causes.slice(0, 2).map((c) => c.id))).toEqual(
      new Set(['recent_deploy', 'provider_failure']),
    );
    const relation = r.data.relations[0]!;
    expect(relation).toMatchObject({
      kind: 'breaker_after_deploy',
      dependency: 'razorpay',
      version: 'v1.4.2',
    });
    expect(Date.parse(relation.openedAt)).toBeGreaterThanOrEqual(deployedAt.getTime());
    expect(r.speak).toContain('version 1.4.2'); // the recorded version, spoken
    expect(r.speak).toMatch(/^Critical\./);
    expect(r.speak.split(/\s+/).length).toBeLessThanOrEqual(30);
  });
});

/** Set NS_SPEAK_LOG to a file path to record every spoken reply (for reports). */
const spoke = (step: string, speak: string): void => {
  const file = process.env['NS_SPEAK_LOG'];
  if (file) appendFileSync(file, `${step}: ${speak}\n`);
};

describe('remediation (two-phase) against the stack', () => {
  const payments = catalog.services.find((s) => s.name === 'payments-api')!;
  const errorRate = async () =>
    (await deps.prometheus.instant(payments.queries.errorRate))[0]?.value ?? NaN;
  const demoState = async () =>
    (await (
      await fetch(`${DEMO}/admin/state`, { headers: { authorization: `Bearer ${TOKEN}` } })
    ).json()) as { activeProvider: string; version: string };
  const prepare = (input: unknown) =>
    invoke<PreparedData>(
      prepareAction as unknown as ToolDefinition,
      deps,
      input,
      ALICE,
      'int-session',
    );
  const confirm = (id: string) =>
    invoke<ConfirmData>(
      confirmAction as unknown as ToolDefinition,
      deps,
      { confirmation_id: id },
      ALICE,
      'int-session',
    );

  /** Start each flow from a quiet system (errors back under the threshold). */
  async function quiet(): Promise<void> {
    await chaos('/admin/reset');
    await waitFor('errors to settle', async () =>
      (await errorRate()) < payments.thresholds.errorRate ? true : undefined,
    );
  }

  it('bad_deploy → explain_incident → prepare rollback → confirm → errors recover', async () => {
    await quiet();
    const deployedAt = new Date();
    for (const [version, at] of [
      ['v1.4.1', new Date(deployedAt.getTime() - 2 * 60 * 60_000)],
      ['v1.4.2', deployedAt],
    ] as const) {
      await deployStore.insertOnce({
        source: 'integration-ci',
        externalId: `int-rb-${version}-${deployedAt.getTime()}`,
        service: payments.name,
        environment: 'production',
        version,
        commitSha: null,
        commitMessage: null,
        author: 'ci',
        status: 'success',
        deployedAt: at,
      });
    }
    await chaos('/admin/chaos/bad_deploy?delaySeconds=20');
    await waitFor('fresh outage alerts', async () => {
      const names = (await deps.alertmanager.listAlerts())
        .filter((a) => a.labels['service'] === 'payments-api' && a.startsAt >= deployedAt)
        .map((a) => a.labels['alertname']);
      return names.includes('HighErrorRate') && names.includes('CircuitBreakerOpen')
        ? true
        : undefined;
    });

    const explained = await invoke<ExplainData>(
      explainIncident as unknown as ToolDefinition,
      deps,
      { service: 'payments' },
      ALICE,
    );
    spoke('bad_deploy explain_incident', explained.speak);
    const rollback = explained.data.causes
      .flatMap((c) => c.suggestedActions)
      .find((a) => a.action === 'rollback_deploy');
    expect(rollback).toMatchObject({ params: { service: 'payments-api', fromVersion: 'v1.4.2' } });

    const prepared = await prepare({ suggested_action: rollback });
    spoke('bad_deploy prepare_action', prepared.speak);
    expect(prepared.isError, prepared.speak).toBe(false);
    expect(prepared.speak).toBe(
      'This will roll payments API back from version 1.4.2 to version 1.4.1. You can redeploy it later. Shall I go ahead?',
    );

    const done = await confirm(prepared.data.confirmationId);
    expect(done.isError, done.speak).toBe(false);
    spoke('bad_deploy confirm_action', done.speak);
    expect(done.speak).toMatch(/^Done\. Payments API is back on version 1\.4\.1\. /);
    expect(['recovering', 'recovered']).toContain(done.data.verification?.outcome);
    expect((await demoState()).version).toBe('v1.4.1');
    await waitFor(
      'errors under the threshold after rollback',
      async () => ((await errorRate()) < payments.thresholds.errorRate ? true : undefined),
      90_000,
    );
  });

  it('provider_outage → prepare failover → confirm → recovers; a second confirm is "already done"', async () => {
    await quiet();
    const started = new Date();
    await chaos('/admin/chaos/provider_outage');
    await waitFor('breaker open alert', async () =>
      (await deps.alertmanager.listAlerts()).some(
        (a) => a.labels['alertname'] === 'CircuitBreakerOpen' && a.startsAt >= started,
      )
        ? true
        : undefined,
    );

    const prepared = await prepare({
      action: 'failover_provider',
      service: 'payments',
      params: { to: 'stripe' },
    });
    spoke('provider_outage prepare_action', prepared.speak);
    expect(prepared.isError, prepared.speak).toBe(false);
    expect(prepared.speak).toBe(
      'This will route all payments API traffic from Razorpay to Stripe. You can switch back anytime. Shall I go ahead?',
    );

    const before = executions.length;
    const done = await confirm(prepared.data.confirmationId);
    expect(done.isError, done.speak).toBe(false);
    spoke('provider_outage confirm_action', done.speak);
    expect(done.speak).toMatch(/^Done\. Payments API now uses Stripe\. /);
    expect(['recovering', 'recovered']).toContain(done.data.verification?.outcome);
    expect((await demoState()).activeProvider).toBe('stripe');
    expect(executions.length).toBe(before + 1);

    const again = await confirm(prepared.data.confirmationId);
    spoke('provider_outage confirm_action again', again.speak);
    expect(again.speak).toBe("That's already done.");
    expect(again.data.replayed).toBe(true);
    expect(executions.length).toBe(before + 1); // never re-executed
  });
});
