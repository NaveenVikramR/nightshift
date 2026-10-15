#!/usr/bin/env node
// Trigger demo-target failure scenarios.
//   node infra/scripts/chaos.mjs <provider_outage|latency_spike|auth_bruteforce|webhook_spoofing>
//   node infra/scripts/chaos.mjs reset | state | route-provider <razorpay|stripe>
// Reads DEMO_ADMIN_TOKEN and DEMO_TARGET_URL from infra/.env (or the environment).
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

const request = {
  reset: { method: 'POST', path: '/admin/reset' },
  state: { method: 'GET', path: '/admin/state' },
  'route-provider': {
    method: 'POST',
    path: '/admin/route-provider',
    body: JSON.stringify({ provider: arg }),
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
