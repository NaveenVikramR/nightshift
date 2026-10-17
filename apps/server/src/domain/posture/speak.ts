/** Spoken summaries for security posture (≤ 30 words, server-authored titles only). */
import { countWords, MAX_SPEAK_WORDS } from '../../lib/speak.js';
import { capitalize, spokenCount, spokenList } from '../spoken.js';
import type { ScanSummary } from './scan.js';
import { COMPLETED, FINDING_SEVERITIES, type CheckStatus, type FindingSeverity } from './types.js';
import type { Grade, SeverityCounts } from './score.js';

const fit = (variants: string[]) =>
  variants.find((v) => countWords(v) <= MAX_SPEAK_WORDS) ?? variants[variants.length - 1]!;

const plural = (n: number, word: string) => `${spokenCount(n)} ${word}${n === 1 ? '' : 's'}`;

/**
 * "Three of six checks didn't run." A grade only covers the checks that ran
 * (unconfigured ones can't find anything), so the speak must say so.
 */
export function coverageNote(checks: readonly { status: CheckStatus }[]): string {
  const notRun = checks.filter((c) => !COMPLETED.has(c.status)).length;
  if (notRun === 0 || checks.length === 0) return '';
  return `${capitalize(spokenCount(notRun))} of ${spokenCount(checks.length)} checks didn't run.`;
}

/** Every variant carries the coverage note; detail is dropped first. */
const withNote = (variants: string[], note: string) =>
  fit(note ? variants.map((v) => `${v} ${note}`) : variants);

function gradeLine(grade: Grade, previous: Grade | null, change: ScanSummary['change']): string {
  if (change === 'first' || previous === null) return `Security grade ${grade}.`;
  if (change === 'same') return `Security grade ${grade}, unchanged.`;
  return `Security grade ${grade}, ${change === 'down' ? 'down' : 'up'} from ${previous}.`;
}

/** "missing content security policy on payments API, and no clickjacking protection on payments API" */
function titles(list: { title: string }[], max: number): string {
  const shown = list.slice(0, max).map((f) => f.title);
  const rest = list.length - shown.length;
  return rest > 0 ? `${shown.join(', ')}, and ${spokenCount(rest)} more` : spokenList(shown);
}

function scanVariants(s: ScanSummary): string[] {
  const head = gradeLine(s.grade, s.previousGrade, s.change);
  const isFirst = s.change === 'first';
  const items = isFirst ? s.open : s.added;
  const label = isFirst ? 'open' : 'new';
  if (items.length === 0) {
    if (s.resolved.length > 0) {
      const resolved = `${capitalize(plural(s.resolved.length, 'issue'))} resolved.`;
      const left =
        s.open.length === 0 ? ' No open issues.' : ` ${plural(s.open.length, 'issue')} still open.`;
      return [`${head} ${resolved}${left}`, `${head} ${resolved}`];
    }
    return [
      s.open.length === 0
        ? `${head} No open issues.`
        : `${head} No new issues; ${plural(s.open.length, 'issue')} still open.`,
    ];
  }
  const n = capitalize(plural(items.length, `${label} issue`));
  return [
    `${head} ${n}: ${titles(items, 2)}.`,
    `${head} ${n}: ${titles(items, 1)}.`,
    `${head} ${n}.`,
  ];
}

export function speakScan(s: ScanSummary): string {
  return withNote(scanVariants(s), coverageNote(s.checks));
}

/** "one high, two medium, one low" (most severe first, zeros skipped). */
export function spokenCounts(c: SeverityCounts): string {
  const parts = FINDING_SEVERITIES.filter((s) => c[s] > 0).map((s) => `${spokenCount(c[s])} ${s}`);
  return parts.length > 0 ? spokenList(parts) : 'no open issues';
}

export function speakFindings(
  grade: Grade,
  counts: SeverityCounts,
  worst: { title: string; severity: FindingSeverity } | undefined,
  checks: readonly { status: CheckStatus }[],
  minSeverity?: FindingSeverity,
): string {
  const note = coverageNote(checks);
  if (!worst) {
    return withNote(
      [
        minSeverity
          ? `Security grade ${grade}. No open issues at ${minSeverity} severity or above.`
          : `Security grade ${grade}. No open issues.`,
      ],
      note,
    );
  }
  return withNote(
    [
      `Security grade ${grade}: ${spokenCounts(counts)}. Worst: ${worst.title}.`,
      `Security grade ${grade}: ${spokenCounts(counts)}.`,
    ],
    note,
  );
}
