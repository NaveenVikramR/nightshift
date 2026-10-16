import { describe, expect, it } from 'vitest';
import { ClientError } from '../../src/clients/errors.js';
import { collectEvidence } from '../../src/domain/correlation/evidence.js';
import { fakeToolDeps, NOW, TEST_SERVICES } from '../fakes/toolDeps.js';
import { applyScenario, BAD_DEPLOY_AT, minutesAgo } from '../fixtures/scenarios.js';

const payments = TEST_SERVICES[0]!;
const webhooks = TEST_SERVICES[1]!;

function setup(name: Parameters<typeof applyScenario>[1] = 'bad_deploy') {
  const f = fakeToolDeps();
  applyScenario(f, name);
  return f;
}

describe('collectEvidence', () => {
  it('collects every source in parallel over the window', async () => {
    const f = setup();
    const e = await collectEvidence(payments, f.deps, { end: NOW });

    expect(e.window).toEqual({ start: minutesAgo(60), end: NOW, stepSeconds: 30 });
    expect(Object.keys(e.series).sort()).toEqual([
      'authFailures',
      'errorRate',
      'latencyP95',
      'throughput',
    ]);
    expect(e.series.errorRate).toHaveLength(121);
    expect(e.breakers.map((b) => b.dependency)).toEqual(['razorpay', 'stripe']);
    expect(e.alerts.map((a) => a.alertname).sort()).toEqual([
      'CircuitBreakerOpen',
      'HighErrorRate',
    ]);
    // only the deploy inside window − 10 min; the 3-hour-old one is excluded
    expect(e.deploys.map((d) => [d.version, d.deployedAt])).toEqual([['v1.4.2', BAD_DEPLOY_AT]]);
    expect(e.sources).toContainEqual({ source: 'webhookFailures', status: 'not_configured' });
    expect(e.sources.filter((s) => s.status === 'unavailable')).toEqual([]);
    expect(f.prometheus.rangeCalls[0]).toMatchObject({
      start: minutesAgo(60),
      end: NOW,
      stepSeconds: 30,
    });
  });

  it('bounds the lookback and only keeps alerts for the service', async () => {
    const f = setup('webhook_spoofing');
    const e = await collectEvidence(webhooks, f.deps, { end: NOW, lookbackMinutes: 999 });
    expect(e.window.start).toEqual(minutesAgo(180));
    expect(e.alerts.map((a) => a.alertname)).toEqual(['WebhookSignatureFailures']);
  });

  it('records an unavailable source and keeps the rest (partial failure)', async () => {
    const f = setup();
    f.prometheus.failing.set('payments:latencyP95', 'timeout');
    f.deploys.failWith = 'unreachable';
    const e = await collectEvidence(payments, f.deps, { end: NOW });
    expect(e.series.latencyP95).toBeUndefined();
    expect(e.series.errorRate).toBeDefined();
    expect(e.deploys).toEqual([]);
    expect(e.sources).toContainEqual({
      source: 'latencyP95',
      status: 'unavailable',
      reason: 'timeout',
    });
    expect(e.sources).toContainEqual({
      source: 'deploys',
      status: 'unavailable',
      reason: 'unreachable',
    });
  });

  it('keeps going with Prometheus down when alerts and deploys answer', async () => {
    const f = setup();
    f.prometheus.failWith = 'unreachable';
    const e = await collectEvidence(payments, f.deps, { end: NOW });
    expect(e.series).toEqual({});
    expect(e.breakers).toEqual([]);
    expect(e.alerts).toHaveLength(2);
  });

  it('throws a ClientError only when every source failed', async () => {
    const f = setup();
    f.prometheus.failWith = 'unreachable';
    f.alertmanager.failWith = 'unreachable';
    f.deploys.failWith = 'unreachable';
    await expect(collectEvidence(payments, f.deps, { end: NOW })).rejects.toBeInstanceOf(
      ClientError,
    );
  });

  it('turns a hung source into a timeout', async () => {
    const f = setup();
    f.deps.alertmanager.listAlerts = () => new Promise(() => {});
    const e = await collectEvidence(payments, f.deps, { end: NOW, timeoutMs: 20 });
    expect(e.sources).toContainEqual({
      source: 'alertmanager',
      status: 'unavailable',
      reason: 'timeout',
    });
  });

  it('marks deploys not_configured for a service without a source', async () => {
    const f = setup();
    f.deploys.sources.set('payments-api', null);
    const e = await collectEvidence(payments, f.deps, { end: NOW });
    expect(e.sources).toContainEqual({ source: 'deploys', status: 'not_configured' });
  });
});
