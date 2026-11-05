/**
 * James — Multi-Year Cycle, Part A (docs/models/plans/07-multi-year-cycle.md section 2b): the equity cycle book. Plain
 * JSON, so the paper test keeps it between nights; the history runner (`runCycle`) and the paper account share it.
 *
 * The account holds a core (the top-K leaders) and dry powder (cash). At the close, from the cycle reads
 * (analysis/models/cycleRegime.ts):
 *   - start: the top-K leaders get the money (minus the starting dry powder), equal shares;
 *   - deploy: a deep-bottom stock gets the dry powder in tranches (1/3 at the signal, 1/3 after 20 trading days still in
 *     the zone or 10% lower, whichever first, 1/3 on the turnaround = a close above the 20-day average), deepest
 *     drawdown first, at most `kb` at once; a stock must leave the zone before it can trigger again;
 *   - harvest: a held stock near the top sells `p` of its shares, at most once per 20 trading days, never below half of
 *     its peak share count; `r` of the money goes at once to the current top leader (not the harvested stock);
 *   - full rotation (variant): after 2+ harvests, when the stock's 126-day return trails QQQ's and another leader
 *     qualifies, the rest moves to that leader;
 *   - never panic-sell: no stop, no trend exit (variants for the comparison: a 30% trailing stop, the Trend 200 sell).
 * Fills at the next open; sells first, then buys; 25% tax (EXIT_TAX_RATE) on every sale's gain; the shared `costBps` on
 * every buy and sell. Dry powder in cash earns the Fed funds rate (the prior month's, point-in-time), or waits in QQQ.
 */

import fs from 'node:fs';
import path from 'node:path';
import { EXIT_TAX_RATE } from '../portfolio/exitTax.ts';
import { phaseAt, isDeepBottom, isNearTop, isPump, leaderScore, PHASE_DEFAULT, type CycleSignals, type PhaseOptions } from '../analysis/models/cycleRegime.ts';

export interface CycleOptions extends PhaseOptions {
  /** Turnaround gate before the first tranche: none (default), a close above the 20-day average, a weekly close above the 10-week average. */
  readonly gate: 'none' | 'sma20' | 'w10';
  readonly tranches: 1 | 3;
  readonly kb: number;
  /** Harvest share of the current shares (D9: 20%). */
  readonly p: number;
  /** Share of each harvest rotated at once into the top leader. */
  readonly r: number;
  readonly fullRotation: boolean;
  /** Top-K leaders in the core (D9: 3). */
  readonly k: number;
  readonly dontChase: boolean;
  /** Rule 5 comparison only: 'none' = never panic-sell (default). */
  readonly panic: 'none' | 'trail30' | 'trend200';
  readonly startDry: number;
  readonly idle: 'cash' | 'qqq';
  readonly costBps?: number;
}
export const CYCLE_DEFAULT: CycleOptions = { ...PHASE_DEFAULT, gate: 'none', tranches: 3, kb: 1, p: 0.2, r: 0.5, fullRotation: false, k: 3, dontChase: true, panic: 'none', startDry: 0, idle: 'cash' };

export interface CyclePos { shares: number; cost: number; peak: number; lastHarvest: number; harvests: number; hi: number }
export interface CycleDeploy { t: string; budget: number; spent: number; done: number; signalPx: number; age: number; armed: boolean }
export interface CycleOrder { t: string; side: 'BUY' | 'SELL'; money?: number; shares?: number; why: string; rotate?: number; leader?: string | null; kind: 'start' | 'deploy' | 'harvest' | 'rotate' | 'panic' }
export interface CycleBook {
  cash: number; qqq: { shares: number; cost: number }; pos: Record<string, CyclePos>; deploys: CycleDeploy[]; orders: CycleOrder[];
  /** Decision nights so far (the harvest spacing counts them). */
  night: number; started: boolean;
  /** Stocks that deployed during their current stay in the deep-bottom zone (one deployment per stay). */
  inZone: string[];
}
export const newCycleBook = (cash: number): CycleBook => ({ cash, qqq: { shares: 0, cost: 0 }, pos: {}, deploys: [], orders: [], night: 0, started: false, inZone: [] });

