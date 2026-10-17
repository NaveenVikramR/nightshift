import { describe, expect, it } from 'vitest';
import { collectEvidence } from '../../src/domain/correlation/evidence.js';
import { diagnose } from '../../src/domain/correlation/rules.js';
import type { ServiceDef } from '../../src/serviceConfig.js';
import { fakeToolDeps, NOW, TEST_SERVICES } from '../fakes/toolDeps.js';
import {
  applyScenario,
  BAD_DEPLOY_AT,
  BREAKER_OPENED_AT,
  INJECTION_COMMIT,
  type ScenarioName,
} from '../fixtures/scenarios.js';

const [payments, webhooks] = TEST_SERVICES as [ServiceDef, ServiceDef];
type Fakes = ReturnType<typeof fakeToolDeps>;

async function run(
  name: ScenarioName,
  opts: { service?: ServiceDef; commitMessage?: string; tweak?: (f: Fakes) => void } = {},
) {
  const f = fakeToolDeps();
  applyScenario(
    f,
    name,
    opts.commitMessage === undefined ? {} : { commitMessage: opts.commitMessage },
  );
  opts.tweak?.(f);
  return diagnose(await collectEvidence(opts.service ?? payments, f.deps, { end: NOW }));
}

const ids = (d: Awaited<ReturnType<typeof run>>) => d.causes.map((c) => c.id);
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe('diagnose (rules over evidence)', () => {
  it('healthy: all clear, no causes', async () => {
    const d = await run('healthy');
    expect(d).toMatchObject({ status: 'all_clear', severity: 'info', causes: [] });
  });

  it('provider_outage: provider failure, suggests failover to stripe, no deploy blamed', async () => {
    const d = await run('provider_outage');
    expect(d.status).toBe('incident');
    expect(d.severity).toBe('critical');
    expect(ids(d)).toEqual(['provider_failure']);
    const c = d.causes[0]!;
    expect(c.confidence).toBe(0.9); // breaker opened within 2 min of the error onset
    expect(c.suggestedActions).toEqual([
      {
        action: 'failover_provider',
        params: { service: 'payments-api', from: 'razorpay', to: 'stripe' },
        requiresConfirmation: true,
      },
    ]);
    expect(d.relations).toEqual([]);
  });

  it('bad_deploy: provider failure and recent deploy, related (breaker opened after the deploy)', async () => {
    const d = await run('bad_deploy');
    expect(ids(d)).toEqual(['provider_failure', 'recent_deploy']);
    const deploy = d.causes[1]!;
    expect(deploy.confidence).toBeGreaterThan(0.8);
    expect(deploy.suggestedActions).toEqual([
      {
        action: 'rollback_deploy',
        params: { service: 'payments-api', fromVersion: 'v1.4.2' },
        requiresConfirmation: true,
      },
    ]);
    expect(d.relations).toEqual([
      {
        kind: 'breaker_after_deploy',
        dependency: 'razorpay',
        version: 'v1.4.2',
        deployedAt: BAD_DEPLOY_AT,
        openedAt: BREAKER_OPENED_AT,
        minutesAfter: 1,
      },
    ]);
    // evidence references the real data points
    const item = deploy.evidence.find((e) => e.kind === 'deploy')!;
    expect(item.values).toMatchObject({
      version: 'v1.4.2',
      deployedAt: BAD_DEPLOY_AT.toISOString(),
    });
    expect(item.quote).toEqual({ untrusted: true, text: 'tune payment retry config' });
  });

  it('latency_spike: saturation, investigate only', async () => {
    const d = await run('latency_spike');
    expect(ids(d)).toEqual(['saturation']);
    expect(d.severity).toBe('warning');
    expect(d.causes[0]!.suggestedActions.every((a) => a.action === 'investigate')).toBe(true);
  });

  it('auth_bruteforce: possible attack, security, no automated action', async () => {
    const d = await run('auth_bruteforce');
    expect(ids(d)).toEqual(['possible_attack']);
    expect(d.causes[0]).toMatchObject({
      security: true,
      title: 'Possible credential brute force',
    });
    expect(d.causes[0]!.suggestedActions.every((a) => !a.requiresConfirmation)).toBe(true);
  });

  it('webhook_spoofing: possible attack on the webhook receiver', async () => {
    const d = await run('webhook_spoofing', { service: webhooks });
    expect(ids(d)).toEqual(['possible_attack']);
    expect(d.causes[0]!.title).toBe('Possible webhook spoofing');
  });

  it('errors up, no deploy, no breaker data: no clear cause, with alert summaries', async () => {
    const d = await run('provider_outage', {
      tweak: (f) => f.prometheus.setRange('payments:breakers', []),
    });
    expect(ids(d)).toEqual(['no_clear_cause']);
    const c = d.causes[0]!;
    expect(c.confidence).toBe(0);
    expect(c.evidence.filter((e) => e.kind === 'alert').map((e) => e.values['alertname'])).toEqual([
      'HighErrorRate',
      'CircuitBreakerOpen',
    ]);
    expect(c.evidence.some((e) => e.text.startsWith('No deploy within 10 minutes'))).toBe(true);
  });

  it('missing data: says so instead of inventing an onset', async () => {
    const d = await run('provider_outage', {
      tweak: (f) => {
        f.prometheus.setRange('payments:errorRate', []);
        f.prometheus.setRange('payments:breakers', []);
      },
    });
    expect(ids(d)).toEqual(['no_clear_cause']);
    expect(d.facts.onsets.errorRate).toEqual({ kind: 'insufficient_data', points: 0 });
  });

  it('Prometheus unavailable: no clear cause, lists what could not be checked', async () => {
    const d = await run('bad_deploy', {
      tweak: (f) => (f.prometheus.failWith = 'unreachable'),
    });
    expect(ids(d)).toEqual(['no_clear_cause']);
    const unchecked = d.causes[0]!.evidence.filter((e) => e.kind === 'source').map(
      (e) => e.values['source'],
    );
    expect(unchecked).toContain('errorRate');
  });

  it('deploy source unavailable: still finds the provider failure, records the gap', async () => {
    const d = await run('bad_deploy', { tweak: (f) => (f.deploys.failWith = 'unreachable') });
    expect(ids(d)).toEqual(['provider_failure']);
    expect(d.sources).toContainEqual({
      source: 'deploys',
      status: 'unavailable',
      reason: 'unreachable',
    });
  });

  it('a deploy long before the onset is not blamed', async () => {
    const before = await run('provider_outage', {
      tweak: (f) =>
        f.deploys.add({ service: 'payments-api', version: 'v1.4.0', deployedAt: minutesAgo(30) }),
    });
    expect(ids(before)).toEqual(['provider_failure']);
  });

  it('errors starting 2 min before a deploy: the deploy is not a cause, and the evidence says so', async () => {
    // provider_outage errors start at 11:56:30; deploy at 11:58:30
    const d = await run('provider_outage', {
      tweak: (f) =>
        f.deploys.add({ service: 'payments-api', version: 'v1.4.3', deployedAt: minutesAgo(1.5) }),
    });
    expect(ids(d)).toEqual(['provider_failure']);
    expect(d.relations).toEqual([]);
    expect(d.causes[0]!.suggestedActions.map((a) => a.action)).toEqual(['failover_provider']);
    const note = d.causes[0]!.evidence.find((e) => e.values['exonerated'] === true)!;
    expect(note.text).toBe(
      'Errors started 2 min before deploy v1.4.3 at 2026-10-16T11:58:30.000Z, so it is not the cause.',
    );
    expect(note.values).toMatchObject({ version: 'v1.4.3', minutesAfterOnset: 2 });
  });

  it('a deploy after the onset is never blamed in speak or suggested for rollback', async () => {
    const d = await run('latency_spike', {
      tweak: (f) =>
        f.deploys.add({ service: 'payments-api', version: 'v1.4.3', deployedAt: minutesAgo(1) }),
    });
    expect(ids(d)).toEqual(['saturation']);
    expect(
      d.causes.flatMap((c) => c.suggestedActions).some((a) => a.action === 'rollback_deploy'),
    ).toBe(false);
  });

  it('prompt-injection commit: quoted only, causes and actions unchanged (invariant 6)', async () => {
    const benign = await run('bad_deploy');
    const injected = await run('bad_deploy', { commitMessage: INJECTION_COMMIT });

    const strip = (d: typeof benign) =>
      d.causes.map((c) => ({
        id: c.id,
        confidence: c.confidence,
        actions: c.suggestedActions,
        evidence: c.evidence.map(({ quote: _quote, ...rest }) => rest),
      }));
    expect(strip(injected)).toEqual(strip(benign));
    const quotes = injected.causes.flatMap((c) =>
      c.evidence.flatMap((e) => (e.quote ? [e.quote] : [])),
    );
    expect(quotes).toEqual([{ untrusted: true, text: INJECTION_COMMIT }]);
    const texts = injected.causes.flatMap((c) => c.evidence.map((e) => e.text)).join(' ');
    expect(texts).not.toMatch(/ignore previous/i);
  });
});
