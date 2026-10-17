import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { SimulatedRequest } from './simulate.ts';
import { PROVIDERS, type DemoState } from './state.ts';
import { PAYMENTS } from './simulate.ts';

export const BREAKER = { closed: 0, open: 1, halfOpen: 2 } as const;

export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const requests = new Counter({
    name: 'http_requests_total',
    help: 'HTTP requests handled, by service, route and status code.',
    labelNames: ['service', 'route', 'status'] as const,
    registers: [registry],
  });
  const duration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds.',
    labelNames: ['service', 'route'] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 1.5, 2.5, 5],
    registers: [registry],
  });
  const breaker = new Gauge({
    name: 'circuit_breaker_state',
    help: 'Payment provider circuit breaker: 0 closed, 1 open, 2 half-open.',
    labelNames: ['service', 'provider'] as const,
    registers: [registry],
  });
  const providerActive = new Gauge({
    name: 'payment_provider_active',
    help: 'Payment provider currently receiving traffic: 1 active, 0 standby.',
    labelNames: ['service', 'provider'] as const,
    registers: [registry],
  });
  const authFailures = new Counter({
    name: 'auth_failures_total',
    help: 'Failed authentication attempts.',
    labelNames: ['service'] as const,
    registers: [registry],
  });
  const webhookFailures = new Counter({
    name: 'webhook_signature_failures_total',
    help: 'Incoming webhooks rejected for an invalid HMAC signature.',
    labelNames: ['service'] as const,
    registers: [registry],
  });

  // Make every series exist from the start so rates are defined (no "no data").
  authFailures.inc({ service: PAYMENTS }, 0);
  webhookFailures.inc({ service: 'webhook-receiver' }, 0);

  return {
    registry,
    record(r: SimulatedRequest): void {
      requests.inc({ service: r.service, route: r.route, status: String(r.status) });
      duration.observe({ service: r.service, route: r.route }, r.durationSeconds);
      if (r.authFailure) authFailures.inc({ service: r.service });
      if (r.webhookSignatureFailure) webhookFailures.inc({ service: r.service });
    },
    updateBreakers(state: DemoState): void {
      for (const provider of PROVIDERS) {
        breaker.set(
          { service: PAYMENTS, provider },
          state.isProviderDown(provider) ? BREAKER.open : BREAKER.closed,
        );
        providerActive.set(
          { service: PAYMENTS, provider },
          state.activeProvider === provider ? 1 : 0,
        );
      }
    },
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
