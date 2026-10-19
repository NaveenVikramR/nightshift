// End-to-end: the simulated Alexa+ against the local stack (real Nightshift, real demo service).
//   ALEXA_TOKEN_FILE=<file with a responder token> npm run e2e -w @nightshift/alexa-sim
// Needs: npm run stack:up, the Nightshift dev server on :3000, the simulator on :3002
// (with DEMO_ADMIN_* set), and `npx playwright install chromium`.
// Flow: sign in -> demo "Provider outage" -> "What's wrong?" -> incident card ->
// "Fail over to Stripe" on the card -> confirmation card -> say "Yes" -> recovered.
// Saves docs/screenshots/alexa-*.png, docs/media/alexa-demo.webm and the conversation.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const shots = join(repo, 'docs', 'screenshots');
const media = join(repo, 'docs', 'media');
const BASE = process.env.ALEXA_URL ?? 'http://127.0.0.1:3002/alexa';
const AM = process.env.ALERTMANAGER_URL ?? 'http://127.0.0.1:9093';
const tokenFile = process.env.ALEXA_TOKEN_FILE;
if (!tokenFile)
  throw new Error('Set ALEXA_TOKEN_FILE to a file holding a responder token (never printed).');
const token = readFileSync(tokenFile, 'utf8').trim();

mkdirSync(shots, { recursive: true });
mkdirSync(media, { recursive: true });
const videoDir = join(media, 'tmp-video');
rmSync(videoDir, { recursive: true, force: true });

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? '✓' : '✗'} ${what}`);
  if (!ok) failures.push(what);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function alertsFiring() {
  for (let i = 0; i < 40; i++) {
    const alerts = await fetch(`${AM}/api/v2/alerts?active=true`)
      .then((r) => r.json())
      .catch(() => []);
    const names = alerts.map((a) => a.labels.alertname);
    if (names.includes('CircuitBreakerOpen') && names.includes('HighErrorRate')) return true;
    await sleep(5000);
  }
  return false;
}

/** The innermost frame showing a rendered Nightshift card whose text matches `re`. */
async function cardFrame(page, re, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      const text = await f
        .evaluate(() => document.querySelector('#app > section:not(.waiting)')?.textContent ?? '')
        .catch(() => '');
      if (text && re.test(text)) return f;
    }
    await sleep(400);
  }
  throw new Error(`no card matching ${re}`);
}

const browser = await chromium.launch({ channel: 'chromium' });
const context = await browser.newContext({
  viewport: { width: 1280, height: 860 },
  deviceScaleFactor: 1,
  recordVideo: { dir: videoDir, size: { width: 1280, height: 860 } },
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (/Content Security Policy/i.test(m.text()))
    pageErrors.push(
      `CSP: ${m.text().slice(0, 400)} @ ${m.location().url}:${m.location().lineNumber}`,
    );
});

try {
  // 1. Sign in.
  await page.goto(BASE);
  await page.getByLabel('Nightshift token').fill(token);
  await page.screenshot({ path: join(shots, 'alexa-1-login.png') });
  await page.getByRole('button', { name: 'Connect' }).click();
  await page.getByText('Ask Nightshift').waitFor();
  check(
    (await page.locator('.role').innerText()).toLowerCase() === 'responder',
    'signed in as responder',
  );
  check(!(await page.content()).includes(token), 'the token is not in the page after login');

  // 2. Break the demo service (judges' panel) and wait for the alerts.
  await page.getByText('Demo controls').click();
  await page.getByRole('button', { name: /Reset/ }).click();
  await page.locator('.demo-status', { hasText: /Demo service reset/ }).waitFor();
  await sleep(2000);
  await page.getByRole('button', { name: /Provider outage/ }).click();
  await page.locator('.demo-status', { hasText: /Provider outage started/ }).waitFor();
  check(await alertsFiring(), 'alerts firing (~30–60 s)');

  // 3. "What's wrong?" -> incident card.
  await page.getByRole('button', { name: "What's wrong?" }).click();
  const incident = await cardFrame(page, /Likely causes/);
  await sleep(800);
  check(/Critical/i.test(await page.locator('.captions').innerText()), 'spoken answer is critical');
  await page.screenshot({ path: join(shots, 'alexa-2-incident.png') });

  // 4. "Fail over to Stripe" on the card -> confirmation card (prepare only).
  await incident.getByRole('button', { name: /Fail over to Stripe/i }).click();
  const confirm = await cardFrame(page, /left to confirm/);
  check(true, 'card button -> confirmation card (prepare_action)');
  await sleep(800);
  await page.screenshot({ path: join(shots, 'alexa-3-confirm.png') });

  // 5. Say "Yes" (typed) -> confirm_action -> verified result.
  await page.getByLabel('Say or type').fill('Yes');
  await page.getByRole('button', { name: 'Send' }).click();
  await page
    .locator('.caption-nightshift', { hasText: /^NightshiftDone\./ })
    .waitFor({ timeout: 60_000 });
  const reply = (await page.locator('.caption-nightshift').last().innerText()).replace(
    /^Nightshift\s*/i,
    '',
  );
  check(/Recovered|Recovering|No improvement/i.test(reply), `verified: ${reply}`);
  void confirm;

  // 6. The judges' panel shows prepare -> yes -> confirm -> verification.
  await page.getByText('What Nightshift did').click();
  const panel = await page.locator('.trace').innerText();
  check(/Prepared — waiting for your yes/.test(panel), 'trace: prepared');
  check(/You said yes/.test(panel), 'trace: you said yes');
  check(/Confirmed and executed once/.test(panel), 'trace: confirmed');
  check(/Verified: /.test(panel), 'trace: verification');
  await sleep(500);
  await page.screenshot({ path: join(shots, 'alexa-4-verified.png'), fullPage: true });

  // 7. Phone layout.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(600);
  await page.screenshot({ path: join(shots, 'alexa-5-phone.png') });

  const conversation = await page.locator('.caption').allInnerTexts();
  writeFileSync(
    join(media, 'alexa-demo-conversation.txt'),
    `${conversation.map((c) => c.replace(/\n/, ': ')).join('\n')}\n`,
  );
  console.log('--- conversation');
  for (const c of conversation) console.log(c.replace(/\n/, ': '));
} finally {
  await page
    .getByText('Demo controls')
    .click()
    .catch(() => undefined);
  await page
    .getByRole('button', { name: /Reset/ })
    .click()
    .catch(() => undefined);
  await sleep(1500);
  await context.close();
  await browser.close();
  const video = (await import('node:fs')).readdirSync(videoDir).find((f) => f.endsWith('.webm'));
  if (video) renameSync(join(videoDir, video), join(media, 'alexa-demo.webm'));
  rmSync(videoDir, { recursive: true, force: true });
}

check(pageErrors.length === 0, `no page errors or CSP violations ${pageErrors.join(' | ')}`);
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nE2E passed. Saved docs/screenshots/alexa-*.png and docs/media/alexa-demo.webm');
