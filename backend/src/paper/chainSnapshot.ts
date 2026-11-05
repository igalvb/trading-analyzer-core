/**
 * G3 (docs/models/MASTER_PLAN.md section 4; plan 04 piece 4b): the nightly option-chain snapshot for James's options
 * models ("James — LEAPS", "James — Option Fair Value"). No IV history exists anywhere in the project; it starts the
 * night this ships (a true IV rank needs about 252 nights).
 *
 * Self-contained: it picks its own contracts and does not wait for model 3. It reads ONLY the chains the paper night
 * already fetched for the LEAPS accounts (paperJob.ts `optionsTonight`, memoised per run): no extra Cboe call, and QQQ
 * and SPY are not added. For each ticker, each night:
 *   - every call of the two January expiries nearest to 12-27 months out (the LEAPS a later pick is rebuilt from:
 *     model 3's 0.60 / 0.75 / 0.85 contracts come from these),
 *   - the ~30-day at-the-money calls (the two strikes below and the two above the price),
 *   - the engine's current LEAPS pick,
 * per contract: strike, bid, ask, iv, delta, open interest, and vega / theo / rho when the feed carries them.
 *
 * Two append-only tabs through the TabStore (so they follow the Sheets routing like every other tab), one block per
 * night, never written twice (paperLog.ts `appendNight`):
 *   📉 IV History                 one light row per ticker: spot, ATM IV ~30 days and ~1 year, RV20/60/252, the chain
 *                                 summary; a ticker whose chain failed gets a "no chain" row
 *   📦 Option Chain Snapshots     the compact JSON of the contracts above, one row per ticker (split into parts when
 *                                 longer than a cell may hold)
 * A failure here is logged by the caller and never stops the paper night.
 */

import type { TabStore, TabCell } from '../storage/tabStore.ts';
import type { CboeChainJson } from '../fetch/cboe.ts';
import { parseOcc } from '../fetch/cboe.ts';
import type { PriceSeries } from '../backtest/data.ts';
import type { LeapsPick } from './paperLeaps.ts';
import { realizedVol } from '../analysis/options/blackScholes.ts';
import { appendNight } from './paperLog.ts';

export const IV_HISTORY_TAB = '📉 IV History';
export const CHAIN_SNAPSHOT_TAB = '📦 Option Chain Snapshots';
export const IV_HISTORY_HEADER: readonly string[] = [
  'Day', 'Ticker', 'Status', 'Spot', 'ATM IV ~30 days', '~30-day expiry', 'ATM IV ~1 year', '~1-year expiry', 'RV20', 'RV60', 'RV252',
  'IV ~30 days ÷ RV60', 'Calls in chain', 'Contracts stored', 'Januaries stored', 'Engine LEAPS pick', 'Vega in feed', 'Theo in feed',
];
export const CHAIN_SNAPSHOT_HEADER: readonly string[] = ['Day', 'Ticker', 'Part', 'Snapshot (JSON: fields, then one row per call)'];
/** Longest text written to one cell (a Sheets cell holds 50,000 characters). */
export const SNAPSHOT_CELL_CHARS = 40_000;
/** The LEAPS window the two Januaries are taken from, in months. */
export const JANUARY_WINDOW_MONTHS: readonly [number, number] = [12, 27];
/** Nights needed before an IV rank over time means anything (plan 04 P7). */
export const IV_RANK_NIGHTS = 252;
export const SNAPSHOT_FIELDS: readonly string[] = ['strike', 'bid', 'ask', 'iv', 'delta', 'oi', 'vega', 'theo', 'rho'];

const DAY = 86_400;
const MONTH_DAYS = 30.4375;

export interface ChainCall {
  readonly strike: number; readonly expUnix: number;
  readonly bid: number | null; readonly ask: number | null; readonly iv: number | null; readonly delta: number | null; readonly oi: number | null;
  readonly vega: number | null; readonly theo: number | null; readonly rho: number | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v: number | null, dp: number): number | null => (v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp);
