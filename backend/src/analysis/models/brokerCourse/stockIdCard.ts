/**
 * Broker Course Phase 1 -- the Stock ID Card (:43-248, 10 functions).
 *
 * The course's first lesson (ep.1): before reading a chart, know what you
 * are holding -- size tier, float, volatility, volume. Four functions here
 * are one-line tier labels whose thresholds are the course's own spoken
 * numbers; four are standard arithmetic (ATR, range volatility, 52-week
 * range, volume stats); one classifies the range volatility against the
 * course's hot/coiled bands; buildStockIdCardV1 assembles the card.
 *
 * Depends on nothing else in this model. P11 consumes the card, and also
 * calls trailing52WeekRangeV1 a second time directly (:1987).
 *
 * ══ THE COURSE'S TIERS, NOT THE ENGINE'S ════════════════════════════════
 * The market-cap tiers (Mega >=$100B / Large >=$10B / Mid >=$2B / Small
 * >=$250M / Tiny) are the course's numbers and deliberately DISAGREE with
 * the engine's own gapMarketCapContextV7 (Mega >=$200B ... Micro <$300M).
 * The source discloses this and keeps them separate on purpose -- this
 * model is meant to be an independent opinion. Do not reconcile them.
 *
 * ══ THE ONE STRUCTURAL CHANGE: BOTH FETCHES ARE LIFTED OUT ══════════════
 * Legacy buildStockIdCardV1(ticker, log, existingChart, existingFund) did
 * `existingChart || fetchYahooChart(ticker)` (:189) and `existingFund !==
 * undefined ? existingFund : gatherFundamentals(...)` (:195). That makes it
 * the second I/O function in this file, not only buildBrokerCourseReportV1
 * -- the split plan's "only P11 touches I/O" was one function short. Same
 * treatment exitRead.ts gave computePositionExitRead: the caller resolves
 * both. The only production call site (:1889) already hands over a
 * resolved `fund` and the engine's own chart, so nothing in production
 * relied on either fallback fetch.
 *
 * `fund` keeps two of legacy's three states: an object is data, `null` is
 * "genuinely no fundamentals". The third -- `undefined` meaning "go fetch
 * it" -- is no longer expressible in the type.
 */

export type MarketCapTier = 'Mega Cap' | 'Large Cap' | 'Mid Cap' | 'Small Cap' | 'Tiny/Micro Cap';

/**
 * Market-cap tier, per episode 1 verbatim. Every floor is inclusive (`>=`),
 * so exactly $100B is Mega and exactly $250M is Small.
 *
 * Zero and negative values are not refused -- they fall through to
 * 'Tiny/Micro Cap'. Only null/undefined/NaN return null.
 */
export function marketCapTierV1(marketCap: number | null | undefined): MarketCapTier | null {
  if (marketCap == null || isNaN(marketCap)) return null;
  if (marketCap >= 100e9) return 'Mega Cap';
  if (marketCap >= 10e9) return 'Large Cap';
  if (marketCap >= 2e9) return 'Mid Cap';
  if (marketCap >= 250e6) return 'Small Cap';
  return 'Tiny/Micro Cap';
}

/**
 * Float tier, per episode 1: <50M / <30M / <10M, each a step further into
 * "can be moved with less capital".
 *
 * Unlike the market-cap tiers these are STRICT (`<`), so exactly 10M is
 * 'Very low', not 'Extreme low', and exactly 50M is 'Normal'.
 */
export function floatTierFlagV1(floatShares: number | null | undefined): string | null {
  if (floatShares == null || isNaN(floatShares)) return null;
  if (floatShares < 10e6) return 'Extreme low float (<10M)';
  if (floatShares < 30e6) return 'Very low float (<30M)';
  if (floatShares < 50e6) return 'Low float (<50M)';
  return 'Normal float';
}

/**
 * ATR above 10% of price = "very high volatility" (ep.1). Strict: exactly
 * 10% is not. Phase 8 reuses the same >10% convention.
 */
export function atrPctFlagV1(atrPct: number | null | undefined): string | null {
  if (atrPct == null || isNaN(atrPct)) return null;
  return atrPct > 0.10 ? 'Very high volatility (ATR >10% of price)' : 'Normal-to-elevated volatility';
}

