/**
 * Long price history (docs/LONG_HISTORY_PLAN.md): daily bars from 2007, kept as files on the `prices` branch of the
 * repository (one CSV per ticker, written by `npm run long-history`), merged IN FRONT of the 2-year '💾' cache.
 *
 * OFF by default. On only with LONG_HISTORY=on (and never in legacy-parity runs); the folder is LONG_HISTORY_DIR
 * (default ../long-history/prices, where a workflow would check the `prices` branch out next to backend/). Off,
 * nothing here runs and every chart is exactly what fetch/chart.ts returns.
 *
 * The merge (mergeLongHistory) never touches the cache: the cache's bars are kept exactly as fetched, and only the
 * long file's bars dated strictly BEFORE the cache's first bar are put in front. The merged chart is never saved.
 *
 * Splits and dividends: both sources are Yahoo's split-adjusted, NOT dividend-adjusted daily bars (`close`, never
 * `adjclose`), so they agree. A split after the long file was written leaves its bars unadjusted: the overlap with the
 * cache (normally ~2 years of bars on the same days) shows one steady price factor, which is applied to the older bars
 * (prices times the factor, volumes divided by it). An overlap that does not agree on one factor, or no overlap at all,
 * means no merge: the chart stays the cache alone, and the reason is logged.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { FetchedChart, Split } from '../types/chart.ts';

/** One ticker's long history: 'YYYY-MM-DD' dates ascending, columnar like research/fetchPrices.ts RawSeries. */
export interface LongSeries {
  readonly ticker: string;
  readonly dates: readonly string[];
  readonly opens: readonly number[];
  readonly highs: readonly number[];
  readonly lows: readonly number[];
  readonly closes: readonly number[];
  readonly volumes: readonly number[];
  /** Unix seconds, as Yahoo lists them. */
  readonly splits: ReadonlyArray<{ readonly date: number; readonly numerator: number; readonly denominator: number }>;
}

export interface LongHistoryStore {
  read(ticker: string): Promise<LongSeries | null>;
}

export const LONG_HISTORY_DEFAULT_DIR = '../long-history/prices';
/** The CSV header of one ticker's file. */
export const LONG_HISTORY_HEADER = 'Date,Open,High,Low,Close,Volume';
/** The side file with each ticker's splits and download time. */
export const LONG_HISTORY_META = '_meta.json';
/** The fewest overlapping days the merge needs to trust the seam. */
export const MIN_OVERLAP_BARS = 5;
/** How far one overlapping day may sit from the common factor (rounding in the Sheet cache, Yahoo revisions). */
export const OVERLAP_TOLERANCE = 0.01;
/** A factor this close to 1 is 1 (no split since the long file was written). */
const UNIT_FACTOR_TOLERANCE = 0.002;

/** '^VIX' is stored as '_VIX' (the research files' rule, backtest/data.ts priceFileName). */
export function longHistoryBaseName(ticker: string): string {
  return ticker.replace(/^\^/, '_');
}

export interface LongHistoryMeta {
  readonly fetchedAt: string;
  readonly splits: LongSeries['splits'];
}

export function seriesToCsv(s: LongSeries): string {
  const lines = [LONG_HISTORY_HEADER];
  for (let i = 0; i < s.dates.length; i++) {
    lines.push([s.dates[i], s.opens[i], s.highs[i], s.lows[i], s.closes[i], s.volumes[i]].join(','));
  }
  return lines.join('\n') + '\n';
}

/** One CSV file back to a series; null when the text is not the expected shape. */
export function seriesFromCsv(ticker: string, text: string, splits: LongSeries['splits'] = []): LongSeries | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length || lines[0]!.trim() !== LONG_HISTORY_HEADER) return null;
  const s = { ticker, dates: [] as string[], opens: [] as number[], highs: [] as number[], lows: [] as number[], closes: [] as number[], volumes: [] as number[], splits };
  for (const l of lines.slice(1)) {
    const [d, o, h, lo, c, v] = l.split(',');
    const nums = [o, h, lo, c, v].map(Number);
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d) || nums.some((x) => !Number.isFinite(x))) return null;
    s.dates.push(d); s.opens.push(nums[0]!); s.highs.push(nums[1]!); s.lows.push(nums[2]!); s.closes.push(nums[3]!); s.volumes.push(nums[4]!);
  }
  return validSeries(s) ? s : null;
}

