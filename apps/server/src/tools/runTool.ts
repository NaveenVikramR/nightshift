import type { AuthInfo, CallToolResult } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { hashInput, type AuditOutcome } from '../lib/audit.js';
import { getPrincipal } from '../lib/auth.js';
import { UserFacingError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { hasRole } from '../lib/roles.js';
import { countWords, MAX_SPEAK_WORDS, SPEAK } from '../lib/speak.js';
import { toSpokenWords } from '../lib/untrusted.js';
import type { ToolDefinition, ToolDeps, ToolOutput } from './types.js';

/**
 * The thin-adapter pipeline every tool goes through:
 * authenticate → authorize → validate (zod) → handler → audit row → MCP result.
 *
 * Arguments arrive unvalidated (tools are registered with passThroughSchema),
 * so schema failures are audited here too. Validation runs after the role check
 * so callers without the role learn nothing about the schema.
 *
 * Audit is fail-closed: if the row cannot be written, the caller gets an
 * error instead of the result (invariant 7).
 */
export async function runTool(
  def: ToolDefinition,
  deps: ToolDeps,
  rawInput: unknown,
  authInfo: AuthInfo | undefined,
  sessionId?: string,
): Promise<CallToolResult> {
  const principal = getPrincipal(authInfo);
  const inputHash = hashInput(rawInput ?? {});

  let outcome: AuditOutcome;
  let output: ToolOutput;

  if (!principal) {
    outcome = 'unauthenticated';
    output = { speak: SPEAK.unauthenticated, data: { error: 'unauthenticated' } };
  } else if (!hasRole(principal.role, def.minRole)) {
    outcome = 'forbidden';
    output = { speak: SPEAK.forbidden(def.minRole), data: { error: 'forbidden' } };
  } else {
    const parsed = def.inputSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      outcome = 'invalid_input';
      output = invalidInput(def, parsed.error);
    } else {
      try {
        output = await def.handler(parsed.data, {
          principal,
          deps,
          ...(sessionId !== undefined && { sessionId }),
        });
        outcome = output.isError ? 'error' : 'ok';
      } catch (err) {
        outcome = 'error';
        if (err instanceof UserFacingError) {
          output = { speak: err.speak, data: { error: err.code } };
        } else {
          log.error('tool failed', {
            tool: def.name,
            error: err instanceof Error ? err.message : 'unknown',
          });
          output = { speak: SPEAK.internalError, data: { error: 'internal_error' } };
        }
      }
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

function invalidInput(def: ToolDefinition, error: z.ZodError): ToolOutput {
  const issues = error.issues.slice(0, 5).map((i) => ({
    path: i.path.map(String).join('.'),
    message: i.message,
  }));
  const first = error.issues[0];
  const speak =
    (first && def.describeInvalidInput?.(first)) ??
    (first && first.path.length > 0
      ? `I couldn't use the ${toSpokenWords(String(first.path[0]))} you gave. Please try again.`
      : "I couldn't understand that request. Please try again.");
  return { speak, data: { error: 'invalid_input', issues } };
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
