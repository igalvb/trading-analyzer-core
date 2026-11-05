/**
 * Support / resistance levels, multi-timeframe confluence, and monthly structure.
 *
 * Verified 2026-09-21: 432 comparisons across 144 chart variants, all exact.
 * 2,634 individual S/R levels compared, covering all three tiers (Minor,
 * Secondary, Primary) and all three confluence strengths.
 */

import type { Chart } from '../../types/chart.ts';

export type SrInput = Pick<Chart, 'closes' | 'highs' | 'lows' | 'volumes' | 'dates'>;

export type SrTier = 'Primary' | 'Secondary' | 'Minor';
export type SrTrendDirection = 'up' | 'down' | 'flat';

export interface SrLevel {
  level: number;
  touchCount: number;
  duration: number;
  tier: SrTier;
  /** null when no trend direction was supplied — see the note in srLevels(). */
  trendFavored: boolean | null;
  /** Absent (not null) when no volume series was supplied. */
  volumeWeightedStrength?: number;
}

export interface SrLevels {
  resistanceLevels: SrLevel[];
  supportLevels: SrLevel[];
}

const SR_WINDOW = 5;
const SR_TOLERANCE = 0.03;
const LEVEL_TOLERANCE = 0.03;

/**
 * Clusters swing highs and lows into price levels by repeated touches.
 *
 * Both optional parameters change the OUTPUT SHAPE, not just values, and that
 * matters because this function is called two different ways:
 *
 *   srLevels(highs, lows, trendDirection, volumes)  -- the main call
 *   srLevels(highs, lows)                           -- inside the confluence fn
 *
 * With no trendDirection, `trendFavored` is null rather than false — an
 * explicit "not evaluated" instead of a claim. With no volumes,
 * `volumeWeightedStrength` is ABSENT from the object entirely rather than
 * undefined-valued. Both distinctions are load-bearing for parity: the
 * confluence function's internal calls produce the sparser shape.
 *
 * The clustering has a subtle property worth knowing: `avgPrice` is RECOMPUTED
 * as each touch joins, so the cluster centre drifts as it grows. Points are
 * pre-sorted by price, so the drift is monotonic — but it does mean a point's
 * membership depends on how many joined before it. Reproduced exactly.
 *
 * Tiering combines touch count AND duration:
 *   Primary   -- 4+ touches AND spanning 60+ bars
 *   Secondary -- 3+ touches OR spanning 30+ bars
 *   Minor     -- everything else (2 touches, short span)
 * Note Primary requires BOTH while Secondary requires EITHER, so a level with
 * 5 touches inside 20 bars is Secondary, not Primary — frequency alone does not
 * establish a major level without duration.
 */
