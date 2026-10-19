/**
 * Demo controls for judges (responder only). They only BREAK or RESET the demo
 * service through its token-protected admin API (server-side; the token never
 * reaches the browser). Diagnosis and fixes still go through Nightshift.
 * The deploy events mirror infra/scripts/deployEvents.mjs (test/demo.test.ts
 * checks they stay identical).
 */
export const SCENARIOS = {
  provider_outage: { label: 'Provider outage', path: '/admin/chaos/provider_outage' },
  bad_deploy: { label: 'Bad deploy', path: '/admin/chaos/bad_deploy' },
  latency_spike: { label: 'Latency spike', path: '/admin/chaos/latency_spike' },
  auth_bruteforce: { label: 'Auth brute force', path: '/admin/chaos/auth_bruteforce' },
  weak_headers: { label: 'Weak security headers', path: '/admin/security', body: { mode: 'weak' } },
  reset: { label: 'Reset everything', path: '/admin/reset' },
} as const;

export type Scenario = keyof typeof SCENARIOS;
export const isScenario = (s: string): s is Scenario => Object.hasOwn(SCENARIOS, s);

const SERVICE = 'payments-api';

export function baselineEvent(now = new Date()) {
  return {
    service: SERVICE,
    version: 'v1.4.1',
    commitMessage: 'stable payments release',
    author: 'ci',
    externalId: `chaos-baseline-v1.4.1-${now.toISOString().slice(0, 10)}`,
    deployedAt: new Date(now.getTime() - 2 * 60 * 60_000).toISOString(),
  };
}

export function badDeployEvent(now = new Date()) {
  return {
    service: SERVICE,
    version: 'v1.4.2',
    commitMessage: 'tune payment retry config',
    author: 'ci',
    externalId: `chaos-bad-deploy-${now.getTime()}`,
  };
}

export function resetEvent(now = new Date()) {
  return {
    service: SERVICE,
    version: 'v1.4.1',
    commitMessage: 'chaos reset: restore baseline',
    author: 'chaos-reset',
    externalId: `chaos-reset-${now.getTime()}`,
  };
}

export interface DemoDeps {
  adminUrl: string;
  adminToken: string;
  deployUrl?: string | undefined;
  ingestToken?: string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

async function post(
  f: typeof fetch,
  url: string,
  token: string,
  body?: unknown,
): Promise<Response> {
  return f(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
}

/** Runs a scenario. Returns a short, safe status line for the UI (never upstream bodies). */
export async function runScenario(
  s: Scenario,
  deps: DemoDeps,
): Promise<{ ok: boolean; message: string }> {
  const f = deps.fetchImpl ?? fetch;
  const now = deps.now?.() ?? new Date();
  const report = async (event: unknown) => {
    if (!deps.deployUrl || !deps.ingestToken) return false;
    const r = await post(f, `${deps.deployUrl}/events/deploy`, deps.ingestToken, event);
    return r.ok;
  };

  let versionBefore: string | undefined;
  if (s === 'bad_deploy') {
    if (!(await report(baselineEvent(now))) || !(await report(badDeployEvent(now)))) {
      return {
        ok: false,
        message: "Couldn't record the deploy in Nightshift; bad deploy not started.",
      };
    }
  }
  if (s === 'reset') {
    const state = await f(`${deps.adminUrl}/admin/state`, {
      headers: { authorization: `Bearer ${deps.adminToken}` },
      signal: AbortSignal.timeout(10_000),
    })
      .then((r) => (r.ok ? (r.json() as Promise<{ version?: string }>) : undefined))
      .catch(() => undefined);
    versionBefore = state?.version;
  }

  const sc = SCENARIOS[s];
  const res = await post(
    f,
    `${deps.adminUrl}${sc.path}`,
    deps.adminToken,
    'body' in sc ? sc.body : undefined,
  ).catch(() => undefined);
  if (!res?.ok) return { ok: false, message: "Couldn't reach the demo service." };

  // A reset that changed the version is a deploy; tell Nightshift's history (like chaos.mjs).
  if (s === 'reset' && versionBefore && versionBefore !== 'v1.4.1')
    await report(resetEvent(now)).catch(() => false);

  return {
    ok: true,
    message:
      s === 'reset'
        ? 'Demo service reset. Alerts clear in about a minute.'
        : `${sc.label} started. Alerts take about 30–60 s to fire.`,
  };
}