/**
 * Relative volume >= 1.5x = "something is happening".
 *
 * The course gives a 1.5-2x range; the source uses the FLOOR because 1.5x
 * is the number explicitly spoken (ep.5). Inclusive. Not fitted.
 */
export function relativeVolumeReadV1(relVol: number | null | undefined): string | null {
  if (relVol == null || isNaN(relVol)) return null;
  return relVol >= 1.5 ? 'Elevated — something is happening' : 'Normal volume';
}

/**
 * Standard Wilder ATR for the most recent bar, default 14 periods.
 *
 * Textbook formula, not course content: true ranges from bar 1 onward (bar
 * 0 has no prior close), seeded with the simple mean of the first `period`
 * TRs, then Wilder-smoothed forward. Needs period+1 bars. `period || 14`
 * means 0 also falls back to 14.
 *
 * The second length check (`trs.length < p`) can never fire: the first
 * guard already requires highs.length >= p+1, and there are exactly
 * highs.length-1 true ranges. Kept -- it is in the source and is
 * behaviour-neutral.
 */
export function computeATRV1(
  highs: readonly number[] | null | undefined,
  lows: readonly number[] | null | undefined,
  closes: readonly number[] | null | undefined,
  period?: number | null,
): number | null {
  const p = period || 14;
  if (!highs || !lows || !closes || highs.length < p + 1) return null;
  const n = highs.length;
  const trs: number[] = [];
  for (let i = 1; i < n; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    trs.push(Math.max(hl, hc, lc));
  }
  if (trs.length < p) return null;
  let atr = trs.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < trs.length; i++) {
    atr = (atr * (p - 1) + trs[i]) / p;
  }
  return atr;
}

/**
 * Trailing-window range volatility: (window high - window low) / mean close.
 *
 * Range-based, not a stdev of returns -- a disclosed approximation, and the
 * same "look at the % swing over the period" read the course itself
 * demonstrates (ep.4). The card calls it with 5 bars ("weekly") and 21
 * ("monthly").
 *
 * A window of 0 yields an empty slice and a NaN mean, which the
 * `!avgClose` guard turns into null -- the same guard that catches a zero
 * mean.
 */
export function trailingRangeVolatilityPctV1(
  highs: readonly number[] | null | undefined,
  lows: readonly number[] | null | undefined,
  closes: readonly number[] | null | undefined,
  lookbackDays: number,
): number | null {
  if (!highs || !lows || !closes || highs.length < lookbackDays) return null;
  const n = highs.length;
  const wHighs = highs.slice(n - lookbackDays);
  const wLows = lows.slice(n - lookbackDays);
  const wCloses = closes.slice(n - lookbackDays);
  const hi = Math.max.apply(null, wHighs);
  const lo = Math.min.apply(null, wLows);
  const avgClose = wCloses.reduce((a, b) => a + b, 0) / wCloses.length;
  if (!avgClose) return null;
  return (hi - lo) / avgClose;
}

export interface VolatilityRead {
  readonly tier: 'Hot' | 'Coiled' | 'Normal';
  readonly read: string;
}

/**
 * Classifies a range-volatility fraction against the course's two bands
 * (ep.1, raw-verified against the transcript per the source): above 5-6%
 * is HOT, below 3% is COILED. Two separate signals, not one scale --
 * "coiled" is "calm before the storm", not merely "not hot". 5% is the hot
 * floor, the same take-the-range's-floor convention as the 1.5x volume rule.
 *
 * Both bands are strict, so exactly 3% and exactly 5% read Normal.
 *
 * ══ THE TEXT CAN CONTRADICT THE TIER AT A BOUNDARY ═════════════════════
 * The percentage is rounded to one decimal for display AFTER the strict
 * test. So 0.0299 reads "Volatility 3.0% — below the course's 3% band",
 * and 0.05001 reads "5.0% — above the course's 5-6% band". Measured on the
 * oracle, reproduced.
 *
 * The only read in Phase 1 without an isNaN guard: NaN falls through to
 * Normal with "NaN%" in the text. Its only producer returns a number or
 * null, so nothing in production feeds it NaN.
 */
