/** Cost and abuse guards. In memory: the simulator runs as a single instance. */

/** Sliding-window limiter keyed by an opaque key (a token hash, never the token). */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit and returns true, or returns false (and records nothing) when over the limit. */
  take(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }

  /** Seconds until the next hit is allowed (0 when allowed now). */
  retryAfterSeconds(key: string): number {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs);
    if (recent.length < this.max) return 0;
    return Math.max(1, Math.ceil((recent[0]! + this.windowMs - t) / 1000));
  }
}

/** A cap per UTC day across all sessions (judge traffic can't run up costs). */
export class DailyCap {
  private day = '';
  private used = 0;

  constructor(
    private readonly cap: number,
    private readonly now: () => number = Date.now,
  ) {}

  private roll(): void {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.used = 0;
    }
  }

  take(n = 1): boolean {
    this.roll();
    if (this.used + n > this.cap) return false;
    this.used += n;
    return true;
  }

  get count(): number {
    this.roll();
    return this.used;
  }

  get limit(): number {
    return this.cap;
  }
}

/** Process-wide usage counters (counts only, no content). */
export class Usage {
  readonly counts = {
    turns: 0,
    modelRequests: 0,
    toolCalls: 0,
    cardToolCalls: 0,
    speechRequests: 0,
    speechCharacters: 0,
    inputTokens: 0,
    outputTokens: 0,
    guardrailBlocks: 0,
    modelErrors: 0,
    modelRateLimited: 0,
    refusedConfirms: 0,
    rateLimited: 0,
    dailyCapHit: 0,
    toolCallLimitHit: 0,
  };

  add(key: keyof Usage['counts'], n = 1): void {
    this.counts[key] += n;
  }
}

/** Rejects after `ms` (the underlying work is abandoned, not cancelled, unless it honours `signal`). */
export async function withTimeout<T>(
  ms: number,
  what: string,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new TimeoutError(what));
    }, ms);
  });
  try {
    return await Promise.race([work(ctrl.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class TimeoutError extends Error {
  constructor(what: string) {
    super(`${what} timed out`);
    this.name = 'TimeoutError';
  }
}
