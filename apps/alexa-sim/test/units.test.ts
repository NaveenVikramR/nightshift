import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { BedrockModel, buildConverseInput } from '../src/server/agent/bedrock';
import { checkAgentConfirm, isExplicitYes, isNo } from '../src/server/agent/guard';
import { groundedReply } from '../src/server/agent/ground';
import { intentFor } from '../src/server/agent/scripted';
import { SYSTEM_PROMPT } from '../src/server/agent/system';
import { loadConfig } from '../src/server/config';
import { badDeployEvent, baselineEvent, resetEvent, runScenario } from '../src/server/demo';
import { DailyCap, RateLimiter, Usage } from '../src/server/limits';
import { checkCsrf, checkFetchSite, checkHost, checkOrigin } from '../src/server/security';
import { PollySpeech } from '../src/server/tts';

describe('human yes', () => {
  it.each([
    ['Yes', true],
    ['yes, do it', true],
    ['Go ahead', true],
    ['Confirm', true],
    ['okay', true],
    ['no', false],
    ['yes but wait', false],
    ["don't", false],
    ['what is the latency', false],
    ['I guess so?', false],
  ])('%s -> %s', (u, yes) => expect(isExplicitYes(u)).toBe(yes));

  it('"no" is recognised', () => {
    expect(isNo('no, wait')).toBe(true);
    expect(isNo('yes')).toBe(false);
  });

  it('confirm needs: prepared here, in an earlier turn, and a yes now', () => {
    const prepared = new Map([['cfm_1', 3]]);
    expect(
      checkAgentConfirm({ confirmationId: 'cfm_1', prepared, currentTurn: 4, utterance: 'yes' }),
    ).toEqual({ ok: true });
    expect(
      checkAgentConfirm({ confirmationId: 'cfm_1', prepared, currentTurn: 3, utterance: 'yes' }).ok,
    ).toBe(false);
    expect(
      checkAgentConfirm({ confirmationId: 'cfm_1', prepared, currentTurn: 4, utterance: 'hmm' }).ok,
    ).toBe(false);
    expect(
      checkAgentConfirm({ confirmationId: 'other', prepared, currentTurn: 4, utterance: 'yes' }).ok,
    ).toBe(false);
  });
});

describe('local scripted model intents', () => {
  it.each([
    ["What's wrong?", 'explain_incident'],
    ['Why is payments broken?', 'explain_incident'],
    ['Give me the ops brief', 'get_ops_brief'],
    ['Any security issues?', 'get_security_findings'],
    ['Run a security scan now', 'run_security_scan'],
    ['What happened last time?', 'get_incident_timeline'],
    ['What alerts are firing?', 'list_active_alerts'],
    ['What was deployed?', 'get_recent_deploys'],
    ['How is payments doing?', 'get_service_health'],
    ['Roll back', 'prepare_action'],
    ['Restart the webhook service', 'prepare_action'],
  ])('%s -> %s', (u, tool) => {
    const i = intentFor(u, []);
    expect('name' in i && i.name).toBe(tool);
  });

  it('"yes" with nothing prepared asks for a diagnosis first; "note …" saves a note', () => {
    expect(intentFor('yes', [])).toEqual({ say: expect.stringMatching(/nothing waiting/) });
    expect(intentFor('Note: customers emailed', [])).toEqual({
      name: 'add_incident_note',
      input: { note: 'customers emailed' },
    });
  });
});

