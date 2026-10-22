import type { FingerprintedFinding, ScanSummary, StoredFinding } from '../domain/posture/scan.js';
import type { Grade } from '../domain/posture/score.js';
import type { CheckName, FindingSeverity } from '../domain/posture/types.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { Db } from './prisma.js';

export interface ScanRecord {
  id: string;
  startedAt: Date;
  finishedAt: Date | null;
  startedBy: string;
  score: number;
  grade: Grade;
  checks: ScanSummary['checks'];
  counts: ScanSummary['counts'];
  deltas: {
    added: string[];
    resolved: string[];
    previousGrade: Grade | null;
    change: ScanSummary['change'];
  };
}

export interface SaveScan {
  startedAt: Date;
  finishedAt: Date;
  startedBy: string;
  summary: ScanSummary;
  previousScanId: string | null;
  /** Findings seen in this scan (added + still open). */
  seen: FingerprintedFinding[];
}

export interface SecurityStore {
  latestScan(): Promise<ScanRecord | undefined>;
  openFindings(): Promise<StoredFinding[]>;
  /** Atomically: the scan row, upserted findings, resolved findings. */
  saveScan(input: SaveScan): Promise<ScanRecord>;
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

type ScanRow = NonNullable<Awaited<ReturnType<Db['securityScan']['findFirst']>>>;
type FindingRow = NonNullable<Awaited<ReturnType<Db['securityFinding']['findFirst']>>>;

function scanFromRow(r: ScanRow): ScanRecord {
  return {
    id: r.id,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    startedBy: r.startedBy,
    score: r.score ?? 0,
    grade: (r.grade ?? 'F') as Grade,
    checks: (r.checks ?? []) as unknown as ScanRecord['checks'],
    counts: (r.counts ?? {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    }) as unknown as ScanRecord['counts'],
    deltas: (r.deltas ?? {
      added: [],
      resolved: [],
      previousGrade: null,
      change: 'first',
    }) as unknown as ScanRecord['deltas'],
  };
}

function findingFromRow(r: FindingRow): StoredFinding {
  return {
    fingerprint: r.fingerprint,
    check: r.check as CheckName,
    target: r.target,
    key: r.key,
    severity: r.severity as FindingSeverity,
    title: r.title,
    detail: (r.detail ?? {}) as StoredFinding['detail'],
    status: r.status as StoredFinding['status'],
    firstSeenAt: r.firstSeenAt,
    resolvedAt: r.resolvedAt,
  };
}

/** Interactive transaction limits for saveScan (see there). */
export const SCAN_TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

export class PrismaSecurityStore implements SecurityStore {
  constructor(private readonly db: Db) {}

  async latestScan() {
    const row = await this.db.securityScan.findFirst({
      where: { finishedAt: { not: null } },
      orderBy: { startedAt: 'desc' },
    });
    return row ? scanFromRow(row) : undefined;
  }

  async openFindings() {
    const rows = await this.db.securityFinding.findMany({ where: { status: 'open' } });
    return rows.map(findingFromRow);
  }

  /**
   * One transaction per scan: the scan row, one upsert per finding, then resolves. Each
   * statement is a round trip, so on a remote database (Neon) Prisma's 5 s default expired
   * live with only 4 findings (8.9 s; the scan was lost). 30 s covers the 50-target allowlist.
   */
  async saveScan(input: SaveScan): Promise<ScanRecord> {
    const s = input.summary;
    const row = await this.db.$transaction(async (tx) => {
      const scan = await tx.securityScan.create({
        data: {
          startedAt: input.startedAt,
          finishedAt: input.finishedAt,
          startedBy: input.startedBy,
          score: s.score,
          grade: s.grade,
          checks: json(s.checks),
          counts: json(s.counts),
          deltas: json({
            added: s.added.map((f) => f.fingerprint),
            resolved: s.resolved.map((f) => f.fingerprint),
            previousGrade: s.previousGrade,
            change: s.change,
          }),
          previousScanId: input.previousScanId,
        },
      });
      for (const f of input.seen) {
        const data = {
          check: f.check,
          target: f.target,
          key: f.key,
          severity: f.severity,
          title: f.title,
          detail: json(f.detail),
        };
        await tx.securityFinding.upsert({
          where: { fingerprint: f.fingerprint },
          create: {
            ...data,
            fingerprint: f.fingerprint,
            firstSeenScanId: scan.id,
            lastSeenScanId: scan.id,
          },
          update: {
            ...data,
            status: 'open',
            lastSeenScanId: scan.id,
            resolvedScanId: null,
            resolvedAt: null,
          },
        });
      }
      if (s.resolved.length > 0) {
        await tx.securityFinding.updateMany({
          where: { fingerprint: { in: s.resolved.map((f) => f.fingerprint) }, status: 'open' },
          data: { status: 'resolved', resolvedScanId: scan.id, resolvedAt: input.finishedAt },
        });
      }
      return scan;
    }, SCAN_TX_OPTIONS);
    return scanFromRow(row);
  }
}
