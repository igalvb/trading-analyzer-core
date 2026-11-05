/**
 * The 1-year forward paper test (owner, 2026-10-27; restarted 2026-10-28 so every account starts together): $100,000 per strategy, from the open of 2026-10-29 to the
 * close of 2027-10-29, decided every night from the LIVE nightly analysis (fundamentals, market-wide data, all
 * models), filled at the next trading day's open, 25% tax on each sale's gain. Nothing here computes a score: it
 * only reads what the engine and the models produced, with the same buy/sell rules as the backtest.
 *
 * Strategies (one $100,000 account each, at most 6 stocks, each buy sized to 1/6 of the account, cut to cash):
 *   current      the Buy report's tier 1, held off when the 5 models are SPLIT / NO_CONSENSUS; sells on the
 *                engine's exit read (EXIT = all, target reached = a third at each target)
 *   engine       the same without the 5-model hold-off
 *   schabacker / edwardsMagee / broker / turtle   that model's own read: "bullish" buys, "cautionary" sells all
 * Benchmarks: all-in QQQ, and the universe equal-weighted, both bought at the first open and held.
 * Research accounts (owner 2026-10-28, paper/paperLab.ts): every lab model with its best setup on the owner's
 * list (14 researched stocks plus SPCX and IBIT), plus holding that list equally; they joined the test on 2026-10-28.
 *
 * The state is one JSON object (the caller stores it); every call to `paperDay` handles ONE closed trading day:
 * fill yesterday's orders at today's open, then decide at today's close.
 */

import { planBuys, planSell, rankReads, type HeldPosition } from '../backtest/policy.ts';
import type { EngineRead, ExitReadResult } from '../backtest/engineRun.ts';
import type { StageMemory } from '../portfolio/sellPlan.ts';
import { EXIT_TAX_RATE, computeExitTax } from '../portfolio/exitTax.ts';
import type { PriceSeries } from '../backtest/data.ts';
import { labDay, labValues, newLabState, LAB_SETUPS, PAPER_OWNER_LIST, LILO_ID, LILO_LABEL, LEAPS_IDS, LAB_LABEL, PAPER_RESEARCH_14, PAPER_ADDED, ALL_ID, ALL_LABEL, ALL_SHARES, JAMES_IDS, JAMES_LEAPS_IDS, JAMES_LILO_V2_ID, JAMES_MR_ID, labHeld, type LabState, type LabDayInput } from './paperLab.ts';
import { liloHeld } from '../research/liloBook.ts';
import { activeProfile } from '../profile/active.ts';
import { paperDatesOf } from '../profile/paperDates.ts';
import { LABELS } from '../profile/labels.ts';

const PAPER_DATES = paperDatesOf(activeProfile());
/** Profile `paper.start` / `paper.end` (GENERIC_PLAN P2); '' when the profile has no start date (paperJob says so). */
export const PAPER_START: string = PAPER_DATES.start;
export const PAPER_END: string = PAPER_DATES.end;
/** The close before the start: decisions only, so the first buys fill at the start day's open with the benchmarks. */
export const PAPER_DECIDE_FROM: string = PAPER_DATES.decideFrom;
export const PAPER_CASH = 100_000;
export const PAPER_MAX_POSITIONS = 6;
/** Profile `paper.fixedUniverse` (GENERIC_PLAN P2); the live watchlist is added every night. */
export const PAPER_FIXED_UNIVERSE: readonly string[] = activeProfile().paper.fixedUniverse;

export const STRATEGIES = ['current', 'engine', 'schabacker', 'edwardsMagee', 'broker', 'turtle'] as const;
export type StrategyId = (typeof STRATEGIES)[number];
export const STRATEGY_LABEL: Readonly<Record<StrategyId, string>> = {
  current: 'Engine + models (current rules)', engine: 'Engine alone', schabacker: 'Schabacker', edwardsMagee: 'Edwards & Magee', broker: 'Broker Course', turtle: 'Turtle',
};

