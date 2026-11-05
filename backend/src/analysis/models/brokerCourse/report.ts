/**
 * Broker Course Phase 11 -- report assembly (:1843-2244, 3 functions):
 * the breakout-context read, the report builder, and its formatter. The
 * builder is the model's only real I/O function; everything it computes
 * comes from Phases 1-10 and 13 (BC-1..BC-4).
 *
 * ══ EVERY I/O TOUCHPOINT IS NOW AN INPUT ═══════════════════════════════
 * Measured before porting -- 13 touchpoints, all lifted into
 * BrokerReportInputs (same treatment as exitRead.ts / riskOverlayReadV1):
 *   existingChart || fetchYahooChart (:1892, + the ID card's own :189) -> chart
 *   existingFund !== undefined ? : gatherFundamentals (:1887)        -> fund
 *   fetchSecEdgarCIKV1 (:1900)               -> dropped: the CIK only feeds the two SEC fetches
 *   13F behind hasTimeBudgetV7_ (:1941-1954)  -> holdings13F (the raw fetch result;
 *                                               the "any real position" filter stays here)
 *   fetchSharesOutstandingHistoryV1 (:1968)   -> sharesOutstandingHistory
 *   new Date() + fetchSecFilingKeywordHitsV1 (:1978-1983) -> filingKeywordHits
 *   new Date() for the lock-up read (:1984)   -> now (F-27 still applies)
 *   existingVixLevel != null ? : fetchYahooChart('^VIX') (:2014-2027) -> vixLevel
 *                                               (note `!= null`: an explicit null fetched,
 *                                               unlike every `!== undefined` above)
 *   fetchEarningsCalendarV7 fallback (:2040)  -> earningsHistory (fund._earningsHistory
 *                                               still wins, as in legacy)
 *   readBrokerDataCacheV1_ (:2064)            -> brokerDataCache
 *   readMacroSnapshotV1_ (:2097)              -> macroSnapshot
 *   the two ETF fetchers in riskOverlayReadV1 -> spdrHoldings / qqqHoldings
 * The Date.now() timing log lines are not emitted (they describe fetches
 * that no longer happen here); the two failure log lines are verbatim.
 * Legacy's second "chart fetch failed" branch (:1893) cannot occur with one
 * shared chart.
 *
 * ══ WHO READS THE REPORT (measured across all ten files) ══════════════
 * The formatter (engine :1479); the comparison report (brokerCourseModelV1.gs
 * :2384-2425, part of BC-6's own scope -- not :1583), which reads only the
 * three tags, synthesis and technical.fibRead; and the dashboard (:1498),
 * which reads only institutional13F and news.shortInterestData.
 * Everything else here is computed and never shown or read -- including
 * risk.etfPositionSizing (F-25), technique.riskReward (F-26),
 * macro.businessCyclePhase/zombieCompanyScreen, technical.breakoutContext
 * and the S/R level lists, news.gaps and most ID-card fields.
 *
 * The F-24 orphans (chartPatternReadV1, vixAndSqueezeReadV1,
 * fibonacciExtensionTargetsV1, flagPatternQualityV1) are not called here,
 * exactly as in legacy.
 */

