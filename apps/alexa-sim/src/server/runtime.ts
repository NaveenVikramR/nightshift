/**
 * Process-wide singletons (single instance): sessions, limits, usage, model and
 * speech providers. Kept on globalThis so dev-mode module reloads don't drop
 * sessions.
 */
import 'server-only';
import { BedrockModel } from './agent/bedrock';
import type { AgentDeps } from './agent/loop';
import { ScriptedModel } from './agent/scripted';
import { config, type AlexaConfig } from './config';
import { DailyCap, RateLimiter, Usage } from './limits';
import { SessionStore } from './sessions';
import { BrowserSpeech, PollySpeech, type Speech } from './tts';

export interface Runtime {
  cfg: AlexaConfig;
  sessions: SessionStore;
  usage: Usage;
  agent: AgentDeps;
  speech: Speech;
  speechCap: DailyCap;
  loginLimiter: RateLimiter;
  demoLimiter: RateLimiter;
}

function build(): Runtime {
  const cfg = config();
  const usage = new Usage();
  const speechCap = new DailyCap(cfg.DAILY_SPEECH_REQUEST_CAP);
  if (cfg.MODEL_PROVIDER === 'bedrock' && !cfg.BEDROCK_MODEL_ID) {
    throw new Error('MODEL_PROVIDER=bedrock needs BEDROCK_MODEL_ID');
  }
  const model =
    cfg.MODEL_PROVIDER === 'bedrock'
      ? BedrockModel.fromRegion(cfg.BEDROCK_MODEL_ID!, cfg.AWS_REGION)
      : new ScriptedModel();
  return {
    cfg,
    sessions: new SessionStore(cfg.SESSION_IDLE_MINUTES * 60_000),
    usage,
    speechCap,
    speech:
      cfg.TTS_PROVIDER === 'polly'
        ? PollySpeech.fromRegion(cfg.AWS_REGION, speechCap, usage)
        : new BrowserSpeech(),
    agent: {
      model,
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
