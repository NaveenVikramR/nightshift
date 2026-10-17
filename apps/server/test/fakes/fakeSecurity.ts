import type { SaveScan, ScanRecord, SecurityStore } from '../../src/db/securityStore.js';
import type { PostureScanner } from '../../src/domain/posture/index.js';
import type { StoredFinding } from '../../src/domain/posture/scan.js';
import type { Check, CheckName, CheckResult } from '../../src/domain/posture/types.js';

/** Same semantics as the Prisma store: persistent findings deduped by fingerprint. */
export class InMemorySecurityStore implements SecurityStore {
  readonly scans: ScanRecord[] = [];
  readonly findings = new Map<string, StoredFinding>();
  private nextId = 1;

  async latestScan() {
    return this.scans.at(-1);
  }

  async openFindings() {
    return [...this.findings.values()].filter((f) => f.status === 'open');
  }

  async saveScan(input: SaveScan) {
    const s = input.summary;
    const scan: ScanRecord = {
      id: `scan-${this.nextId++}`,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      startedBy: input.startedBy,
      score: s.score,
      grade: s.grade,
      checks: s.checks,
      counts: s.counts,
      deltas: {
        added: s.added.map((f) => f.fingerprint),
        resolved: s.resolved.map((f) => f.fingerprint),
        previousGrade: s.previousGrade,
        change: s.change,
      },
    };
    this.scans.push(scan);
    for (const f of input.seen) {
      const prev = this.findings.get(f.fingerprint);
      this.findings.set(f.fingerprint, {
        ...f,
        status: 'open',
        firstSeenAt: prev?.firstSeenAt ?? input.finishedAt,
        resolvedAt: null,
      });
    }
    for (const r of s.resolved) {
      const f = this.findings.get(r.fingerprint);
      if (f) Object.assign(f, { status: 'resolved', resolvedAt: input.finishedAt });
    }
    return scan;
  }
}

/** A check whose result each test scripts. */
export class FakeCheck implements Check {
  result: CheckResult;
  runs = 0;
  constructor(
    readonly name: CheckName,
    result?: Partial<CheckResult>,
  ) {
    this.result = { check: name, status: 'ok', findings: [], checked: [], ...result };
  }
  async run() {
    this.runs++;
    return structuredClone(this.result);
  }
}

export function fakeScanner(checks: FakeCheck[]): PostureScanner {
  return { timeoutMs: 1000, checks: () => checks };
}
