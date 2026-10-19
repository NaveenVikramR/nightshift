import type { ExplainData } from '../../tools/explain_incident.js';
import type { FindingsData } from '../../tools/get_security_findings.js';
import type { OpsBriefData } from '../../tools/get_ops_brief.js';
import type { ScanData } from '../../tools/run_security_scan.js';
import { renderBrief } from './cards/brief.js';
import { renderConfirmCard } from './cards/confirm.js';
import { renderIncident } from './cards/incident.js';
import { renderSecurity } from './cards/security.js';
import { el, mount } from './shared/dom.js';
import type { CardHost, ToolResult } from './shared/host.js';
import { clockIcon } from './shared/icons.js';
import { errorView, header, type ViewContext } from './shared/parts.js';

export type CardId = 'incident' | 'confirm' | 'security' | 'brief';

const has = (d: Record<string, unknown>, ...keys: string[]) => keys.every((k) => k in d);

/** Picks the view from the result's shape, so a card can follow the flow (incident -> confirm -> result). */
export function viewFor(result: ToolResult, ctx: ViewContext): HTMLElement {
  const d = result.data;
  if (
    has(d, 'summary', 'expiresAt') ||
    has(d, 'confirmationId', 'status') ||
    (result.isError && typeof d['error'] === 'string' && /confirmation/.test(d['error']))
  ) {
    return renderConfirmCard(result, ctx);
  }
  if (result.isError && d['error'] === 'scan_rate_limited') return recentScanView(result, ctx);
  if (result.isError) return errorView(result);
  if (has(d, 'causes', 'series')) return renderIncident(d as unknown as ExplainData, ctx);
  if (has(d, 'grade', 'checks'))
    return renderSecurity(d as unknown as ScanData | FindingsData, ctx);
  if (has(d, 'services', 'alerts', 'security'))
    return renderBrief(d as unknown as OpsBriefData, ctx);
  return errorView({ ...result, speak: result.speak || 'Nothing to show for this result.' });
}

/** A scan ran under a minute ago: offer the latest results (read-only, on click). */
function recentScanView(result: ToolResult, ctx: ViewContext): HTMLElement {
  const status = el('p', { class: 'status-line', role: 'status' });
  const show = el(
    'button',
    { class: 'btn btn-primary', type: 'button' },
    'Show the latest results',
  );
  show.addEventListener('click', () => {
    show.disabled = true;
    status.textContent = 'Loading…';
    ctx.host
      .callTool('get_security_findings', {})
      .then((r) => ctx.show(r))
      .catch(() => {
        show.disabled = false;
        status.textContent = "Couldn't reach Nightshift. Try again.";
      });
  });
  return el(
    'section',
    {},
    header({
      badge: el('span', { class: 'badge tone-info' }, clockIcon(), 'Just scanned'),
      eyebrow: 'Security',
      title: result.speak || 'A scan ran less than a minute ago.',
    }),
    el('div', { class: 'actions' }, show),
    status,
  );
}

/** Before the host sends a result (or when opened outside an MCP Apps host). */
export function waitingView(card: CardId | string): HTMLElement {
  const what: Record<string, string> = {
    incident: 'incident',
    confirm: 'confirmation',
    security: 'security scorecard',
    brief: 'ops brief',
  };
  return el(
    'section',
    { class: 'waiting' },
    el('p', { class: 'brand' }, 'Nightshift'),
    el('p', { class: 'muted' }, `Waiting for the ${what[card] ?? 'card'}…`),
  );
}

/**
 * Which host-pushed results (ontoolresult) to show. Hosts may deliver the same call
 * twice (seen in the ext-apps basic-host); a late duplicate must not wipe out what the
 * user is doing. Once the user started a flow from the card (prepare/confirm), host
 * results for the original call are ignored, and an error never replaces a good card.
 */
export function createResultGate() {
  let interacted = false;
  let shown: ToolResult | null = null;
  return {
    /** Call when the card itself calls a tool (the user clicked something). */
    markInteracted() {
      interacted = true;
    },
    accept(result: ToolResult): boolean {
      if (interacted) return false;
      if (shown && !shown.isError && result.isError) return false;
      shown = result;
      return true;
    },
  };
}

/** Renders results into `root`, cleaning up timers between renders. */
export function createRenderer(root: HTMLElement, host: CardHost): (r: ToolResult) => void {
  let disposers: (() => void)[] = [];
  const show = (result: ToolResult) => {
    for (const d of disposers) d();
    disposers = [];
    const ctx: ViewContext = { host, show, onDispose: (fn) => disposers.push(fn) };
    let view: HTMLElement;
    try {
      view = viewFor(result, ctx);
    } catch {
      view = errorView({
        speak: "This card couldn't be shown. The spoken answer is still correct.",
        data: {},
        isError: true,
      });
    }
    mount(root, view);
    root.scrollTo?.({ top: 0 });
  };
  return show;
}
