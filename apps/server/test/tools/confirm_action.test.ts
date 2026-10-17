import { describe, expect, it } from 'vitest';
import { classify } from '../../src/domain/actions/verify.js';
import { confirmAction, type ConfirmData } from '../../src/tools/confirm_action.js';
import { prepareAction, type PreparedData } from '../../src/tools/prepare_action.js';
import type { ToolDefinition } from '../../src/tools/types.js';
import {
  ALICE,
  authFor,
  BOB,
  expectSpeakable,
  fakeToolDeps,
  invoke,
  NOW,
} from '../fakes/toolDeps.js';

const prepareTool = prepareAction as unknown as ToolDefinition;
const confirmTool = confirmAction as unknown as ToolDefinition;
type Fakes = ReturnType<typeof fakeToolDeps>;
const CAROL = authFor('carol', 'responder');
const SESSION = 'session-1';

function setup(opts: { errorAfter?: number | null } = {}) {
  const f = fakeToolDeps();
  f.prometheus
    .set('payments:breakers', [
      { labels: { provider: 'razorpay' }, value: 1 },
      { labels: { provider: 'stripe' }, value: 0 },
    ])
    .set('payments:errorRate', 0.45);
  // What the metrics show after the action (default: recovered).
  const after = opts.errorAfter === undefined ? 0.004 : opts.errorAfter;
  f.executor.onExecute = () => {
    f.prometheus.set('payments:errorRate', after === null ? [] : after);
  };
  return f;
}

async function prepared(
  f: Fakes,
  input: unknown = { action: 'failover_provider', params: { service: 'payments', to: 'stripe' } },
) {
  const r = await invoke<PreparedData>(prepareTool, f.deps, input, ALICE, SESSION);
  if (r.isError) throw new Error(`prepare failed: ${r.speak}`);
  return r.data.confirmationId;
}

const confirm = (f: Fakes, id: string, auth = ALICE, session: string | undefined = SESSION) =>
  invoke<ConfirmData>(confirmTool, f.deps, { confirmation_id: id }, auth, session);

