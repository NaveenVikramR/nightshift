/**
 * Integration test against the local docker stack (demo-target, Prometheus,
 * Alertmanager). Run: npm run stack:up && npm run test:integration
 *
 * Uses the REAL HTTP clients, the real service catalog (config/nightshift.yaml)
 * and the real ingest deploy source, with in-memory stores.
 */
import { existsSync } from 'node:fs';
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
import { ExecutorRegistry } from '../../src/domain/actions/executors/registry.js';
import { InMemoryPendingActionStore } from '../fakes/fakeActions.js';
import { InMemoryDeployStore } from '../fakes/fakeDeploys.js';
import {
  InMemoryAckStore,
  InMemoryIncidentStore,
  InMemorySilenceStore,
} from '../fakes/memoryStores.js';
import { BOB, invoke } from '../fakes/toolDeps.js';

const infraEnv = resolve(__dirname, '../../../../infra/.env');
if (existsSync(infraEnv)) process.loadEnvFile(infraEnv);
const DEMO = process.env['DEMO_TARGET_URL'] ?? 'http://127.0.0.1:18080';
const TOKEN = process.env['DEMO_ADMIN_TOKEN'] ?? '';

const deployStore = new InMemoryDeployStore();
const catalog = loadServiceConfig(resolve(__dirname, '../../config/nightshift.yaml'), process.env);
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
  executors: ExecutorRegistry.fromConfig(catalog, process.env),
  pendingActions: new InMemoryPendingActionStore(),
  timeZone: catalog.display.timeZone,
  now: () => new Date(),
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