import {
  buildStockIdCardV1, trailing52WeekRangeV1,
  type StockIdCard, type StockIdCardChart, type StockIdCardFund, type Range52w,
} from './stockIdCard.ts';
import {
  classifyCandleV1, candleContextReadV1, findSwingPointsV1, findSupportResistanceV1, srReliabilityContextV1,
  smaSeriesV1, maRelationshipReadV1,
  type SrLevel, type CandleContextRead, type MaRelationshipRead,
} from './technicals.ts';
import { fibonacciRetracementReadV1, type FibRetracementRead } from './fibonacci.ts';
import {
  detectPriceGapsV1, classifyGapTypeV1, gapMarketCapSignificanceV1, classifyEarningsGapV1, reverseSplitAvoidFlagV1,
  type BrokerGap, type BrokerGapType, type EarningsEvent, type EarningsGapTag, type ReverseSplitFlag,
} from './gaps.ts';
import { playerMappingReadV1, type PlayerMappingRead } from './playerMapping.ts';
import { shortDate, type ModelTextOptions } from '../modelText.ts';
import { fundamentalsScreenReadV1, type FundamentalsScreen } from './fundamentals.ts';
import { techniqueEntryReadV1, type TechniqueEntryRead } from './technique.ts';
import { riskOverlayReadV1, type RiskOverlay, type SpdrHoldings, type QqqHoldings } from './risk.ts';
import { macroOverlayReadV1, type MacroOverlay } from './macro.ts';
import { vixRegimeReadV1, shortSqueezeSetupReadV1, type VixRegimeRead, type ShortSqueezeRead } from './vixSqueeze.ts';
import type { SharesOutstandingPoint } from './screens.ts';
import type { Split } from '../../../types/chart.ts';

export interface BreakoutContext {
  readonly nearATH: boolean;
  readonly longTermDowntrend: boolean;
  readonly longTermTrend: 'down' | 'up' | 'flat';
  readonly roc252: number | null | undefined;
}

/**
 * The missing producer of Phase 2/4's `atHigh`/`nearATH` and
 * `longTermTrend`/`longTermDowntrend` inputs (a gap the source found and
 * closed during assembly). Near-ATH: within 3% of the 52-week high
 * (inclusive). Long-term down: 252-bar ROC < -30%; up: > +10% (both
 * strict; disclosed defaults).
 *
 * The engine computes its own breakout context (:7539-7543); on real
 * charts the two classifications agree everywhere measured. The fixtures'
 * live quote equals the last close, though -- in production this read
 * uses the quote and the engine the close.
 */
export function breakoutContextReadV1(
  currentPrice: number | null | undefined,
  high52: number | null | undefined,
  roc252: number | null | undefined,
  tolerance?: number | null,
): BreakoutContext {
  const tol = tolerance == null ? 0.03 : tolerance;
  const nearATH = high52 != null && currentPrice != null && currentPrice >= high52 * (1 - tol);
  const longTermDowntrend = roc252 != null && roc252 < -0.30;
  const longTermTrend = longTermDowntrend ? 'down' : (roc252 != null && roc252 > 0.10 ? 'up' : 'flat');
  return { nearATH, longTermDowntrend, longTermTrend, roc252 };
}

export interface BrokerReportChart extends StockIdCardChart {
  readonly opens: readonly number[];
  readonly splits: readonly Split[];
}

export interface BrokerReportFund extends StockIdCardFund {
  readonly revenueGrowth?: number | null;
  readonly _earningsHistory?: readonly EarningsEvent[] | null;
}

export interface Position13F {
  readonly shares: number;
  readonly value: number;
}

export interface Filing13F {
  readonly holdings?: Position13F | null;
  readonly date?: string;
}

export interface Filer13F {
  readonly latest?: Filing13F | null;
  readonly prior?: Filing13F | null;
}

export type Holdings13F = Readonly<Record<string, Filer13F>>;

/** Shape of readBrokerDataCacheV1_'s result (dataLayerV1.gs:952). */
export interface BrokerDataCache {
  readonly shortInterest?: number | null;
  readonly daysToCover?: number | null;
  readonly settlementDate?: string | null;
  readonly interestCoverageRatio?: number | null;
}

/** Shape of readMacroSnapshotV1_'s result (dataLayerV1.gs:1016). */
export interface MacroSnapshot {
  readonly dgs10?: readonly number[] | null;
  readonly fedfunds?: readonly number[] | null;
  readonly gdpSeries?: readonly number[] | null;
}