export interface CycleTrade { readonly ticker: string; readonly side: 'BUY' | 'SELL'; readonly shares: number; readonly price: number; readonly tax: number; readonly why: string; readonly kind: CycleOrder['kind'] | 'idle' }

/** The fills at the open. `rate`: Fed funds, % a year, accrued on cash for this day (0 in the paper test). */
export function cycleFill(b: CycleBook, o: CycleOptions, opens: ReadonlyMap<string, number>, qqqOpen: number | null, rate = 0): CycleTrade[] {
  const out: CycleTrade[] = [], c = (o.costBps ?? 0) / 10_000;
  if (b.cash > 0 && rate > 0) b.cash *= 1 + rate / 100 / 252;
  const sellQqq = (money: number): void => {
    if (!qqqOpen || !b.qqq.shares || money <= 0) return;
    const n = Math.min(b.qqq.shares, Math.ceil(money / (qqqOpen * (1 - c))));
    const cost = (b.qqq.cost * n) / b.qqq.shares, fee = n * qqqOpen * c, tax = Math.max(0, n * qqqOpen - fee - cost) * EXIT_TAX_RATE;
    b.qqq.shares -= n; b.qqq.cost -= cost; b.cash += n * qqqOpen - fee - tax;
    out.push({ ticker: 'QQQ', side: 'SELL', shares: n, price: qqqOpen, tax, why: 'money for the buys', kind: 'idle' });
  };
  const buy = (t: string, money: number, why: string, kind: CycleOrder['kind']): void => {
    const px = opens.get(t);
    if (px == null || money <= 0) return;
    if (money > b.cash) sellQqq(money - b.cash);
    const pc = px * (1 + c), n = Math.floor(Math.min(money, b.cash) / pc);
    if (n <= 0) return;
    b.cash -= n * pc;
    const p = b.pos[t] ??= { shares: 0, cost: 0, peak: 0, lastHarvest: -1e9, harvests: 0, hi: px };
    p.shares += n; p.cost += n * pc; p.peak = Math.max(p.peak, p.shares); p.hi = Math.max(p.hi, px);
    out.push({ ticker: t, side: 'BUY', shares: n, price: px, tax: 0, why, kind });
    const dep = b.deploys.find((x) => x.t === t);
    if (kind === 'deploy' && dep) dep.spent += n * pc;
  };
  const orders = b.orders;
  b.orders = [];
  const rotations: Array<{ t: string; money: number; why: string }> = [];
  for (const x of orders.filter((y) => y.side === 'SELL')) {
    const p = b.pos[x.t], px = opens.get(x.t);
    if (!p || px == null) continue;
    const n = Math.min(p.shares, x.shares ?? p.shares);
    if (n <= 0) continue;
    const cost = (p.cost * n) / p.shares, fee = n * px * c, tax = Math.max(0, n * px - fee - cost) * EXIT_TAX_RATE, net = n * px - fee - tax;
    p.shares -= n; p.cost -= cost; b.cash += net;
    if (p.shares <= 0) delete b.pos[x.t];
    out.push({ ticker: x.t, side: 'SELL', shares: n, price: px, tax, why: x.why, kind: x.kind });
    if (x.rotate && x.leader) rotations.push({ t: x.leader, money: net * x.rotate, why: 'rotation from ' + x.t + ' into the top leader' });
  }
  for (const y of rotations) buy(y.t, y.money, y.why, 'rotate');
  for (const x of orders.filter((y) => y.side === 'BUY')) buy(x.t, x.money ?? 0, x.why, x.kind);
  if (o.idle === 'qqq' && qqqOpen) {
    const pc = qqqOpen * (1 + c), n = Math.floor(b.cash / pc);
    if (n > 0) { b.cash -= n * pc; b.qqq.shares += n; b.qqq.cost += n * pc; out.push({ ticker: 'QQQ', side: 'BUY', shares: n, price: qqqOpen, tax: 0, why: 'dry powder in QQQ', kind: 'idle' }); }
  }
  return out;
}

