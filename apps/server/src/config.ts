import { z } from 'zod';

/** Treat empty env values ("FOO=") as unset so defaults apply. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema);

const csv = optional(z.string().default('')).transform((s) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
);

const origin = z.string().transform((value, ctx) => {
  try {
    const parsed = new URL(value).origin;
    if (parsed !== 'null') return parsed;
  } catch {
    // fall through
  }
  ctx.addIssue({ code: 'custom', message: `not a valid origin: ${value}` });
  return z.NEVER;
});

export const tokenEntrySchema = z.object({
  actor: z.string().min(1).max(64),
  role: z.enum(['viewer', 'responder']),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex chars'),
});
export type TokenEntry = z.infer<typeof tokenEntrySchema>;

const tokens = optional(z.string().default('[]'))
  .transform((s, ctx) => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be a JSON array' });
      return z.NEVER;
    }
  })
  .pipe(z.array(tokenEntrySchema));

const boolean = optional(z.enum(['true', 'false']).default('false')).transform((v) => v === 'true');

const envSchema = z.object({
  HOST: optional(z.string().min(1).default('127.0.0.1')),
  PORT: optional(z.coerce.number().int().min(1).max(65535).default(3000)),
  ALLOWED_ORIGINS: csv.pipe(z.array(origin)),
  ALLOWED_HOSTS: csv,
  TRUST_PROXY: boolean,
  MCP_MAX_BODY_BYTES: optional(
    z.coerce
      .number()
      .int()
      .min(1024)
      .max(10 * 1024 * 1024)
      .default(1024 * 1024),
  ),
  SESSION_IDLE_TTL_MINUTES: optional(
    z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .default(30),
  ),
  NIGHTSHIFT_TOKENS: tokens,
  AUTH_FAIL_LIMIT: optional(z.coerce.number().int().min(1).max(10_000).default(20)),
  AUTH_FAIL_WINDOW_MINUTES: optional(
    z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .default(10),
  ),
  DATABASE_URL: optional(z.string().min(1).optional()),
});

export interface Config {
  host: string;
  port: number;
  /** Exact origins (scheme://host[:port]) allowed to send an Origin header. */
  allowedOrigins: string[];
  /** Host header values accepted (DNS-rebinding protection). Empty = localhost set. */
  allowedHosts: string[];
  trustProxy: boolean;
  maxBodyBytes: number;
  sessionIdleTtlMs: number;
  tokens: TokenEntry[];
  authFailLimit: number;
  authFailWindowMs: number;
  databaseUrl: string | undefined;
}

export class ConfigError extends Error {}

/** Parse configuration from env. Error messages name variables, never their values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  const e = parsed.data;
  const actors = e.NIGHTSHIFT_TOKENS.map((t) => t.actor);
  if (new Set(actors).size !== actors.length) {
    throw new ConfigError('Invalid configuration:\n  NIGHTSHIFT_TOKENS: duplicate actor');
  }
  return {
    host: e.HOST,
    port: e.PORT,
    allowedOrigins: e.ALLOWED_ORIGINS,
    allowedHosts: e.ALLOWED_HOSTS,
    trustProxy: e.TRUST_PROXY,
    maxBodyBytes: e.MCP_MAX_BODY_BYTES,
    sessionIdleTtlMs: e.SESSION_IDLE_TTL_MINUTES * 60_000,
    tokens: e.NIGHTSHIFT_TOKENS,
    authFailLimit: e.AUTH_FAIL_LIMIT,
    authFailWindowMs: e.AUTH_FAIL_WINDOW_MINUTES * 60_000,
    databaseUrl: e.DATABASE_URL,
  };
}
