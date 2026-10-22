import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/prisma.js';
import { PrismaSecurityStore, SCAN_TX_OPTIONS } from '../../src/db/securityStore.js';

/** A fake Prisma client: records the transaction options and every statement in it. */
function fakeDb() {
  const calls: string[] = [];
  let options: unknown;
  const tx = {
    securityScan: {
      create: async ({ data }: { data: Record<string, unknown> }) => (
        calls.push('scan.create'),
        { id: 'scan-1', ...data }
      ),
    },
    securityFinding: {
      upsert: async () => (calls.push('finding.upsert'), {}),
      updateMany: async () => (calls.push('finding.resolve'), { count: 1 }),
    },
  };
  const db = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>, opts: unknown) => {
      options = opts;
      return fn(tx);
    },
  };
  return { db: db as unknown as Db, calls, options: () => options };
}

const finding = (n: number) => ({
  fingerprint: `security_headers|payments API|h${n}`,
  check: 'security_headers',
  target: 'payments API',
  key: `h${n}`,
  severity: 'medium',
  title: `missing header ${n}`,
  detail: null,
});

describe('PrismaSecurityStore.saveScan', () => {
  it('runs in one transaction with a timeout sized for a remote database (live: 5 s expired)', async () => {
    const f = fakeDb();
    await new PrismaSecurityStore(f.db).saveScan({
      startedAt: new Date('2026-10-22T12:00:00Z'),
      finishedAt: new Date('2026-10-22T12:00:05Z'),
      startedBy: 'alice',
      previousScanId: null,
      seen: [finding(1), finding(2), finding(3), finding(4)],
      summary: {
        score: 70,
        grade: 'C',
        checks: [],
        counts: { critical: 0, high: 0, medium: 2, low: 2 },
        added: [],
        resolved: [finding(9)],
        previousGrade: 'A',
        change: 'worse',
      },
    } as never);
    expect(f.options()).toEqual(SCAN_TX_OPTIONS);
    expect(SCAN_TX_OPTIONS.timeout).toBeGreaterThanOrEqual(30_000);
    expect(f.calls).toEqual([
      'scan.create',
      'finding.upsert',
      'finding.upsert',
      'finding.upsert',
      'finding.upsert',
      'finding.resolve',
    ]);
  });
});