export interface CycleCtx {
  readonly day: string;
  /** Per ticker trading tonight: its cycle reads and today's index in them, and the close. */
  readonly stocks: ReadonlyMap<string, { readonly s: CycleSignals; readonly i: number; readonly close: number; /** the traded instrument's close when the reads come from another series (IBIT on BTC-USD's bar) */ readonly price?: number }>;
  readonly qqqRet126: number | null;
  readonly qqqClose: number | null;
  /** Random-signal null: deployments start / harvests fire on these days instead of the zones. */
  readonly randomDeploy?: ReadonlySet<string> | null;
  readonly randomHarvest?: ReadonlySet<string> | null;
}

export function cycleEquity(b: CycleBook, closeOf: (t: string) => number | null): number {
  let v = b.cash + b.qqq.shares * (closeOf('QQQ') ?? (b.qqq.shares ? b.qqq.cost / b.qqq.shares : 0));
  for (const [t, p] of Object.entries(b.pos)) v += p.shares * (closeOf(t) ?? p.cost / p.shares);
  return v;
}
export function cycleValue(b: CycleBook, closeOf: (t: string) => number | null): number {
  const taxed = (n: number, cost: number, px: number): number => n * px - Math.max(0, n * px - cost) * EXIT_TAX_RATE;
  let v = b.cash + (b.qqq.shares ? taxed(b.qqq.shares, b.qqq.cost, closeOf('QQQ') ?? b.qqq.cost / b.qqq.shares) : 0);
  for (const [t, p] of Object.entries(b.pos)) v += taxed(p.shares, p.cost, closeOf(t) ?? p.cost / p.shares);
  return v;
}
export const cycleHeld = (b: CycleBook): string[] => Object.keys(b.pos).sort();

/** The leaders tonight, best first (don't chase: no pump stock). */
export function leadersTonight(o: CycleOptions, x: CycleCtx): Array<{ t: string; score: number }> {
  const out: Array<{ t: string; score: number }> = [];
  for (const [t, a] of x.stocks) {
    const sc = leaderScore(a.s, a.i, x.qqqRet126);
    if (sc == null || (o.dontChase && isPump(a.s, a.i))) continue;
    out.push({ t, score: sc });
  }
  return out.sort((a, b) => b.score - a.score || a.t.localeCompare(b.t));
}

