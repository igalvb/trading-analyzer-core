/**
 * The dark-pool tracker, the Evaluative Index and the relative-strength
 * ranking -- everything darkPoolTrackerV1.gs computes, ported exactly:
 *   DARK_POOL_WATCHLIST_V1 :46-61, extractAtsWeeklyShareV1_ :103-110,
 *   DARK_POOL_ELEVATED_THRESHOLD_PCT_V1 :118, buildDarkPoolTrackerReportV1_ :128-184,
 *   getCachedFinraWeekV1_ :197-199, getTickerDarkPoolShareV1_ :204-234,
 *   computeEvaluativeIndexV1_ :336-360, getCachedEvaluativeIndexV1_ :377-379,
 *   computeRelativeStrengthRankingV1_ :428-467, getCachedRelativeStrengthRankingV1_ :498-501
 * (the sheet writer is sheets/writers/darkPoolTracker.ts; the three daily
 * trigger handlers and their installers are jobs/darkPool.ts).
 *
 * The 14-category watchlist (111 distinct tickers; TSLA is in two) doubles as
 * the Evaluative Index basket and the relative-strength peer groups, as in
 * legacy. Charts come from the injected `fetchChart` -- production passes
 * fetchYahooChart (fetch/chart.ts), which has its own cache.
 */

import type { Clock } from '../core/context.ts';
import { cacheGet, cacheSet, type PropertyStore } from '../storage/kv.ts';
import { wilderSmooth } from './series.ts';
import { fetchFinraAtsWeeklyBatch, findLatestPublishedFinraWeek, type FinraAtsRow, type FinraDeps, type FinraTier } from '../fetch/finra/ats.ts';

/** darkPoolTrackerV1.gs:46-61, transcribed from the user's screenshot (2026-08-31). */
export const DARK_POOL_WATCHLIST: Readonly<Record<string, readonly string[]>> = {
  'SPY/QQQ': ['IVV', 'VOO', 'SPY', 'QQQ', 'DIA', 'IWM'],
  'Sector': ['XLI', 'XLB', 'XBI', 'SOXX', 'XLF', 'SMH', 'XLE'],
  'ETFs': ['XBIL', 'IXN', 'IEUR', 'IGV', 'VXUS'],
  'World ETF': ['EWJ', 'EPOL', 'EFA', 'IEFA', 'EFV', 'IEMG', 'EWZ'],
  'Main Mega Cap': ['NFLX', 'GOOGL', 'GOOG', 'META', 'NVDA', 'AMZN', 'AAPL', 'AVGO', 'AMD', 'TSLA', 'CRM', 'MSFT'],
  'Technology': ['ACN', 'KEYS', 'JBL', 'INGM', 'CTSH', 'G', 'NOK', 'CLS', 'HPE', 'CSCO', 'COHR', 'IONQ', 'APH'],
  'Crypto': ['HODL', 'CORZ', 'IREN', 'IBIT'],
  'Semiconductors': ['SLAB', 'MCHP', 'VSH', 'NXPI', 'AMKR', 'MPWR', 'KLAC', 'UMC', 'MRVL', 'ON', 'INTC', 'CRDO', 'TXN', 'QCOM', 'AMAT'],
  'EV': ['GM', 'TSLA', 'F'],
  'Communication Services (XLC)': ['CNK', 'ROKU', 'NWSA', 'CMCSA', 'RCI', 'WBD', 'VZ'],
  'Travel': ['NCLH', 'CCL'],
  'Software': ['TENB', 'RELY', 'APPF', 'WEX', 'ADP', 'KVYO', 'SNOW', 'DT', 'GDDY', 'U', 'FTNT', 'PANW', 'ORCL', 'UBER', 'NOW', 'NBIS', 'PLTR'],
  'Insurance': ['STC', 'MFC', 'AON', 'UNM', 'OSCR'],
  'Biotech (XBI)': ['GPCR', 'APGE', 'HRMY', 'HALO', 'CRNX', 'EXEL', 'DYN', 'ROIV', 'MRNA'],
};

