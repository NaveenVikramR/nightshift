import { z } from 'zod';
import { checkHealth, speakServiceHealth } from '../domain/health/checkHealth.js';
import type { HealthAssessment, HealthSignals } from '../domain/health/health.js';
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
    const h = await checkHealth(svc, deps.prometheus);
    const { signals, assessment, activeProvider } = h;
    return {
      speak: speakServiceHealth(svc, h),
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
