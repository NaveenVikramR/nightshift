#!/usr/bin/env node
// Trigger demo-target failure scenarios.
//   node infra/scripts/chaos.mjs <provider_outage|latency_spike|auth_bruteforce|webhook_spoofing>
//   node infra/scripts/chaos.mjs bad_deploy [delaySeconds]
//   node infra/scripts/chaos.mjs reset | state | route-provider <razorpay|stripe>
// Reads DEMO_ADMIN_TOKEN and DEMO_TARGET_URL from infra/.env (or the environment).
// bad_deploy also reads NIGHTSHIFT_URL and NIGHTSHIFT_INGEST_TOKEN: it reports the
// deploy to Nightshift like a CI system would, THEN arms demo-target, so the deploy
// timestamp always precedes the failure.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const envFile = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const token = process.env.DEMO_ADMIN_TOKEN;
const base = process.env.DEMO_TARGET_URL ?? 'http://127.0.0.1:18080';
const [command, arg] = process.argv.slice(2);

if (!token) {
  console.error(
    'DEMO_ADMIN_TOKEN is not set. Copy infra/.env.example to infra/.env and fill it in.',
  );
  process.exit(1);
}

const BAD_DEPLOY = {
  service: 'payments-api',
  version: 'v1.4.2',
  commitMessage: 'tune payment retry config',
  author: 'ci',
};

async function reportDeploy() {
  const url = process.env.NIGHTSHIFT_URL ?? 'http://127.0.0.1:3000';
  const ingestToken = process.env.NIGHTSHIFT_INGEST_TOKEN;
  if (!ingestToken) {
    console.error(
      'NIGHTSHIFT_INGEST_TOKEN is not set in infra/.env. Create one with: npm run token:new -- chaos-ci ingest',
    );
    process.exit(1);
  }
  let res;
  try {
    res = await fetch(`${url}/events/deploy`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ingestToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...BAD_DEPLOY, externalId: `chaos-bad-deploy-${Date.now()}` }),
    });
  } catch (err) {
    console.error(
      `Could not reach Nightshift at ${url} (${err.cause?.code ?? err.message}). Is it running?`,
    );
    process.exit(1);
  }
  const body = await res.text();
  if (!res.ok) {
    console.error(`Nightshift refused the deploy event (${res.status}): ${body}`);
    process.exit(1);
  }
  console.log(`deploy recorded -> ${body}`);
}

if (command === 'bad_deploy') await reportDeploy();

const request = {
  reset: { method: 'POST', path: '/admin/reset' },
  state: { method: 'GET', path: '/admin/state' },
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
