import type { Request, RequestHandler } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { hashInput, type AuditLog, type AuditOutcome } from '../lib/audit.js';
import { getPrincipal } from '../lib/auth.js';
import { log } from '../lib/log.js';
import { sanitizeLabel } from '../lib/untrusted.js';

interface ToolCallBody {
  method: 'tools/call';
  params?: { name?: unknown; arguments?: unknown };
}

function isToolCall(body: unknown): body is ToolCallBody {
  return (
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    (body as { method?: unknown }).method === 'tools/call'
  );
}

/** Outcome for a tools/call that never reached runTool, or undefined if runTool handled it. */
function refusalOutcome(status: number, knownTool: boolean): AuditOutcome | undefined {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden_request';
  if (status === 404) return 'session_not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 400) return 'bad_request';
  return knownTool ? undefined : 'unknown_tool';
}

export interface ToolCallAuditTapOptions {
  audit: AuditLog;
  knownTools: ReadonlySet<string>;
  /** Write at most one `rate_limited` row per IP per this window (audit-flood guard). */
  rateLimitedDedupMs: number;
  now: () => number;
}

/**
 * Invariant 7 for tools/call requests that never reach a tool: refused by the
 * Host/Origin guard, auth, the failed-auth limiter, or session lookup, or naming
 * an unknown tool. Mounted after body parsing and before every guard; it only
 * observes (on response finish). Calls that reach runTool are audited there.
 *
 * Not covered: bodies over the size limit (413) and invalid JSON, which are
 * never parsed, so nothing identifies them as tool calls.
 */
export function toolCallAuditTap(opts: ToolCallAuditTapOptions): RequestHandler {
  const rateLimitedUntil = new Map<string, number>();

  return (req, res, next) => {
    const body: unknown = req.body;
    if (req.method !== 'POST' || !isToolCall(body)) return next();

    res.on('finish', () => {
      const rawName = body.params?.name;
      const knownTool = typeof rawName === 'string' && opts.knownTools.has(rawName);
      const outcome = refusalOutcome(res.statusCode, knownTool);
      if (!outcome) return;

      const ip = req.ip ?? 'unknown';
      if (outcome === 'rate_limited') {
        const now = opts.now();
        for (const [k, until] of rateLimitedUntil) if (until <= now) rateLimitedUntil.delete(k);
        if (rateLimitedUntil.has(ip)) return;
        rateLimitedUntil.set(ip, now + opts.rateLimitedDedupMs);
      }

      const principal = getPrincipal((req as Request & { auth?: AuthInfo }).auth);
      const tool = sanitizeLabel(rawName) || '(none)';
      opts.audit
        .record({
          actor: principal?.actor ?? 'anonymous',
          role: principal?.role ?? 'unknown',
          tool,
          inputHash: hashInput(body.params?.arguments ?? {}),
          outcome,
        })
        .catch((err: unknown) =>
          log.error('audit write failed', {
            tool,
            outcome,
            error: err instanceof Error ? err.message : 'unknown',
          }),
        );
    });
    next();
  };
}
