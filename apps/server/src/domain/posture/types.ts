import { createHash } from 'node:crypto';
import type { UntrustedText } from '../../lib/untrusted.js';

export const CHECKS = [
  'tls_expiry',
  'security_headers',
  'dependabot',
  'secret_scanning',
  'auth_failure_spike',
  'webhook_signature_failures',
] as const;
export type CheckName = (typeof CHECKS)[number];

export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/**
 * One problem a check found. `title` is server-authored and safe to speak;
 * anything from an external source (advisory text, package names, URLs,
 * header values) goes in `detail`, quoted as untrusted (invariant 6).
 */
export interface RawFinding {
  check: CheckName;
  /** The allowlisted target (asset name, repo, host, service). Sanitized. */
  target: string;
  /** Stable per problem within a target (header name, alert number, ...). */
  key: string;
  severity: FindingSeverity;
  title: string;
  detail: Record<string, string | number | boolean | null | UntrustedText>;
}

export type CheckStatus =
  /** Ran, nothing wrong. */
  | 'ok'
  /** Ran, found problems. */
  | 'findings'
  /** Nothing to check (no targets / no token). Not a failure. */
  | 'not_configured'
  /** The source doesn't offer it here (e.g. Dependabot disabled, 403/404). Not a finding. */
  | 'not_available'
  | 'timeout'
  | 'error';

export interface CheckResult {
  check: CheckName;
  status: CheckStatus;
  findings: RawFinding[];
  /**
   * Targets this run actually checked. Only their previously open findings may
   * be resolved: a target that timed out keeps its findings open.
   */
  checked: string[];
  /** Short server-authored note (why not configured / not available). */
  note?: string;
}

/** Statuses after which this check's previously open findings may be resolved. */
export const COMPLETED: ReadonlySet<CheckStatus> = new Set(['ok', 'findings']);

/** A security check over the allowlisted targets. Never throws: failures become a status. */
export interface Check {
  readonly name: CheckName;
  run(): Promise<CheckResult>;
}

/** check|target|key → sha256: repeat scans dedupe on it. */
export function fingerprint(f: Pick<RawFinding, 'check' | 'target' | 'key'>): string {
  return createHash('sha256').update(`${f.check}|${f.target}|${f.key}`, 'utf8').digest('hex');
}

export const SEVERITY_RANK: Record<FindingSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};
