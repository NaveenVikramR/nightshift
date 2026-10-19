/**
 * One spoken turn: the person's words -> model (with Nightshift's tools from
 * tools/list) -> MCP tool calls -> a short, grounded reply, the cards to show
 * and a trace for the judges' panel. Guards: per-token rate limit, daily model
 * cap, max tool calls per turn, max turns per session, timeouts, and the
 * human-yes rule for confirm_action.
 */
import type { McpTool } from '../mcp';
import { speakAndData, type McpToolResult } from '../mcp';
import type { DailyCap, RateLimiter, Usage } from '../limits';
import { TimeoutError, withTimeout } from '../limits';
import { log } from '../log';
import type { Session, TraceEntry } from '../sessions';
import { checkAgentConfirm } from './guard';
import { groundedReply } from './ground';
import { redactInput } from './redact';
import { SYSTEM_PROMPT } from './system';
import { isText, isToolUse, type ContentBlock, type Message, type ModelClient } from './types';

export interface AgentDeps {
  model: ModelClient;
  rate: RateLimiter;
  modelCap: DailyCap;
  usage: Usage;
  maxToolCallsPerTurn: number;
  maxTurnsPerSession: number;
  modelTimeoutMs: number;
  mcpTimeoutMs: number;
  turnTimeoutMs: number;
  now?: () => number;
}

export interface CardOut {
  tool: string;
  resourceUri: string;
  /** The CallToolResult, passed to the card through the MCP Apps bridge. */
  result: McpToolResult;
}

export interface TurnResult {
  reply: string;
  replySource: 'model' | 'tool' | 'guard';
  cards: CardOut[];
  trace: TraceEntry[];
  modelLabel: string;
}

const HISTORY_LIMIT = 30;

/**
 * End the turn with an assistant message so the history stays valid for Converse
 * (roles alternate; no toolUse without its toolResult).
 */
export function closeTurn(history: Message[], reply: string): void {
  const last = history[history.length - 1];
  if (last?.role === 'assistant' && last.content.some(isToolUse)) history.pop();
  if (history[history.length - 1]?.role !== 'assistant')
    history.push({ role: 'assistant', content: [{ text: reply }] });
}

/** Keep the last messages, starting at a plain user utterance (never orphan a toolResult). */
export function trimHistory(history: Message[], limit = HISTORY_LIMIT): Message[] {
  if (history.length <= limit) return history;
  let start = history.length - limit;
  while (start < history.length) {
    const m = history[start]!;
    if (m.role === 'user' && m.content.every(isText)) break;
    start++;
  }
  return history.slice(start);
}

function verificationOf(data: Record<string, unknown>): TraceEntry['verification'] {
  const v = data['verification'] as
    { outcome?: string; before?: number | null; after?: number | null } | undefined;
  return v?.outcome
    ? { outcome: v.outcome, before: v.before ?? null, after: v.after ?? null }
    : undefined;
}

/** Records the confirmation bookkeeping of a prepare/confirm result on the session + trace entry. */
function noteConfirmation(
  session: Session,
  entry: TraceEntry,
  data: Record<string, unknown>,
): void {
  if (entry.outcome !== 'ok') return;
  const id = typeof data['confirmationId'] === 'string' ? data['confirmationId'] : '';
  if (!id) return;
  if (entry.tool === 'prepare_action') {
    session.prepared.set(id, session.turn);
    entry.confirmation = { step: 'prepared', id: `${id.slice(0, 4)}…` };
  } else if (entry.tool === 'confirm_action') {
    session.prepared.delete(id);
    entry.confirmation = { step: 'confirmed', id: `${id.slice(0, 4)}…` };
    entry.verification = verificationOf(data);
  }
}

