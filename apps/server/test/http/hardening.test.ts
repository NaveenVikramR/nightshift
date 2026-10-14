import { afterEach, describe, expect, it } from 'vitest';
import {
  initializeBody,
  makeHarness,
  postMcp,
  RESPONDER_TOKEN,
  type TestHarness,
} from '../helpers.js';

describe('Request hardening', () => {
  let h: TestHarness;
  afterEach(() => h.ns.close());

  it('rejects a JSON body over the configured limit with 413', async () => {
    h = makeHarness({ maxBodyBytes: 1024 * 1024 });
    const big = JSON.stringify({ ...initializeBody(), padding: 'a'.repeat(1024 * 1024 + 10) });
    const res = await postMcp(h.ns, big, { token: RESPONDER_TOKEN });
    expect(res.status).toBe(413);
  });

  it('accepts a body just under the limit', async () => {
    h = makeHarness({ maxBodyBytes: 4096 });
    const init = initializeBody();
    const body = JSON.stringify({
      ...init,
      params: { ...init.params, _meta: { padding: 'a'.repeat(3000) } },
    });
    const res = await postMcp(h.ns, body, { token: RESPONDER_TOKEN });
    expect(res.status).toBe(200);
  });

  it('returns 429 after too many failed auth attempts from one IP', async () => {
    h = makeHarness({ authFailLimit: 20, authFailWindowMs: 10 * 60_000 });
    for (let i = 0; i < 20; i++) {
      const res = await postMcp(h.ns, initializeBody(), { token: `wrong-${i}` });
      expect(res.status).toBe(401);
    }
    const blocked = await postMcp(h.ns, initializeBody(), { token: 'wrong-again' });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    // Even a valid token is refused while the IP is blocked.
    const valid = await postMcp(h.ns, initializeBody(), { token: RESPONDER_TOKEN });
    expect(valid.status).toBe(429);
  });

  it('lets the IP back in once the window has passed', async () => {
    h = makeHarness({ authFailLimit: 3, authFailWindowMs: 60_000 });
    for (let i = 0; i < 3; i++) await postMcp(h.ns, initializeBody(), { token: 'wrong' });
    expect((await postMcp(h.ns, initializeBody(), { token: RESPONDER_TOKEN })).status).toBe(429);
    h.clock.now += 61_000;
    expect((await postMcp(h.ns, initializeBody(), { token: RESPONDER_TOKEN })).status).toBe(200);
  });

  it('does not count successful requests as failures', async () => {
    h = makeHarness({ authFailLimit: 2 });
    for (let i = 0; i < 5; i++) {
      const res = await postMcp(h.ns, initializeBody(), { token: RESPONDER_TOKEN });
      expect(res.status).toBe(200);
    }
  });
});