export const expiryDay = (expUnix: number): string => new Date(expUnix * 1000).toISOString().slice(0, 10);

/** Every call of a Cboe chain, by OCC symbol. */
export function chainCalls(json: CboeChainJson | null): ChainCall[] {
  const out: ChainCall[] = [];
  for (const o of json?.data?.options ?? []) {
    if (!o.option) continue;
    const p = parseOcc(String(o.option));
    if (p.side !== 'call' || !(p.strike > 0)) continue;
    out.push({ strike: p.strike, expUnix: p.expUnix, bid: num(o.bid), ask: num(o.ask), iv: num(o.iv), delta: num(o.delta), oi: num(o.open_interest), vega: num(o.vega), theo: num(o.theo), rho: num(o.rho) });
  }
  return out;
}

/** The months between tonight and an expiry. */
const monthsOut = (expUnix: number, nowUnix: number): number => (expUnix - nowUnix) / DAY / MONTH_DAYS;

/**
 * The two January expiries nearest to 12-27 months out (inside the window first, then the closest to it). A year
 * with several January expiries counts once: the one with the most calls (the monthly LEAPS expiry).
 */
export function pickJanuaries(calls: readonly ChainCall[], nowUnix: number): number[] {
  const byExp = new Map<number, number>();
  for (const c of calls) if (c.expUnix > nowUnix && new Date(c.expUnix * 1000).getUTCMonth() === 0) byExp.set(c.expUnix, (byExp.get(c.expUnix) ?? 0) + 1);
  const perYear = new Map<number, [number, number]>();
  for (const [exp, n] of byExp) {
    const y = new Date(exp * 1000).getUTCFullYear(), have = perYear.get(y);
    if (!have || n > have[1] || (n === have[1] && exp > have[0])) perYear.set(y, [exp, n]);
  }
  const [lo, hi] = JANUARY_WINDOW_MONTHS;
  const dist = (exp: number): number => { const m = monthsOut(exp, nowUnix); return m < lo ? lo - m : m > hi ? m - hi : 0; };
  return [...perYear.values()].map(([e]) => e).sort((a, b) => dist(a) - dist(b) || a - b).slice(0, 2).sort((a, b) => a - b);
}

/** The expiry closest to `days` calendar days out (at least `minDays` out); null when none. */
export function nearestExpiry(calls: readonly ChainCall[], nowUnix: number, days: number, minDays = 0): number | null {
  let best: number | null = null;
  for (const e of new Set(calls.map((c) => c.expUnix))) {
    const d = (e - nowUnix) / DAY;
    if (d < minDays) continue;
    if (best == null || Math.abs(d - days) < Math.abs((best - nowUnix) / DAY - days) || (Math.abs(d - days) === Math.abs((best - nowUnix) / DAY - days) && e < best)) best = e;
  }
  return best;
}

/** The at-the-money calls of one expiry: up to `each` strikes at or below the price and `each` above it. */
export function atmCalls(calls: readonly ChainCall[], expUnix: number, spot: number, each = 2): ChainCall[] {
  const xs = calls.filter((c) => c.expUnix === expUnix).sort((a, b) => a.strike - b.strike);
  const below = xs.filter((c) => c.strike <= spot).slice(-each), above = xs.filter((c) => c.strike > spot).slice(0, each);
  return [...below, ...above];
}

/**
 * The at-the-money implied volatility of one expiry: linear in the strike between the nearest call at or below the
 * price and the nearest above it, each with an iv above zero; one-sided chains use the nearest side; null when no call
 * of that expiry has an iv.
 */
export function atmIv(calls: readonly ChainCall[], expUnix: number, spot: number): number | null {
  const xs = calls.filter((c) => c.expUnix === expUnix && c.iv != null && c.iv > 0).sort((a, b) => a.strike - b.strike);
  if (!xs.length) return null;
  const lo = xs.filter((c) => c.strike <= spot).pop(), hi = xs.find((c) => c.strike > spot);
  if (lo && hi) return (lo.iv as number) + ((hi.iv as number) - (lo.iv as number)) * ((spot - lo.strike) / (hi.strike - lo.strike));
  return ((lo ?? hi) as ChainCall).iv;
}

