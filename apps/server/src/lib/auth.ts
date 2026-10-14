import { createHash, timingSafeEqual } from 'node:crypto';
import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type { TokenEntry } from '../config.js';
import { isRole, type Role } from './roles.js';

/** Who is calling, as seen by tool handlers. */
export interface Principal {
  actor: string;
  role: Role;
}

/**
 * The SDK's bearer middleware rejects AuthInfo without `expiresAt`. Our API
 * tokens are long-lived and re-verified on every request, so we stamp a short
 * validity window at verification time (see friction log).
 */
const VERIFICATION_VALIDITY_SECONDS = 300;

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Verifies opaque bearer tokens against configured SHA-256 hashes.
 * Plaintext tokens are never stored; comparison is constant-time and always
 * scans every entry so timing does not reveal which entry matched.
 */
export function createTokenVerifier(
  entries: readonly TokenEntry[],
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
): OAuthTokenVerifier {
  const known = entries.map((e) => ({ ...e, digest: Buffer.from(e.sha256, 'hex') }));

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const digest = createHash('sha256').update(token, 'utf8').digest();
      let match: (typeof known)[number] | undefined;
      for (const entry of known) {
        if (timingSafeEqual(digest, entry.digest) && !match) match = entry;
      }
      if (!match) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or unknown token');
      return {
        token,
        clientId: match.actor,
        scopes: [match.role],
        expiresAt: nowSeconds() + VERIFICATION_VALIDITY_SECONDS,
        extra: { actor: match.actor, role: match.role },
      };
    },
  };
}

/** Extract the Principal our verifier attached; undefined if absent or malformed. */
export function getPrincipal(authInfo: AuthInfo | undefined): Principal | undefined {
  const actor = authInfo?.extra?.['actor'];
  const role = authInfo?.extra?.['role'];
  if (typeof actor !== 'string' || !isRole(role)) return undefined;
  return { actor, role };
}
