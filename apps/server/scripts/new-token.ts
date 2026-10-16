/**
 * Generate a Nightshift API token.
 *   npm run token:new -- <actor> <viewer|responder>   MCP token (NIGHTSHIFT_TOKENS)
 *   npm run token:new -- <source> ingest              CI deploy-ingest token (NIGHTSHIFT_INGEST_TOKENS)
 * Prints the plaintext token ONCE (give it to the client) and the JSON entry
 * to add to the env variable (only the SHA-256 hash is stored).
 */
import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../src/lib/auth.js';
import { isRole } from '../src/lib/roles.js';

const [name, role] = process.argv.slice(2);
if (!name || !/^[\w.@-]{1,64}$/.test(name) || !(isRole(role) || role === 'ingest')) {
  console.error('Usage: npm run token:new -- <actor> <viewer|responder|ingest>');
  process.exit(1);
}

if (role === 'ingest') {
  const token = `nsi_${randomBytes(32).toString('base64url')}`;
  console.log('Ingest token (shown once; store it as a CI secret, not in git):');
  console.log(`  ${token}\n`);
  console.log('Add this entry to the NIGHTSHIFT_INGEST_TOKENS JSON array in apps/server/.env:');
  console.log(`  ${JSON.stringify({ source: name, sha256: sha256Hex(token) })}`);
} else {
  const token = `ns_${randomBytes(32).toString('base64url')}`;
  console.log('Token (shown once; store it in your MCP client, not in git):');
  console.log(`  ${token}\n`);
  console.log('Add this entry to the NIGHTSHIFT_TOKENS JSON array in apps/server/.env:');
  console.log(`  ${JSON.stringify({ actor: name, role, sha256: sha256Hex(token) })}`);
}