export function volatilityHotColdReadV1(pct: number | null | undefined): VolatilityRead | null {
  if (pct == null) return null;
  if (pct > 0.05) return { tier: 'Hot', read: 'Volatility ' + (pct * 100).toFixed(1) + '% — above the course\'s 5-6% "hot" band (ep.1): something real is happening' };
  if (pct < 0.03) return { tier: 'Coiled', read: 'Volatility ' + (pct * 100).toFixed(1) + '% — below the course\'s 3% "coiled" band (ep.1): calm before a possible storm' };
  return { tier: 'Normal', read: 'Volatility ' + (pct * 100).toFixed(1) + '% — neither the course\'s hot (>5-6%) nor coiled (<3%) band (ep.1)' };
}

export interface Range52w {
  readonly high: number;
  readonly low: number;
}

/**
 * 52-week high/low. Walks BACKWARD from the last bar while each bar's date
 * is within 365 calendar days of it -- a calendar cutoff (inclusive), not
 * a 252-bar count, despite the source comment's "~252 trading days".
 *
 * ══ A NULL LOW POISONS THE RESULT; A NULL HIGH DOES NOT ═════════════════
 * `null < lo` coerces null to 0, so the first null low becomes `lo`, and no
 * positive price is ever below it again -- the low comes back `null`. The
 * mirror case recovers: `x > null` is true for any positive x, so a null
 * high is overwritten by the next real one. Measured on the _VIX fixture
 * (182 null closes, reused as its highs/lows by the test harness): full
 * history gives {high: 31.05, low: null}. NOT production-reachable --
 * fetchYahooChartRaw_ drops every null-close bar and backfills null O/H/L
 * with the close (dataLayerV1.gs:311-314) -- so documented, not registered.
 */
export function trailing52WeekRangeV1(
  highs: readonly number[] | null | undefined,
  lows: readonly number[] | null | undefined,
  dates: readonly Date[],
): Range52w | null {
  if (!highs || !lows || !highs.length) return null;
  const n = highs.length;
  const cutoff = new Date(dates[n - 1].getTime() - 365 * 24 * 60 * 60 * 1000);
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = n - 1; i >= 0 && dates[i] >= cutoff; i--) {
    if (highs[i] > hi) hi = highs[i];
    if (lows[i] < lo) lo = lows[i];
  }
  if (hi === -Infinity || lo === Infinity) return null;
  return { high: hi, low: lo };
}

export interface VolumeStats {
  readonly current: number;
  readonly avg: number;
  readonly relVol: number | null;
}

/**
 * Current volume, trailing mean, and relative volume (current / mean).
 *
 * The mean EXCLUDES today (the window ends at n-1), so a spike day is
 * measured against the days before it rather than diluting its own
 * baseline. A zero mean gives `relVol: null` rather than Infinity -- which
 * is how a zero-volume window ends up with a null relative-volume read.
 */
export function volumeStatsV1(
  volumes: readonly number[] | null | undefined, lookbackDays: number,
): VolumeStats | null {
  if (!volumes || volumes.length < 2) return null;
  const n = volumes.length;
  const current = volumes[n - 1];
  const windowStart = Math.max(0, n - 1 - lookbackDays);
  const win = volumes.slice(windowStart, n - 1);
  if (!win.length) return null;
  const avg = win.reduce((a, b) => a + b, 0) / win.length;
  const relVol = avg ? current / avg : null;
  return { current, avg, relVol };
}

/** The subset of the chart the card reads. `Chart` satisfies it. */
export interface StockIdCardChart {
  readonly highs: readonly number[];
  readonly lows: readonly number[];
  readonly closes: readonly number[];
  readonly volumes: readonly number[];
  readonly dates: readonly Date[];
  /** The live quote -- not the last close. */
  readonly currentPrice: number;
  readonly ipoDate?: Date | null;
}

/** The subset of gatherFundamentals' `fund` the card reads. */
export interface StockIdCardFund {
  readonly marketCap?: number | null;
  readonly shareFloat?: number | null;
  readonly sector?: string | null;
  readonly industry?: string | null;
  readonly _sources?: readonly string[] | null;
}

