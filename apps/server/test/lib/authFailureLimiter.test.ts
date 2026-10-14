import { describe, expect, it } from 'vitest';
import { AuthFailureLimiter } from '../../src/lib/authFailureLimiter.js';

describe('AuthFailureLimiter', () => {
  it('blocks an IP at the limit and reports a positive retry-after', () => {
    const clock = { now: 0 };
    const l = new AuthFailureLimiter(3, 60_000, () => clock.now);
    for (let i = 0; i < 2; i++) l.recordFailure('1.1.1.1');
    expect(l.retryAfterSeconds('1.1.1.1')).toBe(0);
    l.recordFailure('1.1.1.1');
    expect(l.retryAfterSeconds('1.1.1.1')).toBe(60);
  });

  it('tracks IPs independently', () => {
    const l = new AuthFailureLimiter(1, 60_000, () => 0);
    l.recordFailure('1.1.1.1');
    expect(l.retryAfterSeconds('1.1.1.1')).toBeGreaterThan(0);
    expect(l.retryAfterSeconds('2.2.2.2')).toBe(0);
  });

  it('slides the window: old failures stop counting', () => {
    const clock = { now: 0 };
    const l = new AuthFailureLimiter(2, 60_000, () => clock.now);
    l.recordFailure('ip');
    clock.now = 30_000;
    l.recordFailure('ip');
    expect(l.retryAfterSeconds('ip')).toBe(30);
    clock.now = 60_001;
    expect(l.retryAfterSeconds('ip')).toBe(0);
  });
});
