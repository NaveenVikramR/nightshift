/**
 * Generate a Nightshift API token.
 *   npm run token:new -- <actor> <viewer|responder>
 * Prints the plaintext token ONCE (give it to the MCP client) and the JSON
 * entry to add to NIGHTSHIFT_TOKENS (only the SHA-256 hash is stored).
 */
import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../src/lib/auth.js';
import { isRole } from '../src/lib/roles.js';

const [actor, role] = process.argv.slice(2);
if (!actor || !/^[\w.@-]{1,64}$/.test(actor) || !isRole(role)) {
  console.error('Usage: npm run token:new -- <actor> <viewer|responder>');
  process.exit(1);
}

const token = `ns_${randomBytes(32).toString('base64url')}`;
console.log('Token (shown once; store it in your MCP client, not in git):');
console.log(`  ${token}\n`);
console.log('Add this entry to the NIGHTSHIFT_TOKENS JSON array in apps/server/.env:');
console.log(`  ${JSON.stringify({ actor, role, sha256: sha256Hex(token) })}`);
