/**
 * Portfolio lab (owner 2026-10-28): one $100,000 account, a bag of 10-15 stocks, and each model decides every
 * day which of them to hold. 5 slots of 20%; a stock takes a free slot when the model says buy (highest
 * conviction first), leaves on its own sell rule; empty slots are held in QQQ (never in cash). Decide at the close,
 * trade at the next open, 25% tax on every sale's gain (QQQ included). No model or score code is changed.
 */

import type { PriceSeries } from '../backtest/data.ts';
import { exitReadFor } from '../backtest/engineRun.ts';
import { EXIT_TAX_RATE } from '../portfolio/exitTax.ts';
import { wyckoffClassicSeries, type WyckoffDirection } from '../analysis/models/wyckoffClassic.ts';
import { trendSeries, type TrendDay } from '../analysis/models/trendFollow.ts';

const trendCache = new WeakMap<PriceSeries, Map<number, Map<string, TrendDay>>>();
function trendOf(s: PriceSeries, days = 150): Map<string, TrendDay> {
  let byDays = trendCache.get(s);
  if (!byDays) { byDays = new Map(); trendCache.set(s, byDays); }
  let m = byDays.get(days);
  if (!m) { const o = trendSeries(s.closes, days); m = new Map(s.dates.map((d, i) => [d, o[i]!])); byDays.set(days, m); }
  return m;
}
import type { CompactRead } from './computeReads.ts';
import { randomSignalNull, NULL_SEEDS, type NullDistribution } from './guards.ts';
import { layerTimeline, layerUnit, layerPrices, DEFAULT_LAYER_OPTIONS, type LayerOptions } from '../analysis/models/liloLayers.ts';
import { newPtState, profitTakingFills, sharesToSell, percentLevels11, noteStep, type PtSchedule, type PtState } from '../analysis/models/profitTaking.ts';
import { atrSeries, annualVol, volScale, bookReturns, newDdBrake, ddStep, DD_CUT_TO, DD_AVG_DAYS, VOL_LOOKBACK, VOL_STEP, ATR_DAYS, ATR_COOLDOWN, type FallOverlay, type FallOverlayStats } from './fallOverlay.ts';

export const PORTFOLIO_MODELS = ['engine', 'current', 'schabacker', 'edwardsMagee', 'broker', 'turtle', 'wyckoff', 'trend', 'combo', 'best'] as const;
export type PortfolioModel = (typeof PORTFOLIO_MODELS)[number];
const DIR_INDEX: Readonly<Record<string, number>> = { engine: 0, broker: 1, schabacker: 2, edwardsMagee: 3, turtle: 4 };
const HOLD_OFF = new Set(['SPLIT', 'NO_CONSENSUS']);

