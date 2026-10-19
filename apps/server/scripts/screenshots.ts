/**
 * Renders every card in a real browser (Playwright + Chromium) inside the test
 * host (test/ui/host.ts: ext-apps AppBridge), checks the click-through flow and
 * escaping, and saves screenshots to docs/screenshots/ for the README and video.
 *   npm run screenshots -w @nightshift/server      (needs: npx playwright install chromium)
 * Not part of `npm test` (CI has no browser).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Frame, type Page } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(root, '..', '..', 'docs', 'screenshots');
const WIDTH = 1024;
const HEIGHT = 600;

execFileSync(process.execPath, [join(root, 'scripts', 'build-ui.mjs')], { stdio: 'inherit' });
const hostJs = (
  await build({
    entryPoints: [join(root, 'test', 'ui', 'host.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'warning',
  })
).outputFiles[0]!.text;

const HOST_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Nightshift test host</title>
<style>html{overflow-y:scroll}html,body{margin:0;background:#0b0f17}html[data-theme=light],html[data-theme=light] body{background:#f4f6f9}
iframe{display:block;width:100%;height:${HEIGHT}px;border:0}</style></head>
<body><script type="module" src="/host.js"></script></body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/')
    return void res.writeHead(200, { 'content-type': 'text/html' }).end(HOST_HTML);
  if (url.pathname === '/host.js') {
    return void res.writeHead(200, { 'content-type': 'text/javascript' }).end(hostJs);
  }
  const card = /^\/cards\/(incident|confirm|security|brief)\.html$/.exec(url.pathname)?.[1];
  if (card) {
    return void res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(readFileSync(join(root, 'dist-ui', `${card}.html`)));
  }
  res.writeHead(404).end();
});
await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

mkdirSync(outDir, { recursive: true });
// Full Chromium in new-headless mode (only `npx playwright install chromium` needed).
const browser = await chromium.launch({ channel: 'chromium' });
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '✓' : '✗'} ${what}`);
  if (!ok) failures.push(what);
};

async function open(scenario: string, opts: { theme?: string; inject?: boolean } = {}) {
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 2,
  });
  if (process.env['DEBUG_CARDS'])
    page.on('console', (m) => console.log(`  [${scenario}] ${m.text()}`));
  page.on('pageerror', (e) => failures.push(`${scenario}: page error ${e.message}`));
  const q = new URLSearchParams({
    scenario,
    theme: opts.theme ?? 'dark',
    ...(opts.inject && { inject: '1' }),
  });
  await page.goto(`${base}/?${q}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15_000 });
  const frame = page.frames().find((f) => f !== page.mainFrame())!;
  await frame.waitForSelector('#app > section:not(.waiting)', { timeout: 15_000 });
  await page.waitForTimeout(300); // let the size-changed notification settle
  return { page, frame };
}

async function shot(page: Page, name: string) {
  // Grow the viewport to the card (a full-page capture does not paint iframe content below the fold).
  const h = await page.evaluate(() =>
    Math.ceil(document.querySelector('iframe')!.getBoundingClientRect().height),
  );
  await page.setViewportSize({ width: WIDTH, height: Math.max(HEIGHT, h) });
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(outDir, `${name}.png`) });
  await page.setViewportSize({ width: WIDTH, height: HEIGHT });
  await page.waitForTimeout(200);
  console.log(`  saved docs/screenshots/${name}.png`);
}

const text = (f: Frame) => f.locator('#app').innerText();

// 1. Each card with realistic data (dark, the default).
for (const name of [
  'incident',
  'confirm',
  'confirm-verified',
  'confirm-expired',
  'security',
  'brief',
]) {
  const { page, frame } = await open(name);
  check((await text(frame)).length > 20, `${name}: renders`);
  await shot(page, name);
  await page.close();
}
{
  const { page } = await open('brief', { theme: 'light' });
  await shot(page, 'brief-light');
  await page.close();
}

// 2. The click-through flow: incident -> Fail over (prepare only) -> Confirm -> verified result.
{
  const { page, frame } = await open('incident');
  await frame.getByRole('button', { name: /fail over to stripe/i }).click();
  await frame.getByRole('button', { name: 'Confirm' }).waitFor();
  const calls1 = await page.evaluate(() => window.__calls.map((c) => c.name));
  check(calls1.join() === 'prepare_action', 'flow: the action button calls prepare_action only');
  await shot(page, 'flow-1-confirm');
  // After a screenshot resized the viewport, Playwright's hit-test uses a stale iframe offset;
  // dispatch the click on the button itself (the layout is checked in the screenshots).
  await frame.getByRole('button', { name: 'Confirm' }).dispatchEvent('click');
  await frame.getByText('Recovered', { exact: false }).first().waitFor();
  const calls2 = await page.evaluate(() => window.__calls);
  check(
    calls2[1]?.name === 'confirm_action' &&
      JSON.stringify(calls2[1].arguments) === JSON.stringify({ confirmation_id: 'cfm_9f3a1c7d2b' }),
    'flow: Confirm calls confirm_action with the confirmationId',
  );
  check(/45%\s*→\s*0\.5%/.test(await text(frame)), 'flow: shows before -> after error rate');
  await shot(page, 'flow-2-verified');
  await page.close();
}

// 3. Cancel never calls the server.
{
  const { page, frame } = await open('confirm');
  await frame.getByRole('button', { name: 'Cancel' }).click();
  check((await page.evaluate(() => window.__calls.length)) === 0, 'cancel: no tool call');
  check(/Cancelled — nothing changed/.test(await text(frame)), 'cancel: says nothing changed');
  await page.close();
}

// 4. Untrusted text stays text (invariant 6).
for (const name of ['incident', 'security', 'brief']) {
  const { page, frame } = await open(name, { inject: true });
  const injected = await frame.evaluate(
    () => document.querySelectorAll('#app img, #app b, #app script').length,
  );
  const pwned = await frame.evaluate(() => (window as { __pwned?: number }).__pwned ?? 0);
  check(injected === 0 && pwned === 0, `${name}: injected markup is not rendered`);
  check((await text(frame)).includes('<img src=x'), `${name}: injected text is shown literally`);
  await page.close();
}

await browser.close();
server.close();
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nAll card checks passed.');
