import type { ConfirmData } from '../../../tools/confirm_action.js';
import type { PreparedData } from '../../../tools/prepare_action.js';
import { el } from '../shared/dom.js';
import { mmss, pct, toneOf } from '../shared/format.js';
import { clockIcon } from '../shared/icons.js';
import { badge, errorView, header, type ViewContext } from '../shared/parts.js';
import type { ToolResult } from '../shared/host.js';

const EXPIRED_CODES = new Set(['confirmation_expired', 'unknown_confirmation']);

/** "Expired — ask again": nothing ran, a fresh prepare is needed. */
export function expiredView(): HTMLElement {
  return el(
    'section',
    {},
    header({
      badge: el('span', { class: 'badge tone-info' }, clockIcon(), 'Expired'),
      eyebrow: 'Confirmation',
      title: 'Expired — ask again',
      meta: 'Nothing was changed. Confirmations last two minutes and work once.',
    }),
  );
}

function facts(p: PreparedData): HTMLElement {
  const row = (term: string, desc: string) => [el('dt', {}, term), el('dd', {}, desc)];
  return el(
    'dl',
    { class: 'facts panel' },
    ...row('What changes', p.summary.changes),
    ...row("Who's affected", p.summary.affected),
    ...row('How to undo', p.summary.undo),
    ...row('Expected effect', p.summary.expectedEffect),
  );
}

/** Phase 1 result: what will happen, a live countdown, Confirm / Cancel. */
export function renderPrepared(p: PreparedData, ctx: ViewContext): HTMLElement {
  const expiresAt = Date.parse(p.expiresAt);
  const time = el('span', { class: 'time' }, '');
  const countdown = el(
    'p',
    { class: 'countdown', role: 'timer', 'aria-live': 'off' },
    time,
    el('span', { class: 'muted' }, 'left to confirm'),
  );
  const status = el('p', { class: 'status-line', role: 'status' });
  const confirm = el('button', { class: 'btn btn-danger', type: 'button' }, 'Confirm');
  const cancel = el('button', { class: 'btn', type: 'button' }, 'Cancel');
  const body = el(
    'section',
    {},
    header({
      badge: badge({ tone: 'warn', label: 'Warning' }, 'Needs your OK'),
      eyebrow: 'Confirm action',
      title: p.summary.changes,
    }),
    facts(p),
    el(
      'div',
      { class: 'panel' },
      countdown,
      el('div', { class: 'actions' }, confirm, cancel),
      status,
    ),
  );

  let done = false;
  const tick = () => {
    const left = (expiresAt - ctx.host.now()) / 1000;
    time.textContent = mmss(left);
    countdown.classList.toggle('low', left <= 30);
    if (left <= 0 && !done) {
      done = true;
      ctx.show({ speak: '', data: { error: 'confirmation_expired' }, isError: true });
    }
  };
  tick();
  const timer = setInterval(tick, 250);
  ctx.onDispose(() => clearInterval(timer));

  confirm.addEventListener('click', () => {
    if (done) return;
    done = true;
    confirm.disabled = true;
    cancel.disabled = true;
    status.textContent = 'Working… checking the result takes up to 20 seconds.';
    // The click is the explicit "yes" (invariant 1). The server re-checks everything.
    ctx.host
      .callTool('confirm_action', { confirmation_id: p.confirmationId })
      .then((r: ToolResult) => ctx.show(r))
      .catch(() => {
        status.textContent = "Couldn't reach Nightshift. Ask again to check what happened.";
      });
  });
  cancel.addEventListener('click', () => {
    done = true;
    clearInterval(timer);
    confirm.disabled = true;
    cancel.disabled = true;
    status.textContent = 'Cancelled — nothing changed.';
  });
  return body;
}

const OUTCOME: Record<string, { tone: 'ok' | 'warn' | 'crit' | 'info'; label: string }> = {
  recovered: { tone: 'ok', label: 'Recovered' },
  recovering: { tone: 'warn', label: 'Recovering' },
  no_improvement: { tone: 'crit', label: 'No improvement yet' },
  unknown: { tone: 'info', label: 'Not verified' },
};

/** Phase 2 result: what ran and the measured effect (before -> after). */
export function renderConfirmed(result: ToolResult, ctx: ViewContext): HTMLElement {
  void ctx;
  const c = result.data as unknown as ConfirmData;
  if (c.status !== 'succeeded') {
    return el(
      'section',
      {},
      header({
        badge: badge(toneOf('critical'), c.status === 'refused' ? 'Refused' : 'Failed'),
        eyebrow: 'Action result',
        title: result.speak || 'The action did not complete.',
      }),
    );
  }
  const v = c.verification;
  const outcome = OUTCOME[v?.outcome ?? 'unknown'] ?? OUTCOME['unknown']!;
  return el(
    'section',
    {},
    header({
      badge: badge({ tone: outcome.tone, label: outcome.label }),
      eyebrow: c.replayed ? 'Already done — nothing ran twice' : 'Action result',
      title: result.speak,
    }),
    v
      ? el(
          'div',
          { class: 'panel' },
          el('h2', {}, 'Error rate, measured'),
          el(
            'p',
            {
              class: 'result-delta',
              'aria-label': `Errors from ${pct(v.before)} to ${pct(v.after)}`,
            },
            el('span', {}, pct(v.before)),
            el('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'),
            el('span', { class: `fg-${outcome.tone}` }, pct(v.after)),
          ),
          el('p', { class: 'muted small' }, `Alert threshold ${pct(v.threshold)}.`),
        )
      : null,
  );
}

/** Any result a confirmation card can receive. */
export function renderConfirmCard(result: ToolResult, ctx: ViewContext): HTMLElement {
  const code = typeof result.data['error'] === 'string' ? result.data['error'] : null;
  if (result.isError && code && EXPIRED_CODES.has(code)) return expiredView();
  if (result.isError) return errorView(result);
  if ('summary' in result.data && 'expiresAt' in result.data) {
    return renderPrepared(result.data as unknown as PreparedData, ctx);
  }
  if ('status' in result.data && 'confirmationId' in result.data)
    return renderConfirmed(result, ctx);
  return errorView(result);
}
