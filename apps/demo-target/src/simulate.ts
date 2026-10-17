import type { DemoState, Provider } from './state.ts';

export const PAYMENTS = 'payments-api';
export const WEBHOOKS = 'webhook-receiver';

export interface SimulatedRequest {
  service: string;
  route: string;
  status: number;
  durationSeconds: number;
  provider?: Provider;
  authFailure?: boolean;
  webhookSignatureFailure?: boolean;
}

export type Rng = () => number;

/** Baseline latency: mostly 40–200 ms with a light tail. */
function baselineLatency(rng: Rng): number {
  const r = rng();
  return r < 0.95 ? 0.04 + rng() * 0.16 : 0.2 + rng() * 0.3;
}

/** One simulated payments-api request under the current chaos state. Pure given rng. */
export function simulatePaymentsRequest(state: DemoState, rng: Rng): SimulatedRequest {
  const pick = rng();
  const route = pick < 0.6 ? '/charge' : pick < 0.7 ? '/refund' : '/status';
  const usesProvider = route !== '/status';
  const provider = usesProvider ? state.activeProvider : undefined;

  let durationSeconds = baselineLatency(rng);
  if (state.active.has('latency_spike') && rng() < 0.8) durationSeconds = 1.2 + rng() * 1.8;

  let status = rng() < 0.005 ? 500 : 200; // 0.5% background errors
  if (provider && state.isProviderDown(provider) && rng() < 0.9) {
    status = 503; // breaker open: fail fast
    durationSeconds = 0.005 + rng() * 0.01;
  }
  if (state.isRestarting()) {
    status = 503; // restarting: not ready
    durationSeconds = 0.002 + rng() * 0.003;
  }

  return { service: PAYMENTS, route, status, durationSeconds, ...(provider && { provider }) };
}

/** Extra events for the current tick (called 20x per second). */
export function simulateBackgroundEvents(state: DemoState, rng: Rng): SimulatedRequest[] {
  const events: SimulatedRequest[] = [];

  // Logins: ~1/s normally (2% fail), ~10 failing logins/s under brute force.
  if (rng() < 0.05) {
    const fail = rng() < 0.02;
    events.push({
      service: PAYMENTS,
      route: '/login',
      status: fail ? 401 : 200,
      durationSeconds: baselineLatency(rng),
      ...(fail && { authFailure: true }),
    });
  }
  if (state.active.has('auth_bruteforce')) {
    events.push({
      service: PAYMENTS,
      route: '/login',
      status: 401,
      durationSeconds: 0.02 + rng() * 0.03,
      authFailure: true,
    });
  }

  // Webhooks: ~2/s valid; ~4 forged/s under spoofing.
  if (rng() < 0.1) {
    events.push({
      service: WEBHOOKS,
      route: '/webhooks/razorpay',
      status: 200,
      durationSeconds: 0.01 + rng() * 0.04,
    });
  }
  if (state.active.has('webhook_spoofing') && rng() < 0.2) {
    events.push({
      service: WEBHOOKS,
      route: '/webhooks/razorpay',
      status: 401,
      durationSeconds: 0.005 + rng() * 0.01,
      webhookSignatureFailure: true,
    });
  }
  return events;
}
