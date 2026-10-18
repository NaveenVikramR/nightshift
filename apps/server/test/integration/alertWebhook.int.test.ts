/**
 * Proactive alerts end to end against the local docker stack:
 * chaos -> Prometheus rule -> REAL Alertmanager webhook (infra/alertmanager/alertmanager.yml,
 * bearer from infra/secrets) -> this in-process Nightshift app on 127.0.0.1:3999
 * -> TelegramNotifier -> a fake Telegram Bot API on a random local port.
 *
 * Run: npm run stack:up && npm run test:integration
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TelegramNotifier } from '../../src/notify/notifier.js';
import { makeHarness } from '../helpers.js';

const infraEnv = resolve(__dirname, '../../../../infra/.env');
if (existsSync(infraEnv)) process.loadEnvFile(infraEnv);
const DEMO = process.env['DEMO_TARGET_URL'] ?? 'http://127.0.0.1:18080';
const DEMO_TOKEN = process.env['DEMO_ADMIN_TOKEN'] ?? '';
const SECRET = resolve(__dirname, '../../../../infra/secrets/alertmanager/webhook_token');
/** The second webhook URL in infra/alertmanager/alertmanager.yml. */
const RECEIVER_PORT = 3999;
const FAKE_BOT_TOKEN = 'fake-bot-token';

const telegram: { path: string; chatId: unknown; text: string }[] = [];
let fakeTelegram: Server;
let nightshift: Server;

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok((server.address() as AddressInfo).port));
  });
}

async function chaos(path: string): Promise<void> {
  const res = await fetch(`${DEMO}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${DEMO_TOKEN}` },
  });
  if (!res.ok) throw new Error(`demo-target ${path} -> ${res.status}`);
}

async function waitForMessage(what: RegExp, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = telegram.find((m) => what.test(m.text));
    if (hit) return hit.text;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`no Telegram message matching ${what} (got: ${JSON.stringify(telegram)})`);
}

beforeAll(async () => {
  if (!DEMO_TOKEN) throw new Error('DEMO_ADMIN_TOKEN missing: create infra/.env');
  if (!existsSync(SECRET)) throw new Error('webhook token missing: run npm run stack:up');
  const webhookToken = readFileSync(SECRET, 'utf8').trim();

  fakeTelegram = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const msg = JSON.parse(body) as { chat_id: unknown; text: string };
      telegram.push({ path: req.url ?? '', chatId: msg.chat_id, text: msg.text });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  });
  const tgPort = await listen(fakeTelegram);

  const h = makeHarness(
    // Alertmanager (in docker) reaches the host as host.docker.internal.
    { alertmanagerWebhookToken: webhookToken, allowedHosts: ['host.docker.internal'] },
    {
      notifier: new TelegramNotifier({
        apiUrl: `http://127.0.0.1:${tgPort}`,
        botToken: FAKE_BOT_TOKEN,
        chatId: '4242',
        timeoutMs: 5000,
      }),
    },
  );
  h.clock.now = Date.now();
  nightshift = createServer(h.ns.app);
  await listen(nightshift, RECEIVER_PORT).catch((e: unknown) => {
    throw new Error(`port ${RECEIVER_PORT} is busy (${String(e)}); stop whatever uses it`);
  });
  await chaos('/admin/reset');
});

afterAll(async () => {
  await chaos('/admin/reset').catch(() => undefined);
  await new Promise((r) => nightshift?.close(r));
  await new Promise((r) => fakeTelegram?.close(r));
});

describe('Alertmanager webhook -> Telegram (live)', () => {
  it('provider_outage pushes a critical message, and reset pushes the resolution', async () => {
    await chaos('/admin/chaos/provider_outage');
    const critical = await waitForMessage(/^🔴 Critical: .*payments API/, 180_000);
    expect(critical).toMatch(/Ask Alexa: what's wrong\?$/);

    await chaos('/admin/reset');
    const resolved = await waitForMessage(/^✅ Resolved: .*payments API/, 240_000);
    expect(resolved).toMatch(/^✅ Resolved: [a-z ]+ on payments API\.$/);

    // What reached "Telegram": the configured chat, the sendMessage method, no links.
    expect(telegram.every((m) => m.path === `/bot${FAKE_BOT_TOKEN}/sendMessage`)).toBe(true);
    expect(telegram.every((m) => m.chatId === '4242')).toBe(true);
    expect(telegram.map((m) => m.text).join(' ')).not.toMatch(/https?:/);
    const log = process.env['NS_SPEAK_LOG'];
    if (log) appendFileSync(log, `telegram: ${telegram.map((m) => m.text).join(' | ')}
`);
  });
});
