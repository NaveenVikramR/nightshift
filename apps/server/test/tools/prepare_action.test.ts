import { describe, expect, it } from 'vitest';
import { quoteUntrusted } from '../../src/lib/untrusted.js';
import { explainIncident, type ExplainData } from '../../src/tools/explain_incident.js';
import { prepareAction, type PreparedData } from '../../src/tools/prepare_action.js';
import type { ToolDefinition } from '../../src/tools/types.js';
import { ALICE, BOB, expectSpeakable, fakeToolDeps, invoke, NOW } from '../fakes/toolDeps.js';
import { applyScenario } from '../fixtures/scenarios.js';

const tool = prepareAction as unknown as ToolDefinition;
type Fakes = ReturnType<typeof fakeToolDeps>;
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

/** Live instant values: razorpay broken (or not), errors high (or not). */
function live(f: Fakes, opts: { razorpay?: 0 | 1; stripe?: 0 | 1; errorRate?: number } = {}) {
  f.prometheus
    .set('payments:breakers', [
      { labels: { provider: 'razorpay' }, value: opts.razorpay ?? 1 },
      { labels: { provider: 'stripe' }, value: opts.stripe ?? 0 },
    ])
    .set('payments:errorRate', opts.errorRate ?? 0.45);
}

function setup() {
  const f = fakeToolDeps();
  live(f);
  return f;
}

const prepare = (f: Fakes, input: unknown, auth = ALICE, session = 'session-1') =>
  invoke<PreparedData>(tool, f.deps, input, auth, session);