describe('confirm_action', () => {
  it('executes once, verifies with metrics, records events and audit', async () => {
    const f = setup();
    const incident = await f.incidents.open({
      title: 't',
      severity: 'critical',
      service: 'payments-api',
      primaryCause: 'provider_failure',
    });
    const id = await prepared(f);
    const r = await confirm(f, id);

    expect(r.isError).toBe(false);
    expect(r.speak).toBe('Done. Payments API now uses Stripe. Recovered: errors at 0.4 percent.');
    expectSpeakable(r.speak);
    expect(f.executor.executed).toEqual([
      { action: 'failover_provider', service: 'payments-api', from: 'razorpay', to: 'stripe' },
    ]);
    expect(r.data).toMatchObject({
      status: 'succeeded',
      executedAt: NOW.toISOString(),
      verification: { outcome: 'recovered', before: 0.45, after: 0.004 },
    });
    expect(f.pendingActions.rows.get(id)).toMatchObject({ status: 'succeeded', executedAt: NOW });
    expect(
      f.incidents.events
        .filter((e) => e.incidentId === incident.id)
        .map((e) => (e.data as { stage: string }).stage),
    ).toEqual(['prepared', 'confirmed', 'executed', 'verified']);
    expect(f.audit.entries.map((e) => [e.tool, e.outcome])).toEqual([
      ['prepare_action', 'ok'],
      ['confirm_action', 'ok'],
    ]);
  });

  it('a reused confirmation returns the original result and never re-executes (invariant 2)', async () => {
    const f = setup();
    const id = await prepared(f);
    const first = await confirm(f, id);
    const again = await confirm(f, id);
    expect(again.speak).toBe("That's already done.");
    expect(again.data).toMatchObject({
      replayed: true,
      status: 'succeeded',
      verification: first.data.verification,
    });
    expect(f.executor.executed).toHaveLength(1);
  });

  it('five concurrent confirms execute exactly once', async () => {
    const f = setup();
    f.executor.executeDelayMs = 20;
    const id = await prepared(f);
    const results = await Promise.all(Array.from({ length: 5 }, () => confirm(f, id)));
    expect(f.executor.executed).toHaveLength(1);
    expect(results.filter((r) => r.speak.startsWith('Done.'))).toHaveLength(1);
    for (const r of results.filter((x) => !x.speak.startsWith('Done.'))) {
      expect(["That's already in progress.", "That's already done."]).toContain(r.speak);
    }
  });

  it('refuses a viewer (invariant 4)', async () => {
    const f = setup();
    const id = await prepared(f);
    const r = await confirm(f, id, BOB);
    expect(r.data).toEqual({ error: 'forbidden' });
    expect(f.executor.executed).toEqual([]);
  });

  it.each([
    ['another responder', CAROL, SESSION],
    ['the same actor in another session', ALICE, 'session-2'],
  ])(
    'refuses %s, without revealing that the confirmation exists',
    async (_label, auth, session) => {
      const f = setup();
      const id = await prepared(f);
      const r = await confirm(f, id, auth, session);
      expect(r.isError).toBe(true);
      expect(r.speak).toBe("I can't find that confirmation. Ask me to prepare the action again.");
      expect(f.executor.executed).toEqual([]);
      expect(f.pendingActions.rows.get(id)!.status).toBe('pending');
    },
  );

  it('refuses unknown and malformed ids the same way', async () => {
    const f = setup();
    for (const id of ['AAAAAAAAAAAAAAAAAAAAAA', 'not a valid id!']) {
      const r = await confirm(f, id);
      expect(r.speak).toBe("I can't find that confirmation. Ask me to prepare the action again.");
    }
  });

  it('refuses an expired confirmation (2 minutes)', async () => {
    const f = setup();
    const id = await prepared(f);
    f.clock.now = new Date(NOW.getTime() + 2 * 60_000);
    const r = await confirm(f, id);
    expect(r.speak).toBe('That confirmation expired. Ask me again.');
    expect(f.executor.executed).toEqual([]);
  });

  it('enforces the rate limit: a 4th action within 10 minutes is refused (invariant 8)', async () => {
    const f = setup();
    for (let i = 0; i < 3; i++) {
      const id = await prepared(f, { action: 'restart_service', service: 'payments' });
      expect((await confirm(f, id)).speak).toMatch(/^Done\./);
      f.clock.now = new Date(f.clock.now.getTime() + 60_000);
    }
    const fourth = await prepared(f, { action: 'restart_service', service: 'payments' });
    const r = await confirm(f, fourth);
    expect(r.isError).toBe(true);
    expect(r.speak).toBe(
      "I've already run 3 actions in the last 10 minutes, the safety limit. Try again in 7 minutes.",
    );
    expect(f.executor.executed).toHaveLength(3);
    expect(f.pendingActions.rows.get(fourth)!.status).toBe('pending');

    f.clock.now = new Date(NOW.getTime() + 10 * 60_000 + 1000); // first one left the window
    const later = await prepared(f, { action: 'restart_service', service: 'payments' });
    expect((await confirm(f, later)).speak).toMatch(/^Done\./);
  });

  it('re-checks before executing: if the situation changed, it does not act', async () => {
    const f = setup();
    const id = await prepared(f);
    f.executor.state_.activeProvider = 'stripe'; // someone already failed over
    const r = await confirm(f, id);
    expect(r.isError).toBe(true);
    expect(r.speak).toBe(
      "I didn't act because things changed. Payments API already uses Stripe. Nothing to do.",
    );
    expect(f.executor.executed).toEqual([]);
    expect(f.pendingActions.rows.get(id)!.status).toBe('refused');
    expect((await confirm(f, id)).speak).toBe(
      "That wasn't run because the situation changed. Ask me again if it's still needed.",
    );
  });

  it('does not act when the provider already recovered', async () => {
    const f = setup();
    const id = await prepared(f);
    f.prometheus
      .set('payments:breakers', [
        { labels: { provider: 'razorpay' }, value: 0 },
        { labels: { provider: 'stripe' }, value: 0 },
      ])
      .set('payments:errorRate', 0.004);
    const r = await confirm(f, id);
    expect(r.speak).toBe(
      "I didn't act because things changed. Razorpay looks healthy, so I won't fail over.",
    );
    expect(f.executor.executed).toEqual([]);
  });

  it('executor failure: reports it, marks the action failed, never claims success', async () => {
    const f = setup();
    f.executor.failExecuteWith = 'rejected';
    const id = await prepared(f);
    const r = await confirm(f, id);
    expect(r.isError).toBe(true);
    expect(r.speak).toBe(
      "I couldn't fail over: the target refused it. As far as I can tell, nothing changed.",
    );
    expect(r.speak).not.toMatch(/done|recover/i);
    expect(r.data).toMatchObject({ status: 'failed', reason: 'AdminApi_rejected' });
    expect(f.pendingActions.rows.get(id)).toMatchObject({ status: 'failed', executedAt: NOW });
    expect(f.audit.entries.at(-1)).toMatchObject({ tool: 'confirm_action', outcome: 'error' });
    expect((await confirm(f, id)).speak).toBe('That already ran and failed.');
  });

  it('a timeout is honest about not knowing whether it took effect', async () => {
    const f = setup();
    f.executor.failExecuteWith = 'timeout';
    const r = await confirm(f, await prepared(f));
    expect(r.speak).toBe(
      "I tried to fail over, but it timed out, so I can't tell whether it took effect. Check before trying again.",
    );
  });

  it.each([
    [
      0.2,
      'Done. Payments API now uses Stripe. Errors are falling, 45 to 20 percent. Still recovering.',
    ],
    [0.44, 'Done. Payments API now uses Stripe. No improvement yet: errors still at 44 percent.'],
    [
      null,
      "Done. Payments API now uses Stripe. I couldn't read the error rate to confirm the effect.",
    ],
  ])('reports what the metrics show after (error rate %s)', async (after, speak) => {
    const f = setup({ errorAfter: after });
    const r = await confirm(f, await prepared(f));
    expect(r.speak).toBe(speak);
  });

  it('verifies with the short-window query when configured (a 1-minute rate lags)', async () => {
    const f = setup({ errorAfter: 0.45 }); // the 1-minute rate still looks broken
    const [payments, ...others] = f.deps.services;
    f.deps.services = [
      { ...payments!, queries: { ...payments!.queries, verifyErrorRate: 'payments:verify' } },
      ...others,
    ];
    f.prometheus.set('payments:verify', 0.5);
    f.executor.onExecute = () => f.prometheus.set('payments:verify', 0.01);
    const r = await confirm(f, await prepared(f));
    expect(r.speak).toBe('Done. Payments API now uses Stripe. Recovered: errors at 1 percent.');
    expect(r.data.verification).toMatchObject({ before: 0.5, after: 0.01, outcome: 'recovered' });
  });

  it('a rollback records the new deploy in the history', async () => {
    const f = setup();
    f.deploys
      .add({
        service: 'payments-api',
        version: 'v1.4.1',
        deployedAt: new Date(NOW.getTime() - 7_200_000),
      })
      .add({
        service: 'payments-api',
        version: 'v1.4.2',
        deployedAt: new Date(NOW.getTime() - 300_000),
      });
    const id = await prepared(f, { action: 'rollback_deploy', service: 'payments' });
    const r = await confirm(f, id);
    expect(r.speak).toBe(
      'Done. Payments API is back on version 1.4.1. Recovered: errors at 0.4 percent.',
    );
    expect(f.deployStore.records).toEqual([
      expect.objectContaining({
        source: 'nightshift',
        externalId: id,
        version: 'v1.4.1',
        author: 'alice',
      }),
    ]);
  });
});

describe('verification classification', () => {
  it.each([
    [0.45, 0.04, 'recovered'],
    [0.45, 0.31, 'recovering'],
    [0.45, 0.32, 'no_improvement'],
    [null, 0.3, 'no_improvement'],
    [0.45, null, 'unknown'],
  ] as const)('before %s, after %s → %s', (before, after, outcome) => {
    expect(classify(before, after, 0.05)).toBe(outcome);
  });
});
