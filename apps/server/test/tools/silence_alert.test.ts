import { describe, expect, it } from 'vitest';
import { silenceAlert } from '../../src/tools/silence_alert.js';
import type { ToolDefinition } from '../../src/tools/types.js';
import { makeAlert } from '../fakes/fakeAlertmanager.js';
import { ALICE, BOB, expectSpeakable, fakeToolDeps, invoke, NOW } from '../fakes/toolDeps.js';

const tool = silenceAlert as unknown as ToolDefinition;

function firing(...names: string[]) {
  const f = fakeToolDeps();
  f.alertmanager.alerts = names.map((n) => makeAlert({ alertname: n }));
  return f;
}

describe('silence_alert', () => {
  it('creates an exact-match Alertmanager silence and records it', async () => {
    const f = firing('HighLatencyP95', 'HighErrorRate');
    const r = await invoke(tool, f.deps, { alert: 'latency', duration_minutes: 60 }, ALICE);
    expect(r.isError).toBe(false);
    expect(r.speak).toBe(
      'Critical: silenced high latency p95 on payments API for 1 hour. It is not fixed, so check on it later.',
    );
    expectSpeakable(r.speak);

    expect(f.alertmanager.silences).toHaveLength(1);
    const s = f.alertmanager.silences[0]!;
    expect(s.matchers).toEqual([
      { name: 'alertname', value: 'HighLatencyP95', isRegex: false, isEqual: true },
      { name: 'service', value: 'payments-api', isRegex: false, isEqual: true },
      { name: 'severity', value: 'critical', isRegex: false, isEqual: true },
    ]);
    expect(s.endsAt.getTime() - s.startsAt.getTime()).toBe(60 * 60_000);
    expect(s.createdBy).toBe('nightshift:alice');
    expect(f.silences.records).toEqual([
      expect.objectContaining({
        alertname: 'HighLatencyP95',
        durationMinutes: 60,
        createdBy: 'alice',
      }),
    ]);
    expect(r.data).toMatchObject({
      durationMinutes: 60,
      alreadySilenced: false,
      endsAt: '2026-10-16T13:00:00.000Z',
    });
  });

  it('is idempotent for the same alert and duration within the window', async () => {
    const f = firing('HighErrorRate');
    const first = await invoke(tool, f.deps, { alert: 'error rate', duration_minutes: 60 }, ALICE);
    f.clock.now = new Date(NOW.getTime() + 2 * 60_000);
    const again = await invoke(tool, f.deps, { alert: 'error rate', duration_minutes: 60 }, ALICE);
    expect(again.speak).toBe(
      'Critical: high error rate on payments API is already silenced for another 58 minutes.',
    );
    expect(again.data).toMatchObject({ alreadySilenced: true, silenceId: first.data['silenceId'] });
    expect(f.alertmanager.silences).toHaveLength(1);
  });

  it('does not duplicate when an existing silence already covers the request', async () => {
    const f = firing('HighErrorRate');
    await invoke(tool, f.deps, { alert: 'error rate', duration_minutes: 120 }, ALICE);
    f.clock.now = new Date(NOW.getTime() + 15 * 60_000); // outside the 10-minute window
    const r = await invoke(tool, f.deps, { alert: 'error rate', duration_minutes: 30 }, ALICE);
    expect(r.data).toMatchObject({ alreadySilenced: true });
    expect(f.alertmanager.silences).toHaveLength(1);
  });

  it('creates a longer silence when the user extends it', async () => {
    const f = firing('HighErrorRate');
    await invoke(tool, f.deps, { alert: 'error rate', duration_minutes: 15 }, ALICE);
    const r = await invoke(tool, f.deps, { alert: 'error rate', duration_minutes: 240 }, ALICE);
    expect(r.data).toMatchObject({ alreadySilenced: false, durationMinutes: 240 });
    expect(r.speak).toContain('for 4 hours');
    expect(f.alertmanager.silences).toHaveLength(2);
  });

  it.each([
    [0, 'zero'],
    [241, 'over four hours'],
    [1.5, 'fractional'],
  ])('rejects duration %s (%s) with a spoken explanation and audits it', async (minutes) => {
    const f = firing('HighErrorRate');
    const r = await invoke(tool, f.deps, { alert: 'error rate', duration_minutes: minutes }, ALICE);
    expect(r.isError).toBe(true);
    expect(r.speak).toBe(
      'I can silence an alert for one minute up to four hours. How long should I silence it?',
    );
    expect(f.alertmanager.silences).toHaveLength(0);
    expect(f.audit.entries.at(-1)?.outcome).toBe('invalid_input');
  });

  it('requires a duration', async () => {
    const f = firing('HighErrorRate');
    const r = await invoke(tool, f.deps, { alert: 'error rate' }, ALICE);
    expect(r.isError).toBe(true);
    expect(r.speak).toMatch(/How long should I silence it/);
  });

  it('asks which alert instead of guessing', async () => {
    const f = firing('HighErrorRate', 'CircuitBreakerOpen');
    const r = await invoke(tool, f.deps, { duration_minutes: 30 }, ALICE);
    expect(r.isError).toBe(false);
    expect(r.speak).toMatch(/^Which alert: /);
    expect(f.alertmanager.silences).toHaveLength(0);
  });

  it('matches the raw label values even when they are not speakable', async () => {
    const f = fakeToolDeps();
    f.alertmanager.alerts = [
      makeAlert({
        alertname: 'DiskFull',
        labels: {
          alertname: 'DiskFull',
          service: 'payments-api',
          severity: 'warning',
          mount: '/var/lib (data)',
        },
      }),
    ];
    await invoke(tool, f.deps, { duration_minutes: 10 }, ALICE);
    expect(f.alertmanager.silences[0]?.matchers).toContainEqual({
      name: 'mount',
      value: '/var/lib (data)',
      isRegex: false,
      isEqual: true,
    });
    expect(f.alertmanager.alerts[0]?.state).toBe('suppressed');
  });

  it('refuses a viewer and creates nothing', async () => {
    const f = firing('HighErrorRate');
    const r = await invoke(tool, f.deps, { alert: 'error rate', duration_minutes: 30 }, BOB);
    expect(r.isError).toBe(true);
    expect(f.alertmanager.silences).toHaveLength(0);
    expect(f.audit.entries.at(-1)).toMatchObject({ actor: 'bob', outcome: 'forbidden' });
  });

  it('turns Alertmanager failing into a safe spoken message', async () => {
    const f = firing('HighErrorRate');
    f.alertmanager.failWith = 'rejected';
    const r = await invoke(tool, f.deps, { alert: 'error rate', duration_minutes: 30 }, ALICE);
    expect(r.speak).toBe('Alertmanager rejected my request. Check the Nightshift service config.');
  });
});
