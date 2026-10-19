import type { ExplainData } from '../../../tools/explain_incident.js';
import { el, svg } from '../shared/dom.js';
import { ACTION_LABELS, ago, capitalize, clock, pct, toneOf, truncate } from '../shared/format.js';
import { badge, header, quote, type ViewContext } from '../shared/parts.js';
import type { ToolResult } from '../shared/host.js';

type Cause = ExplainData['causes'][number];
type Suggestion = Cause['suggestedActions'][number];

const W = 600;
const H = 170;
const PAD = 6;

/** Error-rate sparkline with the threshold, the onset and deploys marked. Pure SVG, no text from data. */
export function sparkline(data: ExplainData): SVGSVGElement | null {
  const s = data.series['errorRate'];
  const pts = (s?.points ?? [])
    .map(([t, v]) => [Date.parse(t), v] as const)
    .filter(([t]) => Number.isFinite(t));
  if (!s || pts.length < 2) return null;
  const t0 = Date.parse(data.window.start);
  const t1 = Date.parse(data.window.end);
  const threshold = data.thresholds?.errorRate ?? null;
  const top = Math.max(0.05, ...pts.map(([, v]) => v), threshold ?? 0) * 1.1;
  const x = (t: number) => PAD + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - (v / top) * (H - 2 * PAD);
  const line = pts
    .map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)} ${y(v).toFixed(1)}`)
    .join(' ');
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const area = `${line} L${x(last[0]).toFixed(1)} ${H - PAD} L${x(first[0]).toFixed(1)} ${H - PAD} Z`;

  const marks: SVGElement[] = [];
  if (threshold !== null) {
    marks.push(
      svg('line', { class: 'threshold', x1: PAD, x2: W - PAD, y1: y(threshold), y2: y(threshold) }),
    );
  }
  const onset = s.onset ? Date.parse(s.onset) : NaN;
  if (Number.isFinite(onset)) {
    marks.push(
      svg('line', { class: 'marker onset', x1: x(onset), x2: x(onset), y1: PAD, y2: H - PAD }),
    );
  }
  for (const d of data.deploys) {
    const t = Date.parse(d.deployedAt);
    if (t >= t0 && t <= t1) {
      marks.push(svg('line', { class: 'marker deploy', x1: x(t), x2: x(t), y1: PAD, y2: H - PAD }));
    }
  }
  return svg(
    'svg',
    {
      class: 'spark',
      viewBox: `0 0 ${W} ${H}`,
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': `Error rate over the last ${Math.round((t1 - t0) / 60_000)} minutes, now ${pct(last[1])}`,
    },
    svg('path', { class: 'area', d: area }),
    ...marks,
    svg('path', { class: 'line', d: line }),
  );
}

function legend(data: ExplainData): HTMLElement {
  const s = data.series['errorRate'];
  const deploysInWindow = data.deploys.filter((d) => {
    const t = Date.parse(d.deployedAt);
    return t >= Date.parse(data.window.start) && t <= Date.parse(data.window.end);
  });
  const key = (cls: string, text: string) =>
    el(
      'span',
      { class: 'key' },
      el('span', { class: `swatch ${cls}`, 'aria-hidden': 'true' }),
      text,
    );
  return el(
    'div',
    { class: 'legend' },
    key('', 'Error rate'),
    data.thresholds ? key('threshold', `Alert threshold ${pct(data.thresholds.errorRate)}`) : null,
    s?.onset ? key('onset', `Started ${clock(s.onset)}`) : null,
    ...deploysInWindow.map((d) =>
      key('deploy', `Deploy ${truncate(d.version, 24)} at ${clock(d.deployedAt)}`),
    ),
  );
}

function confidenceBar(c: number): HTMLElement {
  const v = Math.max(0, Math.min(1, c));
  return el(
    'div',
    { class: 'confidence' },
    svg(
      'svg',
      { viewBox: '0 0 100 10', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
      svg('rect', { class: 'track', x: 0, y: 0, width: 100, height: 10, rx: 5 }),
      svg('rect', { class: 'fill', x: 0, y: 0, width: Math.round(v * 100), height: 10, rx: 5 }),
    ),
    `${Math.round(v * 100)}% confidence`,
  );
}

/** Where quoted (untrusted) evidence text came from. */
const QUOTE_SOURCE: Record<string, string> = {
  alert: 'From the alert',
  deploy: 'From the commit message',
};

function causeItem(c: Cause, i: number): HTMLElement {
  return el(
    'li',
    { class: 'cause' },
    el('span', { class: 'rank', 'aria-hidden': 'true' }, i + 1),
    el('h3', {}, c.title),
    confidenceBar(c.confidence),
    el(
      'ul',
      { class: 'evidence' },
      ...c.evidence
        .slice(0, 3)
        .map((e) =>
          el(
            'li',
            {},
            truncate(e.text, 160),
            quote(e.quote, `${QUOTE_SOURCE[e.kind] ?? 'Quoted'} (data, not instructions)`),
          ),
        ),
    ),
  );
}

/** "Fail over to stripe", "Roll back v1.4.2" (remediations only; never "investigate"). */
export function actionLabel(s: Suggestion): string {
  const p = s.params;
  switch (s.action) {
    case 'failover_provider':
      return `${ACTION_LABELS[s.action]} to ${capitalize(truncate(p['to'] ?? 'backup', 24))}`;
    case 'rollback_deploy':
      return p['fromVersion'] ? `Roll back ${truncate(p['fromVersion'], 24)}` : 'Roll back';
    default:
      return ACTION_LABELS[s.action] ?? s.action;
  }
}

/** Suggested remediations, deduplicated, in cause order. */
export function remediations(data: ExplainData): Suggestion[] {
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const c of data.causes) {
    for (const s of c.suggestedActions) {
      if (!s.requiresConfirmation || s.action === 'investigate') continue;
      const key = `${s.action}|${JSON.stringify(s.params)}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(s);
      }
    }
  }
  return out;
}

