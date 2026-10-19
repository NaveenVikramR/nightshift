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

  MODEL_PROVIDER: opt(z.enum(['scripted', 'bedrock'])).transform((v) => v ?? 'scripted'),
  BEDROCK_MODEL_ID: opt(z.string().max(200)),
  AWS_REGION: opt(z.string().max(40)),
  TTS_PROVIDER: opt(z.enum(['browser', 'polly'])).transform((v) => v ?? 'browser'),

  MAX_TOOL_CALLS_PER_TURN: int(6),
  MAX_TURNS_PER_SESSION: int(40),
  RATE_LIMIT_REQUESTS: int(20),
  RATE_LIMIT_WINDOW_MINUTES: int(10),
  DAILY_MODEL_REQUEST_CAP: int(500),
  DAILY_SPEECH_REQUEST_CAP: int(1500),
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
  return EnvSchema.parse(env);
}

/** Process-wide config (parsed once). */
export function config(): AlexaConfig {
  cached ??= loadConfig();
  return cached;
}
