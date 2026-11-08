/**
 * The growth graph's ESTIMATED past (docs/DASHBOARD.md "Estimated history"): so the graph is not empty before the
 * Nightly has written real snapshots, the market groups are rebuilt from the long price history (the `prices` branch,
 * storage/longHistory.ts) as
 *
 *     value of a group on day d = sum over the positions held on d of  qty x close(ticker, d)  [/ today's USD/ILS]
 *
 * with TODAY's holdings and TODAY's rate (an estimate: it knows nothing of sales the ledger does not list). Every date
 * the ledger knows is used:
 *   dated lots (LedgerStock.lots)   each lot is held from its own date; the undated rest from `bought` (else always)
 *   LedgerStock.bought               no lots: the whole quantity is held from this day (before it: not held)
 *   calls (LedgerOption)             not priced from history: flat at their cost (premium x 100 x contracts) from
 *                                    `bought` (else always); labelled "calls at cost"
 *   closed positions (holdings.closed)  held from `bought` (else always) until the day before `sold`: stocks, funds
 *                                    and coins priced from history with their qty, options flat at their cost. A
 *                                    closed line without a sell day is left out (it cannot be placed in time).
 *   no date at all                   held for the whole range
 * A ticker that did not trade yet (a fund listed in 2024, a new listing) starts at its first bar. A position with no
 * price series at all (coins have none on the `prices` branch today; they would be "<symbol>-USD", cryptoPriceSymbol)
 * is drawn FLAT at today's value from its start day (a closed one: at its cost), so the total has no cliff where the
 * real snapshots begin; it is named in coverage.noHistory, and a group made only of flat lines is in
 * coverage.flatGroups (its change chips show no estimated change).
 *
 * Points (to keep data/dashboard.json small): month ends before two years ago, Fridays within two years, every trading
 * day within the last 90 days, from ESTIMATE_FROM (or the earliest bar) up to the day before the first real snapshot
 * (real snapshots override from their first day). Static groups (pension, funds, real estate, cash) are not rebuilt:
 * `staticUsd` carries today's values; the page draws them flat only when the owner asks for it.
 *
 * Pure: the price series come in as a map (dashboardBuild.ts reads the files; readPriceSeries below).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { LedgerHoldings, LedgerStock } from './schema.ts';
import { groupOfStock } from './schema.ts';
import { cryptoPriceSymbol } from './cryptoPrices.ts';
import type { Logger } from '../core/logger.ts';
import { orElse } from '../core/guard.ts';
import { seriesFromCsv, longHistoryBaseName, LONG_HISTORY_META, type LongHistoryMeta } from '../storage/longHistory.ts';

/** The first day the estimate may start (owner 2026-11-07: positions are 4-6 years old). */
export const ESTIMATE_FROM = '2020-01-01';
/** Within this many days of the last point: every trading day. */
export const DAILY_DAYS = 90;
/** Within this many days: one point a week (Fridays); before it: month ends. */
export const WEEKLY_DAYS = 730;
export const ESTIMATE_LABEL = "estimated (today's holdings)";

export type MarketGroup = 'stocks' | 'btcFunds' | 'crypto' | 'calls';
export type StaticGroup = 'pension' | 'funds' | 'realEstate' | 'cash';
export const MARKET_GROUP_IDS: readonly MarketGroup[] = ['stocks', 'btcFunds', 'crypto', 'calls'];
export const STATIC_GROUP_IDS: readonly StaticGroup[] = ['pension', 'funds', 'realEstate', 'cash'];

/** One ticker's daily closes, dates ascending. */
export interface PriceSeries { readonly dates: readonly string[]; readonly closes: readonly number[] }

export interface EstimateCoverage {
  /** Current holdings whose whole quantity has a known start day (bought, or dated lots covering all of qty). */
  readonly dated: number;
  /** Some lots dated, the rest assumed held for the whole range. */
  readonly partly: number;
  /** No date known: assumed held for the whole range. */
  readonly assumed: number;
  /** Closed positions put in the past (held between bought and sold). */
  readonly closed: number;
  /** Calls (open or closed) drawn flat at their cost. */
  readonly callsAtCost: number;
  /** Tickers with no price series (drawn flat at today's value, a closed one at its cost; left out when no value is known). */
  readonly noHistory: readonly string[];
  /** Groups with no line priced from history (all flat: calls at cost, coins without a series). */
  readonly flatGroups: readonly MarketGroup[];
}

