/**
 * Change detection over Prometheus range series (pure).
 *
 * Inputs are raw points; NaN / ±Inf (e.g. histogram_quantile over an empty
 * window) count as missing and are dropped, never interpolated or invented.
 */

export interface Point {
  time: Date;
  value: number;
}

/**
 * Robust baseline: median and scaled MAD (median absolute deviation × 1.4826,
 * which equals the standard deviation for normal noise). A short earlier
 * spike inside the baseline window cannot drag it up the way a mean would.
 */
export interface Baseline {
  level: number;
  spread: number;
  /** How many points the baseline was computed from. */
  points: number;
}

interface Summary {
  baseline: Baseline;
  peak: Point;
  last: Point;
}

export type OnsetResult =
  /** A sustained rise: `onset` is the first point of the MOST RECENT sustained run above `threshold`. */
  | ({ kind: 'spike'; onset: Point; threshold: number } & Summary)
  /** No sustained rise above the threshold. */
  | ({ kind: 'flat'; threshold: number } & Summary)
  /** Already above `minAbsolute` at the start of the window: the onset is before it (unknown). */
  | ({ kind: 'elevated_at_start' } & Summary)
  /** Too few usable points to say anything. */
  | { kind: 'insufficient_data'; points: number };

export interface OnsetOptions {
  /** Absolute floor for the threshold, usually the service's alert threshold. */
  minAbsolute: number;
  /** Threshold = max(baseline level + k * spread, minAbsolute). */
  k?: number;
  /** Consecutive points above the threshold needed to count as a spike. */
  sustain?: number;
  /** Share of the window (from its start) used as the baseline. */
  baselineFraction?: number;
  minBaselinePoints?: number;
  /** A run breaks when consecutive points are more than this many steps apart. */
  maxGapSteps?: number;
}

const DEFAULTS = { k: 3, sustain: 2, baselineFraction: 0.25, minBaselinePoints: 6, maxGapSteps: 2 };

export function finitePoints(points: readonly Point[]): Point[] {
  return points
    .filter((p) => Number.isFinite(p.value))
    .sort((a, b) => a.time.getTime() - b.time.getTime());
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const MAD_TO_STD = 1.4826;

function robustBaseline(values: readonly number[]): { level: number; spread: number } {
  const level = median(values);
  return { level, spread: MAD_TO_STD * median(values.map((v) => Math.abs(v - level))) };
}

/** Median spacing between points (ms); robust to a few gaps. */
function typicalStepMs(points: readonly Point[]): number {
  const diffs = points
    .slice(1)
    .map((p, i) => p.time.getTime() - points[i]!.time.getTime())
    .sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)] ?? 0;
}

function maxPoint(points: readonly Point[]): Point {
  return points.reduce((best, p) => (p.value > best.value ? p : best));
}

/**
 * Index of the first point of the most recent run of >= `sustain`
 * consecutive points above `threshold` (the current incident, not an older
 * one earlier in the window).
 */
function latestSustainedRun(
  points: readonly Point[],
  threshold: number,
  sustain: number,
  maxGapMs: number,
): number | undefined {
  let latest: number | undefined;
  let runStart: number | undefined;
  let runLength = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const gap = i > 0 && p.time.getTime() - points[i - 1]!.time.getTime() > maxGapMs;
    if (p.value > threshold) {
      if (runStart === undefined || gap) {
        runStart = i;
        runLength = 1;
      } else {
        runLength++;
      }
      if (runLength >= sustain) latest = runStart;
    } else {
      runStart = undefined;
      runLength = 0;
    }
  }
  return latest;
}

/**
 * When did this series start rising? Deterministic:
 * - baseline = median and scaled MAD of the first `baselineFraction` of the
 *   window (at least `minBaselinePoints` points)
 * - baseline level already above `minAbsolute` → elevated_at_start
 * - threshold = max(level + k * spread, minAbsolute); onset = first point of
 *   the most recent run of `sustain` points above it (a gap > `maxGapSteps`
 *   breaks a run)
 * - if the baseline itself is noisy enough to hide a rise that ends above
 *   `minAbsolute`, the run is searched again against `minAbsolute` alone
 */
export function detectOnset(raw: readonly Point[], options: OnsetOptions): OnsetResult {
  const o = { ...DEFAULTS, ...options };
  const points = finitePoints(raw);
  if (points.length < o.minBaselinePoints + o.sustain) {
    return { kind: 'insufficient_data', points: points.length };
  }

  const baselineSize = Math.max(
    o.minBaselinePoints,
    Math.floor(points.length * o.baselineFraction),
  );
  const { level, spread } = robustBaseline(points.slice(0, baselineSize).map((p) => p.value));
  const baseline: Baseline = { level, spread, points: baselineSize };
  const last = points[points.length - 1]!;

  if (level > o.minAbsolute) {
    return { kind: 'elevated_at_start', baseline, peak: maxPoint(points), last };
  }

  const maxGapMs = typicalStepMs(points) * (o.maxGapSteps + 0.5);
  const threshold = Math.max(level + o.k * spread, o.minAbsolute);
  let start = latestSustainedRun(points, threshold, o.sustain, maxGapMs);
  let used = threshold;
  if (start === undefined && last.value > o.minAbsolute) {
    start = latestSustainedRun(points, o.minAbsolute, o.sustain, maxGapMs);
    used = o.minAbsolute;
  }
  if (start === undefined) {
    return { kind: 'flat', threshold, baseline, peak: maxPoint(points), last };
  }
  const onset = points[start]!;
  return {
    kind: 'spike',
    onset,
    threshold: used,
    baseline,
    peak: maxPoint(points.slice(start)),
    last,
  };
}

export type StateChange =
  /** Entered `target` at `at` (the most recent entry) and is `still` in it, or not. */
  | { kind: 'entered'; at: Date; still: boolean }
  /** Already in `target` at the start of the window. */
  | { kind: 'at_start'; still: boolean }
  | { kind: 'never' }
  | { kind: 'no_data' };

/** When did a state series (e.g. breaker 0 closed / 1 open) last enter `target`? */
export function detectStateChange(raw: readonly Point[], target: number): StateChange {
  const points = finitePoints(raw);
  if (points.length === 0) return { kind: 'no_data' };
  const still = points[points.length - 1]!.value === target;
  for (let i = points.length - 1; i >= 1; i--) {
    if (points[i]!.value === target && points[i - 1]!.value !== target) {
      return { kind: 'entered', at: points[i]!.time, still };
    }
  }
  return points[0]!.value === target ? { kind: 'at_start', still } : { kind: 'never' };
}