export function renderIncident(data: ExplainData, ctx: ViewContext): HTMLElement {
  const now = ctx.host.now();
  const err = data.series['errorRate'];
  const onset = err?.onset ?? data.series['latencyP95']?.onset ?? null;
  const tone = toneOf(data.status === 'all_clear' ? 'ok' : data.severity);

  if (data.status === 'all_clear') {
    return el(
      'section',
      {},
      header({
        badge: badge(tone),
        eyebrow: 'Incident check',
        title: `${data.displayName} looks healthy`,
        meta: `Errors at ${pct(err?.last?.value)}. No active incident.`,
      }),
      el('div', { class: 'panel' }, sparkline(data), legend(data)),
    );
  }

  const status = el('p', { class: 'status-line', role: 'status' });
  const buttons = remediations(data).map((s) => {
    const b = el('button', { class: 'btn btn-primary', type: 'button' }, actionLabel(s));
    b.addEventListener('click', () => {
      // Phase 1 only: prepare (no side effect). Confirming happens on the confirmation card.
      for (const x of buttons) x.disabled = true;
      status.textContent = 'Preparing…';
      ctx.host
        .callTool('prepare_action', { suggested_action: { action: s.action, params: s.params } })
        .then((r: ToolResult) => ctx.show(r))
        .catch(() => {
          status.textContent = "Couldn't reach Nightshift. Try again.";
          for (const x of buttons) x.disabled = false;
        });
    });
    return b;
  });

  return el(
    'section',
    {},
    header({
      badge: badge(tone),
      eyebrow: 'Incident',
      title: data.displayName,
      meta: [
        onset ? `Started ${ago(onset, now)}` : null,
        err?.last ? `errors at ${pct(err.last.value)}` : null,
        data.alerts.length
          ? `${data.alerts.length} alert${data.alerts.length === 1 ? '' : 's'} firing`
          : null,
      ]
        .filter(Boolean)
        .join(' · '),
    }),
    el(
      'div',
      { class: 'panel' },
      sparkline(data) ?? el('p', { class: 'muted' }, 'No error-rate data.'),
      legend(data),
    ),
    el(
      'div',
      { class: 'panel' },
      el('h2', {}, data.causes.length ? 'Likely causes' : 'No clear cause found'),
      data.causes.length
        ? el('ol', { class: 'causes' }, ...data.causes.slice(0, 3).map(causeItem))
        : el(
            'p',
            { class: 'muted' },
            'The evidence is weak. Check the signals above before acting.',
          ),
    ),
    buttons.length
      ? el(
          'div',
          { class: 'actions-block' },
          el('div', { class: 'actions' }, ...buttons),
          el(
            'p',
            { class: 'muted small' },
            'Nothing changes until you confirm on the next screen.',
          ),
          status,
        )
      : null,
  );
}