export interface GrowthEstimate {
  readonly label: string;
  readonly basis: 'today-holdings';
  /** Today's USD/ILS used for every estimated point (null = none known; ILS holdings are then left out). */
  readonly fx: number | null;
  /** The sampled days, ascending (all before the first real snapshot). */
  readonly days: readonly string[];
  /** Per market group, one value per day in USD (a group with no position at all is absent). */
  readonly usd: Readonly<Partial<Record<MarketGroup, readonly number[]>>>;
  /** Today's value of each static group in USD (drawn flat only when the owner includes them). */
  readonly staticUsd: Readonly<Partial<Record<StaticGroup, number>>>;
  readonly coverage: EstimateCoverage;
}

export interface EstimateInput {
  readonly holdings: LedgerHoldings;
  /** By series key: the ticker (stocks, funds) or "<symbol>-USD" (coins). */
  readonly series: ReadonlyMap<string, PriceSeries>;
  readonly fx: number | null;
  /** 'YYYY-MM-DD' (New York). */
  readonly today: string;
  /** The first real snapshot day: the estimate stops the day before. null = none (the estimate runs to the last bar). */
  readonly firstReal: string | null;
  readonly staticUsd?: Readonly<Partial<Record<StaticGroup, number>>>;
  /** Today's USD value by holding id (the net worth items): a holding with no price series is drawn flat at it. */
  readonly todayUsd?: ReadonlyMap<string, number>;
  readonly from?: string;
}

const EPS = 1e-9;
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isDay = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x);
const r2 = (x: number): number => Math.round(x * 100) / 100;
const dms = (d: string): number => Date.parse(d + 'T12:00:00Z');
const dayStr = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const addDays = (d: string, k: number): string => dayStr(dms(d) + k * 86_400_000);

/** The series key of a stock line: its ticker, or "<symbol>-USD" for a coin. */
export function seriesKey(s: Pick<LedgerStock, 'ticker' | 'kind' | 'priceSymbol'>): string {
  return s.kind === 'crypto' ? cryptoPriceSymbol(s).toUpperCase() + '-USD' : s.ticker.toUpperCase();
}

/** One priced piece of a position: `qty` units of `key` held on [start, end) (null = open-ended). */
interface Piece { readonly group: MarketGroup; readonly key: string | null; readonly qty: number; readonly start: string | null; readonly end: string | null; readonly flatUsd: number | null; readonly ils: boolean }

/** The held pieces of one current stock line, and how well its dates are known. */
export function stockPieces(s: LedgerStock): { pieces: { qty: number; start: string | null }[]; known: 'dated' | 'partly' | 'assumed' } {
  const bought = isDay(s.bought) ? s.bought : null;
  const dated = (Array.isArray(s.lots) ? s.lots : []).filter((l) => l && isDay(l.date) && fin(l.qty) && l.qty > 0).slice().sort((a, b) => (a.date as string).localeCompare(b.date as string));
  const pieces: { qty: number; start: string | null }[] = [];
  let left = s.qty;
  for (const l of dated) {
    if (left <= EPS) break;
    const q = Math.min(l.qty, left);
    pieces.push({ qty: q, start: l.date as string });
    left -= q;
  }
  if (left > EPS) pieces.push({ qty: left, start: bought });
  const known = left <= EPS || bought ? 'dated' : dated.length ? 'partly' : 'assumed';
  return { pieces, known };
}

/**
 * The sampled days between `first` and `last` (both 'YYYY-MM-DD'): month ends before last - WEEKLY_DAYS, Fridays
 * before last - DAILY_DAYS, then every day in `trading` (the bars' own days) from there; `last` itself is always in.
 */