export interface Lot { readonly day: string; shares: number; readonly price: number }
export interface PendingBuy { readonly ticker: string; readonly signalDay: string; readonly dollars: number; readonly why: string }
export interface PendingSell { readonly ticker: string; readonly signalDay: string; readonly shares: number; readonly full: boolean; readonly why: string; readonly stageAfter: StageMemory | null }
export interface Account {
  cash: number;
  lots: Record<string, Lot[]>;
  meta: Record<string, { entryDate: string; stage: StageMemory | null }>;
  pendingBuys: PendingBuy[];
  pendingSells: PendingSell[];
  taxPaid: number;
}
export interface Bench { cash: number; shares: Record<string, number>; cost: Record<string, number> }
export interface PaperTrade { readonly day: string; readonly strategy: string; readonly side: 'BUY' | 'SELL'; readonly ticker: string; readonly shares: number; readonly price: number; readonly value: number; readonly tax: number; readonly why: string }
/** `qqqClose`: QQQ's close that night (G8; absent in marks saved before it). */
export interface PaperMark { readonly day: string; readonly values: Record<string, number>; readonly qqqClose?: number }
/**
 * G8 (docs/models/MASTER_PLAN.md section 4, testing rule T8): the night an account joined the test and QQQ's close that
 * night, so an account that joins mid-test is compared with "📊 QQQ since this account joined", not with QQQ from the
 * test's first open. `backfilled`: the account was there before joins were recorded; its day is when it joined.
 */
export interface PaperJoin { readonly day: string; readonly qqqClose: number; readonly backfilled?: boolean }

export interface PaperState {
  readonly version: 1;
  readonly start: string;
  readonly end: string;
  readonly cash: number;
  lastDay: string | null;
  accounts: Record<StrategyId, Account>;
  /** null until the first open (benchmarks are bought then). */
  benchmarks: { qqq: Bench; basket: Bench } | null;
  /** The universe the basket was bought with (fixed at the start). */
  basketUniverse: string[];
  /** Value after the 25% tax on what is still held, at each close. */
  marks: PaperMark[];
  /** The research accounts (paperLab.ts); absent in a state saved before they joined. */
  lab?: LabState;
  /** G8: account id -> the night it joined and QQQ's close then; absent in a state saved before G8. */
  joins?: Record<string, PaperJoin>;
}

export function newPaperState(universe: readonly string[]): PaperState {
  const acct = (): Account => ({ cash: PAPER_CASH, lots: {}, meta: {}, pendingBuys: [], pendingSells: [], taxPaid: 0 });
  return {
    version: 1, start: PAPER_START, end: PAPER_END, cash: PAPER_CASH, lastDay: null,
    accounts: Object.fromEntries(STRATEGIES.map((s) => [s, acct()])) as Record<StrategyId, Account>,
    benchmarks: null, basketUniverse: [...universe], marks: [],
  };
}

/** One closed trading day, as the nightly sees it. */
export interface PaperDayInput {
  /** The trading day that just closed ('YYYY-MM-DD', New York). */
  readonly day: string;
  /** That day's open and close per ticker (QQQ included); a ticker without a bar today is left alone. */
  readonly bars: Readonly<Record<string, { readonly open: number; readonly close: number }>>;
  /** Tonight's engine reads for the universe. */
  readonly reads: readonly EngineRead[];
  /** The engine's exit read for a held position (live chart). */
  readonly exitRead: (ticker: string, entryDate: string, entryPrice: number) => ExitReadResult;
  /** The research accounts' inputs: tonight's reads for the owner's list and its price history. */
  readonly lab?: { readonly reads: readonly EngineRead[]; readonly series: ReadonlyMap<string, PriceSeries>; readonly options?: LabDayInput['options']; readonly long?: ReadonlyMap<string, PriceSeries> };
}

const sharesOf = (a: Account, t: string): number => (a.lots[t] ?? []).reduce((x, l) => x + l.shares, 0);
const costOf = (a: Account, t: string): number => (a.lots[t] ?? []).reduce((x, l) => x + l.shares * l.price, 0);
const held = (a: Account): string[] => Object.keys(a.lots).filter((t) => sharesOf(a, t) > 0).sort();