export interface PortfolioInput {
  readonly series: ReadonlyMap<string, PriceSeries>;
  readonly reads: ReadonlyMap<string, ReadonlyMap<string, CompactRead>>;
  readonly qqq: PriceSeries;
}
export interface PortfolioOptions {
  readonly slots: number; readonly cash: number;
  /** docs/LONG_HISTORY_PLAN.md A/B: the bars the engine's exit read sees (default: the 2-year window, production today). */
  readonly chartBars?: number;
  /** 'model' (default): each model's own sell rule; 'trend': sell only when the 150-day trend breaks (lever 1, sell less). */
  readonly exit?: 'model' | 'trend';
  /** Fill mode (lever 2): every N trading days, hold the top-ranked eligible stocks in every slot. */
  readonly rebalanceDays?: number;
  /**
   * Market filter (owner 2026-10-28, against the 2022 losses): the market turns "down" when QQQ closes 3% under its
   * 150-day average and "up" again when QQQ is back above a rising average. While down: 'noBuys' = no new stocks,
   * spare money in cash instead of QQQ; 'exitAll' = also sell every stock.
   */
  readonly marketFilter?: 'off' | 'noBuys' | 'exitAll';
  /** Buy only when the stock's own 150-day trend is up (Trend model as confirmation). */
  readonly confirmTrend?: boolean;
  /** Trend length for the stocks (the Trend model, SELL LESS, the confirmation and the ranking). Default 150. */
  readonly trendDays?: number;
  /** Trend length for the market filter on QQQ. Default 150. */
  readonly marketDays?: number;
  /** Free play (owner 2026-10-28): no slot limit; every holding gets an equal share of the account. `slots` is ignored. */
  readonly free?: boolean;
  /**
   * Where idle money waits (owner 2026-10-28: not always QQQ, "especially when the trend is against you").
   * 'qqq' (default) = always QQQ; 'cash' = never; 'qqqTrend' = QQQ only while QQQ's own trend (idleDays, default 200)
   * is up, cash once QQQ closes 3% under its average, back in when QQQ is above a rising average again.
   * Unlike the market filter, this never stops the model buying stocks.
   */
  readonly idle?: 'qqq' | 'cash' | 'qqqTrend';
  readonly idleDays?: number;
  /**
   * G5 (docs/models/MASTER_PLAN.md T4): the trading cost in basis points of the money traded, charged on every buy
   * and sell (QQQ included). A buy's cost is part of its cost basis; a sell's is taken from the proceeds before the
   * tax. Unset or 0 = today's results exactly.
   */
  readonly costBps?: number;
  /**
   * G5 random-signal null (research/guards.ts): when set, the model's buy signal is replaced by these days (ticker ->
   * decision days); its sell rule and every other rule stay. Not used by fill mode (`rebalanceDays`).
   */
  readonly buyDays?: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * James — Profit-Taking (docs/models/plans/02-master-profit-taking.md, G6): a sell schedule at layers 6-10 on top of
   * the model's own entries. Absent = today's results exactly.
   */
  readonly profitTaking?: ProfitTakingOverlay;
  /**
   * James — LEAPS (model 3's twin runs, research/leapsLab.ts): called after each close's decisions with the stocks the
   * model holds for the next open (held minus tonight's sells, plus tonight's buys). Read only; results unchanged.
   */
  readonly onDecide?: (day: string, want: readonly string[]) => void;
  /**
   * James — Quality Gate (docs/models/plans/10-quality-gate-8-step-ackman.md, phase 5): a stock not held takes a free
   * slot only when `gate(ticker, decision day)` is true (buys only: a held stock is never sold for a score drop).
   * Absent = today's results exactly.
   */
  readonly gate?: (ticker: string, day: string) => boolean;
  /** Plan 10's size variant: a buy's slot is scaled by this (0-1) at its decision day; the rest stays in QQQ. Absent = full slots. */
  readonly sizeScale?: (ticker: string, day: string) => number;
  /**
   * Row 42, the deep falls (research/fallOverlay.ts, docs/models/results/deep-falls.md): one fall-cutting overlay on
   * the host (market cut, drawdown brake, volatility target, max position weight, per-stock ATR stop). Absent = today's
   * results exactly.
   */
  readonly fallOverlay?: FallOverlay;
}