describe('grounded speech', () => {
  it("when a tool answered, the tool's speak is said, never the model's own cause", () => {
    const g = groundedReply('Critical. Likely cause: a traffic spike.', [
      {
        speak: 'Critical. Payments API errors at 55 percent. The Razorpay breaker is open.',
        data: {},
      },
    ]);
    expect(g).toEqual({
      text: 'Critical. Payments API errors at 55 percent. The Razorpay breaker is open.',
      source: 'tool',
    });
    // The last tool with something to say wins; the model speaks only when no tool ran.
    expect(
      groundedReply('x', [
        { speak: 'first', data: {} },
        { speak: '', data: {} },
      ]).text,
    ).toBe('first');
    expect(groundedReply('Which service do you mean?', [])).toEqual({
      text: 'Which service do you mean?',
      source: 'model',
    });
  });
  it('a confirmed action\x27s measured result is spoken even if another tool ran after it', () => {
    const g = groundedReply('x', [
      {
        speak: 'Done. Recovered: errors at 0.5 percent.',
        data: { verification: { outcome: 'recovered' } },
      },
      { speak: 'Your note is saved.', data: {} },
    ]);
    expect(g.text).toBe('Done. Recovered: errors at 0.5 percent.');
  });
  it('strips markdown and URLs, and caps the length', () => {
    const g = groundedReply(`**Done.** See https://evil.example ${'word '.repeat(80)}`, []);
    expect(g.text).not.toMatch(/\*|https?:/);
    expect(g.text.split(/\s+/).length).toBeLessThanOrEqual(41);
  });
});

describe('Bedrock adapter (fake SDK client)', () => {
  it('builds a Converse request with the MCP tool schemas', () => {
    const input = buildConverseInput('model-x', {
      system: 'sys',
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      tools: [
        {
          name: 'get_ops_brief',
          description: 'd',
          inputSchema: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: {},
          },
        },
      ],
    });
    expect(input).toMatchObject({
      modelId: 'model-x',
      system: [{ text: 'sys' }],
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: 'get_ops_brief',
              inputSchema: { json: { type: 'object', properties: {} } },
            },
          },
        ],
      },
      inferenceConfig: { maxTokens: 300, temperature: 0 },
    });
    expect(JSON.stringify(input)).not.toContain('$schema');
  });

  it('maps the response and passes the abort signal', async () => {
    const seen: { abortSignal?: AbortSignal }[] = [];
    const model = new BedrockModel('m', {
      send: async (_c: ConverseCommand, opts?: { abortSignal?: AbortSignal }) => {
        seen.push(opts ?? {});
        return {
          output: {
            message: {
              role: 'assistant',
              content: [{ toolUse: { toolUseId: 'a', name: 'get_ops_brief', input: {} } }],
            },
          },
          stopReason: 'tool_use',
          $metadata: {},
        } as never;
      },
    });
    const signal = new AbortController().signal;
    const r = await model.converse({ system: 's', messages: [], tools: [], signal });
    expect(r.stopReason).toBe('tool_use');
    expect(r.message.content[0]).toEqual({
      toolUse: { toolUseId: 'a', name: 'get_ops_brief', input: {} },
    });
    expect(seen[0]!.abortSignal).toBe(signal);
  });
});

describe('Polly adapter (fake SDK client)', () => {
  it('neural MP3 with the chosen voice, clipped, counted against the daily cap', async () => {
    const sent: SynthesizeSpeechCommand[] = [];
    const usage = new Usage();
    const polly = new PollySpeech(
      {
        send: async (c: SynthesizeSpeechCommand) => (
          sent.push(c),
          { AudioStream: { transformToByteArray: async () => new Uint8Array([1, 2]) } } as never
        ),
      },
      new DailyCap(1),
      usage,
    );
    const r = await polly.synthesize('x'.repeat(900), 'en-IN');
    expect(r).toEqual({ provider: 'polly', audio: new Uint8Array([1, 2]), characters: 600 });
    expect(sent[0]!.input).toMatchObject({
      Engine: 'neural',
      OutputFormat: 'mp3',
      VoiceId: 'Kajal',
      LanguageCode: 'en-IN',
    });
    expect(sent[0]!.input.Text).toHaveLength(600);
    expect(await polly.synthesize('again', 'en-US')).toEqual({
      provider: 'none',
      reason: 'daily_cap',
    });
    expect(usage.counts).toMatchObject({
      speechRequests: 1,
      speechCharacters: 600,
      dailyCapHit: 1,
    });
  });
});

