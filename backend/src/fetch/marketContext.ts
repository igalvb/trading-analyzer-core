/**
 * Market context attached to a ticker's chart before analysis: sector
 * relative strength and relative swing power, SPY alignment, and the VIX
 * read. Ports the block inside runAnalysisV7 at
 * fullStockAnalysisV10_9.gs:993-1140 exactly, including its log lines,
 * which tests compare byte for byte.
 *
 * Kept from legacy on purpose:
 *  - the sector and VIX fetches are each wrapped in try/catch, but the SPY
 *    fetch is NOT (F-34) -- a throw there propagates to the caller;
 *  - when the VIX quote has no price, the context object is attached BEFORE
 *    the final log line throws, and that throw is caught, so a partial
 *    vixContext survives.
 */

import type { FetchedChart } from '../types/chart.ts';
import type { StepStateValue } from '../core/status.ts';
import type { ReasonCode } from '../reports/messages/catalog.ts';
import { slope } from '../analysis/series.ts';
import { vixRegimeReadV1, type VixRegimeRead } from '../analysis/models/brokerCourse/vixSqueeze.ts';

/** fullStockAnalysisV10_9.gs:994-999, verbatim. */
export const SECTOR_ETF: Readonly<Record<string, string>> = {
  'Technology': 'XLK', 'Financial Services': 'XLF', 'Financial': 'XLF',
  'Energy': 'XLE', 'Healthcare': 'XLV', 'Industrials': 'XLI', 'Industrial Goods': 'XLI',
  'Consumer Cyclical': 'XLY', 'Consumer Defensive': 'XLP', 'Utilities': 'XLU',
  'Basic Materials': 'XLB', 'Real Estate': 'XLRE', 'Communication Services': 'XLC',
};

const RSP_LOOKBACK = 63;

export interface SectorRS {
  readonly etf: string;
  readonly sector: string;
  readonly rs63: number;
  readonly outperforming: boolean;
}

export interface RelativeSwingPower {
  readonly ratio: number;
  readonly etf: string;
  readonly sector: string;
}

export interface VixDivergence5d {
  readonly vixSlope5: number;
  readonly spyChange5pct: number;
  readonly flagged: boolean;
  readonly note: string | null;
}

export interface VixContext {
  level: number;
  high52: number;
  low52: number;
  rangePct: number;
  read: 'calm' | 'normal' | 'elevated' | 'fear/crisis';
  courseRead?: VixRegimeRead;
  divergence5d?: VixDivergence5d;
}

/**
 * The chart with whatever context could be attached. `benchmarkCloses` may
 * hold leading nulls (chart dates before SPY's first matching date) -- the
 * legacy alignment forward-fills from null.
 */
export type MarketContextChart = FetchedChart & {
  sectorRS?: SectorRS;
  relativeSwingPower?: RelativeSwingPower;
  benchmarkCloses?: Array<number | null>;
  vixContext?: VixContext;
};

export interface MarketContextDeps {
  /** fetchYahooChart, bound to its store and HTTP client. */
  readonly fetchChart: (ticker: string) => Promise<FetchedChart | null>;
  readonly log?: (msg: string) => void;
  /** setStatusV7(status, key, state, detail). */
  readonly setStatus?: (key: string, state: StepStateValue, detail: string, reasonCode?: ReasonCode) => void;
}

/** :1006-1013 and :1061-1067 -- the benchmark's close on each chart date (UTC), forward-filled. */
export function alignToChartDates(chartDates: readonly Date[], bench: Pick<FetchedChart, 'dates' | 'closes'>): Array<number | null> {
  const byDate: Record<string, number> = {};
  bench.dates.forEach((d, i) => {
    byDate[d.toISOString().slice(0, 10)] = bench.closes[i];
  });
  let last: number | null = null;
  return chartDates.map((d) => {
    const key = d.toISOString().slice(0, 10);
    if (byDate[key] != null) last = byDate[key];
    return last;
  });
}

/** :1015-1021 -- 63-bar change of the ticker/ETF ratio, in percent. */
export function computeSectorRS(closes: readonly number[], aligned: ReadonlyArray<number | null>, etf: string, sector: string): SectorRS | null {
  const ratio = closes.map((v, i) => (aligned[i] ? v / (aligned[i] as number) : null)).filter((v) => v != null) as number[];
  const rn = ratio.length;
  if (rn > 63) {
    const rs63 = (ratio[rn - 1] / ratio[rn - 64] - 1) * 100;
    return { etf, sector, rs63, outperforming: rs63 > 0 };
  }
  return null;
}

/** :1035-1041, legacy's inline stdevPctV1: population stdev of simple returns. */
export function stdevPct(arr: readonly number[] | null | undefined): number | null {
  if (!arr || arr.length < 2) return null;
  const rets = arr.slice(1).map((v, i) => (v - arr[i]) / arr[i]);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / rets.length;
  return Math.sqrt(variance);
}