function valueAfterTax(a: Account, closeOf: (t: string) => number | null): number {
  let v = a.cash;
  for (const t of held(a)) {
    const sh = sharesOf(a, t), px = closeOf(t);
    if (px == null) { v += costOf(a, t); continue; }
    const x = computeExitTax({ quantity: sh, unitCost: costOf(a, t) / sh, unitPrice: px });
    v += (x.marketValueUsd ?? sh * px) - (x.taxOwedUsd ?? 0);
  }
  return v;
}

function benchValue(b: Bench, closeOf: (t: string) => number | null): number {
  let v = b.cash;
  for (const [t, sh] of Object.entries(b.shares)) {
    const px = closeOf(t) ?? (b.cost[t] ?? 0) / sh;
    const gain = sh * px - (b.cost[t] ?? 0);
    v += sh * px - (gain > 0 ? gain * EXIT_TAX_RATE : 0);
  }
  return v;
}

function buyBench(cash: number, tickers: readonly string[], openOf: (t: string) => number | null): Bench {
  const b: Bench = { cash, shares: {}, cost: {} };
  const slice = cash / Math.max(1, tickers.length);
  for (const t of tickers) {
    const px = openOf(t);
    if (!px) continue;
    const n = Math.floor(slice / px);
    if (n <= 0) continue;
    b.shares[t] = n; b.cost[t] = n * px; b.cash -= n * px;
  }
  return b;
}

/**
 * Handles one closed trading day. Returns the trades made at today's open. Idempotent per day: a day on or before
 * `lastDay`, or before the start, does nothing.
 */