export function sampleDays(first: string, last: string, trading: readonly string[]): string[] {
  if (first > last) return [];
  const weeklyFrom = addDays(last, -WEEKLY_DAYS), dailyFrom = addDays(last, -DAILY_DAYS);
  const out: string[] = [];
  for (let y = Number(first.slice(0, 4)), m = Number(first.slice(5, 7)); ; m === 12 ? (m = 1, y++) : m++) {
    const end = dayStr(Date.UTC(y, m, 0, 12));
    if (end >= weeklyFrom || end > last) break;
    if (end >= first) out.push(end);
  }
  let d = first > weeklyFrom ? first : weeklyFrom;
  while (new Date(dms(d)).getUTCDay() !== 5) d = addDays(d, 1);
  for (; d < dailyFrom && d <= last; d = addDays(d, 7)) out.push(d);
  const lo = first > dailyFrom ? first : dailyFrom;
  for (const t of trading) if (t >= lo && t <= last && (!out.length || t > (out[out.length - 1] as string))) out.push(t);
  if (!out.length || (out[out.length - 1] as string) < last) out.push(last);
  return out;
}

/** The close on or before `d` (null before the first bar); `at` is a moving cursor for ascending days. */
function closeOn(s: PriceSeries, d: string, at: { i: number }): number | null {
  while (at.i + 1 < s.dates.length && (s.dates[at.i + 1] as string) <= d) at.i++;
  if (!s.dates.length || (s.dates[0] as string) > d) return null;
  const c = s.closes[at.i];
  return fin(c) && c > 0 ? c : null;
}

export function buildEstimate(input: EstimateInput): GrowthEstimate | null {
  const H = input.holdings, fx = input.fx != null && input.fx > 0 ? input.fx : null;
  const pieces: Piece[] = [];
  let dated = 0, partly = 0, assumed = 0, closedN = 0, callsAtCost = 0;
  const noHistory = new Set<string>();
  const has = (k: string): boolean => (input.series.get(k)?.dates.length ?? 0) > 0;

  for (const s of H.stocks ?? []) {
    if (!s || typeof s.ticker !== 'string' || !fin(s.qty) || s.qty <= 0) continue;
    const key = seriesKey(s), now = input.todayUsd?.get(s.id);
    const priced = has(key);
    if (!priced) { noHistory.add(s.ticker); if (!fin(now)) continue; }
    const { pieces: ps, known } = stockPieces(s);
    if (known === 'dated') dated++; else if (known === 'partly') partly++; else assumed++;
    const group = groupOfStock(s) as MarketGroup;
    for (const p of ps) pieces.push(priced ? { group, key, qty: p.qty, start: p.start, end: null, flatUsd: null, ils: s.currency === 'ILS' } : { group, key: null, qty: p.qty, start: p.start, end: null, flatUsd: (now as number) * p.qty / s.qty, ils: false });
  }
  for (const o of H.options ?? []) {
    if (!o || !fin(o.contracts) || !fin(o.avgPremium)) continue;
    callsAtCost++;
    if (isDay(o.bought)) dated++; else assumed++;
    pieces.push({ group: 'calls', key: null, qty: 1, start: isDay(o.bought) ? o.bought : null, end: null, flatUsd: o.avgPremium * 100 * o.contracts, ils: false });
  }
  for (const c of H.closed ?? []) {
    if (!c || !isDay(c.sold) || !fin(c.qty) || c.qty <= 0) continue;
    const start = isDay(c.bought) ? c.bought : null;
    if (c.kind === 'call' || c.kind === 'put') {
      if (!fin(c.cost)) continue;
      closedN++; callsAtCost++;
      pieces.push({ group: 'calls', key: null, qty: 1, start, end: c.sold, flatUsd: c.cost, ils: c.currency === 'ILS' });
      continue;
    }
    const key = seriesKey({ ticker: c.ticker, kind: c.kind });
    if (!has(key)) {
      noHistory.add(c.ticker);
      if (!fin(c.cost)) continue;
      closedN++;
      pieces.push({ group: groupOfStock({ kind: c.kind }) as MarketGroup, key: null, qty: 1, start, end: c.sold, flatUsd: c.cost, ils: c.currency === 'ILS' });
      continue;
    }
    closedN++;
    pieces.push({ group: groupOfStock({ kind: c.kind }) as MarketGroup, key, qty: c.qty, start, end: c.sold, flatUsd: null, ils: c.currency === 'ILS' });
  }
  const usable = pieces.filter((p) => !p.ils || fx != null);
  if (!usable.length) return null;

  // The range: from ESTIMATE_FROM (or the earliest bar used) to the day before the first real snapshot (or the last bar).
  const from = input.from ?? ESTIMATE_FROM;
  const keys = [...new Set(usable.map((p) => p.key).filter((k): k is string => k != null))];
  const firstBar = keys.map((k) => input.series.get(k)!.dates[0] as string).sort()[0];
  const lastBar = keys.map((k) => { const d = input.series.get(k)!.dates; return d[d.length - 1] as string; }).sort().pop();
  const start = firstBar && firstBar > from ? firstBar : from;
  let end = lastBar && lastBar < input.today ? lastBar : input.today;
  if (input.firstReal && input.firstReal <= end) end = addDays(input.firstReal, -1);
  if (start > end) return null;
  const trading = [...new Set(keys.flatMap((k) => input.series.get(k)!.dates.filter((d) => d >= addDays(end, -DAILY_DAYS - 7) && d <= end)))].sort();
  const days = sampleDays(start, end, trading);
  if (!days.length) return null;

  const sums: Partial<Record<MarketGroup, number[]>> = {};
  const cursors = new Map<string, { i: number }>();
  for (const p of usable) sums[p.group] ??= days.map(() => 0);
  days.forEach((d, j) => {
    for (const p of usable) {
      if (p.start && d < p.start) continue;
      if (p.end && d >= p.end) continue;
      let usd: number | null;
      if (p.flatUsd != null) usd = p.flatUsd;
      else {
        const s = input.series.get(p.key as string) as PriceSeries;
        let cur = cursors.get(p.key as string);
        if (!cur) { cur = { i: 0 }; cursors.set(p.key as string, cur); }
        const c = closeOn(s, d, cur);
        usd = c == null ? null : c * p.qty;
      }
      if (usd == null) continue;
      if (p.ils) usd /= fx as number;
      (sums[p.group] as number[])[j] += usd;
    }
  });
  const usd: Partial<Record<MarketGroup, number[]>> = {};
  for (const g of MARKET_GROUP_IDS) if (sums[g]) usd[g] = (sums[g] as number[]).map(r2);
  const staticUsd: Partial<Record<StaticGroup, number>> = {};
  for (const g of STATIC_GROUP_IDS) { const v = input.staticUsd?.[g]; if (fin(v)) staticUsd[g] = r2(v); }
  return {
    label: ESTIMATE_LABEL, basis: 'today-holdings', fx, days, usd, staticUsd,
    coverage: { dated, partly, assumed, closed: closedN, callsAtCost, noHistory: [...noHistory].sort(), flatGroups: MARKET_GROUP_IDS.filter((g) => usd[g] && !usable.some((p) => p.group === g && p.key != null)) },
  };
}

