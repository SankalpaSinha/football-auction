/** Fixed-window counter keyed by anything (IP, user id, socket id). */
export class RateLimiter {
  private hits = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {
    // Sweep expired windows periodically so the map can't grow without bound.
    const sweep = setInterval(() => this.prune(this.now()), Math.max(windowMs, 60_000));
    sweep.unref?.();
  }

  /** Returns true if the action is allowed (and counts it). */
  take(key: string): boolean {
    const t = this.now();
    const h = this.hits.get(key);
    if (!h || t - h.windowStart >= this.windowMs) {
      // Hard ceiling as a last resort against floods of unique keys.
      if (this.hits.size >= 100_000) return false;
      this.hits.set(key, { windowStart: t, count: 1 });
      return true;
    }
    if (h.count >= this.max) return false;
    h.count++;
    return true;
  }

  private prune(t: number) {
    for (const [k, h] of this.hits) if (t - h.windowStart >= this.windowMs) this.hits.delete(k);
  }
}

/** Token bucket: smooth per-second limits with a burst allowance. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.ratePerSec);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
