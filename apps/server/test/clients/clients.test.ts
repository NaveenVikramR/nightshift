import { describe, expect, it } from 'vitest';
import { HttpAlertmanagerClient } from '../../src/clients/alertmanager.js';
import { ClientError } from '../../src/clients/errors.js';
import { HttpPrometheusClient } from '../../src/clients/prometheus.js';
import { json, kindOf, stubFetch } from '../fakes/stubFetch.js';

describe('HttpPrometheusClient', () => {
  it('parses a vector result, including NaN values', async () => {
    const { fetch, calls } = stubFetch(() =>
      json({
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            { metric: { provider: 'razorpay' }, value: [1, '1'] },
            { metric: { provider: 'stripe' }, value: [1, 'NaN'] },
          ],
        },
      }),
    );
    const prom = new HttpPrometheusClient('http://prom', 1000, fetch);
    const samples = await prom.instant('circuit_breaker_state');
    expect(samples[0]).toEqual({ labels: { provider: 'razorpay' }, value: 1 });
    expect(Number.isNaN(samples[1]?.value)).toBe(true);
    expect(calls[0]?.url).toBe('http://prom/api/v1/query');
    expect(String(calls[0]?.init?.body)).toBe('query=circuit_breaker_state');
  });

  it('parses a scalar result', async () => {
    const { fetch } = stubFetch(() =>
      json({ status: 'success', data: { resultType: 'scalar', result: [1, '0.25'] } }),
    );
    expect(await new HttpPrometheusClient('http://p', 1000, fetch).instant('0.25')).toEqual([
      { labels: {}, value: 0.25 },
    ]);
  });

  it('parses a range (matrix) result', async () => {
    const { fetch } = stubFetch(() =>
      json({
        status: 'success',
        data: {
          resultType: 'matrix',
          result: [
            {
              metric: {},
              values: [
                [10, '2'],
                [20, '3'],
              ],
            },
          ],
        },
      }),
    );
    const series = await new HttpPrometheusClient('http://p', 1000, fetch).range(
      'up',
      new Date(0),
      new Date(20_000),
      10,
    );
    expect(series[0]?.points.map((p) => p.value)).toEqual([2, 3]);
  });

  it.each([
    ['network error → unreachable', () => new TypeError('fetch failed'), 'unreachable'],
    ['timeout → timeout', () => new DOMException('timed out', 'TimeoutError'), 'timeout'],
    [
      'bad PromQL (400) → rejected',
      () => json({ status: 'error', errorType: 'bad_data', error: 'parse error' }, 400),
      'rejected',
    ],
    ['503 → unreachable', () => new Response('down', { status: 503 }), 'unreachable'],
    ['HTML body → bad_response', () => new Response('<html>', { status: 200 }), 'bad_response'],
    [
      'unexpected shape → bad_response',
      () => json({ status: 'success', data: {} }),
      'bad_response',
    ],
  ])('%s', async (_label, respond, kind) => {
    const { fetch } = stubFetch(respond);
    expect(await kindOf(new HttpPrometheusClient('http://p', 1000, fetch).instant('up'))).toBe(
      kind,
    );
  });

  it('errors carry a user-safe speak with no URL or detail', async () => {
    const { fetch } = stubFetch(() => new TypeError('connect ECONNREFUSED 10.0.0.5:9090'));
    try {
      await new HttpPrometheusClient('http://10.0.0.5:9090', 1000, fetch).instant('up');
    } catch (e) {
      expect((e as ClientError).speak).toBe("I couldn't reach Prometheus. Try again in a minute.");
    }
  });
});

describe('HttpAlertmanagerClient', () => {
  const apiAlert = {
    fingerprint: 'abc123',
    labels: { alertname: 'HighErrorRate', service: 'payments-api', severity: 'critical' },
    annotations: { summary: 'payments-api 5xx error rate is 63%' },
    startsAt: '2026-10-16T11:57:00.000Z',
    endsAt: '2026-10-16T12:10:00.000Z',
    status: { state: 'active', silencedBy: [], inhibitedBy: [] },
    receivers: [{ name: 'null' }],
    updatedAt: '2026-10-16T11:58:00.000Z',
  };

  it('lists alerts from API v2, including silenced and inhibited ones', async () => {
    const { fetch, calls } = stubFetch(() => json([apiAlert]));
    const alerts = await new HttpAlertmanagerClient('http://am', 1000, fetch).listAlerts();
    expect(calls[0]?.url).toBe('http://am/api/v2/alerts?active=true&silenced=true&inhibited=true');
    expect(alerts[0]).toMatchObject({
      fingerprint: 'abc123',
      state: 'active',
      startsAt: new Date('2026-10-16T11:57:00.000Z'),
    });
  });

  it('creates a silence and returns its id', async () => {
    const { fetch, calls } = stubFetch(() => json({ silenceID: 'sil-1' }));
    const id = await new HttpAlertmanagerClient('http://am', 1000, fetch).createSilence({
      matchers: [{ name: 'alertname', value: 'HighErrorRate', isRegex: false, isEqual: true }],
      startsAt: new Date('2026-10-16T12:00:00Z'),
      endsAt: new Date('2026-10-16T13:00:00Z'),
      createdBy: 'nightshift:alice',
      comment: 'nightshift:alice',
    });
    expect(id).toBe('sil-1');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      endsAt: '2026-10-16T13:00:00.000Z',
      createdBy: 'nightshift:alice',
    });
  });

  it('lists silences', async () => {
    const { fetch } = stubFetch(() =>
      json([
        {
          id: 's1',
          matchers: [{ name: 'alertname', value: 'X', isRegex: false }],
          startsAt: '2026-10-16T12:00:00Z',
          endsAt: '2026-10-16T13:00:00Z',
          createdBy: 'nightshift:alice',
          comment: 'c',
          status: { state: 'active' },
          updatedAt: '2026-10-16T12:00:00Z',
        },
      ]),
    );
    const [s] = await new HttpAlertmanagerClient('http://am', 1000, fetch).listSilences();
    expect(s).toMatchObject({ id: 's1', state: 'active' });
    expect(s?.matchers[0]?.isEqual).toBe(true);
  });

  it('maps malformed alert payloads to bad_response', async () => {
    const { fetch } = stubFetch(() => json([{ labels: 'nope' }]));
    expect(await kindOf(new HttpAlertmanagerClient('http://am', 1000, fetch).listAlerts())).toBe(
      'bad_response',
    );
  });
});