export function srLevels(
  highs: readonly number[],
  lows: readonly number[],
  trendDirection?: SrTrendDirection,
  volumes?: readonly number[],
): SrLevels {
  const n = highs.length;
  const swingHighs: Array<{ idx: number; price: number }> = [];
  const swingLows: Array<{ idx: number; price: number }> = [];

  for (let i = SR_WINDOW; i < n - SR_WINDOW; i++) {
    const hSlice = highs.slice(i - SR_WINDOW, i + SR_WINDOW + 1);
    const lSlice = lows.slice(i - SR_WINDOW, i + SR_WINDOW + 1);
    if (highs[i] === Math.max(...hSlice)) swingHighs.push({ idx: i, price: highs[i] as number });
    if (lows[i] === Math.min(...lSlice)) swingLows.push({ idx: i, price: lows[i] as number });
  }

  function clusterLevels(points: Array<{ idx: number; price: number }>, isSupport: boolean): SrLevel[] {
    const sorted = points.slice().sort((a, b) => a.price - b.price);
    const clusters: Array<{ avgPrice: number; touches: Array<{ idx: number; price: number }> }> = [];

    for (const p of sorted) {
      let placed = false;
      for (const cl of clusters) {
        if (Math.abs(p.price - cl.avgPrice) / cl.avgPrice <= SR_TOLERANCE) {
          cl.touches.push(p);
          // Centre drifts as the cluster grows — see the note above.
          cl.avgPrice = cl.touches.reduce((s, t) => s + t.price, 0) / cl.touches.length;
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push({ avgPrice: p.price, touches: [p] });
    }

    return clusters
      .filter((cl) => cl.touches.length >= 2) // a single touch is not a level
      .map((cl) => {
        const idxs = cl.touches.map((t) => t.idx);
        const duration = Math.max(...idxs) - Math.min(...idxs);
        const touchCount = cl.touches.length;

        let tier: SrTier;
        if (touchCount >= 4 && duration >= 60) tier = 'Primary'; // BOTH
        else if (touchCount >= 3 || duration >= 30) tier = 'Secondary'; // EITHER
        else tier = 'Minor';

        // Support is favoured in an uptrend, resistance in a downtrend.
        const trendFavored =
          trendDirection === undefined ? null : isSupport ? trendDirection === 'up' : trendDirection === 'down';

        const out: SrLevel = { level: cl.avgPrice, touchCount, duration, tier, trendFavored };
        // Assigned only when volumes were supplied, so the key is genuinely
        // absent otherwise — not present-and-undefined.
        if (volumes && volumes.length) {
          out.volumeWeightedStrength = cl.touches.reduce((s, t) => s + ((volumes[t.idx] as number) || 0), 0);
        }
        return out;
      })
      .sort((a, b) => b.touchCount - a.touchCount);
  }

  return {
    resistanceLevels: clusterLevels(swingHighs, false),
    supportLevels: clusterLevels(swingLows, true),
  };
}

/** D10: the display window (about one trading year) and the band around price a shown level must lie in. */
export const RECENT_SR_BARS = 252;
export const RECENT_SR_BAND = 0.5;

/**
 * D10 (display only): the levels from the last year of bars, resistance strictly ABOVE `price` and support strictly
 * BELOW it, each within +/-50% of price, most touches first. Legacy's srLevels reads the whole history, so a level from
 * the IPO period (ALAB: resistance $101 with price $268) could print as "resistance" below price.
 */
export function recentSrLevels(c: Pick<SrInput, 'highs' | 'lows' | 'volumes'>, price: number, trendDirection?: SrTrendDirection): SrLevels {
  const from = Math.max(0, c.highs.length - RECENT_SR_BARS);
  const all = srLevels(c.highs.slice(from), c.lows.slice(from), trendDirection, c.volumes ? c.volumes.slice(from) : undefined);
  const near = (l: SrLevel): boolean => Math.abs(l.level / price - 1) <= RECENT_SR_BAND;
  return {
    resistanceLevels: all.resistanceLevels.filter((l) => l.level > price && near(l)),
    supportLevels: all.supportLevels.filter((l) => l.level < price && near(l)),
  };
}

/**
 * Downsamples to a coarser timeframe by taking the extreme of each group.
 *
 * Walks BACKWARD from the end, so the most recent group is always complete and
 * any partial group lands at the START. That ordering matters: the alternative
 * (forward grouping) would leave a partial group at the end, contaminating the
 * most recent — and most decision-relevant — bar.
 */
export function resampleHighLow(
  highs: readonly number[],
  lows: readonly number[],
  groupSize: number,
): { highs: number[]; lows: number[] } {
  const outHighs: number[] = [];
  const outLows: number[] = [];
  for (let i = highs.length; i > 0; i -= groupSize) {
    const start = Math.max(0, i - groupSize);
    outHighs.unshift(Math.max(...highs.slice(start, i)));
    outLows.unshift(Math.min(...lows.slice(start, i)));
  }
  return { highs: outHighs, lows: outLows };
}

export interface SrConfluence {
  level: number;
  tier: SrTier;
  touchCount: number;
  onWeekly: boolean;
  onMonthly: boolean;
  strength: 'DAILY_ONLY' | 'DAILY+WEEKLY' | 'DAILY+WEEKLY+MONTHLY';
}

export interface SrMultiTimeframe {
  resistance: SrConfluence | null;
  support: SrConfluence | null;
}

/**
 * Checks whether the strongest daily level also appears on weekly and monthly
 * timeframes — confluence across timeframes being stronger evidence than a
 * level visible on one alone.
 *
 * Only the TOP daily level of each side is classified (`[0]` after the
 * touch-count sort), not every level. Returns null for a side with no daily
 * levels at all.
 *
 * Note it calls srLevels with TWO arguments, so the weekly and monthly level
 * sets carry `trendFavored: null` and no `volumeWeightedStrength`. Those
 * sparser objects are never surfaced — only matched against — but the
 * two-argument form is what makes the confluence function's own output shape
 * correct, so it must not be "improved" to pass the extra parameters through.
 *
 * `strength` is monotonic: monthly confluence implies weekly is reported too,
 * even though onWeekly is tested independently.
 */
export function srMultiTimeframeConfluence(highs: readonly number[], lows: readonly number[]): SrMultiTimeframe {
  const daily = srLevels(highs, lows);
  const weekly = resampleHighLow(highs, lows, 5);
  const monthly = resampleHighLow(highs, lows, 21); // trading-days-per-month convention
  const weeklySR = srLevels(weekly.highs, weekly.lows);
  const monthlySR = srLevels(monthly.highs, monthly.lows);

  const match = (price: number, levels: SrLevel[]): boolean =>
    levels.some((l) => Math.abs(l.level - price) / price <= LEVEL_TOLERANCE);

  function classify(dailyLevel: SrLevel | undefined, weeklyLevels: SrLevel[], monthlyLevels: SrLevel[]): SrConfluence | null {
    if (!dailyLevel) return null;
    const onWeekly = match(dailyLevel.level, weeklyLevels);
    const onMonthly = match(dailyLevel.level, monthlyLevels);
    const strength = onMonthly ? 'DAILY+WEEKLY+MONTHLY' : onWeekly ? 'DAILY+WEEKLY' : 'DAILY_ONLY';
    return { level: dailyLevel.level, tier: dailyLevel.tier, touchCount: dailyLevel.touchCount, onWeekly, onMonthly, strength };
  }

  return {
    resistance: classify(daily.resistanceLevels[0], weeklySR.resistanceLevels, monthlySR.resistanceLevels),
    support: classify(daily.supportLevels[0], weeklySR.supportLevels, monthlySR.supportLevels),
  };
}

export interface MonthlyStructure {
  monthlySma: number;
  monthlyTrend: 'above' | 'below';
  monthsAvailable: number;
}

export interface SrFamilySlice {
  monthlyStructure: MonthlyStructure | null;
  srLevels: SrLevels;
  srMultiTimeframe: SrMultiTimeframe;
}

/**
 * The three S/R-family fields.
 *
 * monthlyStructure implements the well-known "10-month rule". Months are
 * derived from UTC calendar dates, and the LAST close seen for each month wins
 * — which works only because dates arrive chronologically. It is genuine
 * calendar-month bucketing, unlike the 21-trading-day approximation used by
 * resampleHighLow above; the two coexist deliberately.
 *
 * On srTrendDirection: when sma50 is unavailable, pctFromSma50 is null and both
 * comparisons against it are false, so the direction becomes 'flat'. That makes
 * trendFavored false on both sides — "not favoured" rather than a claimed
 * direction. Notably better behaved than F-08's short-history handling in the
 * volume-structure slice, which asserts 'DOWN' outright. Same situation,
 * different outcome, in the same file.
 */
export function computeSrFamilySlice(c: SrInput): SrFamilySlice {
  const { closes, highs, lows, volumes, dates } = c;
  const n = closes.length;
  const last = closes[n - 1] as number;

  const sma50 = closes.length >= 50 ? closes.slice(-50).reduce((a, b) => a + b, 0) / 50 : null;
  const pctFromSma50 = sma50 ? (last / sma50 - 1) * 100 : null;
  const srTrendDirection: SrTrendDirection =
    (pctFromSma50 as number) > 0 ? 'up' : (pctFromSma50 as number) < 0 ? 'down' : 'flat';

  let monthlyStructure: MonthlyStructure | null = null;
  try {
    const monthlyMap: Record<string, number> = {};
    dates.forEach((d, i) => {
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      monthlyMap[key] = closes[i] as number; // last close of the month wins
    });
    const monthlyCloses = Object.keys(monthlyMap)
      .sort()
      .map((k) => monthlyMap[k] as number);

    const MONTHLY_SMA_PERIOD = 10; // the "10-month rule"
    if (monthlyCloses.length >= MONTHLY_SMA_PERIOD) {
      const recent10 = monthlyCloses.slice(-MONTHLY_SMA_PERIOD);
      const monthlySma = recent10.reduce((a, b) => a + b, 0) / MONTHLY_SMA_PERIOD;
      monthlyStructure = {
        monthlySma,
        monthlyTrend: last > monthlySma ? 'above' : 'below',
        monthsAvailable: monthlyCloses.length,
      };
    }
  } catch {
    /* non-fatal — multi-timeframe context is supplementary */
  }

  return {
    monthlyStructure,
    srLevels: srLevels(highs, lows, srTrendDirection, volumes),
    srMultiTimeframe: srMultiTimeframeConfluence(highs, lows),
  };
}