async function callTool(
  deps: AgentDeps,
  session: Session,
  tool: string,
  input: Record<string, unknown>,
  source: TraceEntry['source'],
): Promise<{
  result: McpToolResult;
  entry: TraceEntry;
  speak: string;
  data: Record<string, unknown>;
}> {
  const now = deps.now ?? Date.now;
  let result: McpToolResult;
  try {
    result = await withTimeout(deps.mcpTimeoutMs, `tool ${tool}`, () =>
      session.mcp.callTool(tool, input),
    );
  } catch (err) {
    const timeout = err instanceof TimeoutError;
    const speak = timeout
      ? "Nightshift didn't answer in time. Try again in a minute."
      : "I couldn't reach Nightshift. Try again in a minute.";
    result = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ speak, data: { error: timeout ? 'timeout' : 'unreachable' } }),
        },
      ],
      isError: true,
    };
  }
  const { speak, data } = speakAndData(result);
  const entry: TraceEntry = {
    turn: session.turn,
    at: new Date(now()).toISOString(),
    source,
    tool,
    input: redactInput(input),
    outcome: result.isError ? 'error' : 'ok',
    note: speak,
  };
  noteConfirmation(session, entry, data);
  return { result, entry, speak, data };
}

export async function runTurn(
  deps: AgentDeps,
  session: Session,
  utterance: string,
): Promise<TurnResult> {
  const modelLabel = deps.model.label;
  const guardReply = (reply: string): TurnResult => ({
    reply,
    replySource: 'guard',
    cards: [],
    trace: [],
    modelLabel,
  });

  if (session.turn >= deps.maxTurnsPerSession) {
    return guardReply('This conversation is getting long. Sign out and in again to start fresh.');
  }
  if (!deps.rate.take(session.tokenKey)) {
    deps.usage.add('rateLimited');
    const s = deps.rate.retryAfterSeconds(session.tokenKey);
    return guardReply(
      `You're going a bit fast. Try again in ${Math.max(1, Math.round(s / 60))} minute${s > 90 ? 's' : ''}.`,
    );
  }

  session.turn++;
  deps.usage.add('turns');
  session.history.push({ role: 'user', content: [{ text: utterance.slice(0, 500) }] });

  const cards: CardOut[] = [];
  const trace: TraceEntry[] = [];
  const answered: { speak: string; data: unknown }[] = [];
  let toolCalls = 0;

  const work = async (): Promise<TurnResult> => {
    const tools: McpTool[] = await session.mcp.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const specs = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    for (;;) {
      if (!deps.modelCap.take()) {
        deps.usage.add('dailyCapHit');
        log.warn('daily model cap reached', { cap: deps.modelCap.limit });
        const reply = "I've reached today's limit for this demo. Please try again tomorrow.";
        closeTurn(session.history, reply);
        return { reply, replySource: 'guard', cards, trace, modelLabel };
      }
      deps.usage.add('modelRequests');
      const response = await withTimeout(deps.modelTimeoutMs, 'model', (signal) =>
        deps.model.converse({
          system: SYSTEM_PROMPT,
          messages: trimHistory(session.history),
          tools: specs,
          signal,
        }),
      );
      session.history.push(response.message);

      const uses = response.message.content.filter(isToolUse);
      if (uses.length === 0) {
        const text = response.message.content
          .filter(isText)
          .map((b) => b.text)
          .join(' ');
        const g = groundedReply(text, answered);
        return { reply: g.text, replySource: g.source, cards, trace, modelLabel };
      }

      const results: ContentBlock[] = [];
      let stop: string | undefined;
      for (const use of uses) {
        const { toolUseId, name, input } = use.toolUse;
        const err = (message: string): ContentBlock => ({
          toolResult: {
            toolUseId,
            status: 'error',
            content: [{ json: { speak: message, data: { error: 'refused' } } }],
          },
        });

        if (toolCalls >= deps.maxToolCallsPerTurn) {
          deps.usage.add('toolCallLimitHit');
          stop = "I've done as much as I can for that question. Ask me again to keep going.";
          results.push(err('Tool call limit for this turn reached.'));
          continue;
        }
        const tool = byName.get(name);
        if (!tool) {
          results.push(err(`There is no tool named ${name}.`));
          continue;
        }
        if (name === 'confirm_action') {
          const decision = checkAgentConfirm({
            confirmationId: input['confirmation_id'],
            prepared: session.prepared,
            currentTurn: session.turn,
            utterance,
          });
          if (!decision.ok) {
            deps.usage.add('refusedConfirms');
            trace.push({
              turn: session.turn,
              at: new Date((deps.now ?? Date.now)()).toISOString(),
              source: 'agent',
              tool: name,
              input: redactInput(input),
              outcome: 'refused',
              note: decision.reason,
              confirmation: {
                step: 'refused',
                id: `${String(input['confirmation_id'] ?? '').slice(0, 4)}…`,
              },
            });
            results.push(err(decision.reason));
            continue;
          }
          trace.push({
            turn: session.turn,
            at: new Date((deps.now ?? Date.now)()).toISOString(),
            source: 'agent',
            tool: 'human',
            input: {},
            outcome: 'ok',
            note: 'The person said yes.',
            confirmation: {
              step: 'human_yes',
              id: `${String(input['confirmation_id']).slice(0, 4)}…`,
            },
          });
        }

        toolCalls++;
        deps.usage.add('toolCalls');
        const call = await callTool(deps, session, name, input, 'agent');
        trace.push(call.entry);
        answered.push({ speak: call.speak, data: call.data });
        if (tool.resourceUri)
          cards.push({ tool: name, resourceUri: tool.resourceUri, result: call.result });
        results.push({
          toolResult: {
            toolUseId,
            status: call.result.isError ? 'error' : 'success',
            // Data only: quoted/untrusted fields stay as Nightshift marked them.
            content: [{ json: { speak: call.speak, data: call.data } }],
          },
        });
      }
      session.history.push({ role: 'user', content: results });
      if (stop) {
        closeTurn(session.history, stop);
        return { reply: stop, replySource: 'guard', cards, trace, modelLabel };
      }
    }
  };

  try {
    const result = await withTimeout(deps.turnTimeoutMs, 'turn', () => work());
    session.trace.push(...result.trace);
    return result;
  } catch (err) {
    const timeout = err instanceof TimeoutError;
    log.warn('turn failed', { error: err instanceof Error ? err.name : 'unknown', timeout });
    session.trace.push(...trace);
    const reply = timeout
      ? 'That took too long. Try again in a minute.'
      : "I couldn't think that through just now. Try again in a minute.";
    closeTurn(session.history, reply);
    return {
      reply,
      replySource: 'guard',
      cards,
      trace,
      modelLabel,
    };
  }
}