/** Tonight's decisions for the next open. Returns the reasons in words (for the log). */
export function cycleDecide(b: CycleBook, o: CycleOptions, x: CycleCtx): void {
  b.night++;
  const closeOf = (t: string): number | null => { if (t === 'QQQ') return x.qqqClose; const a = x.stocks.get(t); return a ? a.price ?? a.close : null; };
  const eq = cycleEquity(b, closeOf);
  const leaders = leadersTonight(o, x);
  const orders: CycleOrder[] = [];
  const selling = new Set<string>();
  // start: the top-K leaders with all the money (minus the starting dry powder)
  if (!b.started && leaders.length) {
    b.started = true;
    const money = (eq * (1 - o.startDry)) / o.k;
    for (const l of leaders.slice(0, o.k)) orders.push({ t: l.t, side: 'BUY', money, why: 'start: a top-' + o.k + ' leader (126-day return ' + (l.score >= 0 ? '+' : '') + (l.score * 100).toFixed(0) + ' points vs QQQ)', kind: 'start' });
  }
  // the held stocks: panic variants, harvest, full rotation
  for (const [t, p] of Object.entries(b.pos)) {
    const a = x.stocks.get(t);
    if (!a) continue;
    p.hi = Math.max(p.hi, a.close);
    if (o.panic === 'trail30' && a.close <= p.hi * 0.7) { orders.push({ t, side: 'SELL', why: 'variant: 30% trailing stop', kind: 'panic' }); selling.add(t); continue; }
    if (o.panic === 'trend200' && a.s.trend200[a.i] === 'cautionary') { orders.push({ t, side: 'SELL', why: 'variant: Trend 200 sell', kind: 'panic' }); selling.add(t); continue; }
    const leader = leaders.find((l) => l.t !== t)?.t ?? null;
    if (o.fullRotation && p.harvests >= 2 && leader && a.s.ret126[a.i] != null && x.qqqRet126 != null && (a.s.ret126[a.i] as number) < x.qqqRet126) {
      orders.push({ t, side: 'SELL', why: 'full rotation: 2+ harvests and trailing QQQ over 6 months', rotate: 1, leader, kind: 'rotate' }); selling.add(t); continue;
    }
    const top = x.randomHarvest ? x.randomHarvest.has(t) : isNearTop(a.s, a.i, o);
    if (top && b.night - p.lastHarvest >= 20) {
      const keep = Math.ceil(p.peak / 2), n = Math.min(Math.floor(p.shares * o.p), p.shares - keep);
      if (n > 0) {
        p.lastHarvest = b.night; p.harvests++;
        const mayer = a.s.mayer[a.i];
        orders.push({ t, side: 'SELL', shares: n, why: 'harvest ' + Math.round(o.p * 100) + '% near the top' + (mayer != null ? ' (Mayer ' + mayer.toFixed(2) + ')' : '') + (o.r && leader ? '; ' + Math.round(o.r * 100) + '% to ' + leader : ''), rotate: o.r, leader, kind: 'harvest' });
      }
    }
  }
  // deployments in progress: tranches 2 and 3
  const zoneNow = new Set<string>();
  for (const [t, a] of x.stocks) if (isDeepBottom(a.s, a.i, o)) zoneNow.add(t);
  for (const dp of b.deploys) {
    dp.age++;
    const a = x.stocks.get(dp.t);
    if (!a || selling.has(dp.t)) continue;
    const tranche = dp.budget / o.tranches, left = Math.max(0, dp.budget - dp.spent);
    if (!dp.armed) {
      const ok = o.gate === 'sma20' ? a.s.sma20[a.i] != null && a.close > (a.s.sma20[a.i] as number) : o.gate === 'w10' ? a.s.wAbove10[a.i] === true : true;
      if (ok) { dp.armed = true; dp.age = 0; dp.done = 1; dp.signalPx = a.close; orders.push({ t: dp.t, side: 'BUY', money: Math.min(tranche, left), why: 'deploy tranche 1 of ' + o.tranches + ' after the turnaround', kind: 'deploy' }); }
      continue;
    }
    if (o.tranches === 3 && dp.done === 1 && ((dp.age >= 20 && (x.randomDeploy ? true : zoneNow.has(dp.t))) || a.close <= dp.signalPx * 0.9)) { dp.done = 2; orders.push({ t: dp.t, side: 'BUY', money: Math.min(tranche, left), why: 'deploy tranche 2 of 3 (' + (a.close <= dp.signalPx * 0.9 ? '10% lower' : '20 days in the zone') + ')', kind: 'deploy' }); }
    else if (o.tranches === 3 && dp.done === 2 && a.s.sma20[a.i] != null && a.close > (a.s.sma20[a.i] as number)) { dp.done = 3; orders.push({ t: dp.t, side: 'BUY', money: left, why: 'deploy tranche 3 of 3 (turnaround: a close above the 20-day average)', kind: 'deploy' }); }
  }
  b.inZone = b.inZone.filter((t) => zoneNow.has(t));
  // finished or stale deployments end (the unspent money stays dry powder)
  b.deploys = b.deploys.filter((dp) => !(dp.done >= o.tranches || (!dp.armed && dp.age > 60) || dp.age > 250));
  // new deployments: deepest first, at most kb at once, one per stay in the zone
  const committed = b.deploys.reduce((s, dp) => s + Math.max(0, dp.budget - dp.spent), 0);
  const startingMoney = orders.filter((y) => y.kind === 'start').reduce((s, y) => s + (y.money ?? 0), 0);
  let dry = b.cash + b.qqq.shares * (x.qqqClose ?? 0) - committed - startingMoney;
  const fresh = [...x.stocks].filter(([t, a]) => (x.randomDeploy ? x.randomDeploy.has(t) : zoneNow.has(t) && !b.inZone.includes(t)) && !b.deploys.some((dp) => dp.t === t) && !selling.has(t) && a)
    .map(([t, a]) => ({ t, dd: a.s.dd[a.i] ?? 0, a })).sort((p, q) => q.dd - p.dd || p.t.localeCompare(q.t));
  for (const f of fresh) {
    if (b.deploys.length >= o.kb || dry <= eq * 0.01) break;
    const budget = dry / (o.kb - b.deploys.length);
    dry -= budget;
    const dp: CycleDeploy = { t: f.t, budget, spent: 0, done: 0, signalPx: f.a.close, age: 0, armed: o.gate === 'none' };
    b.deploys.push(dp);
    if (!b.inZone.includes(f.t)) b.inZone.push(f.t);
    if (dp.armed) { dp.done = 1; orders.push({ t: f.t, side: 'BUY', money: budget / o.tranches, why: 'deploy tranche 1 of ' + o.tranches + ': ' + Math.round(f.dd * 100) + '% under the 52-week high' + (o.bottomTest === '200w' && f.a.s.sma200w[f.a.i] != null ? ', under the 200-week average' : ', weekly RSI under 30'), kind: 'deploy' }); }
  }
  b.inZone.sort();
  b.orders = orders;
}

