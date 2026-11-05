/**
 * The fundamental ("OWN") score and its helpers, ported exactly from
 * fullStockAnalysisV10_9.gs:1635-1898:
 *   sectorProfileV7 :1635-1641   floatTierV7 :1648-1654
 *   trendStatsV7 :1686-1715      percentileRankV7 :1720-1725
 *   computeFundamentalScoreV7 :1731-1898
 * (seriesLatestV7 / seriesArrayV7, :1658-1681, are in fetch/finnhubSeries.ts.)
 *
 * ZERO price input. Eight components, each a -1..+1 signal weighted by
 * sector profile; a missing metric drops its component (its weight leaves
 * the average) rather than defaulting it.
 *
 * The one structural change: legacy fetched each peer's metrics INSIDE the
 * score (:1819, fetchPeerBasicMetricsV7). Here the caller fetches them first
 * -- peerSymbolsForScore(fund) names exactly the symbols legacy would
 * fetch, in order, and fetch/fundamentals/v7.ts fetchPeerMetricsFor fetches
 * them -- and passes the results in. The score itself is pure.
 */

import { seriesLatest, seriesArray, type FinnhubMetricSeries, type SeriesPoint } from '../fetch/finnhubSeries.ts';
import type { CrossRefCV, PeerBasicMetrics } from '../types/fundamentals.ts';

export type SectorProfile = 'TECH_GROWTH' | 'DEFAULT';

/** The fields the score reads. A live v7 record and a cached one both fit. */
export interface FundamentalScoreInput {
  readonly sector?: string | null;
  readonly industry?: string | null;
  readonly marketCap?: number | null;
  readonly profitMargins?: number | null;
  readonly revenueGrowth?: number | null;
  readonly returnOnEquity?: number | null;
  readonly targetMean?: number | null;
  readonly price?: number | null;
  readonly recMean?: number | null;
  readonly recKey?: string | null;
  readonly forwardPE?: number | null;
  readonly trailingPE?: number | null;
  readonly pegRatio?: number | null;
  readonly _metricSeries?: FinnhubMetricSeries | null;
  readonly _peersRaw?: readonly string[] | null;
  readonly _crossRefCV?: Readonly<Record<string, CrossRefCV>> | null;
}

export interface FundamentalDriver {
  readonly label: string;
  readonly value: string;
  readonly points: number;
  readonly note: string;
}

export interface PeerTableRow {
  readonly ticker: string;
  readonly evSales: number | null;
  readonly revGrowth: number | null;
  readonly margin: number | null;
}

export interface FundamentalScore {
  readonly score: number | null;
  readonly verdict: string;
  readonly profile: SectorProfile | null;
  readonly drivers: FundamentalDriver[];
  readonly peerTable: PeerTableRow[];
  readonly pricedForPerfection: boolean;
  readonly evSales: number | null;
}

export interface TrendStats {
  readonly latest: number;
  readonly prev: number | null;
  readonly yoy: number | null;
  readonly slopeSign: number;
  readonly accel: number;
  readonly pointCount: number;
}

/** sectorProfileV7 (:1635-1641): TECH_GROWTH unless the AAPL gate (big + profitable) fires. */
export function sectorProfile(fund: FundamentalScoreInput | null | undefined): SectorProfile {
  const s = ((fund && (fund.sector || fund.industry)) || '').toString();
  const isTechLike = /tech|software|internet|semiconduct|communication|cloud|data|platform/i.test(s);
  if (!isTechLike) return 'DEFAULT';
  // A null marketCap/profitMargins compares false, as in legacy.
  if (fund && (fund.marketCap as number) > 200e9 && (fund.profitMargins as number) > 0.15) return 'DEFAULT';
  return 'TECH_GROWTH';
}

