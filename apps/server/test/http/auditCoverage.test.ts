import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { hashInput } from '../../src/lib/audit.js';
import { TOOLS } from '../../src/mcp/registerTools.js';
import type { ToolDefinition } from '../../src/tools/types.js';
import {
  callTool,
  makeHarness,
  openSession,
  postMcp,
  PROTOCOL,
  RESPONDER_TOKEN,
  rpcMessage,
  VIEWER_TOKEN,
  type TestHarness,
} from '../helpers.js';

const snoozeSchema = z.object({ minutes: z.number().int().min(1).max(240) });
const snooze: ToolDefinition<typeof snoozeSchema> = {
  name: 'test_snooze',
  title: 'Test snooze',
  description: 'test only',
  inputSchema: snoozeSchema,
  minRole: 'viewer',
  annotations: {},
  handler: async ({ minutes }) => ({ speak: `Snoozed for ${minutes} minutes.`, data: { minutes } }),
  describeInvalidInput: () => 'I can snooze for between one minute and four hours.',
};
const responderOnly: ToolDefinition = {
  name: 'test_write',
  title: 'Test write',
  description: 'test only',
  inputSchema: z.object({}),
  minRole: 'responder',
  annotations: {},
  handler: async () => ({ speak: 'done', data: {} }),
};
const tools = [...TOOLS, snooze as ToolDefinition, responderOnly];

const toolsCall = (name: string, args: unknown = {}) => ({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name, arguments: args },
});

