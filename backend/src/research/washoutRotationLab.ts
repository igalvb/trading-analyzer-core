/**
 * Washout buys and in-list rotation (research only, owner 2026-11-07; docs/RESEARCH_WASHOUT_ROTATION_2026-11-07.md).
 * Nothing here is read by a live rule, a profile, the Buy report, the engine or a paper account.
 *
 * Daily bars; every decision uses bars dated on or before the decision day's close and trades at the next open
 * (test/research.washoutRotation.test.ts checks this by cutting the history). 25% tax (profile rate) on each sale's
 * gain and on what is still held at the end, 10 bps per side, $100,000 start, the research harness conventions
 * (research/portfolioLab.ts). Fractional shares.
 *
 * PRE-REGISTERED (fixed before any run, not tuned on 2024-26):
 * - Washout W1: close <= 20-day average - 2.5 SD (population SD of the 20 closes) AND close >= 20% below the highest
 *   close of the last 252 bars AND the 150-day average above its value 20 bars earlier. W2: 2.0 SD / 15%. W3: W1
 *   without the 150-day filter. At least 170 bars of history. Up to 3 slices per episode: slice 1 at the signal;
 *   slice 2 on the first later close above -2 SD; slice 3 on the first close above the 20-day average (slices 2 and 3
 *   may fall on the same close); an episode ends after slice 3 or 60 bars after its signal. A new episode needs a new
 *   signal after the last one ended (adds on later dips, no per-stock cap).
 * - Washout accounts (W1C/W1D/W2C/W3C): idle money in QQQ (harness convention); a slice is 1/15 of the account (a full
 *   3-slice episode = 20%), paid by selling QQQ; skipped in part when QQQ runs out (no margin).
 *   Exit C: a weekly close (last bar of the week) below the average of the last 40 weekly closes AND the 150-day
 *   average below its value 20 bars earlier: sell all. Exit D: never sell on price (held to the period's end).
 * - Rotation inside the list (R/RB/RS/RS-w), always invested, monthly (decide at a month's last close):
 *   R  = average rank of (150-day average / its value 63 bars ago) and the 126-bar return.
 *   RB = among stocks whose 150-day average was rising 63 bars ago (vs 20 bars before that): drawdown from the
 *        252-bar high x beta to QQQ (252 daily returns). Not qualified = bottom third.
 *   RS = among the same qualified stocks: average rank of the slopes of the 9-, 20- and 50-day averages over 5 / 10 /
 *        20 bars. RS-w: the same on weekly closes (completed weeks; 9/20/50 weeks over 5/10/20 weeks).
 *   Tiers: top third (round(n/3)) 2x, bottom third 0.5x, middle 1x, normalised. Target change per stock at most
 *   +-5 points per rebalance (then renormalised). A stock enters once it has the history its measure needs.
 *   TAX RULES (default): no trims; cash (exit proceeds, the start money) is directed to stocks below their target,
 *   in proportion to the shortfall. FULL EXIT only when the 150-day average has been falling (below its value 20 bars
 *   earlier) on each of the last 42 bars AND the stock was in the bottom third on the variant's measure at 3
 *   consecutive rebalances; then it is out for 12 calendar months. "Trims allowed" rows: the same, plus every
 *   rebalance sells stocks above target back to target.
 * - RW/RBW/RSW: the rotation on 80% of the account + 20% kept in QQQ as the washout budget; each W1 slice is 2% of
 *   the account, paid from that QQQ only (none left = no buy), added to the washed-out stock.
 *
 * RARER EXITS (pre-registered 2026-11-07 b, before any run; R and RW only; tax rules unchanged: no trims, cash to the
 * stocks under target). Each replaces the full-exit rule above; an exited stock is out for 12 months as before.
 * - X1: at a weekly close (the week's last bar), the 150-day average has been falling (below its value 20 bars
 *   earlier) on each of the last 126 bars (6 months) AND the close is under the average of the last 40 weekly closes.
 * - X2: X1, but never at a loss: decided only when at least one lot (one buy) is in profit at that close, net of the
 *   10 bps fee; at the next open only the lots in profit at that open are sold (each at its own cost); lots at a loss
 *   stay held. Lots are tracked per buy; every other sale reduces all lots of the stock pro rata (average cost).
 * - X3: no exits at all; the R weights only steer new cash (the start money and, for RW, the W1 buys).
 * - X4: at a quarter's last close (Mar / Jun / Sep / Dec), the stock's 252-bar return was in the bottom third
 *   (round(n/3) of the list stocks with 252 bars, held or not) at 4 consecutive quarter ends, this one included, AND
 *   the 150-day average is falling at this close. The quarter streak resets after an exit.
 */

