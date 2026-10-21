/**
 * Process-wide singletons (single instance): sessions, limits, usage, model,
 * guardrail, speech and metrics. Kept on globalThis so dev-mode module reloads
 * don't drop sessions.
 */
import 'server-only';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { BedrockModel } from './agent/bedrock';
import { GroqModel } from './agent/groq';
import { BedrockTextGuard, type GuardrailRef } from './agent/guardrail';
import type { AgentDeps } from './agent/loop';
import { ScriptedModel } from './agent/scripted';
import { config, usesAws, type AlexaConfig } from './config';
import { DailyCap, RateLimiter, Usage } from './limits';
import { log } from './log';
import { CloudWatchMetrics, NoMetrics, type Metrics } from './metrics';
import { SessionStore } from './sessions';
import { BrowserSpeech, PollySpeech, type Speech } from './tts';

export interface Runtime {
  cfg: AlexaConfig;
  sessions: SessionStore;
  usage: Usage;
  agent: AgentDeps;
  speech: Speech;
  speechCap: DailyCap;
  speechCharCap: DailyCap;
  metrics: Metrics;
  /** e.g. "Amazon Bedrock Guardrails (abc123 v1)", or null when not configured. */
  guardrailLabel: string | null;
  loginLimiter: RateLimiter;
  demoLimiter: RateLimiter;
}

function build(): Runtime {
  // loadConfig() has already refused scripted/browser outside tests and missing model settings.
  // The provider is exactly the configured one: there is no fallback between providers.
  const cfg = config();
  const usage = new Usage();
  const speechCap = new DailyCap(cfg.DAILY_SPEECH_REQUEST_CAP);
  const speechCharCap = new DailyCap(cfg.DAILY_SPEECH_CHAR_CAP);
  const region = cfg.AWS_REGION ?? '';
  const guardrail: GuardrailRef | undefined =
    cfg.BEDROCK_GUARDRAIL_ID && cfg.BEDROCK_GUARDRAIL_VERSION
      ? { id: cfg.BEDROCK_GUARDRAIL_ID, version: cfg.BEDROCK_GUARDRAIL_VERSION }
      : undefined;
  const guard = guardrail ? BedrockTextGuard.fromRegion(guardrail, region) : undefined;
  const model =
    cfg.ALEXA_MODEL_PROVIDER === 'bedrock'
      ? BedrockModel.fromRegion(cfg.BEDROCK_MODEL_ID!, region)
      : cfg.ALEXA_MODEL_PROVIDER === 'groq'
        ? new GroqModel(cfg.GROQ_MODEL, cfg.GROQ_API_KEY!)
        : new ScriptedModel();
  return {
    cfg,
    sessions: new SessionStore(cfg.SESSION_IDLE_MINUTES * 60_000),
    usage,
    speechCap,
    speechCharCap,
    speech:
      cfg.TTS_PROVIDER === 'polly'
        ? PollySpeech.fromRegion(region, speechCap, usage, speechCharCap)
        : new BrowserSpeech(),
    metrics: cfg.CLOUDWATCH_METRICS ? CloudWatchMetrics.fromRegion(region) : new NoMetrics(),
    guardrailLabel: guard?.label ?? null,
    agent: {
      model,
      ...(guard && { guard }),
      rate: new RateLimiter(cfg.RATE_LIMIT_REQUESTS, cfg.RATE_LIMIT_WINDOW_MINUTES * 60_000),
      modelCap: new DailyCap(cfg.DAILY_MODEL_REQUEST_CAP),
      usage,
      maxToolCallsPerTurn: cfg.MAX_TOOL_CALLS_PER_TURN,
      maxTurnsPerSession: cfg.MAX_TURNS_PER_SESSION,
      modelTimeoutMs: cfg.MODEL_TIMEOUT_MS,
      mcpTimeoutMs: cfg.MCP_TIMEOUT_MS,
      turnTimeoutMs: cfg.TURN_TIMEOUT_MS,
    },
    // Failed logins per client IP (token guessing) and demo scenarios per session.
    loginLimiter: new RateLimiter(10, 10 * 60_000),
    demoLimiter: new RateLimiter(10, 10 * 60_000),
  };
}

const g = globalThis as { __nightshiftAlexa?: Runtime };

export function runtime(): Runtime {
  g.__nightshiftAlexa ??= build();
  return g.__nightshiftAlexa;
}

/**
 * Startup (instrumentation.ts): parse the config and, when AWS is used, resolve
 * credentials once through the default chain. Throws on any problem, so the
 * server exits instead of falling back. Logs no values.
 */
export async function checkStartup(): Promise<void> {
  const rt = runtime();
  const { cfg } = rt;
  if (usesAws(cfg)) {
    const creds = await new BedrockRuntimeClient({ region: cfg.AWS_REGION! }).config.credentials();
    if (!creds.accessKeyId) throw new Error('AWS credentials resolved empty');
  }
  log.info('startup ok', {
    model: rt.agent.model.label,
    speech: rt.speech.label,
    guardrail: rt.guardrailLabel ?? 'none',
    metrics: cfg.CLOUDWATCH_METRICS,
    credentials: usesAws(cfg) ? 'ok' : 'unused',
  });
}