export function paperDay(state: PaperState, input: PaperDayInput): PaperTrade[] {
  const d = input.day;
  if (d < PAPER_DECIDE_FROM || (state.lastDay != null && d <= state.lastDay)) return [];
  const before = d < state.start;
  const trades: PaperTrade[] = [];
  // G8: in a state saved before joins were recorded, the accounts already there (not those that join tonight).
  const hadBefore = state.joins || state.lastDay == null ? null : new Set(accountIds(state));
  const openOf = (t: string): number | null => input.bars[t]?.open ?? null;
  const closeOf = (t: string): number | null => input.bars[t]?.close ?? null;

  // Benchmarks at the first open.
  if (!before && !state.benchmarks) state.benchmarks = { qqq: buyBench(state.cash, ['QQQ'], openOf), basket: buyBench(state.cash, state.basketUniverse, openOf) };

  // 1. Fills at today's open: sells, then buys (none before the start day).
  for (const id of before ? [] : STRATEGIES) {
    const a = state.accounts[id];
    const carryS: PendingSell[] = [];
    for (const o of a.pendingSells) {
      const px = openOf(o.ticker);
      if (px == null) { carryS.push(o); continue; }
      const qty = Math.min(o.shares, sharesOf(a, o.ticker));
      if (qty <= 0) continue;
      let left = qty, cost = 0;
      for (const l of a.lots[o.ticker] ?? []) { const take = Math.min(l.shares, left); cost += take * l.price; l.shares -= take; left -= take; if (left <= 0) break; }
      a.lots[o.ticker] = (a.lots[o.ticker] ?? []).filter((l) => l.shares > 0);
      const value = qty * px, gain = value - cost, tax = Math.max(0, gain) * EXIT_TAX_RATE;
      a.cash += value - tax; a.taxPaid += tax;
      if (sharesOf(a, o.ticker) <= 0) { delete a.lots[o.ticker]; delete a.meta[o.ticker]; } else if (a.meta[o.ticker]) a.meta[o.ticker]!.stage = o.stageAfter;
      trades.push({ day: d, strategy: id, side: 'SELL', ticker: o.ticker, shares: qty, price: px, value, tax, why: o.why });
    }
    a.pendingSells = carryS;
    const carryB: PendingBuy[] = [];
    for (const o of a.pendingBuys) {
      if (sharesOf(a, o.ticker) > 0) continue;
      const px = openOf(o.ticker);
      if (px == null) { carryB.push(o); continue; }
      const n = Math.floor(Math.min(o.dollars, a.cash + 1e-9) / px);
      if (n <= 0) continue;
      a.cash -= n * px;
      a.lots[o.ticker] = [{ day: d, shares: n, price: px }];
      a.meta[o.ticker] = { entryDate: d, stage: null };
      trades.push({ day: d, strategy: id, side: 'BUY', ticker: o.ticker, shares: n, price: px, value: n * px, tax: 0, why: o.why });
    }
    a.pendingBuys = carryB;
  }

  // 2. Decisions at today's close (none after the end day: no open is left to fill them).
  if (d < state.end) {
    const byTicker = new Map(input.reads.map((r) => [r.ticker, r]));
    for (const id of STRATEGIES) {
      const a = state.accounts[id];
      const h = held(a);
      const equity = a.cash + h.reduce((x, t) => x + sharesOf(a, t) * (closeOf(t) ?? costOf(a, t) / Math.max(1, sharesOf(a, t))), 0);
      const slot = equity / PAPER_MAX_POSITIONS;
      const pendingSell = new Set(a.pendingSells.map((o) => o.ticker));
      if (id === 'current' || id === 'engine') {
        for (const t of h) {
          if (pendingSell.has(t)) continue;
          const m = a.meta[t];
          if (!m) continue;
          const pos: HeldPosition = { ticker: t, shares: sharesOf(a, t), entryDate: m.entryDate, entryPrice: costOf(a, t) / sharesOf(a, t), stage: m.stage };
          const o = planSell(pos, input.exitRead(t, pos.entryDate, pos.entryPrice));
          if (o) a.pendingSells.push({ ticker: t, signalDay: d, shares: o.shares, full: o.full, why: o.reason, stageAfter: o.stageAfter });
        }
        const fullExits = a.pendingSells.filter((o) => o.full).length;
        const candidates = input.reads.filter((r) => !h.includes(r.ticker) && !a.pendingBuys.some((o) => o.ticker === r.ticker));
        const plan = planBuys({ equity, held: new Set(h), openAfterExits: h.length - fullExits + a.pendingBuys.length }, candidates,
          { maxPositions: PAPER_MAX_POSITIONS, ...(id === 'engine' ? { noVeto: true } : {}) });
        for (const o of plan.orders) a.pendingBuys.push({ ticker: o.ticker, signalDay: d, dollars: slot, why: 'conviction ' + o.read.finalConviction + ', timing ' + o.read.timing + ', models ' + o.read.verdict });
      } else {
        for (const t of h) if (!pendingSell.has(t) && byTicker.get(t)?.directions?.[id] === 'cautionary') a.pendingSells.push({ ticker: t, signalDay: d, shares: sharesOf(a, t), full: true, why: STRATEGY_LABEL[id] + ' turned cautionary', stageAfter: null });
        let open = h.length - a.pendingSells.filter((o) => o.full).length + a.pendingBuys.length;
        const bullish = rankReads(input.reads.filter((r) => r.directions?.[id] === 'bullish' && !h.includes(r.ticker) && !a.pendingBuys.some((o) => o.ticker === r.ticker)));
        for (const r of bullish) {
          if (open >= PAPER_MAX_POSITIONS) break;
          a.pendingBuys.push({ ticker: r.ticker, signalDay: d, dollars: slot, why: STRATEGY_LABEL[id] + ' reads bullish' });
          open++;
        }
      }
    }
  }

  // Research accounts: they decide from the day they join; their first fills are at the next open.
  if (input.lab) {
    state.lab ??= newLabState(d, state.cash);
    trades.push(...labDay(state.lab, { day: d, bars: input.bars, reads: input.lab.reads, series: input.lab.series, exitRead: input.exitRead, options: input.lab.options ?? null, ...(input.lab.long ? { long: input.lab.long } : {}) },
      { fill: !before && d > state.lab.joined, decide: d < state.end, cash: state.cash }));
  }

  recordJoins(state, d, closeOf('QQQ'), input.lab?.series.get('QQQ'), hadBefore);

  if (before || !state.benchmarks) { state.lastDay = d; return trades; }

  // 3. Mark at the close.
  const values: Record<string, number> = {};
  for (const id of STRATEGIES) values[id] = valueAfterTax(state.accounts[id], closeOf);
  values.qqq = benchValue(state.benchmarks.qqq, closeOf);
  values.basket = benchValue(state.benchmarks.basket, closeOf);
  if (state.lab) Object.assign(values, labValues(state.lab, closeOf));
  const qqqClose = closeOf('QQQ');
  state.marks.push({ day: d, values, ...(qqqClose != null ? { qqqClose } : {}) });
  state.lastDay = d;
  return trades;
}

