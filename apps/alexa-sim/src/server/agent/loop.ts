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
import { errorFields, log } from '../log';
import type { Session, TraceEntry } from '../sessions';
import { compactForModel } from './compact';
import { checkAgentConfirm, isExplicitYes } from './guard';
import {
  GUARDRAIL_INPUT_SPOKEN,
  GUARDRAIL_SPOKEN,
  GUARDRAIL_UNCHECKED_SPOKEN,
  untrustedTexts,
  withholdUntrusted,
  WITHHELD_FLAGGED,
  WITHHELD_UNCHECKED,
  type TextGuard,
} from './guardrail';
import { groundedReply } from './ground';
import { redactInput } from './redact';
import { systemPrompt } from './system';
import { toolNamesIn, toolsForTurn, toSpecs } from './tools';
import {
  isText,
  isToolUse,
  type ContentBlock,
  type Message,
  type ModelClient,
  type ModelResponse,
} from './types';

export interface AgentDeps {
  model: ModelClient;
  /**
   * Bedrock Guardrails (ApplyGuardrail): the person's words and untrusted tool-result
   * text, whatever the model provider. Optional second layer.
   */
  guard?: TextGuard;
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

/** Counts for one turn (logs, the trace panel and CloudWatch). No content. */
export interface TurnStats {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  guardrailBlocks: number;
  modelErrors: number;
}

export interface TurnResult {
  reply: string;
  replySource: 'model' | 'tool' | 'guard';
  cards: CardOut[];
  trace: TraceEntry[];
  modelLabel: string;
  stats: TurnStats;
}

const newStats = (): TurnStats => ({
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  toolCalls: 0,
  guardrailBlocks: 0,
  modelErrors: 0,
});

/** An audit line for a guardrail block: who, which tool, where. Never the text. */
function auditGuardrailBlock(session: Session, tool: string, where: string): void {
  log.info('audit', {
    event: 'guardrail_block',
    actor: session.actor,
    role: session.role,
    tool,
    where,
  });
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** How long a repeated "yes" is answered with the last confirmed result. */
const ALREADY_DONE_WINDOW_MS = 10 * 60_000;

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
    session.lastConfirmed = { speak: entry.note, at: Date.parse(entry.at) };
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
  /** A guardrail entry when untrusted text was withheld. */
  guardEntry?: TraceEntry;
  speak: string;
  /** For the model: untrusted text withheld if the guardrail blocked it or couldn't check it. */
  data: Record<string, unknown>;
  blocked: boolean;
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
  const { speak, data: raw } = speakAndData(result);
  let data = raw;
  let blocked = false;
  let guardEntry: TraceEntry | undefined;
  const texts = deps.guard ? untrustedTexts(raw) : [];
  if (deps.guard && texts.length) {
    let verdict: 'allowed' | 'blocked' | 'unchecked';
    try {
      verdict = await withTimeout(deps.mcpTimeoutMs, 'guardrail', (signal) =>
        deps.guard!.check(texts, signal),
      );
    } catch (err) {
      log.warn('guardrail check failed', errorFields(err));
      verdict = 'unchecked';
    }
    if (verdict !== 'allowed') {
      data = withholdUntrusted(raw, verdict === 'blocked' ? WITHHELD_FLAGGED : WITHHELD_UNCHECKED);
      blocked = verdict === 'blocked';
      guardEntry = {
        turn: session.turn,
        at: new Date(now()).toISOString(),
        source,
        tool: 'guardrail',
        input: { tool, texts: texts.length },
        outcome: blocked ? 'refused' : 'error',
        note: blocked
          ? `Blocked: outside text in the ${tool} result looked like an instruction. Withheld from the model.`
          : `Couldn't check outside text in the ${tool} result, so it was withheld from the model.`,
      };
      if (blocked) {
        deps.usage.add('guardrailBlocks');
        auditGuardrailBlock(session, tool, 'tool_result');
      }
    }
  }
  // The model gets the facts, not the card's chart series (cost, provider request limits).
  data = compactForModel(data);
  const entry: TraceEntry = {
    turn: session.turn,
    at: new Date(now()).toISOString(),
    source,
    tool,
    input: redactInput(input),
    outcome: result.isError ? 'error' : 'ok',
    note: speak,
  };
  noteConfirmation(session, entry, raw);
  return { result, entry, ...(guardEntry && { guardEntry }), speak, data, blocked };
}

export async function runTurn(
  deps: AgentDeps,
  session: Session,
  utterance: string,
): Promise<TurnResult> {
  const modelLabel = deps.model.label;
  const stats = newStats();
  const guardReply = (reply: string): TurnResult => ({
    reply,
    replySource: 'guard',
    cards: [],
    trace: [],
    modelLabel,
    stats,
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
  let toolBlocked = false;
  const nowIso = () => new Date((deps.now ?? Date.now)()).toISOString();
  const result = (reply: string, replySource: TurnResult['replySource']): TurnResult => {
    // Say that outside text was left out when it fits the voice budget; otherwise the
    // grounded answer wins (the block stays visible in the trace and the audit log).
    if (toolBlocked && replySource !== 'guard' && words(`${GUARDRAIL_SPOKEN} ${reply}`) <= 30)
      reply = `${GUARDRAIL_SPOKEN} ${reply}`;
    return { reply, replySource, cards, trace, modelLabel, stats };
  };

  /** ApplyGuardrail on the person's words before any model sees them (fail closed). */
  const guardUtterance = async (): Promise<TurnResult | undefined> => {
    if (!deps.guard) return undefined;
    let verdict: 'allowed' | 'blocked' | 'unchecked';
    try {
      verdict = await withTimeout(deps.mcpTimeoutMs, 'guardrail', (signal) =>
        deps.guard!.check([utterance.slice(0, 500)], signal),
      );
    } catch (err) {
      log.warn('guardrail check failed', errorFields(err));
      verdict = 'unchecked';
    }
    if (verdict === 'allowed') return undefined;
    const blocked = verdict === 'blocked';
    if (blocked) {
      stats.guardrailBlocks++;
      deps.usage.add('guardrailBlocks');
      auditGuardrailBlock(session, 'utterance', 'user_input');
    }
    // Keep the words out of the history either way.
    const last = session.history[session.history.length - 1];
    if (last?.role === 'user') last.content = [{ text: '(withheld by the guardrail)' }];
    trace.push({
      turn: session.turn,
      at: nowIso(),
      source: 'agent',
      tool: 'guardrail',
      input: { checked: 'your words' },
      outcome: blocked ? 'refused' : 'error',
      note: blocked
        ? 'Blocked by the prompt-attack filter before the model saw it.'
        : "Couldn't check your words, so they were not sent to the model.",
    });
    const reply = blocked ? GUARDRAIL_INPUT_SPOKEN : GUARDRAIL_UNCHECKED_SPOKEN;
    closeTurn(session.history, reply);
    return result(reply, 'guard');
  };

  /**
   * "Yes" again after the action already ran (nothing pending): say so from the recorded
   * result, without the model. Nightshift would never run it twice anyway (single-use,
   * idempotent confirmations); this keeps the spoken answer grounded.
   */
  const alreadyDone = (): TurnResult | undefined => {
    const last = session.lastConfirmed;
    const now = (deps.now ?? Date.now)();
    if (!last || session.prepared.size > 0 || !isExplicitYes(utterance)) return undefined;
    if (now - last.at > ALREADY_DONE_WINDOW_MS) return undefined;
    const reply = `That's already done. ${last.speak}`;
    trace.push({
      turn: session.turn,
      at: nowIso(),
      source: 'agent',
      tool: 'human',
      input: {},
      outcome: 'ok',
      note: 'You said yes again: that action already ran, so nothing ran twice.',
    });
    closeTurn(session.history, reply);
    return result(words(reply) <= 30 ? reply : "That's already done.", 'guard');
  };

  const work = async (): Promise<TurnResult> => {
    const refused = await guardUtterance();
    if (refused) return refused;
    const done = alreadyDone();
    if (done) return done;
    const all: McpTool[] = await session.mcp.listTools();
    const byName = new Map(all.map((t) => [t.name, t]));
    // Trimmed once per turn: confirm_action only once something is prepared.
    const offered = toolsForTurn(all, {
      role: session.role,
      utterance,
      pendingConfirmation: session.prepared.size > 0,
      inHistory: toolNamesIn(session.history),
    });
    const specs = toSpecs(offered);
    const system = systemPrompt(offered.some((t) => t.name === 'prepare_action'));

    for (;;) {
      if (!deps.modelCap.take()) {
        deps.usage.add('dailyCapHit');
        log.warn('daily model cap reached', { cap: deps.modelCap.limit });
        const reply = "I've reached today's limit for this demo. Please try again tomorrow.";
        closeTurn(session.history, reply);
        return result(reply, 'guard');
      }
      deps.usage.add('modelRequests');
      let response: ModelResponse;
      try {
        response = await withTimeout(deps.modelTimeoutMs, 'model', (signal) =>
          deps.model.converse({
            system,
            messages: trimHistory(session.history),
            tools: specs,
            signal,
          }),
        );
      } catch (err) {
        stats.modelErrors++;
        deps.usage.add('modelErrors');
        throw err;
      }
      stats.modelCalls++;
      stats.inputTokens += response.usage?.inputTokens ?? 0;
      stats.outputTokens += response.usage?.outputTokens ?? 0;
      deps.usage.add('inputTokens', response.usage?.inputTokens ?? 0);
      deps.usage.add('outputTokens', response.usage?.outputTokens ?? 0);

      session.history.push(response.message);

      const uses = response.message.content.filter(isToolUse);
      if (uses.length === 0) {
        const text = response.message.content
          .filter(isText)
          .map((b) => b.text)
          .join(' ');
        const g = groundedReply(text, answered);
        return result(g.text, g.source);
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

        if (stats.toolCalls >= deps.maxToolCallsPerTurn) {
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

        stats.toolCalls++;
        deps.usage.add('toolCalls');
        const call = await callTool(deps, session, name, input, 'agent');
        trace.push(call.entry);
        if (call.guardEntry) trace.push(call.guardEntry);
        if (call.blocked) {
          toolBlocked = true;
          stats.guardrailBlocks++;
        }
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
        return result(stop, 'guard');
      }
    }
  };

  /** "model" entry: which model, how many calls and tokens (counts only). */
  const modelEntry = (): TraceEntry => ({
    turn: session.turn,
    at: nowIso(),
    source: 'agent',
    tool: 'model',
    input: {},
    outcome: stats.modelErrors ? 'error' : 'ok',
    note: `${modelLabel}: ${stats.modelCalls} call${stats.modelCalls === 1 ? '' : 's'}, ${stats.inputTokens} input and ${stats.outputTokens} output tokens.`,
    tokens: { input: stats.inputTokens, output: stats.outputTokens },
  });

  try {
    const done = await withTimeout(deps.turnTimeoutMs, 'turn', () => work());
    done.trace.push(modelEntry());
    session.trace.push(...done.trace);
    return done;
  } catch (err) {
    // Match by name: a bundler can duplicate error classes across chunks (instanceof fails).
    const name = err instanceof Error ? err.name : 'unknown';
    const timeout = name === 'TimeoutError';
    const busy = name === 'ModelRateLimitError';
    if (busy) deps.usage.add('modelRateLimited');
    const e = err as { status?: unknown; code?: unknown; message?: unknown };
    log.warn('turn failed', {
      error: name,
      timeout,
      ...(name === 'ModelError' && {
        status: typeof e.status === 'number' ? e.status : null,
        code: typeof e.code === 'string' ? e.code : null,
      }),
      // Programming errors only (never provider bodies or user text).
      ...(name === 'TypeError' && { detail: String(e.message).slice(0, 160) }),
    });
    trace.push(modelEntry());
    session.trace.push(...trace);
    // A tool already answered (e.g. confirm_action ran and was verified): say its grounded
    // result rather than an error, because the action did happen.
    if (answered.length) {
      // Through result(), so a guardrail block in this turn is still said out loud.
      const r = result(groundedReply('', answered).text, 'tool');
      closeTurn(session.history, r.reply);
      return r;
    }
    const reply = busy
      ? 'The model is busy right now. Try again in a minute.'
      : timeout
        ? 'That took too long. Try again in a minute.'
        : "I couldn't think that through just now. Try again in a minute.";
    closeTurn(session.history, reply);
    return { reply, replySource: 'guard', cards, trace, modelLabel, stats };
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
): Promise<
  | { result: McpToolResult; speak: string; blocked: boolean; trace: TraceEntry[] }
  | { refused: string }
> {
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
  if (call.guardEntry) trace.push(call.guardEntry);
  session.trace.push(...trace);
  recordCardCall(session, tool, input, call.speak, call.data, call.result.isError === true);
  return { result: call.result, speak: call.speak, blocked: call.blocked, trace };
}

let cardSeq = 0;

/**
 * Put a card button's tool call into the conversation, so the model knows about
 * it (e.g. the person taps "Fail over" on the card, then SAYS "yes"). Recorded as
 * a proper toolUse/toolResult pair after a user note, keeping roles alternating.
 */
function recordCardCall(
  session: Session,
  tool: string,
  input: Record<string, unknown>,
  speak: string,
  data: Record<string, unknown>,
  isError: boolean,
): void {
  const last = session.history[session.history.length - 1];
  if (last && last.role !== 'assistant') closeTurn(session.history, 'Okay.');
  const toolUseId = `card-${++cardSeq}`;
  session.history.push(
    {
      role: 'user',
      content: [{ text: `(I pressed a button on the ${tool.replaceAll('_', ' ')} card.)` }],
    },
    { role: 'assistant', content: [{ toolUse: { toolUseId, name: tool, input } }] },
    {
      role: 'user',
      content: [
        {
          toolResult: {
            toolUseId,
            status: isError ? 'error' : 'success',
            content: [{ json: { speak, data } }],
          },
        },
      ],
    },
    { role: 'assistant', content: [{ text: speak || 'Done.' }] },
  );
}
