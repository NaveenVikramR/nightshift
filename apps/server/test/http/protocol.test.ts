import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import {
  initializeBody,
  makeHarness,
  openSession,
  postMcp,
  PROTOCOL,
  RESPONDER_TOKEN,
  rpcMessage,
  type TestHarness,
} from '../helpers.js';

const toolsList = { jsonrpc: '2.0', id: 2, method: 'tools/list' };

describe('MCP protocol version and sessions', () => {
  let h: TestHarness;
  afterEach(() => h.ns.close());

  it('negotiates 2025-11-25 and returns a session id', async () => {
    h = makeHarness();
    const res = await postMcp(h.ns, initializeBody(), { token: RESPONDER_TOKEN });
    expect(res.status).toBe(200);
    expect(res.headers['mcp-session-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(rpcMessage(res).result?.['protocolVersion']).toBe('2025-11-25');
  });

  it('answers a client asking for a newer revision (2026-07-28) with 2025-11-25', async () => {
    h = makeHarness();
    const res = await postMcp(h.ns, initializeBody('2026-07-28'), { token: RESPONDER_TOKEN });
    expect(res.status).toBe(200);
    expect(rpcMessage(res).result?.['protocolVersion']).toBe('2025-11-25');
  });

  it('rejects an unsupported MCP-Protocol-Version header with 400', async () => {
    h = makeHarness();
    const sessionId = await openSession(h.ns, RESPONDER_TOKEN);
    const res = await postMcp(h.ns, toolsList, {
      token: RESPONDER_TOKEN,
      sessionId,
      protocol: '1999-01-01',
    });
    expect(res.status).toBe(400);
  });

  it('accepts requests with the negotiated MCP-Protocol-Version header', async () => {
    h = makeHarness();
    const sessionId = await openSession(h.ns, RESPONDER_TOKEN);
    const res = await postMcp(h.ns, toolsList, {
      token: RESPONDER_TOKEN,
      sessionId,
      protocol: PROTOCOL,
    });
    expect(res.status).toBe(200);
    const tools = rpcMessage(res).result?.['tools'] as { name: string }[];
    expect(tools.map((t) => t.name)).toContain('ping_nightshift');
  });

  it('returns 404 for an unknown session id', async () => {
    h = makeHarness();
    const res = await postMcp(h.ns, toolsList, {
      token: RESPONDER_TOKEN,
      sessionId: '00000000-0000-4000-8000-000000000000',
      protocol: PROTOCOL,
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 for a non-initialize request without a session id', async () => {
    h = makeHarness();
    const res = await postMcp(h.ns, toolsList, { token: RESPONDER_TOKEN, protocol: PROTOCOL });
    expect(res.status).toBe(400);
  });

  it('expires idle sessions (404 after the TTL)', async () => {
    h = makeHarness({ sessionIdleTtlMs: 60_000 });
    const sessionId = await openSession(h.ns, RESPONDER_TOKEN);
    h.clock.now += 61_000;
    const res = await postMcp(h.ns, toolsList, {
      token: RESPONDER_TOKEN,
      sessionId,
      protocol: PROTOCOL,
    });
    expect(res.status).toBe(404);
  });

  it('ends a session on DELETE', async () => {
    h = makeHarness();
    const sessionId = await openSession(h.ns, RESPONDER_TOKEN);
    const del = await request(h.ns.app)
      .delete('/mcp')
      .set('Authorization', `Bearer ${RESPONDER_TOKEN}`)
      .set('MCP-Session-Id', sessionId)
      .set('MCP-Protocol-Version', PROTOCOL);
    expect(del.status).toBe(200);
    expect(h.ns.sessions.size).toBe(0);
    const after = await postMcp(h.ns, toolsList, {
      token: RESPONDER_TOKEN,
      sessionId,
      protocol: PROTOCOL,
    });
    expect(after.status).toBe(404);
  });
});
