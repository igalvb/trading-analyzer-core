/**
 * Model 4f (docs/models/plans/04-black-scholes-fair-value.md section 6.2): the APPROXIMATE historical LEAPS pricer.
 * No option history exists in the project, so a call on day d is priced by Black-Scholes (G2) from the stock's own
 * history — always labelled "approximate":
 *
 *   sigma_d  k x RV252_d (the closes up to d only), floored at 15% [PROPOSED]; k = 0.9 / 1.0 / 1.2 / 1.4 swept
 *   rate     the previous month's Fed funds (legacy/historical_data/fedfunds.csv), point-in-time
 *   expiry   the third Friday of the chosen January (listings are not known; computed)
 *   strike   solved in closed form so the Black-Scholes delta equals the target (no listed-strike grid)
 *   fills    buy at mid x (1 + h), sell at mid x (1 - h); h = 1 / 3 / 5% swept; exercise at the stock's close if ITM
 *            by $0.01 or more
 * Limits (printed under every result): no skew or term structure, crash IV only through RV, no real spreads or open
 * interest, no dividends (q = 0), European formula, LEAPS listing unknown (synthetic LEAPS only after a stock has
 * traded 12 months), the owner's list chosen with hindsight, survivors only.
 */

import type { PriceSeries } from '../backtest/data.ts';
import { bsCall, bsGreeks } from '../analysis/options/blackScholes.ts';
import { thirdFriday, jamesJanuaryDate } from '../analysis/options/leapsPick.ts';
import { loadFedFunds } from './cycleLab.ts';

export const SIM = { k: 1.0, h: 0.03, floor: 0.15, ks: [0.9, 1.0, 1.2, 1.4] as readonly number[], hs: [0.01, 0.03, 0.05] as readonly number[], listedDays: 252, engineMaxMonths: 32 } as const;

/** Acklam's inverse of the standard normal CDF (relative error < 1.2e-9). */
export function normInv(p: number): number {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const lo = 0.02425, hi = 1 - lo;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
  if (p > hi) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** The strike whose Black-Scholes call delta is `delta` (closed form: d1 = N^-1(delta)). */
export function strikeForDelta(S: number, T: number, sigma: number, r: number, delta: number): number {
  const d1 = normInv(delta), v = sigma * Math.sqrt(T);
  return S * Math.exp(-(d1 * v - (r + (sigma * sigma) / 2) * T));
}

const DAY_MS = 86_400_000;
export const calDays = (from: string, to: string): number => (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY_MS;

/** RV252 per day (sample SD of the last 252 log returns x sqrt(252)), causal; null before 253 closes. Cached per series. */
const RV = new WeakMap<PriceSeries, Array<number | null>>();
export function rv252Series(s: PriceSeries, n = 252): Array<number | null> {
  const hit = n === 252 ? RV.get(s) : undefined;
  if (hit) return hit;
  const c = s.closes, out: Array<number | null> = [];
  let sum = 0, sq = 0;
  const r: number[] = [0];
  for (let i = 1; i < c.length; i++) r.push((c[i] as number) > 0 && (c[i - 1] as number) > 0 ? Math.log((c[i] as number) / (c[i - 1] as number)) : 0);
  for (let i = 0; i < c.length; i++) {
    if (i >= 1) { sum += r[i] as number; sq += (r[i] as number) ** 2; }
    if (i - n >= 1) { sum -= r[i - n] as number; sq -= (r[i - n] as number) ** 2; }
    if (i < n) { out.push(null); continue; }
    const m = sum / n, v = (sq - n * m * m) / (n - 1);
    out.push(Math.sqrt(Math.max(0, v)) * Math.sqrt(252));
  }
  if (n === 252) RV.set(s, out);
  return out;
}

let FED: ((d: string) => number) | null = null;
/** The rate on `day` as a fraction (previous month's Fed funds). */
export const rateOn = (day: string): number => (FED ??= loadFedFunds())(day) / 100;

export interface SimPricer { readonly k: number; readonly h: number; readonly floor: number }

/** sigma on bar i of `s`: k x RV252 (bars up to i), floored; null before a year of history. */
export function sigmaAt(s: PriceSeries, i: number, p: SimPricer): number | null {
  const v = rv252Series(s)[i];
  return v == null ? null : Math.max(p.floor, p.k * v);
}

/** The mid of a call (per share) at stock price S on `day` for expiry `exp` ('YYYY-MM-DD'). */
export function simMid(S: number, K: number, day: string, exp: string, sigma: number): number {
  const T = Math.max(0, calDays(day, exp)) / 365;
  return bsCall({ S, K, T, sigma, r: rateOn(day) });
}
export function simDelta(S: number, K: number, day: string, exp: string, sigma: number): number {
  const T = calDays(day, exp) / 365;
  if (!(T > 0)) return S > K ? 1 : 0;
  return bsGreeks({ S, K, T, sigma, r: rateOn(day) }).delta;
}

/** James's January for a decision on `day` (13-26 months, nearest 19); the engine's: the furthest January listed (within 32 months), at least 180 days out. */
export function simExpiry(day: string, pick: 'james' | 'engine'): string | null {
  if (pick === 'james') return jamesJanuaryDate(day);
  const y = Number(day.slice(0, 4));
  let best: string | null = null;
  for (let yy = y; yy <= y + 3; yy++) {
    const e = thirdFriday(yy, 1), dd = calDays(day, e);
    if (dd >= 180 && dd <= SIM.engineMaxMonths * 30.4375) best = e;
  }
  return best;
}

export interface SimContract { readonly K: number; readonly exp: string; readonly delta: number; readonly mid: number; readonly ask: number; readonly bemYear: number | null }

/** A synthetic contract at a target delta on `day` (price S, sigma). */
export function simContract(S: number, day: string, exp: string, sigma: number, delta: number, h: number): SimContract {
  const T = calDays(day, exp) / 365, r = rateOn(day);
  const K = strikeForDelta(S, T, sigma, r, delta), mid = bsCall({ S, K, T, sigma, r }), ask = mid * (1 + h);
  const bem = (K + ask) / S - 1, dte = calDays(day, exp);
  return { K, exp, delta, mid, ask, bemYear: dte > 0 && 1 + bem > 0 ? Math.pow(1 + bem, 365 / dte) - 1 : null };
}
