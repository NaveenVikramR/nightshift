import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Metrics } from './metrics.ts';
import { DemoState, isProvider, isScenario, PROVIDERS, SCENARIOS } from './state.ts';

const MAX_BODY_BYTES = 4096;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function isAuthorized(req: IncomingMessage, expectedDigest: Buffer): boolean {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return timingSafeEqual(digest(token), expectedDigest);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as unknown) : {};
}

export interface DemoServerOptions {
  state: DemoState;
  metrics: Metrics;
  adminToken: string;
}

/**
 * GET  /metrics                    Prometheus exposition
 * GET  /healthz                    liveness
 * GET  /admin/state                (admin) current chaos state
 * POST /admin/chaos/:scenario      (admin) enable a failure scenario
 * POST /admin/reset                (admin) clear all scenarios, route back to razorpay
 * POST /admin/route-provider       (admin) {"provider":"stripe"} failover target
 */
export function createDemoServer({ state, metrics, adminToken }: DemoServerOptions): Server {
  const adminDigest = digest(adminToken);

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;

      if (req.method === 'GET' && path === '/metrics') {
        res.writeHead(200, { 'content-type': metrics.registry.contentType });
        res.end(await metrics.registry.metrics());
        return;
      }
      if (req.method === 'GET' && path === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        return;
      }
      if (!path.startsWith('/admin/')) return send(res, 404, { error: 'not_found' });
      if (!isAuthorized(req, adminDigest)) return send(res, 401, { error: 'unauthorized' });

      if (req.method === 'GET' && path === '/admin/state') return send(res, 200, state.snapshot());

      if (req.method === 'POST' && path === '/admin/reset') {
        state.reset();
        metrics.updateBreakers(state);
        return send(res, 200, state.snapshot());
      }

      const chaos = /^\/admin\/chaos\/([a-z_]+)$/.exec(path);
      if (req.method === 'POST' && chaos) {
        const scenario = chaos[1];
        if (!isScenario(scenario)) {
          return send(res, 404, { error: 'unknown_scenario', scenarios: SCENARIOS });
        }
        state.enable(scenario);
        metrics.updateBreakers(state);
        return send(res, 200, state.snapshot());
      }

      if (req.method === 'POST' && path === '/admin/route-provider') {
        const body = (await readJson(req)) as { provider?: unknown };
        if (!isProvider(body.provider)) {
          return send(res, 400, { error: 'invalid_provider', providers: PROVIDERS });
        }
        state.routeTo(body.provider);
        return send(res, 200, state.snapshot());
      }

      send(res, 404, { error: 'not_found' });
    })().catch(() => {
      if (!res.headersSent) send(res, 400, { error: 'bad_request' });
    });
  });
}
