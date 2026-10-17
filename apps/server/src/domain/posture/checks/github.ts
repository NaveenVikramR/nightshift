import { z } from 'zod';
import type { FetchLike } from '../../../clients/errors.js';
import { quoteUntrusted, sanitizeLabel } from '../../../lib/untrusted.js';
import type { Check, CheckName, CheckResult, FindingSeverity, RawFinding } from '../types.js';

export interface GitHubAlertsOptions {
  apiUrl: string;
  token: string | undefined;
  repos: readonly string[];
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

type Fetched =
  { kind: 'ok'; body: unknown } | { kind: 'not_available'; status: number } | { kind: 'error' };

/**
 * GET a GitHub API path. 403 / 404 mean "this repo or token doesn't offer
 * it" (feature disabled, not GHAS, missing permission) and are NOT findings.
 */
async function ghGet(o: GitHubAlertsOptions, path: string): Promise<Fetched> {
  try {
    const res = await (o.fetchImpl ?? fetch)(`${o.apiUrl}${path}`, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        authorization: `Bearer ${o.token ?? ''}`,
        'user-agent': 'nightshift-security-scan',
      },
      signal: AbortSignal.timeout(o.timeoutMs),
    });
    if (res.status === 403 || res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: 'not_available', status: res.status };
    }
    if (!res.ok) return { kind: 'error' };
    return { kind: 'ok', body: await res.json() };
  } catch {
    return { kind: 'error' };
  }
}

const SEVERITY: Record<string, FindingSeverity> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  moderate: 'medium',
  low: 'low',
};

const dependabotAlert = z.object({
  number: z.number(),
  security_advisory: z
    .object({
      severity: z.string(),
      summary: z.string().optional(),
      ghsa_id: z.string().optional(),
    })
    .optional(),
  security_vulnerability: z
    .object({
      package: z.object({ name: z.string(), ecosystem: z.string().optional() }).optional(),
    })
    .optional(),
  html_url: z.string().optional(),
});

const secretAlert = z.object({
  number: z.number(),
  secret_type_display_name: z.string().optional(),
  secret_type: z.string().optional(),
  html_url: z.string().optional(),
});

abstract class GitHubAlertsCheck implements Check {
  abstract readonly name: CheckName;
  protected abstract path(repo: string): string;
  protected abstract toFindings(repo: string, body: unknown): RawFinding[] | null;

  constructor(protected readonly o: GitHubAlertsOptions) {}

  async run(): Promise<CheckResult> {
    if (this.o.repos.length === 0) {
      return {
        check: this.name,
        status: 'not_configured',
        findings: [],
        checked: [],
        note: 'no repos in security.repos',
      };
    }
    if (!this.o.token) {
      return {
        check: this.name,
        status: 'not_configured',
        findings: [],
        checked: [],
        note: 'GITHUB_TOKEN is not set',
      };
    }
    const findings: RawFinding[] = [];
    const checked: string[] = [];
    const unavailable: string[] = [];
    let errors = 0;
    for (const repo of this.o.repos) {
      const r = await ghGet(this.o, this.path(repo));
      if (r.kind === 'not_available') {
        unavailable.push(`${repo} (${r.status})`);
        continue;
      }
      const parsed = r.kind === 'ok' ? this.toFindings(repo, r.body) : null;
      if (!parsed) {
        errors++;
        continue;
      }
      checked.push(repo);
      findings.push(...parsed);
    }
    if (checked.length === 0) {
      return {
        check: this.name,
        status: errors > 0 ? 'error' : 'not_available',
        findings: [],
        checked,
        note:
          unavailable.length > 0
            ? `not available for ${unavailable.join(', ')}`
            : 'GitHub did not answer',
      };
    }
    return {
      check: this.name,
      status: findings.length > 0 ? 'findings' : 'ok',
      findings,
      checked,
      ...(unavailable.length > 0 && { note: `not available for ${unavailable.join(', ')}` }),
    };
  }
}

/** Open Dependabot alerts; severity from the advisory. Advisory text and package names are untrusted. */
export class DependabotCheck extends GitHubAlertsCheck {
  readonly name = 'dependabot' as const;

  protected path(repo: string) {
    return `/repos/${repo}/dependabot/alerts?state=open&per_page=100`;
  }

  protected toFindings(repo: string, body: unknown): RawFinding[] | null {
    const parsed = z.array(dependabotAlert).safeParse(body);
    if (!parsed.success) return null;
    return parsed.data.map((a) => {
      const severity = SEVERITY[(a.security_advisory?.severity ?? '').toLowerCase()] ?? 'medium';
      return {
        check: 'dependabot',
        target: repo,
        key: String(a.number),
        severity,
        title: `${severity}-severity dependency alert in ${repo.replace('/', ' ')}`,
        detail: {
          repo,
          alert: a.number,
          package: quoteUntrusted(a.security_vulnerability?.package?.name ?? '', 100),
          ecosystem: sanitizeLabel(a.security_vulnerability?.package?.ecosystem ?? '') || null,
          advisory: quoteUntrusted(a.security_advisory?.summary ?? '', 200),
          ghsa: sanitizeLabel(a.security_advisory?.ghsa_id ?? '') || null,
          url: quoteUntrusted(a.html_url ?? '', 200),
        },
      };
    });
  }
}

/** Open secret-scanning alerts (an exposed secret is high severity). */
export class SecretScanningCheck extends GitHubAlertsCheck {
  readonly name = 'secret_scanning' as const;

  protected path(repo: string) {
    return `/repos/${repo}/secret-scanning/alerts?state=open&per_page=100`;
  }

  protected toFindings(repo: string, body: unknown): RawFinding[] | null {
    const parsed = z.array(secretAlert).safeParse(body);
    if (!parsed.success) return null;
    return parsed.data.map((a) => ({
      check: 'secret_scanning',
      target: repo,
      key: String(a.number),
      severity: 'high',
      title: `exposed secret alert in ${repo.replace('/', ' ')}`,
      detail: {
        repo,
        alert: a.number,
        secretType: quoteUntrusted(a.secret_type_display_name ?? a.secret_type ?? '', 100),
        url: quoteUntrusted(a.html_url ?? '', 200),
      },
    }));
  }
}