/** Every account of the test (not the yardsticks), by the id its values are marked under. */
export function accountIds(state: PaperState): string[] {
  const ids: string[] = [...STRATEGIES];
  const lab = state.lab;
  if (lab) {
    ids.push(...Object.keys(lab.accounts));
    if (lab.lilo) ids.push(LILO_ID);
    ids.push(...Object.keys(lab.leaps ?? {}));
    if (lab.accounts[ALL_SHARES.id]) ids.push(ALL_ID);
    if (lab.liloV2) ids.push(JAMES_LILO_V2_ID);
    ids.push(...Object.keys(lab.james ?? {}));
    // James's models, phase 2
    if (lab.meanRev) ids.push(JAMES_MR_ID);
    ids.push(...Object.keys(lab.pair ?? {}), ...Object.keys(lab.winners ?? {}));
    // phase 3
    if (lab.cycle) ids.push('james.cycle');
    if (lab.cycleBtc) ids.push('james.cycleBtc');
    if (lab.marketMaker) ids.push('james.marketMaker');
  }
  return [...new Set(ids)];
}

/**
 * G8: notes the join night (and QQQ's close then) of every account that has none. `hadBefore`: in a state saved before
 * joins were recorded, the accounts that were already there; they are back-filled with the night they joined (the
 * original six: the first decision night; the research accounts: the night they joined) and QQQ's close then, from
 * `qqq` when it holds that day (else tonight's close, marked back-filled).
 */
export function recordJoins(state: PaperState, day: string, qqqClose: number | null, qqq?: PriceSeries, hadBefore?: ReadonlySet<string> | null): void {
  const joins = state.joins ??= {};
  const closeOn = (d: string): number | null => { const i = qqq ? qqq.dates.lastIndexOf(d) : -1; return i >= 0 ? (qqq!.closes[i] as number) : null; };
  for (const id of accountIds(state)) {
    if (joins[id]) continue;
    if (hadBefore?.has(id)) {
      const was = (STRATEGIES as readonly string[]).includes(id) ? PAPER_DECIDE_FROM : (state.lab?.joined ?? PAPER_DECIDE_FROM);
      if (was < day) {
        const c = closeOn(was) ?? qqqClose;
        if (c != null) joins[id] = { day: was, qqqClose: c, backfilled: true };
        continue;
      }
    }
    if (qqqClose != null) joins[id] = { day, qqqClose };
  }
}

/**
 * G8: what PAPER_CASH (or `cash`) put in QQQ at the close of the account's join night is worth at `qqqCloseNow`, after
 * the 25% tax on the gain (the same footing as every account's value). Null without a join or a close.
 */
export function qqqSinceJoined(join: PaperJoin | undefined, qqqCloseNow: number | null | undefined, cash = PAPER_CASH): number | null {
  if (!join || qqqCloseNow == null || !(join.qqqClose > 0)) return null;
  const v = (cash * qqqCloseNow) / join.qqqClose;
  return v - Math.max(0, v - cash) * EXIT_TAX_RATE;
}

