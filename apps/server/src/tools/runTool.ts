import type { AuthInfo, CallToolResult } from '@modelcontextprotocol/server';
import { hashInput, type AuditOutcome } from '../lib/audit.js';
import { getPrincipal } from '../lib/auth.js';
import { log } from '../lib/log.js';
import { hasRole } from '../lib/roles.js';
import { countWords, MAX_SPEAK_WORDS, SPEAK } from '../lib/speak.js';
import type { ToolDefinition, ToolDeps, ToolOutput } from './types.js';

/**
 * The thin-adapter pipeline every tool goes through:
 * (input already validated by the SDK against the zod schema) → authorize →
 * handler (domain call + speak/data) → audit row → MCP result.
 *
 * Audit is fail-closed: if the row cannot be written, the caller gets an
 * error instead of the result (invariant 7).
 */
export async function runTool<D>(
  def: ToolDefinition,
  deps: ToolDeps,
  input: unknown,
  authInfo: AuthInfo | undefined,
): Promise<CallToolResult> {
  const principal = getPrincipal(authInfo);
  const inputHash = hashInput(input);

  let outcome: AuditOutcome;
  let output: ToolOutput<D | { error: string }>;

  if (!principal) {
    outcome = 'unauthenticated';
    output = { speak: SPEAK.unauthenticated, data: { error: 'unauthenticated' } };
  } else if (!hasRole(principal.role, def.minRole)) {
    outcome = 'forbidden';
    output = { speak: SPEAK.forbidden(def.minRole), data: { error: 'forbidden' } };
  } else {
    try {
      output = (await def.handler(input as never, { principal, deps })) as ToolOutput<D>;
      outcome = 'ok';
    } catch (err) {
      log.error('tool failed', {
        tool: def.name,
        error: err instanceof Error ? err.message : 'unknown',
      });
      outcome = 'error';
      output = { speak: SPEAK.internalError, data: { error: 'internal_error' } };
    }
  }

  try {
    await deps.audit.record({
      actor: principal?.actor ?? 'unknown',
      role: principal?.role ?? 'unknown',
      tool: def.name,
      inputHash,
      outcome,
    });
  } catch (err) {
    log.error('audit write failed', {
      tool: def.name,
      error: err instanceof Error ? err.message : 'unknown',
    });
    return toResult({ speak: SPEAK.auditFailed, data: { error: 'audit_unavailable' } }, true);
  }

  if (countWords(output.speak) > MAX_SPEAK_WORDS) {
    log.warn('speak exceeds word budget', { tool: def.name, words: countWords(output.speak) });
  }
  return toResult(output, outcome !== 'ok');
}

function toResult(output: ToolOutput, isError: boolean): CallToolResult {
  const structured = { speak: output.speak, data: output.data };
  return {
    // Spec: tools returning structuredContent SHOULD also return it serialized as text.
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
    ...(isError && { isError: true }),
  };
}
