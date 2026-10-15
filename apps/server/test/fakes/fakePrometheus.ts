import { ClientError, type ClientErrorKind } from '../../src/clients/errors.js';
import type { PrometheusClient, PromSample, PromSeries } from '../../src/clients/prometheus.js';

/** Scriptable in-memory Prometheus: answers by exact query string. */
export class FakePrometheus implements PrometheusClient {
  readonly queries: string[] = [];
  private readonly answers = new Map<string, PromSample[]>();
  failWith: ClientErrorKind | undefined;

  set(query: string, samples: PromSample[] | number): this {
    this.answers.set(
      query,
      typeof samples === 'number' ? [{ labels: {}, value: samples }] : samples,
    );
    return this;
  }

  async instant(query: string): Promise<PromSample[]> {
    this.queries.push(query);
    if (this.failWith) throw new ClientError('Prometheus', this.failWith);
    return this.answers.get(query) ?? [];
  }

  async range(query: string): Promise<PromSeries[]> {
    this.queries.push(query);
    if (this.failWith) throw new ClientError('Prometheus', this.failWith);
    return (this.answers.get(query) ?? []).map((s) => ({
      labels: s.labels,
      points: [{ time: new Date(0), value: s.value }],
    }));
  }
}
