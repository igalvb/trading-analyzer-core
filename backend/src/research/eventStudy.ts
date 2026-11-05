/**
 * Event studies (docs/models/MASTER_PLAN.md T3; plan 05 step 1): forward returns after a signal with one signal per
 * ticker per holding window (no overlapping windows), a random-day baseline drawn from the same ticker and period with
 * the same count (seeded, so a rerun draws the same), and the Holm correction across the variants tested.
 */

import type { PriceSeries } from '../backtest/data.ts';
import { mulberry32, NULL_SEED } from './guards.ts';

/** The return from the next open to the close `h` bars after the signal bar `k`; null past the data. */
export function forwardReturn(s: PriceSeries, k: number, h: number): number | null {
  if (k + h >= s.closes.length || k + 1 >= s.opens.length) return null;
  return (s.closes[k + h] as number) / (s.opens[k + 1] as number) - 1;
}

/** One signal per holding window: keep the first, drop the ones within `h` bars after a kept one. */
export function nonOverlapping(idx: readonly number[], h: number): number[] {
  const out: number[] = [];
  for (const k of [...idx].sort((a, b) => a - b)) if (!out.length || k - (out[out.length - 1] as number) >= h) out.push(k);
  return out;
}

export interface EventResult { readonly n: number; readonly mean: number; readonly baseline: number; readonly p: number }

/**
 * The mean forward return of the (non-overlapping) signals against random days: per ticker the same number of days
 * drawn from the same pool (the period's bars with a full forward window), `draws` times. p = the share of draws whose
 * mean is at least the signals' mean (one-sided: the signal should beat random days). Baseline = the draws' average.
 */
export function eventTest(signals: ReadonlyMap<PriceSeries, readonly number[]>, pool: (s: PriceSeries) => readonly number[], h: number, draws = 2000, seed = NULL_SEED): EventResult {
  const obs: number[] = [];
  const per: Array<{ s: PriceSeries; n: number; pool: readonly number[] }> = [];
  for (const [s, idx] of signals) {
    const kept = nonOverlapping(idx, h).filter((k) => forwardReturn(s, k, h) != null);
    for (const k of kept) obs.push(forwardReturn(s, k, h) as number);
    const p = pool(s).filter((k) => forwardReturn(s, k, h) != null);
    if (kept.length && p.length) per.push({ s, n: kept.length, pool: p });
  }
  if (!obs.length) return { n: 0, mean: NaN, baseline: NaN, p: 1 };
  const mean = obs.reduce((a, b) => a + b, 0) / obs.length;
  const rnd = mulberry32(seed);
  let atLeast = 0, sum = 0;
  for (let d = 0; d < draws; d++) {
    let tot = 0, cnt = 0;
    for (const x of per) for (let j = 0; j < x.n; j++) { const k = x.pool[Math.floor(rnd() * x.pool.length)] as number; tot += forwardReturn(x.s, k, h) as number; cnt++; }
    const m = cnt ? tot / cnt : 0;
    sum += m; if (m >= mean) atLeast++;
  }
  return { n: obs.length, mean, baseline: sum / draws, p: (atLeast + 1) / (draws + 1) };
}

/** Holm's step-down correction: adjusted p-values in the input order. */
export function holm(ps: readonly number[]): number[] {
  const order = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const adj = Array(ps.length).fill(1) as number[];
  let run = 0;
  order.forEach((x, r) => { run = Math.max(run, Math.min(1, (ps.length - r) * x.p)); adj[x.i] = run; });
  return adj;
}
