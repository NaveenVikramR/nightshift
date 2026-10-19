import { describe, expect, it } from 'vitest';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { CARDS, cardHtml } from '../../src/ui/cards.js';
import { getOpsBrief } from '../../src/tools/get_ops_brief.js';
import type { ToolDefinition } from '../../src/tools/types.js';
import { BOB as BOB_VIEWER, invoke } from '../fakes/toolDeps.js';
import {
  callTool,
  makeHarness,
  openSession,
  postMcp,
  PROTOCOL,
  rpcMessage,
  VIEWER_TOKEN,
} from '../helpers.js';

const LINKS: Record<string, string> = {
  explain_incident: CARDS.incident.uri,
  prepare_action: CARDS.confirm.uri,
  confirm_action: CARDS.confirm.uri,
  run_security_scan: CARDS.security.uri,
  get_security_findings: CARDS.security.uri,
  get_ops_brief: CARDS.brief.uri,
};

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const h = makeHarness();
  const sessionId = await openSession(h.ns, VIEWER_TOKEN);
  const res = await postMcp(
    h.ns,
    { jsonrpc: '2.0', id: 7, method, params },
    { token: VIEWER_TOKEN, sessionId, protocol: PROTOCOL },
  );
  return rpcMessage(res).result as Record<string, unknown>;
}

describe('MCP Apps cards', () => {
  it('links each card tool to its ui:// resource, and only those tools', async () => {
    const { tools } = (await rpc('tools/list')) as {
      tools: { name: string; _meta?: Record<string, unknown> }[];
    };
    for (const t of tools) {
      const ui = (t._meta?.['ui'] as { resourceUri?: string } | undefined)?.resourceUri;
      expect(ui, t.name).toBe(LINKS[t.name]);
      if (LINKS[t.name]) expect(t._meta?.['ui/resourceUri']).toBe(LINKS[t.name]); // legacy key too
    }
    expect(Object.keys(LINKS).every((n) => tools.some((t) => t.name === n))).toBe(true);
  });

  it('serves every card as self-contained MCP Apps HTML', async () => {
    const { resources } = (await rpc('resources/list')) as {
      resources: { uri: string; mimeType: string }[];
    };
    expect(resources.map((r) => r.uri).sort()).toEqual(
      Object.values(CARDS)
        .map((c) => c.uri)
        .sort(),
    );
    for (const card of Object.values(CARDS)) {
      const { contents } = (await rpc('resources/read', { uri: card.uri })) as {
        contents: { uri: string; mimeType: string; text: string; _meta?: unknown }[];
      };
      const html = contents[0]!.text;
      expect(contents[0]!.mimeType).toBe(RESOURCE_MIME_TYPE);
      expect(html).toMatch(/^<!doctype html>/);
      expect(html).toContain('id="app"');
      // No external loads: no <link>, no src=/href= attributes, no CSS imports or remote url().
      // (booleans, so a failure doesn't print the 600 KB bundle)
      const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
      const markup = html.replace(/<script>[\s\S]*?<\/script>/, '').replace(css, '');
      expect(/<link\b/i.test(markup), 'no <link>').toBe(false);
      expect(/\s(src|href)=/i.test(markup), 'no src/href attributes').toBe(false);
      expect(/@import|url\(/i.test(css), 'no CSS imports or url()').toBe(false);
      expect((html.match(/<script\b/g) ?? []).length, 'one inline script').toBe(1);
      expect(contents[0]!._meta).toEqual({ ui: { csp: {}, prefersBorder: false } });
    }
  });

  it('keeps the voice contract unchanged: same speak and data as without cards', async () => {
    const h = makeHarness();
    const { message } = await callTool(h.ns, VIEWER_TOKEN, 'get_ops_brief');
    const result = message.result as {
      content: { type: string; text: string }[];
      structuredContent: { speak: string; data: unknown };
    };
    const direct = await invoke(
      getOpsBrief as unknown as ToolDefinition,
      h.fakes.deps,
      {},
      BOB_VIEWER,
    );
    expect(result.structuredContent.speak).toBe(direct.speak);
    expect(Object.keys(result).sort()).toEqual(['content', 'structuredContent']);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it('has a built page for each card', () => {
    for (const id of Object.keys(CARDS) as (keyof typeof CARDS)[]) {
      expect(cardHtml(id)).toContain(`data-card="${id}"`);
    }
  });
});
