#!/usr/bin/env node
// Trigger demo-target failure scenarios.
//   node infra/scripts/chaos.mjs <provider_outage|latency_spike|auth_bruteforce|webhook_spoofing>
//   node infra/scripts/chaos.mjs bad_deploy [delaySeconds]
//   node infra/scripts/chaos.mjs security <weak|hardened>
//   node infra/scripts/chaos.mjs reset | state | route-provider <razorpay|stripe>
// Reads DEMO_ADMIN_TOKEN and DEMO_TARGET_URL from infra/.env (or the environment).
// bad_deploy and reset also read NIGHTSHIFT_URL and NIGHTSHIFT_INGEST_TOKEN: they
// report deploys to Nightshift like a CI system would, so the deploy history always
// matches what demo-target runs. bad_deploy reports BEFORE arming demo-target, so the
// deploy timestamp always precedes the failure.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { badDeployEvent, baselineEvent, reportDeploy, resetEvent } from './deployEvents.mjs';

const envFile = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const token = process.env.DEMO_ADMIN_TOKEN;
const base = process.env.DEMO_TARGET_URL ?? 'http://127.0.0.1:18080';
const nightshiftUrl = process.env.NIGHTSHIFT_URL ?? 'http://127.0.0.1:3000';
const ingestToken = process.env.NIGHTSHIFT_INGEST_TOKEN;
const [command, arg] = process.argv.slice(2);

const INGEST_HELP =
  'NIGHTSHIFT_INGEST_TOKEN is not set in infra/.env. Create one with: npm run token:new -- chaos-ci ingest';

if (!token) {
  console.error(
    'DEMO_ADMIN_TOKEN is not set. Copy infra/.env.example to infra/.env and fill it in.',
  );
  process.exit(1);
}

async function report(event) {
  try {
    return await reportDeploy({ url: nightshiftUrl, token: ingestToken, event });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (command === 'bad_deploy') {
  if (!ingestToken) {
    console.error(INGEST_HELP);
    process.exit(1);
  }
  // Baseline first (so a rollback has a target), then the bad deploy, then arm demo-target.
  await report(baselineEvent());
  console.log(`deploy recorded -> ${JSON.stringify(await report(badDeployEvent()))}`);
}

const request = {
  reset: { method: 'POST', path: '/admin/reset' },
  state: { method: 'GET', path: '/admin/state' },
  security: {
    method: 'POST',
    path: '/admin/security',
    body: JSON.stringify({ mode: arg }),
  },
  'route-provider': {
    method: 'POST',
    path: '/admin/route-provider',
    body: JSON.stringify({ provider: arg }),
  },
  bad_deploy: {
    method: 'POST',
    path: `/admin/chaos/bad_deploy${arg ? `?delaySeconds=${encodeURIComponent(arg)}` : ''}`,
  },
}[command] ?? { method: 'POST', path: `/admin/chaos/${encodeURIComponent(command ?? '')}` };

try {
  const res = await fetch(base + request.path, {
    method: request.method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(request.body && { body: request.body }),
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`demo-target answered ${res.status}: ${body}`);
    process.exit(1);
  }
  console.log(`${command}${arg ? ` ${arg}` : ''} -> ${body}`);
} catch (err) {
  console.error(
    `Could not reach demo-target at ${base} (${err.cause?.code ?? err.message}). Is the stack up?`,
  );
  process.exit(1);
}

// reset puts demo-target back on v1.4.1: tell the deploy history, or say why we couldn't.
if (command === 'reset') {
  if (!ingestToken) {
    console.warn(`warning: deploy history not updated. ${INGEST_HELP}`);
  } else {
    try {
      const answer = await reportDeploy({
        url: nightshiftUrl,
        token: ingestToken,
        event: resetEvent(),
      });
      console.log(`deploy recorded -> ${answer.version} (${answer.environment})`);
    } catch (err) {
      console.warn(`warning: deploy history not updated. ${err.message}`);
    }
  }
}