/** Tools a card may call through the MCP Apps bridge (its buttons), and nothing else. */
export const CARD_TOOLS = new Set(['prepare_action', 'confirm_action', 'get_security_findings']);

/**
 * A card button (MCP Apps bridge -> POST /api/tool). The click is the person's
 * explicit yes for confirm_action, but only for a confirmation this session prepared.
 */
export async function runCardTool(
  deps: AgentDeps,
  session: Session,
  tool: string,
  input: Record<string, unknown>,
): Promise<{ result: McpToolResult; trace: TraceEntry[] } | { refused: string }> {
  if (!CARD_TOOLS.has(tool))
    return { refused: 'Cards can only prepare, confirm, or read findings.' };
  if (!deps.rate.take(session.tokenKey)) {
    deps.usage.add('rateLimited');
    return { refused: "You're going a bit fast. Try again in a minute." };
  }
  const trace: TraceEntry[] = [];
  if (tool === 'confirm_action') {
    const id = typeof input['confirmation_id'] === 'string' ? input['confirmation_id'] : '';
    if (!session.prepared.has(id)) {
      deps.usage.add('refusedConfirms');
      return { refused: 'That confirmation was not prepared in this conversation. Ask me again.' };
    }
    trace.push({
      turn: session.turn,
      at: new Date((deps.now ?? Date.now)()).toISOString(),
      source: 'card',
      tool: 'human',
      input: {},
      outcome: 'ok',
      note: 'The person pressed Confirm on the card.',
      confirmation: { step: 'human_yes', id: `${id.slice(0, 4)}…` },
    });
  }
  deps.usage.add('cardToolCalls');
  const call = await callTool(deps, session, tool, input, 'card');
  trace.push(call.entry);
  session.trace.push(...trace);
  return { result: call.result, trace };
}
