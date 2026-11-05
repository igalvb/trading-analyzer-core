/**
 * James — Option Fair Value, model 4 (docs/models/plans/04-black-scholes-fair-value.md, pieces 4c-4e): James's
 * pricing view of one long call ("the length of time, the cost, and return"), built on the G2 pricer. A tool and a
 * display filter: nothing here changes a score, a pick or a verdict.
 *
 *   fair          Black-Scholes at a reference volatility: RV252 for LEAPS (>= 12 months), RV60 for short-term (P3)
 *   rich          mid / fair - 1; flagged above +25% (P5)
 *   IV ÷ realized the ATM IV of the contract's expiry / the reference volatility; flagged above 1.3 (P6)
 *   time cost     (time value / DTE) x 365 / (S x delta): the yearly price of each share of exposure (P9)
 *   break-even    K + ask, the rise needed and per year
 *   short guard   no new short-dated call at z >= +2 (20-day, daily closes; the deck's 4-hour chart is not
 *                 available) or with earnings within 5 trading days (P10, P11)
 * Thresholds are the plan's pre-registered defaults ([PROPOSED]; James gives none).
 */

import { bsCall, bsGreeks, impliedVol, type BsGreeks } from './blackScholes.ts';

export const FAIR_VALUE = { rich: 0.25, ivr: 1.3, leapsDays: 365, z: 2, earningsDays: 5 } as const;

export interface FvContract { readonly strike: number; readonly expUnix: number; readonly bid: number | null; readonly ask: number | null; readonly iv: number | null; readonly delta?: number | null }
export interface FvVols { readonly rv20: number | null; readonly rv60: number | null; readonly rv252: number | null }

export interface FairValue {
  readonly dte: number;
  readonly mid: number | null;
  readonly refVol: number | null; readonly refName: 'RV252' | 'RV60';
  readonly fair: number | null;
  readonly fairRv252: number | null; readonly fairRv60: number | null;
  readonly rich: number | null; readonly richFlag: boolean;
  readonly iv: number | null; readonly atmIv: number | null;
  readonly ivr: number | null; readonly ivrFlag: boolean;
  /** The volatility the mid itself implies (G2 solver), to check Cboe's iv. */
  readonly impliedFromMid: number | null;
  readonly intrinsic: number; readonly timeValue: number | null; readonly tvPct: number | null; readonly tvPerDay: number | null;
  readonly yearlyTimeCostPerDelta: number | null;
  readonly breakEven: number | null; readonly moveNeeded: number | null; readonly moveNeededPerYear: number | null;
  readonly greeks: BsGreeks | null;
}

/** The at-the-money IV of one expiry (linear in the strike between the two calls around the price). */
export function atmIvOf(calls: ReadonlyArray<{ strike: number; expUnix: number; iv: number | null }>, expUnix: number, spot: number): number | null {
  const xs = calls.filter((c) => c.expUnix === expUnix && c.iv != null && c.iv > 0).sort((a, b) => a.strike - b.strike);
  if (!xs.length) return null;
  const lo = xs.filter((c) => c.strike <= spot).pop(), hi = xs.find((c) => c.strike > spot);
  if (lo && hi) return (lo.iv as number) + ((hi.iv as number) - (lo.iv as number)) * ((spot - lo.strike) / (hi.strike - lo.strike));
  return (lo ?? hi)!.iv;
}

