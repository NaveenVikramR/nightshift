import { quoteUntrusted, sanitizeLabel } from '../../../lib/untrusted.js';
import type { Check, CheckResult, RawFinding } from '../types.js';

/** One GET (no redirect following); behind an interface so tests use fakes. */
export interface HeaderFetcher {
  get(url: string, timeoutMs: number): Promise<{ status: number; headers: Headers }>;
}

export const fetchHeaders: HeaderFetcher = {
  async get(url, timeoutMs) {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'nightshift-security-scan' },
    });
    await res.body?.cancel().catch(() => undefined);
    return { status: res.status, headers: res.headers };
  },
};

/** "Express/4.17.1", "nginx/1.25.3": a version number leaks software details. */
const VERSIONED = /\d+\.\d+/;

/**
 * Evaluate one response's headers (pure). HSTS only matters on https: on
 * plain http browsers ignore it, so its absence there is noted, not a finding.
 */
export function evaluateHeaders(
  asset: { name: string; url: string },
  headers: Headers,
): { findings: RawFinding[]; notes: string[] } {
  const name = sanitizeLabel(asset.name);
  const https = asset.url.startsWith('https://');
  const csp = headers.get('content-security-policy');
  const findings: RawFinding[] = [];
  const add = (
    key: string,
    severity: RawFinding['severity'],
    title: string,
    value?: string | null,
  ) =>
    findings.push({
      check: 'security_headers',
      target: name,
      key,
      severity,
      title,
      detail: {
        asset: name,
        header: key,
        ...(value != null && { value: quoteUntrusted(value, 120) }),
      },
    });

  if (!csp) add('content-security-policy', 'medium', `missing content security policy on ${name}`);
  if (https && !headers.get('strict-transport-security')) {
    add('strict-transport-security', 'medium', `missing HSTS on ${name}`);
  }
  if ((headers.get('x-content-type-options') ?? '').toLowerCase() !== 'nosniff') {
    add('x-content-type-options', 'low', `missing X-Content-Type-Options on ${name}`);
  }
  if (!headers.get('x-frame-options') && !/frame-ancestors/i.test(csp ?? '')) {
    add('x-frame-options', 'medium', `no clickjacking protection on ${name}`);
  }
  const poweredBy = headers.get('x-powered-by');
  if (poweredBy)
    add('x-powered-by', 'low', `X-Powered-By header leaks the stack on ${name}`, poweredBy);
  const server = headers.get('server');
  if (server && VERSIONED.test(server))
    add('server', 'low', `Server header leaks a version on ${name}`, server);

  return { findings, notes: https ? [] : [`${name} is plain http: HSTS not applicable`] };
}

export class SecurityHeadersCheck implements Check {
  readonly name = 'security_headers' as const;

  constructor(
    private readonly assets: readonly { name: string; url: string }[],
    private readonly fetcher: HeaderFetcher,
    private readonly timeoutMs: number,
  ) {}

  async run(): Promise<CheckResult> {
    if (this.assets.length === 0) {
      return {
        check: this.name,
        status: 'not_configured',
        findings: [],
        checked: [],
        note: 'no URLs in security.headers',
      };
    }
    const findings: RawFinding[] = [];
    const notes: string[] = [];
    const checked: string[] = [];
    let answered = 0;
    for (const asset of this.assets) {
      try {
        const res = await this.fetcher.get(asset.url, this.timeoutMs);
        answered++;
        checked.push(sanitizeLabel(asset.name));
        const r = evaluateHeaders(asset, res.headers);
        findings.push(...r.findings);
        notes.push(...r.notes);
      } catch {
        notes.push(`${sanitizeLabel(asset.name)} did not answer`);
      }
    }
    if (answered === 0)
      return { check: this.name, status: 'error', findings: [], checked, note: notes.join('; ') };
    return {
      check: this.name,
      status: findings.length > 0 ? 'findings' : 'ok',
      findings,
      checked,
      ...(notes.length > 0 && { note: notes.join('; ') }),
    };
  }
}
