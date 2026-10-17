import { describe, expect, it } from 'vitest';
import { AdminApiExecutor } from '../../src/domain/actions/executors/adminApi.js';
import { GitHubWorkflowExecutor } from '../../src/domain/actions/executors/githubWorkflow.js';
import { ExecutorRegistry } from '../../src/domain/actions/executors/registry.js';
import { ConfigError } from '../../src/config.js';
import { parseServiceConfig } from '../../src/serviceConfig.js';
import { json, kindOf, stubFetch } from '../fakes/stubFetch.js';

const state = { activeProvider: 'razorpay', version: 'v1.4.2', restarting: false, scenarios: [] };

describe('AdminApiExecutor', () => {
  it('reads target state with the bearer token', async () => {
    const { fetch, calls } = stubFetch(() => json(state));
    const ex = new AdminApiExecutor('demo-admin', 'http://demo.test', 'secret', 1000, fetch);
    expect(await ex.state('payments-api')).toEqual({
      activeProvider: 'razorpay',
      version: 'v1.4.2',
      restarting: false,
    });
    expect(calls[0]!.url).toBe('http://demo.test/admin/state');
    expect((calls[0]!.init?.headers as Record<string, string>)['authorization']).toBe(
      'Bearer secret',
    );
  });

  it.each([
    [
      { action: 'failover_provider', service: 'payments-api', from: 'razorpay', to: 'stripe' },
      '/admin/route-provider',
      { provider: 'stripe' },
    ],
    [
      {
        action: 'rollback_deploy',
        service: 'payments-api',
        fromVersion: 'v1.4.2',
        toVersion: 'v1.4.1',
      },
      '/admin/rollback',
      { version: 'v1.4.1' },
    ],
    [{ action: 'restart_service', service: 'payments-api' }, '/admin/restart', {}],
  ] as const)('%o → POST %s', async (action, path, body) => {
    const { fetch, calls } = stubFetch(() => json(state));
    const ex = new AdminApiExecutor('demo-admin', 'http://demo.test', 'secret', 1000, fetch);
    const r = await ex.execute(action);
    expect(calls[0]!.url).toBe(`http://demo.test${path}`);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(body);
    expect(r.detail).toMatchObject({ endpoint: path, activeProvider: 'razorpay' });
  });

  it('refuses without a token and never calls the target', async () => {
    const { fetch, calls } = stubFetch(() => json(state));
    const ex = new AdminApiExecutor('demo-admin', 'http://demo.test', undefined, 1000, fetch);
    expect(await kindOf(ex.execute({ action: 'restart_service', service: 'x' }))).toBe('rejected');
    expect(calls).toHaveLength(0);
  });

  it('maps target failures to typed errors (never success)', async () => {
    const denied = new AdminApiExecutor(
      'd',
      'http://demo.test',
      's',
      1000,
      stubFetch(() => json({}, 401)).fetch,
    );
    expect(await kindOf(denied.execute({ action: 'restart_service', service: 'x' }))).toBe(
      'rejected',
    );
    const down = new AdminApiExecutor(
      'd',
      'http://demo.test',
      's',
      1000,
      stubFetch(() => new Error('ECONNREFUSED')).fetch,
    );
    expect(await kindOf(down.execute({ action: 'restart_service', service: 'x' }))).toBe(
      'unreachable',
    );
  });
});

