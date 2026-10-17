/** Scoring and deltas (pure). */
import { SEVERITY_RANK, type FindingSeverity } from './types.js';

export const WEIGHTS: Record<FindingSeverity, number> = {
  critical: 40,
  high: 20,
  medium: 8,
  low: 3,
};
export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

export function score(open: readonly { severity: FindingSeverity }[]): number {
  return Math.max(0, 100 - open.reduce((s, f) => s + WEIGHTS[f.severity], 0));
}

export function grade(s: number): Grade {
  return s >= 90 ? 'A' : s >= 80 ? 'B' : s >= 70 ? 'C' : s >= 60 ? 'D' : 'F';
}

export type SeverityCounts = Record<FindingSeverity, number>;

export function countBySeverity(open: readonly { severity: FindingSeverity }[]): SeverityCounts {
  const c: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of open) c[f.severity]++;
  return c;
}

export function worstFirst<T extends { severity: FindingSeverity; title: string }>(
  findings: readonly T[],
): T[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.title.localeCompare(b.title),
  );
}

const GRADE_ORDER: Grade[] = ['F', 'D', 'C', 'B', 'A'];

/** 'up' | 'down' | 'same' | 'first' (no previous scan). */
export function gradeChange(
  previous: Grade | null,
  current: Grade,
): 'up' | 'down' | 'same' | 'first' {
  if (previous === null) return 'first';
  const d = GRADE_ORDER.indexOf(current) - GRADE_ORDER.indexOf(previous);
  return d > 0 ? 'up' : d < 0 ? 'down' : 'same';
}
