#!/usr/bin/env node
// Show whether the local docker stack is up: each container's state/health
// (docker compose ps) and an HTTP readiness probe per service port.
//   node infra/scripts/stack-status.mjs              full report (npm run stack:status)
//   node infra/scripts/stack-status.mjs --preflight  probes only; prints one line and
//                                                    exits 1 if anything is down
// Exit code: 0 when every probe answers, 1 otherwise.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const infra = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(infra, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const demoUrl =
  process.env.DEMO_TARGET_URL ?? `http://127.0.0.1:${process.env.DEMO_TARGET_PORT ?? '18080'}`;
const probes = [
  { name: 'demo-target', url: `${demoUrl}/healthz` },
  { name: 'prometheus', url: `${process.env.PROMETHEUS_URL ?? 'http://127.0.0.1:9090'}/-/ready` },
  {
    name: 'alertmanager',
    url: `${process.env.ALERTMANAGER_URL ?? 'http://127.0.0.1:9093'}/-/ready`,
  },
];

async function probe(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok ? 'ok' : `HTTP ${res.status}`;
  } catch {
    return 'unreachable';
  }
}

const results = await Promise.all(probes.map(async (p) => ({ ...p, result: await probe(p.url) })));
const down = results.filter((r) => r.result !== 'ok');
// Set exitCode instead of calling process.exit(): exiting while fetch's keep-alive
// sockets are still closing trips a libuv assertion on Windows (UV_HANDLE_CLOSING).
process.exitCode = down.length === 0 ? 0 : 1;

if (process.argv.includes('--preflight')) {
  if (down.length > 0) {
    console.error(
      `stack not running (${down.map((r) => r.name).join(', ')} down) — run npm run stack:up`,
    );
  }
} else {
  report();
}

function report() {
  // Containers, as docker compose sees them.
  let containers;
  try {
    const out = execFileSync(
      'docker',
      ['compose', '-f', join(infra, 'docker-compose.yml'), 'ps', '--all', '--format', 'json'],
      { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    // Compose prints either a JSON array or one JSON object per line, depending on version.
    containers = out.startsWith('[')
      ? JSON.parse(out)
      : out
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
  } catch {
    containers = undefined;
  }

  console.log('Containers:');
  if (containers === undefined) {
    console.log('  docker is not responding (is Docker Desktop running?)');
  } else {
    for (const name of probes.map((p) => p.name)) {
      const c = containers.find((x) => x.Service === name);
      const state = c ? `${c.State}${c.Health ? ` (${c.Health})` : ''}` : 'missing';
      console.log(`  ${name.padEnd(13)} ${state}`);
    }
  }

  console.log('Ports:');
  for (const r of results) console.log(`  ${r.name.padEnd(13)} ${r.result.padEnd(12)} ${r.url}`);

  console.log(
    down.length === 0 ? 'Stack is healthy.' : 'Stack is NOT healthy — run npm run stack:up',
  );
}
