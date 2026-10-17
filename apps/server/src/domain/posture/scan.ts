import {
  countBySeverity,
  grade,
  gradeChange,
  score,
  worstFirst,
  type Grade,
  type SeverityCounts,
} from './score.js';
import { COMPLETED, fingerprint, type Check, type CheckResult, type RawFinding } from './types.js';

/** A finding as persisted across scans. */
export interface StoredFinding extends RawFinding {
  fingerprint: string;
  status: 'open' | 'resolved';
  firstSeenAt: Date;
  resolvedAt: Date | null;
}

export type FingerprintedFinding = RawFinding & { fingerprint: string };

/** Run every check in parallel; one that doesn't finish in time becomes status "timeout". */
export async function runChecks(
  checks: readonly Check[],
  timeoutMs: number,
): Promise<CheckResult[]> {
  return Promise.all(
    checks.map(async (c) => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<CheckResult>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              check: c.name,
              status: 'timeout',
              findings: [],
              checked: [],
              note: `no answer in ${timeoutMs} ms`,
            }),
          timeoutMs,
        );
      });
      const run = c
        .run()
        .catch((): CheckResult => ({
          check: c.name,
          status: 'error',
          findings: [],
          checked: [],
          note: 'check failed',
        }));
      return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
    }),
  );
}

export interface Reconciled {
  /** First seen in this scan (or reopened). */
  added: FingerprintedFinding[];
  /** Seen before and again now. */
  stillOpen: FingerprintedFinding[];
  /** Open before, checked again now, and gone. */
  resolved: StoredFinding[];
  /** Open before, but its check/target wasn't checked this time: stays open, unchanged. */
  carried: StoredFinding[];
  /** Everything open after this scan (what the score is computed from). */
  open: (FingerprintedFinding | StoredFinding)[];
}

/**
 * Dedupe by fingerprint and decide what's new / resolved (pure). A previous
 * finding is resolved only if its check completed AND its target was checked
 * this time; otherwise a timeout would look like a fix.
 */
export function reconcile(
  previousOpen: readonly StoredFinding[],
  results: readonly CheckResult[],
): Reconciled {
  const current = new Map<string, FingerprintedFinding>();
  for (const r of results)
    for (const f of r.findings) current.set(fingerprint(f), { ...f, fingerprint: fingerprint(f) });
  const before = new Map(previousOpen.map((f) => [f.fingerprint, f]));
  const byCheck = new Map(results.map((r) => [r.check, r]));

  const added = [...current.values()].filter((f) => !before.has(f.fingerprint));
  const stillOpen = [...current.values()].filter((f) => before.has(f.fingerprint));
  const resolved: StoredFinding[] = [];
  const carried: StoredFinding[] = [];
  for (const f of previousOpen) {
    if (current.has(f.fingerprint)) continue;
    const r = byCheck.get(f.check);
    if (r && COMPLETED.has(r.status) && r.checked.includes(f.target)) resolved.push(f);
    else carried.push(f);
  }
  return { added, stillOpen, resolved, carried, open: [...current.values(), ...carried] };
}

export interface ScanSummary {
  score: number;
  grade: Grade;
  previousGrade: Grade | null;
  change: ReturnType<typeof gradeChange>;
  counts: SeverityCounts;
  added: FingerprintedFinding[];
  resolved: StoredFinding[];
  open: (FingerprintedFinding | StoredFinding)[];
  checks: {
    check: CheckResult['check'];
    status: CheckResult['status'];
    findings: number;
    note?: string;
  }[];
}

export function summarize(
  r: Reconciled,
  results: readonly CheckResult[],
  previousGrade: Grade | null,
): ScanSummary {
  const s = score(r.open);
  const g = grade(s);
  return {
    score: s,
    grade: g,
    previousGrade,
    change: gradeChange(previousGrade, g),
    counts: countBySeverity(r.open),
    added: worstFirst(r.added),
    resolved: worstFirst(r.resolved),
    open: worstFirst(r.open),
    checks: results.map((c) => ({
      check: c.check,
      status: c.status,
      findings: c.findings.length,
      ...(c.note && { note: c.note }),
    })),
  };
}
