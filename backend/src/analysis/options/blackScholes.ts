/**
 * G2 (docs/models/MASTER_PLAN.md section 4; plan 04 section 2.1): James's Black-Scholes sheet as code — an exact port
 * of "BS OPM - Generic" (JETS Black Scholes Option Pricing Model, 2021-01-31; the 2021-06-28 and 2023-02-06 sheets use
 * the same formulas), units included. Pure functions, no I/O. Display name of the model that uses it:
 * "James — Option Fair Value".
 *
 * Inputs as the sheet: T in years = CALENDAR days / 365, K strike, S price, sigma volatility (0.39 = 39%), r risk-free
 * (0.01 = 1%). No dividend yield (q = 0); the European formula (equal to American for a call on a stock paying no
 * dividend).
 *
 * Units: every greek is returned in BOTH the sheet's unit and the display unit, under names that say which, so they
 * cannot be mixed: theta per year (sheet) and per calendar day (/365, Cboe's unit); vega per 1.00 of sigma (sheet, 100
 * vol points) and per vol point (/100, Cboe's unit); rho per 1.00 of r and per rate point (/100).
 *
 * Long-only: the put formulas are here ONLY so the port can be checked cell by cell against the sheet (put-call
 * parity); no put is ever shown as a trade or used in a decision.
 */

export interface BsInput {
  /** Years to expiry: calendar days / 365 (the sheet's convention). */
  readonly T: number;
  readonly K: number;
  readonly S: number;
  /** Volatility as a fraction (0.39 = 39%). */
  readonly sigma: number;
  /** Risk-free rate as a fraction (0.01 = 1%). */
  readonly r: number;
}

/** Years from calendar days, as the sheet does (days / 365). */
export const yearsFromDays = (days: number): number => days / 365;

const SQRT_2PI = Math.sqrt(2 * Math.PI);

/** Standard normal density φ(x). */
export function normPdf(x: number): number {
  return Math.exp(-(x * x) / 2) / SQRT_2PI;
}

/**
 * Standard normal CDF N(x) (Excel NORMSDIST): Hart's algorithm 5666 in West's double-precision form (absolute error
 * below 1e-14), so the port is not limited by the CDF.
 */
