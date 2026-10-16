import type { AlertmanagerClient } from '../../clients/alertmanager.js';
import type { DeployEvent, DeployEventsClient } from '../../clients/deploys.js';
import { ClientError, type Upstream } from '../../clients/errors.js';
import type { PrometheusClient, PromSeries } from '../../clients/prometheus.js';
import { sanitizeLabel } from '../../lib/untrusted.js';
import type { ServiceDef } from '../../serviceConfig.js';
import { toAlertView, type AlertView } from '../alerts/alerts.js';
import { finitePoints, type Point } from './changeDetection.js';

export const SIGNALS = [
  'errorRate',
  'latencyP95',
  'throughput',
  'authFailures',
  'webhookFailures',
] as const;
export type SignalName = (typeof SIGNALS)[number];

export type SourceName = 'alertmanager' | 'deploys' | SignalName | 'breakers';

export interface SourceStatus {
  source: SourceName;
  status: 'ok' | 'unavailable' | 'not_configured';
  /** ClientError kind (unreachable, timeout, ...); never upstream text. */
  reason?: string;
}

export interface BreakerSeries {
  dependency: string;
  points: Point[];
}

/** Everything explain_incident reasons over. Every value comes from a source; nothing is filled in. */
export interface Evidence {
  service: Pick<ServiceDef, 'name' | 'displayName' | 'thresholds'>;
  window: { start: Date; end: Date; stepSeconds: number };
  /** Current alerts for this service (sanitized; annotations quoted). */
  alerts: AlertView[];
  /** Finite points only; a signal is absent when not configured or unavailable. */
  series: Partial<Record<SignalName, Point[]>>;
  breakers: BreakerSeries[];
  /** Newest first; from window.start − deployLeadMinutes to window.end. */
  deploys: DeployEvent[];
  sources: SourceStatus[];
}

export interface EvidenceDeps {
  prometheus: PrometheusClient;
  alertmanager: AlertmanagerClient;
  deploys: DeployEventsClient;
  services: readonly ServiceDef[];
}

export interface EvidenceOptions {
  end: Date;
  lookbackMinutes?: number;
  stepSeconds?: number;
  /** Deploys this long before the window still count (they may explain its start). */
  deployLeadMinutes?: number;
  /** Per-source cap on top of each client's own timeout. */
  timeoutMs?: number;
  /** Alerts already loaded by the caller (avoids a second Alertmanager call). */
  alerts?: readonly AlertView[];
}

export const LOOKBACK = { default: 60, min: 10, max: 180 } as const;

function withTimeout<T>(p: Promise<T>, ms: number, upstream: Upstream): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ClientError(upstream, 'timeout', `no answer in ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const reasonOf = (err: unknown) => (err instanceof ClientError ? err.kind : 'error');

const single = (s: PromSeries[]): Point[] => finitePoints(s[0]?.points ?? []);

/**
 * Collect evidence for one service, all sources in parallel. A failing source
 * is recorded as unavailable and the rest still count (partial failure is
 * fine). Throws only when every source failed, so the caller can say which
 * upstream is down.
 */
export async function collectEvidence(
  service: ServiceDef,
  deps: EvidenceDeps,
  opts: EvidenceOptions,
): Promise<Evidence> {
  const lookback = Math.min(
    LOOKBACK.max,
    Math.max(LOOKBACK.min, opts.lookbackMinutes ?? LOOKBACK.default),
  );
  const stepSeconds = opts.stepSeconds ?? 30;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const end = opts.end;
  const start = new Date(end.getTime() - lookback * 60_000);
  const deploySince = new Date(start.getTime() - (opts.deployLeadMinutes ?? 10) * 60_000);
  const q = service.queries;

  const range = (query: string) =>
    withTimeout(deps.prometheus.range(query, start, end, stepSeconds), timeoutMs, 'Prometheus');

  const signalQueries: [SignalName, string | undefined][] = [
    ['errorRate', q.errorRate],
    ['latencyP95', q.latencyP95],
    ['throughput', q.throughput],
    ['authFailures', q.authFailures],
    ['webhookFailures', q.webhookFailures],
  ];
  const configured = signalQueries.filter((e): e is [SignalName, string] => e[1] !== undefined);
  const deploySource = deps.deploys.sourceFor(service);

  const [alertsR, breakersR, deploysR, ...signalR] = await Promise.allSettled([
    opts.alerts
      ? Promise.resolve([...opts.alerts])
      : withTimeout(deps.alertmanager.listAlerts(), timeoutMs, 'Alertmanager').then((as) =>
          as.map((a) => toAlertView(a, deps.services)),
        ),
    q.breakers ? range(q.breakers) : Promise.resolve(null),
    deploySource
      ? withTimeout(
          deps.deploys.listDeploys(service, { since: deploySince, until: end, limit: 10 }),
          timeoutMs,
          deploySource === 'github' ? 'GitHub' : 'Database',
        )
      : Promise.resolve(null),
    ...configured.map(([, query]) => range(query)),
  ]);

  const sources: SourceStatus[] = [];
  const failures: unknown[] = [];
  const settle = <T>(source: SourceName, r: PromiseSettledResult<T>, isConfigured = true) => {
    if (!isConfigured) {
      sources.push({ source, status: 'not_configured' });
      return undefined;
    }
    if (r.status === 'fulfilled') {
      sources.push({ source, status: 'ok' });
      return r.value;
    }
    failures.push(r.reason);
    sources.push({ source, status: 'unavailable', reason: reasonOf(r.reason) });
    return undefined;
  };

  const alerts = (settle('alertmanager', alertsR) ?? []).filter((a) => a.service === service.name);
  const breakerSeries = settle('breakers', breakersR, q.breakers !== undefined) ?? null;
  const deploys = settle('deploys', deploysR, deploySource !== null) ?? null;

  const series: Evidence['series'] = {};
  configured.forEach(([name], i) => {
    const r = settle(name, signalR[i]!);
    if (r) series[name] = single(r);
  });
  for (const [name, query] of signalQueries) {
    if (query === undefined) sources.push({ source: name, status: 'not_configured' });
  }

  const attempted = sources.filter((s) => s.status !== 'not_configured').length;
  if (failures.length > 0 && failures.length === attempted) {
    throw failures.find((f) => f instanceof ClientError) ?? failures[0];
  }

  return {
    service: {
      name: service.name,
      displayName: service.displayName,
      thresholds: service.thresholds,
    },
    window: { start, end, stepSeconds },
    alerts,
    series,
    breakers: (breakerSeries ?? []).map((s) => ({
      dependency: sanitizeLabel(s.labels[service.breakerLabel]) || 'unknown dependency',
      points: finitePoints(s.points),
    })),
    deploys: deploys ?? [],
    sources,
  };
}
