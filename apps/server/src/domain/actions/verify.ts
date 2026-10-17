/**
 * After an action: did it help? Polls the error rate and classifies the
 * result from MEASURED values only. Never reports recovery the metrics don't
 * show.
 */
import { spokenPercent } from '../spoken.js';

export type VerificationOutcome = 'recovered' | 'recovering' | 'no_improvement' | 'unknown';

export interface Verification {
  outcome: VerificationOutcome;
  /** Error ratio just before executing (null = unknown). */
  before: number | null;
  /** Last measured error ratio (null = no data). */
  after: number | null;
  threshold: number;
  samples: { at: string; errorRate: number | null }[];
}

export interface VerifyOptions {
  before: number | null;
  threshold: number;
  /** Reads the current error ratio; null when unavailable. */
  read: () => Promise<number | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  attempts?: number;
  intervalMs?: number;
}

/** Falling by at least this share of the starting value counts as "recovering". */
const RECOVERING_DROP = 0.3;

export function classify(
  before: number | null,
  after: number | null,
  threshold: number,
): VerificationOutcome {
  if (after === null) return 'unknown';
  if (after <= threshold) return 'recovered';
  if (before !== null && before > 0 && after <= before * (1 - RECOVERING_DROP)) return 'recovering';
  return 'no_improvement';
}

/** Poll every `intervalMs` (default 4 s) up to `attempts` times (default 5 ≈ 20 s); stop once recovered. */
export async function verifyRecovery(o: VerifyOptions): Promise<Verification> {
  const attempts = o.attempts ?? 5;
  const samples: Verification['samples'] = [];
  let after: number | null = null;
  for (let i = 0; i < attempts; i++) {
    await o.sleep(o.intervalMs ?? 4000);
    after = await o.read().catch(() => null);
    samples.push({ at: o.now().toISOString(), errorRate: after });
    if (classify(o.before, after, o.threshold) === 'recovered') break;
  }
  return {
    outcome: classify(o.before, after, o.threshold),
    before: o.before,
    after,
    threshold: o.threshold,
    samples,
  };
}

/** ≤ ~12 words, numbers from the measurements only. */
export function speakVerification(v: Verification): string {
  switch (v.outcome) {
    case 'recovered':
      return `Recovered: errors at ${spokenPercent(v.after!)}.`;
    case 'recovering':
      return `Errors are falling, ${spokenPercent(v.before!).replace(' percent', '')} to ${spokenPercent(v.after!)}. Still recovering.`;
    case 'no_improvement':
      return `No improvement yet: errors still at ${spokenPercent(v.after!)}.`;
    case 'unknown':
      return "I couldn't read the error rate to confirm the effect.";
  }
}