/** Fed funds (backend/legacy/historical_data/fedfunds.csv, monthly): the prior month's rate, % a year. */
export function loadFedFunds(file = path.join(path.dirname(new URL(import.meta.url).pathname), '../../legacy/historical_data/fedfunds.csv')): (day: string) => number {
  const rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.split(',')).map(([d, v]) => [String(d).slice(0, 7), Number(v)] as const).filter(([, v]) => Number.isFinite(v));
  const m = new Map(rows);
  return (day: string): number => {
    const y = Number(day.slice(0, 4)), mo = Number(day.slice(5, 7));
    const prev = mo === 1 ? (y - 1) + '-12' : y + '-' + String(mo - 1).padStart(2, '0');
    return m.get(prev) ?? 0;
  };
}


// ─────────────────────────────── Parts B + C: the BTC sleeve (descriptive only) ───────────────────────────────

/**
 * james.cycleBtc (plan 07 section 8): a sleeve of IBIT run on the frozen-from-2017 halving calendar (deploy from month
 * 23 to month 6, harvest months 14-20) and the price-only regime (deploy also in Bottom, harvest also in Top, no new
 * buys while risk-off), the rest in the Part A leaders. Monthly steps at the first decision night of a month:
 * deploy = (S x account - sleeve) / months left in the deploy window; harvest = H x the sleeve at the window's start /
 * 7 months (a Top outside the window: H / 3 of the sleeve). Sleeve buys are funded from cash, then from the core pro
 * rata; the harvest money goes to the top leader. Fitted on all known cycles: descriptive, never judged as a model.
 */
