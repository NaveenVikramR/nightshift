/** Shared guard for the API route handlers (Host, Origin/CSRF or Sec-Fetch-Site, session). */
import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { runtime } from './runtime';
import {
  checkCsrf,
  checkFetchSite,
  checkHost,
  checkOrigin,
  CSRF_HEADER,
  SESSION_COOKIE,
  type Check,
} from './security';
import type { Session } from './sessions';

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

const fail = (c: Extract<Check, { ok: false }>) => json({ error: c.error }, c.status);

/**
 * method POST: Host + exact Origin (+ CSRF when a session is required).
 * method GET:  Host + Sec-Fetch-Site (no cross-site reads).
 */
export function guard(
  req: NextRequest,
  opts: { session: true },
): { session: Session } | { response: NextResponse };
export function guard(
  req: NextRequest,
  opts: { session: false },
): { session?: undefined } | { response: NextResponse };
export function guard(
  req: NextRequest,
  opts: { session: boolean },
): { session?: Session | undefined } | { response: NextResponse } {
  const { cfg, sessions } = runtime();
  const host = checkHost(cfg, req.headers.get('host'));
  if (!host.ok) return { response: fail(host) };
  const isPost = req.method !== 'GET' && req.method !== 'HEAD';
  const site = isPost
    ? checkOrigin(cfg, req.headers.get('origin'))
    : checkFetchSite(req.headers.get('sec-fetch-site'));
  if (!site.ok) return { response: fail(site) };
  if (!opts.session) return {};
  const session = sessions.get(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return { response: json({ error: 'signed_out' }, 401) };
  if (isPost) {
    const csrf = checkCsrf(session.csrf, req.headers.get(CSRF_HEADER));
    if (!csrf.ok) return { response: fail(csrf) };
  }
  return { session };
}

/** Client IP for the login limiter (behind Caddy: the X-Forwarded-For it sets). */
export function clientIp(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
}

export async function readJson(
  req: NextRequest,
  maxBytes = 8_192,
): Promise<Record<string, unknown> | undefined> {
  const text = await req.text();
  if (text.length > maxBytes) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
