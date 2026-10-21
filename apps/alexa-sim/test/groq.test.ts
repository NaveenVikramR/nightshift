import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildChatRequest,
  fromChatCompletion,
  GroqModel,
  toChatMessages,
  type HttpPost,
} from '../src/server/agent/groq';
import { runTurn } from '../src/server/agent/loop';
import { historyIsValid, makeDeps, makeSession, TOOLS } from './fakes';

const KEY = 'gsk_' + 'k'.repeat(48);

type Reply =
  | { tool: string; args?: Record<string, unknown> }
  | { text: string }
  | { status: number; retryAfter?: string };

/** A fake Groq endpoint: replays replies, records each request body (parsed). */
function fakeGroq(replies: Reply[]) {
  const requests: Record<string, unknown>[] = [];
  const auth: string[] = [];
  let n = 0;
  const post: HttpPost = async (_url, init) => {
    requests.push(JSON.parse(init.body) as Record<string, unknown>);
    auth.push(init.headers['authorization'] ?? '');
    const r = replies.shift();
    if (!r) throw new Error('no more replies');
    if ('status' in r)
      return {
        status: r.status,
        headers: { get: (h: string) => (h === 'retry-after' ? (r.retryAfter ?? null) : null) },
        json: async () => ({ error: { message: 'rate limit reached' } }),
      };
    const message =
      'tool' in r
        ? {
            content: null,
            tool_calls: [
              {
                id: `call_${++n}`,
                type: 'function',
                function: { name: r.tool, arguments: JSON.stringify(r.args ?? {}) },
              },
            ],
          }
        : { content: r.text };
    return {
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        choices: [{ finish_reason: 'tool' in r ? 'tool_calls' : 'stop', message }],
        usage: { prompt_tokens: 1000, completion_tokens: 40 },
      }),
    };
  };
  return { post, requests, auth };
}

afterEach(() => vi.restoreAllMocks());