/** Everything legacy fetched or read; see the header for the mapping. */
export interface BrokerReportInputs {
  readonly chart: BrokerReportChart | null;
  readonly fund: BrokerReportFund | null;
  readonly vixLevel: number | null;
  readonly sharesOutstandingHistory: readonly SharesOutstandingPoint[] | null | undefined;
  readonly filingKeywordHits: Record<string, number | null> | null | undefined;
  readonly holdings13F: Holdings13F | null;
  readonly earningsHistory: readonly EarningsEvent[] | null | undefined;
  readonly brokerDataCache: BrokerDataCache | null;
  readonly macroSnapshot: MacroSnapshot | null;
  readonly spdrHoldings: SpdrHoldings | null;
  readonly qqqHoldings: QqqHoldings | null;
  readonly now: Date;
}

export interface ShortInterestData {
  readonly shortInterest: number;
  readonly daysToCover: number | null | undefined;
  readonly settlementDate: string | null | undefined;
}

export type NetRead = 'Net read leans supportive' | 'Net read leans cautionary' | 'Net read is mixed/neutral — no clear lean';

export interface BrokerCourseReport {
  readonly ticker: string;
  readonly idCard: StockIdCard;
  readonly playerMapping: PlayerMappingRead;
  readonly fundamentalsScreen: FundamentalsScreen;
  readonly technical: {
    readonly breakoutContext: BreakoutContext;
    readonly lastCandleType: string | null;
    readonly candleContext: CandleContextRead | null;
    readonly resistanceLevels: readonly SrLevel[];
    readonly supportLevels: readonly SrLevel[];
    readonly srReliability: string;
    readonly maRelationship: MaRelationshipRead | null;
    readonly fibRead: FibRetracementRead | null;
    readonly vix: VixRegimeRead | null;
  };
  readonly news: {
    readonly gaps: readonly BrokerGap[];
    readonly lastGap: BrokerGap | null;
    readonly gapType: BrokerGapType | null;
    readonly gapCapContext: string | null;
    readonly earningsGap: EarningsGapTag | null;
    readonly reverseSplit: ReverseSplitFlag | null;
    readonly shortInterestData: ShortInterestData | null;
    readonly shortPctOfFloat: number | null;
    readonly squeezeSetup: ShortSqueezeRead | null;
    readonly shortInterestNote: string | null;
  };
  readonly technique: TechniqueEntryRead;
  readonly risk: RiskOverlay;
  readonly macro: MacroOverlay;
  readonly institutional13F: Holdings13F | null;
  readonly synthesis: {
    readonly bullish: string[];
    readonly cautionary: string[];
    readonly netRead: NetRead;
  };
}

/**
 * Assembles the nine-section report plus 13F, and a qualitative synthesis:
 * a COUNT of bullish vs cautionary items, not a weighted score.
 *
 * Production shapes kept exactly: n = closes.length - 1; S/R with four
 * arguments (F-21/F-22); the technique read with a literal null target
 * (F-26); macro windows of the last 20 yields / 12 rates.
 *
 * The candle-context "preceding trend" is the ONE-BAR slope of the 50-day
 * SMA -- a hammer counts as "after a downtrend" if the 50 ticked down on
 * the last bar.
 *
 * ══ FLAGGED (F-28): THE ZOMBIE LINE CONTRADICTS ITS OWN SCREEN ════════
 * The synthesis rule re-tests `interestCoverageRatio < 1.0` raw instead of
 * using zombieCompanyScreenV1, which deliberately excludes exactly 0 (a
 * documented real fix: 0 is a real AAPL value, near-zero NET interest
 * expense). At 0 the macro screen reads "not a zombie-company profile",
 * but that verdict never enters macro.evidence (isZombie is false) and the
 * formatter renders evidence only -- so the user's report carries just
 * "[-] Macro: interest coverage below 1.0 — standard academic zombie-
 * company profile", plus a cautionary vote. Reproduced, not fixed.
 *
 * The VIX rule adds a cautionary vote whenever VIX is 13-25: 67.0% of real
 * VIX days in the fixture (3,316 of 4,946). Deliberate per the legacy
 * comment's out-of-sample evidence; recorded so the base rate is known.
 *
 * With no chart, logs the ID card's line and then this one, exactly as
 * legacy does when its own chart fetch fails, and returns null.
 */
