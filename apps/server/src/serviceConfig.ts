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

const DEFAULT_THRESHOLDS = {
  errorRate: 0.05,
  latencyP95Seconds: 1,
  authFailuresPerSecond: 2,
  webhookFailuresPerSecond: 0.5,
};

/** Where a service's deploy history comes from. Omitted = no deploy source. */
const deploySourceSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('ingest'),
    environment: z.string().min(1).max(40).default('production'),
  }),
  z.object({
    source: z.literal('github'),
    environment: z.string().min(1).max(40).default('production'),
    repo: z.string().regex(/^[\w.-]{1,100}\/[\w.-]{1,100}$/, 'must be owner/name'),
  }),
]);

const executorName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, 'lowercase letters, digits, - and _');

const serviceSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, 'lowercase letters, digits, - and _'),
  displayName: z.string().min(1).max(40),
  aliases: z.array(z.string().min(1).max(40)).max(20).default([]),
  queries: z.object({
    errorRate: z.string().min(1),
    latencyP95: z.string().min(1),
    throughput: z.string().min(1),
    breakers: z.string().min(1).optional(),
    /** Failed logins per second (security signal). */
    authFailures: z.string().min(1).optional(),
    /** Webhooks rejected for a bad signature, per second (security signal). */
    webhookFailures: z.string().min(1).optional(),
    /** Series with value 1 for the provider receiving traffic (label `breakerLabel`). */
    activeProvider: z.string().min(1).optional(),
    /**
     * Short-window error ratio (e.g. rate[15s]) read right before and after an action.
     * A 1-minute rate can't show a recovery within confirm_action's ~20 s check.
     * Defaults to errorRate.
     */
    verifyErrorRate: z.string().min(1).optional(),
  }),
  breakerLabel: z.string().min(1).default('provider'),
  thresholds: z
    .object({
      errorRate: z.number().min(0).max(1).default(DEFAULT_THRESHOLDS.errorRate),
      latencyP95Seconds: z.number().positive().default(DEFAULT_THRESHOLDS.latencyP95Seconds),
      authFailuresPerSecond: z
        .number()
        .positive()
        .default(DEFAULT_THRESHOLDS.authFailuresPerSecond),
      webhookFailuresPerSecond: z
        .number()
        .positive()
        .default(DEFAULT_THRESHOLDS.webhookFailuresPerSecond),
    })
    .default(DEFAULT_THRESHOLDS),
  deploys: deploySourceSchema.optional(),
  /** Remediations allowed for this service and who performs them. Anything absent is refused. */
  actions: z
    .object({
      failover_provider: z
        .object({ executor: executorName, providers: z.array(z.string().min(1).max(64)).min(2) })
        .optional(),
      rollback_deploy: z.object({ executor: executorName }).optional(),
      restart_service: z.object({ executor: executorName }).optional(),
    })
    .strict()
    .default({}),
});

const envVarName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'an env var name, e.g. DEMO_ADMIN_TOKEN');
const timeoutMs = z.number().int().min(100).max(60_000);

/** Who can perform actions. Secrets are only referenced by env var name. */
const executorSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('admin_api'),
    url: httpUrl,
    tokenEnv: envVarName,
    timeoutMs: timeoutMs.default(5000),
  }),
  z.object({
    type: z.literal('github_workflow'),
    repo: z.string().regex(/^[\w.-]{1,100}\/[\w.-]{1,100}$/, 'must be owner/name'),
    workflow: z.string().regex(/^[\w.-]{1,100}$/, 'a workflow file name or id'),
    ref: z.string().min(1).max(100).default('main'),
    tokenEnv: envVarName,
    timeoutMs: timeoutMs.default(8000),
  }),
]);

const timeZone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'unknown IANA time zone');

/**
 * What run_security_scan may touch. Nothing outside these lists is ever scanned
 * (invariant 3): no discovery, no port scanning.
 */
const securitySchema = z
  .object({
    /** URLs whose response headers are checked (one GET each). */
    headers: z
      .array(z.object({ name: z.string().min(1).max(64), url: httpUrl }))
      .max(50)
      .default([]),
    /** TLS endpoints whose certificate is checked (one handshake each). */
    tls: z
      .array(
        z.object({
          name: z.string().min(1).max(64),
          host: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/, 'a hostname'),
          port: z.number().int().min(1).max(65535).default(443),
        }),
      )
      .max(50)
      .default([]),
    /** GitHub repos for Dependabot and secret-scanning alerts. */
    repos: z
      .array(z.string().regex(/^[\w.-]{1,100}\/[\w.-]{1,100}$/, 'must be owner/name'))
      .max(20)
      .default([]),
    scanTimeoutMs: z.number().int().min(500).max(60_000).default(8000),
  })
  .default({ headers: [], tls: [], repos: [], scanTimeoutMs: 8000 });

const serviceConfigSchema = z
  .object({
    prometheus: endpoint,
    alertmanager: endpoint,
    services: z.array(serviceSchema).min(1),
    security: securitySchema,
    /** How times are spoken ("the 2:41 deploy"). */
    display: z.object({ timeZone: timeZone.default('UTC') }).default({ timeZone: 'UTC' }),
    github: z
      .object({
        apiUrl: httpUrl.default('https://api.github.com'),
        timeoutMs: z.number().int().min(100).max(60_000).default(8000),
      })
      .default({ apiUrl: 'https://api.github.com', timeoutMs: 8000 }),
    executors: z.record(executorName, executorSchema).default({}),
  })
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.services.forEach((s, i) => {
      if (seen.has(s.name)) {
        ctx.addIssue({ code: 'custom', path: ['services', i, 'name'], message: 'duplicate name' });
      }
      seen.add(s.name);
      for (const [action, cfg] of Object.entries(s.actions)) {
        const executor = cfg && c.executors[cfg.executor];
        if (cfg && !executor) {
          ctx.addIssue({
            code: 'custom',
            path: ['services', i, 'actions', action, 'executor'],
            message: `unknown executor "${cfg.executor}"`,
          });
        } else if (executor?.type === 'github_workflow' && action !== 'rollback_deploy') {
          ctx.addIssue({
            code: 'custom',
            path: ['services', i, 'actions', action, 'executor'],
            message: 'a github_workflow executor can only do rollback_deploy',
          });
        }
      }
    });
  });

export type ServiceConfig = z.infer<typeof serviceConfigSchema>;
export type ServiceDef = ServiceConfig['services'][number];
export type DeploySourceConfig = NonNullable<ServiceDef['deploys']>;
export type ExecutorConfig = ServiceConfig['executors'][string];

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

  // SECURITY_DOMAIN: the public domain this deployment serves (prod). Adds its
  // TLS certificate and its response headers to the security allowlist, so the
  // committed config doesn't hard-code anyone's domain.
  const domain = env['SECURITY_DOMAIN']?.trim();
  if (domain) {
    const sec =
      typeof out['security'] === 'object' && out['security'] !== null
        ? (out['security'] as Record<string, unknown>)
        : {};
    const list = (k: string) => (Array.isArray(sec[k]) ? (sec[k] as unknown[]) : []);
    out['security'] = {
      ...sec,
      headers: [
        ...list('headers'),
        { name: 'Nightshift public endpoint', url: `https://${domain}/healthz` },
        { name: 'Nightshift landing page', url: `https://${domain}/` },
        { name: 'Nightshift simulated Alexa', url: `https://${domain}/alexa` },
      ],
      tls: [...list('tls'), { name: 'Nightshift public endpoint', host: domain, port: 443 }],
    };
  }
  return out;
}
