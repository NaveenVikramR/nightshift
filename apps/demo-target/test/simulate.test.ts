import { describe, expect, it } from 'vitest';
import { createMetrics } from '../src/metrics.ts';
import { simulateBackgroundEvents, simulatePaymentsRequest, type Rng } from '../src/simulate.ts';
import { DemoState } from '../src/state.ts';
import { tick } from '../src/traffic.ts';

/** Deterministic PRNG (mulberry32). */
function seeded(seed = 42): Rng {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample(state: DemoState, n = 2000) {
  const rng = seeded();
  return Array.from({ length: n }, () => simulatePaymentsRequest(state, rng));
}
const errorRate = (rs: { status: number }[]) =>
  rs.filter((r) => r.status >= 500).length / rs.length;
const p95 = (rs: { durationSeconds: number }[]) =>
  rs.map((r) => r.durationSeconds).sort((a, b) => a - b)[Math.floor(rs.length * 0.95)]!;

describe('payments-api simulation', () => {
  it('is healthy by default: <2% errors, p95 under 0.5 s', () => {
    const rs = sample(new DemoState());
    expect(errorRate(rs)).toBeLessThan(0.02);
    expect(p95(rs)).toBeLessThan(0.5);
  });

  it('provider_outage: razorpay calls fail (>40% overall 5xx)', () => {
    const state = new DemoState();
    state.enable('provider_outage');
    const rs = sample(state);
    expect(errorRate(rs)).toBeGreaterThan(0.4);
    expect(rs.filter((r) => r.provider === 'razorpay' && r.status === 503).length).toBeGreaterThan(
      0,
    );
  });

  it('failover to stripe during the outage brings errors back down', () => {
    const state = new DemoState();
    state.enable('provider_outage');
    state.routeTo('stripe');
    expect(errorRate(sample(state))).toBeLessThan(0.02);
  });

  it('latency_spike pushes p95 above 1 s without raising errors', () => {
    const state = new DemoState();
    state.enable('latency_spike');
    const rs = sample(state);
    expect(p95(rs)).toBeGreaterThan(1);
    expect(errorRate(rs)).toBeLessThan(0.02);
  });

  it('auth_bruteforce adds a failed login every tick; webhook_spoofing adds forged webhooks', () => {
    const state = new DemoState();
    state.enable('auth_bruteforce');
    state.enable('webhook_spoofing');
    const rng = seeded();
    const events = Array.from({ length: 200 }, () => simulateBackgroundEvents(state, rng)).flat();
    expect(events.filter((e) => e.authFailure).length).toBeGreaterThanOrEqual(200);
    expect(events.filter((e) => e.webhookSignatureFailure).length).toBeGreaterThan(20);
  });

  it('reset clears scenarios and routes back to razorpay', () => {
    const state = new DemoState();
    state.enable('provider_outage');
    state.routeTo('stripe');
    state.reset();
    expect(state.snapshot()).toEqual({
      scenarios: [],
      activeProvider: 'razorpay',
      downProviders: [],
    });
  });
});

describe('metrics', () => {
  it('exposes the five metric families and the open breaker during an outage', async () => {
    const state = new DemoState();
    const metrics = createMetrics();
    state.enable('provider_outage');
    for (let i = 0; i < 50; i++) tick(state, metrics, seeded(i));
    const text = await metrics.registry.metrics();
    for (const name of [
      'http_requests_total',
      'http_request_duration_seconds_bucket',
      'circuit_breaker_state',
      'auth_failures_total',
      'webhook_signature_failures_total',
    ]) {
      expect(text).toContain(name);
    }
    expect(text).toContain('circuit_breaker_state{service="payments-api",provider="razorpay"} 1');
    expect(text).toContain('circuit_breaker_state{service="payments-api",provider="stripe"} 0');
  });
});