/** A percentile rank (0-100) of today's value among the stored nights; null until IV_RANK_NIGHTS nights exist. */
export function ivRankOverTime(history: readonly number[], today: number): number | null {
  if (history.length < IV_RANK_NIGHTS) return null;
  const w = history.slice(-IV_RANK_NIGHTS);
  return (w.filter((v) => v < today).length / w.length) * 100;
}

export interface TickerSnapshot {
  readonly v: 1;
  readonly day: string;
  readonly ticker: string;
  readonly spot: number | null;
  readonly asOfUnix: number;
  readonly fields: readonly string[];
  /** expiry 'YYYY-MM-DD' -> its role and its calls (rows in `fields` order). */
  readonly expiries: Record<string, { role: 'january' | 'atm30'; rows: Array<Array<number | null>> }>;
  readonly pick: { symbol: string; strike: number; expiry: string; bid: number; ask: number } | null;
}

export interface TickerNight {
  readonly ticker: string;
  readonly chain: CboeChainJson | null;
  readonly pick: LeapsPick | null;
  /** The ticker's daily closes up to tonight (for RV), and tonight's close (spot fallback). */
  readonly series?: PriceSeries | undefined;
}

const rowOf = (c: ChainCall): Array<number | null> => [c.strike, round(c.bid, 2), round(c.ask, 2), round(c.iv, 4), round(c.delta, 4), c.oi, round(c.vega, 4), round(c.theo, 4), round(c.rho, 4)];

/** Tonight's snapshot and light row for one ticker. */
export function tickerNight(day: string, n: TickerNight, nowUnix: number): { row: TabCell[]; snapshot: TickerSnapshot | null } {
  const closes = n.series ? n.series.closes.slice(0, n.series.dates.lastIndexOf(day) + 1 || n.series.closes.length) : [];
  const rv = (k: number): number | null => realizedVol(closes, k);
  const rvCells = [rv(20), rv(60), rv(252)].map((x) => (x == null ? '' : round(x, 4) as number));
  const calls = chainCalls(n.chain);
  const spot = num(n.chain?.data?.current_price) ?? (closes.length ? (closes[closes.length - 1] as number) : null);
  if (!n.chain || !calls.length || spot == null) {
    return { row: [day, n.ticker, 'no chain', spot ?? '', '', '', '', '', ...rvCells, '', calls.length, 0, '', '', '', ''], snapshot: null };
  }
  const jans = pickJanuaries(calls, nowUnix);
  const e30 = nearestExpiry(calls, nowUnix, 30, 7), e365 = nearestExpiry(calls, nowUnix, 365, 180);
  const expiries: TickerSnapshot['expiries'] = {};
  for (const e of jans) expiries[expiryDay(e)] = { role: 'january', rows: calls.filter((c) => c.expUnix === e).sort((a, b) => a.strike - b.strike).map(rowOf) };
  if (e30 != null && !jans.includes(e30)) expiries[expiryDay(e30)] = { role: 'atm30', rows: atmCalls(calls, e30, spot).map(rowOf) };
  const stored = Object.values(expiries).reduce((s, x) => s + x.rows.length, 0);
  const iv30 = e30 == null ? null : atmIv(calls, e30, spot), iv365 = e365 == null ? null : atmIv(calls, e365, spot);
  const rv60 = rv(60);
  const snapshot: TickerSnapshot = {
    v: 1, day, ticker: n.ticker, spot, asOfUnix: nowUnix, fields: SNAPSHOT_FIELDS, expiries,
    pick: n.pick ? { symbol: n.pick.symbol, strike: n.pick.strike, expiry: expiryDay(n.pick.expUnix), bid: n.pick.bid, ask: n.pick.ask } : null,
  };
  const row: TabCell[] = [
    day, n.ticker, 'ok', spot, iv30 == null ? '' : round(iv30, 4) as number, e30 == null ? '' : expiryDay(e30), iv365 == null ? '' : round(iv365, 4) as number, e365 == null ? '' : expiryDay(e365),
    ...rvCells, iv30 != null && rv60 ? round(iv30 / rv60, 3) as number : '', calls.length, stored, jans.map(expiryDay).join(', '),
    n.pick ? n.pick.symbol : '', calls.some((c) => c.vega != null) ? 'yes' : 'no', calls.some((c) => c.theo != null) ? 'yes' : 'no',
  ];
  return { row, snapshot };
}