/** floatTierV7 (:1648-1654): the broker course's float bands. Display only. */
export function floatTier(floatShares: number | null | undefined): string | null {
  if (floatShares == null || isNaN(floatShares)) return null;
  if (floatShares < 10e6) return 'Extreme (float <10M)';
  if (floatShares < 30e6) return 'Super volatile (float <30M)';
  if (floatShares < 50e6) return 'Very volatile (float <50M)';
  return 'Normal float';
}

/**
 * trendStatsV7 (:1686-1715): winsorise at ~3 MAD, then the sign of the
 * least-squares slope and of the second-half-vs-first-half change.
 * latest/prev/yoy are the RAW values.
 */
export function trendStats(arr: readonly SeriesPoint[] | null | undefined): TrendStats | null {
  if (!arr || arr.length === 0) return null;
  const vals = arr.map((p) => p.v as number);
  const latest = vals[0], prev = vals.length > 1 ? vals[1] : null;
  const yoy = vals.length > 4 ? vals[4] : null;
  const median = (a: number[]): number => {
    const s = a.slice().sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const med = median(vals);
  const mad = median(vals.map((v) => Math.abs(v - med))) || 1e-9;
  const clipHi = med + 3 * mad * 1.4826, clipLo = med - 3 * mad * 1.4826;
  const clipped = vals.map((v) => (v > clipHi ? clipHi : v < clipLo ? clipLo : v));
  const chrono = clipped.slice().reverse();
  const n = chrono.length;
  let slopeSign = 0;
  if (n >= 2) {
    const xs = chrono.map((_, i) => i);
    const xMean = xs.reduce((a, b) => a + b, 0) / n, yMean = chrono.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - xMean) * (chrono[i] - yMean); den += (xs[i] - xMean) ** 2; }
    const slopeVal = den === 0 ? 0 : num / den;
    slopeSign = slopeVal > 1e-6 ? 1 : slopeVal < -1e-6 ? -1 : 0;
  }
  let accel = 0;
  if (n >= 4) {
    const half = Math.floor(n / 2);
    const avg = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
    const d1 = avg(chrono.slice(0, half)), d2 = avg(chrono.slice(half));
    accel = d2 > d1 + 1e-6 ? 1 : d2 < d1 - 1e-6 ? -1 : 0;
  }
  return { latest, prev, yoy, slopeSign, accel, pointCount: arr.length };
}

/** percentileRankV7 (:1720-1725): % of peers `value` beats (higherBetter false: by being lower). */
export function percentileRank(value: number | null | undefined, peerValues: ReadonlyArray<number | null> | null | undefined, higherBetter: boolean): number | null {
  const clean = (peerValues || []).filter((v) => v != null && !isNaN(v)) as number[];
  if (value == null || isNaN(value)) return null;
  if (clean.length === 0) return null;
  const x = value;
  const beat = clean.filter((v) => (higherBetter ? x >= v : x <= v)).length;
  return Math.round((beat / clean.length) * 100);
}

/**
 * The peers legacy fetches inside the score (:1813-1819): only when an
 * EV/Sales exists and there are 2+ peers. In order, duplicates kept.
 */
export function peerSymbolsForScore(fund: FundamentalScoreInput | null | undefined): string[] {
  if (!fund) return [];
  const evSales = seriesLatest(fund._metricSeries, 'evRevenueTTM', null, null);
  if (evSales == null) return [];
  if (!(fund._peersRaw && fund._peersRaw.length >= 2)) return [];
  return [...fund._peersRaw];
}

/**
 * computeFundamentalScoreV7 (:1731-1898). `peerMetrics` holds what
 * fetchPeerBasicMetricsV7 returned for each symbol of peerSymbolsForScore;
 * a missing or null entry is a peer that failed, exactly as in legacy.
 */
