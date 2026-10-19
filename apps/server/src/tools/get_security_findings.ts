import { z } from 'zod';
import { countBySeverity, worstFirst } from '../domain/posture/score.js';
import { speakFindings } from '../domain/posture/speak.js';
import { FINDING_SEVERITIES, SEVERITY_RANK } from '../domain/posture/types.js';
import type { ScanRecord } from '../db/securityStore.js';
import type { ToolDefinition } from './types.js';

const inputSchema = z.object({
  severity: z
    .enum(FINDING_SEVERITIES)
    .optional()
    .describe('Only issues at this severity or worse (critical, high, medium, low).'),
});

export interface FindingsData {
  scanned: boolean;
  grade: ScanRecord['grade'] | null;
  score: number | null;
  scannedAt: string | null;
  counts: ScanRecord['counts'] | null;
  findings: {
    fingerprint: string;
    check: string;
    target: string;
    severity: string;
    title: string;
    detail: unknown;
    firstSeenAt: string;
  }[];
  checks: ScanRecord['checks'];
}

export const getSecurityFindings: ToolDefinition<typeof inputSchema, FindingsData> = {
  name: 'get_security_findings',
  title: 'Get security findings',
  description:
    'Report the current security grade and open issues from the latest scan, worst first, without scanning again. ' +
    'Use when the user asks about security posture or what to fix. To scan now use run_security_scan.',
  inputSchema,
  minRole: 'viewer',
  card: 'security',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },

  async handler(input, { deps }) {
    const latest = await deps.security.latestScan();
    if (!latest) {
      return {
        speak: "I haven't run a security scan yet. Ask me to run one.",
        data: {
          scanned: false,
          grade: null,
          score: null,
          scannedAt: null,
          counts: null,
          findings: [],
          checks: [],
        },
      };
    }
    const min = input.severity;
    const open = worstFirst(await deps.security.openFindings()).filter(
      (f) => !min || SEVERITY_RANK[f.severity] <= SEVERITY_RANK[min],
    );
    return {
      speak: speakFindings(latest.grade, countBySeverity(open), open[0], latest.checks, min),
      data: {
        scanned: true,
        grade: latest.grade,
        score: latest.score,
        scannedAt: latest.startedAt.toISOString(),
        counts: latest.counts,
        findings: open.map((f) => ({
          fingerprint: f.fingerprint,
          check: f.check,
          target: f.target,
          severity: f.severity,
          title: f.title,
          detail: f.detail,
          firstSeenAt: f.firstSeenAt.toISOString(),
        })),
        checks: latest.checks,
      },
    };
  },
};