import type { PriceSeries } from '../backtest/data.ts';
import { EXIT_TAX_RATE } from '../portfolio/exitTax.ts';

// ---- Fixed numbers (pre-registered). The washout signal itself lives in analysis/washout.ts (the live Washout ADD
// alert reads the same function); re-exported here unchanged. -------------------------------------------------------
import { SD_DAYS, HIGH_DAYS, LONG_DAYS, RISE_LAG, MIN_BARS, WASHOUTS, smaArr, sdArr, maxArr, washoutAt, type WashoutParams, type WashoutKey } from '../analysis/washout.ts';
export { SD_DAYS, HIGH_DAYS, LONG_DAYS, RISE_LAG, MIN_BARS, WASHOUTS, smaArr, washoutAt, type WashoutParams, type WashoutKey };
export const SLICE2_Z = -2;
export const EPISODE_BARS = 60;
export const WEEKS_AVG = 40;
export const FALL_BARS = 42;
export const BOTTOM_STREAK = 3;
export const OUT_MONTHS = 12;
export const MAX_STEP = 0.05;
export const WASHOUT_SLICE = 1 / 15;
export const RW_RESERVE = 0.2;
export const RW_SLICE = 0.02;
export const X1_FALL_BARS = 126;
export const X4_RET_BARS = 252;
export const X4_QUARTERS = 4;
export type ExitRule = 'base' | 'X1' | 'X2' | 'X3' | 'X4';

const DAY_MS = 86_400_000;
/** Monday-based week number of a 'YYYY-MM-DD' day. */
export function weekKey(d: string): number { return Math.floor((Date.parse(d + 'T00:00:00Z') / DAY_MS + 3) / 7); }

export interface Ind {
  readonly s: PriceSeries;
  readonly idx: ReadonlyMap<string, number>;
  readonly sma9: Array<number | null>; readonly sma20: Array<number | null>; readonly sma50: Array<number | null>; readonly sma150: Array<number | null>;
  readonly z: Array<number | null>;
  readonly hi252: number[];
  /** sma150[i] vs sma150[i-20]: +1 rising, -1 falling, 0 unknown/flat. */
  readonly dir150: number[];
  /** Bars in a row (ending at i) with the 150-day average falling. */
  readonly fallRun: number[];
  /** The bar is the week's last bar (the next bar is in another week; the last bar of the file only on a Friday). */
  readonly weekEnd: boolean[];
  /** Number of completed weeks up to and including bar i (weekly arrays index = that - 1). */
  readonly weeksDone: number[];
  readonly wClose: number[];
  readonly w40: Array<number | null>; readonly w9: Array<number | null>; readonly w20: Array<number | null>; readonly w50: Array<number | null>;
}

export function indicators(s: PriceSeries): Ind {
  const c = s.closes;
  const sma20 = smaArr(c, SD_DAYS), sd20 = sdArr(c, SD_DAYS, sma20), sma150 = smaArr(c, LONG_DAYS);
  const z = c.map((x, i) => (sma20[i] != null && sd20[i]! > 0 ? (x - sma20[i]!) / sd20[i]! : null));
  const dir150 = c.map((_, i) => { const a = sma150[i], b = i >= RISE_LAG ? sma150[i - RISE_LAG] : null; return a == null || b == null ? 0 : a > b ? 1 : a < b ? -1 : 0; });
  const fallRun: number[] = []; dir150.forEach((d, i) => fallRun.push(d < 0 ? (i ? fallRun[i - 1]! : 0) + 1 : 0));
  const weekEnd = s.dates.map((d, i) => (i < s.dates.length - 1 ? weekKey(s.dates[i + 1]!) !== weekKey(d) : new Date(d + 'T00:00:00Z').getUTCDay() === 5));
  const wClose: number[] = [], weeksDone: number[] = [];
  weekEnd.forEach((e, i) => { if (e) wClose.push(c[i]!); weeksDone.push(wClose.length); });
  return {
    s, idx: new Map(s.dates.map((d, i) => [d, i])), sma9: smaArr(c, 9), sma20, sma50: smaArr(c, 50), sma150, z, hi252: maxArr(c, HIGH_DAYS), dir150, fallRun,
    weekEnd, weeksDone, wClose, w40: smaArr(wClose, WEEKS_AVG), w9: smaArr(wClose, 9), w20: smaArr(wClose, 20), w50: smaArr(wClose, 50),
  };
}

