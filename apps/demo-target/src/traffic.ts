import type { Metrics } from './metrics.ts';
import { simulateBackgroundEvents, simulatePaymentsRequest, type Rng } from './simulate.ts';
import type { DemoState } from './state.ts';

export const TICK_MS = 50; // 20 payments requests per second

/** One generator tick: one payments request plus background events. */
export function tick(state: DemoState, metrics: Metrics, rng: Rng = Math.random): void {
  metrics.record(simulatePaymentsRequest(state, rng));
  for (const event of simulateBackgroundEvents(state, rng)) metrics.record(event);
  metrics.updateBreakers(state);
}

export function startTraffic(state: DemoState, metrics: Metrics): () => void {
  const timer = setInterval(() => tick(state, metrics), TICK_MS);
  return () => clearInterval(timer);
}
