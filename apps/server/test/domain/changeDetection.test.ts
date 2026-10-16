import { describe, expect, it } from 'vitest';
import { detectOnset, detectStateChange } from '../../src/domain/correlation/changeDetection.js';
import { series, step } from '../fixtures/series.js';

const END = new Date('2026-10-16T12:00:00Z');
const at = (minutesBeforeEnd: number) => new Date(END.getTime() - minutesBeforeEnd * 60_000);
const N = 121; // 60 minutes at 30 s
const opts = { minAbsolute: 0.05 };

describe('detectOnset', () => {
  it('finds the onset of a clean step', () => {
    const r = detectOnset(series(END, N, step(at(5), 0.005, 0.4)), opts);
    expect(r.kind).toBe('spike');
    if (r.kind !== 'spike') return;
    expect(r.onset.time).toEqual(at(5));
    expect(r.baseline.mean).toBeCloseTo(0.005);
    expect(r.peak.value).toBeCloseTo(0.4);
    expect(r.last.value).toBeCloseTo(0.4);
  });

  it('finds the onset of a noisy spike', () => {
    const r = detectOnset(series(END, N, step(at(8), 0.01, 0.35, 0.008)), opts);
    expect(r).toMatchObject({ kind: 'spike', onset: { time: at(8) } });
  });

  it('reports flat for a flat series and for noise under the floor', () => {
    expect(
      detectOnset(
        series(END, N, () => 0.004),
        opts,
      ).kind,
    ).toBe('flat');
    expect(detectOnset(series(END, N, step(at(0), 0.01, 0.01, 0.009)), opts).kind).toBe('flat');
  });

  it('ignores a single-point blip (not sustained)', () => {
    const r = detectOnset(
      series(END, N, (i) => (i === 100 ? 0.9 : 0.005)),
      opts,
    );
    expect(r.kind).toBe('flat');
  });

  it('reports elevated_at_start when the window opens already high', () => {
    const r = detectOnset(
      series(END, N, () => 0.3),
      opts,
    );
    expect(r).toMatchObject({ kind: 'elevated_at_start', last: { value: 0.3 } });
  });

  it('drops missing points and still finds the onset', () => {
    const base = step(at(6), 0.005, 0.5);
    const r = detectOnset(
      series(END, N, (i, t) => (i % 7 === 3 ? NaN : base(i, t))),
      opts,
    );
    expect(r).toMatchObject({ kind: 'spike' });
    if (r.kind === 'spike') expect(r.onset.time.getTime()).toBeLessThanOrEqual(at(5.5).getTime());
  });

  it('does not join a run across a long gap', () => {
    // two high points separated by 5 missing steps are not a sustained run
    const r = detectOnset(
      series(END, N, (i) => (i === 100 || i === 106 ? 0.8 : i > 100 && i < 106 ? NaN : 0.005)),
      opts,
    );
    expect(r.kind).toBe('flat');
  });

  it('needs enough points', () => {
    expect(detectOnset([], opts)).toEqual({ kind: 'insufficient_data', points: 0 });
    expect(
      detectOnset(
        series(END, 5, () => 1),
        opts,
      ).kind,
    ).toBe('insufficient_data');
    expect(
      detectOnset(
        series(END, N, () => NaN),
        opts,
      ).kind,
    ).toBe('insufficient_data');
  });

  it('falls back to the absolute floor when a noisy baseline hides the rise', () => {
    // noisy baseline (std ~0.03) would put mean + 3·std above the plateau
    const r = detectOnset(series(END, N, step(at(20), 0.02, 0.09, 0.05, 3)), {
      minAbsolute: 0.05,
      sustain: 3,
    });
    expect(r.kind).toBe('spike');
  });
});

describe('detectStateChange', () => {
  const breaker = (openFrom?: number, closeFrom?: number) =>
    series(END, N, (_i, t) =>
      openFrom !== undefined &&
      t.getTime() >= at(openFrom).getTime() &&
      (closeFrom === undefined || t.getTime() < at(closeFrom).getTime())
        ? 1
        : 0,
    );

  it('finds when the breaker opened, and whether it is still open', () => {
    expect(detectStateChange(breaker(4), 1)).toEqual({ kind: 'entered', at: at(4), still: true });
    expect(detectStateChange(breaker(10, 3), 1)).toEqual({
      kind: 'entered',
      at: at(10),
      still: false,
    });
  });

  it('handles never, open from the start and no data', () => {
    expect(detectStateChange(breaker(), 1)).toEqual({ kind: 'never' });
    expect(
      detectStateChange(
        series(END, N, () => 1),
        1,
      ),
    ).toEqual({
      kind: 'at_start',
      still: true,
    });
    expect(
      detectStateChange(
        series(END, 3, () => NaN),
        1,
      ),
    ).toEqual({ kind: 'no_data' });
  });
});
