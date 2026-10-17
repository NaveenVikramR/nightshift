import { z } from 'zod';
import type { PromSample } from '../clients/prometheus.js';
import {
  breakerStateFromValue,
  evaluateHealth,
  speakHealth,
  type HealthAssessment,
  type HealthSignals,
} from '../domain/health/health.js';
import { log } from '../lib/log.js';
import { capitalize } from '../domain/spoken.js';
import { sanitizeLabel, toSpokenWords } from '../lib/untrusted.js';
import { lookupService, type Clarification } from './common.js';
import type { ToolDefinition } from './types.js';

const inputSchema = z.object({
  service: z
    .string()
    .max(60)
    .optional()
    .describe(
      'Service name as the user said it, e.g. "payments" or "the webhook service". Optional when only one service is configured.',
    ),
});

export interface ServiceHealthData {
  service: string;
  displayName: string;
  status: HealthAssessment['status'];
  signals: HealthSignals;
  thresholds: { errorRate: number; latencyP95Seconds: number };
  reasons: HealthAssessment['reasons'];
  missing: HealthAssessment['missing'];
  /** Provider currently receiving traffic (from the activeProvider query), when configured. */
  activeProvider: string | null;
  checkedAt: string;
}

/** First finite value of a single-number query, else null (no data is never invented). */
function singleValue(samples: PromSample[]): number | null {
  const finite = samples.map((s) => s.value).filter(Number.isFinite);
  return finite.length > 0 ? finite[0]! : null;
}

export const getServiceHealth: ToolDefinition<
  typeof inputSchema,
  ServiceHealthData | Clarification
> = {
  name: 'get_service_health',
  title: 'Get service health',
  description:
    "Check one service's live metrics from Prometheus: error rate, p95 latency, throughput and circuit breaker states, " +
    'with an overall healthy, degraded or critical status. Use when the user asks how a service is doing. ' +
    'Read only; for firing alerts use list_active_alerts.',
  inputSchema,
  minRole: 'viewer',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },

  async handler(input, { deps }) {
    const found = lookupService(input.service, deps.services);
    if (found.kind === 'clarify') return found.output;
    const svc = found.service;
    const q = svc.queries;

    // Optional context: never makes the check fail on its own.
    const activeP = q.activeProvider
      ? deps.prometheus
          .instant(q.activeProvider)
          .then((samples) => {
            const on = samples.find((x) => x.value === 1);
            return on ? sanitizeLabel(on.labels[svc.breakerLabel]) || null : null;
          })
          .catch(() => null)
      : Promise.resolve(null);
    const settled = await Promise.allSettled([
      deps.prometheus.instant(q.errorRate),
      deps.prometheus.instant(q.latencyP95),
      deps.prometheus.instant(q.throughput),
      q.breakers ? deps.prometheus.instant(q.breakers) : Promise.resolve(null),
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

    const assessment = evaluateHealth(signals, svc.thresholds);
    const activeProvider = await activeP;
    const primary = svc.actions.failover_provider?.providers[0];
    const routing =
      activeProvider && primary && activeProvider !== primary
        ? ` Routing to ${capitalize(toSpokenWords(activeProvider))}.`
        : '';
    return {
      speak: `${speakHealth(svc.displayName, signals, assessment)}${routing}`,
      data: {
        service: svc.name,
        displayName: svc.displayName,
        status: assessment.status,
        signals,
        thresholds: svc.thresholds,
        reasons: assessment.reasons,
        missing: assessment.missing,
        activeProvider,
        checkedAt: deps.now().toISOString(),
      },
    };
  },
};
