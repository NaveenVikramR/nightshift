/**
 * GET /alexa/api/card?uri=ui://… → a Nightshift MCP Apps card, read through this
 * session's MCP client (resources/read). Loaded into an iframe with
 * sandbox="allow-scripts" (opaque origin), with its own CSP: inline card
 * script/styles only, no network.
 */
import type { NextRequest } from 'next/server';
import { guard, json } from '@/server/http';
import { log } from '@/server/log';

const CARD_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  "connect-src 'none'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export async function GET(req: NextRequest) {
  const g = guard(req, { session: true });
  if ('response' in g) return g.response;
  const uri = req.nextUrl.searchParams.get('uri') ?? '';
  if (!/^ui:\/\/nightshift\/[a-z-]+\.html$/.test(uri)) return json({ error: 'bad_uri' }, 400);
  try {
    const { text } = await g.session.mcp.readResource(uri);
    return new Response(text, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': CARD_CSP,
        'x-frame-options': 'SAMEORIGIN',
        'cache-control': 'private, max-age=300',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch {
    log.warn('card read failed');
    return json({ error: 'card_unavailable' }, 502);
  }
}
