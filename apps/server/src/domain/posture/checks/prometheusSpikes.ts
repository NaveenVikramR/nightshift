import type { PrometheusClient } from '../../../clients/prometheus.js';
import type { ServiceDef } from '../../../serviceConfig.js';
import type { Check, CheckResult, RawFinding } from '../types.js';

const WINDOW_MS = 15 * 60_000;

type Signal = 'authFailures' | 'webhookFailures';

const SIGNALS: Record<
  Signal,
  {
    check: 'auth_failure_spike' | 'webhook_signature_failures';
    threshold: 'authFailuresPerSecond' | 'webhookFailuresPerSecond';
    what: string;
  }
> = {
  authFailures: {
    check: 'auth_failure_spike',
    threshold: 'authFailuresPerSecond',
    what: 'failed-login spike',
  },
  webhookFailures: {
    check: 'webhook_signature_failures',
    threshold: 'webhookFailuresPerSecond',
    what: 'webhook signature failures',
  },
};

/**
 * Max of a per-second rate over the last 15 minutes vs the service threshold:
 * over it → medium, 5× over → high. Services without the query are skipped.
 */
export class PrometheusSpikeCheck implements Check {
  readonly name: 'auth_failure_spike' | 'webhook_signature_failures';

  constructor(
    private readonly signal: Signal,
    private readonly services: readonly ServiceDef[],
    private readonly prometheus: PrometheusClient,
    private readonly now: () => Date,
  ) {
    this.name = SIGNALS[signal].check;
  }

  async run(): Promise<CheckResult> {
    const cfg = SIGNALS[this.signal];
    const targets = this.services.filter((s) => s.queries[this.signal] !== undefined);
    if (targets.length === 0) {
      return {
        check: this.name,
        status: 'not_configured',
        findings: [],
        checked: [],
        note: `no ${this.signal} query configured`,
      };
    }
    const end = this.now();
    const start = new Date(end.getTime() - WINDOW_MS);
    const findings: RawFinding[] = [];
    const checked: string[] = [];
    for (const svc of targets) {
      let series;
      try {
        series = await this.prometheus.range(svc.queries[this.signal]!, start, end, 60);
      } catch {
        continue;
      }
      checked.push(svc.name);
      const values = series.flatMap((s) => s.points.map((p) => p.value)).filter(Number.isFinite);
      const peak = values.length > 0 ? Math.max(...values) : null;
      const threshold = svc.thresholds[cfg.threshold];
      if (peak !== null && peak > threshold) {
        findings.push({
          check: this.name,
          target: svc.name,
          key: this.signal,
          severity: peak > threshold * 5 ? 'high' : 'medium',
          title: `${cfg.what} on ${svc.displayName}`,
          detail: {
            service: svc.name,
            peakPerSecond: Number(peak.toFixed(3)),
            thresholdPerSecond: threshold,
            windowMinutes: 15,
          },
        });
      }
    }
    if (checked.length === 0) {
      return {
        check: this.name,
        status: 'error',
        findings: [],
        checked,
        note: 'Prometheus did not answer',
      };
    }
    return { check: this.name, status: findings.length > 0 ? 'findings' : 'ok', findings, checked };
  }
}