export function buildBrokerCourseReportV1(
  ticker: string,
  inputs: BrokerReportInputs,
  log?: (msg: string) => void,
): BrokerCourseReport | null {
  const fund = inputs.fund;
  const idCard = buildStockIdCardV1(ticker, inputs.chart, fund, log);
  if (!idCard) {
    log?.('Report: ID card build failed for ' + ticker);
    return null;
  }
  const chart = inputs.chart as BrokerReportChart;
  const n = chart.closes.length - 1;

  const holdings = inputs.holdings13F;
  const institutional13F = holdings == null
    ? null
    : (Object.values(holdings).some((q) => (q.latest && q.latest.holdings) || (q.prior && q.prior.holdings)) ? holdings : null);

  const gaps = detectPriceGapsV1(chart.opens, chart.closes, chart.dates, 0.02);
  const lastGap = gaps.length ? gaps[gaps.length - 1] : null;

  const playerMapping = playerMappingReadV1(chart.closes, chart.highs, chart.lows, chart.volumes, chart.currentPrice, 20);

  const fundamentalsScreen = fundamentalsScreenReadV1(fund ? fund.revenueGrowth : null, chart.ipoDate, inputs.now,
    inputs.sharesOutstandingHistory, inputs.filingKeywordHits);

  const range52w: Range52w | null = trailing52WeekRangeV1(chart.highs, chart.lows, chart.dates);
  const roc252 = chart.closes.length > 252
    ? (chart.currentPrice - chart.closes[chart.closes.length - 1 - 252]) / chart.closes[chart.closes.length - 1 - 252]
    : null;
  const breakoutContext = breakoutContextReadV1(chart.currentPrice, range52w ? range52w.high : null, roc252);

  const lastCandleType = classifyCandleV1(chart.opens[n], chart.highs[n], chart.lows[n], chart.closes[n]);
  const sma50Series = smaSeriesV1(chart.closes, 50);
  const sma200Series = smaSeriesV1(chart.closes, 200);
  const maRelationship = maRelationshipReadV1(sma50Series, sma200Series);
  const precedingTrend = maRelationship ? maRelationship.slope50 : null;
  const candleContext = candleContextReadV1(lastCandleType, precedingTrend, idCard.relativeVolume);

  const { resistanceLevels, supportLevels } = findSupportResistanceV1(chart.highs, chart.lows, 0.03, n);
  const srReliability = srReliabilityContextV1(breakoutContext.nearATH, breakoutContext.longTermTrend);

  const { swingHighs, swingLows } = findSwingPointsV1(chart.highs, chart.lows, 5);
  const lastSwingHigh = swingHighs.length ? swingHighs[swingHighs.length - 1] : null;
  const lastSwingLow = swingLows.length ? swingLows[swingLows.length - 1] : null;
  let fibRead: FibRetracementRead | null = null;
  if (lastSwingHigh && lastSwingLow) {
    const direction = lastSwingHigh.idx > lastSwingLow.idx ? 'up' : 'down';
    fibRead = fibonacciRetracementReadV1(chart.currentPrice, lastSwingHigh.price, lastSwingLow.price, direction);
  }

  const vix = vixRegimeReadV1(inputs.vixLevel);

  const gapType = lastGap
    ? classifyGapTypeV1(lastGap, gaps, chart.highs, chart.lows, chart.volumes, chart.closes, breakoutContext.nearATH, breakoutContext.longTermDowntrend)
    : null;
  const gapCapContext = lastGap ? gapMarketCapSignificanceV1(lastGap.sizePct, idCard.marketCapTier) : null;
  const earningsHistory = (fund && fund._earningsHistory != null) ? fund._earningsHistory : inputs.earningsHistory;
  const earningsGap = (lastGap && earningsHistory) ? classifyEarningsGapV1(lastGap, earningsHistory, 1) : null;
  const reverseSplit = reverseSplitAvoidFlagV1(chart.splits, chart.dates, n);

  const brokerDataCache = inputs.brokerDataCache;
  const shortInterestData: ShortInterestData | null = (brokerDataCache && brokerDataCache.shortInterest != null)
    ? { shortInterest: brokerDataCache.shortInterest, daysToCover: brokerDataCache.daysToCover, settlementDate: brokerDataCache.settlementDate }
    : null;
  const shortPctOfFloat = (shortInterestData && idCard.floatShares) ? shortInterestData.shortInterest / idCard.floatShares : null;
  const squeezeSetup = shortSqueezeSetupReadV1(shortPctOfFloat, chart.currentPrice, range52w ? range52w.high : null);
  const shortInterestNote = shortInterestData ? null : 'Short-interest data not available — Nasdaq-listed tickers only (verified live, ep.9/13)';

  const techniqueEntry = techniqueEntryReadV1(chart.closes, chart.highs, chart.volumes, n, idCard.marketCap, supportLevels, null);

  const riskOverlay = riskOverlayReadV1(idCard.marketCap, idCard.atrPct, ticker, inputs.spdrHoldings, inputs.qqqHoldings);

  const macroSnapshot = inputs.macroSnapshot;
  const dgs10 = macroSnapshot ? macroSnapshot.dgs10 : null;
  const fedfunds = macroSnapshot ? macroSnapshot.fedfunds : null;
  const gdpSeries = macroSnapshot ? macroSnapshot.gdpSeries : null;
  const interestCoverageRatio = brokerDataCache ? brokerDataCache.interestCoverageRatio : null;
  const macroOverlay = macroOverlayReadV1(dgs10 ? dgs10.slice(-20) : null, fedfunds ? fedfunds.slice(-12) : null, gdpSeries, interestCoverageRatio);

  const bullish: string[] = [];
  const cautionary: string[] = [];
  if (playerMapping.tag === 'Institutional-Accumulation-Signature') bullish.push('Player Mapping: institutional-accumulation signature');
  if (playerMapping.tag === 'Speculative-Spike') cautionary.push('Player Mapping: speculative-spike signature (lower reliability)');
  if (fundamentalsScreen.tag === 'Dilution/Pump-Dump Risk Flagged') cautionary.push('Fundamentals: dilution/pump-dump risk flagged');
  if (fibRead && fibRead.trendIntact === false) cautionary.push('Fibonacci: retracement exceeds 50%, trend likely broken');
  if (maRelationship && maRelationship.cross && maRelationship.cross.indexOf('Golden') === 0) bullish.push('Technicals: golden cross');
  if (maRelationship && maRelationship.cross && maRelationship.cross.indexOf('Death') === 0) cautionary.push('Technicals: death cross');
  if (reverseSplit) cautionary.push('News: recent reverse split — course\'s own avoid-heuristic');
  if (squeezeSetup && squeezeSetup.isSqueezeSetup) bullish.push('News: Short Squeeze setup identified');
  if (techniqueEntry.tag !== 'No specific entry technique identified') bullish.push('Technique: ' + techniqueEntry.tag);
  if (interestCoverageRatio != null && interestCoverageRatio < 1.0) cautionary.push('Macro: interest coverage below 1.0 — standard academic zombie-company profile');
  if (vix && vix.regime === 'Normal (13-25)') cautionary.push('VIX: Normal regime (13-25) shows a real, modest historical underperformance vs baseline, confirmed in-sample AND out-of-sample (-2.59pp/-0.77pp, p=0.0425/0.0048) -- a mild caution, not a strong bearish signal');
  const netRead: NetRead = bullish.length > cautionary.length ? 'Net read leans supportive'
    : cautionary.length > bullish.length ? 'Net read leans cautionary'
      : 'Net read is mixed/neutral — no clear lean';

  return {
    ticker,
    idCard,
    playerMapping,
    fundamentalsScreen,
    technical: { breakoutContext, lastCandleType, candleContext, resistanceLevels, supportLevels, srReliability, maRelationship, fibRead, vix },
    news: { gaps, lastGap, gapType, gapCapContext, earningsGap, reverseSplit, shortInterestData, shortPctOfFloat, squeezeSetup, shortInterestNote },
    technique: techniqueEntry,
    risk: riskOverlay,
    macro: macroOverlay,
    institutional13F,
    synthesis: { bullish, cautionary, netRead },
  };
}