describe('GitHubWorkflowExecutor', () => {
  const opts = {
    apiUrl: 'https://api.github.test',
    repo: 'acme/payments',
    workflow: 'rollback.yml',
    ref: 'main',
    token: 'gh',
    timeoutMs: 1000,
  };

  it('dispatches the rollback workflow with the version', async () => {
    const { fetch, calls } = stubFetch(() => new Response(null, { status: 204 }));
    const ex = new GitHubWorkflowExecutor('gh-rollback', opts, fetch);
    const r = await ex.execute({
      action: 'rollback_deploy',
      service: 'payments-api',
      fromVersion: 'v1.4.2',
      toVersion: 'v1.4.1',
    });
    expect(calls[0]!.url).toBe(
      'https://api.github.test/repos/acme/payments/actions/workflows/rollback.yml/dispatches',
    );
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      ref: 'main',
      inputs: { service: 'payments-api', version: 'v1.4.1' },
    });
    expect(r.detail).toMatchObject({ dispatched: true, status: 204 });
    expect(await ex.state()).toBeNull();
  });

  it('does rollback only, and needs a token', async () => {
    const { fetch, calls } = stubFetch(() => new Response(null, { status: 204 }));
    const ex = new GitHubWorkflowExecutor('gh', opts, fetch);
    expect(ex.supports('failover_provider')).toBe(false);
    expect(await kindOf(ex.execute({ action: 'restart_service', service: 'x' }))).toBe('rejected');
    const noToken = new GitHubWorkflowExecutor('gh', { ...opts, token: undefined }, fetch);
    expect(
      await kindOf(
        noToken.execute({
          action: 'rollback_deploy',
          service: 'x',
          fromVersion: 'a',
          toVersion: 'b',
        }),
      ),
    ).toBe('rejected');
    expect(calls).toHaveLength(0);
  });
});

const base = {
  prometheus: { url: 'http://prom.test' },
  alertmanager: { url: 'http://am.test' },
  executors: {
    'demo-admin': { type: 'admin_api', url: 'http://demo.test', tokenEnv: 'DEMO_ADMIN_TOKEN' },
    'gh-rollback': {
      type: 'github_workflow',
      repo: 'acme/p',
      workflow: 'rollback.yml',
      tokenEnv: 'GITHUB_TOKEN',
    },
  },
  services: [
    {
      name: 'payments-api',
      displayName: 'payments API',
      queries: { errorRate: 'a', latencyP95: 'b', throughput: 'c' },
      actions: {
        failover_provider: { executor: 'demo-admin', providers: ['razorpay', 'stripe'] },
        rollback_deploy: { executor: 'gh-rollback' },
      },
    },
    {
      name: 'batch',
      displayName: 'batch',
      queries: { errorRate: 'a', latencyP95: 'b', throughput: 'c' },
    },
  ],
};

describe('executor config and registry', () => {
  it('builds executors from config and only allows configured actions', () => {
    const c = parseServiceConfig(base, {});
    const reg = ExecutorRegistry.fromConfig(c, { DEMO_ADMIN_TOKEN: 'x' });
    const [payments, batch] = c.services as [(typeof c.services)[0], (typeof c.services)[0]];
    expect(reg.for(payments, 'failover_provider')?.name).toBe('demo-admin');
    expect(reg.for(payments, 'rollback_deploy')?.type).toBe('github_workflow');
    expect(reg.for(payments, 'restart_service')).toBeUndefined(); // not configured
    expect(reg.for(batch, 'failover_provider')).toBeUndefined();
    expect(ExecutorRegistry.missingTokens(c, { DEMO_ADMIN_TOKEN: 'x' })).toEqual([
      'gh-rollback (GITHUB_TOKEN)',
    ]);
  });

  it.each([
    [
      'an unknown executor',
      {
        ...base,
        services: [{ ...base.services[0], actions: { restart_service: { executor: 'nope' } } }],
      },
    ],
    [
      'a workflow executor for failover',
      {
        ...base,
        services: [
          {
            ...base.services[0],
            actions: { failover_provider: { executor: 'gh-rollback', providers: ['a', 'b'] } },
          },
        ],
      },
    ],
    [
      'an action outside the allowlist',
      {
        ...base,
        services: [
          { ...base.services[0], actions: { delete_database: { executor: 'demo-admin' } } },
        ],
      },
    ],
    [
      'a literal secret instead of an env var name',
      {
        ...base,
        executors: { x: { type: 'admin_api', url: 'http://d.test', tokenEnv: 'hunter2-secret' } },
      },
    ],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseServiceConfig(raw, {})).toThrow(ConfigError);
  });
});