/** A snapshot as tab rows: one row, or several parts when the JSON is longer than a cell may hold. */
export function snapshotRows(s: TickerSnapshot): TabCell[][] {
  const text = JSON.stringify(s), parts: string[] = [];
  for (let i = 0; i < text.length; i += SNAPSHOT_CELL_CHARS) parts.push(text.slice(i, i + SNAPSHOT_CELL_CHARS));
  return parts.map((p, i) => [s.day, s.ticker, (i + 1) + '/' + parts.length, p]);
}

/** Reads the snapshots back from the tab's rows (parts joined in order): ticker -> day -> snapshot. */
export function readSnapshots(rows: readonly (readonly TabCell[])[]): Map<string, Map<string, TickerSnapshot>> {
  const parts = new Map<string, string[]>();
  for (const r of rows) {
    const [day, t, part, text] = r.map(String) as [string, string, string, string];
    const m = /^(\d+)\/(\d+)$/.exec(part);
    if (!m) continue;
    const k = day + '|' + t, xs = parts.get(k) ?? Array(Number(m[2])).fill('');
    xs[Number(m[1]) - 1] = text; parts.set(k, xs);
  }
  const out = new Map<string, Map<string, TickerSnapshot>>();
  for (const [k, xs] of parts) {
    if (xs.some((x) => !x)) continue;
    const s = JSON.parse(xs.join('')) as TickerSnapshot, [day, t] = k.split('|') as [string, string];
    (out.get(t) ?? out.set(t, new Map()).get(t)!).set(day, s);
  }
  return out;
}

/** The calls of one stored expiry, back as objects (for a later pick, e.g. model 3's 0.75 contract). */
export function snapshotCalls(s: TickerSnapshot, expiry: string): ChainCall[] {
  const e = s.expiries[expiry];
  if (!e) return [];
  const at = (name: string): number => s.fields.indexOf(name);
  const expUnix = Math.floor(Date.parse(expiry + 'T00:00:00Z') / 1000);
  return e.rows.map((r) => ({
    strike: r[at('strike')] as number, expUnix, bid: r[at('bid')] ?? null, ask: r[at('ask')] ?? null, iv: r[at('iv')] ?? null, delta: r[at('delta')] ?? null,
    oi: r[at('oi')] ?? null, vega: r[at('vega')] ?? null, theo: r[at('theo')] ?? null, rho: r[at('rho')] ?? null,
  }));
}

/**
 * Writes tonight's snapshot: the light rows to 📉 IV History and the contracts to 📦 Option Chain Snapshots. A night
 * already written (a retried run) writes nothing. Returns how many tickers had a chain.
 */
export async function recordChainNight(store: TabStore, day: string, nights: readonly TickerNight[], nowUnix: number): Promise<{ withChain: number; rows: number }> {
  const rows: TabCell[][] = [], snaps: TabCell[][] = [];
  let withChain = 0;
  for (const n of nights) {
    const x = tickerNight(day, n, nowUnix);
    rows.push(x.row);
    if (x.snapshot) { withChain++; snaps.push(...snapshotRows(x.snapshot)); }
  }
  const written = await appendNight(store, IV_HISTORY_TAB, IV_HISTORY_HEADER, day, rows);
  await appendNight(store, CHAIN_SNAPSHOT_TAB, CHAIN_SNAPSHOT_HEADER, day, snaps);
  return { withChain, rows: written };
}