describe('prepare_action', () => {
  it('prepares a failover: asks first, stores a 2-minute confirmation, changes nothing', async () => {
    const f = setup();
    const r = await prepare(f, {
      action: 'failover_provider',
      service: 'payments',
      params: { to: 'stripe' },
    });

    expect(r.isError).toBe(false);
    expect(r.speak).toBe(
      'This will route all payments API traffic from Razorpay to Stripe. You can switch back anytime. Shall I go ahead?',
    );
    expectSpeakable(r.speak);
    expect(r.data).toMatchObject({
      action: 'failover_provider',
      service: 'payments-api',
      params: {
        action: 'failover_provider',
        service: 'payments-api',
        from: 'razorpay',
        to: 'stripe',
      },
      expiresAt: '2026-10-16T12:02:00.000Z',
      expiresInSeconds: 120,
      summary: { undo: 'Fail back to Razorpay at any time.' },
    });
    expect(r.data.confirmationId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(r.speak).not.toContain(r.data.confirmationId);

    const row = f.pendingActions.rows.get(r.data.confirmationId)!;
    expect(row).toMatchObject({
      status: 'pending',
      createdBy: 'alice',
      sessionId: 'session-1',
      expiresAt: new Date('2026-10-16T12:02:00Z'),
    });
    expect(row.paramsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(f.executor.executed).toEqual([]); // no side effect on the target
    expect(f.audit.entries.at(-1)).toMatchObject({
      actor: 'alice',
      tool: 'prepare_action',
      outcome: 'ok',
    });
  });

  it('gives each preparation a fresh, unguessable id', async () => {
    const f = setup();
    const input = { action: 'failover_provider', params: { service: 'payments', to: 'stripe' } };
    const a = await prepare(f, input);
    const b = await prepare(f, input);
    expect(a.data.confirmationId).not.toBe(b.data.confirmationId);
  });

  it('refuses a viewer and stores nothing (invariant 4)', async () => {
    const f = setup();
    const r = await prepare(
      f,
      { action: 'failover_provider', params: { service: 'payments', to: 'stripe' } },
      BOB,
    );
    expect(r.isError).toBe(true);
    expect(r.data).toEqual({ error: 'forbidden' });
    expect(f.pendingActions.rows.size).toBe(0);
    expect(f.audit.entries.at(-1)).toMatchObject({ actor: 'bob', outcome: 'forbidden' });
  });

  it('accepts a suggested action from explain_incident unchanged, and links the incident', async () => {
    const f = fakeToolDeps();
    applyScenario(f, 'bad_deploy');
    live(f);
    const explained = await invoke<ExplainData>(
      explainIncident as unknown as ToolDefinition,
      f.deps,
      {},
      ALICE,
    );
    const suggestion = explained.data.causes[0]!.suggestedActions[0]!;
    expect(suggestion.action).toBe('failover_provider');

    const r = await prepare(f, { suggested_action: suggestion });
    expect(r.isError).toBe(false);
    expect(r.data.incidentId).toBe(explained.data.incidentId);
    expect(f.incidents.events.at(-1)).toMatchObject({
      kind: 'action',
      actor: 'alice',
      message: 'prepared failover_provider razorpay -> stripe (expires in 2 min)',
    });
  });

  it.each([
    [
      { razorpay: 1, stripe: 0 },
      { to: 'stripe' },
      { activeProvider: 'stripe' },
      'Payments API already uses Stripe. Nothing to do.',
    ],
    [
      { razorpay: 0, stripe: 0, errorRate: 0.004 },
      { to: 'stripe' },
      {},
      "Razorpay looks healthy, so I won't fail over.",
    ],
    [
      { razorpay: 1, stripe: 1 },
      { to: 'stripe' },
      {},
      "Stripe looks unhealthy too, so failing over won't help.",
    ],
    [{}, { to: 'paypal' }, {}, 'I can only route payments API to Razorpay or Stripe.'],
    [
      {},
      { to: 'stripe', from: 'stripe' },
      {},
      'Payments API uses Razorpay, not Stripe. Nothing changed.',
    ],
  ] as const)(
    'refuses a failover when preconditions fail (%o %o)',
    async (metrics, params, state, speak) => {
      const f = fakeToolDeps();
      live(f, metrics);
      Object.assign(f.executor.state_, state);
      const r = await prepare(f, {
        action: 'failover_provider',
        params: { service: 'payments', ...params },
      });
      expect(r.isError).toBe(true);
      expect(r.speak).toBe(speak);
      expect(f.pendingActions.rows.size).toBe(0);
    },
  );

  it('refuses when the target state cannot be read (never acts blind)', async () => {
    const f = setup();
    f.executor.failStateWith = 'unreachable';
    const r = await prepare(f, {
      action: 'failover_provider',
      params: { service: 'payments', to: 'stripe' },
    });
    expect(r.isError).toBe(true);
    expect(r.speak).toBe("I couldn't reach the service admin API. Try again in a minute.");
    expect(f.pendingActions.rows.size).toBe(0);
  });

  describe('rollback_deploy', () => {
    function withHistory() {
      const f = setup();
      f.deploys
        .add({
          service: 'payments-api',
          version: 'v1.4.1',
          deployedAt: minutesAgo(120),
          commitMessage: quoteUntrusted('stable'),
        })
        .add({ service: 'payments-api', version: 'v1.4.2', deployedAt: minutesAgo(5) });
      return f;
    }

    it('defaults to the previous successful version', async () => {
      const f = withHistory();
      const r = await prepare(f, {
        action: 'rollback_deploy',
        params: { service: 'payments', fromVersion: 'v1.4.2' },
      });
      expect(r.speak).toBe(
        'This will roll payments API back from version 1.4.2 to version 1.4.1. You can redeploy it later. Shall I go ahead?',
      );
      expect(r.data.params).toEqual({
        action: 'rollback_deploy',
        service: 'payments-api',
        fromVersion: 'v1.4.2',
        toVersion: 'v1.4.1',
      });
    });

    it.each([
      [
        { fromVersion: 'v1.4.0' },
        'Payments API is running version 1.4.2, not version 1.4.0. Nothing changed.',
      ],
      [
        { toVersion: 'v1.3.9' },
        "I don't have a successful deploy of version 1.3.9 in the history, so I won't roll back to it.",
      ],
      [{ toVersion: 'v1.4.2' }, 'Payments API already runs version 1.4.2. Nothing to do.'],
    ])('refuses %o', async (params, speak) => {
      const r = await prepare(withHistory(), {
        action: 'rollback_deploy',
        params: { service: 'payments', ...params },
      });
      expect(r.speak).toBe(speak);
    });

    it('refuses when there is no previous version', async () => {
      const f = setup();
      f.deploys.add({ service: 'payments-api', version: 'v1.4.2', deployedAt: minutesAgo(5) });
      const r = await prepare(f, { action: 'rollback_deploy', service: 'payments' });
      expect(r.speak).toBe("I don't know a previous version of payments API to roll back to.");
    });
  });

  it('restart: asks first, and refuses while already restarting', async () => {
    const f = setup();
    const ok = await prepare(f, { action: 'restart_service', service: 'payments' });
    expect(ok.speak).toBe(
      'This will restart payments API; requests fail for a few seconds. Shall I go ahead?',
    );
    f.executor.state_.restarting = true;
    const no = await prepare(f, { action: 'restart_service', service: 'payments' });
    expect(no.speak).toBe('Payments API is already restarting.');
  });

  it('refuses an action not configured for the service (allowlist)', async () => {
    const r = await prepare(setup(), { action: 'restart_service', service: 'webhooks' });
    expect(r.isError).toBe(true);
    expect(r.speak).toBe("I'm not set up to do that for webhook receiver. Nothing changed.");
  });

  it.each([
    [{}, 'I can fail over a provider, roll back a deploy, or restart a service. Which one?'],
    [
      { action: 'delete_database', service: 'payments' },
      'I can fail over a provider, roll back a deploy, or restart a service. Which one?',
    ],
    [
      { suggested_action: { action: 'investigate', params: { service: 'payments-api' } } },
      undefined,
    ],
  ])('rejects input outside the allowlist %o', async (input, speak) => {
    const f = setup();
    const r = await prepare(f, input);
    expect(r.isError).toBe(true);
    expect(r.data).toMatchObject({ error: 'invalid_input' });
    if (speak) expect(r.speak).toBe(speak);
    expect(f.pendingActions.rows.size).toBe(0);
  });
});
