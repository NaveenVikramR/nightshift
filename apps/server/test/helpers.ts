import request from 'supertest';
import type { Response } from 'supertest';
import type { Config } from '../src/config.js';
import { createApp, type NightshiftApp } from '../src/http/createApp.js';
import { sha256Hex } from '../src/lib/auth.js';
import type { ToolDefinition } from '../src/tools/types.js';
import type { InMemoryAuditLog } from './fakes/inMemoryAuditLog.js';
import { fakeToolDeps } from './fakes/toolDeps.js';

// Test-only tokens; never valid anywhere else.
export const RESPONDER_TOKEN = 'test-responder-token';
export const VIEWER_TOKEN = 'test-viewer-token';
export const INGEST_TOKEN = 'test-ingest-token';
export const ALLOWED_ORIGIN = 'http://localhost:6274';
export const PROTOCOL = '2025-11-25';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: '127.0.0.1',
    port: 0,
    allowedOrigins: [ALLOWED_ORIGIN],
    allowedHosts: [],
    trustProxy: false,
    strictSessionBinding: false,
    maxBodyBytes: 1024 * 1024,
    sessionIdleTtlMs: 30 * 60_000,
    tokens: [
      { actor: 'alice', role: 'responder', sha256: sha256Hex(RESPONDER_TOKEN) },
      { actor: 'bob', role: 'viewer', sha256: sha256Hex(VIEWER_TOKEN) },
    ],
    ingestTokens: [{ source: 'test-ci', sha256: sha256Hex(INGEST_TOKEN) }],
    githubToken: undefined,
    authFailLimit: 20,
    authFailWindowMs: 10 * 60_000,
    databaseUrl: undefined,
    ...overrides,
  };
}

export interface TestHarness {
  ns: NightshiftApp;
  audit: InMemoryAuditLog;
  clock: { now: number };
  fakes: ReturnType<typeof fakeToolDeps>;
}

export function makeHarness(
  overrides: Partial<Config> = {},
  opts: { tools?: readonly ToolDefinition[] } = {},
): TestHarness {
  const fakes = fakeToolDeps();
  const { audit } = fakes;
  const clock = { now: Date.parse('2026-10-14T12:00:00Z') };
  const { now: _now, serverVersion: _version, startedAt: _startedAt, ...external } = fakes.deps;
  const ns = createApp({
    config: testConfig(overrides),
    deps: external,
    deployStore: fakes.deployStore,
    ...(opts.tools && { tools: opts.tools }),
    now: () => clock.now,
  });
  return { ns, audit, clock, fakes };
}

const MCP_ACCEPT = 'application/json, text/event-stream';

export function initializeBody(protocolVersion = PROTOCOL) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name: 'vitest', version: '0' } },
  };
}

/** POST /mcp with MCP headers. Body is buffered so SSE responses are readable. */
export function postMcp(
  ns: NightshiftApp,
  body: unknown,
  opts: { token?: string; sessionId?: string; protocol?: string; origin?: string } = {},
) {
  let req = request(ns.app)
    .post('/mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', MCP_ACCEPT)
    .buffer(true)
    .parse(textParser);
  if (opts.token) req = req.set('Authorization', `Bearer ${opts.token}`);
  if (opts.sessionId) req = req.set('MCP-Session-Id', opts.sessionId);
  if (opts.protocol) req = req.set('MCP-Protocol-Version', opts.protocol);
  if (opts.origin) req = req.set('Origin', opts.origin);
  return req.send(typeof body === 'string' ? body : JSON.stringify(body));
}

/** Initialize a session (and send notifications/initialized). Returns the session id. */
export async function openSession(ns: NightshiftApp, token: string): Promise<string> {
  const res = await postMcp(ns, initializeBody(), { token });
  const sessionId = res.headers['mcp-session-id'];
  if (res.status !== 200 || typeof sessionId !== 'string') {
    throw new Error(`initialize failed: ${res.status} ${bodyText(res)}`);
  }
  const ack = await postMcp(
    ns,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { token, sessionId, protocol: PROTOCOL },
  );
  if (ack.status !== 202) throw new Error(`initialized notification failed: ${ack.status}`);
  return sessionId;
}

/** Extract the JSON-RPC message from a JSON or SSE response. */
export function bodyText(res: Response): string {
  return typeof res.body === 'string' ? res.body : res.text;
}

export function rpcMessage(res: Response): { result?: Record<string, unknown>; error?: unknown } {
  const text = bodyText(res);
  const dataLine = text
    .split('\n')
    .reverse()
    .find((l) => l.startsWith('data: '));
  return JSON.parse(dataLine ? dataLine.slice(6) : text) as {
    result?: Record<string, unknown>;
    error?: unknown;
  };
}

export async function callTool(ns: NightshiftApp, token: string, name: string, args: unknown = {}) {
  const sessionId = await openSession(ns, token);
  const res = await postMcp(
    ns,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
    { token, sessionId, protocol: PROTOCOL },
  );
  return { res, message: rpcMessage(res) };
}

/** Buffer any response (including text/event-stream) as a string. In Node, superagent passes the raw stream. */
function textParser(res: Response, cb: (err: Error | null, body: string) => void): void {
  const stream = res as unknown as NodeJS.ReadableStream & { setEncoding(e: BufferEncoding): void };
  let data = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => (data += chunk));
  stream.on('end', () => cb(null, data));
}
