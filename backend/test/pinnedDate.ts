/**
 * A Date constructor for the oracle realm whose NO-ARGUMENT form returns a
 * fixed instant.
 *
 * Pinning Date.now alone is not enough: a no-argument `new Date()` reads
 * the real clock regardless (the FL-0 lesson), and legacy freshness and
 * age checks use exactly that form. Every other use -- with arguments,
 * Date.UTC, Date.parse, `instanceof Date` -- behaves as the real Date, and
 * the instances ARE real Dates.
 *
 * Install with withOracleGlobals({ Date: pinnedDateClass(ms) }, fn).
 */
export function pinnedDateClass(nowMs: number): DateConstructor {
  const Real = Date;
  const Pinned = function (this: unknown, ...args: unknown[]): unknown {
    if (!new.target) return Real();
    return args.length ? new (Real as unknown as new (...a: unknown[]) => Date)(...args) : new Real(nowMs);
  } as unknown as DateConstructor;
  Object.defineProperty(Pinned, 'now', { value: () => nowMs });
  Object.defineProperty(Pinned, 'UTC', { value: Real.UTC });
  Object.defineProperty(Pinned, 'parse', { value: Real.parse });
  Object.defineProperty(Pinned, 'prototype', { value: Real.prototype });
  Object.defineProperty(Pinned, Symbol.hasInstance, { value: (x: unknown) => x instanceof Real });
  return Pinned;
}