/** darkPoolTrackerV1.gs:118 -- a reasoned default (typical ATS share is ~12-15%), not backtested. */
export const DARK_POOL_ELEVATED_THRESHOLD_PCT = 0.20;
/** PropertiesService keys and TTL (hours) legacy used. */
export const FINRA_WEEK_KEY_PREFIX = 'darkPoolFinraWeek_';
export const EVALUATIVE_INDEX_KEY = 'evaluativeIndexV1';
export const RELATIVE_STRENGTH_KEY = 'relativeStrengthRankingV1';
export const DARK_POOL_CACHE_TTL_HOURS = 30;

/** The fields of a chart these computations read (a FetchedChart qualifies). */
export interface DarkPoolChart {
  readonly currentPrice?: number | null;
  readonly closes?: readonly number[] | null;
  readonly highs?: readonly number[] | null;
  readonly lows?: readonly number[] | null;
  readonly volumes?: readonly number[] | null;
}

export type DarkPoolLog = (message: string) => void;

export interface DarkPoolDeps extends FinraDeps {
  readonly kv: PropertyStore;
  /** fetchYahooChart. A throw counts as no chart, as in legacy. */
  readonly fetchChart: (ticker: string) => Promise<DarkPoolChart | null>;
  /** Logger.log. */
  readonly log?: DarkPoolLog;
}

const nowOf = (d: { readonly clock?: Clock }): number => (d.clock ? d.clock.now() : Date.now());
const errMsg = (e: any): unknown => (e && e.message ? e.message : e);

/** Every distinct watchlist ticker, in first-seen order (the union legacy builds three times). */
export function darkPoolUniverse(): string[] {
  const all: string[] = [];
  Object.keys(DARK_POOL_WATCHLIST).forEach((cat) => {
    DARK_POOL_WATCHLIST[cat].forEach((t) => { if (all.indexOf(t) === -1) all.push(t); });
  });
  return all;
}

async function chartOf(deps: Pick<DarkPoolDeps, 'fetchChart'>, t: string): Promise<DarkPoolChart | null> {
  try {
    return await deps.fetchChart(t);
  } catch {
    return null;
  }
}

/**
 * extractAtsWeeklyShareV1_ (:103-110): FINRA's precomputed per-symbol row
 * when present, else the per-venue rows summed; no rows at all is a real 0.
 */
export function extractAtsWeeklyShare(rows: readonly FinraAtsRow[] | null | undefined): number | null {
  if (!rows) return null;
  const agg = rows.find((r) => r.summaryTypeCode === 'ATS_W_SMBL');
  if (agg) return agg.totalWeeklyShareQuantity || 0;
  const firmRows = rows.filter((r) => r.summaryTypeCode === 'ATS_W_SMBL_FIRM');
  if (!firmRows.length) return 0;
  return firmRows.reduce((s, r) => s + (r.totalWeeklyShareQuantity || 0), 0);
}

export interface DarkPoolTickerInfo {
  atsShareVolume: number | null;
  tier: FinraTier | null;
  weekStartDate: string | null;
  price?: number | null;
  approxWeeklyTapeVolume?: number | null;
  darkPoolSharePct?: number | null;
  elevated?: boolean;
}

export interface DarkPoolRow extends DarkPoolTickerInfo {
  readonly ticker: string;
}

export interface DarkPoolReport {
  readonly generatedAt: Date;
  readonly t1Week: string | null;
  readonly t2Week: string | null;
  readonly categories: ReadonlyArray<{ readonly category: string; readonly rows: DarkPoolRow[] }>;
}

/**
 * buildDarkPoolTrackerReportV1_ (:128-184): the latest published week per
 * tier (cached 30 h for the per-ticker read), every ticker's Tier-1 rows,
 * Tier 2 for those Tier 1 had nothing for, and the share of the last five
 * daily volumes.
 */
