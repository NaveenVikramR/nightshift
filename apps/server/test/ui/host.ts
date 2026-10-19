/**
 * A minimal MCP Apps host for screenshots and browser tests. It uses the real
 * ext-apps AppBridge + PostMessageTransport (the host side of the protocol),
 * loads a built card in a sandboxed iframe, sends a fixture tool result, and
 * answers the card's tool calls (prepare_action / confirm_action) from fixtures.
 *   /?scenario=incident&theme=dark&inject=1
 */
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import { confirmed, prepared, SCENARIOS, toCallToolResult } from './fixtures.js';

const INJECT = '<img src=x onerror="window.__pwned=1"></script><b>bold</b>';

declare global {
  interface Window {
    __calls: { name: string; arguments: unknown }[];
    __ready: boolean;
    __pwned?: number;
  }
}

const params = new URLSearchParams(location.search);
const name = (params.get('scenario') ?? 'incident') as keyof typeof SCENARIOS;
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const inject = params.get('inject') === '1' ? INJECT : '';
const scenario = SCENARIOS[name];

window.__calls = [];
window.__ready = false;
document.documentElement.dataset['theme'] = theme;

const frame = document.createElement('iframe');
frame.title = `Nightshift ${scenario.card} card`;
frame.setAttribute('sandbox', 'allow-scripts'); // like real hosts: no same-origin access
document.body.append(frame);

const bridge = new AppBridge(
  null,
  { name: 'nightshift-test-host', version: '1.0.0' },
  { serverTools: {} },
);
bridge.onsizechange = ({ height }) => {
  if (height) frame.style.height = `${Math.ceil(height)}px`;
};
bridge.oncalltool = async (p) => {
  window.__calls.push({ name: p.name, arguments: p.arguments });
  await new Promise((r) => setTimeout(r, 400));
  if (p.name === 'prepare_action') return toCallToolResult(prepared(Date.now()));
  if (p.name === 'confirm_action') return toCallToolResult(confirmed(Date.now()));
  return toCallToolResult({
    speak: 'Unknown tool.',
    data: { error: 'unknown_tool' },
    isError: true,
  });
};
bridge.oninitialized = () => {
  bridge.setHostContext({ theme });
  const fixture = (
    scenario.fixture as (now: number, inject?: string) => Parameters<typeof toCallToolResult>[0]
  )(Date.now(), inject);
  void bridge.sendToolResult(toCallToolResult(fixture)).then(() => {
    window.__ready = true;
  });
};

await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
frame.src = `/cards/${scenario.card}.html`;