export interface StockIdCard {
  readonly ticker: string;
  readonly price: number;
  readonly ipoDate: Date | null | undefined;
  readonly exchange: null;
  readonly companyName: null;
  readonly hq: null;
  readonly employees: null;
  readonly revenueAbsolute: null;
  readonly shortable: null;
  readonly sector: string | null | undefined;
  readonly industry: string | null | undefined;
  readonly marketCap: number | null | undefined;
  readonly marketCapTier: MarketCapTier | null;
  readonly sharesOutstandingApprox: number | null;
  readonly floatShares: number | null | undefined;
  readonly floatTier: string | null;
  readonly atr: number | null;
  readonly atrPct: number | null;
  readonly atrFlag: string | null;
  readonly weeklyVolatilityPct: number | null;
  readonly monthlyVolatilityPct: number | null;
  readonly weeklyVolatilityRead: VolatilityRead | null;
  readonly monthlyVolatilityRead: VolatilityRead | null;
  readonly range52w: Range52w | null;
  readonly avgVolume20d: number | null;
  readonly currentVolume: number | null;
  readonly relativeVolume: number | null;
  readonly relativeVolumeRead: string | null;
  readonly fundSources: readonly string[] | null | undefined;
}

/**
 * Assembles the card from an already-resolved chart and fund.
 *
 * ══ ABSENT FUND FIELDS LEAK `undefined`, NOT `null` ═════════════════════
 * `fund ? fund.marketCap : null` yields `undefined` when the fund object
 * exists but lacks the field. So `{}` produces a card whose marketCap,
 * floatShares, sector, industry and fundSources are `undefined`, while the
 * DERIVED marketCapTier / floatTier / sharesOutstandingApprox are `null`
 * (each has its own `== null` guard). Measured on the oracle and kept --
 * the difference survives into anything that distinguishes the two, e.g.
 * JSON serialisation drops undefined keys.
 *
 * Shares outstanding is DERIVED (marketCap / currentPrice), disclosed as an
 * approximation in the source. It and atrPct both divide by the live quote
 * `currentPrice`, not the last close; a zero quote nulls both.
 *
 * Six fields are hardwired null -- real, disclosed gaps the reused fetchers
 * cannot supply. Never guessed.
 *
 * A missing chart logs the legacy message verbatim (it says "fetch
 * failed", because in legacy that is what had happened) and returns null.
 */
export function buildStockIdCardV1(
  ticker: string,
  chart: StockIdCardChart | null,
  fund: StockIdCardFund | null,
  log?: (msg: string) => void,
): StockIdCard | null {
  if (!chart) {
    log?.('  ID Card: chart fetch failed for ' + ticker);
    return null;
  }

  const atr = computeATRV1(chart.highs, chart.lows, chart.closes, 14);
  const atrPct = atr != null && chart.currentPrice ? atr / chart.currentPrice : null;
  const weeklyVolPct = trailingRangeVolatilityPctV1(chart.highs, chart.lows, chart.closes, 5);
  const monthlyVolPct = trailingRangeVolatilityPctV1(chart.highs, chart.lows, chart.closes, 21);
  const range52w = trailing52WeekRangeV1(chart.highs, chart.lows, chart.dates);
  const vol = volumeStatsV1(chart.volumes, 20);

  const marketCap = fund ? fund.marketCap : null;
  const floatShares = fund ? fund.shareFloat : null;
  const sharesOutstandingApprox = marketCap != null && chart.currentPrice
    ? marketCap / chart.currentPrice
    : null;

  return {
    ticker,
    price: chart.currentPrice,
    ipoDate: chart.ipoDate,
    exchange: null,
    companyName: null,
    hq: null,
    employees: null,
    revenueAbsolute: null,
    shortable: null,

    sector: fund ? fund.sector : null,
    industry: fund ? fund.industry : null,
    marketCap,
    marketCapTier: marketCapTierV1(marketCap),
    sharesOutstandingApprox,
    floatShares,
    floatTier: floatTierFlagV1(floatShares),
    atr,
    atrPct,
    atrFlag: atrPctFlagV1(atrPct),
    weeklyVolatilityPct: weeklyVolPct,
    monthlyVolatilityPct: monthlyVolPct,
    weeklyVolatilityRead: volatilityHotColdReadV1(weeklyVolPct),
    monthlyVolatilityRead: volatilityHotColdReadV1(monthlyVolPct),
    range52w,
    avgVolume20d: vol ? vol.avg : null,
    currentVolume: vol ? vol.current : null,
    relativeVolume: vol ? vol.relVol : null,
    relativeVolumeRead: vol ? relativeVolumeReadV1(vol.relVol) : null,
    fundSources: fund ? fund._sources : null,
  };
}
