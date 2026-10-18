#!/usr/bin/env node
// Validate the Prometheus config + alert rules (promtool) and the Alertmanager
// config (amtool) with the same pinned images the stack uses. Needs Docker.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const infra = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (args) => execFileSync('docker', args, { stdio: 'inherit' });

run([
  'run',
  '--rm',
  '--entrypoint',
  'promtool',
  '-v',
  `${join(infra, 'prometheus')}:/etc/prometheus:ro`,
  'prom/prometheus:v3.15.0',
  'check',
  'config',
  '/etc/prometheus/prometheus.yml',
]);
run([
  'run',
  '--rm',
  '--entrypoint',
  'amtool',
  '-v',
  `${join(infra, 'alertmanager')}:/etc/alertmanager:ro`,
  'prom/alertmanager:v0.34.1',
  'check-config',
  '/etc/alertmanager/alertmanager.yml',
  '/etc/alertmanager/alertmanager.prod.yml',
]);
console.log('Prometheus and Alertmanager configs are valid.');
