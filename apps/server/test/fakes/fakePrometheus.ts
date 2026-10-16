import { ClientError, type ClientErrorKind } from '../../src/clients/errors.js';
import type { PrometheusClient, PromSample, PromSeries } from '../../src/clients/prometheus.js';

/** Scriptable in-memory Prometheus: answers by exact query string. */
export class FakePrometheus implements PrometheusClient {
  readonly queries: string[] = [];
  readonly rangeCalls: { query: string; start: Date; end: Date; stepSeconds: number }[] = [];
  private readonly answers = new Map<string, PromSample[]>();
  private readonly rangeAnswers = new Map<string, PromSeries[]>();
  /** Queries that fail on their own (others keep working). */
  readonly failing = new Map<string, ClientErrorKind>();
  failWith: ClientErrorKind | undefined;

  set(query: string, samples: PromSample[] | number): this {
    this.answers.set(
      query,
      typeof samples === 'number' ? [{ labels: {}, value: samples }] : samples,
    );
    return this;
  }

  /** Script a range query: one series (points) or several (with labels). */
  setRange(query: string, series: PromSeries[] | PromSeries['points']): this {
    const list = series.length > 0 && 'points' in series[0]! ? (series as PromSeries[]) : null;
    this.rangeAnswers.set(query, list ?? [{ labels: {}, points: series as PromSeries['points'] }]);
    return this;
  }

  private check(query: string): void {
    const kind = this.failWith ?? this.failing.get(query);
    if (kind) throw new ClientError('Prometheus', kind);
  }

  async instant(query: string): Promise<PromSample[]> {
    this.queries.push(query);
    this.check(query);
    return this.answers.get(query) ?? [];
  }

  async range(query: string, start: Date, end: Date, stepSeconds: number): Promise<PromSeries[]> {
    this.queries.push(query);
    this.rangeCalls.push({ query, start, end, stepSeconds });
    this.check(query);
    const scripted = this.rangeAnswers.get(query);
    if (scripted) return structuredClone(scripted);
    return (this.answers.get(query) ?? []).map((s) => ({
      labels: s.labels,
      points: [{ time: new Date(0), value: s.value }],
    }));
  }
}
