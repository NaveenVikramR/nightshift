import { afterEach, describe, expect, it } from 'vitest';
import {
  ALLOWED_ORIGIN,
  initializeBody,
  makeHarness,
  postMcp,
  RESPONDER_TOKEN,
  type TestHarness,
} from '../helpers.js';

describe('Origin validation on /mcp', () => {
  let h: TestHarness;
  afterEach(() => h.ns.close());

  it('allows a request from an allowlisted origin', async () => {
    h = makeHarness();
    const res = await postMcp(h.ns, initializeBody(), {
      token: RESPONDER_TOKEN,
      origin: ALLOWED_ORIGIN,
    });
    expect(res.status).toBe(200);
  });

  it('allows a request without an Origin header (non-browser clients)', async () => {
    h = makeHarness();
    const res = await postMcp(h.ns, initializeBody(), { token: RESPONDER_TOKEN });
    expect(res.status).toBe(200);
  });

  it.each([
    ['a foreign origin', 'https://evil.example'],
    ['an allowlisted host on another port', 'http://localhost:9999'],
    ['an allowlisted host over another scheme', 'https://localhost:6274'],
    ['the opaque null origin', 'null'],
  ])('rejects %s with 403', async (_label, origin) => {
    h = makeHarness();
    const res = await postMcp(h.ns, initializeBody(), { token: RESPONDER_TOKEN, origin });
    expect(res.status).toBe(403);
  });

  it('rejects a disallowed origin before checking the token', async () => {
    h = makeHarness();
    const res = await postMcp(h.ns, initializeBody(), { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });
});
