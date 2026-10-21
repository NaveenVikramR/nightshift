/**
 * Local model (no AWS): maps what the person says to Nightshift tools with
 * keyword intents and answers with the tools' own `speak` text. It drives the
 * same agent loop, guards and limits as Bedrock, so the whole app runs locally.
 * Clearly labelled in the UI; ALEXA_MODEL_PROVIDER=bedrock or groq selects a real model.
 */
import { isExplicitYes, isNo } from './guard';
import {
  isText,
  isToolResult,
  isToolUse,
  type ContentBlock,
  type Message,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from './types';

type ToolCall = { name: string; input: Record<string, unknown> };

const SERVICE_WORDS: [RegExp, string][] = [
  [/\bpayments?\b/i, 'payments'],
  [/\bwebhooks?\b/i, 'webhook'],
];

function serviceIn(text: string): string | undefined {
  return SERVICE_WORDS.find(([re]) => re.test(text))?.[1];
}

/** Latest structured result of `tool` in the conversation. */
function lastResult(messages: Message[], tool: string): Record<string, unknown> | undefined {
  const names = new Map<string, string>();
  for (const m of messages)
    for (const b of m.content) if (isToolUse(b)) names.set(b.toolUse.toolUseId, b.toolUse.name);
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const b of messages[i]!.content) {
      if (!isToolResult(b) || names.get(b.toolResult.toolUseId) !== tool) continue;
      const json = b.toolResult.content.find((c): c is { json: unknown } => 'json' in c)?.json;
      if (json && typeof json === 'object') return json as Record<string, unknown>;
    }
  }
  return undefined;
}

/** The suggested remediations of the latest diagnosis, best cause first. */
function suggestions(messages: Message[]): { action: string; params: Record<string, string> }[] {
  const data = lastResult(messages, 'explain_incident')?.['data'] as
    | {
        causes?: {
          suggestedActions?: {
            action: string;
            params: Record<string, string>;
            requiresConfirmation?: boolean;
          }[];
        }[];
      }
    | undefined;
  return (data?.causes ?? [])
    .flatMap((c) => c.suggestedActions ?? [])
    .filter((s) => s.requiresConfirmation && s.action !== 'investigate');
}

export function intentFor(text: string, messages: Message[]): ToolCall | { say: string } {
  const t = text.toLowerCase();
  const service = serviceIn(t);
  const withService = (input: Record<string, unknown> = {}) =>
    service ? { ...input, service } : input;

  const pending = lastResult(messages, 'prepare_action')?.['data'] as
    { confirmationId?: string } | undefined;
  if (isNo(t)) return { say: "Okay, I won't change anything." };
  if (isExplicitYes(t)) {
    if (pending?.confirmationId)
      return { name: 'confirm_action', input: { confirmation_id: pending.confirmationId } };
    return { say: "There's nothing waiting for your OK. Ask me what's wrong first." };
  }

  if (/fail ?over|switch (to|provider)/.test(t)) {
    const s = suggestions(messages).find((x) => x.action === 'failover_provider');
    if (s) return { name: 'prepare_action', input: { suggested_action: s } };
    const to = /\bto (\w+)/.exec(t)?.[1];
    return {
      name: 'prepare_action',
      input: withService({ action: 'failover_provider', ...(to && { params: { to } }) }),
    };
  }
  if (/roll ?back|revert/.test(t)) {
    const s = suggestions(messages).find((x) => x.action === 'rollback_deploy');
    return {
      name: 'prepare_action',
      input: s ? { suggested_action: s } : withService({ action: 'rollback_deploy' }),
    };
  }
  if (/\brestart\b/.test(t))
    return { name: 'prepare_action', input: withService({ action: 'restart_service' }) };

  if (/\b(note|remember that|log that)\b/.test(t)) {
    const note = text.replace(/^.*?\b(note|remember that|log that)\b[:,]?\s*/i, '').trim();
    if (note) return { name: 'add_incident_note', input: { note } };
  }
  if (/last time|what happened|timeline|postmortem|post-mortem/.test(t))
    return { name: 'get_incident_timeline', input: withService() };
  if (/security|secure|vulnerab|scan|headers|tls|certificate/.test(t)) {
    return /scan|now|run/.test(t)
      ? { name: 'run_security_scan', input: {} }
      : { name: 'get_security_findings', input: {} };
  }
  if (/what'?s wrong|what is wrong|why|broken|broke|incident|diagnos|what'?s going on/.test(t)) {
    return { name: 'explain_incident', input: withService() };
  }
  if (/alert|firing|paging/.test(t)) return { name: 'list_active_alerts', input: withService() };
  if (/deploy|release|what changed/.test(t))
    return { name: 'get_recent_deploys', input: withService() };
  if (service && /how|health|doing|status|latency|errors?/.test(t))
    return { name: 'get_service_health', input: withService() };
  if (/brief|everything|overview|status|how are we|summary|morning/.test(t))
    return { name: 'get_ops_brief', input: {} };
  if (/who am i|working|are you there|ping/.test(t)) return { name: 'ping_nightshift', input: {} };
  return {
    say: "I can give you the ops brief, explain what's wrong, check security, or tell you what happened. Try: what's wrong?",
  };
}

let seq = 0;
const text = (s: string): Message => ({ role: 'assistant', content: [{ text: s }] });

export class ScriptedModel implements ModelClient {
  readonly label = 'Local scripted model (no AWS)';

  async converse(req: ModelRequest): Promise<ModelResponse> {
    const last = req.messages[req.messages.length - 1];
    if (!last) return { message: text('Say something to start.'), stopReason: 'end_turn' };

    // After tool results: answer with the tool's own speak (grounded by construction).
    const results = last.content.filter(isToolResult);
    if (results.length > 0) {
      const json = results[results.length - 1]!.toolResult.content.find(
        (c): c is { json: unknown } => 'json' in c,
      )?.json as { speak?: string } | undefined;
      return { message: text(json?.speak || 'Done.'), stopReason: 'end_turn' };
    }

    const utterance = last.content
      .filter(isText)
      .map((b) => b.text)
      .join(' ');
    const intent = intentFor(utterance, req.messages);
    if ('say' in intent) return { message: text(intent.say), stopReason: 'end_turn' };
    if (!req.tools.some((t) => t.name === intent.name)) {
      return { message: text("I can't do that with the tools I have."), stopReason: 'end_turn' };
    }
    const block: ContentBlock = {
      toolUse: { toolUseId: `scripted-${++seq}`, name: intent.name, input: intent.input },
    };
    return { message: { role: 'assistant', content: [block] }, stopReason: 'tool_use' };
  }
}