const indCache = new WeakMap<PriceSeries, Ind>();
export function indOf(s: PriceSeries): Ind { let m = indCache.get(s); if (!m) { m = indicators(s); indCache.set(s, m); } return m; }

/** Exit C at bar i: a weekly close under the 40-week average while the 150-day average falls. */
export function exitCAt(ind: Ind, i: number): boolean {
  if (!ind.weekEnd[i]) return false;
  const w = ind.w40[ind.weeksDone[i]! - 1];
  return w != null && ind.s.closes[i]! < w && ind.dir150[i] === -1;
}

/** Exit X1 (and X2's trigger) at bar i: a weekly close under the 40-week average after 126 bars of a falling 150-day. */
export function exitX1At(ind: Ind, i: number): boolean {
  if (!ind.weekEnd[i] || ind.fallRun[i]! < X1_FALL_BARS) return false;
  const w = ind.w40[ind.weeksDone[i]! - 1];
  return w != null && ind.s.closes[i]! < w;
}

/** X4's thirds: the list stocks with a 252-bar return at the decision, bottom third = the round(n/3) lowest (ties by list order). */
export function bottomThirdRet(tickers: readonly string[], at: (t: string) => { ind: Ind; i: number } | null): Set<string> {
  const r: Array<{ t: string; v: number }> = [];
  for (const t of tickers) { const x = at(t); if (x && x.i >= X4_RET_BARS) r.push({ t, v: x.ind.s.closes[x.i]! / x.ind.s.closes[x.i - X4_RET_BARS]! - 1 }); }
  const order = [...r].sort((a, b) => a.v - b.v), third = Math.round(r.length / 3);
  return new Set(order.slice(0, third).map((x) => x.t));
}

// ---- Speed measures ------------------------------------------------------------------------------------------------
export type Speed = 'R' | 'RB' | 'RS' | 'RSw';
const slope = (a: ReadonlyArray<number | null>, i: number, k: number): number | null => (i - k >= 0 && a[i] != null && a[i - k] != null ? a[i]! / a[i - k]! - 1 : null);

/** Rising 3 months ago (63 bars), as the qualification for RB / RS / RS-w. null = not enough history. */
export function qualified(ind: Ind, i: number): boolean | null {
  if (i - 63 < MIN_BARS - 1) return null;
  return ind.dir150[i - 63] === 1;
}

function beta(ind: Ind, i: number, q: Ind): number | null {
  if (i < HIGH_DAYS) return null;
  const xs: number[] = [], ys: number[] = [];
  for (let k = i - HIGH_DAYS + 1; k <= i; k++) {
    const a = q.idx.get(ind.s.dates[k]!), b = q.idx.get(ind.s.dates[k - 1]!);
    if (a == null || b == null) continue;
    xs.push(q.s.closes[a]! / q.s.closes[b]! - 1); ys.push(ind.s.closes[k]! / ind.s.closes[k - 1]! - 1);
  }
  const n = xs.length; if (n < 200) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let cv = 0, vx = 0; for (let k = 0; k < n; k++) { cv += (xs[k]! - mx) * (ys[k]! - my); vx += (xs[k]! - mx) ** 2; }
  return vx > 0 ? cv / vx : null;
}

/** The raw inputs of a measure at bar i (higher = faster), or null when the stock cannot be ranked yet. */
export function speedInputs(sp: Speed, ind: Ind, i: number, q: Ind): number[] | null {
  if (sp === 'R') {
    const a = slope(ind.sma150, i, 63), b = i >= 126 ? ind.s.closes[i]! / ind.s.closes[i - 126]! - 1 : null;
    return a == null || b == null ? null : [a, b];
  }
  if (sp === 'RB') { const bt = beta(ind, i, q); return bt == null ? null : [(1 - ind.s.closes[i]! / ind.hi252[i]!) * bt]; }
  if (sp === 'RS') { const v = [slope(ind.sma9, i, 5), slope(ind.sma20, i, 10), slope(ind.sma50, i, 20)]; return v.some((x) => x == null) ? null : (v as number[]); }
  const w = ind.weeksDone[i]! - 1;
  const v = [slope(ind.w9, w, 5), slope(ind.w20, w, 10), slope(ind.w50, w, 20)];
  return v.some((x) => x == null) ? null : (v as number[]);
}