export function normCdf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const z = Math.abs(x);
  let c: number;
  if (z > 37) c = 0;
  else {
    const e = Math.exp(-(z * z) / 2);
    if (z < 7.07106781186547) {
      let n = 3.52624965998911e-2 * z + 0.700383064443688;
      n = n * z + 6.37396220353165; n = n * z + 33.912866078383; n = n * z + 112.079291497871; n = n * z + 221.213596169931; n = n * z + 220.206867912376;
      let d = 8.83883476483184e-2 * z + 1.75566716318264;
      d = d * z + 16.064177579207; d = d * z + 86.7807322029461; d = d * z + 296.564248779674; d = d * z + 637.333633378831; d = d * z + 793.826512519948; d = d * z + 440.413735824752;
      c = (e * n) / d;
    } else {
      let b = z + 0.65;
      b = z + 4 / b; b = z + 3 / b; b = z + 2 / b; b = z + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}

/** d1 (sheet row 9) and d2 (row 10). */
export function bsD1D2(p: BsInput): { d1: number; d2: number } {
  const v = p.sigma * Math.sqrt(p.T);
  const d1 = (Math.log(p.S / p.K) + (p.r + (p.sigma * p.sigma) / 2) * p.T) / v;
  return { d1, d2: d1 - v };
}

/** The call price per share (row 13): S·N(d1) − K·e^(−rT)·N(d2). At or after expiry (T ≤ 0): the intrinsic value. */
export function bsCall(p: BsInput): number {
  if (!(p.T > 0) || !(p.sigma > 0)) return Math.max(p.S - p.K * (p.T > 0 ? Math.exp(-p.r * p.T) : 1), 0);
  const { d1, d2 } = bsD1D2(p);
  return p.S * normCdf(d1) - p.K * Math.exp(-p.r * p.T) * normCdf(d2);
}

export interface BsGreeks {
  /** N(d1), per $1 of the stock (row 21). */
  readonly delta: number;
  /** φ(d1)/(S·σ·√T) (row 22). */
  readonly gamma: number;
  /** The sheet's theta (row 23), $ per YEAR. */
  readonly thetaPerYear: number;
  /** thetaPerYear / 365: $ per calendar day (Cboe's unit). */
  readonly thetaPerDay: number;
  /** The sheet's vega (row 24), $ per 1.00 of sigma (100 vol points). */
  readonly vegaPer1: number;
  /** vegaPer1 / 100: $ per vol point (Cboe's unit). */
  readonly vegaPerPoint: number;
  /** The sheet's rho (row 25), $ per 1.00 of r. */
  readonly rhoPer1: number;
  /** rhoPer1 / 100: $ per rate point. */
  readonly rhoPerPoint: number;
}

/** The call's greeks, sheet rows 21-25, in both unit sets. */
export function bsGreeks(p: BsInput): BsGreeks {
  const { d1, d2 } = bsD1D2(p);
  const sq = Math.sqrt(p.T), disc = Math.exp(-p.r * p.T), pd1 = normPdf(d1);
  const thetaPerYear = -(p.S * pd1 * p.sigma) / (2 * sq) - p.r * p.K * disc * normCdf(d2);
  const vegaPer1 = p.S * sq * pd1;
  const rhoPer1 = p.K * p.T * disc * normCdf(d2);
  return {
    delta: normCdf(d1), gamma: pd1 / (p.S * p.sigma * sq),
    thetaPerYear, thetaPerDay: thetaPerYear / 365, vegaPer1, vegaPerPoint: vegaPer1 / 100, rhoPer1, rhoPerPoint: rhoPer1 / 100,
  };
}

/**
 * The sheet's put (row 16, by put-call parity) and its greeks (rows 28-32). FOR THE PORT CHECK ONLY: never displayed,
 * never traded (long-only).
 */
export function bsPutCheck(p: BsInput): { put: number; delta: number; gamma: number; thetaPerYear: number; vegaPer1: number; rhoPer1: number } {
  const { d1, d2 } = bsD1D2(p);
  const sq = Math.sqrt(p.T), disc = Math.exp(-p.r * p.T), pd1 = normPdf(d1);
  return {
    put: bsCall(p) + p.K * disc - p.S,
    delta: normCdf(d1) - 1,
    gamma: pd1 / (p.S * p.sigma * sq),
    thetaPerYear: -(p.S * pd1 * p.sigma) / (2 * sq) + p.r * p.K * disc * normCdf(-d2),
    vegaPer1: p.S * sq * pd1,
    rhoPer1: -p.K * p.T * disc * normCdf(-d2),
  };
}

export interface BsSheet extends BsGreeks {
  readonly call: number;
  /** max(S − K, 0) (row 14). */
  readonly intrinsic: number;
  /** "Speculative premium" = call − intrinsic (row 15): the time value, $ per share. */
  readonly specPremium: number;
  /** Speculative premium as a fraction of the price (Spin sheet B17). */
  readonly specPctOfPrice: number;
  /** Speculative premium per CALENDAR day to expiry (Spin sheet B18); null without days. */
  readonly specPerDay: number | null;
  /** The call per contract (× 100 shares). */
  readonly callPerContract: number;
}

/** Everything the sheet shows for one call. `days` (calendar) gives the per-day premium; T is taken from `p`. */
export function bsSheet(p: BsInput, days?: number): BsSheet {
  const call = bsCall(p), intrinsic = Math.max(p.S - p.K, 0), spec = call - intrinsic;
  return {
    call, intrinsic, specPremium: spec, specPctOfPrice: spec / p.S, specPerDay: days && days > 0 ? spec / days : null,
    callPerContract: call * 100, ...bsGreeks(p),
  };
}

/**
 * The implied volatility of a call price (plan 04 P1): bisection on [1%, 500%], then Newton, to 1e-6. Null when the
 * price is outside what 1%..500% volatility can give (below the near-intrinsic value, or at or above S), or when the
 * inputs are not usable.
 */
export function impliedVol(price: number, p: Omit<BsInput, 'sigma'>): number | null {
  if (!(price > 0) || !(p.T > 0) || !(p.S > 0) || !(p.K > 0) || price >= p.S) return null;
  const at = (sigma: number): number => bsCall({ ...p, sigma });
  let lo = 0.01, hi = 5;
  if (price < at(lo) || price > at(hi)) return null;
  for (let i = 0; i < 60 && hi - lo > 1e-4; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) < price) lo = mid; else hi = mid;
  }
  let s = (lo + hi) / 2;
  for (let i = 0; i < 50; i++) {
    const diff = at(s) - price, vega = bsGreeks({ ...p, sigma: s }).vegaPer1;
    if (Math.abs(diff) < 1e-10 || !(vega > 1e-12)) break;
    const next = s - diff / vega;
    if (!(next > 0.01 && next < 5)) break;
    if (Math.abs(next - s) < 1e-9) { s = next; break; }
    s = next;
  }
  return Math.abs(at(s) - price) < 1e-6 * Math.max(1, price) ? s : (lo + hi) / 2;
}

/**
 * Realized volatility RV_n (plan 04 P2): the sample standard deviation of the last `n` daily log returns × √252.
 * Uses only the closes given (the caller passes closes up to the day). Null with fewer than n + 1 closes or a
 * non-positive close in the window.
 */
export function realizedVol(closes: readonly number[], n: number): number | null {
  if (n < 2 || closes.length < n + 1) return null;
  const w = closes.slice(closes.length - n - 1);
  const rets: number[] = [];
  for (let i = 1; i < w.length; i++) {
    const a = w[i - 1] as number, b = w[i] as number;
    if (!(a > 0) || !(b > 0)) return null;
    rets.push(Math.log(b / a));
  }
  const mean = rets.reduce((x, y) => x + y, 0) / rets.length;
  const v = rets.reduce((x, y) => x + (y - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v) * Math.sqrt(252);
}
