import { describe, expect, it } from 'vitest';
import {
  breakerStateFromValue,
  evaluateHealth,
  speakHealth,
  type HealthSignals,
} from '../../src/domain/health/health.js';
import { countWords } from '../../src/lib/speak.js';

const t = { errorRate: 0.05, latencyP95Seconds: 1 };
const healthy: HealthSignals = {
  errorRate: 0.004,
  latencyP95Seconds: 0.18,
  throughputRps: 19.6,
  breakers: [
    { dependency: 'razorpay', state: 'closed' },
    { dependency: 'stripe', state: 'closed' },
  ],
};

describe('evaluateHealth', () => {
  it('healthy when everything is under threshold', () => {
    expect(evaluateHealth(healthy, t)).toEqual({ status: 'healthy', reasons: [], missing: [] });
  });

  it('critical on error rate above threshold', () => {
    const a = evaluateHealth({ ...healthy, errorRate: 0.63 }, t);
    expect(a.status).toBe('critical');
    expect(a.reasons[0]).toMatchObject({ signal: 'errorRate', spoken: 'errors at 63 percent' });
  });

  it('critical on an open breaker even if errors are flat', () => {
    const a = evaluateHealth(
      { ...healthy, breakers: [{ dependency: 'razorpay', state: 'open' }] },
      t,
    );
    expect(a.status).toBe('critical');
    expect(a.reasons[0]?.spoken).toBe('razorpay breaker open');
  });

  it('degraded on latency alone or a half-open breaker', () => {
    expect(evaluateHealth({ ...healthy, latencyP95Seconds: 2.2 }, t).status).toBe('degraded');
    expect(
      evaluateHealth({ ...healthy, breakers: [{ dependency: 'x', state: 'half_open' }] }, t).status,
    ).toBe('degraded');
  });

  it('exactly at the threshold is not a breach', () => {
    expect(evaluateHealth({ ...healthy, errorRate: 0.05, latencyP95Seconds: 1 }, t).status).toBe(
      'healthy',
    );
  });

  it('reports missing signals and unknown when nothing has data', () => {
    expect(evaluateHealth({ ...healthy, latencyP95Seconds: null }, t).missing).toEqual([
      'latencyP95',
    ]);
    const none = { errorRate: null, latencyP95Seconds: null, throughputRps: null, breakers: null };
    expect(evaluateHealth(none, t).status).toBe('unknown');
  });

  it('maps breaker gauge values', () => {
    expect([0, 1, 2, 7].map(breakerStateFromValue)).toEqual([
      'closed',
      'open',
      'half_open',
      'unknown',
    ]);
  });
});

describe('speakHealth', () => {
  const speak = (s: HealthSignals) => speakHealth('payments API', s, evaluateHealth(s, t));

  it('healthy', () => {
    expect(speak(healthy)).toBe(
      'Payments API is healthy: 0.4 percent errors, p95 180 milliseconds and 20 requests per second.',
    );
  });

  it('critical: status first, then what, then next step', () => {
    const s = speak({
      ...healthy,
      errorRate: 0.63,
      breakers: [{ dependency: 'razorpay', state: 'open' }],
    });
    expect(s).toBe(
      'Critical: payments API has errors at 63 percent and razorpay breaker open. Ask me why.',
    );
    expect(countWords(s)).toBeLessThanOrEqual(30);
  });

  it('degraded also points at explain_incident', () => {
    expect(speak({ ...healthy, latencyP95Seconds: 2.2 })).toBe(
      'Degraded: payments API has p95 latency 2.2 seconds. Ask me why.',
    );
  });

  it('says "no data" instead of inventing a value', () => {
    expect(speak({ ...healthy, latencyP95Seconds: null })).toBe(
      'Payments API is healthy: 0.4 percent errors and 20 requests per second. No data for latency.',
    );
  });

  it('worst case stays within 30 words', () => {
    const s = speak({
      errorRate: 0.9,
      latencyP95Seconds: 3.4,
      throughputRps: null,
      breakers: [
        { dependency: 'razorpay', state: 'open' },
        { dependency: 'stripe', state: 'open' },
      ],
    });
    expect(countWords(s)).toBeLessThanOrEqual(30);
  });
});
