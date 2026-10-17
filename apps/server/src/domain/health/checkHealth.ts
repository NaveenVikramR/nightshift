import type { PrometheusClient, PromSample } from '../../clients/prometheus.js';
import { log } from '../../lib/log.js';
import { sanitizeLabel, toSpokenWords } from '../../lib/untrusted.js';
import type { ServiceDef } from '../../serviceConfig.js';
import { capitalize } from '../spoken.js';
import {
  breakerStateFromValue,
  evaluateHealth,
  speakHealth,
  type HealthAssessment,
  type HealthSignals,
} from './health.js';

export interface HealthCheck {
  signals: HealthSignals;
  assessment: HealthAssessment;
  /** Provider receiving traffic (activeProvider query), when configured. */
  activeProvider: string | null;
}

/** First finite value of a single-number query, else null (no data is never invented). */
function singleValue(samples: PromSample[]): number | null {
  const finite = samples.map((s) => s.value).filter(Number.isFinite);
  return finite.length > 0 ? finite[0]! : null;
}

/**
 * Live health of one service from its configured queries (shared by
 * get_service_health and get_ops_brief). Throws only when every core query
 * failed; a single failing query just means "no data" for that signal.
 */
export async function checkHealth(
  svc: ServiceDef,
  prometheus: PrometheusClient,
): Promise<HealthCheck> {
  const q = svc.queries;
  // Optional context: never makes the check fail on its own.
  const activeP = q.activeProvider
    ? prometheus
        .instant(q.activeProvider)
        .then((samples) => {
          const on = samples.find((x) => x.value === 1);
          return on ? sanitizeLabel(on.labels[svc.breakerLabel]) || null : null;
        })
        .catch(() => null)
    : Promise.resolve(null);
  const settled = await Promise.allSettled([
    prometheus.instant(q.errorRate),
    prometheus.instant(q.latencyP95),
    prometheus.instant(q.throughput),
    q.breakers ? prometheus.instant(q.breakers) : Promise.resolve(null),
  ]);
  const failures = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (failures.length === settled.length - (q.breakers ? 0 : 1)) throw failures[0]!.reason;
  for (const f of failures) {
    log.warn('health query failed', {
      service: svc.name,
      error: f.reason instanceof Error ? f.reason.message : 'unknown',
    });
  }

  const value = <T>(i: number, map: (s: PromSample[]) => T): T | null => {
    const s = settled[i];
    return s?.status === 'fulfilled' && s.value !== null ? map(s.value) : null;
  };
  const signals: HealthSignals = {
    errorRate: value(0, singleValue),
    latencyP95Seconds: value(1, singleValue),
    throughputRps: value(2, singleValue),
    breakers: value(3, (samples) =>
      samples
        .filter((s) => Number.isFinite(s.value))
        .map((s) => ({
          dependency: sanitizeLabel(s.labels[svc.breakerLabel]) || 'unknown dependency',
          state: breakerStateFromValue(s.value),
        })),
    ),
  };
  return {
    signals,
    assessment: evaluateHealth(signals, svc.thresholds),
    activeProvider: await activeP,
  };
}

/** get_service_health's sentence: health first, then "Routing to Stripe." after a failover. */
export function speakServiceHealth(svc: ServiceDef, h: HealthCheck): string {
  const primary = svc.actions.failover_provider?.providers[0];
  const routing =
    h.activeProvider && primary && h.activeProvider !== primary
      ? ` Routing to ${capitalize(toSpokenWords(h.activeProvider))}.`
      : '';
  return `${speakHealth(svc.displayName, h.signals, h.assessment)}${routing}`;
}