export interface Tiering { readonly tier: ReadonlyMap<string, 2 | 1 | 0.5>; readonly rank: ReadonlyMap<string, number> }

/**
 * Tiers at one decision: stocks with enough history; for RB/RS/RS-w those not qualified go to the bottom third and
 * are not ranked. Ranks: 0 = fastest (average of per-input ranks; ties by list order).
 */
export function tiersAt(sp: Speed, tickers: readonly string[], at: (t: string) => { ind: Ind; i: number } | null, q: Ind): Tiering {
  const cand: Array<{ t: string; v: number[] }> = [], unq: string[] = [];
  for (const t of tickers) {
    const x = at(t); if (!x) continue;
    const ql = qualified(x.ind, x.i);
    if (ql == null) continue;
    const v = speedInputs(sp, x.ind, x.i, q);
    if (!v) continue;
    if (sp !== 'R' && !ql) { unq.push(t); continue; }
    cand.push({ t, v });
  }
  const m = cand[0]?.v.length ?? 0;
  const avg = new Map(cand.map((c) => [c.t, 0]));
  for (let k = 0; k < m; k++) {
    const order = [...cand].sort((a, b) => b.v[k]! - a.v[k]!);
    order.forEach((c, r) => avg.set(c.t, avg.get(c.t)! + r / m));
  }
  const ranked = [...cand].sort((a, b) => avg.get(a.t)! - avg.get(b.t)!).map((c) => c.t);
  const all = [...ranked, ...unq], n = all.length, third = Math.round(n / 3);
  const tier = new Map<string, 2 | 1 | 0.5>();
  all.forEach((t, r) => tier.set(t, unq.includes(t) || r >= n - third ? 0.5 : r < third ? 2 : 1));
  return { tier, rank: new Map(ranked.map((t, r) => [t, r])) };
}

export function normalise(tier: ReadonlyMap<string, number>): Map<string, number> {
  const s = [...tier.values()].reduce((a, b) => a + b, 0);
  return new Map([...tier].map(([t, v]) => [t, s > 0 ? v / s : 0]));
}

/** New targets: each stock moves at most MAX_STEP from its previous target, then all are renormalised. */
export function stepTargets(prev: ReadonlyMap<string, number> | null, raw: ReadonlyMap<string, number>): Map<string, number> {
  if (!prev) return new Map(raw);
  const keys = new Set([...prev.keys(), ...raw.keys()]), out = new Map<string, number>();
  for (const t of keys) { const a = prev.get(t) ?? 0, b = raw.get(t) ?? 0; const v = a + Math.max(-MAX_STEP, Math.min(MAX_STEP, b - a)); if (v > 1e-9 && raw.has(t)) out.set(t, v); }
  return normalise(out);
}

// ---- The account ---------------------------------------------------------------------------------------------------
export type Rule =
  | { readonly kind: 'washout'; readonly signal: WashoutKey; readonly exit: 'C' | 'D' }
  | { readonly kind: 'rotation'; readonly speed: Speed; readonly trims: boolean; readonly washout: boolean; readonly exit?: ExitRule };

export interface Input { readonly series: ReadonlyMap<string, PriceSeries>; readonly qqq: PriceSeries; readonly bag: readonly string[] }
/** An exit fill. partial = X2 kept lots at a loss. */
export interface FullExit { readonly t: string; readonly date: string; readonly price: number; readonly partial?: boolean }
export interface RunResult {
  readonly finalTaxed: number; readonly finalPreTax: number; readonly maxDrawdownPct: number;
  readonly taxPaid: number; readonly stockSold: number; readonly avgEquity: number; readonly years: number;
  readonly holdDays: number[]; readonly exits: FullExit[]; readonly buys: number;
  /** Stock sales (not QQQ) whose proceeds after the fee were under their cost. */
  readonly lossSales: number;
  /** Trades of every open, in order (for the look-ahead test). */
  readonly log: string[];
}

interface Lot { shares: number; cost: number; opened: string; lots: Array<{ shares: number; cost: number }> }
type Order = { readonly sell: string; readonly frac: number; readonly profitOnly?: boolean } | { readonly buy: string; readonly amount: number } | { readonly allocate: true } | { readonly trimTo: true };