/** The research JSON (research/fetchPrices.ts RawSeries, /tmp or `recordings` files) as a series; null when malformed. */
export function seriesFromJson(ticker: string, raw: unknown): LongSeries | null {
  const r = raw as Partial<Record<keyof LongSeries, unknown>> | null;
  if (!r || !Array.isArray(r.dates) || !Array.isArray(r.closes)) return null;
  const closes = r.closes as number[];
  const s: LongSeries = {
    ticker, dates: r.dates as string[], closes,
    opens: Array.isArray(r.opens) ? (r.opens as number[]) : closes,
    highs: Array.isArray(r.highs) ? (r.highs as number[]) : closes,
    lows: Array.isArray(r.lows) ? (r.lows as number[]) : closes,
    volumes: Array.isArray(r.volumes) ? (r.volumes as number[]) : closes.map(() => 0),
    splits: Array.isArray(r.splits) ? (r.splits as LongSeries['splits']) : [],
  };
  return validSeries(s) ? s : null;
}

function validSeries(s: LongSeries): boolean {
  const n = s.dates.length;
  if (!n || [s.opens, s.highs, s.lows, s.closes, s.volumes].some((a) => a.length !== n)) return false;
  for (let i = 1; i < n; i++) if ((s.dates[i] as string) <= (s.dates[i - 1] as string)) return false;
  return true;
}

/**
 * The files in one folder: `<T>.csv` (+ `_meta.json` for the splits), or the research `<T>.json`. Each ticker is read
 * once per process (a run asks for the same chart several times); a missing or malformed file is null (no merge).
 */
export class DirLongHistoryStore implements LongHistoryStore {
  readonly dir: string;
  private readonly memo = new Map<string, LongSeries | null>();
  private meta: Record<string, LongHistoryMeta> | null = null;
  constructor(dir: string) { this.dir = dir; }
  async read(ticker: string): Promise<LongSeries | null> {
    if (!this.memo.has(ticker)) this.memo.set(ticker, this.load(ticker));
    return this.memo.get(ticker) ?? null;
  }
  private load(ticker: string): LongSeries | null {
    const base = path.join(this.dir, longHistoryBaseName(ticker));
    try {
      if (fs.existsSync(base + '.csv')) return seriesFromCsv(ticker, fs.readFileSync(base + '.csv', 'utf8'), this.metaFor(ticker)?.splits ?? []);
      if (fs.existsSync(base + '.json')) return seriesFromJson(ticker, JSON.parse(fs.readFileSync(base + '.json', 'utf8')));
    } catch { /* unreadable: no merge */ }
    return null;
  }
  private metaFor(ticker: string): LongHistoryMeta | null {
    if (!this.meta) {
      try { this.meta = JSON.parse(fs.readFileSync(path.join(this.dir, LONG_HISTORY_META), 'utf8')) as Record<string, LongHistoryMeta>; } catch { this.meta = {}; }
    }
    return this.meta[ticker] ?? null;
  }
}

export interface LongHistoryConfig { readonly on: boolean; readonly dir: string }

/** LONG_HISTORY=on turns it on (any other value, or none: off); LONG_HISTORY_DIR names the folder. */
export function longHistoryFromEnv(env: Readonly<Record<string, string | undefined>>): LongHistoryConfig {
  const on = String(env.LONG_HISTORY ?? '').trim().toLowerCase() === 'on';
  const dir = String(env.LONG_HISTORY_DIR ?? '').trim() || LONG_HISTORY_DEFAULT_DIR;
  return { on, dir };
}

const utcDay = (d: Date): string => d.toISOString().slice(0, 10);
/** A long bar's Date: the time stamp the backtest and the test fixtures use (13:30 UTC; crypto, dated in UTC: 00:00). */
function barDate(ticker: string, day: string): Date {
  return new Date(day + (/^[A-Z0-9]+-USD$/i.test(ticker) ? 'T00:00:00Z' : 'T13:30:00Z'));
}