/**
 * The text the user reads (written to the "📚 Broker Model" sheet,
 * engine :1479). Sections 1-9 plus 13F when present.
 *
 * Reproduced as-is, worth knowing: the price prints as a raw float; a
 * missing tier, candle or ATR flag prints the literal "null"; 13F share
 * counts use toLocaleString(), so their exact text depends on the
 * runtime's ICU data (same caveat as gann's pivot.dateStr). The header is
 * `── ... ──`, not `===`: Sheets' setValue() treats a leading '=' as a
 * formula. Section 3 deliberately suppresses the shares/filing line when
 * the same read is already in evidence -- the F-18 duplicate class,
 * avoided here by design.
 */
/**
 * D19 (plain text): the analysis's own gap list (indicators/priceGaps.ts -- a true void, prior high/low, last ~60 bars),
 * the same list the Analysis v7 'PRICE GAPS' table and the Schabacker tab print. Legacy's broker line used its own
 * open-vs-prior-close detector (>=2%), so the two tabs named different 'last gaps'.
 */
export interface BrokerTextOptions extends ModelTextOptions {
  readonly analysisGaps?: ReadonlyArray<{ readonly date: Date; readonly type: string; readonly sizePct: number; readonly gapType?: string; readonly filled?: boolean }> | null;
}

