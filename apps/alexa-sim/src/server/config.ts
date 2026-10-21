import { z } from 'zod';

/** Empty strings count as unset (env files often have `KEY=`). */
const opt = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const int = (def: number) => opt(z.coerce.number().int().positive()).transform((v) => v ?? def);
const csv = opt(z.string()).transform((v) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const EnvSchema = z.object({
  NIGHTSHIFT_MCP_URL: opt(z.url()).transform((v) => v ?? 'http://127.0.0.1:3000/mcp'),
  /** Exact Origins allowed on POST routes, e.g. https://nightshift-demo.duckdns.org */
  ALLOWED_ORIGINS: csv,
  /** Host header values accepted (DNS-rebinding guard). Empty = localhost only. */
  ALLOWED_HOSTS: csv,
  SECURE_COOKIES: opt(z.enum(['true', 'false'])).transform((v) => v === 'true'),

  /**
   * The model, chosen by config only (required; never a fallback): "bedrock" (Converse,
   * e.g. Nova Lite) or "groq" (OpenAI-compatible tool calling). "scripted" = tests only.
   */
  ALEXA_MODEL_PROVIDER: z.enum(['bedrock', 'groq', 'scripted'], {
    error: 'ALEXA_MODEL_PROVIDER must be bedrock, groq or scripted',
  }),
  /** Server-side only; never logged or sent to the browser. */
  GROQ_API_KEY: opt(z.string().regex(/^[\w-]{20,200}$/)),
  GROQ_MODEL: opt(z.string().regex(/^[\w./:-]{3,100}$/)).transform(
    (v) => v ?? 'openai/gpt-oss-120b',
  ),
  ALLOW_SCRIPTED_MODEL: opt(z.enum(['true', 'false'])).transform((v) => v === 'true'),
  BEDROCK_MODEL_ID: opt(z.string().regex(/^[\w.:-]{3,200}$/)),
  AWS_REGION: opt(z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/)),
  /**
   * Bedrock guardrail (prompt-attack filter, via ApplyGuardrail): id + published version.
   * Checks the person's words and untrusted tool-result text with any model provider.
   */
  BEDROCK_GUARDRAIL_ID: opt(z.string().regex(/^[a-z0-9]{1,64}$/)),
  BEDROCK_GUARDRAIL_VERSION: opt(z.string().regex(/^\d{1,8}$/)),
  TTS_PROVIDER: opt(z.enum(['browser', 'polly'])).transform((v) => v ?? 'polly'),
  /** CloudWatch metrics (namespace Nightshift, 5 counts per turn). */
  CLOUDWATCH_METRICS: opt(z.enum(['true', 'false'])).transform((v) => v === 'true'),

  MAX_TOOL_CALLS_PER_TURN: int(6),
  MAX_TURNS_PER_SESSION: int(40),
  RATE_LIMIT_REQUESTS: int(20),
  RATE_LIMIT_WINDOW_MINUTES: int(10),
  DAILY_MODEL_REQUEST_CAP: int(100),
  DAILY_SPEECH_REQUEST_CAP: int(300),
  /** Polly characters per UTC day (40,000 neural characters ≈ $0.64). */
  DAILY_SPEECH_CHAR_CAP: int(40_000),
  MODEL_TIMEOUT_MS: int(20_000),
  MCP_TIMEOUT_MS: int(35_000),
  TURN_TIMEOUT_MS: int(60_000),
  SESSION_IDLE_MINUTES: int(30),

  /** Demo panel (responder only): demo-target admin API, called server-side only. */
  DEMO_ADMIN_URL: opt(z.url()),
  DEMO_ADMIN_TOKEN: opt(z.string().min(16)),
  /** For the bad_deploy scenario: report the deploy to Nightshift like CI does. */
  NIGHTSHIFT_DEPLOY_URL: opt(z.url()),
  NIGHTSHIFT_INGEST_TOKEN: opt(z.string().min(16)),
});

export type AlexaConfig = z.infer<typeof EnvSchema>;

let cached: AlexaConfig | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AlexaConfig {
  const cfg = EnvSchema.parse(env);
  const problems = providerProblems(cfg, env['NODE_ENV']);
  if (problems.length) throw new ConfigError(problems);
  return cfg;
}

/** Anything that needs AWS credentials. */
export const usesAws = (cfg: AlexaConfig): boolean =>
  cfg.ALEXA_MODEL_PROVIDER === 'bedrock' ||
  cfg.TTS_PROVIDER === 'polly' ||
  Boolean(cfg.BEDROCK_GUARDRAIL_ID) ||
  cfg.CLOUDWATCH_METRICS;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`alexa-sim config: ${problems.join('; ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * No silent fallback: the scripted model and browser speech run only when asked
 * for explicitly, and never in production. Bedrock needs a model id and region.
 */
export function providerProblems(cfg: AlexaConfig, nodeEnv: string | undefined): string[] {
  const prod = nodeEnv === 'production';
  const problems: string[] = [];
  if (cfg.ALEXA_MODEL_PROVIDER === 'scripted' && (prod || !cfg.ALLOW_SCRIPTED_MODEL))
    problems.push(
      prod
        ? 'ALEXA_MODEL_PROVIDER=scripted is not allowed in production; use bedrock or groq'
        : 'ALEXA_MODEL_PROVIDER=scripted needs ALLOW_SCRIPTED_MODEL=true (tests and local e2e only)',
    );
  if (cfg.TTS_PROVIDER === 'browser' && (prod || !cfg.ALLOW_SCRIPTED_MODEL))
    problems.push(
      prod
        ? 'TTS_PROVIDER=browser is not allowed in production; use polly'
        : 'TTS_PROVIDER=browser needs ALLOW_SCRIPTED_MODEL=true (tests and local e2e only)',
    );
  if (usesAws(cfg) && !cfg.AWS_REGION)
    problems.push('AWS_REGION is required for Bedrock, Guardrails, Polly and CloudWatch');
  if (cfg.ALEXA_MODEL_PROVIDER === 'bedrock' && !cfg.BEDROCK_MODEL_ID)
    problems.push('BEDROCK_MODEL_ID is required (e.g. amazon.nova-lite-v1:0)');
  if (cfg.ALEXA_MODEL_PROVIDER === 'groq' && !cfg.GROQ_API_KEY)
    problems.push('GROQ_API_KEY is required for ALEXA_MODEL_PROVIDER=groq');
  if (Boolean(cfg.BEDROCK_GUARDRAIL_ID) !== Boolean(cfg.BEDROCK_GUARDRAIL_VERSION))
    problems.push('set both BEDROCK_GUARDRAIL_ID and BEDROCK_GUARDRAIL_VERSION, or neither');
  return problems;
}

/** Process-wide config (parsed once). */
export function config(): AlexaConfig {
  cached ??= loadConfig();
  return cached;
}