export const pctOf = (v: number, base = PAPER_CASH): string => ((v / base - 1) * 100 >= 0 ? '+' : '') + ((v / base - 1) * 100).toFixed(1) + '%';

/** Largest fall from a high, %, of one account or benchmark over the marks so far. */
export function deepestFall(state: PaperState, key: string): number {
  let peak = 0, dd = 0;
  for (const m of state.marks) { const v = m.values[key]; if (v == null) continue; peak = Math.max(peak, v); dd = Math.max(dd, peak > 0 ? (1 - v / peak) * 100 : 0); }
  return dd;
}

/**
 * One line per strategy and benchmark, best first: for the summary tab and Telegram. The yardsticks (owner
 * 2026-10-28: always compare with holding QQQ and holding the 14) are marked `bench`.
 */
export function standings(state: PaperState): Array<{ key: string; name: string; value: number; positions: number; maxDrawdownPct: number; bench: boolean; qqqSinceJoined: number | null }> {
  const last = state.marks[state.marks.length - 1];
  if (!last) return [];
  const rows: Array<{ key: string; name: string; positions: number; bench: boolean }> = STRATEGIES.map((s) => ({ key: s, name: STRATEGY_LABEL[s], positions: held(state.accounts[s]).length, bench: false }));
  rows.push({ key: 'qqq', name: 'Hold QQQ', positions: 1, bench: true });
  rows.push({ key: 'basket', name: 'Hold all ' + state.basketUniverse.length + ' equally (4 + watchlist)', positions: state.basketUniverse.length, bench: true });
  for (const st of LAB_SETUPS) rows.push({ key: st.id, name: st.label, positions: Object.keys(state.lab?.accounts[st.id]?.pos ?? {}).filter((t) => t !== 'QQQ').length, bench: false });
  rows.push({ key: LILO_ID, name: LILO_LABEL, positions: state.lab?.lilo ? liloHeld(state.lab.lilo).length : 0, bench: false });
  for (const id of LEAPS_IDS) rows.push({ key: id, name: LAB_LABEL[id] as string, positions: state.lab?.leaps?.[id]?.held.length ?? 0, bench: false });
  rows.push({ key: ALL_ID, name: ALL_LABEL, positions: state.lab ? labHeld(state.lab, ALL_ID).filter((t) => t !== 'QQQ').length : 0, bench: false });
  // James's models (phase 1), group J; judged against "📊 QQQ since this account joined" (they join after the start)
  for (const id of JAMES_IDS) rows.push({ key: id, name: LAB_LABEL[id] as string, positions: state.lab ? labHeld(state.lab, id).filter((t) => t !== 'QQQ').length : 0, bench: false });
  // James's models, phase 4: James — LEAPS (group E)
  for (const id of JAMES_LEAPS_IDS) rows.push({ key: id, name: LAB_LABEL[id] as string, positions: state.lab ? labHeld(state.lab, id).filter((t) => t !== 'QQQ').length : 0, bench: false });
  rows.push({ key: 'lab.list14', name: LABELS.holdResearchCore, positions: PAPER_RESEARCH_14.length, bench: true });
  rows.push({ key: 'lab.list', name: LABELS.holdCore, positions: PAPER_OWNER_LIST.length, bench: true });
  return rows.filter((r) => last.values[r.key] != null)
    .map((r) => {
      // G8: only an account that joined after the test began gets its own QQQ yardstick (for the others it is Hold QQQ).
      const j = r.bench ? undefined : state.joins?.[r.key];
      const late = j && j.day > PAPER_DECIDE_FROM ? qqqSinceJoined(j, last.qqqClose) : null;
      return { key: r.key, name: r.name, value: last.values[r.key] as number, positions: r.positions, maxDrawdownPct: deepestFall(state, r.key), bench: r.bench, qqqSinceJoined: late };
    })
    .sort((x, y) => y.value - x.value);
}

export function heldList(state: PaperState, id: StrategyId): string[] { return held(state.accounts[id]); }
