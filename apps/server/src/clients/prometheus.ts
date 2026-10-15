import { z } from 'zod';
import { ClientError, fetchJson, type FetchLike } from './errors.js';

export interface PromSample {
  labels: Record<string, string>;
  /** May be NaN (e.g. 0/0) or ±Infinity; callers must check Number.isFinite. */
  value: number;
}

export interface PromSeries {
  labels: Record<string, string>;
  points: { time: Date; value: number }[];
}

export interface PrometheusClient {
  /** Instant query. Vector → one sample per series; scalar → one sample with no labels. */
  instant(query: string, time?: Date): Promise<PromSample[]>;
  range(query: string, start: Date, end: Date, stepSeconds: number): Promise<PromSeries[]>;
}

const sampleValue = z.tuple([z.number(), z.string()]);
const labels = z.record(z.string(), z.string());

const instantData = z.discriminatedUnion('resultType', [
  z.object({
    resultType: z.literal('vector'),
    result: z.array(z.object({ metric: labels, value: sampleValue })),
  }),
  z.object({ resultType: z.literal('scalar'), result: sampleValue }),
]);

const rangeData = z.object({
  resultType: z.literal('matrix'),
  result: z.array(z.object({ metric: labels, values: z.array(sampleValue) })),
});

export class HttpPrometheusClient implements PrometheusClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async instant(query: string, time?: Date): Promise<PromSample[]> {
    const params = new URLSearchParams({ query });
    if (time) params.set('time', String(time.getTime() / 1000));
    const data = await this.post('/api/v1/query', params, instantData);
    if (data.resultType === 'scalar') return [{ labels: {}, value: Number(data.result[1]) }];
    return data.result.map((r) => ({ labels: r.metric, value: Number(r.value[1]) }));
  }

  async range(query: string, start: Date, end: Date, stepSeconds: number): Promise<PromSeries[]> {
    const params = new URLSearchParams({
      query,
      start: String(start.getTime() / 1000),
      end: String(end.getTime() / 1000),
      step: String(stepSeconds),
    });
    const data = await this.post('/api/v1/query_range', params, rangeData);
    return data.result.map((r) => ({
      labels: r.metric,
      points: r.values.map(([t, v]) => ({ time: new Date(t * 1000), value: Number(v) })),
    }));
  }

  private async post<T extends z.ZodType>(
    path: string,
    params: URLSearchParams,
    data: T,
  ): Promise<z.infer<T>> {
    const { body } = await fetchJson(
      'Prometheus',
      `${this.baseUrl}${path}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      },
      this.timeoutMs,
      this.fetchImpl,
    );
    const parsed = z.object({ status: z.literal('success'), data }).safeParse(body);
    if (!parsed.success) throw new ClientError('Prometheus', 'bad_response', parsed.error.message);
    return (parsed.data as { data: z.infer<T> }).data;
  }
}