/** The tap writes on response 'finish'; give the event loop a moment. */
async function auditRows(h: TestHarness, n: number) {
  for (let i = 0; i < 50 && h.audit.entries.length < n; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return h.audit.entries;
}

describe('Every tools/call produces exactly one audit row', () => {
  let h: TestHarness;
  afterEach(() => h.ns.close());

  it('valid call: one ok row (no double audit)', async () => {
    h = makeHarness({}, { tools });
    await callTool(h.ns, VIEWER_TOKEN, 'test_snooze', { minutes: 30 });
    await new Promise((r) => setTimeout(r, 30));
    expect(h.audit.entries).toEqual([
      expect.objectContaining({ tool: 'test_snooze', outcome: 'ok', actor: 'bob' }),
    ]);
  });

  it('schema failure: invalid_input row and a helpful speak', async () => {
    h = makeHarness({}, { tools });
    const { message } = await callTool(h.ns, VIEWER_TOKEN, 'test_snooze', { minutes: 999 });
    const result = message.result as { isError: boolean; structuredContent: { speak: string } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.speak).toBe(
      'I can snooze for between one minute and four hours.',
    );
    expect(await auditRows(h, 1)).toEqual([
      {
        actor: 'bob',
        role: 'viewer',
        tool: 'test_snooze',
        inputHash: hashInput({ minutes: 999 }),
        outcome: 'invalid_input',
      },
    ]);
  });

  it('missing required argument and wrong type are audited as invalid_input', async () => {
    h = makeHarness({}, { tools });
    await callTool(h.ns, VIEWER_TOKEN, 'test_snooze', {});
    await callTool(h.ns, VIEWER_TOKEN, 'test_snooze', { minutes: 'ten' });
    expect((await auditRows(h, 2)).map((e) => e.outcome)).toEqual([
      'invalid_input',
      'invalid_input',
    ]);
  });

  it('tools/list still advertises the real JSON Schema', async () => {
    h = makeHarness({}, { tools });
    const sessionId = await openSession(h.ns, VIEWER_TOKEN);
    const res = await postMcp(
      h.ns,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { token: VIEWER_TOKEN, sessionId, protocol: PROTOCOL },
    );
    const listed = (
      rpcMessage(res).result?.['tools'] as { name: string; inputSchema: unknown }[]
    ).find((t) => t.name === 'test_snooze');
    expect(listed?.inputSchema).toMatchObject({
      type: 'object',
      properties: { minutes: { type: 'integer', minimum: 1, maximum: 240 } },
      required: ['minutes'],
    });
  });

  it('unknown tool: unknown_tool row', async () => {
    h = makeHarness({}, { tools });
    await callTool(h.ns, RESPONDER_TOKEN, 'drop_database', { really: true });
    expect(await auditRows(h, 1)).toEqual([
      {
        actor: 'alice',
        role: 'responder',
        tool: 'drop_database',
        inputHash: hashInput({ really: true }),
        outcome: 'unknown_tool',
      },
    ]);
  });

  it('unknown tool name is sanitized before it is stored', async () => {
    h = makeHarness({}, { tools });
    await callTool(h.ns, RESPONDER_TOKEN, 'x"; DROP TABLE audit_log;--‮' + 'a'.repeat(200));
    const [row] = await auditRows(h, 1);
    expect(row?.tool).toMatch(/^[A-Za-z0-9 _.:/-]{1,64}$/);
  });

  it('viewer calling a responder tool: forbidden row', async () => {
    h = makeHarness({}, { tools });
    await callTool(h.ns, VIEWER_TOKEN, 'test_write');
    expect((await auditRows(h, 1))[0]).toMatchObject({ outcome: 'forbidden', actor: 'bob' });
  });

  it.each([
    ['missing token', undefined],
    ['invalid token', 'wrong-token'],
  ])('%s: unauthenticated row with anonymous actor', async (_label, token) => {
    h = makeHarness({}, { tools });
    const res = await postMcp(h.ns, toolsCall('ping_nightshift'), {
      ...(token && { token }),
      protocol: PROTOCOL,
    });
    expect(res.status).toBe(401);
    expect(await auditRows(h, 1)).toEqual([
      expect.objectContaining({
        actor: 'anonymous',
        role: 'unknown',
        tool: 'ping_nightshift',
        outcome: 'unauthenticated',
      }),
    ]);
  });

  it('disallowed origin: forbidden_request row', async () => {
    h = makeHarness({}, { tools });
    const res = await postMcp(h.ns, toolsCall('ping_nightshift'), {
      token: RESPONDER_TOKEN,
      origin: 'https://evil.example',
    });
    expect(res.status).toBe(403);
    expect((await auditRows(h, 1))[0]).toMatchObject({ outcome: 'forbidden_request' });
  });

  it('unknown session: session_not_found row with the caller identity', async () => {
    h = makeHarness({}, { tools });
    const res = await postMcp(h.ns, toolsCall('ping_nightshift'), {
      token: RESPONDER_TOKEN,
      sessionId: '00000000-0000-4000-8000-000000000000',
      protocol: PROTOCOL,
    });
    expect(res.status).toBe(404);
    expect((await auditRows(h, 1))[0]).toMatchObject({
      outcome: 'session_not_found',
      actor: 'alice',
    });
  });

  it('rate limited: at most one rate_limited row per IP per window', async () => {
    h = makeHarness({ authFailLimit: 2, authFailWindowMs: 60_000 }, { tools });
    for (let i = 0; i < 2; i++) {
      await postMcp(h.ns, toolsCall('ping_nightshift'), { token: 'wrong' });
    }
    for (let i = 0; i < 5; i++) {
      const res = await postMcp(h.ns, toolsCall('ping_nightshift'), { token: RESPONDER_TOKEN });
      expect(res.status).toBe(429);
    }
    const rows = await auditRows(h, 3);
    await new Promise((r) => setTimeout(r, 30));
    expect(rows.map((r) => r.outcome)).toEqual([
      'unauthenticated',
      'unauthenticated',
      'rate_limited',
    ]);
  });

  it('non-tool requests (initialize, tools/list) are not audited by the tap', async () => {
    h = makeHarness({}, { tools });
    const sessionId = await openSession(h.ns, VIEWER_TOKEN);
    await postMcp(
      h.ns,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { token: VIEWER_TOKEN, sessionId, protocol: PROTOCOL },
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(h.audit.entries).toEqual([]);
  });
});
