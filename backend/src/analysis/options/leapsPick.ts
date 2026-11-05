/**
 * James — LEAPS, model 3 (docs/models/plans/03-james-leaps-method.md section 2.2 A): James's contract pick, NEXT TO
 * the engine's (`selectRecommendedCall` in conviction.ts is not changed and stays the control).
 *
 *   expiry   the January (third-Friday series) closest to 19 months out, within 13-26 months (master plan D5; owner
 *            2026-10-30: keep plan 03's rules as written). Today, 29 Oct 2026: Jan 2028 (14.8 months).
 *   strike   the call whose delta is nearest the target (0.60 / 0.75 / 0.85 run side by side); Cboe's delta, else
 *            the Black-Scholes delta (G2) from the contract's own Cboe iv. Ties: the lower spread.
 *   gates    break-even: BEM = (K + ask) / S - 1, per year (1 + BEM)^(365 / DTE) - 1 <= 12% (James's GOOG buy was
 *            9.9% a year, "no brainer"); liquidity [PROPOSED, ours]: bid > 0, spread (ask - bid) / mid <= 10%,
 *            open interest >= 100. A failing best contract steps to the next strikes of the same expiry within
 *            +-0.10 delta, nearest first; nothing passing = "no liquid contract" with the reasons.
 *   shown    time value share (mid - intrinsic) / S, never gated.
 *
 * Pure. Works on the live Cboe chain and on a stored G3 snapshot (paper/chainSnapshot.ts: the same fields).
 */

import { parseOcc, type CboeChainJson } from '../../fetch/cboe.ts';
import { bsGreeks } from './blackScholes.ts';

export const JAMES_LEAPS = {
  targetMonths: 19, minMonths: 13, maxMonths: 26,
  deltas: [0.60, 0.75, 0.85] as readonly number[],
  mainDelta: 0.75,
  /** Break-even per year at most this (James: GOOG 9.9%/yr; owner 2026-10-30: 12% as written). */
  beGate: 0.12,
  maxSpread: 0.10, minOi: 100,
  /** Neighbours tried when the best contract fails a gate: within this delta of the target. */
  stepDelta: 0.10,
} as const;

export interface JamesCall {
  readonly strike: number; readonly expUnix: number;
  readonly bid: number | null; readonly ask: number | null; readonly iv: number | null; readonly delta: number | null; readonly oi: number | null;
  /** The OCC symbol (live chain); absent on a stored snapshot. */
  readonly symbol?: string;
}

/** Every call of a Cboe chain with its OCC symbol. */
export function jamesCallsOf(json: CboeChainJson | null | undefined): JamesCall[] {
  const out: JamesCall[] = [];
  const num = (v: unknown): number | null => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  for (const o of json?.data?.options ?? []) {
    if (!o || !o.option) continue;
    const p = parseOcc(String(o.option));
    if (p.side !== 'call' || !(p.strike > 0)) continue;
    out.push({ strike: p.strike, expUnix: p.expUnix, bid: num(o.bid), ask: num(o.ask), iv: num(o.iv), delta: num(o.delta), oi: num(o.open_interest), symbol: String(o.option) });
  }
  return out;
}

const DAY = 86_400;

/** `ymd` + `months` calendar months, 00:00 UTC, in Unix seconds (day clamped to the month's end). */
export function addMonthsUnix(ymd: string, months: number): number {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last)) / 1000;
}