const GAP_TYPE_WORDS: Readonly<Record<string, string>> = { BREAKAWAY: 'Breakaway', EXHAUSTION: 'Exhaustion', ISLAND: 'Island', RUNAWAY: 'Runaway', COMMON: 'Common' };

export function formatBrokerCourseReportV1(report: BrokerCourseReport | null, opts: BrokerTextOptions = {}): string {
  if (!report) return 'No report — data fetch failed.';
  const lines: string[] = [];
  const push = (s: string): void => {
    lines.push(s);
  };

  push('── ' + report.ticker + ' — Broker Course Model v1 ──');
  push('');
  push('1. STOCK ID CARD');
  push('  Price: ' + report.idCard.price + '  Market cap: ' + report.idCard.marketCapTier + '  Float: ' + report.idCard.floatTier);
  push('  ATR%: ' + (report.idCard.atrPct != null ? (report.idCard.atrPct * 100).toFixed(1) + '%' : 'n/a') + ' — ' + report.idCard.atrFlag);
  push('  Relative volume: ' + (report.idCard.relativeVolumeRead || 'n/a'));
  push('  Weekly volatility: ' + (report.idCard.weeklyVolatilityRead ? report.idCard.weeklyVolatilityRead.read : 'n/a'));
  push('  Monthly volatility: ' + (report.idCard.monthlyVolatilityRead ? report.idCard.monthlyVolatilityRead.read : 'n/a'));
  push('');
  push('2. PLAYER MAPPING: ' + report.playerMapping.tag);
  report.playerMapping.evidence.forEach((e) => push('  - ' + e));
  push('');
  push('3. FUNDAMENTALS SCREEN: ' + report.fundamentalsScreen.tag);
  report.fundamentalsScreen.evidence.forEach((e) => push('  - ' + e));
  if (report.fundamentalsScreen.sharesOutstandingTrend.indexOf('Shares outstanding steadily rising') !== 0) push('  ' + report.fundamentalsScreen.sharesOutstandingTrend);
  if (report.fundamentalsScreen.filingKeywordSearch.indexOf('Recent filings mention') !== 0) push('  ' + report.fundamentalsScreen.filingKeywordSearch);
  push('');
  push('4. TECHNICAL READ');
  push('  Last candle: ' + report.technical.lastCandleType + (report.technical.candleContext ? ' — ' + report.technical.candleContext.read : ''));
  push('  ' + report.technical.srReliability);
  if (report.technical.maRelationship) push('  MA: 50-slope ' + report.technical.maRelationship.slope50 + ', ' + report.technical.maRelationship.convergence + (report.technical.maRelationship.cross ? ' — ' + report.technical.maRelationship.cross : ''));
  if (report.technical.fibRead) push('  Fibonacci: ' + report.technical.fibRead.read);
  if (report.technical.vix) push('  ' + report.technical.vix.read);
  push('');
  push('5. NEWS/CATALYST CONTEXT');
  if (opts.plainText && opts.analysisGaps !== undefined) {
    const g = opts.analysisGaps && opts.analysisGaps.length ? opts.analysisGaps[opts.analysisGaps.length - 1] : null;
    if (g) {
      const cap = gapMarketCapSignificanceV1(g.sizePct, report.idCard.marketCapTier);
      push('  Last gap: ' + g.type + ' ' + (g.sizePct * 100).toFixed(1) + '% on ' + shortDate(g.date, opts.timeZone) + ' — ' + (GAP_TYPE_WORDS[g.gapType || ''] || 'unclassified')
        + (g.filled ? ', filled' : g.filled === false ? ', still open' : '') + (cap ? ' | ' + cap : '') + ' (same gap list as the Price Gaps table)');
    } else push('  Last gap: none in the last ~3 months (same gap list as the Price Gaps table)');
  } else if (report.news.lastGap) push('  Last gap: ' + report.news.lastGap.type + ' ' + (report.news.lastGap.sizePct * 100).toFixed(1) + '% — ' + report.news.gapType + (report.news.gapCapContext ? ' | ' + report.news.gapCapContext : ''));
  if (report.news.earningsGap && !(opts.plainText && opts.analysisGaps !== undefined)) push('  Earnings-linked, EPS surprise ' + (report.news.earningsGap.epsSurprisePct != null ? report.news.earningsGap.epsSurprisePct.toFixed(1) + '%' : 'n/a'));
  if (report.news.reverseSplit) push('  ' + report.news.reverseSplit.read);
  if (report.news.squeezeSetup) push('  ' + report.news.squeezeSetup.read);
  if (report.news.shortInterestNote) push('  (gap) ' + report.news.shortInterestNote);
  push('');
  push('6. TECHNIQUE: ' + report.technique.tag);
  report.technique.evidence.forEach((e) => push('  - ' + e));
  push('');
  push('7. RISK-SIZED POSITION RECOMMENDATION');
  report.risk.evidence.forEach((e) => push('  - ' + e));
  push('');
  push('8. MACRO CONTEXT');
  report.macro.evidence.forEach((e) => push('  - ' + e));
  push('');
  push('9. FINAL SYNTHESIS: ' + report.synthesis.netRead);
  report.synthesis.bullish.forEach((b) => push('  [+] ' + b));
  report.synthesis.cautionary.forEach((c) => push('  [-] ' + c));

  if (report.institutional13F) {
    push('');
    push('10. INSTITUTIONAL HOLDINGS (13F — Berkshire/BlackRock/Vanguard/State Street)');
    Object.entries(report.institutional13F).forEach(([name, q]) => {
      const latestPos = q.latest && q.latest.holdings;
      const priorPos = q.prior && q.prior.holdings;
      if (!latestPos && !priorPos) return;
      if (latestPos && priorPos) {
        const pct = (latestPos.shares - priorPos.shares) / priorPos.shares * 100;
        push('  - ' + name + ': ' + latestPos.shares.toLocaleString() + ' shares ($' + (latestPos.value / 1e6).toFixed(1) + 'M), ' + (pct >= 0 ? '+' : '') + pct.toFixed(1) + '% vs prior qtr (' + q.latest!.date + ')');
      } else if (latestPos) {
        push('  - ' + name + ': ' + latestPos.shares.toLocaleString() + ' shares ($' + (latestPos.value / 1e6).toFixed(1) + 'M), no prior-qtr comparison (' + q.latest!.date + ')');
      } else {
        push('  - ' + name + ': held ' + priorPos!.shares.toLocaleString() + ' shares as of prior qtr (' + q.prior!.date + '), not in latest filing');
      }
    });
  }

  return lines.join('\n');
}