export function fairValueOf(c: FvContract, spot: number, nowUnix: number, vols: FvVols, rate: number, atmIv: number | null = null): FairValue {
  const dte = Math.max(0, (c.expUnix - nowUnix) / 86_400), T = dte / 365;
  const bid = c.bid ?? 0, ask = c.ask ?? 0;
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : ask > 0 ? ask : null;
  const leaps = dte >= FAIR_VALUE.leapsDays;
  const refName = leaps ? 'RV252' : 'RV60', refVol = leaps ? vols.rv252 : vols.rv60;
  const price = (s: number | null): number | null => (s != null && s > 0 && T > 0 ? bsCall({ S: spot, K: c.strike, T, sigma: s, r: rate }) : null);
  const fair = price(refVol);
  const rich = fair != null && fair > 0 && mid != null ? mid / fair - 1 : null;
  const iv = c.iv != null && c.iv > 0 ? c.iv : null;
  const atm = atmIv ?? iv;
  const ivr = atm != null && refVol != null && refVol > 0 ? atm / refVol : null;
  const intrinsic = Math.max(spot - c.strike, 0);
  const timeValue = mid != null ? mid - intrinsic : null;
  const greeks = T > 0 && (iv ?? refVol) ? bsGreeks({ S: spot, K: c.strike, T, sigma: (iv ?? refVol) as number, r: rate }) : null;
  const delta = c.delta != null && c.delta > 0 ? c.delta : greeks?.delta ?? null;
  const be = ask > 0 ? c.strike + ask : mid != null ? c.strike + mid : null;
  const move = be != null ? be / spot - 1 : null;
  return {
    dte, mid, refVol, refName, fair, fairRv252: price(vols.rv252), fairRv60: price(vols.rv60),
    rich, richFlag: rich != null && rich > FAIR_VALUE.rich, iv, atmIv: atm, ivr, ivrFlag: ivr != null && ivr > FAIR_VALUE.ivr,
    impliedFromMid: mid != null && T > 0 ? impliedVol(mid, { S: spot, K: c.strike, T, r: rate }) : null,
    intrinsic, timeValue, tvPct: timeValue != null ? timeValue / spot : null, tvPerDay: timeValue != null && dte > 0 ? timeValue / dte : null,
    yearlyTimeCostPerDelta: timeValue != null && dte > 0 && delta ? ((timeValue / dte) * 365) / (spot * delta) : null,
    breakEven: be, moveNeeded: move, moveNeededPerYear: move != null && dte > 0 && 1 + move > 0 ? Math.pow(1 + move, 365 / dte) - 1 : null, greeks,
  };
}

/** The "what the call is worth" grid (the sheets' "Prior vs At Expiration" lesson): rows today / in 180 days / at expiry. */
export function scenarioGrid(c: { strike: number; expUnix: number }, spot: number, nowUnix: number, sigma: number, rate: number, moves: readonly number[] = [-0.2, -0.1, 0, 0.1, 0.2]): Array<{ label: string; values: number[] }> {
  const dte = (c.expUnix - nowUnix) / 86_400;
  const at = (days: number): number[] => moves.map((m) => bsCall({ S: spot * (1 + m), K: c.strike, T: Math.max(0, days) / 365, sigma, r: rate }));
  return [{ label: 'today', values: at(dte) }, ...(dte > 180 ? [{ label: 'in 180 d', values: at(dte - 180) }] : []), { label: 'at expiry', values: at(0) }];
}

export interface ShortCallGuard { readonly ok: boolean; readonly reasons: readonly string[]; readonly earnings: 'clear' | 'near' | 'unknown' }

/** P10 + P11: no new short-dated call into a +2 SD spike or within 5 trading days of earnings. */
export function shortCallGuard(x: { z: number | null; tradingDaysToEarnings: number | null }): ShortCallGuard {
  const reasons: string[] = [];
  if (x.z != null && x.z >= FAIR_VALUE.z) reasons.push('z = ' + (x.z >= 0 ? '+' : '') + x.z.toFixed(1) + ' (overextended, +2 or more)');
  const earnings = x.tradingDaysToEarnings == null ? 'unknown' : x.tradingDaysToEarnings <= FAIR_VALUE.earningsDays ? 'near' : 'clear';
  if (earnings === 'near') reasons.push('earnings in ' + x.tradingDaysToEarnings + ' trading days (a buyer pays the event premium)');
  return { ok: reasons.length === 0, reasons, earnings };
}
