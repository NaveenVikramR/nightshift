import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config.js';
import { loadServiceConfig, parseServiceConfig } from '../src/serviceConfig.js';

const minimal = {
  prometheus: { url: 'http://127.0.0.1:9090/' },
  alertmanager: { url: 'http://127.0.0.1:9093' },
  services: [
    {
      name: 'payments-api',
      displayName: 'payments API',
      queries: { errorRate: 'a', latencyP95: 'b', throughput: 'c' },
    },
  ],
};

describe('service config', () => {
  it('loads and validates the shipped config/nightshift.yaml', () => {
    const c = loadServiceConfig('config/nightshift.yaml', {});
    expect(c.services.map((s) => s.name)).toEqual(['payments-api', 'webhook-receiver']);
    expect(c.services[0]?.queries.breakers).toContain('circuit_breaker_state');
    expect(c.security.headers.map((h) => h.url)).toEqual(['http://127.0.0.1:18080']);
    expect(c.security.tls).toEqual([]);
  });

  it('applies defaults and strips trailing slashes', () => {
    const c = parseServiceConfig(minimal, {});
    expect(c.prometheus).toEqual({ url: 'http://127.0.0.1:9090', timeoutMs: 5000 });
    expect(c.services[0]).toMatchObject({
      aliases: [],
      breakerLabel: 'provider',
      thresholds: { errorRate: 0.05, latencyP95Seconds: 1 },
    });
  });

  it('lets PROMETHEUS_URL / ALERTMANAGER_URL override the file', () => {
    const c = parseServiceConfig(minimal, {
      PROMETHEUS_URL: 'https://prom.example',
      ALERTMANAGER_URL: 'https://am.example',
    });
    expect(c.prometheus.url).toBe('https://prom.example');
    expect(c.alertmanager.url).toBe('https://am.example');
  });

  it.each([
    ['no services', { ...minimal, services: [] }],
    ['bad URL scheme', { ...minimal, prometheus: { url: 'file:///etc/passwd' } }],
    ['duplicate names', { ...minimal, services: [minimal.services[0], minimal.services[0]] }],
    [
      'missing query',
      { ...minimal, services: [{ name: 'x', displayName: 'x', queries: { errorRate: 'a' } }] },
    ],
    [
      'error threshold above 1',
      {
        ...minimal,
        services: [{ ...minimal.services[0], thresholds: { errorRate: 5 } }],
      },
    ],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseServiceConfig(raw, {})).toThrow(ConfigError);
  });

  it('parses deploy sources, security thresholds and the display time zone', () => {
    const c = parseServiceConfig(
      {
        ...minimal,
        display: { timeZone: 'Asia/Kolkata' },
        services: [
          { ...minimal.services[0], deploys: { source: 'github', repo: 'acme/payments' } },
        ],
      },
      {},
    );
    expect(c.display.timeZone).toBe('Asia/Kolkata');
    expect(c.services[0]?.deploys).toEqual({
      source: 'github',
      repo: 'acme/payments',
      environment: 'production',
    });
    expect(c.services[0]?.thresholds).toMatchObject({
      authFailuresPerSecond: 2,
      webhookFailuresPerSecond: 0.5,
    });
    expect(parseServiceConfig(minimal, {}).display.timeZone).toBe('UTC');
  });

  it.each([
    ['unknown time zone', { ...minimal, display: { timeZone: 'Mars/Olympus' } }],
    [
      'github source without repo',
      { ...minimal, services: [{ ...minimal.services[0], deploys: { source: 'github' } }] },
    ],
    [
      'unknown deploy source',
      { ...minimal, services: [{ ...minimal.services[0], deploys: { source: 'jenkins' } }] },
    ],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseServiceConfig(raw, {})).toThrow(ConfigError);
  });

  it('reports a missing file clearly', () => {
    expect(() => loadServiceConfig('config/does-not-exist.yaml', {})).toThrow(/Can't read/);
  });
});
