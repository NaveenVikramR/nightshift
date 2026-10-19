/**
 * MCP Apps cards (server side). The HTML is built from src/ui/view by
 * scripts/build-ui.mjs into dist-ui/ and served as ui:// resources; tools link
 * to them with _meta.ui.resourceUri. Cards are an addition: every tool still
 * returns its speak + data for voice-only clients.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/server';
import { RESOURCE_MIME_TYPE, registerAppResource } from '@modelcontextprotocol/ext-apps/server';
import { log } from '../lib/log.js';

export const CARDS = {
  incident: { uri: 'ui://nightshift/incident.html', title: 'Incident card' },
  confirm: { uri: 'ui://nightshift/confirm.html', title: 'Confirmation card' },
  security: { uri: 'ui://nightshift/security.html', title: 'Security scorecard' },
  brief: { uri: 'ui://nightshift/brief.html', title: 'Ops brief card' },
} as const;

export type CardId = keyof typeof CARDS;

/** src/ui/cards.ts and dist/ui/cards.js are both two levels below apps/server. */
const DIST_UI = fileURLToPath(new URL('../../dist-ui/', import.meta.url));

const FALLBACK = (id: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>Nightshift</title>` +
  `<body style="font-family:system-ui;background:#0b0f17;color:#f2f5fa;padding:24px">` +
  `<p>The ${id} card is not built. Run <code>npm run build:ui -w @nightshift/server</code>.</p></body></html>`;

let cache: Map<CardId, string> | undefined;

/** Reads the built cards once (missing build: a plain fallback page and one warning). */
export function cardHtml(id: CardId, dir = DIST_UI): string {
  if (!cache) {
    cache = new Map();
    const missing: string[] = [];
    for (const key of Object.keys(CARDS) as CardId[]) {
      try {
        cache.set(key, readFileSync(`${dir}${key}.html`, 'utf8'));
      } catch {
        missing.push(key);
        cache.set(key, FALLBACK(key));
      }
    }
    if (missing.length) log.warn('cards not built; serving a fallback page', { missing });
  }
  return cache.get(id)!;
}

/** Registers every card as a ui:// resource (MCP Apps, text/html;profile=mcp-app). */
export function registerCards(server: Pick<McpServer, 'registerResource'>): void {
  for (const [id, card] of Object.entries(CARDS) as [CardId, (typeof CARDS)[CardId]][]) {
    registerAppResource(
      server,
      card.title,
      card.uri,
      {
        description: `Nightshift ${card.title.toLowerCase()} (self-contained HTML; data comes only from the tool result).`,
        mimeType: RESOURCE_MIME_TYPE,
        // No connect/resource/frame domains: the card makes no network requests.
        _meta: { ui: { csp: {}, prefersBorder: false } },
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: RESOURCE_MIME_TYPE,
            text: cardHtml(id),
            _meta: { ui: { csp: {}, prefersBorder: false } },
          },
        ],
      }),
    );
  }
}
