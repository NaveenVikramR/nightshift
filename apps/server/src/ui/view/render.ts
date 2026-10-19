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
import { errorView, type ViewContext } from './shared/parts.js';

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
  if (result.isError) return errorView(result);
  if (has(d, 'causes', 'series')) return renderIncident(d as unknown as ExplainData, ctx);
  if (has(d, 'grade', 'checks'))
    return renderSecurity(d as unknown as ScanData | FindingsData, ctx);
  if (has(d, 'services', 'alerts', 'security'))
    return renderBrief(d as unknown as OpsBriefData, ctx);
  return errorView({ ...result, speak: result.speak || 'Nothing to show for this result.' });
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
