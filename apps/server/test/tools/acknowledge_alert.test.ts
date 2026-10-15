import { describe, expect, it } from 'vitest';
import { acknowledgeAlert } from '../../src/tools/acknowledge_alert.js';
import type { ToolDefinition } from '../../src/tools/types.js';
import { makeAlert } from '../fakes/fakeAlertmanager.js';
import { ALICE, authFor, BOB, expectSpeakable, fakeToolDeps, invoke } from '../fakes/toolDeps.js';

const tool = acknowledgeAlert as unknown as ToolDefinition;
const CAROL = authFor('carol', 'responder');

function firing(...names: string[]) {
  const f = fakeToolDeps();
  f.alertmanager.alerts = names.map((n) => makeAlert({ alertname: n }));
  return f;
}

describe('acknowledge_alert', () => {
  it('acknowledges the named alert and stores who did it', async () => {
    const f = firing('HighErrorRate', 'CircuitBreakerOpen');
    const r = await invoke(tool, f.deps, { alert: 'the error rate alert' }, ALICE);
    expect(r.isError).toBe(false);
    expect(r.speak).toBe(
      'Critical alert acknowledged: high error rate on payments API. It keeps firing until the cause is fixed.',
    );
    expectSpeakable(r.speak);
    expect(f.acks.records).toEqual([
      expect.objectContaining({ alertname: 'HighErrorRate', ackedBy: 'alice' }),
    ]);
    expect(r.data).toMatchObject({ alertname: 'HighErrorRate', alreadyAcknowledged: false });
  });

  it('is idempotent: a second ack (by anyone) reports the original one', async () => {
    const f = firing('HighErrorRate');
    await invoke(tool, f.deps, { alert: 'error rate' }, ALICE);
    f.clock.now = new Date(f.clock.now.getTime() + 3 * 60_000);
    const r = await invoke(tool, f.deps, { alert: 'error rate' }, CAROL);
    expect(r.isError).toBe(false);
    expect(r.speak).toBe(
      'Critical: high error rate on payments API was already acknowledged by alice 3 minutes ago.',
    );
    expect(r.data).toMatchObject({ alreadyAcknowledged: true, acknowledged: { by: 'alice' } });
    expect(f.acks.records).toHaveLength(1);
  });

  it('a re-fired alert (new startsAt) needs a new ack', async () => {
    const f = firing('HighErrorRate');
    await invoke(tool, f.deps, { alert: 'error rate' }, ALICE);
    f.alertmanager.alerts[0]!.startsAt = new Date('2026-10-16T12:30:00Z');
    const r = await invoke(tool, f.deps, { alert: 'error rate' }, ALICE);
    expect(r.data).toMatchObject({ alreadyAcknowledged: false });
    expect(f.acks.records).toHaveLength(2);
  });

  it('with no reference, acks the only unacknowledged alert', async () => {
    const f = firing('HighErrorRate', 'CircuitBreakerOpen');
    await invoke(tool, f.deps, { alert: 'breaker' }, ALICE);
    const r = await invoke(tool, f.deps, {}, ALICE);
    expect(r.data).toMatchObject({ alertname: 'HighErrorRate', alreadyAcknowledged: false });
    const done = await invoke(tool, f.deps, {}, ALICE);
    expect(done.speak).toBe('All firing alerts are already acknowledged.');
    expect(done.data).toEqual({ allAcknowledged: true });
  });

  it('asks which alert instead of guessing', async () => {
    const f = firing('HighErrorRate', 'CircuitBreakerOpen');
    const r = await invoke(tool, f.deps, { alert: 'the payments alert' }, ALICE);
    expect(r.isError).toBe(false);
    expect(r.speak).toBe(
      'Which alert: high error rate on payments API or circuit breaker open on payments API?',
    );
    expect(r.data).toHaveProperty('clarify.options.length', 2);
    expect(f.acks.records).toHaveLength(0);
  });

  it('accepts a fingerprint from list_active_alerts', async () => {
    const f = firing('HighErrorRate', 'CircuitBreakerOpen');
    const fp = f.alertmanager.alerts[1]!.fingerprint;
    const r = await invoke(tool, f.deps, { alert: fp }, ALICE);
    expect(r.data).toMatchObject({ alertname: 'CircuitBreakerOpen' });
  });

  it('says so when nothing is firing or nothing matches', async () => {
    const none = await invoke(tool, fakeToolDeps().deps, {}, ALICE);
    expect(none.speak).toBe("No alerts are firing, so there's nothing to acknowledge.");
    const f = firing('HighErrorRate');
    const miss = await invoke(tool, f.deps, { alert: 'disk full' }, ALICE);
    expect(miss.isError).toBe(true);
    expect(miss.speak).toBe(
      "I couldn't find a firing alert like that. Ask me what alerts are firing.",
    );
  });

  it('refuses a viewer (role checked server-side) and stores nothing', async () => {
    const f = firing('HighErrorRate');
    const r = await invoke(tool, f.deps, { alert: 'error rate' }, BOB);
    expect(r.isError).toBe(true);
    expect(r.speak).toMatch(/needs responder access/);
    expect(f.acks.records).toHaveLength(0);
    expect(f.audit.entries.at(-1)).toMatchObject({ actor: 'bob', outcome: 'forbidden' });
  });

  it('rejects invalid input', async () => {
    const f = firing('HighErrorRate');
    const r = await invoke(tool, f.deps, { alert: 42 }, ALICE);
    expect(r.isError).toBe(true);
    expect(f.audit.entries.at(-1)?.outcome).toBe('invalid_input');
  });

  it('turns Alertmanager being down into a safe spoken message', async () => {
    const f = firing('HighErrorRate');
    f.alertmanager.failWith = 'unreachable';
    const r = await invoke(tool, f.deps, { alert: 'error rate' }, ALICE);
    expect(r.speak).toBe("I couldn't reach Alertmanager. Try again in a minute.");
  });
});
