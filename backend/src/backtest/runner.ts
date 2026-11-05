/**
 * Backlog 9: the day-by-day walk.
 *
 * For every trading day d in the window (the calendar of the `calendar` series, SPY):
 *   1. At d's OPEN: fill the orders decided at the previous close -- sells first (their cash, after tax, is then
 *      available), then buys in rank order, each scaled down to the cash on hand (skipped at 0 shares).
 *   2. At d's CLOSE (not on the last day, whose orders could not fill inside the window):
 *        - every held position gets the engine's exit read (real entry date and price) -> sell orders;
 *        - every universe ticker NOT held gets the full engine run as of d -> buy orders.
 *   3. Equity is marked at d's close.
 * No lookahead: a decision at d's close only sees bars dated <= d, and fills at the next open.
 *
 * The engine and exit reads are injected so the walk is testable on mock data.
 */

import { Ledger, type Trade } from './ledger.ts';
import { planBuys, planSell, buyCheck, type BuyOrder, type SellOrder, type HeldPosition, type PolicyConfig, type SkippedBuy } from './policy.ts';
import { indexOf, lastIndexOnOrBefore, type PriceSeries } from './data.ts';
import type { EngineRead, ExitReadResult } from './engineRun.ts';
import type { StageMemory } from '../portfolio/sellPlan.ts';

export interface BacktestSources {
  /** Engine reads as of `day`'s close for these tickers. */
  engineReads(day: string, tickers: readonly string[]): Promise<EngineRead[]>;
  /** The engine's exit read for a held position as of `day`'s close. */
  exitRead(ticker: string, day: string, entryDate: string, entryPrice: number): ExitReadResult;
}

export interface BacktestConfig {
  readonly name: string;
  readonly universe: readonly string[];
  readonly start: string;
  readonly end: string;
  readonly cash: number;
  readonly policy: PolicyConfig;
  /** 0.25 (taxed run) or 0 (untaxed run). */
  readonly taxRate: number;
  /** The trading calendar (SPY). */
  readonly calendar: string;
  /** Report the open-position count at the close of this day (owner rule: at least 4 by end of 2024, not forced). */
  readonly checkpointDay?: string;
  /** Called after each simulated day (progress). */
  readonly onDay?: (day: string, i: number, n: number) => void;
}

export interface DayMark {
  readonly day: string;
  readonly equity: number;
  readonly cash: number;
  readonly positions: number;
}

export interface BacktestResult {
  readonly config: Omit<BacktestConfig, 'onDay'>;
  readonly days: number;
  readonly firstDay: string;
  readonly lastDay: string;
  readonly trades: readonly Trade[];
  readonly marks: readonly DayMark[];
  readonly finalCash: number;
  readonly finalHoldings: ReadonlyArray<{ ticker: string; shares: number; avgCost: number; lastClose: number; value: number }>;
  readonly finalEquity: number;
  /** finalEquity minus the 25% tax a sale of every remaining holding would owe (only meaningful for the taxed run). */
  readonly finalEquityAfterLiquidationTax: number;
  readonly taxPaid: number;
  readonly realized: number;
  readonly maxOpenPositions: number;
  readonly openAtCheckpoint: number | null;
  readonly distinctHeldByCheckpoint: number | null;
  readonly tickersBought: readonly string[];
  readonly skipped: readonly SkippedBuy[];
  /** How often each hold-off reason blocked an otherwise analysed ticker (counts of ticker-days). */
  readonly signalStats: Readonly<Record<string, number>>;
  /** Exit reads on held positions by the Exit pipeline's class (EXIT / TRIM / HOLD / failed). */
  readonly exitStats: Readonly<Record<string, number>>;
  readonly engineCalls: number;
  readonly exitReads: number;
  readonly cashCapped: number;
  readonly cashSkipped: number;
}

