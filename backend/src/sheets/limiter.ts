/**
 * Rate limiting and bounded concurrency.
 *
 * WHY A CONCURRENCY CEILING IS MANDATORY, NOT OPTIONAL: an earlier draft of
 * this project's plan described Apps Script's batched fetchAll as an
 * "artificial" constraint that Node could discard. That was wrong, and the
 * legacy code says so explicitly. dataLayerV1.gs:819-825 documents the 13F
 * chain issuing "up to 18 concurrent ~23MB downloads, the ones SEC's own
 * real rate limiting is most likely to throttle/403/truncate" -- and
 * records the real GOOGL failure that resulted, where an all-null result
 * was then cached as a genuine finding for a whole quarter.
 *
 * Promise.all over an unbounded array is EASIER to write than the Apps
 * Script equivalent and has no implicit ceiling. Porting "concurrently"
 * without a limiter would faithfully reproduce a bug the old system had
 * already been hardened against.
 */

/**
 * Token bucket.
 *
 * Sized for the Sheets API's real binding limit. The published quota is 300
 * requests/minute/project AND 60/minute/user/project. A service account is a
 * single user, so 60 is the number that actually binds -- not 300. Default
 * below leaves headroom under it.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  // Parameter-property shorthand is disallowed under erasableSyntaxOnly
  // (it is not erasable -- it has a runtime effect), so these are declared
  // and assigned explicitly instead of via constructor shorthand.
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(
    capacity: number,
    refillPerMs: number,
    now: () => number = Date.now,
    sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.capacity = capacity;
    this.refillPerMs = refillPerMs;
    this.now = now;
    this.sleepFn = sleepFn;
    this.tokens = capacity;
    this.lastRefill = now();
  }

  static perMinute(n: number, now?: () => number, sleepFn?: (ms: number) => Promise<void>): RateLimiter {
    return new RateLimiter(n, n / 60_000, now, sleepFn);
  }

  private refill(): void {
    const t = this.now();
    const elapsed = t - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = t;
  }

  availableTokens(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Waits until a token is available, then consumes it. Proactive, not reactive.
   * Row 34: once `signal` fires, throws its reason instead of taking a token.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      const waitMs = Math.max(1, Math.ceil(deficit / this.refillPerMs));
      await this.sleepFn(waitMs);
    }
  }
}

/**
 * Bounded concurrency, with an optional tighter per-key ceiling.
 *
 * The key is normally a hostname, so that a provider known to throttle
 * aggressively (SEC) can be held to a lower ceiling than the global one
 * without slowing everything else down.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly activeByKey = new Map<string, number>();
  private readonly queue: Array<() => void> = [];
  private peak = 0;
  private readonly peakByKey = new Map<string, number>();
  private readonly maxConcurrent: number;
  private readonly perKeyMax: Readonly<Record<string, number>>;

  constructor(maxConcurrent: number, perKeyMax: Readonly<Record<string, number>> = {}) {
    this.maxConcurrent = maxConcurrent;
    this.perKeyMax = perKeyMax;
  }

  peakConcurrency(): number {
    return this.peak;
  }

  peakFor(key: string): number {
    return this.peakByKey.get(key) ?? 0;
  }

  private canStart(key: string): boolean {
    if (this.active >= this.maxConcurrent) return false;
    const cap = this.perKeyMax[key];
    if (cap === undefined) return true;
    return (this.activeByKey.get(key) ?? 0) < cap;
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    while (!this.canStart(key)) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }

    this.active++;
    const n = (this.activeByKey.get(key) ?? 0) + 1;
    this.activeByKey.set(key, n);
    if (this.active > this.peak) this.peak = this.active;
    if (n > (this.peakByKey.get(key) ?? 0)) this.peakByKey.set(key, n);

    try {
      return await fn();
    } finally {
      this.active--;
      this.activeByKey.set(key, (this.activeByKey.get(key) ?? 1) - 1);
      // Wake everyone; each re-checks its own key ceiling. Simple and correct.
      // A targeted wake would be faster but this queue is never long enough
      // for that to matter, and correctness here is worth more than speed.
      const waiters = this.queue.splice(0, this.queue.length);
      for (const w of waiters) w();
    }
  }

  /** Maps all items with bounded concurrency. The safe replacement for Promise.all. */
  async map<I, O>(items: readonly I[], key: string | ((item: I) => string), fn: (item: I) => Promise<O>): Promise<O[]> {
    const keyOf = typeof key === 'function' ? key : (): string => key;
    return Promise.all(items.map((item) => this.run(keyOf(item), () => fn(item))));
  }
}

/** Per-host ceilings, grounded in observed behaviour rather than guessed. */
export const HOST_CONCURRENCY: Readonly<Record<string, number>> = {
  // Documented real throttling under 18 concurrent large downloads.
  'data.sec.gov': 3,
  'www.sec.gov': 3,
  'sheets.googleapis.com': 4,
};

export const DEFAULT_MAX_CONCURRENCY = 8;