export interface BtcSleeveOptions { readonly ticker: string; readonly size: number; readonly harvest: number; readonly k: number; readonly costBps?: number }
export const BTC_SLEEVE_DEFAULT: BtcSleeveOptions = { ticker: 'IBIT', size: 0.5, harvest: 0.5, k: 3 };
export interface BtcSleeveBook {
  cash: number; sleeve: { shares: number; cost: number }; core: Record<string, { shares: number; cost: number }>;
  /** 'YYYY-MM' of the last monthly step; the sleeve's share count when the harvest window opened. */
  month: string | null; harvestBase: number | null; started: boolean;
  orders: Array<{ t: string; side: 'BUY' | 'SELL'; money?: number; shares?: number; why: string; rotate?: boolean }>;
}
export const newBtcSleeveBook = (cash: number): BtcSleeveBook => ({ cash, sleeve: { shares: 0, cost: 0 }, core: {}, month: null, harvestBase: null, started: false, orders: [] });

export function btcSleeveFill(b: BtcSleeveBook, o: BtcSleeveOptions, opens: ReadonlyMap<string, number>): CycleTrade[] {
  const out: CycleTrade[] = [], c = (o.costBps ?? 0) / 10_000;
  const hold = (t: string): { shares: number; cost: number } => (t === o.ticker ? b.sleeve : (b.core[t] ??= { shares: 0, cost: 0 }));
  const sell = (t: string, n: number, why: string): number => {
    const h = hold(t), px = opens.get(t);
    n = Math.min(n, h.shares); if (px == null || n <= 0) return 0;
    const cost = (h.cost * n) / h.shares, fee = n * px * c, tax = Math.max(0, n * px - fee - cost) * EXIT_TAX_RATE;
    h.shares -= n; h.cost -= cost; b.cash += n * px - fee - tax;
    if (t !== o.ticker && h.shares <= 0) delete b.core[t];
    out.push({ ticker: t, side: 'SELL', shares: n, price: px, tax, why, kind: t === o.ticker ? 'harvest' : 'rotate' });
    return n * px - fee - tax;
  };
  const buy = (t: string, money: number, why: string): void => {
    const px = opens.get(t); if (px == null || money <= 0) return;
    if (money > b.cash && t === o.ticker) {
      // fund the sleeve from the core, pro rata
      const need = money - b.cash, core = Object.entries(b.core).filter(([x]) => opens.has(x)), tot = core.reduce((a, [x, h]) => a + h.shares * (opens.get(x) as number), 0);
      if (tot > 0) for (const [x, h] of core) sell(x, Math.ceil((need * ((h.shares * (opens.get(x) as number)) / tot)) / ((opens.get(x) as number) * (1 - c))), 'money for the BTC sleeve');
    }
    const pc = px * (1 + c), n = Math.floor(Math.min(money, b.cash) / pc);
    if (n <= 0) return;
    const h = hold(t); h.shares += n; h.cost += n * pc; b.cash -= n * pc;
    out.push({ ticker: t, side: 'BUY', shares: n, price: px, tax: 0, why, kind: t === o.ticker ? 'deploy' : 'start' });
  };
  const orders = b.orders; b.orders = [];
  let harvested = 0;
  for (const x of orders.filter((y) => y.side === 'SELL')) harvested += sell(x.t, x.shares ?? 0, x.why);
  for (const x of orders.filter((y) => y.side === 'BUY')) buy(x.t, x.rotate ? harvested : x.money ?? 0, x.why);
  return out;
}

