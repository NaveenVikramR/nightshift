import type { RequestHandler } from 'express';

/**
 * Sliding-window counter of failed authentication attempts per client IP.
 * In memory, like sessions (single instance).
 */
export class AuthFailureLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(ip: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.failures.get(ip) ?? []).filter((t) => t > cutoff);
    if (kept.length === 0) this.failures.delete(ip);
    else this.failures.set(ip, kept);
    return kept;
  }

  /** Seconds until this IP may try again, or 0 when not blocked. */
  retryAfterSeconds(ip: string): number {
    const recent = this.recent(ip);
    if (recent.length < this.limit) return 0;
    const oldestRelevant = recent[recent.length - this.limit] ?? this.now();
    return Math.max(1, Math.ceil((oldestRelevant + this.windowMs - this.now()) / 1000));
  }

  recordFailure(ip: string): void {
    this.failures.set(ip, [...this.recent(ip), this.now()]);
  }

  /** Drop idle entries so the map cannot grow without bound. */
  sweep(): void {
    for (const ip of [...this.failures.keys()]) this.recent(ip);
  }
}

/**
 * Must run BEFORE the bearer-auth middleware: blocks IPs over the limit with
 * 429, and counts every 401 the rest of the chain produces.
 */
export function authFailureGuard(limiter: AuthFailureLimiter): RequestHandler {
  return (req, res, next) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const retryAfter = limiter.retryAfterSeconds(ip);
    if (retryAfter > 0) {
      res.status(429).set('Retry-After', String(retryAfter)).json({
        error: 'too_many_requests',
        error_description: 'Too many failed authentication attempts. Try again later.',
      });
      return;
    }
    res.on('finish', () => {
      if (res.statusCode === 401) limiter.recordFailure(ip);
    });
    next();
  };
}