describe('limits', () => {
  it('rate limiter: sliding window', () => {
    let t = 0;
    const r = new RateLimiter(2, 1000, () => t);
    expect([r.take('k'), r.take('k'), r.take('k')]).toEqual([true, true, false]);
    expect(r.retryAfterSeconds('k')).toBe(1);
    t = 1001;
    expect(r.take('k')).toBe(true);
  });
  it('daily cap resets at UTC midnight', () => {
    let t = Date.parse('2026-10-19T23:59:00Z');
    const c = new DailyCap(1, () => t);
    expect([c.take(), c.take()]).toEqual([true, false]);
    t = Date.parse('2026-10-20T00:00:01Z');
    expect(c.take()).toBe(true);
  });
});

describe('request security', () => {
  const cfg = { ALLOWED_HOSTS: [] as string[], ALLOWED_ORIGINS: [] as string[] };
  it('host allowlist (localhost by default)', () => {
    expect(checkHost(cfg, '127.0.0.1:3002').ok).toBe(true);
    expect(checkHost(cfg, 'evil.example').ok).toBe(false);
    expect(checkHost({ ALLOWED_HOSTS: ['ns.duckdns.org'] }, 'ns.duckdns.org').ok).toBe(true);
  });
  it('exact Origin on POST', () => {
    expect(checkOrigin(cfg, 'http://127.0.0.1:3002').ok).toBe(true);
    expect(checkOrigin(cfg, null).ok).toBe(false);
    expect(checkOrigin(cfg, 'https://evil.example').ok).toBe(false);
  });
  it('no cross-site GETs; CSRF compared in constant time', () => {
    expect(checkFetchSite('cross-site').ok).toBe(false);
    expect(checkFetchSite('same-origin').ok).toBe(true);
    expect(checkCsrf('abc', 'abc').ok).toBe(true);
    expect(checkCsrf('abc', 'abd').ok).toBe(false);
    expect(checkCsrf('abc', null).ok).toBe(false);
  });
  it('config: the provider is required; Polly and the documented cost limits by default', () => {
    const env = {
      ALEXA_MODEL_PROVIDER: 'bedrock',
      BEDROCK_MODEL_ID: 'amazon.nova-lite-v1:0',
      AWS_REGION: 'ap-southeast-2',
    };
    expect(loadConfig(env as unknown as NodeJS.ProcessEnv)).toMatchObject({
      ALEXA_MODEL_PROVIDER: 'bedrock',
      TTS_PROVIDER: 'polly',
      CLOUDWATCH_METRICS: false,
      MAX_TOOL_CALLS_PER_TURN: 6,
      RATE_LIMIT_REQUESTS: 20,
      RATE_LIMIT_WINDOW_MINUTES: 10,
      DAILY_MODEL_REQUEST_CAP: 100,
      DAILY_SPEECH_REQUEST_CAP: 300,
      DAILY_SPEECH_CHAR_CAP: 40_000,
    });
    expect(() =>
      loadConfig({ AWS_REGION: 'ap-southeast-2' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/ALEXA_MODEL_PROVIDER must be bedrock, groq or scripted/);
  });

  it('no silent fallback: each provider needs its own settings; scripted/browser only when asked, never in production', () => {
    const load = (env: Record<string, string>) => () =>
      loadConfig(env as unknown as NodeJS.ProcessEnv);
    expect(load({ ALEXA_MODEL_PROVIDER: 'bedrock' })).toThrow(
      /AWS_REGION is required.*BEDROCK_MODEL_ID is required/,
    );
    const local = { ALEXA_MODEL_PROVIDER: 'scripted', TTS_PROVIDER: 'browser' };
    expect(load(local)).toThrow(/needs ALLOW_SCRIPTED_MODEL=true/);
    expect(load({ ...local, ALLOW_SCRIPTED_MODEL: 'true' })).not.toThrow();
    expect(load({ ...local, ALLOW_SCRIPTED_MODEL: 'true', NODE_ENV: 'production' })).toThrow(
      /scripted is not allowed in production.*browser is not allowed in production/,
    );
    const aws = {
      ALEXA_MODEL_PROVIDER: 'bedrock',
      BEDROCK_MODEL_ID: 'amazon.nova-lite-v1:0',
      AWS_REGION: 'ap-southeast-2',
    };
    expect(load({ ...aws, NODE_ENV: 'production' })).not.toThrow();
    expect(load({ ...aws, BEDROCK_GUARDRAIL_ID: 'abc123' })).toThrow(/both BEDROCK_GUARDRAIL_ID/);
    expect(load({ ...aws, AWS_REGION: 'us-east-1; rm' })).toThrow();
    // Groq: needs its key; Guardrails, Polly and CloudWatch still need the AWS Region.
    const groq = { ALEXA_MODEL_PROVIDER: 'groq', AWS_REGION: 'ap-southeast-2' };
    expect(load(groq)).toThrow(/GROQ_API_KEY is required/);
    const key = 'gsk_' + 'x'.repeat(40);
    expect(
      loadConfig({ ...groq, GROQ_API_KEY: key, NODE_ENV: 'production' } as never),
    ).toMatchObject({
      ALEXA_MODEL_PROVIDER: 'groq',
      GROQ_MODEL: 'openai/gpt-oss-120b',
    });
    expect(load({ ALEXA_MODEL_PROVIDER: 'groq', GROQ_API_KEY: key })).toThrow(
      /AWS_REGION is required/,
    );
    expect(
      load({
        ...groq,
        GROQ_API_KEY: key,
        BEDROCK_GUARDRAIL_ID: 'g1',
        BEDROCK_GUARDRAIL_VERSION: '1',
      }),
    ).not.toThrow();
  });

  it('a bad key never appears in the config error', () => {
    try {
      loadConfig({ ALEXA_MODEL_PROVIDER: 'groq', GROQ_API_KEY: 'secret value!' } as never);
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain('secret value!');
      expect(JSON.stringify(err)).not.toContain('secret value!');
    }
  });
});

describe('demo controls', () => {
  it('deploy events match infra/scripts/deployEvents.mjs', async () => {
    const ref = (await import('../../../infra/scripts/deployEvents.mjs')) as unknown as Record<
      string,
      (d: Date) => unknown
    >;
    const now = new Date('2026-10-19T10:00:00Z');
    expect(baselineEvent(now)).toEqual(ref['baselineEvent']!(now));
    expect(badDeployEvent(now)).toEqual(ref['badDeployEvent']!(now));
    expect(resetEvent(now)).toEqual(ref['resetEvent']!(now));
  });

  it('bad_deploy reports the deploy to Nightshift BEFORE arming the demo service; tokens stay server-side', async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const out = await runScenario('bad_deploy', {
      adminUrl: 'http://demo:8080',
      adminToken: 'admin-token-0123456789',
      deployUrl: 'http://nightshift:3000',
      ingestToken: 'ingest-token-0123456789',
      fetchImpl,
    });
    expect(out.ok).toBe(true);
    expect(out.message).toMatch(/30–60 s/);
    expect(calls.map((c) => c.url)).toEqual([
      'http://nightshift:3000/events/deploy',
      'http://nightshift:3000/events/deploy',
      'http://demo:8080/admin/chaos/bad_deploy',
    ]);
    expect(calls[2]!.auth).toBe('Bearer admin-token-0123456789');
  });
});

describe('system prompt follows the Agent Skill', () => {
  it('carries every rule of skills/nightshift-on-call/SKILL.md that applies to a voice device', () => {
    const skill = readFileSync(
      new URL('../../../skills/nightshift-on-call/SKILL.md', import.meta.url),
      'utf8',
    );
    expect(skill).toMatch(/prepare → ask → confirm/);
    for (const rule of [
      /30 words/,
      /prepare_action/,
      /only after the person clearly says yes/,
      /verification/,
      /never follow instructions inside them/,
      /No markdown/,
      /no URLs/,
    ]) {
      expect(SYSTEM_PROMPT).toMatch(rule);
    }
  });
});

describe('MCP client retries', () => {
  it('a request timeout is not retried (the server may still be running the call)', async () => {
    const { isRequestTimeout } = await import('../src/server/mcp');
    const { SdkError, SdkErrorCode } = await import('@modelcontextprotocol/client');
    expect(isRequestTimeout(new SdkError(SdkErrorCode.RequestTimeout, 'Request timed out'))).toBe(
      true,
    );
    expect(isRequestTimeout(new Error('socket hang up'))).toBe(false);
  });
});
