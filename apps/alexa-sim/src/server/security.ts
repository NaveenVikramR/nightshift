/**
 * Request checks for the simulator's API routes: Host allowlist (DNS rebinding),
 * exact Origin on state-changing requests, a per-session CSRF token, and
 * Sec-Fetch-Site for GETs. Same spirit as Nightshift's own guards.
 */
import { timingSafeEqual } from 'node:crypto';
import type { AlexaConfig } from './config';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Local dev (next dev on :3002) when ALLOWED_ORIGINS is unset. */
const LOCAL_ORIGINS = ['http://127.0.0.1:3002', 'http://localhost:3002'];

export type Check = { ok: true } | { ok: false; status: number; error: string };

function hostname(hostHeader: string | null): string {
  if (!hostHeader) return '';
  return hostHeader.startsWith('[')
    ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
    : hostHeader.split(':')[0]!;
}

export function checkHost(
  cfg: Pick<AlexaConfig, 'ALLOWED_HOSTS'>,
  hostHeader: string | null,
): Check {
  const host = hostname(hostHeader).toLowerCase();
  const allowed = cfg.ALLOWED_HOSTS.length
    ? new Set(cfg.ALLOWED_HOSTS.map((h) => h.toLowerCase()))
    : LOCAL_HOSTS;
  return allowed.has(host) ? { ok: true } : { ok: false, status: 403, error: 'forbidden_host' };
}

/** POST/DELETE: the Origin must be present and exactly allowed. */
export function checkOrigin(
  cfg: Pick<AlexaConfig, 'ALLOWED_ORIGINS'>,
  origin: string | null,
): Check {
  if (!origin) return { ok: false, status: 403, error: 'missing_origin' };
  const allowed = cfg.ALLOWED_ORIGINS.length ? cfg.ALLOWED_ORIGINS : LOCAL_ORIGINS;
  return allowed.includes(origin)
    ? { ok: true }
    : { ok: false, status: 403, error: 'forbidden_origin' };
}

/** GET: refuse cross-site requests (Sec-Fetch-Site), allow same-origin and direct navigation. */
export function checkFetchSite(secFetchSite: string | null): Check {
  if (!secFetchSite || secFetchSite === 'same-origin' || secFetchSite === 'none')
    return { ok: true };
  return { ok: false, status: 403, error: 'cross_site' };
}

export function checkCsrf(expected: string, given: string | null): Check {
  const a = Buffer.from(expected);
  const b = Buffer.from(given ?? '');
  return a.length === b.length && timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, status: 403, error: 'bad_csrf' };
}

export const SESSION_COOKIE = 'ns_alexa';
export const CSRF_HEADER = 'x-nightshift-csrf';
