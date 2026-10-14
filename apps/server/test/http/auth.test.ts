import { afterEach, describe, expect, it } from 'vitest';
import {
  callTool,
  initializeBody,
  makeHarness,
  openSession,
  postMcp,
  PROTOCOL,
  RESPONDER_TOKEN,
  VIEWER_TOKEN,
  type TestHarness,
} from '../helpers.js';

describe('Bearer auth on /mcp', () => {
  let h: TestHarness;
  afterEach(() => h.ns.close());

  it('rejects a missing token with 401 and a Bearer challenge', async () => {
    h = makeHarness();
    const res = await postMcp(h.ns, initializeBody());
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Bearer /);
  });

  it('rejects an invalid token with 401', async () => {
    h = makeHarness();
    const res = await postMcp(h.ns, initializeBody(), { token: 'not-a-real-token' });
    expect(res.status).toBe(401);
  });

  it('never echoes the presented token back', async () => {
    h = makeHarness();
    const res = await postMcp(h.ns, initializeBody(), { token: 'secret-guess-123' });
    expect(JSON.stringify(res.headers) + JSON.stringify(res.body)).not.toContain(
      'secret-guess-123',
    );
  });

  it('accepts a viewer token and exposes the viewer role to tools', async () => {
    h = makeHarness();
    const { message } = await callTool(h.ns, VIEWER_TOKEN, 'ping_nightshift');
    const sc = message.result?.['structuredContent'] as { data: { actor: string; role: string } };
    expect(sc.data).toMatchObject({ actor: 'bob', role: 'viewer' });
  });

  it('accepts a responder token and exposes the responder role to tools', async () => {
    h = makeHarness();
    const { message } = await callTool(h.ns, RESPONDER_TOKEN, 'ping_nightshift');
    const sc = message.result?.['structuredContent'] as { data: { actor: string; role: string } };
    expect(sc.data).toMatchObject({ actor: 'alice', role: 'responder' });
  });

  it("does not let one token use another actor's session (404)", async () => {
    h = makeHarness();
    const sessionId = await openSession(h.ns, RESPONDER_TOKEN);
    const res = await postMcp(
      h.ns,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { token: VIEWER_TOKEN, sessionId, protocol: PROTOCOL },
    );
    expect(res.status).toBe(404);
  });

  it('keeps /healthz public', async () => {
    h = makeHarness();
    const { default: request } = await import('supertest');
    const res = await request(h.ns.app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.text).toBe('ok');
  });
});