export async function buildDarkPoolTrackerReport(deps: DarkPoolDeps, log: DarkPoolLog | null = deps.log ?? null): Promise<DarkPoolReport> {
  const t1Week = await findLatestPublishedFinraWeek(deps, 'T1');
  const t2Week = await findLatestPublishedFinraWeek(deps, 'T2');
  if (log) log('Dark Pool Tracker: latest published week — Tier1 ' + (t1Week || 'n/a') + ', Tier2 ' + (t2Week || 'n/a'));
  if (t1Week) await cacheSet(deps.kv, FINRA_WEEK_KEY_PREFIX + 'T1', t1Week, DARK_POOL_CACHE_TTL_HOURS, nowOf(deps));
  if (t2Week) await cacheSet(deps.kv, FINRA_WEEK_KEY_PREFIX + 'T2', t2Week, DARK_POOL_CACHE_TTL_HOURS, nowOf(deps));

  const allTickers = darkPoolUniverse();
  const t1Rows: Record<string, FinraAtsRow[] | null> = t1Week ? await fetchFinraAtsWeeklyBatch(deps, allTickers, 'T1', t1Week) : {};
  const needsT2 = allTickers.filter((t) => !t1Rows[t] || !(t1Rows[t] as FinraAtsRow[]).length);
  const t2Rows: Record<string, FinraAtsRow[] | null> = (t2Week && needsT2.length) ? await fetchFinraAtsWeeklyBatch(deps, needsT2, 'T2', t2Week) : {};

  const perTicker: Record<string, DarkPoolTickerInfo> = {};
  allTickers.forEach((t) => {
    const usedT1 = t1Rows[t] && (t1Rows[t] as FinraAtsRow[]).length;
    const rows = usedT1 ? t1Rows[t] : (t2Rows[t] || null);
    const tier: FinraTier | null = usedT1 ? 'T1' : (t2Rows[t] ? 'T2' : null);
    const week = tier === 'T1' ? t1Week : (tier === 'T2' ? t2Week : null);
    perTicker[t] = { atsShareVolume: rows ? extractAtsWeeklyShare(rows) : null, tier, weekStartDate: week };
  });

  for (const t of allTickers) {
    const info = perTicker[t];
    const chart = await chartOf(deps, t);
    info.price = chart ? (chart.currentPrice as number | null) : null;
    if (info.atsShareVolume == null || !chart || !chart.volumes || chart.volumes.length < 5) {
      info.approxWeeklyTapeVolume = null; info.darkPoolSharePct = null; info.elevated = false;
      continue;
    }
    const recentVol = chart.volumes.slice(-5).reduce((a, b) => a + b, 0);
    info.approxWeeklyTapeVolume = recentVol;
    info.darkPoolSharePct = recentVol > 0 ? (info.atsShareVolume / recentVol) : null;
    info.elevated = info.darkPoolSharePct != null && info.darkPoolSharePct > DARK_POOL_ELEVATED_THRESHOLD_PCT;
  }

  return {
    generatedAt: new Date(nowOf(deps)),
    t1Week, t2Week,
    categories: Object.keys(DARK_POOL_WATCHLIST).map((cat) => ({
      category: cat,
      rows: DARK_POOL_WATCHLIST[cat].map((t) => ({ ticker: t, ...(perTicker[t] || {}) }) as DarkPoolRow),
    })),
  };
}

/** getCachedFinraWeekV1_ (:197-199): null until the daily job has run. */
export async function getCachedFinraWeek(deps: Pick<DarkPoolDeps, 'kv' | 'clock'>, tierIdentifier: string): Promise<string | null | undefined> {
  return cacheGet<string>(deps.kv, FINRA_WEEK_KEY_PREFIX + tierIdentifier, nowOf(deps));
}

export interface DarkPoolShare {
  readonly tier: FinraTier | null;
  readonly weekStartDate: string | null;
  readonly atsShareVolume: number;
  readonly darkPoolSharePct: number | null;
  readonly elevated: boolean;
}

/**
 * getTickerDarkPoolShareV1_ (:204-234): the per-ticker read for the
 * analysis -- the cached weeks only (no probe walk), one FINRA query per
 * tier for this ticker, and the chart the analysis already has.
 */
