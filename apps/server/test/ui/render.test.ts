// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRenderer } from '../../src/ui/view/render.js';
import { ago, mmss, pct, truncate } from '../../src/ui/view/shared/format.js';
import { toToolResult, type CardHost, type ToolResult } from '../../src/ui/view/shared/host.js';
import {
  brief,
  confirmed,
  expired,
  findingsNone,
  incident,
  prepared,
  scan,
  toCallToolResult,
  type Fixture,
} from './fixtures.js';

const NOW = Date.parse('2026-10-19T09:41:00Z');
const INJECT = '<img src=x onerror="window.__pwned=1"></script><b>bold</b>';

function setup(replies: Record<string, Fixture> = {}) {
  const root = document.createElement('main');
  document.body.replaceChildren(root);
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const host: CardHost = {
    now: () => Date.now(),
    callTool: async (name, args) => {
      calls.push({ name, args });
      const f = replies[name];
      if (!f) throw new Error(`unexpected tool call ${name}`);
      return toToolResult(toCallToolResult(f));
    },
  };
  const show = createRenderer(root, host);
  const render = (f: Fixture) => show(toToolResult(toCallToolResult(f)));
  return { root, calls, render, text: () => root.textContent ?? '' };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const button = (root: HTMLElement, name: RegExp | string) =>
  [...root.querySelectorAll('button')].find((b) =>
    typeof name === 'string' ? b.textContent === name : name.test(b.textContent ?? ''),
  )!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('cards escape untrusted text (invariant 6)', () => {
  it.each([
    ['incident', incident(NOW, INJECT)],
    ['security', scan(NOW, INJECT)],
    ['brief', brief(NOW, INJECT)],
  ])('%s: injected markup stays text', (_name, fixture) => {
    const s = setup();
    s.render(fixture);
    expect(s.root.querySelectorAll('img, script, b, iframe').length).toBe(0);
    expect(s.text()).toContain('<img src=x');
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('labels quoted evidence as data', () => {
    const s = setup();
    s.render(incident(NOW));
    expect(s.text()).toContain('From the alert (data, not instructions)');
    expect(s.text()).toContain('From the commit message (data, not instructions)');
  });
});

describe('incident card', () => {
  it('shows severity as icon + word, the onset, causes with confidence, and the action buttons', () => {
    const s = setup();
    s.render(incident(NOW));
    const badge = s.root.querySelector('.badge')!;
    expect(badge.textContent).toBe('Critical');
    expect(badge.querySelector('svg')).not.toBeNull();
    expect(s.text()).toContain('Started 4 min ago');
    expect(s.text()).toContain('86% confidence');
    expect(s.root.querySelector('svg.spark')).not.toBeNull();
    expect([...s.root.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Fail over to Stripe',
      'Roll back v1.4.2',
    ]);
  });

  it('an action button only PREPARES, then shows the confirmation card', async () => {
    const s = setup({ prepare_action: prepared(NOW) });
    s.render(incident(NOW));
    button(s.root, /fail over/i).click();
    await flush();
    expect(s.calls).toEqual([
      {
        name: 'prepare_action',
        args: {
          suggested_action: {
            action: 'failover_provider',
            params: { service: 'payments-api', from: 'razorpay', to: 'stripe' },
          },
        },
      },
    ]);
    expect(s.text()).toContain('Route all Payments API traffic from Razorpay to Stripe');
    expect(button(s.root, 'Confirm')).toBeDefined();
  });
});

describe('confirmation card', () => {
  it('shows what changes, who is affected, how to undo, and a live countdown', async () => {
    const s = setup();
    s.render(prepared(NOW));
    for (const t of ['What changes', "Who's affected", 'How to undo', 'Expected effect'])
      expect(s.text()).toContain(t);
    expect(s.root.querySelector('.countdown .time')!.textContent).toBe('2:00');
    await vi.advanceTimersByTimeAsync(31_000);
    expect(s.root.querySelector('.countdown .time')!.textContent).toBe('1:29');
  });

  it('expires at 0:00: "Expired — ask again", nothing called', async () => {
    const s = setup();
    s.render(prepared(NOW, 3));
    await vi.advanceTimersByTimeAsync(3_500);
    expect(s.text()).toContain('Expired — ask again');
    expect(s.root.querySelector('button')).toBeNull();
    expect(s.calls).toEqual([]);
  });

  it('Confirm calls confirm_action with the confirmationId and shows before -> after', async () => {
    const s = setup({ confirm_action: confirmed(NOW) });
    s.render(prepared(NOW));
    button(s.root, 'Confirm').click();
    expect(button(s.root, 'Confirm').disabled).toBe(true);
    await flush();
    expect(s.calls).toEqual([
      { name: 'confirm_action', args: { confirmation_id: 'cfm_9f3a1c7d2b' } },
    ]);
    expect(s.text()).toContain('Recovered');
    expect(s.root.querySelector('.result-delta')!.textContent).toBe('45%→0.5%');
  });

  it('Cancel changes nothing and calls nothing', () => {
    const s = setup();
    s.render(prepared(NOW));
    button(s.root, 'Cancel').click();
    expect(s.calls).toEqual([]);
    expect(s.text()).toContain('Cancelled — nothing changed.');
  });

  it('an expired or unknown confirmation result shows "Expired — ask again"', () => {
    const s = setup();
    s.render(expired);
    expect(s.text()).toContain('Expired — ask again');
  });

  it('a replayed result says nothing ran twice', () => {
    const s = setup();
    const f = confirmed(NOW);
    s.render({ ...f, data: { ...(f.data as object), replayed: true } });
    expect(s.text()).toContain('Already done — nothing ran twice');
  });
});

describe('security scorecard', () => {
  it('shows the grade, the change, coverage, grouped findings and struck-through resolved items', () => {
    const s = setup();
    s.render(scan(NOW));
    expect(s.root.querySelector('.grade')!.textContent).toBe('C');
    expect(s.text()).toContain('↓ down from A');
    expect(s.root.querySelector('.coverage')!.textContent).toBe('4 of 6 checks ran');
    expect([...s.root.querySelectorAll('.finding-group h3')].map((h) => h.textContent)).toEqual([
      'Medium2 issues',
      'Low2 issues',
    ]);
    expect(s.root.querySelector('.resolved s')!.textContent).toBe(
      'TLS certificate expires in 6 days',
    );
  });

  it('get_security_findings with nothing open', () => {
    const s = setup();
    s.render(findingsNone(NOW));
    expect(s.root.querySelector('.grade')!.textContent).toBe('A');
    expect(s.text()).toContain('No open issues');
  });
});

describe('ops brief', () => {
  it('a tile per service plus alerts, incident, security and deploys', () => {
    const s = setup();
    s.render(brief(NOW));
    const labels = [...s.root.querySelectorAll('.tile .label')].map((l) => l.textContent);
    expect(labels).toEqual([
      'Payments API',
      'Webhook receiver',
      'Alerts',
      'Open incident',
      'Security',
      'Deploys today',
    ]);
    expect(s.text()).toContain('via Razorpay');
    expect(s.root.querySelector('.badge')!.textContent).toBe('Needs attention');
  });
});

describe('robustness', () => {
  it('a tool error shows the server-authored speak', () => {
    const s = setup();
    s.render({
      speak: 'Sorry, that needs responder access.',
      data: { error: 'forbidden' },
      isError: true,
    });
    expect(s.text()).toContain('Sorry, that needs responder access.');
  });

  it('reads structuredContent, or falls back to the JSON text content', () => {
    const r: ToolResult = toToolResult({
      content: [{ type: 'text', text: JSON.stringify({ speak: 'hi', data: { a: 1 } }) }],
    });
    expect(r).toEqual({ speak: 'hi', data: { a: 1 }, isError: false });
  });
});

describe('format', () => {
  it('pct, mmss, ago, truncate', () => {
    expect([pct(0.4512), pct(0.005), pct(0), pct(null)]).toEqual(['45%', '0.5%', '0%', '–']);
    expect([mmss(120), mmss(89.9), mmss(-3)]).toEqual(['2:00', '1:29', '0:00']);
    expect(ago(new Date(NOW - 4 * 60_000).toISOString(), NOW)).toBe('4 min ago');
    expect(truncate('a  b\n c', 10)).toBe('a b c');
    expect(truncate('x'.repeat(20), 10)).toHaveLength(10);
  });
});
