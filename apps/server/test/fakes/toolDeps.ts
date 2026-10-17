import type { AuthInfo, CallToolResult } from '@modelcontextprotocol/server';
import { parseServiceConfig, type ServiceDef } from '../../src/serviceConfig.js';
import { runTool } from '../../src/tools/runTool.js';
import type { ToolDefinition, ToolDeps } from '../../src/tools/types.js';
import { FakeAlertmanager } from './fakeAlertmanager.js';
import { ExecutorRegistry } from '../../src/domain/actions/executors/registry.js';
import { FakeExecutor, InMemoryPendingActionStore } from './fakeActions.js';
import { FakeDeploys, InMemoryDeployStore } from './fakeDeploys.js';
import { FakePrometheus } from './fakePrometheus.js';
import { InMemoryAuditLog } from './inMemoryAuditLog.js';
import { InMemoryAckStore, InMemoryIncidentStore, InMemorySilenceStore } from './memoryStores.js';

/** Test catalog: queries are short tokens so FakePrometheus answers are easy to script. */
export const TEST_SERVICES: readonly ServiceDef[] = parseServiceConfig(
  {
    prometheus: { url: 'http://prom.test' },
    alertmanager: { url: 'http://am.test' },
    executors: {
      'demo-admin': { type: 'admin_api', url: 'http://demo.test', tokenEnv: 'DEMO_ADMIN_TOKEN' },
    },
    services: [
      {
        name: 'payments-api',
        displayName: 'payments API',
        aliases: ['payments', 'payment api', 'checkout'],
        queries: {
          errorRate: 'payments:errorRate',
          latencyP95: 'payments:latencyP95',
          throughput: 'payments:throughput',
          breakers: 'payments:breakers',
          authFailures: 'payments:authFailures',
          activeProvider: 'payments:activeProvider',
        },
        actions: {
          failover_provider: { executor: 'demo-admin', providers: ['razorpay', 'stripe'] },
          rollback_deploy: { executor: 'demo-admin' },
          restart_service: { executor: 'demo-admin' },
        },
      },
      {
        name: 'webhook-receiver',
        displayName: 'webhook receiver',
        aliases: ['webhooks', 'payment webhooks'],
        queries: {
          errorRate: 'webhooks:errorRate',
          latencyP95: 'webhooks:latencyP95',
          throughput: 'webhooks:throughput',
          webhookFailures: 'webhooks:webhookFailures',
        },
      },
    ],
  },
  {},
).services;

export const NOW = new Date('2026-10-16T12:00:00Z');

export function fakeToolDeps(services: readonly ServiceDef[] = TEST_SERVICES) {
  const clock = { now: NOW };
  const now = () => clock.now;
  const audit = new InMemoryAuditLog();
  const prometheus = new FakePrometheus();
  const alertmanager = new FakeAlertmanager();
  const acks = new InMemoryAckStore(now);
  const silences = new InMemorySilenceStore(now);
  const deploys = new FakeDeploys();
  const deployStore = new InMemoryDeployStore(now);
  const incidents = new InMemoryIncidentStore(now);
  const executor = new FakeExecutor();
  const executors = new ExecutorRegistry(new Map([[executor.name, executor]]));
  const pendingActions = new InMemoryPendingActionStore(now);
  const deps: ToolDeps = {
    audit,
    prometheus,
    alertmanager,
    services,
    acks,
    silences,
    deploys,
    incidents,
    executors,
    pendingActions,
    deployLog: deployStore,
    sleep: async () => {},
    timeZone: 'UTC',
    now,
    serverVersion: '0.1.0',
    startedAt: new Date('2026-10-16T11:00:00Z'),
  };
  return {
    deps,
    clock,
    audit,
    prometheus,
    alertmanager,
    acks,
    silences,
    deploys,
    deployStore,
    incidents,
    executor,
    pendingActions,
  };
}

export function authFor(actor: string, role: 'viewer' | 'responder'): AuthInfo {
  return { token: 'x', clientId: actor, scopes: [role], extra: { actor, role } };
}

export const ALICE = authFor('alice', 'responder');
export const BOB = authFor('bob', 'viewer');

export interface Invoked<D = Record<string, unknown>> {
  result: CallToolResult;
  speak: string;
  data: D;
  isError: boolean;
}

/** Run a tool through the real runTool pipeline (auth → validation → handler → audit). */
export async function invoke<D = Record<string, unknown>>(
  def: ToolDefinition,
  deps: ToolDeps,
  input: unknown,
  auth: AuthInfo = ALICE,
  sessionId?: string,
): Promise<Invoked<D>> {
  const result = await runTool(def, deps, input, auth, sessionId);
  const sc = result.structuredContent as { speak: string; data: D };
  return { result, speak: sc.speak, data: sc.data, isError: result.isError === true };
}

/** Voice contract checks: ≤ 30 words, no markdown, URLs, UUIDs or long hex ids. */
export function expectSpeakable(speak: string): void {
  const words = speak.trim().split(/\s+/).length;
  if (words > 30) throw new Error(`speak has ${words} words (> 30): ${speak}`);
  if (/[*_`#[\]]|https?:|[0-9a-f]{8}-[0-9a-f]{4}|[0-9a-f]{12,}/i.test(speak)) {
    throw new Error(`speak contains markdown, a URL or an ID: ${speak}`);
  }
}
