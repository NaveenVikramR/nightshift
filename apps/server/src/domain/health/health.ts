import { capitalize, spokenList, spokenPercent, spokenRate, spokenSeconds } from '../spoken.js';

export type BreakerState = 'closed' | 'open' | 'half_open' | 'unknown';

/** Measured signals; null = no data (never invented). */
export interface HealthSignals {
  errorRate: number | null;
  latencyP95Seconds: number | null;
  throughputRps: number | null;
  /** null when the service has no breaker query. */
  breakers: { dependency: string; state: BreakerState }[] | null;
}

export interface HealthThresholds {
  errorRate: number;
  latencyP95Seconds: number;
}

export type HealthStatus = 'healthy' | 'degraded' | 'critical' | 'unknown';

export interface HealthReason {
  severity: 'critical' | 'warning';
  signal: 'errorRate' | 'latencyP95' | 'breaker';
  /** Spoken fragment: "errors at 63 percent", "razorpay breaker open". */
  spoken: string;
}

export interface HealthAssessment {
  status: HealthStatus;
  reasons: HealthReason[];
  missing: ('errorRate' | 'latencyP95' | 'throughput')[];
}

export function breakerStateFromValue(value: number): BreakerState {
  if (value === 0) return 'closed';
  if (value === 1) return 'open';
  if (value === 2) return 'half_open';
  return 'unknown';
}

/**
 * Deterministic rules (pure):
 * - critical: error rate above threshold, or any breaker open
 * - degraded: p95 above threshold, or any breaker half-open
 * - unknown: no signal had data
 */
export function evaluateHealth(s: HealthSignals, t: HealthThresholds): HealthAssessment {
  const reasons: HealthReason[] = [];
  if (s.errorRate !== null && s.errorRate > t.errorRate) {
    reasons.push({
      severity: 'critical',
      signal: 'errorRate',
      spoken: `errors at ${spokenPercent(s.errorRate)}`,
    });
  }
  for (const b of s.breakers ?? []) {
    if (b.state === 'open') {
      reasons.push({
        severity: 'critical',
        signal: 'breaker',
        spoken: `${b.dependency} breaker open`,
      });
    } else if (b.state === 'half_open') {
      reasons.push({
        severity: 'warning',
        signal: 'breaker',
        spoken: `${b.dependency} breaker half open`,
      });
    }
  }
  if (s.latencyP95Seconds !== null && s.latencyP95Seconds > t.latencyP95Seconds) {
    reasons.push({
      severity: 'warning',
      signal: 'latencyP95',
      spoken: `p95 latency ${spokenSeconds(s.latencyP95Seconds)}`,
    });
  }

  const missing: HealthAssessment['missing'] = [];
  if (s.errorRate === null) missing.push('errorRate');
  if (s.latencyP95Seconds === null) missing.push('latencyP95');
  if (s.throughputRps === null) missing.push('throughput');

  const allMissing = missing.length === 3 && (s.breakers ?? []).length === 0;
  const status: HealthStatus = reasons.some((r) => r.severity === 'critical')
    ? 'critical'
    : reasons.length > 0
      ? 'degraded'
      : allMissing
        ? 'unknown'
        : 'healthy';
  return { status, reasons, missing };
}

const MISSING_WORDS = {
  errorRate: 'errors',
  latencyP95: 'latency',
  throughput: 'traffic',
} as const;

/** ≤ 30 words: status first, then what, then next step. */
export function speakHealth(displayName: string, s: HealthSignals, a: HealthAssessment): string {
  const name = displayName;
  if (a.status === 'unknown') {
    return `I have no data for ${name} right now. Prometheus may not be scraping it. Check the service config.`;
  }
  const noData =
    a.missing.length > 0
      ? ` No data for ${spokenList(a.missing.map((m) => MISSING_WORDS[m]))}.`
      : '';
  if (a.status === 'healthy') {
    const parts = [
      s.errorRate !== null ? `${spokenPercent(s.errorRate)} errors` : null,
      s.latencyP95Seconds !== null ? `p95 ${spokenSeconds(s.latencyP95Seconds)}` : null,
      s.throughputRps !== null ? spokenRate(s.throughputRps) : null,
    ].filter((p): p is string => p !== null);
    return `${capitalize(name)} is healthy: ${spokenList(parts)}.${noData}`;
  }
  const label = a.status === 'critical' ? 'Critical' : 'Degraded';
  const reasons = spokenList(a.reasons.slice(0, 3).map((r) => r.spoken));
  // explain_incident answers "why" for both critical and degraded.
  const next = ' Ask me why.';
  return `${label}: ${name} has ${reasons}.${noData}${next}`;
}