export interface BtcSleeveCtx {
  readonly day: string;
  /** The halving window (frozen-from-2017) and the BTC regime on the bar before `day`. */
  readonly window: 'deploy' | 'harvest' | 'hold' | null; readonly halvingMonth: number | null;
  readonly zone: 'bottom' | 'top' | 'riskOff' | 'neutral' | null; readonly riskOff: boolean;
  readonly sleevePx: number | null;
  /** The Part A leaders tonight, best first, and the closes for the valuation. */
  readonly leaders: ReadonlyArray<{ t: string }>;
  readonly closeOf: (t: string) => number | null;
}
export function btcSleeveEquity(b: BtcSleeveBook, o: BtcSleeveOptions, closeOf: (t: string) => number | null): number {
  let v = b.cash + b.sleeve.shares * (closeOf(o.ticker) ?? (b.sleeve.shares ? b.sleeve.cost / b.sleeve.shares : 0));
  for (const [t, h] of Object.entries(b.core)) v += h.shares * (closeOf(t) ?? h.cost / h.shares);
  return v;
}
export function btcSleeveValue(b: BtcSleeveBook, o: BtcSleeveOptions, closeOf: (t: string) => number | null): number {
  const taxed = (n: number, cost: number, px: number): number => n * px - Math.max(0, n * px - cost) * EXIT_TAX_RATE;
  let v = b.cash + (b.sleeve.shares ? taxed(b.sleeve.shares, b.sleeve.cost, closeOf(o.ticker) ?? b.sleeve.cost / b.sleeve.shares) : 0);
  for (const [t, h] of Object.entries(b.core)) v += taxed(h.shares, h.cost, closeOf(t) ?? h.cost / h.shares);
  return v;
}
export const btcSleeveHeld = (b: BtcSleeveBook, o: BtcSleeveOptions): string[] => [...Object.keys(b.core), ...(b.sleeve.shares ? [o.ticker] : [])].sort();

/** Months left in the frozen deploy window (month 23 to month 6 of the next cycle), this month included. */
export const deployMonthsLeft = (h: number): number => (h >= 23 ? 48 - h + 7 : Math.max(1, 7 - h));

export function btcSleeveDecide(b: BtcSleeveBook, o: BtcSleeveOptions, x: BtcSleeveCtx): void {
  const eq = btcSleeveEquity(b, o, x.closeOf);
  const orders: BtcSleeveBook['orders'] = [];
  const starting = !b.started && x.leaders.length > 0;
  if (starting) b.started = true;
  const month = x.day.slice(0, 7);
  if (b.started && b.month !== month && x.sleevePx) {
    b.month = month;
    const h = x.halvingMonth, sleeveV = b.sleeve.shares * x.sleevePx;
    const harvest = x.window === 'harvest' || x.zone === 'top', deploy = !harvest && (x.window === 'deploy' || x.zone === 'bottom') && !x.riskOff;
    if (x.window !== 'harvest') b.harvestBase = null;
    if (harvest && b.sleeve.shares > 0) {
      if (x.window === 'harvest' && b.harvestBase == null) b.harvestBase = b.sleeve.shares;
      const n = x.window === 'harvest' ? Math.floor(((b.harvestBase ?? b.sleeve.shares) * o.harvest) / 7) : Math.floor((b.sleeve.shares * o.harvest) / 3);
      if (n > 0) {
        orders.push({ t: o.ticker, side: 'SELL', shares: n, why: 'BTC sleeve harvest (' + (x.window === 'harvest' ? 'halving month ' + h + ', the harvest window' : 'regime Top') + ')' });
        const lead = x.leaders[0]?.t;
        if (lead) orders.push({ t: lead, side: 'BUY', rotate: true, why: 'BTC sleeve harvest money to the top leader' });
      }
    } else if (deploy && sleeveV < o.size * eq) {
      const left = x.window === 'deploy' && h != null ? deployMonthsLeft(h) : 3;
      const money = (o.size * eq - sleeveV) / left;
      if (money > eq * 0.005) orders.push({ t: o.ticker, side: 'BUY', money, why: 'BTC sleeve deploy step (' + (x.window === 'deploy' ? 'halving month ' + h + ', the deploy window' : 'regime Bottom') + '; ' + left + ' monthly steps left)' });
    }
  }
  // the start: the top-K leaders share what the first sleeve step leaves
  if (starting) {
    const left = eq - orders.filter((y) => y.side === 'BUY' && y.t === o.ticker).reduce((a, y) => a + (y.money ?? 0), 0);
    orders.unshift(...x.leaders.slice(0, o.k).map((l) => ({ t: l.t, side: 'BUY' as const, money: left / o.k, why: 'start: a top-' + o.k + ' Part A leader' })));
  }
  b.orders = orders;
}