/** :1042-1047 -- the ticker's 63-day return volatility relative to its sector ETF's. */
export function computeRelativeSwingPower(closes: readonly number[], sectorCloses: readonly number[], etf: string, sector: string): RelativeSwingPower | null {
  const tickerStdev = stdevPct(closes.slice(-RSP_LOOKBACK - 1));
  const sectorStdev = stdevPct(sectorCloses.slice(-RSP_LOOKBACK - 1));
  if (tickerStdev != null && sectorStdev != null && sectorStdev > 0) return { ratio: tickerStdev / sectorStdev, etf, sector };
  return null;
}

/** fullStockAnalysisV10_9.gs:993-1140. Returns a new object; `chart` is not mutated. */
export async function attachMarketContext(
  chart: FetchedChart,
  fund: { readonly sector?: string | null } | null | undefined,
  deps: MarketContextDeps,
): Promise<MarketContextChart> {
  const log = deps.log ?? ((): void => {});
  const out: MarketContextChart = { ...chart };

  if (fund && fund.sector) {
    const sectorEtf = SECTOR_ETF[fund.sector];
    if (sectorEtf) {
      log('📡 Fetching ' + sectorEtf + ' for sector-relative strength (' + fund.sector + ')...');
      try {
        const sectorChart = await deps.fetchChart(sectorEtf);
        if (sectorChart) {
          const aligned = alignToChartDates(chart.dates, sectorChart);
          const rs = computeSectorRS(chart.closes, aligned, sectorEtf, fund.sector);
          if (rs) {
            out.sectorRS = rs;
            log('✅ Sector RS vs ' + sectorEtf + ': ' + (rs.rs63 >= 0 ? '+' : '') + rs.rs63.toFixed(1) + '%');
          }
          try {
            const rsp = computeRelativeSwingPower(chart.closes, sectorChart.closes, sectorEtf, fund.sector);
            if (rsp) out.relativeSwingPower = rsp;
          } catch {
            /* non-fatal, as in legacy */
          }
        }
      } catch (e) {
        log('⚠️ Sector ETF fetch error: ' + (e as Error).message.substring(0, 60));
      }
    } else {
      log('ℹ️ No sector ETF mapping for "' + fund.sector + '" — sector-relative strength skipped');
    }
  }

  // :1056-1073. Deliberately unguarded, as in legacy (F-34).
  log('📡 Fetching SPY for relative strength...');
  const spy = await deps.fetchChart('SPY');
  if (spy) {
    out.benchmarkCloses = alignToChartDates(chart.dates, spy);
    deps.setStatus?.('spyRS', 'ok', spy.closes.length + ' days aligned');
    log('✅ SPY aligned (' + spy.closes.length + ' days)');
  } else {
    deps.setStatus?.('spyRS', 'degraded', 'SPY fetch failed — technical score computed WITHOUT Relative Strength', 'PROVIDER_NO_RESPONSE');
    log('⚠️ SPY fetch failed — relative strength skipped');
  }

  // :1075-1140
  log('📡 Fetching VIX for market volatility context...');
  try {
    const vix = await deps.fetchChart('^VIX');
    if (vix && vix.closes.length) {
      const vixNow = vix.currentPrice;
      const vixHigh52 = Math.max(...vix.closes.slice(-252));
      const vixLow52 = Math.min(...vix.closes.slice(-252));
      const vixRangePct = vixHigh52 > vixLow52 ? (vixNow - vixLow52) / (vixHigh52 - vixLow52) * 100 : 50;
      const ctx: VixContext = {
        level: vixNow,
        high52: vixHigh52,
        low52: vixLow52,
        rangePct: vixRangePct,
        read: vixNow < 15 ? 'calm' : vixNow < 20 ? 'normal' : vixNow < 30 ? 'elevated' : 'fear/crisis',
      };
      out.vixContext = ctx;
      const courseVix = vixRegimeReadV1(vixNow);
      if (courseVix) ctx.courseRead = courseVix;
      if (spy && spy.closes && spy.closes.length >= 5 && vix.closes.length >= 5) {
        const vixSlope5 = slope(vix.closes, 5);
        const spyLast5 = spy.closes.slice(-5);
        const spyChange5 = (spyLast5[spyLast5.length - 1] - spyLast5[0]) / spyLast5[0] * 100;
        const divergence = vixSlope5 > 0 && Math.abs(spyChange5) < 1;
        ctx.divergence5d = {
          vixSlope5,
          spyChange5pct: spyChange5,
          flagged: divergence,
          note: divergence ? '⚠ VIX rising while S&P is flat (5d) — early bearish divergence' : null,
        };
        if (divergence) log('⚠️ VIX/price divergence flagged (5d)');
      }
      log('✅ VIX: ' + vixNow.toFixed(2) + ' (' + ctx.read + ')');
    } else {
      log('⚠️ VIX fetch failed — market volatility context skipped');
    }
  } catch (e) {
    log('⚠️ VIX fetch error: ' + (e as Error).message.substring(0, 60));
  }

  return out;
}
