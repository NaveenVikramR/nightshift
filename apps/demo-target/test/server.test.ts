import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMetrics } from '../src/metrics.ts';
import { createDemoServer } from '../src/server.ts';
import { DemoState } from '../src/state.ts';

const TOKEN = 'test-admin-token-123456';
let server: Server;
let base: string;
let state: DemoState;

beforeEach(async () => {
  state = new DemoState();
  server = createDemoServer({ state, metrics: createMetrics(), adminToken: TOKEN });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

const admin = (path: string, init: RequestInit = {}, token = TOKEN) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });

describe('demo-target HTTP API', () => {
  it('serves /metrics and /healthz without auth', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const metrics = await fetch(`${base}/metrics`);
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain('circuit_breaker_state');
  });

  it('rejects admin calls without the right token', async () => {
    expect((await fetch(`${base}/admin/state`)).status).toBe(401);
    expect((await admin('/admin/chaos/provider_outage', {}, 'wrong')).status).toBe(401);
    expect(state.active.size).toBe(0);
  });

  it('enables a scenario, then resets', async () => {
    const on = await admin('/admin/chaos/provider_outage');
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({
      scenarios: ['provider_outage'],
      downProviders: ['razorpay'],
    });
    const off = await admin('/admin/reset');
    expect(await off.json()).toMatchObject({ scenarios: [], downProviders: [] });
  });

  it('rejects unknown scenarios and providers', async () => {
    expect((await admin('/admin/chaos/rm_rf')).status).toBe(404);
    const bad = await admin('/admin/route-provider', { body: JSON.stringify({ provider: 'x' }) });
    expect(bad.status).toBe(400);
  });

  it('routes traffic to another provider', async () => {
    const res = await admin('/admin/route-provider', {
      body: JSON.stringify({ provider: 'stripe' }),
    });
    expect(await res.json()).toMatchObject({ activeProvider: 'stripe' });
  });
});
