/**
 * Card entry point (bundled by scripts/build-ui.mjs into dist-ui/<card>.html).
 * Talks to the MCP Apps host with the ext-apps App class: receives the tool
 * result, renders it, and calls tools back through the host (prepare_action,
 * confirm_action). No network access of its own.
 */
import { App, applyDocumentTheme } from '@modelcontextprotocol/ext-apps';
import { mount } from './shared/dom.js';
import { toToolResult, type CardHost } from './shared/host.js';
import { createRenderer, waitingView } from './render.js';

const root = document.getElementById('app')!;
const card = document.body.dataset['card'] ?? 'card';
mount(root, waitingView(card));

const app = new App(
  { name: `nightshift-${card}-card`, version: '1.0.0' },
  {},
  { autoResize: true },
);

const host: CardHost = {
  now: () => Date.now(),
  callTool: async (name, args) => toToolResult(await app.callServerTool({ name, arguments: args })),
};
const show = createRenderer(root, host);

app.ontoolresult = (result) => show(toToolResult(result));
app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
};

app
  .connect()
  .then(() => {
    const theme = app.getHostContext()?.theme;
    if (theme) applyDocumentTheme(theme);
  })
  .catch(() => {
    // Opened outside an MCP Apps host: keep the waiting view.
  });
