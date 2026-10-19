/**
 * POST /alexa/api/tool { name, arguments } → a card button through the MCP Apps
 * bridge. Only prepare_action, confirm_action (for a confirmation this session
 * prepared; the click is the explicit yes) and get_security_findings.
 */
import type { NextRequest } from 'next/server';
import { runCardTool } from '@/server/agent/loop';
import { guard, json, readJson } from '@/server/http';
import { runtime } from '@/server/runtime';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const g = guard(req, { session: true });
  if ('response' in g) return g.response;
  const body = await readJson(req);
  const name = typeof body?.['name'] === 'string' ? body['name'] : '';
  const args =
    typeof body?.['arguments'] === 'object' &&
    body['arguments'] !== null &&
    !Array.isArray(body['arguments'])
      ? (body['arguments'] as Record<string, unknown>)
      : {};
  const out = await runCardTool(runtime().agent, g.session, name, args);
  if ('refused' in out) {
    // A tool-shaped error the card can show (server-authored text only).
    return json({
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ speak: out.refused, data: { error: 'refused' } }),
          },
        ],
        isError: true,
      },
      trace: [],
    });
  }
  return json(out);
}