/** The series keys the estimate needs for a ledger (stocks, funds, coins, closed positions). */
export function neededSeries(H: LedgerHoldings): string[] {
  const out = new Set<string>();
  for (const s of H.stocks ?? []) if (s && typeof s.ticker === 'string') out.add(seriesKey(s));
  for (const c of H.closed ?? []) if (c && typeof c.ticker === 'string' && c.kind !== 'call' && c.kind !== 'put') out.add(seriesKey({ ticker: c.ticker, kind: c.kind }));
  return [...out];
}

/**
 * Thin I/O: the closes of each key from a long-history folder (`<T>.csv`); a missing or bad file is left out (one log
 * line when a logger is given). Never throws.
 */
export function readPriceSeries(dir: string, keys: readonly string[], log?: Logger | null): Map<string, PriceSeries> {
  const out = new Map<string, PriceSeries>();
  if (!fs.existsSync(dir)) return out;
  const metaFile = path.join(dir, LONG_HISTORY_META);
  const meta = fs.existsSync(metaFile) ? orElse<Record<string, LongHistoryMeta>>(log, 'long history ' + LONG_HISTORY_META, () => JSON.parse(fs.readFileSync(metaFile, 'utf8')) as Record<string, LongHistoryMeta>, {}) : {};
  for (const k of keys) {
    const f = path.join(dir, longHistoryBaseName(k) + '.csv');
    if (!fs.existsSync(f)) continue;
    const s = orElse(log, 'long history ' + k, () => seriesFromCsv(k, fs.readFileSync(f, 'utf8'), meta[k]?.splits ?? []), null);
    if (s && s.dates.length) out.set(k, { dates: s.dates, closes: s.closes });
  }
  return out;
}
