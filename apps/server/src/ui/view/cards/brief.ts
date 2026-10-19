import type { OpsBriefData } from '../../../tools/get_ops_brief.js';
import { el } from '../shared/dom.js';
import { ago, clock, capitalize, plural, toneOf, truncate, type Tone } from '../shared/format.js';
import { toneIcon } from '../shared/icons.js';
import { badge, header, type ViewContext } from '../shared/parts.js';
import { gradeTone } from './security.js';

function tile(opts: {
  label: string;
  tone: Tone;
  value: string;
  detail?: string | null;
}): HTMLElement {
  const border = opts.tone === 'crit' || opts.tone === 'warn' ? ` tone-border-${opts.tone}` : '';
  return el(
    'article',
    { class: `tile${border}` },
    el('p', { class: 'label' }, opts.label),
    el('p', { class: `value status-line fg-${opts.tone}` }, toneIcon(opts.tone), opts.value),
    opts.detail ? el('p', { class: 'detail' }, opts.detail) : null,
  );
}

const unavailable = (label: string) =>
  tile({ label, tone: 'info', value: 'Unavailable', detail: "Couldn't check right now." });

export function overallTone(d: OpsBriefData): Tone {
  const statuses = d.services.map((s) => s.status);
  const sec = d.security.ok && d.security.value ? gradeTone(d.security.value.grade) : 'ok';
  if (
    statuses.includes('critical') ||
    (d.alerts.ok && d.alerts.value.worst?.severity === 'critical') ||
    sec === 'crit'
  ) {
    return 'crit';
  }
  if (statuses.includes('degraded') || (d.alerts.ok && d.alerts.value.firing > 0) || sec === 'warn')
    return 'warn';
  return 'ok';
}

/** What needs attention, in a few words (the badge already says how bad). */
export function headline(d: OpsBriefData): string {
  const names = (status: string) =>
    d.services.filter((s) => s.status === status).map((s) => s.displayName);
  const join = (xs: string[]) => (xs.length <= 2 ? xs.join(' and ') : `${xs.length} services`);
  const crit = names('critical');
  if (crit.length) return `${join(crit)} ${crit.length === 1 ? 'is' : 'are'} critical`;
  const degraded = names('degraded');
  if (degraded.length) return `${join(degraded)} ${degraded.length === 1 ? 'is' : 'are'} degraded`;
  const firing = d.alerts.ok ? d.alerts.value.firing : 0;
  if (firing) return plural(firing, 'alert') + ' firing';
  const sec = d.security.ok ? d.security.value : null;
  if (sec && gradeTone(sec.grade) !== 'ok') return `Security grade ${sec.grade}`;
  return 'Everything looks good';
}

export function renderBrief(d: OpsBriefData, ctx: ViewContext): HTMLElement {
  const tone = overallTone(d);
  const label =
    tone === 'crit' ? 'Needs attention' : tone === 'warn' ? 'Worth a look' : 'All clear';
  const tiles: HTMLElement[] = d.services.map((s) => {
    const t = toneOf(s.available ? s.status : 'unknown');
    return tile({
      label: s.displayName,
      tone: t.tone,
      value: s.available ? t.label : 'Unknown',
      detail: [
        s.activeProvider ? `via ${capitalize(s.activeProvider)}` : null,
        s.reasons[0] ? truncate(s.reasons[0], 80) : null,
      ]
        .filter(Boolean)
        .join(' · '),
    });
  });

  tiles.push(
    d.alerts.ok
      ? tile({
          label: 'Alerts',
          tone: d.alerts.value.firing === 0 ? 'ok' : toneOf(d.alerts.value.worst?.severity).tone,
          value:
            d.alerts.value.firing === 0
              ? 'None firing'
              : plural(d.alerts.value.firing, 'firing', 'firing'),
          detail: d.alerts.value.worst ? `Worst: ${truncate(d.alerts.value.worst.name, 60)}` : null,
        })
      : unavailable('Alerts'),
  );
  tiles.push(
    d.incidents.ok
      ? (() => {
          const open = d.incidents.value.open;
          const first = open[0];
          return tile({
            label: 'Open incident',
            tone: open.length === 0 ? 'ok' : toneOf(first?.severity).tone,
            value: open.length === 0 ? 'None' : plural(open.length, 'open', 'open'),
            detail: first
              ? `${truncate(first.title, 60)} · opened ${ago(first.openedAt, ctx.host.now())}`
              : null,
          });
        })()
      : unavailable('Open incident'),
  );
  tiles.push(
    d.security.ok
      ? d.security.value
        ? tile({
            label: 'Security',
            tone: gradeTone(d.security.value.grade),
            value: `Grade ${d.security.value.grade}`,
            detail: `Scanned ${ago(d.security.value.scannedAt, ctx.host.now())}`,
          })
        : tile({
            label: 'Security',
            tone: 'info',
            value: 'No scan yet',
            detail: 'Ask for a security scan.',
          })
      : unavailable('Security'),
  );
  tiles.push(
    d.deploys.ok
      ? tile({
          label: 'Deploys today',
          tone: 'info',
          value: d.deploys.value.last24h === 0 ? 'None' : plural(d.deploys.value.last24h, 'deploy'),
          detail: 'Last 24 hours',
        })
      : unavailable('Deploys today'),
  );

  return el(
    'section',
    {},
    header({
      badge: badge({ tone, label }),
      eyebrow: 'Ops brief',
      title: capitalize(headline(d)),
      meta: `Updated ${clock(d.generatedAt)}`,
    }),
    el('div', { class: 'tiles' }, ...tiles),
  );
}