export async function getTickerDarkPoolShare(
  deps: DarkPoolDeps, ticker: string, chart: DarkPoolChart | null | undefined, log: DarkPoolLog | null = deps.log ?? null,
): Promise<DarkPoolShare | null> {
  try {
    const t1Week = await getCachedFinraWeek(deps, 'T1');
    const t2Week = await getCachedFinraWeek(deps, 'T2');
    if (!t1Week && !t2Week) {
      if (log) log('Dark Pool: no cached FINRA week yet (daily trigger hasn\'t run) — skipped for ' + ticker);
      return null;
    }
    let rows: FinraAtsRow[] | null = null;
    let tier: FinraTier | null = null;
    let week: string | null = null;
    if (t1Week) {
      const t1Result = await fetchFinraAtsWeeklyBatch(deps, [ticker], 'T1', t1Week);
      if (t1Result[ticker] && (t1Result[ticker] as FinraAtsRow[]).length) { rows = t1Result[ticker]; tier = 'T1'; week = t1Week; }
    }
    if (!rows && t2Week) {
      const t2Result = await fetchFinraAtsWeeklyBatch(deps, [ticker], 'T2', t2Week);
      if (t2Result[ticker] && (t2Result[ticker] as FinraAtsRow[]).length) { rows = t2Result[ticker]; tier = 'T2'; week = t2Week; }
    }
    const atsShareVolume = rows ? extractAtsWeeklyShare(rows) : null;
    if (atsShareVolume == null || !chart || !chart.volumes || chart.volumes.length < 5) return null;
    const recentVol = chart.volumes.slice(-5).reduce((a, b) => a + b, 0);
    const darkPoolSharePct = recentVol > 0 ? (atsShareVolume / recentVol) : null;
    return {
      tier, weekStartDate: week, atsShareVolume,
      darkPoolSharePct,
      elevated: darkPoolSharePct != null && darkPoolSharePct > DARK_POOL_ELEVATED_THRESHOLD_PCT,
    };
  } catch (e) {
    if (log) log('Dark Pool: per-ticker read failed for ' + ticker + ' (non-fatal): ' + errMsg(e));
    return null;
  }
}

export interface EvaluativeIndex {
  readonly pctStrong: number | null;
  readonly strong: number;
  readonly weak: number;
  readonly unavailable: number;
  readonly total: number;
  readonly read: string;
  readonly asOfDate: Date | null;
}

/**
 * computeEvaluativeIndexV1_ (:336-360), Edwards & Magee ch. 38: the share of
 * the basket whose SMA50 is above its SMA200. <= 9% Strong reads OVERSOLD,
 * >= 91% OVERBOUGHT. Any unexpected error yields the all-zero 'unavailable'
 * result, as in legacy.
 */
export async function computeEvaluativeIndex(deps: Pick<DarkPoolDeps, 'fetchChart' | 'clock'>): Promise<EvaluativeIndex> {
  try {
    const tickers = darkPoolUniverse();
    let strong = 0, weak = 0, unavailable = 0;
    for (const t of tickers) {
      const chart = await chartOf(deps, t);
      if (!chart || !chart.closes || chart.closes.length < 200) { unavailable++; continue; }
      const closes = chart.closes;
      const sma = (n: number): number => closes.slice(-n).reduce((a, b) => a + b, 0) / n;
      if (sma(50) > sma(200)) strong++; else weak++;
    }
    const total = strong + weak;
    const pctStrong = total > 0 ? (strong / total * 100) : null;
    const read = pctStrong == null ? 'unavailable'
      : pctStrong <= 9 ? 'OVERSOLD (real historical Bottom-zone anchor)'
      : pctStrong >= 91 ? 'OVERBOUGHT (symmetric complement of the Bottom-zone anchor)'
      : 'neutral';
    return { pctStrong, strong, weak, unavailable, total: tickers.length, read, asOfDate: new Date(nowOf(deps)) };
  } catch {
    return { pctStrong: null, strong: 0, weak: 0, unavailable: 0, total: 0, read: 'unavailable', asOfDate: null };
  }
}

/** getCachedEvaluativeIndexV1_ (:377-379): cache-only. After the JSON round trip asOfDate is an ISO string. */
export async function getCachedEvaluativeIndex(deps: Pick<DarkPoolDeps, 'kv' | 'clock'>): Promise<unknown> {
  return cacheGet(deps.kv, EVALUATIVE_INDEX_KEY, nowOf(deps));
}

export interface ScoredPeer {
  readonly ticker: string;
  readonly score: number;
}

export interface RelativeStrengthRanking {
  readonly categories: string[];
  readonly peerCount: number;
  readonly rank: number;
  readonly percentile: number;
  readonly read: string;
  readonly topPeers: ScoredPeer[];
  readonly bottomPeers: ScoredPeer[];
}