describe('Groq provider (fake HTTP client)', () => {
  it('sends trimmed tools in OpenAI format and runs the tool the model picks', async () => {
    const groq = fakeGroq([
      { tool: 'explain_incident', args: { service: 'payments' } },
      { text: 'Critical. Payments API errors at 45 percent.' },
    ]);
    const model = new GroqModel('openai/gpt-oss-120b', KEY, groq.post);
    const { session, mcp } = makeSession();
    const turn = await runTurn(makeDeps(model), session, "What's wrong?");

    expect(model.label).toBe('Groq · openai/gpt-oss-120b');
    expect(groq.auth[0]).toBe(`Bearer ${KEY}`);
    const first = groq.requests[0]!;
    expect(first).toMatchObject({
      model: 'openai/gpt-oss-120b',
      tool_choice: 'auto',
      parallel_tool_calls: false,
      temperature: 0,
      reasoning_effort: 'low',
    });
    const tools = first['tools'] as { type: string; function: { name: string } }[];
    expect(tools.every((t) => t.type === 'function')).toBe(true);
    expect(tools.map((t) => t.function.name)).toEqual(
      TOOLS.map((t) => t.name).filter((n) => n !== 'confirm_action'),
    );
    expect(mcp.calls).toEqual([{ name: 'explain_incident', args: { service: 'payments' } }]);
    // The second request carries the assistant tool call and the tool result.
    const msgs = groq.requests[1]!['messages'] as Record<string, unknown>[];
    expect(msgs.map((m) => m['role'])).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(msgs[3]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_1',
      name: 'explain_incident',
    });
    expect(turn.reply).toBe(
      'Critical. Payments API errors at 45 percent for 4 minutes. The Razorpay breaker is open. I can fail over to Stripe.',
    );
    expect(turn.stats).toMatchObject({ modelCalls: 2, inputTokens: 2000, outputTokens: 80 });
    expect(turn.trace.at(-1)!.note).toMatch(/^Groq · openai\/gpt-oss-120b: 2 calls/);
    expect(historyIsValid(session.history)).toBe(true);
  });

  it('human-yes rule holds with Groq: confirm in the prepare turn is refused, "yes" next turn executes', async () => {
    const groq = fakeGroq([
      { tool: 'prepare_action', args: { suggested_action: { action: 'failover_provider' } } },
      { tool: 'confirm_action', args: { confirmation_id: 'cfm_abcdef123456' } },
      { text: 'This will route payments to Stripe. Shall I go ahead?' },
      { tool: 'confirm_action', args: { confirmation_id: 'cfm_abcdef123456' } },
      { text: 'Done. Payments API now uses Stripe. Recovered: errors at 0.5 percent.' },
    ]);
    const model = new GroqModel('openai/gpt-oss-120b', KEY, groq.post);
    const deps = makeDeps(model);
    const { session, mcp } = makeSession();

    const t1 = await runTurn(deps, session, 'Fail over to Stripe');
    expect(mcp.calls.map((c) => c.name)).toEqual(['prepare_action']);
    expect(t1.trace.map((t) => [t.tool, t.outcome])).toContainEqual(['confirm_action', 'refused']);

    // Turn 2 offers confirm_action (a confirmation is pending) and the person said yes.
    const t2 = await runTurn(deps, session, 'Yes, go ahead');
    const offered = (groq.requests[3]!['tools'] as { function: { name: string } }[]).map(
      (t) => t.function.name,
    );
    expect(offered).toContain('confirm_action');
    expect(mcp.calls.map((c) => c.name)).toEqual(['prepare_action', 'confirm_action']);
    expect(t2.trace.map((t) => t.confirmation?.step).filter(Boolean)).toEqual([
      'human_yes',
      'confirmed',
    ]);
    expect(historyIsValid(session.history)).toBe(true);
  });

  it('refuses confirm when the person did not say yes, even if Groq calls it', async () => {
    const groq = fakeGroq([
      { tool: 'prepare_action', args: {} },
      { text: 'Shall I go ahead?' },
      { tool: 'confirm_action', args: { confirmation_id: 'cfm_abcdef123456' } },
      { text: 'Okay.' },
    ]);
    const deps = makeDeps(new GroqModel('openai/gpt-oss-120b', KEY, groq.post));
    const { session, mcp } = makeSession();
    await runTurn(deps, session, 'Fail over');
    await runTurn(deps, session, "what's the latency?");
    expect(mcp.calls.map((c) => c.name)).toEqual(['prepare_action']);
  });

  it('429: a short spoken message, counted; the key is never logged', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation(
      (...a: unknown[]) => void lines.push(a.join(' ')),
    );
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => (lines.push(String(s)), true));
    const groq = fakeGroq([{ status: 429, retryAfter: '7' }]);
    const deps = makeDeps(new GroqModel('openai/gpt-oss-120b', KEY, groq.post));
    const { session, mcp } = makeSession();
    const turn = await runTurn(deps, session, "What's wrong?");
    expect(turn.reply).toBe('The model is busy right now. Try again in a minute.');
    expect(turn.replySource).toBe('guard');
    expect(mcp.calls).toEqual([]);
    expect(deps.usage.counts).toMatchObject({ modelRateLimited: 1, modelErrors: 1 });
    expect(historyIsValid(session.history)).toBe(true);
    expect(lines.join('\n')).toContain('ModelRateLimitError');
    expect(lines.join('\n')).not.toContain(KEY);
  });

  it('other HTTP errors carry the status only (no body, no key)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const groq = fakeGroq([{ status: 400 }]);
    const model = new GroqModel('openai/gpt-oss-120b', KEY, groq.post);
    const err = await model.converse({ system: 's', messages: [], tools: [] }).catch((e) => e);
    expect(err).toMatchObject({ name: 'ModelError', status: 400 });
    expect(String(err)).not.toContain(KEY);
    expect(JSON.stringify(model)).not.toContain(KEY);
  });

  it('maps history and responses both ways (card calls, bad JSON arguments)', () => {
    const msgs = toChatMessages('sys', [
      { role: 'user', content: [{ text: '(I pressed a button on the prepare action card.)' }] },
      {
        role: 'assistant',
        content: [{ toolUse: { toolUseId: 'card-1', name: 'prepare_action', input: {} } }],
      },
      {
        role: 'user',
        content: [{ toolResult: { toolUseId: 'card-1', content: [{ json: { speak: 'ok' } }] } }],
      },
      { role: 'assistant', content: [{ text: 'ok' }] },
    ]);
    expect(msgs).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '(I pressed a button on the prepare action card.)' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'card-1', type: 'function', function: { name: 'prepare_action', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'card-1', name: 'prepare_action', content: '{"speak":"ok"}' },
      { role: 'assistant', content: 'ok' },
    ]);
    const r = fromChatCompletion({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: '',
            tool_calls: [{ id: 'c1', function: { name: 'get_ops_brief', arguments: '{oops' } }],
          },
        },
      ],
    });
    expect(r).toMatchObject({
      stopReason: 'tool_use',
      message: { content: [{ toolUse: { toolUseId: 'c1', name: 'get_ops_brief', input: {} } }] },
    });
    expect(
      buildChatRequest('llama-3.3-70b-versatile', { system: 's', messages: [], tools: [] }),
    ).not.toHaveProperty('reasoning_effort');
  });
});

describe('Groq tool_use_failed', () => {
  it('retries once, then gives up with the error', async () => {
    let n = 0;
    const post: HttpPost = async () => {
      n++;
      return n === 1
        ? {
            status: 400,
            headers: { get: () => null },
            json: async () => ({ error: { code: 'tool_use_failed' } }),
          }
        : {
            status: 200,
            headers: { get: () => null },
            json: async () => ({
              choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
            }),
          };
    };
    const r = await new GroqModel('openai/gpt-oss-120b', KEY, post).converse({
      system: 's',
      messages: [],
      tools: [],
    });
    expect(n).toBe(2);
    expect(r.message.content).toEqual([{ text: 'ok' }]);

    let m = 0;
    const always: HttpPost = async () => (
      m++,
      {
        status: 400,
        headers: { get: () => null },
        json: async () => ({ error: { code: 'tool_use_failed' } }),
      }
    );
    const err = await new GroqModel('openai/gpt-oss-120b', KEY, always)
      .converse({ system: 's', messages: [], tools: [] })
      .catch((e) => e);
    expect(m).toBe(2);
    expect(err).toMatchObject({ name: 'ModelError', status: 400, code: 'tool_use_failed' });
  });
});

describe('a late model failure after a tool answered', () => {
  it('speaks the grounded tool result (the action happened), not an error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const groq = fakeGroq([{ tool: 'get_ops_brief' }, { status: 500 }]);
    const deps = makeDeps(new GroqModel('openai/gpt-oss-120b', KEY, groq.post));
    const { session } = makeSession();
    const turn = await runTurn(deps, session, 'How is everything?');
    expect(turn.reply).toBe('Critical: payments API errors at 45 percent.');
    expect(turn.replySource).toBe('tool');
    expect(historyIsValid(session.history)).toBe(true);
  });
});
