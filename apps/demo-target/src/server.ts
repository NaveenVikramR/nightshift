import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Metrics } from './metrics.ts';
import {
  BAD_DEPLOY_DELAY,
  VERSION_PATTERN,
  DemoState,
  isProvider,
  isScenario,
  isSecurityMode,
  SECURITY_MODES,
  PROVIDERS,
  SCENARIOS,
  type SecurityMode,
} from './state.ts';

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

/**
 * hardened: CSP (with frame-ancestors), nosniff, X-Frame-Options and HSTS.
 * weak: none of those, and an X-Powered-By header that leaks the stack.
 */
export function applySecurityHeaders(res: ServerResponse, mode: SecurityMode): void {
  for (const h of [
    'content-security-policy',
    'x-content-type-options',
    'x-frame-options',
    'strict-transport-security',
    'x-powered-by',
  ]) {
    res.removeHeader(h);
  }
  if (mode === 'weak') {
    res.setHeader('x-powered-by', 'Express/4.17.1');
    return;
  }
  res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
}

export interface DemoServerOptions {
  state: DemoState;
  metrics: Metrics;
  adminToken: string;
}

/**
 * GET  /metrics                    Prometheus exposition
 * GET  /healthz                    liveness
 * GET  /readyz                     readiness (503 while restarting)
 * GET  /admin/state                (admin) current chaos state
 * POST /admin/chaos/:scenario      (admin) enable a failure scenario
 *      /admin/chaos/bad_deploy?delaySeconds=60  razorpay starts failing after the delay
 * POST /admin/reset                (admin) clear all scenarios, route back to razorpay
 * POST /admin/route-provider       (admin) {"provider":"stripe"} failover target
 * POST /admin/rollback             (admin) {"version":"v1.4.1"} deploy another version
 * POST /admin/restart              (admin) ~5 s of unavailability, then normal
 * POST /admin/security             (admin) {"mode":"weak"|"hardened"} response security headers
 * GET  /                           tiny landing JSON (the security-headers scan target)
 */
export function createDemoServer({ state, metrics, adminToken }: DemoServerOptions): Server {
  const adminDigest = digest(adminToken);

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      applySecurityHeaders(res, state.securityMode);

      if (req.method === 'GET' && path === '/metrics') {
        res.writeHead(200, { 'content-type': metrics.registry.contentType });
        res.end(await metrics.registry.metrics());
        return;
      }
      if (req.method === 'GET' && path === '/') return send(res, 200, { service: 'payments demo' });
      if (req.method === 'GET' && path === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        return;
      }
      if (req.method === 'GET' && path === '/readyz') {
        const ready = !state.isRestarting();
        res.writeHead(ready ? 200 : 503, { 'content-type': 'text/plain' });
        res.end(ready ? 'ready' : 'restarting');
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
        let delaySeconds: number | undefined;
        if (scenario === 'bad_deploy' && url.searchParams.has('delaySeconds')) {
          delaySeconds = Number(url.searchParams.get('delaySeconds'));
          if (
            !Number.isInteger(delaySeconds) ||
            delaySeconds < BAD_DEPLOY_DELAY.min ||
            delaySeconds > BAD_DEPLOY_DELAY.max
          ) {
            return send(res, 400, { error: 'invalid_delay', ...BAD_DEPLOY_DELAY });
          }
        }
        state.enable(scenario, delaySeconds === undefined ? {} : { delaySeconds });
        metrics.updateBreakers(state);
        return send(res, 200, state.snapshot());
      }

      if (req.method === 'POST' && path === '/admin/rollback') {
        const body = (await readJson(req)) as { version?: unknown };
        if (typeof body.version !== 'string' || !VERSION_PATTERN.test(body.version)) {
          return send(res, 400, { error: 'invalid_version' });
        }
        state.rollbackTo(body.version);
        metrics.updateBreakers(state);
        return send(res, 200, state.snapshot());
      }

      if (req.method === 'POST' && path === '/admin/security') {
        const body = (await readJson(req)) as { mode?: unknown };
        if (!isSecurityMode(body.mode)) {
          return send(res, 400, { error: 'invalid_mode', modes: SECURITY_MODES });
        }
        state.securityMode = body.mode;
        applySecurityHeaders(res, state.securityMode);
        return send(res, 200, state.snapshot());
      }

      if (req.method === 'POST' && path === '/admin/restart') {
        state.restart();
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