/**
 * computeRelativeStrengthRankingV1_ (:428-467), the Turtle appendix's
 * "(price now - price N months ago) / N" across the ticker's categories:
 * a 3-month lookback, each peer's own 20-day Wilder N. Weakness is framed as
 * a caution only (the strategy is long-only). Null when the ticker is in no
 * category or has too little history; any error is null.
 */
/** Bars a ticker needs for the relative-strength score: 3 months of 21 trading days, plus 21 for the ATR. */
export const RELATIVE_STRENGTH_MIN_BARS = 3 * 21 + 21;

/**
 * Why computeRelativeStrengthRanking returned null for a ticker of the universe: its chart came back but is shorter
 * than the minimum (an expected gap, e.g. a new listing), or no chart at all (a real miss). Give it the RAW chart
 * fetch: the cached fetchChart answers null for a chart under 60 bars, so it cannot tell the two apart.
 */
export async function relativeStrengthMissKind(deps: Pick<DarkPoolDeps, 'fetchChart'>, ticker: string): Promise<'SHORT_HISTORY' | 'NO_DATA'> {
  const chart = await chartOf(deps, ticker);
  return chart && chart.closes && chart.closes.length > 0 && chart.closes.length < RELATIVE_STRENGTH_MIN_BARS ? 'SHORT_HISTORY' : 'NO_DATA';
}

export async function computeRelativeStrengthRanking(deps: Pick<DarkPoolDeps, 'fetchChart'>, ticker: string): Promise<RelativeStrengthRanking | null> {
  try {
    const categories = Object.keys(DARK_POOL_WATCHLIST).filter((cat) => DARK_POOL_WATCHLIST[cat].indexOf(ticker) > -1);
    if (!categories.length) return null;
    const peers: string[] = [];
    categories.forEach((cat) => DARK_POOL_WATCHLIST[cat].forEach((t) => { if (peers.indexOf(t) === -1) peers.push(t); }));
    const N_MONTHS = 3, TRADING_DAYS_PER_MONTH = 21;
    const scored: ScoredPeer[] = [];
    for (const t of peers) {
      const chart = await chartOf(deps, t);
      if (!chart || !chart.closes || chart.closes.length < RELATIVE_STRENGTH_MIN_BARS) continue;
      const closes = chart.closes, highs = chart.highs as readonly number[], lows = chart.lows as readonly number[], n = closes.length;
      const idxAgo = n - 1 - N_MONTHS * TRADING_DAYS_PER_MONTH;
      const priceAgo = closes[idxAgo];
      if (priceAgo == null) continue;
      const trArr: number[] = [];
      for (let i = 1; i < n; i++) trArr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
      const peerN = wilderSmooth(trArr, 20) || 0.0001;
      scored.push({ ticker: t, score: (closes[n - 1] - priceAgo) / peerN });
    }
    if (!scored.some((s) => s.ticker === ticker)) return null;
    scored.sort((a, b) => b.score - a.score);
    const rank = scored.findIndex((s) => s.ticker === ticker) + 1;
    const total = scored.length;
    const percentile = Math.round((1 - (rank - 1) / total) * 100);
    const read = percentile >= 80 ? 'STRONG -- among the strongest in its real peer group'
      : percentile <= 20 ? 'WEAK -- among the weakest in its real peer group (a real caution, not a short signal -- this project is long-only/calls-only)'
      : 'middling within its real peer group';
    return { categories, peerCount: total, rank, percentile, read, topPeers: scored.slice(0, 3), bottomPeers: scored.slice(-3).reverse() };
  } catch {
    return null;
  }
}

/** getCachedRelativeStrengthRankingV1_ (:498-501): one ticker out of the cached map; null when absent. */
export async function getCachedRelativeStrengthRanking(deps: Pick<DarkPoolDeps, 'kv' | 'clock'>, ticker: string): Promise<RelativeStrengthRanking | null> {
  const map = await cacheGet<Record<string, RelativeStrengthRanking>>(deps.kv, RELATIVE_STRENGTH_KEY, nowOf(deps));
  return (map && map[ticker]) ? map[ticker] : null;
}