/** Plan 02's overlay options (defaults: anchor layers, the rest on the model's own sell, cash into QQQ, intraday limit sells). */
export interface ProfitTakingOverlay {
  readonly schedule: PtSchedule;
  /** P1: 'anchor' = G1's LILO v2 layers frozen at the first buy; 'entry' = L0 at the entry price, u = 5 x SD50 that day; 'percent' = entry x 1.25 / 1.5 / 2 / 2.5 / 3. */
  readonly layers?: 'anchor' | 'entry' | 'percent';
  /** P4: what happens to the rest once a step has sold: the model's own sell, held to the end, or the 200-day trend sell. */
  readonly rest?: 'own' | 'hold' | 'trend200';
  /** P5: where a step's cash goes: QQQ (at the next open), cash, or the strongest stock of the bag not held (126-day return), one slot. */
  readonly cashTo?: 'qqq' | 'cash' | 'fasterHorse';
  /** P3: limit sells at the layers during the day, or a close at the layer sells at the next open. */
  readonly trigger?: 'intraday' | 'close';
  /** The anchor layers' options (default G1's A1-63, U1 k=5). */
  readonly layerOptions?: LayerOptions;
  /**
   * The exit's random-signal null (plan 02 section 6): no layers; on these decision days a held position sells its
   * schedule's next step at the next open (the same number of partial sells, the same size, on random days).
   */
  readonly randomSells?: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Plan 02's per-position check of a schedule (only positions where a step sold). */
export interface ProfitTakingStats {
  readonly positions: number;
  /** Steps sold, and per ticker (the exit null draws as many). */
  readonly sells: number; readonly sellsByTicker: ReadonlyMap<string, number>;
  /** Decision days each ticker was held under a schedule (the exit null's random days are drawn from these). */
  readonly heldDaysByTicker: ReadonlyMap<string, readonly string[]>;
  /** Sheet-faithful, pre-tax (the B4 fix): r0 x the last step's price - (step cash + shares left x that price), summed. */
  readonly leftOnTableSheet: number;
  /** After tax, at each position's final exit (or the period end): holding the r0 shares minus what the schedule produced (step cash after tax + the rest after tax; the cash's own growth is left out). */
  readonly leftOnTableReal: number;
  /** Positions where the schedule produced more than holding. */
  readonly helped: number;
  /** Strategy ROI / HODL ROI over those positions (the 2023-10-07 post's "ROI vs Oppty Cost Ratio", reconstructed). */
  readonly roiRatio: number | null;
}
export interface PortfolioResult {
  readonly finalTaxed: number; readonly trades: number; readonly avgStocksHeld: number; readonly qqqShare: number; /** Largest fall from a high, % (before tax). */ readonly maxDrawdownPct: number;
  /** G5: the share of the account in cash (not in a stock, not in QQQ) at each day's close, for the best-days check. */
  readonly cashShareByDay: ReadonlyMap<string, number>;
  /** G5: the stock buys per ticker (for the random-signal null: the same number of trades in the same stocks). */
  readonly buysByTicker: ReadonlyMap<string, number>;
  /** With `profitTaking`: the schedule's per-position check. */
  readonly profitTaking?: ProfitTakingStats;
  /** With `gate`: per ticker, the decision days a buy signal (stock not held) was blocked by the gate, and all such buy-signal days. */
  readonly gateStats?: { readonly blockedByTicker: ReadonlyMap<string, number>; readonly signalDaysByTicker: ReadonlyMap<string, number> };
  /** With `fallOverlay`: what the overlay did. */
  readonly fallStats?: FallOverlayStats;
}

interface PtPos { st: PtState; startCost: number; net: number; sheetLeft: number | null }
interface Pos { shares: number; cost: number; entryDate: string; pt?: PtPos; /** fallOverlay 'atr': the highest close since the buy. */ hi?: number }

const wyCache = new WeakMap<PriceSeries, Map<string, WyckoffDirection>>();
function wyOf(s: PriceSeries): Map<string, WyckoffDirection> {
  let m = wyCache.get(s);
  if (!m) { const o = wyckoffClassicSeries(s); m = new Map(s.dates.map((d, i) => [d, o[i]!.direction])); wyCache.set(s, m); }
  return m;
}

export function runPortfolio(model: PortfolioModel, bag: readonly string[], inp: PortfolioInput, start: string, end: string, o: PortfolioOptions): PortfolioResult {
  const idx = new Map<string, Map<string, number>>();
  for (const t of [...bag, 'QQQ']) {
    const s = t === 'QQQ' ? inp.qqq : inp.series.get(t);
    if (s) idx.set(t, new Map(s.dates.map((d, i) => [d, i])));
  }
  const ser = (t: string): PriceSeries => (t === 'QQQ' ? inp.qqq : (inp.series.get(t) as PriceSeries));
  const px = (t: string, d: string, at: 'opens' | 'closes'): number | null => { const k = idx.get(t)?.get(d); return k == null ? null : (ser(t)[at][k] as number); };
  const days = inp.qqq.dates.filter((d) => d >= start && d <= end);
  const dirOf = (m: string, t: string, d: string): string | null => {
    if (m === 'wyckoff') return ({ bullish: 'b', mixed: 'm', cautionary: 'c' } as Record<string, string>)[wyOf(ser(t)).get(d) ?? ''] ?? null;
    if (m === 'trend') return ({ bullish: 'b', mixed: 'm', cautionary: 'c' } as Record<string, string>)[trendOf(ser(t), o.trendDays ?? 150).get(d)?.direction ?? ''] ?? null;
    const r = inp.reads.get(t)?.get(d);
    return r ? (r.dir[DIR_INDEX[m] as number] ?? null) : null;
  };
  /** Does the model say buy / sell for this stock today? */
  const modelSays = (m: PortfolioModel, t: string, d: string, side: 'buy' | 'sell'): boolean => {
    if (side === 'buy' && o.buyDays) return !!o.buyDays.get(t)?.has(d);
    const r = inp.reads.get(t)?.get(d);
    if (m === 'engine' || m === 'current') {
      if (side === 'buy') return !!r && r.ok === 1 && r.c != null && (r.tm === 'BUY_NOW' || r.c >= 70) && (m === 'engine' || !HOLD_OFF.has(String(r.v)));
      const x = pos.get(t); if (!x) return false;
      const e = exitReadFor(ser(t), d, x.entryDate, x.cost / x.shares, o.chartBars ? { chartBars: o.chartBars } : {});
      return e.ok && e.actionClass === 'EXIT';
    }
    if (m === 'best') {
      // the engine's buy (tier 1) OR the 2-of-3 combo's buy; it has no sell of its own (use exit: 'trend')
      return side === 'buy' && (modelSays('engine', t, d, 'buy') || modelSays('combo', t, d, 'buy'));
    }
    if (m === 'combo') {
      // Turtle + Schabacker + Edwards & Magee: buy when 2 of 3 read bullish, sell when 2 of 3 read cautionary
      const ds = ['turtle', 'schabacker', 'edwardsMagee'].map((x) => dirOf(x, t, d));
      return ds.filter((x) => x === (side === 'buy' ? 'b' : 'c')).length >= 2;
    }
    return dirOf(m, t, d) === (side === 'buy' ? 'b' : 'c');
  };
  /** Fill mode's eligibility for a stock not held: the model is not saying sell (any read but cautionary). */
  const notSell = (t: string, d: string): boolean => {
    if (model === 'combo') return !modelSays('combo', t, d, 'sell');
    const k = model === 'engine' || model === 'current' ? 'engine' : model;
    return dirOf(k, t, d) !== 'c';
  };
  /** Ranking among buy candidates: the engine's conviction (buy-now first); for the price-only models, how far above its 150-day average the stock is. */
  const rankOf = (m: PortfolioModel, t: string, d: string): number => {
    const r = inp.reads.get(t)?.get(d);
    if (m === 'engine' || m === 'current' || m === 'best') return (r?.c ?? 0) + (r?.tm === 'BUY_NOW' ? 1000 : 0);
    return trendOf(ser(t), o.trendDays ?? 150).get(d)?.strength ?? -1;
  };
  const c = (o.costBps ?? 0) / 10_000;
  const buysByTicker = new Map<string, number>();
  let cash = o.cash, trades = 0, heldSum = 0, qShareSum = 0, peak = o.cash, maxDd = 0;
  const cashShareByDay = new Map<string, number>();
  const pos = new Map<string, Pos>();
  const lastPx = new Map<string, number>();
  let toSell: string[] = [], toBuy: string[] = [];
  let toScale = new Map<string, number>();
  const gBlocked = new Map<string, number>(), gSignal = new Map<string, number>();
  /** The model's buy for a stock not held, through the quality gate when there is one (counted for the gate's report). */
  const buyThroughGate = (t: string, d: string): boolean => {
    if (!modelSays(model, t, d, 'buy')) return false;
    if (ov?.kind === 'atr' && (coolUntil.get(t) ?? -1) >= curI) return false;
    if (!o.gate) return true;
    gSignal.set(t, (gSignal.get(t) ?? 0) + 1);
    if (o.gate(t, d)) return true;
    gBlocked.set(t, (gBlocked.get(t) ?? 0) + 1);
    return false;
  };
  let marketDown = false;
  let idleOut = o.idle === 'cash';
  // ── row 42 fall overlay (only with `fallOverlay`) ──
  const ov = o.fallOverlay;
  let scale = 1, pendScale: number | null = null, ovCash = 0, curI = 0, ovMktDown = false;
  let ovTrims: Array<{ t: string; n: number }> = [];
  const coolUntil = new Map<string, number>(), ddb = newDdBrake();
  const ovStats = { rescales: 0, scaledDays: 0, stops: 0, trims: 0 };

  const sell = (t: string, p: number): void => {
    const x = pos.get(t); if (!x) return;
    const v = x.shares * p, fee = v * c, gain = v - fee - x.cost;
    cash += v - fee - Math.max(0, gain) * EXIT_TAX_RATE; pos.delete(t); if (t !== 'QQQ') trades++;
    if (x.pt) ptClose(x, p, v - fee - Math.max(0, gain) * EXIT_TAX_RATE);
  };
  /** A partial sale (fee, tax on the part's gain); the position goes when nothing is left. */
  const sellPart = (t: string, n: number, p: number): void => {
    const x = pos.get(t); if (!x) return;
    n = Math.min(n, x.shares); if (n <= 0) return;
    if (n === x.shares) { sell(t, p); return; }
    const part = (x.cost * n) / x.shares, v = n * p, fee = v * c, gain = v - fee - part;
    x.shares -= n; x.cost -= part; cash += v - fee - Math.max(0, gain) * EXIT_TAX_RATE; if (t !== 'QQQ') trades++;
  };
  const pto = o.profitTaking;
  const buy = (t: string, dollars: number, p: number, d: string): void => {
    const pc = p * (1 + c), n = Math.floor(Math.min(dollars, cash) / pc); if (n <= 0) return;
    const x = pos.get(t);
    cash -= n * pc;
    if (x) { x.shares += n; x.cost += n * pc; if (x.pt && x.pt.st.fired === 0) { x.pt.st.r0 += n; x.pt.startCost += n * pc; } } else pos.set(t, { shares: n, cost: n * pc, entryDate: d, ...(pto && t !== 'QQQ' ? ptStart(t, d, p, n, n * pc) : {}) });
    if (t !== 'QQQ') { trades++; buysByTicker.set(t, (buysByTicker.get(t) ?? 0) + 1); }
  };
  // ── James — Profit-Taking overlay (only with `profitTaking`) ──
  /** The schedule a new position starts with: its sell layers, frozen at the first buy (decided at the close before). */
  function ptStart(t: string, d: string, fillPx: number, n: number, cost: number): { pt?: PtPos } {
    const s = ser(t), k = (idx.get(t)?.get(d) ?? 0) - 1;
    if (k < 0) return {};
    let levels: readonly number[] | null = null;
    if ((pto!.layers ?? 'anchor') === 'anchor') levels = layerTimeline(s, pto!.layerOptions ?? DEFAULT_LAYER_OPTIONS)[k]?.levels ?? null;
    else if (pto!.layers === 'entry') { const u = layerUnit(s, k, 'U1', 5); levels = u ? layerPrices(fillPx, u) : null; }
    else levels = percentLevels11(fillPx);
    return levels ? { pt: { st: newPtState(pto!.schedule, levels, n), startCost: cost, net: 0, sheetLeft: null } } : {};
  }
  let ptCash = 0, ptSoldToday = false, ptPending: Array<{ t: string; n: number }> = [];
  const ptStats = { positions: 0, sells: 0, leftSheet: 0, leftReal: 0, helped: 0, gain: 0, hodlGain: 0 };
  const ptSellsByTicker = new Map<string, number>(), ptHeldDays = new Map<string, string[]>();
  /** A step's sale: fee, tax, and the bookkeeping of the position's check. */
  const ptSell = (t: string, n: number, p: number): void => {
    const x = pos.get(t); if (!x || !x.pt) return;
    n = Math.min(n, x.shares); if (n <= 0) return;
    const part = (x.cost * n) / x.shares, v = n * p, fee = v * c, net = v - fee - Math.max(0, v - fee - part) * EXIT_TAX_RATE;
    x.shares -= n; x.cost -= part; cash += net; trades++;
    x.pt.net += net; noteStep(x.pt.st, n, p); x.pt.sheetLeft = x.pt.st.r0 * p - (x.pt.st.stepCash + x.shares * p);
    ptStats.sells++; ptSellsByTicker.set(t, (ptSellsByTicker.get(t) ?? 0) + 1); ptSoldToday = true;
    if (pto!.cashTo === 'cash') ptCash += net;
    if (x.shares <= 0) { ptClose(x, p); pos.delete(t); }
  };
  /** A position's check at its final exit (or the period end), at price `p`, with `restNet` the after-tax value of the shares still held. */
  function ptClose(x: Pos, p: number, restNet = 0): void {
    if (!x.pt || x.pt.st.lastPrice == null) return;
    const r0 = x.pt.st.r0, hv = r0 * p, hodl = hv - Math.max(0, hv - x.pt.startCost) * EXIT_TAX_RATE, produced = x.pt.net + restNet;
    ptStats.positions++; ptStats.leftSheet += x.pt.sheetLeft ?? 0; ptStats.leftReal += hodl - produced;
    if (produced > hodl) ptStats.helped++;
    ptStats.gain += produced - x.pt.startCost; ptStats.hodlGain += hodl - x.pt.startCost;
  }
  const equityAt = (d: string, at: 'opens' | 'closes'): number => {
    let e = cash;
    for (const [t, x] of pos) { const p = px(t, d, at) ?? lastPx.get(t) ?? x.cost / x.shares; e += x.shares * p; }
    return e;
  };

  for (let i = 0; i < days.length; i++) {
    const d = days[i] as string;
    // 1. trades at the open: sells, then fund the buys from QQQ, then buys, then park the rest in QQQ
    if (pto) { ptSoldToday = false; for (const s of ptPending) { const p = px(s.t, d, 'opens'); if (p != null && !toSell.includes(s.t)) ptSell(s.t, s.n, p); } ptPending = []; }
    for (const t of toSell) { const p = px(t, d, 'opens'); if (p != null) sell(t, p); }
    if (ov) {
      // trims (cap), then the book rescaled in proportion (mkt / dd / vol): cuts are taxed sales, top-ups buys
      for (const { t, n } of ovTrims) { const p = px(t, d, 'opens'); if (p != null && pos.has(t)) { sellPart(t, n, p); ovStats.trims++; } }
      ovTrims = [];
      if (pendScale != null && pendScale !== scale) {
        const ratio = scale > 0 ? pendScale / scale : 1;
        if (pendScale === 0) { for (const t of [...pos.keys()]) { const p = px(t, d, 'opens') ?? lastPx.get(t); if (p != null) sell(t, p); } }
        else if (ratio < 1) { for (const [t, x] of [...pos]) { const p = px(t, d, 'opens'); if (p != null) sellPart(t, Math.floor(x.shares * (1 - ratio)), p); } }
        else if (ratio > 1) {
          for (const [t, x] of [...pos]) {
            const p = px(t, d, 'opens'); if (t === 'QQQ' || p == null) continue;
            const pc = p * (1 + c), n = Math.floor(Math.min(x.shares * p * (ratio - 1), cash) / pc); if (n <= 0) continue;
            x.shares += n; x.cost += n * pc; cash -= n * pc; trades++;
          }
        }
        scale = pendScale; ovStats.rescales++;
        ovCash = Math.max(0, Math.min(cash, (1 - scale) * equityAt(d, 'opens')));
      }
      pendScale = null;
    }
    const buys = ov && scale === 0 ? [] : toBuy.filter((t) => px(t, d, 'opens') != null && !pos.has(t));
    const qOpen = px('QQQ', d, 'opens');
    if ((marketDown || idleOut) && pos.has('QQQ') && qOpen) sell('QQQ', qOpen);
    if (buys.length) {
      // Free play: each holding gets an equal share of the account, whatever the number of holdings.
      const heldNow = [...pos.keys()].filter((t) => t !== 'QQQ');
      const slot = (equityAt(d, 'opens') / (o.free ? Math.max(1, heldNow.length + buys.length) : o.slots)) * (ov ? scale : 1);
      const need = (toScale.size ? buys.reduce((x, t) => x + slot * (toScale.get(t) ?? 1), 0) : slot * buys.length) - (cash - ovCash);
      const q = pos.get('QQQ');
      if (need > 0 && q && qOpen) {
        const n = Math.min(q.shares, Math.ceil(need / (qOpen * (1 - c))));
        const part = { shares: n, cost: (q.cost * n) / q.shares };
        q.shares -= n; q.cost -= part.cost;
        const v = n * qOpen, fee = v * c, gain = v - fee - part.cost;
        cash += v - fee - Math.max(0, gain) * EXIT_TAX_RATE;
        if (q.shares <= 0) pos.delete('QQQ');
      }
      // Free play: if QQQ and cash are not enough, the other holdings are trimmed to their new equal share (taxed).
      if (o.free) {
        for (const t of heldNow) {
          const x = pos.get(t), p = px(t, d, 'opens');
          if (!x || p == null || cash >= slot * buys.length) continue;
          const over = x.shares * p - slot;
          if (over <= p) continue;
          const n = Math.floor(over / p), part = (x.cost * n) / x.shares, fee = n * p * c, gain = n * p - fee - part;
          x.shares -= n; x.cost -= part; cash += n * p - fee - Math.max(0, gain) * EXIT_TAX_RATE;
        }
      }
      for (const t of buys) buy(t, slot * (toScale.get(t) ?? 1), px(t, d, 'opens') as number, d);
    }
    if (pto) ptCash = Math.min(ptCash, Math.max(0, cash));
    if (ov) ovCash = Math.min(ovCash, Math.max(0, cash));
    if (!marketDown && !idleOut && qOpen && cash - ptCash - ovCash >= qOpen) buy('QQQ', cash - ptCash - ovCash, qOpen, d);
    toSell = []; toBuy = []; toScale = new Map();
    // the schedule's resting limit sells at the layers, during the day (P3 'intraday')
    if (pto && !pto.randomSells && (pto.trigger ?? 'intraday') === 'intraday') {
      for (const [t, x] of [...pos]) {
        const k = idx.get(t)?.get(d);
        if (t === 'QQQ' || !x.pt || k == null) continue;
        const s = ser(t);
        for (const f of profitTakingFills(x.pt.st, { open: s.opens[k] as number, high: s.highs[k] as number, close: s.closes[k] as number }, x.shares, 'intraday', x.cost / x.shares)) ptSell(t, f.shares, f.price as number);
      }
    }

    // 2. decisions at the close
    if (i < days.length - 1) {
      const held = [...pos.keys()].filter((t) => t !== 'QQQ');
      if (o.marketFilter && o.marketFilter !== 'off') {
        const qd = trendOf(inp.qqq, o.marketDays ?? 150).get(d)?.direction;
        if (qd === 'cautionary') marketDown = true; else if (qd === 'bullish') marketDown = false;
      }
      if (o.idle === 'qqqTrend') {
        const qd = trendOf(inp.qqq, o.idleDays ?? 200).get(d)?.direction;
        if (qd === 'cautionary') idleOut = true; else if (qd === 'bullish') idleOut = false;
      }
      const rebalanceDay = !!o.rebalanceDays && i % o.rebalanceDays === 0;
      for (const t of held) {
        // P4: once a step has sold, the rest follows the overlay's rule ('own' = the model's own sell, as without it)
        const rest = pto && pos.get(t)?.pt?.st.lastPrice != null ? (pto.rest ?? 'own') : 'own';
        const sell = rest === 'hold' ? false : rest === 'trend200' ? trendOf(ser(t), 200).get(d)?.direction === 'cautionary'
          : o.exit === 'trend' ? trendOf(ser(t), o.trendDays ?? 150).get(d)?.direction === 'cautionary' : modelSays(model, t, d, 'sell');
        if (sell || (marketDown && o.marketFilter === 'exitAll')) toSell.push(t);
      }
      if (ov) {
        curI = i;
        const eqC = equityAt(d, 'closes');
        if (ov.kind === 'atr' || ov.kind === 'cap') for (const t of held) {
          const x = pos.get(t)!, k = idx.get(t)?.get(d); if (k == null || toSell.includes(t)) continue;
          const cl = ser(t).closes[k] as number;
          if (ov.kind === 'atr') {
            x.hi = Math.max(x.hi ?? cl, cl);
            const a = atrSeries(ser(t), ov.atrDays ?? ATR_DAYS)[k] as number;
            if (Number.isFinite(a) && cl < x.hi - ov.k * a) { toSell.push(t); coolUntil.set(t, i + (ov.cooldown ?? ATR_COOLDOWN)); ovStats.stops++; }
          } else if (eqC > 0 && (x.shares * cl) / eqC > ov.w) {
            const n = Math.floor((x.shares * cl - eqC / o.slots) / cl);
            if (n > 0) ovTrims.push({ t, n });
          }
        }
        let want = scale;
        if (ov.kind === 'mkt') {
          const qd = trendOf(inp.qqq, ov.days ?? 200).get(d)?.direction;
          if (qd === 'cautionary') ovMktDown = true; else if (qd === 'bullish') ovMktDown = false;
          want = ovMktDown ? ov.x : 1;
        } else if (ov.kind === 'dd') want = ddStep(ddb, eqC, ov.y, ov.avgDays ?? DD_AVG_DAYS) ? (ov.cutTo ?? DD_CUT_TO) : 1;
        else if (ov.kind === 'vol') {
          const vals = new Map<string, number>();
          for (const [t, x] of pos) { const p = px(t, d, 'closes'); if (p != null) vals.set(t, x.shares * p); }
          const rets = bookReturns(vals, (t) => (t === 'QQQ' ? inp.qqq : inp.series.get(t)), (t, dd) => idx.get(t)?.get(dd), d, ov.lookback ?? VOL_LOOKBACK);
          if (rets.length) want = volScale(ov.target, annualVol(rets), ov.step ?? VOL_STEP, ov.floor ?? ov.step ?? VOL_STEP);
        }
        if (want !== scale) pendScale = want;
      }
      // the schedule's steps decided at the close (P3 'close'), or the exit null's random partial sells, for the next open
      if (pto) for (const t of held) {
        const x = pos.get(t)!, k = idx.get(t)?.get(d);
        if (!x.pt || toSell.includes(t) || k == null) continue;
        (ptHeldDays.get(t) ?? ptHeldDays.set(t, []).get(t)!).push(d);
        const st = x.pt.st;
        if (pto.randomSells) {
          if (pto.randomSells.get(t)?.has(d) && st.fired < st.levels.length) { const n = sharesToSell(st.schedule, st.fired, st.r0, x.shares); st.fired++; if (n > 0) ptPending.push({ t, n }); }
        } else if (pto.trigger === 'close') {
          const s = ser(t);
          for (const f of profitTakingFills(st, { open: s.opens[k] as number, high: s.highs[k] as number, close: s.closes[k] as number }, x.shares, 'close', x.cost / x.shares)) ptPending.push({ t, n: f.shares });
        }
      }
      // Fill mode: on a rebalance day, the slots go to the best-ranked eligible stocks; a holding that has dropped
      // out of the top ranks is sold (it is only bought back when it ranks again).
      const ranked = rebalanceDay || !o.rebalanceDays ? bag.filter((t) => px(t, d, 'closes') != null && (pos.has(t) ? !toSell.includes(t) : o.rebalanceDays ? notSell(t, d) : buyThroughGate(t, d)))
        .map((t) => ({ t, rank: rankOf(model, t, d) })).sort((a, b) => b.rank - a.rank || a.t.localeCompare(b.t)) : [];
      if (o.rebalanceDays && rebalanceDay) {
        const top = new Set(ranked.slice(0, o.slots).map((x) => x.t));
        for (const t of held) if (!top.has(t) && !toSell.includes(t)) toSell.push(t);
        toBuy = [...top].filter((t) => !pos.has(t));
      } else if (!o.rebalanceDays) {
        const free = o.free ? bag.length : o.slots - (held.length - toSell.length);
        if (free > 0) toBuy = ranked.filter((x) => !pos.has(x.t) && (!o.confirmTrend || trendOf(ser(x.t), o.trendDays ?? 150).get(d)?.direction === 'bullish')).slice(0, free).map((x) => x.t);
        // P5 "faster horse": after a step sold today, a free slot goes to the strongest stock of the bag not held (126-day return)
        if (pto?.cashTo === 'fasterHorse' && ptSoldToday && free - toBuy.length > 0) {
          let best: { t: string; r: number } | null = null;
          for (const t of bag) {
            const k = idx.get(t)?.get(d);
            if (k == null || k < 126 || pos.has(t) || toBuy.includes(t)) continue;
            const r = (ser(t).closes[k] as number) / (ser(t).closes[k - 126] as number) - 1;
            if (r > 0 && (!best || r > best.r)) best = { t, r };
          }
          if (best) toBuy.push(best.t);
        }
      }
      if (marketDown) toBuy = [];
      if (o.sizeScale) for (const t of toBuy) toScale.set(t, Math.max(0, Math.min(1, o.sizeScale(t, d))));
      if (o.onDecide) o.onDecide(d, [...held.filter((t) => !toSell.includes(t)), ...toBuy.filter((t) => !held.includes(t))]);
    }

    // 3. mark
    for (const t of pos.keys()) { const p = px(t, d, 'closes'); if (p != null) lastPx.set(t, p); }
    const eq = equityAt(d, 'closes');
    peak = Math.max(peak, eq); maxDd = Math.max(maxDd, peak > 0 ? (1 - eq / peak) * 100 : 0);
    if (ov && scale < 1) ovStats.scaledDays++;
    cashShareByDay.set(d, eq > 0 ? Math.max(0, cash) / eq : 1);
    const q = pos.get('QQQ');
    heldSum += [...pos.keys()].filter((t) => t !== 'QQQ').length;
    qShareSum += q && eq > 0 ? (q.shares * (lastPx.get('QQQ') ?? 0)) / eq : 0;
  }
  // value after the tax on everything still held
  let v = cash;
  for (const [t, x] of pos) { const p = lastPx.get(t) ?? x.cost / x.shares, val = x.shares * p; v += val - Math.max(0, val - x.cost) * EXIT_TAX_RATE; if (x.pt) ptClose(x, p, val - Math.max(0, val - x.cost) * EXIT_TAX_RATE); }
  const base = { finalTaxed: v, trades, avgStocksHeld: days.length ? heldSum / days.length : 0, qqqShare: days.length ? (qShareSum / days.length) * 100 : 0, maxDrawdownPct: maxDd, cashShareByDay, buysByTicker };
  if (o.gate) Object.assign(base, { gateStats: { blockedByTicker: gBlocked, signalDaysByTicker: gSignal } });
  if (ov) Object.assign(base, { fallStats: { rescales: ovStats.rescales, scaledDaysPct: days.length ? (ovStats.scaledDays / days.length) * 100 : 0, stops: ovStats.stops, trims: ovStats.trims } satisfies FallOverlayStats });
  if (!pto) return base;
  return {
    ...base,
    profitTaking: {
      positions: ptStats.positions, sells: ptStats.sells, sellsByTicker: ptSellsByTicker, heldDaysByTicker: ptHeldDays, leftOnTableSheet: ptStats.leftSheet, leftOnTableReal: ptStats.leftReal,
      helped: ptStats.helped, roiRatio: ptStats.hodlGain !== 0 ? ptStats.gain / ptStats.hodlGain : null,
    },
  };
}

/**
 * Equal weight in every stock of the bag (those trading at the start), bought at the first open and held; after tax.
 * `costBps` (G5): the yardstick pays the trading cost once, at the entry (part of the cost basis).
 */
export function holdBag(bag: readonly string[], inp: PortfolioInput, start: string, end: string, cash: number, costBps = 0): number {
  const first = inp.qqq.dates.find((d) => d >= start) ?? start;
  const live = bag.filter((t) => { const s = inp.series.get(t); return s && (s.dates[0] as string) <= first; });
  let v = 0;
  for (const t of live) {
    const s = inp.series.get(t)!;
    const i0 = s.dates.findIndex((d) => d >= start); let i1 = -1;
    for (let k = 0; k < s.dates.length; k++) if ((s.dates[k] as string) <= end) i1 = k;
    const pc = (s.opens[i0] as number) * (1 + costBps / 10_000);
    const slice = cash / live.length, n = Math.floor(slice / pc);
    const val = n * (s.closes[i1] as number), cost = n * pc;
    v += slice - cost + val - Math.max(0, val - cost) * EXIT_TAX_RATE;
  }
  return live.length ? v : cash;
}

/**
 * G5 random-signal null (master T2e) for a runPortfolio result: `seeds` reruns of the same model with the same
 * options (same sell rule, slots, idle money, cost), its buy signal replaced by random decision days, the same number
 * of buys per stock as `r` made. Not for fill mode (`rebalanceDays`), which has no buy signal.
 */
export function runPortfolioNull(model: PortfolioModel, bag: readonly string[], inp: PortfolioInput, start: string, end: string, o: PortfolioOptions, r: PortfolioResult, seeds = NULL_SEEDS): NullDistribution {
  if (o.rebalanceDays) throw new Error('runPortfolioNull: fill mode has no buy signal');
  const days = inp.qqq.dates.filter((d) => d >= start && d <= end).slice(0, -1);
  const daysOf = (t: string): string[] => { const has = new Set(inp.series.get(t)?.dates ?? []); return days.filter((d) => has.has(d)); };
  return randomSignalNull(r.buysByTicker, daysOf, (buyDays) => runPortfolio(model, bag, inp, start, end, { ...o, buyDays }).finalTaxed, seeds);
}