export async function runBacktest(series: ReadonlyMap<string, PriceSeries>, src: BacktestSources, cfg: BacktestConfig): Promise<BacktestResult> {
  const cal = series.get(cfg.calendar);
  if (!cal) throw new Error('no calendar series ' + cfg.calendar);
  const days = cal.dates.filter((d) => d >= cfg.start && d <= cfg.end);
  if (days.length < 2) throw new Error('window too short');
  const ledger = new Ledger(cfg.cash, cfg.taxRate);
  const meta = new Map<string, { entryDate: string; stage: StageMemory | null }>();
  const marks: DayMark[] = [];
  const skipped: SkippedBuy[] = [];
  const stats: Record<string, number> = {};
  const exitStats: Record<string, number> = {};
  const bought = new Set<string>();
  const heldEver = new Set<string>();
  let pendingSells: SellOrder[] = [];
  let pendingBuys: BuyOrder[] = [];
  let maxOpen = 0, openAtCheckpoint: number | null = null, distinctAtCheckpoint: number | null = null;
  let engineCalls = 0, exitReads = 0, cashCapped = 0, cashSkipped = 0;

  const closeOn = (t: string, d: string): number => {
    const s = series.get(t) as PriceSeries;
    const i = lastIndexOnOrBefore(s, d);
    return s.closes[i] as number;
  };

  for (let i = 0; i < days.length; i++) {
    const d = days[i] as string;

    // 1. Fills at the open: sells, then buys.
    const carrySells: SellOrder[] = [];
    for (const o of pendingSells) {
      const s = series.get(o.ticker) as PriceSeries;
      const bi = indexOf(s, d);
      if (bi < 0) { carrySells.push(o); continue; }
      const qty = Math.min(o.shares, ledger.shares(o.ticker));
      if (qty <= 0) continue;
      const x = o.exit;
      ledger.sell(d, o.ticker, qty, s.opens[bi] as number,
        (o.full ? 'sell all' : 'sell part') + ': ' + o.reason + ' (signal ' + o.signalDay + '; close $' + (x.close ?? 0).toFixed(2)
        + (x.stopLevel != null ? ', trailing stop $' + x.stopLevel.toFixed(2) : '') + (x.t1 != null ? ', T1 $' + x.t1.toFixed(2) : '') + (x.t2 != null ? ', T2 $' + x.t2.toFixed(2) : '') + ')');
      const m = meta.get(o.ticker);
      if (ledger.shares(o.ticker) <= 0) meta.delete(o.ticker);
      else if (m) m.stage = o.stageAfter;
    }
    const carryBuys: BuyOrder[] = [];
    for (const o of pendingBuys) {
      if (ledger.shares(o.ticker) > 0) continue;
      const s = series.get(o.ticker) as PriceSeries;
      const bi = indexOf(s, d);
      if (bi < 0) { carryBuys.push(o); continue; }
      const px = s.opens[bi] as number;
      const affordable = Math.floor((ledger.cash + 1e-9) / px);
      const qty = Math.min(o.plannedShares, affordable);
      if (qty < o.plannedShares) { if (qty > 0) cashCapped++; }
      if (qty <= 0) { cashSkipped++; skipped.push({ ticker: o.ticker, signalDay: o.signalDay, reason: 'not enough cash at the fill' }); continue; }
      const r = o.read;
      ledger.buy(d, o.ticker, qty, px,
        'buy: conviction ' + r.finalConviction + ', timing ' + r.timing + ', verdict ' + r.verdict + ' (signal ' + o.signalDay
        + '; engine entry $' + (r.entryPrice ?? 0).toFixed(2) + ', stop $' + (r.stop ?? 0).toFixed(2) + ', sized ' + o.plannedShares + ' sh'
        + (qty < o.plannedShares ? ', cut to ' + qty + ' by cash' : '') + ')');
      meta.set(o.ticker, { entryDate: d, stage: null });
      bought.add(o.ticker);
      heldEver.add(o.ticker);
    }
    pendingSells = carrySells;
    pendingBuys = carryBuys;

    // 2. Decisions at the close (none on the last day: no open left to fill them).
    if (i < days.length - 1) {
      const held = ledger.held();
      const newSells: SellOrder[] = [];
      for (const t of held) {
        if (pendingSells.some((o) => o.ticker === t)) continue;
        const m = meta.get(t) as { entryDate: string; stage: StageMemory | null };
        const pos: HeldPosition = { ticker: t, shares: ledger.shares(t), entryDate: m.entryDate, entryPrice: ledger.avgCost(t) as number, stage: m.stage };
        exitReads++;
        const x = src.exitRead(t, d, pos.entryDate, pos.entryPrice);
        const xk = x.ok ? String(x.actionClass) : 'failed';
        exitStats[xk] = (exitStats[xk] ?? 0) + 1;
        const o = planSell(pos, x);
        if (o) newSells.push(o);
      }
      pendingSells.push(...newSells);
      const candidates = cfg.universe.filter((t) => !held.includes(t) && !pendingBuys.some((o) => o.ticker === t));
      const reads = candidates.length ? await src.engineReads(d, candidates) : [];
      engineCalls += reads.length;
      for (const r of reads) {
        const c = buyCheck(r);
        const key = c.eligible ? 'buy signal' : c.reason.replace(/\(.*\)/, '').replace(/conviction \d+.*/, '').trim();
        stats[key] = (stats[key] ?? 0) + 1;
      }
      const fullExits = pendingSells.filter((o) => o.full).length;
      const priceOf = (t: string): number => closeOn(t, d);
      const plan = planBuys({ equity: ledger.equity(priceOf), held: new Set(held), openAfterExits: held.length - fullExits + pendingBuys.length }, reads, cfg.policy);
      skipped.push(...plan.skipped);
      pendingBuys.push(...plan.orders);
    }

    // 3. Mark at the close.
    const priceOf = (t: string): number => closeOn(t, d);
    const open = ledger.held().length;
    maxOpen = Math.max(maxOpen, open);
    marks.push({ day: d, equity: ledger.equity(priceOf), cash: ledger.cash, positions: open });
    if (cfg.checkpointDay && d <= cfg.checkpointDay) { openAtCheckpoint = open; distinctAtCheckpoint = heldEver.size; }
    cfg.onDay?.(d, i, days.length);
  }

  const last = days[days.length - 1] as string;
  const priceOf = (t: string): number => closeOn(t, last);
  const finalHoldings = ledger.held().map((t) => ({ ticker: t, shares: ledger.shares(t), avgCost: ledger.avgCost(t) as number, lastClose: priceOf(t), value: ledger.shares(t) * priceOf(t) }));
  const { onDay: _ignored, ...config } = cfg;
  return {
    config, days: days.length, firstDay: days[0] as string, lastDay: last,
    trades: ledger.trades, marks, finalCash: ledger.cash, finalHoldings,
    finalEquity: ledger.equity(priceOf), finalEquityAfterLiquidationTax: ledger.equityAfterLiquidationTax(priceOf),
    taxPaid: ledger.taxPaid, realized: ledger.realized, maxOpenPositions: maxOpen,
    openAtCheckpoint, distinctHeldByCheckpoint: distinctAtCheckpoint,
    tickersBought: [...bought].sort(), skipped, signalStats: stats, exitStats, engineCalls, exitReads, cashCapped, cashSkipped,
  };
}
