/** POST /alexa/api/logout → closes the MCP session and forgets the token. */
import type { NextRequest } from 'next/server';
import { guard, json } from '@/server/http';
import { runtime } from '@/server/runtime';
import { SESSION_COOKIE } from '@/server/security';

export async function POST(req: NextRequest) {
  const g = guard(req, { session: true });
  if ('response' in g) return g.response;
  await runtime().sessions.destroy(g.session.id);
  const res = json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', {
    path: '/alexa',
    maxAge: 0,
    httpOnly: true,
    sameSite: 'strict',
  });
  return res;
}
