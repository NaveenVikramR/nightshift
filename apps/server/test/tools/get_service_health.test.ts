import { describe, expect, it } from 'vitest';
import { getServiceHealth } from '../../src/tools/get_service_health.js';
import type { ToolDefinition } from '../../src/tools/types.js';
import { BOB, expectSpeakable, fakeToolDeps, invoke, TEST_SERVICES } from '../fakes/toolDeps.js';

const tool = getServiceHealth as unknown as ToolDefinition;

function payments(o: { errorRate?: number; p95?: number; rps?: number; razorpay?: number } = {}) {
  const f = fakeToolDeps();
  f.prometheus
    .set('payments:errorRate', o.errorRate ?? 0.004)
    .set('payments:latencyP95', o.p95 ?? 0.18)
    .set('payments:throughput', o.rps ?? 19.6)
    .set('payments:breakers', [
      { labels: { service: 'payments-api', provider: 'razorpay' }, value: o.razorpay ?? 0 },
      { labels: { service: 'payments-api', provider: 'stripe' }, value: 0 },
    ]);
  return f;
}

describe('get_service_health', () => {
  it('reports a healthy service with its numbers', async () => {
    const f = payments();
    const r = await invoke(tool, f.deps, { service: 'payments' }, BOB);
    expect(r.isError).toBe(false);
    expect(r.speak).toBe(
      'Payments API is healthy: 0.4 percent errors, p95 180 milliseconds and 20 requests per second.',
    );
    expectSpeakable(r.speak);
    expect(r.data).toMatchObject({
      service: 'payments-api',
      status: 'healthy',
      signals: {
        errorRate: 0.004,
        latencyP95Seconds: 0.18,
        throughputRps: 19.6,
        breakers: [
          { dependency: 'razorpay', state: 'closed' },
          { dependency: 'stripe', state: 'closed' },
        ],
      },
    });
  });

  it('reports a provider outage as critical, severity first', async () => {
    const f = payments({ errorRate: 0.63, razorpay: 1 });
    const r = await invoke(tool, f.deps, { service: 'the payment api' }, BOB);
    expect(r.speak).toBe(
      'Critical: payments API has errors at 63 percent and razorpay breaker open. Ask me why.',
    );
    expectSpeakable(r.speak);
    expect(r.data['status']).toBe('critical');
  });

  it('runs exactly the configured PromQL for that service', async () => {
    const f = payments();
    await invoke(tool, f.deps, { service: 'payments' }, BOB);
    expect(f.prometheus.queries.sort()).toEqual([
      'payments:breakers',
      'payments:errorRate',
      'payments:latencyP95',
      'payments:throughput',
    ]);
  });

  it('services without a breaker query report breakers as null', async () => {
    const f = fakeToolDeps();
    f.prometheus
      .set('webhooks:errorRate', 0)
      .set('webhooks:latencyP95', 0.03)
      .set('webhooks:throughput', 2);
    const r = await invoke(tool, f.deps, { service: 'webhooks' }, BOB);
    expect((r.data['signals'] as { breakers: unknown }).breakers).toBeNull();
    expect(r.speak).toMatch(/^Webhook receiver is healthy/);
  });

  it('says "no data" for an empty signal and never invents one', async () => {
    const f = payments();
    f.prometheus.set('payments:latencyP95', [{ labels: {}, value: Number.NaN }]);
    const r = await invoke(tool, f.deps, { service: 'payments' }, BOB);
    expect(r.speak).toContain('No data for latency');
    expect((r.data['signals'] as { latencyP95Seconds: unknown }).latencyP95Seconds).toBeNull();
  });

  it('asks which service when none is given and several exist', async () => {
    const f = payments();
    const r = await invoke(tool, f.deps, {}, BOB);
    expect(r.isError).toBe(false);
    expect(r.speak).toBe('Which service: payments API or webhook receiver?');
    expect(r.data).toEqual({
      clarify: {
        question: 'Which service: payments API or webhook receiver?',
        options: [
          { id: 'payments-api', label: 'payments API' },
          { id: 'webhook-receiver', label: 'webhook receiver' },
        ],
      },
    });
    expect(f.prometheus.queries).toEqual([]); // no guess, no queries
  });

  it('uses the only service when there is just one', async () => {
    const f = fakeToolDeps(TEST_SERVICES.slice(0, 1));
    f.prometheus
      .set('payments:errorRate', 0)
      .set('payments:latencyP95', 0.1)
      .set('payments:throughput', 5);
    const r = await invoke(tool, f.deps, {}, BOB);
    expect(r.data['service']).toBe('payments-api');
  });

  it('refuses an unknown service with a helpful speak', async () => {
    const f = payments();
    const r = await invoke(tool, f.deps, { service: 'inventory' }, BOB);
    expect(r.isError).toBe(true);
    expect(r.speak).toBe(
      "I don't know that service. I can check payments API or webhook receiver.",
    );
    expect(f.audit.entries.at(-1)?.outcome).toBe('error');
  });

  it('rejects an over-long service name as invalid input', async () => {
    const f = payments();
    const r = await invoke(tool, f.deps, { service: 'x'.repeat(200) }, BOB);
    expect(r.isError).toBe(true);
    expect(f.audit.entries.at(-1)?.outcome).toBe('invalid_input');
  });

  it('turns Prometheus being down into a safe spoken message', async () => {
    const f = payments();
    f.prometheus.failWith = 'timeout';
    const r = await invoke(tool, f.deps, { service: 'payments' }, BOB);
    expect(r.isError).toBe(true);
    expect(r.speak).toBe('Prometheus is taking too long to answer. Try again in a minute.');
  });
});
