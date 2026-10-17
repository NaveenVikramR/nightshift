import { MAX_DEPLOYS, type DeployEventsClient } from '../../clients/deploys.js';
import type { PrometheusClient } from '../../clients/prometheus.js';
import { sanitizeLabel } from '../../lib/untrusted.js';
import type { ServiceDef } from '../../serviceConfig.js';
import { breakerStateFromValue } from '../health/health.js';
import type { ActionExecutor } from './executors/types.js';
import type { ActionSnapshot } from './plan.js';
import type { ActionName } from './types.js';

const HISTORY_MS = 30 * 24 * 60 * 60_000;

/**
 * Live state for preconditions. The executor's view of the target must load
 * (we never act blind); metrics are best effort (null / [] when unavailable);
 * deploy history is required for a rollback.
 */
export async function loadSnapshot(
  service: ServiceDef,
  action: ActionName,
  executor: ActionExecutor,
  deps: { prometheus: PrometheusClient; deploys: DeployEventsClient },
  now: Date,
): Promise<ActionSnapshot> {
  const q = service.queries;
  const [target, breakers, errorRate, deploys] = await Promise.all([
    executor.state(service.name),
    q.breakers
      ? deps.prometheus
          .instant(q.breakers)
          .then((samples) =>
            samples
              .filter((s) => Number.isFinite(s.value))
              .map((s) => ({
                dependency: sanitizeLabel(s.labels[service.breakerLabel]) || 'unknown',
                state: breakerStateFromValue(s.value),
              })),
          )
          .catch(() => [])
      : Promise.resolve([]),
    deps.prometheus
      .instant(q.errorRate)
      .then((s) => s.map((x) => x.value).find(Number.isFinite) ?? null)
      .catch(() => null),
    action === 'rollback_deploy'
      ? deps.deploys.listDeploys(service, {
          since: new Date(now.getTime() - HISTORY_MS),
          until: now,
          limit: MAX_DEPLOYS,
        })
      : Promise.resolve([]),
  ]);
  return { service, target, breakers, errorRate, deploys };
}