const addMonths = (d: string, n: number): string => { const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)) - 1 + n; return String(y + Math.floor(m / 12)) + '-' + String((m % 12) + 1).padStart(2, '0') + d.slice(7); };

export function run(rule: Rule, inp: Input, start: string, end: string, o: { readonly cash?: number; readonly costBps?: number } = {}): RunResult {
  const cash0 = o.cash ?? 100_000, c = (o.costBps ?? 10) / 10_000;
  const q = indOf(inp.qqq);
  const inds = new Map(inp.bag.filter((t) => inp.series.has(t)).map((t) => [t, indOf(inp.series.get(t)!)]));
  const qi0 = inp.qqq.dates.findIndex((d) => d >= start);
  const days = inp.qqq.dates.filter((d) => d >= start && d <= end);
  const at = (t: string, d: string): { ind: Ind; i: number } | null => { const ind = inds.get(t)!; const i = ind.idx.get(d); return i == null ? null : { ind, i }; };
  const pos = new Map<string, Lot>(), last = new Map<string, number>();
  let cash = cash0, taxPaid = 0, stockSold = 0, eqSum = 0, peak = cash0, maxDd = 0, buys = 0, lossSales = 0;
  const holdDays: number[] = [], exits: FullExit[] = [], log: string[] = [];
  const px = (t: string, d: string, f: 'opens' | 'closes'): number | null => {
    if (t === 'QQQ') { const i = q.idx.get(d); return i == null ? null : inp.qqq[f][i]!; }
    const x = at(t, d); return x ? x.ind.s[f][x.i]! : null;
  };
  const buy = (t: string, amount: number, p: number, d: string): void => {
    if (amount <= 0.01) return;
    amount = Math.min(amount, cash); if (amount <= 0.01) return;
    const sh = amount / (p * (1 + c));
    const x = pos.get(t) ?? { shares: 0, cost: 0, opened: d, lots: [] };
    if (x.shares === 0) x.opened = d;
    x.shares += sh; x.cost += amount; x.lots.push({ shares: sh, cost: amount }); pos.set(t, x); cash -= amount;
    if (t !== 'QQQ') { buys++; log.push(d + ' B ' + t + ' ' + amount.toFixed(2)); }
  };
  const sell = (t: string, shares: number, p: number, d: string): void => {
    const x = pos.get(t); if (!x || shares <= 0) return;
    shares = Math.min(shares, x.shares);
    const v = shares * p, fee = v * c, part = (x.cost * shares) / x.shares, tax = Math.max(0, v - fee - part) * EXIT_TAX_RATE;
    const keep = 1 - shares / x.shares; for (const l of x.lots) { l.shares *= keep; l.cost *= keep; }
    cash += v - fee - tax; taxPaid += tax; x.shares -= shares; x.cost -= part;
    if (t !== 'QQQ') { stockSold += v; log.push(d + ' S ' + t + ' ' + v.toFixed(2)); if (v - fee < part) lossSales++; }
    if (x.shares <= 1e-9) { pos.delete(t); if (t !== 'QQQ') holdDays.push((Date.parse(d) - Date.parse(x.opened)) / DAY_MS); }
  };
  /** X2: sell only the lots whose net proceeds at price p exceed their cost; returns the shares sold. */
  const sellProfitLots = (t: string, p: number, d: string): number => {
    const x = pos.get(t); if (!x) return 0;
    const win = x.lots.filter((l) => l.shares * p * (1 - c) > l.cost);
    if (!win.length) return 0;
    let sh = 0, cost = 0; for (const l of win) { sh += l.shares; cost += l.cost; }
    const v = sh * p, fee = v * c, tax = Math.max(0, v - fee - cost) * EXIT_TAX_RATE;
    cash += v - fee - tax; taxPaid += tax; stockSold += v; log.push(d + ' S ' + t + ' ' + v.toFixed(2));
    x.lots = x.lots.filter((l) => !win.includes(l)); x.shares -= sh; x.cost -= cost;
    if (x.shares <= 1e-9 || !x.lots.length) { pos.delete(t); holdDays.push((Date.parse(d) - Date.parse(x.opened)) / DAY_MS); }
    return sh;
  };
  /** X2's decision at a close: at least one lot in profit at that close, net of the fee. */
  const anyLotInProfit = (t: string, p: number): boolean => !!pos.get(t)?.lots.some((l) => l.shares * p * (1 - c) > l.cost);
  const val = (t: string, d: string, f: 'opens' | 'closes'): number => { const x = pos.get(t); if (!x) return 0; const p = px(t, d, f) ?? last.get(t) ?? 0; return x.shares * p; };
  const equity = (d: string, f: 'opens' | 'closes'): number => cash + [...pos.keys()].reduce((a, t) => a + val(t, d, f), 0);

  // rotation state
  let targets: Map<string, number> | null = null;
  const streak = new Map<string, number>(), outUntil = new Map<string, string>(), qStreak = new Map<string, number>();
  const exitRule: ExitRule = rule.kind === 'rotation' ? rule.exit ?? 'base' : 'base';
  // washout state: per ticker the open episode
  const ep = new Map<string, { k: number; slices: number }>();
  const wx = rule.kind === 'washout' ? WASHOUTS[rule.signal] : WASHOUTS.W1;
  const useWashout = rule.kind === 'washout' || rule.washout;
  const slice = rule.kind === 'washout' ? WASHOUT_SLICE : RW_SLICE;
  let pending: Order[] = [];

  const rebalanceDecision = (d: string): void => {
    if (rule.kind !== 'rotation') return;
    const eligible = [...inds.keys()].filter((t) => !(outUntil.get(t) && outUntil.get(t)! > d));
    const tier = new Map<string, number>(tiersAt(rule.speed, eligible, (t) => at(t, d), q).tier);
    // full exits (held stocks only)
    if (exitRule === 'base') for (const t of [...inds.keys()]) {
      const b = tier.get(t) === 0.5;
      streak.set(t, b ? (streak.get(t) ?? 0) + 1 : 0);
      const x = at(t, d);
      if (pos.has(t) && x && b && streak.get(t)! >= BOTTOM_STREAK && x.ind.fallRun[x.i]! >= FALL_BARS) {
        pending.push({ sell: t, frac: 1 }); outUntil.set(t, addMonths(d, OUT_MONTHS)); tier.delete(t); streak.set(t, 0);
      }
    }
    if (exitRule === 'X4' && ['03', '06', '09', '12'].includes(d.slice(5, 7))) {
      const bottom = bottomThirdRet([...inds.keys()], (t) => at(t, d));
      for (const t of [...inds.keys()]) {
        qStreak.set(t, bottom.has(t) ? (qStreak.get(t) ?? 0) + 1 : 0);
        const x = at(t, d);
        if (pos.has(t) && x && qStreak.get(t)! >= X4_QUARTERS && x.ind.dir150[x.i] === -1 && !pending.some((p) => 'sell' in p && p.sell === t)) {
          pending.push({ sell: t, frac: 1 }); outUntil.set(t, addMonths(d, OUT_MONTHS)); tier.delete(t); qStreak.set(t, 0);
        }
      }
    }
    targets = stepTargets(targets, normalise(tier));
    pending.push(rule.trims ? { trimTo: true } : { allocate: true });
  };

  const sleeveValue = (d: string): number => [...pos.keys()].filter((t) => t !== 'QQQ').reduce((a, t) => a + val(t, d, 'opens'), 0);
  const allocate = (d: string, spend: number): void => {
    if (!targets || spend <= 0.01) return;
    const V = sleeveValue(d) + spend;
    const tradable = [...targets].filter(([t]) => px(t, d, 'opens') != null);
    const gaps = tradable.map(([t, w]) => [t, Math.max(0, w * V - val(t, d, 'opens'))] as const);
    const g = gaps.reduce((a, [, x]) => a + x, 0);
    const plan = g > 0.01 ? gaps.map(([t, x]) => [t, (spend * x) / g] as const) : tradable.map(([t, w]) => [t, spend * w] as const);
    for (const [t, a] of plan) buy(t, Math.min(a, cash), px(t, d, 'opens')!, d);
  };

  const execute = (d: string): void => {
    const orders = pending; pending = [];
    for (const od of orders) if ('sell' in od) {
      const p = px(od.sell, d, 'opens'), x = pos.get(od.sell); if (p == null || !x) continue;
      if (od.profitOnly) { if (sellProfitLots(od.sell, p, d) > 0) exits.push({ t: od.sell, date: d, price: p, partial: pos.has(od.sell) }); continue; }
      sell(od.sell, x.shares * od.frac, p, d); if (od.frac === 1) exits.push({ t: od.sell, date: d, price: p });
    }
    for (const od of orders) if ('trimTo' in od && targets) {
      const V = sleeveValue(d) + cash;
      for (const [t] of pos) if (t !== 'QQQ') { const w = targets.get(t) ?? 0, v = val(t, d, 'opens'), p = px(t, d, 'opens'); if (p != null && v > w * V + 1) sell(t, (v - w * V) / p, p, d); }
    }
    for (const od of orders) if ('buy' in od) {
      const p = px(od.buy, d, 'opens'); if (p == null) continue;
      // washout accounts: cash first, then QQQ; rotation + washout: always from the QQQ budget
      const need = rule.kind === 'rotation' ? od.amount : od.amount - cash;
      if (need > 0) { const qp = px('QQQ', d, 'opens')!, qx = pos.get('QQQ'); if (qx) sell('QQQ', Math.min(qx.shares, (need / (qp * (1 - c))) * (1 + 1e-9)), qp, d); }
      buy(od.buy, Math.min(od.amount, cash), p, d);
    }
    for (const od of orders) if ('allocate' in od || 'trimTo' in od) allocate(d, cash);
    // idle money: washout accounts keep it in QQQ; rotation keeps what is left (rounding) in QQQ only with a reserve
    if (cash > 1 && (rule.kind === 'washout' || rule.washout)) buy('QQQ', cash, px('QQQ', d, 'opens')!, d);
    else if (cash > 1 && targets) allocate(d, cash);
  };

  // decision before the first open (the bar before the period)
  const pre = qi0 > 0 ? inp.qqq.dates[qi0 - 1]! : null;
  if (rule.kind === 'washout') pending.push({ buy: 'QQQ', amount: cash0 });
  else {
    if (pre) rebalanceDecision(pre); else pending.push({ allocate: true });
    if (rule.washout) pending.push({ buy: 'QQQ', amount: cash0 * RW_RESERVE });
  }

  for (let k = 0; k < days.length; k++) {
    const d = days[k]!;
    // QQQ "buy" orders before the first open are plain buys from cash, done first so the reserve is set aside
    if (k === 0) { const qo = pending.filter((x) => 'buy' in x && x.buy === 'QQQ'); pending = pending.filter((x) => !qo.includes(x)); for (const x of qo) buy('QQQ', (x as { amount: number }).amount, px('QQQ', d, 'opens')!, d); }
    execute(d);
    for (const t of [...pos.keys()]) { const p = px(t, d, 'closes'); if (p != null) last.set(t, p); }
    const eq = equity(d, 'closes');
    eqSum += eq; peak = Math.max(peak, eq); maxDd = Math.max(maxDd, (1 - eq / peak) * 100);
    if (k === days.length - 1) break;
    // ---- decisions at the close of d
    const monthEnd = (days[k + 1] ?? inp.qqq.dates[qi0 + k + 1] ?? '').slice(0, 7) !== d.slice(0, 7);
    if (rule.kind === 'washout' && rule.exit === 'C') for (const t of inds.keys()) { const x = at(t, d); if (x && pos.has(t) && exitCAt(x.ind, x.i)) { pending.push({ sell: t, frac: 1 }); ep.delete(t); } }
    if ((exitRule === 'X1' || exitRule === 'X2') && targets) for (const t of inds.keys()) {
      const x = at(t, d); if (!x || !pos.has(t) || !exitX1At(x.ind, x.i)) continue;
      if (exitRule === 'X2' && !anyLotInProfit(t, x.ind.s.closes[x.i]!)) continue;
      pending.push({ sell: t, frac: 1, ...(exitRule === 'X2' ? { profitOnly: true } : {}) }); outUntil.set(t, addMonths(d, OUT_MONTHS)); ep.delete(t);
      const tg: Map<string, number> = targets; tg.delete(t); targets = normalise(tg);
      if (!monthEnd) pending.push({ allocate: true });
    }
    if (rule.kind === 'rotation' && monthEnd) rebalanceDecision(d);
    if (useWashout) for (const t of inds.keys()) {
      const x = at(t, d); if (!x) continue;
      if (pending.some((p) => 'sell' in p && p.sell === t)) continue;
      if (outUntil.get(t) && outUntil.get(t)! > d) continue;
      let e = ep.get(t), n = 0;
      if (e && k - e.k > EPISODE_BARS) { ep.delete(t); e = undefined; }
      if (e) {
        const z = x.ind.z[x.i];
        if (e.slices === 1 && z != null && z > SLICE2_Z) { e.slices = 2; n++; }
        if (e.slices === 2 && x.ind.sma20[x.i] != null && x.ind.s.closes[x.i]! > x.ind.sma20[x.i]!) { e.slices = 3; n++; }
        if (e.slices === 3) ep.delete(t);
      } else if (washoutAt(x.ind, x.i, wx)) { ep.set(t, { k, slices: 1 }); n = 1; }
      if (n) {
        const amt = n * slice * eq;
        if (rule.kind === 'rotation') { const qv = val('QQQ', d, 'closes'); if (qv <= 1) continue; pending.push({ buy: t, amount: Math.min(amt, qv) }); }
        else pending.push({ buy: t, amount: amt });
      }
    }
  }
  const lastDay = days[days.length - 1]!;
  let finalTaxed = cash, finalPreTax = cash;
  for (const [t, x] of pos) {
    const v = x.shares * (last.get(t) ?? 0);
    finalPreTax += v; finalTaxed += v - Math.max(0, v - x.cost) * EXIT_TAX_RATE;
    if (t !== 'QQQ') holdDays.push((Date.parse(lastDay) - Date.parse(x.opened)) / DAY_MS);
  }
  return { finalTaxed, finalPreTax, maxDrawdownPct: maxDd, taxPaid, stockSold, avgEquity: days.length ? eqSum / days.length : cash0, years: days.length / 252, holdDays, exits, buys, lossSales, log };
}

