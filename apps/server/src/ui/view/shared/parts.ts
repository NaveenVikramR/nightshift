import { el, type Child } from './dom.js';
import { truncate, type ToneInfo } from './format.js';
import { toneIcon } from './icons.js';
import type { CardHost, ToolResult } from './host.js';

/** Severity pill: icon + word + colour (never colour alone). */
export function badge(t: ToneInfo, label = t.label): HTMLSpanElement {
  return el('span', { class: `badge tone-${t.tone}` }, toneIcon(t.tone), label);
}

export function header(opts: {
  badge?: HTMLElement;
  eyebrow?: string;
  title: string;
  meta?: Child;
}): HTMLElement {
  return el(
    'header',
    { class: 'head' },
    opts.badge,
    el(
      'div',
      {},
      opts.eyebrow ? el('p', { class: 'eyebrow' }, opts.eyebrow) : null,
      el('h1', {}, opts.title),
    ),
    opts.meta ? el('p', { class: 'meta' }, opts.meta) : null,
  );
}

/**
 * Untrusted text (alert annotations, commit messages, advisory text): shown as a
 * labelled quote, as text only, truncated. Accepts { untrusted: true, text } or a string.
 */
export function quote(value: unknown, label: string, max = 160): HTMLElement | null {
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'object' &&
          value !== null &&
          typeof (value as { text?: unknown }).text === 'string'
        ? (value as { text: string }).text
        : '';
  if (!text.trim()) return null;
  return el(
    'blockquote',
    { class: 'quote' },
    el('span', { class: 'quote-label' }, label),
    truncate(text, max),
  );
}

/** Context every card view gets. */
export interface ViewContext {
  host: CardHost;
  /** Re-render the card with another tool result (e.g. prepare -> confirm -> result). */
  show(result: ToolResult): void;
  /** Register cleanup (timers) run before the next render. */
  onDispose(fn: () => void): void;
}

/** A tool error (server-authored speak) as a card. */
export function errorView(result: ToolResult): HTMLElement {
  return el(
    'section',
    { class: 'card-body' },
    header({
      badge: badge({ tone: 'warn', label: 'Warning' }, 'Not done'),
      title: result.speak || 'Something went wrong.',
    }),
  );
}