export interface MergeResult {
  readonly chart: FetchedChart;
  /** Bars put in front of the cache (0 = the chart is the cache alone). */
  readonly added: number;
  /** The price factor applied to the long bars (1 = none). */
  readonly factor: number;
  /** Why nothing was merged, when nothing was. */
  readonly skipped?: string;
}

/**
 * The cache with the long file's older bars in front. The cache's own bars, current price, previous close, currency
 * and IPO date are kept exactly; its splits list gains the long file's earlier splits.
 */
export function mergeLongHistory(long: LongSeries | null, chart: FetchedChart): MergeResult {
  const none = (skipped: string): MergeResult => ({ chart, added: 0, factor: 1, skipped });
  if (!long || !long.dates.length) return none('no long history file');
  if (!chart.dates.length) return none('empty chart');
  const first = utcDay(chart.dates[0] as Date);
  let head = 0;
  while (head < long.dates.length && (long.dates[head] as string) < first) head++;
  if (head === 0) return none('the long history starts after the cache');
  // The seam: the same days in both, the latest 60 at most.
  const byDay = new Map<string, number>();
  for (let i = 0; i < chart.dates.length; i++) byDay.set(utcDay(chart.dates[i] as Date), i);
  const ratios: number[] = [];
  for (let i = long.dates.length - 1; i >= head && ratios.length < 60; i--) {
    const j = byDay.get(long.dates[i] as string);
    const lc = long.closes[i] as number;
    if (j != null && lc > 0) ratios.push((chart.closes[j] as number) / lc);
  }
  if (ratios.length < MIN_OVERLAP_BARS) return none('the long history and the cache overlap on ' + ratios.length + ' days (need ' + MIN_OVERLAP_BARS + ')');
  const sorted = [...ratios].sort((a, b) => a - b);
  let factor = sorted[Math.floor(sorted.length / 2)] as number;
  const agree = ratios.filter((r) => Math.abs(r / factor - 1) <= OVERLAP_TOLERANCE).length;
  if (agree < Math.ceil(ratios.length * 0.9)) return none('the long history and the cache disagree on the overlap (' + agree + ' of ' + ratios.length + ' days agree)');
  if (Math.abs(factor - 1) <= UNIT_FACTOR_TOLERANCE) factor = 1;
  const px = (a: readonly number[]): number[] => a.slice(0, head).map((v) => v * factor);
  const known = (chart.splits || []).map((s) => s.date.getTime());
  const olderSplits: Split[] = long.splits
    .filter((s) => utcDay(new Date(s.date * 1000)) < first && !known.includes(s.date * 1000))
    .map((s) => ({ date: new Date(s.date * 1000), numerator: s.numerator, denominator: s.denominator }));
  const merged: FetchedChart = {
    ...chart,
    dates: long.dates.slice(0, head).map((d) => barDate(chart.ticker, d)).concat(chart.dates),
    opens: px(long.opens).concat(chart.opens),
    highs: px(long.highs).concat(chart.highs),
    lows: px(long.lows).concat(chart.lows),
    closes: px(long.closes).concat(chart.closes),
    volumes: long.volumes.slice(0, head).map((v) => (factor === 1 ? v : Math.round(v / factor))).concat(chart.volumes),
    splits: [...olderSplits, ...(chart.splits || [])].sort((a, b) => a.date.getTime() - b.date.getTime()),
  };
  return { chart: merged, added: head, factor };
}

/** A fetchChart with the long history merged in (LONG_HISTORY=on); the reason a ticker is not merged is logged once. */
export function withLongHistory(
  fetchChart: (t: string) => Promise<FetchedChart | null>, store: LongHistoryStore, log: (m: string) => void = () => {},
): (t: string) => Promise<FetchedChart | null> {
  const told = new Set<string>();
  return async (t) => {
    const c = await fetchChart(t);
    if (!c) return c;
    let long: LongSeries | null = null;
    try { long = await store.read(t); } catch { long = null; }
    const r = mergeLongHistory(long, c);
    if (!told.has(t)) {
      told.add(t);
      log(r.added ? 'long history ' + t + ': ' + r.added + ' older bars from ' + long!.dates[0] + (r.factor !== 1 ? ' (split factor ' + r.factor.toFixed(4) + ')' : '')
        : 'long history ' + t + ': not used (' + r.skipped + ')');
    }
    return r.chart;
  };
}
