/**
 * All engine timing goes through a Clock so tests can drive time manually and
 * the server stays the single authority on when a lot closes.
 */
export type TimerHandle = { cancel(): void };

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const t = setTimeout(fn, Math.max(0, ms));
    return { cancel: () => clearTimeout(t) };
  },
};

/** Deterministic clock for tests: time only moves when `advance` is called. */
export class ManualClock implements Clock {
  private t: number;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();

  constructor(start = 1_800_000_000_000) {
    this.t = start;
  }

  now() {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return { cancel: () => void this.timers.delete(id) };
  }

  /** Move time forward, firing due timers in order (timers may schedule more timers). */
  advance(ms: number) {
    const target = this.t + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && (timer.at < nextAt || (timer.at === nextAt && id < nextId!))) {
          nextAt = timer.at;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const timer = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.t = Math.max(this.t, timer.at);
      timer.fn();
    }
    this.t = target;
  }

  pending() {
    return this.timers.size;
  }
}
