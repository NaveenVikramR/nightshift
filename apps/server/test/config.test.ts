import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const hash = 'a'.repeat(64);

describe('loadConfig', () => {
  it('applies safe defaults (localhost bind, 1 MB body, 20 failures / 10 min)', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      host: '127.0.0.1',
      port: 3000,
      maxBodyBytes: 1024 * 1024,
      authFailLimit: 20,
      authFailWindowMs: 600_000,
      sessionIdleTtlMs: 1_800_000,
      tokens: [],
      allowedOrigins: [],
      trustProxy: false,
    });
  });

  it('parses STRICT_SESSION_BINDING (default off)', () => {
    expect(loadConfig({}).strictSessionBinding).toBe(false);
    expect(loadConfig({ STRICT_SESSION_BINDING: 'true' }).strictSessionBinding).toBe(true);
  });

  it('treats empty values as unset', () => {
    expect(loadConfig({ PORT: '', HOST: '' })).toMatchObject({ port: 3000, host: '127.0.0.1' });
  });

  it('normalizes allowed origins', () => {
    const c = loadConfig({ ALLOWED_ORIGINS: 'http://LOCALHOST:6274/ , https://a.example' });
    expect(c.allowedOrigins).toEqual(['http://localhost:6274', 'https://a.example']);
  });

  it('parses token entries', () => {
    const c = loadConfig({
      NIGHTSHIFT_TOKENS: JSON.stringify([{ actor: 'a', role: 'viewer', sha256: hash }]),
    });
    expect(c.tokens).toEqual([{ actor: 'a', role: 'viewer', sha256: hash }]);
  });

  it('parses ingest tokens and GITHUB_TOKEN', () => {
    const c = loadConfig({
      NIGHTSHIFT_INGEST_TOKENS: JSON.stringify([{ source: 'github-actions', sha256: hash }]),
      GITHUB_TOKEN: 'ghp_x',
    });
    expect(c.ingestTokens).toEqual([{ source: 'github-actions', sha256: hash }]);
    expect(c.githubToken).toBe('ghp_x');
    expect(loadConfig({}).ingestTokens).toEqual([]);
  });

  it.each([
    ['bad JSON', { NIGHTSHIFT_TOKENS: '[{' }],
    [
      'unknown role',
      { NIGHTSHIFT_TOKENS: JSON.stringify([{ actor: 'a', role: 'admin', sha256: hash }]) },
    ],
    [
      'plaintext instead of hash',
      { NIGHTSHIFT_TOKENS: JSON.stringify([{ actor: 'a', role: 'viewer', sha256: 'tok' }]) },
    ],
    [
      'duplicate actor',
      {
        NIGHTSHIFT_TOKENS: JSON.stringify([
          { actor: 'a', role: 'viewer', sha256: hash },
          { actor: 'a', role: 'responder', sha256: 'b'.repeat(64) },
        ]),
      },
    ],
    [
      'duplicate ingest source',
      {
        NIGHTSHIFT_INGEST_TOKENS: JSON.stringify([
          { source: 'ci', sha256: hash },
          { source: 'ci', sha256: 'b'.repeat(64) },
        ]),
      },
    ],
    [
      'bad ingest source',
      { NIGHTSHIFT_INGEST_TOKENS: JSON.stringify([{ source: 'a b', sha256: hash }]) },
    ],
    ['bad origin', { ALLOWED_ORIGINS: 'not a url' }],
    ['port out of range', { PORT: '70000' }],
  ])('rejects %s', (_label, env) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it('does not echo secret values in errors', () => {
    try {
      loadConfig({
        NIGHTSHIFT_TOKENS: JSON.stringify([{ actor: 'a', role: 'viewer', sha256: 'SUPERSECRET' }]),
      });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain('SUPERSECRET');
    }
  });
});
