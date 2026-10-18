#!/usr/bin/env node
// Local only: make sure Alertmanager and the Nightshift dev server share a
// webhook token. Creates infra/secrets/alertmanager/webhook_token (gitignored)
// and sets ALERTMANAGER_WEBHOOK_TOKEN in apps/server/.env if it isn't set.
// Never prints the token.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const secretFile = join(root, 'infra', 'secrets', 'alertmanager', 'webhook_token');
const serverEnv = join(root, 'apps', 'server', '.env');

const fromEnv = existsSync(serverEnv)
  ? /^ALERTMANAGER_WEBHOOK_TOKEN=(.+)$/m.exec(readFileSync(serverEnv, 'utf8'))?.[1]?.trim()
  : undefined;
const fromFile = existsSync(secretFile) ? readFileSync(secretFile, 'utf8').trim() : undefined;
const token = fromEnv || fromFile || randomBytes(32).toString('base64url');

mkdirSync(dirname(secretFile), { recursive: true });
if (fromFile !== token) writeFileSync(secretFile, token, { mode: 0o600 });
if (existsSync(serverEnv) && !fromEnv) {
  const env = readFileSync(serverEnv, 'utf8');
  const nl = env.includes('\r\n') ? '\r\n' : '\n';
  const next = /^ALERTMANAGER_WEBHOOK_TOKEN=.*$/m.test(env)
    ? env.replace(/^ALERTMANAGER_WEBHOOK_TOKEN=.*$/m, () => `ALERTMANAGER_WEBHOOK_TOKEN=${token}`)
    : `${env}${env.endsWith(nl) || env === '' ? '' : nl}ALERTMANAGER_WEBHOOK_TOKEN=${token}${nl}`;
  writeFileSync(serverEnv, next);
  console.log('ALERTMANAGER_WEBHOOK_TOKEN set in apps/server/.env (restart the dev server).');
}
console.log('Alertmanager webhook token ready (infra/secrets, gitignored).');
if (existsSync(serverEnv)) {
  const hosts = /^ALLOWED_HOSTS=(.*)$/m.exec(readFileSync(serverEnv, 'utf8'))?.[1] ?? '';
  if (!hosts.split(',').some((h) => h.trim() === 'host.docker.internal'))
    console.log(
      'Hint: for Telegram pushes from the local stack, set in apps/server/.env\n' +
        '  ALLOWED_HOSTS=localhost,127.0.0.1,[::1],host.docker.internal',
    );
}