// ---- Signal statistics ---------------------------------------------------------------------------------------------
export interface SignalStat { readonly n: number; readonly years: number; readonly hit20: number; readonly r10: number; readonly r20: number; readonly r40: number; readonly keptFalling: number }

/**
 * Every new signal (no signal in the 20 bars before) dated in [start, end], entry at the next open: forward returns to
 * the close 10 / 20 / 40 bars after the signal; "kept falling" = a close within the next 40 bars at least 15% under
 * the entry. Signals without 40 bars after them are left out.
 */
export function signalStats(series: readonly PriceSeries[], p: WashoutParams, start: string, end: string): SignalStat {
  const r10: number[] = [], r20: number[] = [], r40: number[] = []; let kept = 0, years = 0;
  for (const s of series) {
    const ind = indOf(s); let lastSig = -1e9;
    const inRange = s.dates.filter((d) => d >= start && d <= end).length; years = Math.max(years, inRange / 252);
    for (let i = 0; i < s.dates.length; i++) {
      if (!washoutAt(ind, i, p)) continue;
      const fresh = i - lastSig > 20; lastSig = i;
      if (!fresh || s.dates[i]! < start || s.dates[i]! > end || i + 40 >= s.dates.length) continue;
      const e = s.opens[i + 1]!;
      r10.push(s.closes[i + 10]! / e - 1); r20.push(s.closes[i + 20]! / e - 1); r40.push(s.closes[i + 40]! / e - 1);
      let mn = Infinity; for (let k = i + 1; k <= i + 40; k++) mn = Math.min(mn, s.closes[k]!);
      if (mn <= e * 0.85) kept++;
    }
  }
  const avg = (x: number[]): number => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
  return { n: r20.length, years, hit20: r20.length ? r20.filter((x) => x > 0).length / r20.length : NaN, r10: avg(r10), r20: avg(r20), r40: avg(r40), keptFalling: r20.length ? kept / r20.length : NaN };
}

/** The close at which bar i+1 would sit exactly `sd` SD under its 20-day average (bisection; the 19 closes before it fixed). */
export function closeForZ(s: PriceSeries, i: number, sd: number): number {
  const prev = s.closes.slice(i - SD_DAYS + 2, i + 1);
  const zOf = (x: number): number => { const a = [...prev, x], m = a.reduce((p, v) => p + v, 0) / a.length, v = Math.sqrt(a.reduce((p, y) => p + (y - m) ** 2, 0) / a.length); return (x - m) / v; };
  let lo = 0.01 * s.closes[i]!, hi = s.closes[i]!;
  if (zOf(hi) <= -sd) return hi;
  for (let k = 0; k < 80; k++) { const mid = (lo + hi) / 2; if (zOf(mid) <= -sd) lo = mid; else hi = mid; }
  return lo;
}
