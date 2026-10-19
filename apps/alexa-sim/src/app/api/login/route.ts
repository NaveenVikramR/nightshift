/**
 * POST /alexa/api/login { token } → opens this browser's MCP session to Nightshift.
 * The token stays in server memory; the browser only gets an opaque session cookie.
 */
import type { NextRequest } from 'next/server';
import { clientIp, guard, json, readJson } from '@/server/http';
import { log } from '@/server/log';
import { NightshiftMcp, speakAndData } from '@/server/mcp';
import { runtime } from '@/server/runtime';
import { SESSION_COOKIE } from '@/server/security';

export async function POST(req: NextRequest) {
  const g = guard(req, { session: false });
  if ('response' in g) return g.response;
  const { cfg, sessions, loginLimiter } = runtime();

  const body = await readJson(req, 2_048);
  const token = typeof body?.['token'] === 'string' ? body['token'].trim() : '';
  if (!/^[\w.~+/=-]{16,200}$/.test(token)) return json({ error: 'invalid_token' }, 400);

  const ip = clientIp(req);
  if (loginLimiter.retryAfterSeconds(ip) > 0) return json({ error: 'too_many_attempts' }, 429);

  const mcp = new NightshiftMcp(cfg.NIGHTSHIFT_MCP_URL, token, cfg.MCP_TIMEOUT_MS);
  let actor = '';
  let role = '';
  try {
    const { data } = speakAndData(await mcp.callTool('ping_nightshift', {}));
    actor = typeof data['actor'] === 'string' ? data['actor'] : '';
    role = typeof data['role'] === 'string' ? data['role'] : '';
  } catch {
    // Wrong token (401) or Nightshift unreachable: same generic answer.
  }
  if (role !== 'viewer' && role !== 'responder') {
    loginLimiter.take(ip);
    await mcp.close();
    log.info('login refused');
    return json({ error: 'login_failed' }, 401);
  }

  const session = sessions.create({ token, actor, role, mcp });
  log.info('login', { role, sessions: sessions.size });
  const res = json({ actor, role, csrf: session.csrf });
  res.cookies.set(SESSION_COOKIE, session.id, {
    httpOnly: true,
    secure: cfg.SECURE_COOKIES,
    sameSite: 'strict',
    path: '/alexa',
    maxAge: cfg.SESSION_IDLE_MINUTES * 60,
  });
  return res;
}