export function computeFundamentalScore(
  fund: FundamentalScoreInput | null | undefined,
  peerMetrics: ReadonlyMap<string, PeerBasicMetrics | null> = new Map(),
): FundamentalScore {
  if (!fund) return { score: null, verdict: 'N/A', profile: null, drivers: [], peerTable: [], pricedForPerfection: false, evSales: null };

  const profile = sectorProfile(fund);
  const isTech = profile === 'TECH_GROWTH';
  const W: Record<string, number> = isTech
    ? { growth: 0.22, margin: 0.16, r40: 0.18, quality: 0.10, valuation: 0.16, balance: 0.06, analyst: 0.06, pe: 0.06 }
    : { growth: 0.14, margin: 0.12, r40: 0.08, quality: 0.20, valuation: 0.16, balance: 0.06, analyst: 0.12, pe: 0.12 };

  const drivers: FundamentalDriver[] = [];
  let wSum = 0, wTot = 0;
  function add(key: string, label: string, sig: number | null, value: string, note: string): void {
    if (sig == null) return;
    sig = Math.max(-1, Math.min(1, sig));
    const w = W[key];
    wSum += sig * w; wTot += w;
    drivers.push({ label, value, points: Math.round(sig * w * 1000) / 1000, note });
  }

  const series = fund._metricSeries;

  const revStats = trendStats(seriesArray(series, 'salesPerShare', 8));
  if (revStats) {
    const sig = revStats.slopeSign * 0.6 + revStats.accel * 0.4;
    const yoyTxt = (revStats.yoy != null && revStats.yoy !== 0) ? (((revStats.latest - revStats.yoy) / Math.abs(revStats.yoy)) * 100).toFixed(0) + '% YoY, ' : '';
    add('growth', 'Revenue/share trend', sig, yoyTxt + 'rev/share ' + (revStats.slopeSign > 0 ? 'rising' : revStats.slopeSign < 0 ? 'falling' : 'flat'),
      revStats.pointCount < 4 ? 'limited history (' + revStats.pointCount + 'q) — reduced confidence' : 'trend across ' + revStats.pointCount + ' quarters — NOTE: this is revenue-per-share trend, not the same figure as flat revenue growth %');
  } else if (fund.revenueGrowth != null) {
    const rg = fund.revenueGrowth;
    const sig = rg > 0.20 ? 1 : rg > 0.10 ? 0.5 : rg > 0 ? 0 : rg > -0.10 ? -0.5 : -1;
    add('growth', 'Revenue growth (level)', sig, (rg >= 0 ? '+' : '') + (rg * 100).toFixed(1) + '% rev growth', 'no series data — level only, not a trend');
  }

  const nmStats = trendStats(seriesArray(series, 'netMargin', 8));
  const gmStats = !nmStats ? trendStats(seriesArray(series, 'grossMargin', 8)) : null;
  const marginStats = nmStats || gmStats;
  if (marginStats) {
    const sig = marginStats.slopeSign * 0.7 + marginStats.accel * 0.3;
    const isLoss = marginStats.latest < 0;
    const marginNote = isLoss
      ? (marginStats.slopeSign > 0 ? 'losses narrowing — sign-aware scoring credits this even though still unprofitable'
        : marginStats.slopeSign < 0 ? 'losses widening — a real concern' : 'losses roughly flat')
      : (marginStats.slopeSign > 0 ? 'already profitable, and the margin is improving further'
        : marginStats.slopeSign < 0 ? 'still profitable, but the margin is compressing' : 'profitable, margin trend is flat');
    add('margin', 'Margin trajectory', sig, (marginStats.latest * 100).toFixed(1) + '% ' + (nmStats ? 'net' : 'gross') + ' margin, ' + (marginStats.slopeSign > 0 ? 'improving' : marginStats.slopeSign < 0 ? 'worsening' : 'flat'),
      marginNote);
  }

  const fcfMargin = seriesLatest(series, 'fcfMargin', null, null);
  if (fund.revenueGrowth != null && fcfMargin != null) {
    const r40 = fund.revenueGrowth * 100 + fcfMargin * 100;
    const sig = r40 >= 40 ? 1 : r40 >= 20 ? 0.3 : -0.5;
    add('r40', 'Rule of 40', sig, r40.toFixed(1) + ' (growth ' + (fund.revenueGrowth * 100).toFixed(0) + ' + FCF ' + (fcfMargin * 100).toFixed(0) + ')', r40 >= 40 ? 'strong' : r40 >= 20 ? 'ok' : 'weak');
  }

  if (fund.returnOnEquity != null || fund.profitMargins != null) {
    let sig = 0, n = 0;
    if (fund.returnOnEquity != null) { const roe = fund.returnOnEquity * 100; sig += roe > 20 ? 1 : roe > 10 ? 0.5 : roe > 0 ? 0 : -0.5; n++; }
    if (fund.profitMargins != null) { const pm = fund.profitMargins * 100; sig += pm > 15 ? 1 : pm > 5 ? 0.5 : pm > 0 ? 0 : -0.5; n++; }
    add('quality', 'Profitability/quality', n ? sig / n : null,
      (fund.returnOnEquity != null ? 'ROE ' + (fund.returnOnEquity * 100).toFixed(1) + '%  ' : '') + (fund.profitMargins != null ? 'NM ' + (fund.profitMargins * 100).toFixed(1) + '%' : ''),
      'current-level read (not a trend)');
  }

  const evSales = seriesLatest(series, 'evRevenueTTM', null, null);
  let peerTable: PeerTableRow[] = [];
  let pricedForPerfection = false;
  if (evSales != null) {
    let usedPeers = false;
    if (fund._peersRaw && fund._peersRaw.length >= 2) {
      const metricsBySym = new Map<string, PeerBasicMetrics>();
      fund._peersRaw.forEach((sym) => {
        const m = peerMetrics.get(sym) ?? null;
        if (m) metricsBySym.set(sym, m);
      });
      const all = [...metricsBySym.values()];
      const evPeers = all.map((m) => m.evSales).filter((v) => v != null);
      peerTable = [...metricsBySym.keys()].map((sym) => {
        const m = metricsBySym.get(sym) as PeerBasicMetrics;
        return { ticker: sym, evSales: m.evSales, revGrowth: m.revenueGrowth, margin: m.fcfMargin != null ? m.fcfMargin : m.netMargin };
      });
      if (evPeers.length >= 2) {
        usedPeers = true;
        const cheaperThanPct = percentileRank(evSales, evPeers, false) as number;
        const sig = cheaperThanPct >= 66 ? 1 : cheaperThanPct >= 33 ? 0 : -0.5;
        const valPhrase = cheaperThanPct <= 0 ? 'more expensive than all ' + evPeers.length + ' peers sampled'
          : cheaperThanPct >= 100 ? 'cheaper than all ' + evPeers.length + ' peers sampled'
            : 'cheaper than ' + cheaperThanPct + '% of ' + evPeers.length + ' peers';
        add('valuation', 'Valuation vs peers', sig, evSales.toFixed(1) + 'x EV/Sales, ' + valPhrase, 'peer-relative');
        const growthVals = all.map((m) => m.revenueGrowth).filter((v) => v != null);
        const qualityPct = (fund.revenueGrowth != null && growthVals.length >= 2) ? percentileRank(fund.revenueGrowth, growthVals, true) : null;
        pricedForPerfection = (qualityPct != null && qualityPct >= 75 && (100 - cheaperThanPct) >= 75);
      }
    }
    if (!usedPeers) {
      const sig = evSales < 5 ? 0.5 : evSales <= 15 ? 0 : -0.5;
      add('valuation', 'Valuation vs peers', sig, evSales.toFixed(1) + 'x EV/Sales (absolute bands — insufficient peer data)', evSales < 5 ? 'cheap' : evSales <= 15 ? 'fair' : 'expensive');
    }
  }

  if (fund.profitMargins != null && fund.profitMargins < 0) {
    const cashPS = seriesLatest(series, 'cashPerShareTTM', null, null);
    const fcfPS = seriesLatest(series, 'fcfPerShareTTM', null, null);
    if (cashPS != null && fcfPS != null && fcfPS < 0) {
      const quarterlyBurn = Math.abs(fcfPS) / 4;
      if (quarterlyBurn > 0) {
        const runwayMonths = Math.round((cashPS / quarterlyBurn) * 3);
        const sig = runwayMonths >= 24 ? 1 : runwayMonths >= 12 ? 0.3 : runwayMonths >= 6 ? -0.3 : -1;
        add('balance', 'Balance-sheet durability', sig, runwayMonths + ' months runway (est.)', runwayMonths < 12 ? '⚠ RISK: thin runway' : 'adequate runway');
      }
    }
  }

  if (fund.targetMean != null && fund.price) {
    const upside = (fund.targetMean / fund.price - 1) * 100;
    let sig = upside > 20 ? 1 : upside > 5 ? 0.5 : upside > -5 ? 0 : -1, n = 1;
    if (fund.recMean != null) { const rm = fund.recMean; sig = (sig + (rm < 2 ? 1 : rm < 2.5 ? 0.5 : rm < 3.5 ? 0 : -1)) / 2; n = 2; }
    add('analyst', 'Analyst view', sig, (upside >= 0 ? '+' : '') + upside.toFixed(1) + '% to target' + (fund.recKey ? ', ' + fund.recKey : ''), n === 2 ? 'target+rating blended' : 'target only');
  } else if (fund.recMean != null) {
    const rm = fund.recMean;
    add('analyst', 'Analyst view', rm < 2 ? 1 : rm < 2.5 ? 0.5 : rm < 3.5 ? 0 : -1, fund.recKey || 'N/A', 'rating only (no target price)');
  }

  const peValue = fund.forwardPE != null ? fund.forwardPE : fund.trailingPE;
  const peIsForward = fund.forwardPE != null;
  if (peValue != null && peValue > 0) {
    let sig = peValue < 15 ? 1 : peValue > 40 ? -1 : peValue < 25 ? 0.5 : -0.3, n = 1;
    if (fund.pegRatio != null && fund.pegRatio > 0) { sig = (sig + (fund.pegRatio < 1 ? 1 : fund.pegRatio > 2 ? -1 : 0.3)) / 2; n = 2; }
    const cvKey = peIsForward ? 'forwardPE' : 'trailingPE';
    const cvInfo = fund._crossRefCV && fund._crossRefCV[cvKey];
    const confidenceNote = (cvInfo && cvInfo.band === 'untrustworthy') ? '  ⚠ sources disagree substantially on this (CV=' + cvInfo.cv.toFixed(2) + ') — treat with caution'
      : (cvInfo && cvInfo.band === 'shaky') ? '  ⚠ some cross-source disagreement (CV=' + cvInfo.cv.toFixed(2) + ')'
        : '';
    add('pe', 'P/E & PEG', sig, peValue.toFixed(1) + 'x ' + (peIsForward ? 'Forward' : 'Trailing') + ' P/E' + (fund.pegRatio ? '  ' + fund.pegRatio.toFixed(2) + 'x PEG' : ''), (n === 2 ? (peIsForward ? 'Forward P/E' : 'Trailing P/E') + '+PEG blended' : (peIsForward ? 'Forward' : 'Trailing') + ' P/E only') + confidenceNote);
  }

  const score = wTot > 0 ? Math.round(((wSum / wTot) + 1) / 2 * 100) : null;
  const verdict = score == null ? 'N/A' : score >= 70 ? '🟢 Own-worthy' : score >= 57 ? '🟡 Decent' : score >= 43 ? '⚪ Mixed' : score >= 30 ? '🟠 Weak' : '🔴 Avoid';

  return { score, verdict, profile, drivers, peerTable, pricedForPerfection, evSales };
}
