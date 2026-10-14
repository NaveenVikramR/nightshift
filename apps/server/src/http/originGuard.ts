import type { RequestHandler } from 'express';
import { jsonRpcError } from './jsonRpcError.js';

/**
 * MCP 2025-11-25 (Streamable HTTP, security warning): servers MUST validate the
 * Origin header and answer 403 when it is present and invalid.
 *
 * Exact match on scheme + host + port. Requests without Origin (CLI clients,
 * server-to-server) pass through to bearer-token auth. `Origin: null` is rejected.
 */
export function originGuard(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin === undefined) return next();
    if (allowed.has(normalizeOrigin(origin) ?? '')) return next();
    res.status(403).json(jsonRpcError(-32000, 'Forbidden: origin not allowed'));
  };
}

function normalizeOrigin(value: string): string | undefined {
  try {
    const o = new URL(value).origin;
    return o === 'null' ? undefined : o;
  } catch {
    return undefined;
  }
}
