import { z } from 'zod';
import { reconcile, runChecks, summarize, type ScanSummary } from '../domain/posture/scan.js';
import { speakScan } from '../domain/posture/speak.js';
import { UserFacingError } from '../lib/errors.js';
import { Mutex } from '../lib/mutex.js';
import type { ToolDefinition } from './types.js';

/** At most one scan per minute per team (single instance, like the other limits). */
export const SCAN_INTERVAL_MS = 60_000;
const scanLock = new Mutex();

const inputSchema = z.object({});

const findingView = (f: ScanSummary['open'][number]) => ({
  fingerprint: f.fingerprint,
  check: f.check,
  target: f.target,
  severity: f.severity,
  title: f.title,
  /** Untrusted external text is inside, quoted. */
  detail: f.detail,
});

export interface ScanData {
  scanId: string;
  grade: ScanSummary['grade'];
  score: number;
  previousGrade: ScanSummary['previousGrade'];
  change: ScanSummary['change'];
  counts: ScanSummary['counts'];
  added: ReturnType<typeof findingView>[];
  resolved: ReturnType<typeof findingView>[];
  open: ReturnType<typeof findingView>[];
  checks: ScanSummary['checks'];
  scannedAt: string;
}

export const runSecurityScan: ToolDefinition<typeof inputSchema, ScanData> = {
  name: 'run_security_scan',
  title: 'Run a security scan',
  description:
    'Run the security posture checks now (TLS expiry, security headers, Dependabot and secret-scanning alerts, ' +
    'failed-login and webhook-signature spikes) on configured targets only, and report the grade and what changed. ' +
    'At most once a minute; to read the last results use get_security_findings.',
  inputSchema,
  minRole: 'viewer',
  annotations: {
    readOnlyHint: false, // stores the scan and findings; never changes the scanned systems
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },

  async handler(_input, { deps, principal }) {
    return scanLock.run(async () => {
      const latest = await deps.security.latestScan();
      const startedAt = deps.now();
      if (latest && startedAt.getTime() - latest.startedAt.getTime() < SCAN_INTERVAL_MS) {
        throw new UserFacingError(
          'scan_rate_limited',
          'I scanned less than a minute ago. Ask me for the security findings instead.',
        );
      }
      const results = await runChecks(deps.posture.checks(), deps.posture.timeoutMs);
      const reconciled = reconcile(await deps.security.openFindings(), results);
      const summary = summarize(reconciled, results, latest?.grade ?? null);
      const saved = await deps.security.saveScan({
        startedAt,
        finishedAt: deps.now(),
        startedBy: principal.actor,
        summary,
        previousScanId: latest?.id ?? null,
        seen: [...reconciled.added, ...reconciled.stillOpen],
      });
      return {
        speak: speakScan(summary),
        data: {
          scanId: saved.id,
          grade: summary.grade,
          score: summary.score,
          previousGrade: summary.previousGrade,
          change: summary.change,
          counts: summary.counts,
          added: summary.added.map(findingView),
          resolved: summary.resolved.map(findingView),
          open: summary.open.map(findingView),
          checks: summary.checks,
          scannedAt: startedAt.toISOString(),
        },
      };
    });
  },
};
