import { describe, expect, it } from 'vitest';
import {
  spokenAgo,
  spokenDuration,
  spokenList,
  spokenPercent,
  spokenRate,
  spokenSeconds,
} from '../../src/domain/spoken.js';

const now = new Date('2026-10-16T12:00:00Z');
const minus = (ms: number) => new Date(now.getTime() - ms);

describe('spoken formatters', () => {
  it.each([
    [10_000, 'just now'],
    [60_000, '1 minute ago'],
    [3 * 60_000, '3 minutes ago'],
    [2 * 3_600_000, '2 hours ago'],
    [26 * 3_600_000, '1 day ago'],
  ])('spokenAgo(%i ms) = %s', (ms, text) => expect(spokenAgo(minus(ms), now)).toBe(text));

  it.each([
    [1, '1 minute'],
    [45, '45 minutes'],
    [60, '1 hour'],
    [90, '1 hour 30 minutes'],
    [240, '4 hours'],
  ])('spokenDuration(%i) = %s', (m, text) => expect(spokenDuration(m)).toBe(text));

  it.each([
    [0.6312, '63 percent'],
    [0.0412, '4.1 percent'],
    [0.05, '5 percent'],
    [0.004, '0.4 percent'],
    [0.0004, '0.04 percent'],
    [0, '0 percent'],
  ])('spokenPercent(%d) = %s', (r, text) => expect(spokenPercent(r)).toBe(text));

  it('formats seconds, rates and lists', () => {
    expect(spokenSeconds(0.18)).toBe('180 milliseconds');
    expect(spokenSeconds(1.42)).toBe('1.4 seconds');
    expect(spokenSeconds(2)).toBe('2 seconds');
    expect(spokenRate(19.6)).toBe('20 requests per second');
    expect(spokenRate(0.42)).toBe('0.4 requests per second');
    expect(spokenList(['a'])).toBe('a');
    expect(spokenList(['a', 'b'], 'or')).toBe('a or b');
    expect(spokenList(['a', 'b', 'c'])).toBe('a, b and c');
  });
});
