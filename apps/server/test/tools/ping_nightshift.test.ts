import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { hashInput } from '../../src/lib/audit.js';
import { countWords, MAX_SPEAK_WORDS } from '../../src/lib/speak.js';
import { pingNightshift } from '../../src/tools/ping_nightshift.js';
import { runTool } from '../../src/tools/runTool.js';
import type { ToolDefinition, ToolDeps } from '../../src/tools/types.js';
import { InMemoryAuditLog } from '../fakes/inMemoryAuditLog.js';
import { fakeToolDeps } from '../fakes/toolDeps.js';
import {
  callTool,
  makeHarness,
  RESPONDER_TOKEN,
  VIEWER_TOKEN,
  type TestHarness,
} from '../helpers.js';

interface PingResult {
  speak: string;
  data: { status: string; serverVersion: string; protocolVersion: string; role: string };
}

describe('ping_nightshift over MCP', () => {
  let h: TestHarness;
  afterEach(() => h.ns.close());

  it('returns speak + data with server version and caller role', async () => {
    h = makeHarness();
    const { res, message } = await callTool(h.ns, VIEWER_TOKEN, 'ping_nightshift');
    expect(res.status).toBe(200);
    const result = message.result as { structuredContent: PingResult; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.data).toMatchObject({
      status: 'ok',
      serverVersion: '0.1.0',
      protocolVersion: '2025-11-25',
      role: 'viewer',
    });
  });

  it.each([
    ['viewer', VIEWER_TOKEN],
    ['responder', RESPONDER_TOKEN],
  ])('keeps speak within %s word budget and free of markdown/URLs/IDs', async (_r, token) => {
    h = makeHarness();
    const { message } = await callTool(h.ns, token, 'ping_nightshift');
    const { speak } = (message.result as { structuredContent: PingResult }).structuredContent;
    expect(countWords(speak)).toBeLessThanOrEqual(MAX_SPEAK_WORDS);
    expect(speak).not.toMatch(/[*_`#[\]]|https?:|[0-9a-f]{8}-/i);
  });

  it('mirrors structuredContent as JSON text content (spec back-compat)', async () => {
    h = makeHarness();
    const { message } = await callTool(h.ns, VIEWER_TOKEN, 'ping_nightshift');
    const result = message.result as {
      content: { type: string; text: string }[];
      structuredContent: unknown;
    };
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it('writes one audit row with actor, role, tool, input hash and outcome', async () => {
    h = makeHarness();
    await callTool(h.ns, RESPONDER_TOKEN, 'ping_nightshift');
    expect(h.audit.entries).toEqual([
      {
        actor: 'alice',
        role: 'responder',
        tool: 'ping_nightshift',
        inputHash: hashInput({}),
        outcome: 'ok',
      },
    ]);
  });
});

describe('runTool adapter', () => {
  const authFor = (actor: string, role: string): AuthInfo => ({
    token: 'x',
    clientId: actor,
    scopes: [role],
    extra: { actor, role },
  });

  function deps(audit = new InMemoryAuditLog()): ToolDeps {
    return { ...fakeToolDeps().deps, audit };
  }

  const responderOnly: ToolDefinition = {
    name: 'fake_write',
    title: 'Fake write',
    description: 'test only',
    inputSchema: z.object({}),
    minRole: 'responder',
    annotations: {},
    handler: async () => ({ speak: 'done', data: {} }),
  };

  it('refuses a viewer calling a responder tool, and audits the refusal', async () => {
    const audit = new InMemoryAuditLog();
    const result = await runTool(responderOnly, deps(audit), {}, authFor('bob', 'viewer'));
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { speak: string }).speak).toMatch(/responder access/);
    expect(audit.entries[0]).toMatchObject({ actor: 'bob', outcome: 'forbidden' });
  });

  it('refuses a call with no verified principal', async () => {
    const audit = new InMemoryAuditLog();
    const result = await runTool(pingNightshift as ToolDefinition, deps(audit), {}, undefined);
    expect(result.isError).toBe(true);
    expect(audit.entries[0]).toMatchObject({ actor: 'unknown', outcome: 'unauthenticated' });
  });

  it('fails closed when the audit log cannot be written', async () => {
    const audit = new InMemoryAuditLog();
    audit.failNext = true;
    const result = await runTool(
      pingNightshift as ToolDefinition,
      deps(audit),
      {},
      authFor('alice', 'responder'),
    );
    expect(result.isError).toBe(true);
    const sc = result.structuredContent as { speak: string; data: unknown };
    expect(sc.data).toEqual({ error: 'audit_unavailable' });
    expect(JSON.stringify(result)).not.toContain('serverVersion');
  });

  it('turns handler exceptions into a user-safe message and audits an error', async () => {
    const audit = new InMemoryAuditLog();
    const broken: ToolDefinition = {
      ...responderOnly,
      handler: async () => {
        throw new Error('db password=hunter2 leaked');
      },
    };
    const result = await runTool(broken, deps(audit), {}, authFor('alice', 'responder'));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(audit.entries[0]).toMatchObject({ outcome: 'error' });
  });
});