/** The third Friday of a month, 'YYYY-MM-DD' (the standard monthly expiry; LEAPS expire on January's). */
export function thirdFriday(year: number, month1: number): string {
  const first = new Date(Date.UTC(year, month1 - 1, 1)).getUTCDay(); // 0 = Sunday
  const day = 1 + ((5 - first + 7) % 7) + 14;
  return year + '-' + String(month1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

/**
 * James's January among `expiries` (Unix seconds) for a decision on `today` ('YYYY-MM-DD'): the January within
 * 13-26 months nearest 19 months (the earlier on a tie); null when none.
 */
export function jamesJanuary(expiries: Iterable<number>, today: string, o: { targetMonths?: number; minMonths?: number; maxMonths?: number } = {}): number | null {
  const lo = addMonthsUnix(today, o.minMonths ?? JAMES_LEAPS.minMonths), hi = addMonthsUnix(today, o.maxMonths ?? JAMES_LEAPS.maxMonths), t = addMonthsUnix(today, o.targetMonths ?? JAMES_LEAPS.targetMonths);
  let best: number | null = null;
  for (const e of [...new Set(expiries)].sort((a, b) => a - b)) {
    if (new Date(e * 1000).getUTCMonth() !== 0 || e < lo || e > hi) continue;
    if (best == null || Math.abs(e - t) < Math.abs(best - t)) best = e;
  }
  return best;
}

/** The January third-Friday dates (synthetic history) within 13-26 months of `today`, the one nearest 19 months. */
export function jamesJanuaryDate(today: string, o: { targetMonths?: number; minMonths?: number; maxMonths?: number } = {}): string | null {
  const y = Number(today.slice(0, 4));
  const cands = [y, y + 1, y + 2, y + 3].map((yy) => Date.parse(thirdFriday(yy, 1) + 'T00:00:00Z') / 1000);
  const e = jamesJanuary(cands, today, o);
  return e == null ? null : new Date(e * 1000).toISOString().slice(0, 10);
}

export interface BreakEven { readonly breakEven: number; readonly bem: number; readonly bemYear: number | null; readonly dte: number }

/** The break-even check (plan 03 S5): BEM = (K + ask) / S - 1 and per year over the calendar days left. */
export function breakEvenOf(spot: number, strike: number, ask: number, dte: number): BreakEven {
  const breakEven = strike + ask, bem = breakEven / spot - 1;
  return { breakEven, bem, bemYear: dte > 0 && 1 + bem > 0 ? Math.pow(1 + bem, 365 / dte) - 1 : null, dte };
}

export interface GateResult {
  readonly name: 'break-even' | 'bid' | 'spread' | 'open interest';
  readonly ok: boolean;
  readonly value: number | null;
  readonly limit: number;
}

export interface JamesContract {
  readonly strike: number; readonly expUnix: number; readonly symbol: string | null;
  readonly bid: number; readonly ask: number; readonly mid: number;
  readonly delta: number; readonly deltaSource: 'cboe' | 'black-scholes';
  readonly iv: number | null; readonly oi: number | null;
  readonly dte: number;
  readonly breakEven: number; readonly bem: number; readonly bemYear: number | null;
  readonly spread: number | null;
  /** (mid - intrinsic) / S: shown, not gated. */
  readonly timeValuePct: number;
  readonly gates: readonly GateResult[];
  readonly passes: boolean;
}

export interface JamesPick {
  readonly targetDelta: number;
  readonly expUnix: number | null;
  /** The contract bought: the best one that passes every gate; null when none. */
  readonly contract: JamesContract | null;
  /** The contract nearest the target delta (shown even when it fails). */
  readonly nearest: JamesContract | null;
  /** Every contract looked at, nearest first. */
  readonly tried: readonly JamesContract[];
  readonly reason: string | null;
}

export interface PickOptions {
  readonly beGate?: number | null;
  readonly maxSpread?: number | null;
  readonly minOi?: number | null;
  /** The risk-free rate for a Black-Scholes delta (fraction); default 0.04. */
  readonly rate?: number;
}

/** One contract's numbers and gates. Null when it has no usable delta. */
export function jamesContractOf(c: JamesCall, spot: number, nowUnix: number, o: PickOptions = {}): JamesContract | null {
  const dte = Math.max(0, (c.expUnix - nowUnix) / DAY);
  let delta = c.delta != null && Number.isFinite(c.delta) && c.delta > 0 ? c.delta : null, src: JamesContract['deltaSource'] = 'cboe';
  if (delta == null && c.iv != null && c.iv > 0 && dte > 0) { delta = bsGreeks({ S: spot, K: c.strike, T: dte / 365, sigma: c.iv, r: o.rate ?? 0.04 }).delta; src = 'black-scholes'; }
  if (delta == null) return null;
  const bid = c.bid ?? 0, ask = c.ask ?? 0, mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : ask > 0 ? ask : bid;
  const be = breakEvenOf(spot, c.strike, ask > 0 ? ask : mid, dte);
  const spread = bid > 0 && ask > 0 && mid > 0 ? (ask - bid) / mid : null;
  const gates: GateResult[] = [];
  const beGate = o.beGate === undefined ? JAMES_LEAPS.beGate : o.beGate;
  if (beGate != null) gates.push({ name: 'break-even', ok: be.bemYear != null && ask > 0 && be.bemYear <= beGate, value: be.bemYear, limit: beGate });
  if (o.maxSpread !== null) {
    gates.push({ name: 'bid', ok: bid > 0, value: bid, limit: 0 });
    gates.push({ name: 'spread', ok: spread != null && spread <= (o.maxSpread ?? JAMES_LEAPS.maxSpread), value: spread, limit: o.maxSpread ?? JAMES_LEAPS.maxSpread });
  }
  if (o.minOi !== null) gates.push({ name: 'open interest', ok: (c.oi ?? 0) >= (o.minOi ?? JAMES_LEAPS.minOi), value: c.oi, limit: o.minOi ?? JAMES_LEAPS.minOi });
  return {
    strike: c.strike, expUnix: c.expUnix, symbol: c.symbol ?? null, bid, ask, mid, delta, deltaSource: src, iv: c.iv, oi: c.oi, dte,
    breakEven: be.breakEven, bem: be.bem, bemYear: be.bemYear, spread, timeValuePct: (mid - Math.max(spot - c.strike, 0)) / spot,
    gates, passes: gates.every((g) => g.ok),
  };
}

/** James's pick at one target delta (plan 03 2.2 A). `today` = the decision day, 'YYYY-MM-DD' (New York). */
export function selectJamesLeaps(calls: readonly JamesCall[], spot: number | null, nowUnix: number, today: string, targetDelta: number, o: PickOptions = {}): JamesPick {
  const none = (reason: string, expUnix: number | null = null): JamesPick => ({ targetDelta, expUnix, contract: null, nearest: null, tried: [], reason });
  if (!calls.length) return none('no chain');
  if (spot == null || !(spot > 0)) return none('no stock price');
  const exp = jamesJanuary(calls.map((c) => c.expUnix), today);
  if (exp == null) return none('no January expiry ' + JAMES_LEAPS.minMonths + '-' + JAMES_LEAPS.maxMonths + ' months out');
  const cs = calls.filter((c) => c.expUnix === exp).map((c) => jamesContractOf(c, spot, nowUnix, o)).filter((c): c is JamesContract => !!c);
  if (!cs.length) return none('no usable delta at the January expiry', exp);
  const order = [...cs].sort((a, b) => Math.abs(a.delta - targetDelta) - Math.abs(b.delta - targetDelta) || (a.spread ?? 9) - (b.spread ?? 9) || a.strike - b.strike);
  const nearest = order[0]!;
  const tried = [nearest, ...order.slice(1).filter((c) => Math.abs(c.delta - targetDelta) <= JAMES_LEAPS.stepDelta + 1e-9)];
  const contract = tried.find((c) => c.passes) ?? null;
  const fails = (c: JamesContract): string => c.gates.filter((g) => !g.ok).map((g) => g.name).join(', ');
  return { targetDelta, expUnix: exp, contract, nearest, tried, reason: contract ? null : 'no liquid contract: ' + tried.map((c) => '$' + c.strike + ' (' + fails(c) + ')').join('; ') };
}

/** The three side-by-side picks (0.60 / 0.75 / 0.85). */
export function jamesLeapsPicks(calls: readonly JamesCall[], spot: number | null, nowUnix: number, today: string, o: PickOptions = {}): JamesPick[] {
  return JAMES_LEAPS.deltas.map((d) => selectJamesLeaps(calls, spot, nowUnix, today, d, o));
}

/** Attached to the engine's LEAPS pick by the options run (non-enumerable, as the expiry comparison): the chain's calls. */
export const JAMES_CALLS_KEY = 'jamesCalls';
export function attachJamesCalls<T extends object>(pick: T, calls: readonly JamesCall[] | null, spot: number | null): T {
  if (calls && calls.length) Object.defineProperty(pick, JAMES_CALLS_KEY, { value: { calls, spot }, enumerable: false, configurable: true });
  return pick;
}
export function jamesCallsOfPick(pick: unknown): { calls: readonly JamesCall[]; spot: number | null } | null {
  return pick && typeof pick === 'object' ? ((pick as Record<string, unknown>)[JAMES_CALLS_KEY] as { calls: readonly JamesCall[]; spot: number | null } | undefined) ?? null : null;
}
