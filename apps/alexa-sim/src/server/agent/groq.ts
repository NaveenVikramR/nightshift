/**
 * Groq (OpenAI-compatible chat completions with tool calling): the model
 * provider while the Bedrock quota is 0 (FL-31). Chosen by config only
 * (ALEXA_MODEL_PROVIDER=groq), never as a fallback. The API key stays in this
 * object (a #private field): it is sent only in the Authorization header and is
 * never logged, returned or put in an error. Errors carry the HTTP status only.
 */
import {
  isText,
  isToolResult,
  isToolUse,
  ModelError,
  ModelRateLimitError,
  type ContentBlock,
  type Message,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from './types';

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

/** The one HTTP call we make (fetch in prod; a fake in tests). */
export type HttpPost = (
  url: string,
  init: { headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<HttpResponse>;

const fetchPost: HttpPost = (url, init) => fetch(url, { method: 'POST', ...init });

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    }
  | { role: 'tool'; tool_call_id: string; name: string; content: string };

/** Converse-shaped history -> OpenAI chat messages. */
export function toChatMessages(system: string, messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: system }];
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'assistant') {
      const uses = m.content.filter(isToolUse);
      for (const u of uses) toolNames.set(u.toolUse.toolUseId, u.toolUse.name);
      const text = m.content
        .filter(isText)
        .map((b) => b.text)
        .join(' ');
      out.push({
        role: 'assistant',
        content: text || null,
        ...(uses.length && {
          tool_calls: uses.map((u) => ({
            id: u.toolUse.toolUseId,
            type: 'function' as const,
            function: { name: u.toolUse.name, arguments: JSON.stringify(u.toolUse.input) },
          })),
        }),
      });
      continue;
    }
    for (const r of m.content.filter(isToolResult)) {
      const body = r.toolResult.content
        .map((c) => ('json' in c ? JSON.stringify(c.json) : c.text))
        .join('\n');
      out.push({
        role: 'tool',
        tool_call_id: r.toolResult.toolUseId,
        name: toolNames.get(r.toolResult.toolUseId) ?? 'tool',
        content: body,
      });
    }
    const text = m.content
      .filter(isText)
      .map((b) => b.text)
      .join(' ');
    if (text) out.push({ role: 'user', content: text });
  }
  return out;
}

export function buildChatRequest(model: string, req: ModelRequest): Record<string, unknown> {
  return {
    model,
    messages: toChatMessages(req.system, req.messages),
    tools: req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    })),
    tool_choice: 'auto',
    // One call at a time: our loop and the human-yes guard reason per call.
    parallel_tool_calls: false,
    temperature: 0,
    // Room for the short reasoning of gpt-oss models plus a ≤ 30-word answer.
    max_completion_tokens: 600,
    ...(model.startsWith('openai/gpt-oss') && { reasoning_effort: 'low' }),
  };
}

interface ChatCompletion {
  choices?: {
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw ?? '{}');
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

let callSeq = 0;

export function fromChatCompletion(body: ChatCompletion): ModelResponse {
  const choice = body.choices?.[0];
  const msg = choice?.message;
  const content: ContentBlock[] = [];
  if (msg?.content?.trim()) content.push({ text: msg.content.trim() });
  for (const c of msg?.tool_calls ?? []) {
    if (!c.function?.name) continue;
    content.push({
      toolUse: {
        toolUseId: c.id || `groq-${++callSeq}`,
        name: c.function.name,
        input: parseArgs(c.function.arguments),
      },
    });
  }
  const finish = choice?.finish_reason;
  const stopReason: ModelResponse['stopReason'] = content.some(isToolUse)
    ? 'tool_use'
    : finish === 'stop'
      ? 'end_turn'
      : finish === 'length'
        ? 'max_tokens'
        : 'other';
  return {
    message: { role: 'assistant', content },
    stopReason,
    usage: {
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
    },
  };
}

export class GroqModel implements ModelClient {
  readonly label: string;
  readonly #apiKey: string;

  constructor(
    private readonly model: string,
    apiKey: string,
    private readonly post: HttpPost = fetchPost,
    private readonly baseUrl: string = GROQ_BASE_URL,
  ) {
    this.#apiKey = apiKey;
    this.label = `Groq · ${model}`;
  }

  /**
   * One retry for `tool_use_failed` (400): Groq rejects a tool call the model
   * generated malformed; a second sample usually succeeds. Nothing else is retried.
   */
  async converse(req: ModelRequest): Promise<ModelResponse> {
    try {
      return await this.once(req);
    } catch (err) {
      if (err instanceof ModelError && err.code === 'tool_use_failed' && !req.signal?.aborted)
        return this.once(req);
      throw err;
    }
  }

  private async once(req: ModelRequest): Promise<ModelResponse> {
    const res = await this.post(`${this.baseUrl}/chat/completions`, {
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(buildChatRequest(this.model, req)),
      ...(req.signal && { signal: req.signal }),
    });
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after'));
      throw new ModelRateLimitError(Number.isFinite(after) && after > 0 ? after : undefined);
    }
    if (res.status < 200 || res.status >= 300) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { code?: unknown; type?: unknown };
      };
      const code = body.error?.code ?? body.error?.type;
      throw new ModelError(
        res.status,
        typeof code === 'string' && /^[\w.-]{1,64}$/.test(code) ? code : undefined,
      );
    }
    return fromChatCompletion((await res.json()) as ChatCompletion);
  }

  /** Never serialize the key (e.g. a stray JSON.stringify of the runtime). */
  toJSON(): Record<string, string> {
    return { label: this.label };
  }
}
