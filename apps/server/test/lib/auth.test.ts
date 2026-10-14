import { describe, expect, it } from 'vitest';
import { OAuthError } from '@modelcontextprotocol/server';
import { createTokenVerifier, getPrincipal, sha256Hex } from '../../src/lib/auth.js';
import { hasRole } from '../../src/lib/roles.js';

const entries = [
  { actor: 'alice', role: 'responder' as const, sha256: sha256Hex('tok-a') },
  { actor: 'bob', role: 'viewer' as const, sha256: sha256Hex('tok-b') },
];

describe('createTokenVerifier', () => {
  const verifier = createTokenVerifier(entries, () => 1_000);

  it('maps a known token to its actor and role, with an expiry', async () => {
    const info = await verifier.verifyAccessToken('tok-b');
    expect(getPrincipal(info)).toEqual({ actor: 'bob', role: 'viewer' });
    expect(info.expiresAt).toBe(1_300);
  });

  it('rejects unknown tokens with an OAuth invalid_token error', async () => {
    await expect(verifier.verifyAccessToken('nope')).rejects.toSatisfy(
      (e: unknown) => e instanceof OAuthError && e.code === 'invalid_token',
    );
  });

  it('rejects the hash itself used as a token', async () => {
    await expect(verifier.verifyAccessToken(sha256Hex('tok-a'))).rejects.toThrow();
  });

  it('rejects everything when no tokens are configured', async () => {
    await expect(createTokenVerifier([]).verifyAccessToken('tok-a')).rejects.toThrow();
  });
});

describe('getPrincipal', () => {
  it('ignores auth info with a missing or unknown role', () => {
    expect(getPrincipal(undefined)).toBeUndefined();
    expect(
      getPrincipal({ token: 't', clientId: 'x', scopes: [], extra: { actor: 'x', role: 'admin' } }),
    ).toBeUndefined();
  });
});

describe('hasRole', () => {
  it('orders viewer < responder', () => {
    expect(hasRole('responder', 'viewer')).toBe(true);
    expect(hasRole('responder', 'responder')).toBe(true);
    expect(hasRole('viewer', 'viewer')).toBe(true);
    expect(hasRole('viewer', 'responder')).toBe(false);
  });
});
