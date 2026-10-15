import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { ConfigError } from './config.js';

const httpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//.test(u), 'must be an http(s) URL')
  .transform((u) => u.replace(/\/+$/, ''));

const endpoint = z.object({
  url: httpUrl,
  timeoutMs: z.number().int().min(100).max(60_000).default(5000),
});

const serviceSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, 'lowercase letters, digits, - and _'),
  displayName: z.string().min(1).max(40),
  aliases: z.array(z.string().min(1).max(40)).max(20).default([]),
  queries: z.object({
    errorRate: z.string().min(1),
    latencyP95: z.string().min(1),
    throughput: z.string().min(1),
    breakers: z.string().min(1).optional(),
  }),
  breakerLabel: z.string().min(1).default('provider'),
  thresholds: z
    .object({
      errorRate: z.number().min(0).max(1).default(0.05),
      latencyP95Seconds: z.number().positive().default(1),
    })
    .default({ errorRate: 0.05, latencyP95Seconds: 1 }),
});

const scanAssetSchema = z.object({
  name: z.string().min(1).max(64),
  url: httpUrl,
});

const serviceConfigSchema = z
  .object({
    prometheus: endpoint,
    alertmanager: endpoint,
    services: z.array(serviceSchema).min(1),
    scanAssets: z.array(scanAssetSchema).default([]),
  })
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.services.forEach((s, i) => {
      if (seen.has(s.name)) {
        ctx.addIssue({ code: 'custom', path: ['services', i, 'name'], message: 'duplicate name' });
      }
      seen.add(s.name);
    });
  });

export type ServiceConfig = z.infer<typeof serviceConfigSchema>;
export type ServiceDef = ServiceConfig['services'][number];

/** Validate a parsed config object, applying env URL overrides. */
export function parseServiceConfig(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ServiceConfig {
  const withOverrides = applyEnvOverrides(raw, env);
  const parsed = serviceConfigSchema.safeParse(withOverrides);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid service config:\n  ${problems.join('\n  ')}`);
  }
  return parsed.data;
}

/** Read and validate the YAML service catalog (NIGHTSHIFT_CONFIG, default config/nightshift.yaml). */
export function loadServiceConfig(
  path = process.env['NIGHTSHIFT_CONFIG'] || 'config/nightshift.yaml',
  env: NodeJS.ProcessEnv = process.env,
): ServiceConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(`Can't read service config at ${path} (set NIGHTSHIFT_CONFIG).`);
  }
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new ConfigError(
      `Service config ${path} is not valid YAML: ${err instanceof Error ? err.message : ''}`,
    );
  }
  return parseServiceConfig(raw, env);
}

function applyEnvOverrides(raw: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const out = { ...(raw as Record<string, unknown>) };
  const override = (key: 'prometheus' | 'alertmanager', value: string | undefined) => {
    if (!value) return;
    const current = typeof out[key] === 'object' && out[key] !== null ? out[key] : {};
    out[key] = { ...current, url: value };
  };
  override('prometheus', env['PROMETHEUS_URL']);
  override('alertmanager', env['ALERTMANAGER_URL']);
  return out;
}
