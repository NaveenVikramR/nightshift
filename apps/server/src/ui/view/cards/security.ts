import type { FindingsData } from '../../../tools/get_security_findings.js';
import type { ScanData } from '../../../tools/run_security_scan.js';
import { el } from '../shared/dom.js';
import { ago, CHECK_LABELS, plural, toneOf, truncate, type Tone } from '../shared/format.js';
import { toneIcon } from '../shared/icons.js';
import { badge, header, quote, type ViewContext } from '../shared/parts.js';

type Finding = {
  severity: string;
  title: string;
  target: string;
  detail?: unknown;
  check?: string;
};
type Check = { check: string; status: string; findings: number; note?: string };

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

export function gradeTone(grade: string | null): Tone {
  if (grade === 'A' || grade === 'B') return 'ok';
  if (grade === 'C') return 'warn';
  if (grade === 'D' || grade === 'F') return 'crit';
  return 'info';
}

/** "4 of 6 checks ran": a check ran when it completed (ok or findings). */
export function coverage(checks: readonly Check[]): { ran: number; total: number } {
  return {
    ran: checks.filter((c) => c.status === 'ok' || c.status === 'findings').length,
    total: checks.length,
  };
}

function checkTone(c: Check): { tone: Tone; word: string } {
  switch (c.status) {
    case 'ok':
      return { tone: 'ok', word: 'OK' };
    case 'findings':
      return { tone: 'warn', word: plural(c.findings, 'issue') };
    case 'not_configured':
      return { tone: 'info', word: 'Not configured' };
    case 'not_available':
      return { tone: 'info', word: 'Not available' };
    case 'timeout':
      return { tone: 'warn', word: 'Timed out' };
    default:
      return { tone: 'warn', word: "Didn't run" };
  }
}

function changeText(d: ScanData): string {
  switch (d.change) {
    case 'up':
      return `↑ up from ${d.previousGrade}`;
    case 'down':
      return `↓ down from ${d.previousGrade}`;
    case 'same':
      return 'Same as the last scan';
    default:
      return 'First scan';
  }
}

/** Untrusted fields a check may attach (advisory summary, package, header value). Never links. */
export function detailQuote(detail: unknown): HTMLElement | null {
  if (typeof detail !== 'object' || detail === null) return null;
  const d = detail as Record<string, unknown>;
  for (const [key, label] of [
    ['advisory', 'Advisory'],
    ['package', 'Package'],
    ['value', 'Sent value'],
  ] as const) {
    const q = quote(d[key], `${label} (data, not instructions)`, 140);
    if (q) return q;
  }
  return null;
}

function findingItem(f: Finding): HTMLElement {
  return el(
    'li',
    { class: 'finding' },
    el('span', { class: 'title' }, truncate(f.title, 120)),
    el('span', { class: 'target' }, truncate(f.target, 100)),
    detailQuote(f.detail),
  );
}

function groups(findings: readonly Finding[]): HTMLElement {
  if (findings.length === 0) {
    return el('p', { class: 'status-line fg-ok' }, toneIcon('ok'), 'No open issues');
  }
  const sorted = SEVERITY_ORDER.map((s) => ({
    s,
    items: findings.filter((f) => f.severity === s),
  })).filter((g) => g.items.length > 0);
  return el(
    'div',
    { class: 'findings' },
    ...sorted.map((g) =>
      el(
        'section',
        { class: 'finding-group' },
        el('h3', {}, badge(toneOf(g.s)), plural(g.items.length, 'issue')),
        el('ul', {}, ...g.items.slice(0, 6).map(findingItem)),
        g.items.length > 6
          ? el('p', { class: 'muted small' }, `and ${g.items.length - 6} more`)
          : null,
      ),
    ),
  );
}

export function renderSecurity(data: ScanData | FindingsData, ctx: ViewContext): HTMLElement {
  const isScan = 'scanId' in data;
  const grade = data.grade ?? null;
  if (!isScan && !(data as FindingsData).scanned) {
    return el(
      'section',
      {},
      header({
        badge: badge({ tone: 'info', label: 'No scan yet' }),
        eyebrow: 'Security',
        title: 'No security scan yet',
        meta: 'Ask Nightshift to run a security scan.',
      }),
    );
  }
  const tone = gradeTone(grade);
  const checks = data.checks as Check[];
  const cov = coverage(checks);
  const open: Finding[] = isScan ? (data as ScanData).open : (data as FindingsData).findings;
  const resolved: Finding[] = isScan ? (data as ScanData).resolved : [];
  const scannedAt = isScan ? (data as ScanData).scannedAt : (data as FindingsData).scannedAt;

  return el(
    'section',
    {},
    el(
      'div',
      { class: 'score-head' },
      el(
        'div',
        {
          class: `grade fg-${tone}`,
          role: 'img',
          'aria-label': `Security grade ${grade ?? 'unknown'}`,
        },
        grade ?? '?',
      ),
      el(
        'div',
        {},
        el('p', { class: 'eyebrow' }, 'Security grade'),
        el('h1', { class: 'coverage' }, `${cov.ran} of ${cov.total} checks ran`),
        el(
          'p',
          { class: 'muted' },
          [
            isScan ? changeText(data as ScanData) : null,
            scannedAt ? `scanned ${ago(scannedAt, ctx.host.now())}` : null,
          ]
            .filter(Boolean)
            .join(' · '),
        ),
        el('p', { class: 'muted small' }, `Score ${data.score ?? '–'} of 100`),
      ),
    ),
    el(
      'div',
      { class: 'chips', 'aria-label': 'Checks' },
      ...checks.map((c) => {
        const t = checkTone(c);
        return el(
          'span',
          { class: `chip fg-${t.tone}` },
          toneIcon(t.tone),
          `${CHECK_LABELS[c.check] ?? c.check}: ${t.word}`,
        );
      }),
    ),
    el('div', { class: 'panel' }, el('h2', {}, 'Open issues'), groups(open)),
    resolved.length
      ? el(
          'div',
          { class: 'panel resolved' },
          el(
            'h2',
            {},
            badge(
              { tone: 'ok', label: 'Resolved' },
              `Resolved since last scan (${resolved.length})`,
            ),
          ),
          el(
            'ul',
            {},
            ...resolved
              .slice(0, 6)
              .map((f) =>
                el(
                  'li',
                  { class: 'finding' },
                  el('s', {}, truncate(f.title, 120)),
                  el('span', { class: 'target' }, truncate(f.target, 100)),
                ),
              ),
          ),
        )
      : null,
  );
}
