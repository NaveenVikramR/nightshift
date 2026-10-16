import type { Point } from '../../src/domain/correlation/changeDetection.js';

/** Deterministic PRNG (mulberry32) so noisy fixtures are reproducible. */
export function seeded(seed = 7): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `n` points every `stepSeconds`, ending at `end`. `value(i, t)` gets the index
 * and the point's time; return NaN for a missing point.
 */
export function series(
  end: Date,
  n: number,
  value: (i: number, t: Date) => number,
  stepSeconds = 30,
): Point[] {
  return Array.from({ length: n }, (_, i) => {
    const time = new Date(end.getTime() - (n - 1 - i) * stepSeconds * 1000);
    return { time, value: value(i, time) };
  });
}

/** Value `low` before `at`, `high` from `at` on, plus optional uniform noise (± jitter). */
export function step(at: Date, low: number, high: number, jitter = 0, seed = 7) {
  const rng = seeded(seed);
  return (_i: number, t: Date) =>
    (t.getTime() >= at.getTime() ? high : low) + (jitter ? (rng() * 2 - 1) * jitter : 0);
}
