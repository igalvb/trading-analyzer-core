/**
 * The v6.1-style SHORT / LONG / fundamentals signal engine behind the
 * dashboard's signal tables, ported exactly from fullStockAnalysisV10_9.gs:
 *   categoryOfV7_ :4565-4572, scoreAllSignalsV7_ :4574-5020,
 *   doubleTopBottomMarketCapContextV7 :8695-8703, shortSqueezeSetupV7 :9172-9178
 *
 * Distinct from the tech score (techPlan/scoring.ts): this produces the
 * per-signal rows, the category scores with regime-adaptive weights, the
 * short/long/fundamental scores, the trend-vs-momentum conflict damping and
 * the two convictions the dashboard prints. Only buildDashboardV7 (:3459)
 * calls it.
 *
 * The guarded fallback `readBrokerDataCacheV1_(chart.ticker)` (:4821) is the
 * required `readBrokerData` dependency (production: storage/macroCaches.ts
 * readBrokerDataCache) -- always called when no short-interest value was
 * passed in, as the standing rule requires.
 *
 * Date#toDateString() (lock-up and reverse-split rows) is printed in the
 * script's zone.
 */

import { dateStringInTz } from './macroRegime.ts';
import { floatTier } from './fundamentalScore.ts';
import { LEVEL_TOLERANCE } from './indicators/slices.ts';
import { recentSrLevels } from './indicators/srLevels.ts';

export interface Signal {
  readonly name: string;
  readonly signal: number;
  readonly display: string;
  readonly weight: number;
  readonly note: string;
  readonly cat: string;
}

/** categoryOfV7_ (:4565-4572): a signal's category, by its name. */
export function categoryOf(name: string): string {
  if (/SMA|EMA|Cross|ADX|Gann|Relative Strength|Aroon|Donchian|Parabolic SAR|SuperTrend|Ichimoku/i.test(name)) return 'Trend';
  if (/RSI|MACD|Stochastic|Williams|CCI|MFI|ROC|Momentum|Divergence|Bollinger/i.test(name)) return 'Momentum';
  if (/Volume|OBV|CMF/i.test(name)) return 'Volume';
  if (/ATR/i.test(name)) return 'Volatility';
  if (/52wk|Fib/i.test(name)) return 'Position';
  return 'Other';
}

export interface DoubleTopBottomCapContext {
  readonly tier: string;
  readonly expectedReliability: string;
  readonly roundTripBars: number | null;
  readonly note: string;
}

/** doubleTopBottomMarketCapContextV7 (:8695-8703): the broker course's large- vs small-cap read of a double top/bottom. */
export function doubleTopBottomMarketCapContext(patternType: string, marketCap: number | null | undefined, roundTripBars: number | null | undefined): DoubleTopBottomCapContext | null {
  if (!marketCap || (patternType !== 'DOUBLE_TOP' && patternType !== 'DOUBLE_BOTTOM')) return null;
  const tier = marketCap >= 200e9 ? 'Mega' : marketCap >= 10e9 ? 'Large' : marketCap >= 2e9 ? 'Mid' : marketCap >= 300e6 ? 'Small' : 'Micro';
  const isLarge = tier === 'Mega' || tier === 'Large';
  const note = isLarge
    ? tier + '-cap — the course flags large-cap double-top/bottom patterns as rarer and, when they do occur, typically producing a smaller reversal'
    : tier + '-cap — the course flags small/speculative-cap double-top/bottom patterns as more common, often with a larger, more explosive reversal (especially with a fast round-trip)';
  return { tier, expectedReliability: isLarge ? 'lower-frequency, smaller-magnitude' : 'higher-frequency, larger-magnitude', roundTripBars: roundTripBars != null ? roundTripBars : null, note };
}

export interface ShortSqueezeSetup {
  readonly triggered: boolean;
  readonly shortPctOfFloat: number;
  readonly atNewHigh: boolean;
}

/** shortSqueezeSetupV7 (:9172-9178): short interest > 20% of float at (within 3% of) a 52-week high. */
export function shortSqueezeSetup(shortPctOfFloat: number | null | undefined, currentPrice: number | null | undefined, high52: number | null | undefined): ShortSqueezeSetup | null {
  if (shortPctOfFloat == null || currentPrice == null || high52 == null) return null;
  const SQUEEZE_MIN_SHORT_PCT = 0.20;
  const atNewHigh = currentPrice >= high52 * (1 - LEVEL_TOLERANCE);
  const triggered = shortPctOfFloat > SQUEEZE_MIN_SHORT_PCT && atNewHigh;
  return { triggered, shortPctOfFloat, atNewHigh };
}

export interface ShortInterestInput {
  readonly shortInterest: number | null;
  readonly daysToCover?: number | null;
  readonly settlementDate?: string | null;
}

export interface CategoryScore {
  readonly signal: number;
  readonly score: number;
  readonly count: number;
}

export interface Conflict {
  readonly conflict: boolean;
  readonly note: string;
}

export interface SignalScores {
  readonly shortSignals: Signal[];
  readonly longSignals: Signal[];
  readonly fundSignals: Signal[];
  readonly shortScore: number;
  readonly longScore: number;
  readonly fundScore: number | null;
  readonly shortW: Readonly<Record<string, number>>;
  readonly longW: Readonly<Record<string, number>>;
  readonly regimeUsedForWeights: string;
  readonly usedDefaultWeights: boolean;
  readonly shortCats: Record<string, CategoryScore>;
  readonly longCats: Record<string, CategoryScore>;
  readonly shortConflict: Conflict;
  readonly longConflict: Conflict;
  readonly divergence: unknown;
  readonly macdDivergence: unknown;
  readonly obvDivergence: unknown;
  readonly rs: unknown;
  readonly shortVerdict: string;
  readonly longVerdict: string;
  readonly fundVerdict: string;
  readonly shortConviction: number;
  readonly longConviction: number;
}

export interface SignalScoringDeps {
  /** The script's zone (Date#toDateString rows). */
  readonly timeZone: string;
  /** readBrokerDataCacheV1_(ticker): the cached short interest when none was passed in. */
  readonly readBrokerData: (ticker: string) => Promise<{ readonly shortInterest: number | null; readonly daysToCover: number | null; readonly settlementDate: string | null } | null>;
  /**
   * D8 (display only; unset = legacy text): the share of today's session behind the last bar when that bar is still
   * live (core/marketSession.ts liveBarFraction), null when the bar is a complete day. With `plainText`, 'Volume vs 20d'
   * shows today's volume so far AND its full-day pace, and the note reads from the pace; a ratio under 0.7 is
   * 'Low volume', not 'Normal volume'. The SIGNAL value (the score input) is unchanged.
   */
  readonly liveBarFraction?: number | null;
  readonly plainText?: boolean;
}

const SHORT_WEIGHTS_BY_REGIME: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  TREND_UP: { Momentum: 0.40, Trend: 0.25, Volume: 0.20, Volatility: 0.10, Position: 0.05 },
  TREND_DOWN: { Momentum: 0.40, Trend: 0.25, Volume: 0.20, Volatility: 0.10, Position: 0.05 },
  CHOP: { Momentum: 0.25, Volume: 0.25, Trend: 0.15, Volatility: 0.25, Position: 0.10 },
  HIGH_VOL: { Momentum: 0.25, Volume: 0.20, Trend: 0.15, Volatility: 0.35, Position: 0.05 },
  DEFAULT: { Momentum: 0.35, Volume: 0.25, Trend: 0.20, Volatility: 0.15, Position: 0.05 },
};
const LONG_WEIGHTS_BY_REGIME: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  TREND_UP: { Trend: 0.50, Momentum: 0.25, Volume: 0.12, Position: 0.08, Volatility: 0.05 },
  TREND_DOWN: { Trend: 0.50, Momentum: 0.25, Volume: 0.12, Position: 0.08, Volatility: 0.05 },
  CHOP: { Trend: 0.30, Volume: 0.25, Momentum: 0.15, Position: 0.20, Volatility: 0.10 },
  HIGH_VOL: { Trend: 0.35, Volatility: 0.25, Momentum: 0.15, Volume: 0.15, Position: 0.10 },
  DEFAULT: { Trend: 0.45, Momentum: 0.20, Volume: 0.15, Position: 0.12, Volatility: 0.08 },
};

const PATTERN_SCORE_RULES_V9_50: Readonly<Record<string, { readonly signal: number; readonly regime: string | null }>> = {
  DOUBLE_BOTTOM: { signal: -1, regime: null }, RECTANGLE: { signal: -1, regime: null }, TRIPLE_TOP: { signal: -1, regime: null },
  BEAR_FLAG: { signal: -1, regime: 'CHOP' }, BEAR_TRAP: { signal: 1, regime: 'CHOP' }, BULL_TRAP: { signal: 1, regime: 'HIGH_VOL' },
  DOUBLE_TOP: { signal: -1, regime: 'CHOP' }, INVERSE_HEAD_AND_SHOULDERS: { signal: -1, regime: 'TREND_UP' },
  ROUNDING_TOP: { signal: -1, regime: 'TREND_DOWN' },
};

/**
 * D8 (plain text): the 'Volume vs 20d' reading and note. While today's bar is still live (`fraction` = share of the
 * session elapsed), today's volume is also shown at its full-day pace (volume / fraction) and the note reads from the
 * pace; a ratio under 0.7 is 'Low volume'. Display only -- the signal value stays legacy's (raw ratio).
 */
export function volumeVs20dText(volRatio: number, fraction: number | null): { display: string; note: string } {
  const live = fraction != null && fraction > 0;
  const pace = live ? volRatio / (fraction as number) : volRatio;
  const word = pace > 1.5 ? 'High volume' : pace < 0.7 ? 'Low volume' : 'Normal volume';
  if (live) {
    return {
      display: volRatio.toFixed(2) + 'x so far (' + Math.round((fraction as number) * 100) + '% of the session) — on pace for ' + pace.toFixed(2) + 'x',
      note: word + ' pace (market open: today\'s volume scaled to a full day; the score uses the raw ratio)',
    };
  }
  return { display: volRatio.toFixed(2) + 'x' + (volRatio > 1.5 ? ' HIGH' : volRatio < 0.7 ? ' LOW' : ''), note: pace > 1.5 ? 'High volume confirms move' : word };
}

/**
 * scoreAllSignalsV7_ (:4574-5020). `ind` is the full indicator object
 * enriched by the analysis run (dark pool, macro supplemental, Dow theory,
 * Evaluative Index, player mapping, zombie / dilution screens, RS ranking);
 * `fund` the merged fundamentals or null; `regime` the tech plan's regime.
 */
export async function scoreAllSignals(
  deps: SignalScoringDeps, ind: any, fund: any, gann: any, chart: any, regime: string | null | undefined, existingShortInterest?: ShortInterestInput | null,
): Promise<SignalScores> {
  const shortSignals: Signal[] = [], longSignals: Signal[] = [], fundSignals: Signal[] = [];
  const addS = (n: string, s: number, d: string, w: number, note?: string): void => { shortSignals.push({ name: n, signal: s, display: d, weight: w, note: note || '', cat: categoryOf(n) }); };
  const addL = (n: string, s: number, d: string, w: number, note?: string): void => { longSignals.push({ name: n, signal: s, display: d, weight: w, note: note || '', cat: categoryOf(n) }); };
  const addF = (n: string, s: number, d: string, w: number, note?: string): void => { fundSignals.push({ name: n, signal: s, display: d, weight: w, note: note || '', cat: 'Valuation' }); };
  const tz = deps.timeZone;

  addS('RSI(14)', ind.rsi14 < 30 ? 1 : ind.rsi14 > 70 ? -1 : ind.rsi14 > 55 ? 0.5 : ind.rsi14 < 45 ? -0.5 : 0, ind.rsi14.toFixed(1) + (ind.rsi14 < 30 ? ' OVERSOLD' : ind.rsi14 > 70 ? ' OVERBOUGHT' : ''), 3, ind.rsi14 < 30 ? 'Oversold — bounce likely' : ind.rsi14 > 70 ? 'Overbought — pullback risk' : ind.rsi14 > 55 ? 'Firm — bullish momentum' : ind.rsi14 < 45 ? 'Soft — mild weakness' : 'Neutral zone');
  addS('MACD Histogram', ind.histogram > 0 && ind.histSlope > 0 ? 1 : ind.histogram < 0 && ind.histSlope < 0 ? -1 : ind.histogram > 0 ? 0.5 : -0.5, ind.macdVal.toFixed(2) + ' / sig ' + ind.sigVal.toFixed(2), 3, ind.histogram > 0 ? 'Above signal — bullish' : 'Below signal — bearish');
  addS('Stochastic %K/%D', ind.stochK < 20 ? 1 : ind.stochK > 80 ? -1 : ind.stochK > ind.stochD ? 0.5 : -0.5, '%K=' + ind.stochK.toFixed(1) + '  %D=' + ind.stochD.toFixed(1), 2, ind.stochK < 20 ? 'Oversold' : ind.stochK > 80 ? 'Overbought' : 'Momentum: ' + (ind.stochK > ind.stochD ? 'rising' : 'falling'));
  addS('Bollinger %B', ind.bbPctB < 0.05 ? 1 : ind.bbPctB > 0.95 ? -1 : ind.bbPctB < 0.35 ? 0.5 : ind.bbPctB > 0.65 ? -0.5 : 0, '%B=' + (ind.bbPctB * 100).toFixed(1) + '%  W=' + (ind.bbWidth * 100).toFixed(1) + '%', 2, ind.bbSqueeze ? 'Squeeze — breakout imminent' : ind.bbPctB > 0.95 ? 'Near upper band' : ind.bbPctB < 0.05 ? 'Near lower band' : 'Mid-band');
  addS('Williams %R', ind.willR < -80 ? 1 : ind.willR > -20 ? -1 : ind.willR < -50 ? 0.5 : -0.5, ind.willR.toFixed(1), 2, ind.willR < -80 ? 'Oversold' : ind.willR > -20 ? 'Overbought' : 'Neutral');
  addS('CCI(20)', ind.cci20 > 100 ? 1 : ind.cci20 < -100 ? -1 : ind.cci20 > 0 ? 0.3 : -0.3, ind.cci20.toFixed(1), 2, ind.cci20 > 100 ? 'Strong upward momentum' : ind.cci20 < -100 ? 'Strong downward momentum' : 'Neutral');
  addS('MFI(14)', ind.mfi14 < 20 ? 1 : ind.mfi14 > 80 ? -1 : ind.mfi14 > 55 ? 0.5 : ind.mfi14 < 45 ? -0.5 : 0, ind.mfi14.toFixed(1) + (ind.mfi14 < 20 ? ' OVERSOLD' : ind.mfi14 > 80 ? ' OVERBOUGHT' : ''), 2, ind.mfi14 < 20 ? 'Money flowing in' : ind.mfi14 > 80 ? 'Overbought flow' : 'Balanced');
  if (ind.aroonUp != null && ind.aroonDown != null) addS('Aroon(25)', (ind.aroonUp > 70 && ind.aroonDown < 30) ? 1 : (ind.aroonDown > 70 && ind.aroonUp < 30) ? -1 : ind.aroonUp > ind.aroonDown ? 0.5 : ind.aroonDown > ind.aroonUp ? -0.5 : 0, 'Up=' + ind.aroonUp.toFixed(0) + ' Down=' + ind.aroonDown.toFixed(0), 2, (ind.aroonUp > 70 && ind.aroonDown < 30) ? 'Strong uptrend' : (ind.aroonDown > 70 && ind.aroonUp < 30) ? 'Strong downtrend' : 'No dominant trend');
  if (ind.donchianUpper != null) { const dcPctB = (ind.last - ind.donchianLower) / ((ind.donchianUpper - ind.donchianLower) || 1); addS('Donchian(20)', dcPctB > 0.95 ? 1 : dcPctB < 0.05 ? -1 : dcPctB > 0.65 ? 0.5 : dcPctB < 0.35 ? -0.5 : 0, '$' + ind.donchianLower.toFixed(2) + ' – $' + ind.donchianUpper.toFixed(2), 2, dcPctB > 0.95 ? 'At/near 20d high — breakout zone' : dcPctB < 0.05 ? 'At/near 20d low — breakdown zone' : 'Mid-channel'); }
  if (ind.donchian55Upper != null) { addS('Donchian(55) [Turtle System 2 — informational, not scored]', 0, '$' + ind.donchian55Lower.toFixed(2) + ' – $' + ind.donchian55Upper.toFixed(2), 0, 'Appendix E, Original Turtle Trading System — the book\'s own parallel 55-day breakout channel, the real "Failsafe" level. Cross-reference only; not yet backtested, not scored.'); }
  if (ind.parabolicSAR != null) addS('Parabolic SAR', ind.parabolicSARBullish ? 1 : -1, '$' + ind.parabolicSAR.toFixed(2), 2, ind.parabolicSARBullish ? 'Below price — uptrend' : 'Above price — downtrend');
  if (ind.superTrend != null) addS('SuperTrend', ind.superTrendBullish ? 1 : -1, '$' + ind.superTrend.toFixed(2), 2, ind.superTrendBullish ? 'Below price — uptrend' : 'Above price — downtrend');
  if (ind.senkouSpanA != null) addS('Ichimoku Cloud', ind.ichimokuCloudBullish === true ? 1 : ind.ichimokuCloudBullish === false ? -1 : 0, ind.ichimokuCloudBullish === true ? 'Price above cloud' : ind.ichimokuCloudBullish === false ? 'Price below cloud' : 'Price inside cloud', 2, ind.ichimokuCloudBullish === true ? 'Bullish — trend support below' : ind.ichimokuCloudBullish === false ? 'Bearish — trend resistance above' : 'No clear trend (inside cloud)');
  {
    const vDir = ind.last > (ind.sma20 || 0) ? 1 : ind.last < (ind.sma20 || 0) ? -1 : 0;
    const volSig = ind.volRatio > 1.5 ? vDir : (ind.volRatio > 1.2 ? 0.3 * vDir : 0);
    if (deps.plainText) {
      const row = volumeVs20dText(ind.volRatio, deps.liveBarFraction ?? null);
      addS('Volume vs 20d', volSig, row.display, 2, row.note);
    } else addS('Volume vs 20d', volSig, ind.volRatio.toFixed(2) + 'x' + (ind.volRatio > 1.5 ? ' HIGH' : ''), 2, ind.volRatio > 1.5 ? 'High volume confirms move' : 'Normal volume');
  }
  addS('OBV (10d)', ind.obvShortSlope > 0 ? 1 : ind.obvShortSlope < 0 ? -1 : 0, ind.obvShortSlope > 0 ? 'Rising' : 'Falling', 2, 'Volume flow direction');
  addS('Price vs SMA20', ind.pctFromSma20 == null ? 0 : (ind.pctFromSma20 > 2 ? 1 : ind.pctFromSma20 < -2 ? -1 : ind.pctFromSma20 > 0 ? 0.5 : -0.5), ind.pctFromSma20 == null ? 'N/A — insufficient history' : (ind.pctFromSma20 > 0 ? '+' : '') + ind.pctFromSma20.toFixed(2) + '%  SMA=' + ind.sma20.toFixed(2), ind.pctFromSma20 == null ? 0 : 2, ind.pctFromSma20 == null ? '<20 days history' : (ind.pctFromSma20 > 0 ? 'Above' : 'Below') + ' 20MA');
  addS('EMA9/EMA21', (ind.ema9 || 0) > (ind.ema21 || 0) ? 1 : -1, (ind.ema9 || 0).toFixed(2) + ' / ' + (ind.ema21 || 0).toFixed(2), 2, (ind.ema9 || 0) > (ind.ema21 || 0) ? 'Fast EMA above slow' : 'Fast EMA below slow');
  addS('CMF(20)', ind.cmf20 > 0.1 ? 1 : ind.cmf20 < -0.1 ? -1 : ind.cmf20 > 0 ? 0.3 : -0.3, ind.cmf20.toFixed(3), 2, ind.cmf20 > 0.1 ? 'Buying pressure' : ind.cmf20 < -0.1 ? 'Selling pressure' : 'Balanced');
  addS('ROC(10)', ind.roc10 > 3 ? 1 : ind.roc10 < -3 ? -1 : ind.roc10 > 0 ? 0.3 : -0.3, (ind.roc10 > 0 ? '+' : '') + ind.roc10.toFixed(2) + '%', 1, '10-day momentum');
  addS('Momentum Divergence (RSI)', ind.divergence.type === 'bullish' ? 1 : ind.divergence.type === 'bearish' ? -1 : 0, ind.divergence.type === 'none' ? 'None' : ind.divergence.type.toUpperCase(), 3, ind.divergence.note);

  addL('Price vs SMA200', ind.pctFromSma200 == null ? 0 : (ind.pctFromSma200 > 5 ? 1 : ind.pctFromSma200 < -5 ? -1 : ind.pctFromSma200 > 0 ? 0.5 : -0.5), ind.pctFromSma200 == null ? 'N/A — insufficient history' : (ind.pctFromSma200 > 0 ? '+' : '') + ind.pctFromSma200.toFixed(2) + '%  SMA=' + ind.sma200.toFixed(2), ind.pctFromSma200 == null ? 0 : 4, ind.sma200 == null ? '<200 days history' : 'Primary trend: ' + (ind.above200 ? 'BULLISH' : 'BEARISH'));
  addL('Golden/Death Cross', ind.goldenCross ? 1 : ind.deathCross ? -1 : (ind.sma200 == null ? 0 : (ind.sma50 > ind.sma200 ? 0.5 : -0.5)), ind.goldenCross ? '🌟 GOLDEN CROSS' : ind.deathCross ? '☠️ DEATH CROSS' : (ind.sma200 == null ? 'N/A — insufficient history' : (ind.sma50 > ind.sma200 ? 'Bullish align' : 'Bearish align')), ind.sma200 == null && !ind.goldenCross && !ind.deathCross ? 0 : 4, 'SMA50=' + (ind.sma50 || 0).toFixed(2) + '  SMA200=' + (ind.sma200 != null ? ind.sma200.toFixed(2) : 'N/A'));
  {
    const bcSig = ind.breakoutContext === 'long-term downtrend — weaker breakout context' ? 0.5
      : (ind.breakoutContext === 'near 52wk/ATH — favorable breakout context' && regime === 'CHOP') ? -1
      : (ind.breakoutContext === 'neutral' && regime === 'TREND_DOWN') ? -1
      : 0;
    addL('Breakout Context', bcSig, ind.breakoutContext, bcSig !== 0 ? 1 : 0, 'from broker course ep.3 — ATH breakouts run harder than downtrend-resistance breakouts');
  }
  if (ind.climaxVolume) addL('Climax Volume', 0, '⚠ Possible distribution — high-volume down day after an extended advance', 0, 'from broker course ep.4 — Wyckoff-style exhaustion signal');
  if (ind.progressiveStopFlag) addL('Progressive Stop Trigger', 0, '⚠ ' + ind.progressiveStopFlag.volumeRatio.toFixed(1) + 'x avg volume on an up day after an established uptrend — Edwards & Magee Ch27 real trigger to tighten the stop for the day', 0, 'informational, not scored — see the Basing Point stop section for the tight level');
  if (ind.wyckoffSchematic) { const wy = ind.wyckoffSchematic; const wySig = wy.phase === 'ACCUMULATION' ? (wy.stage === 'LPS/LPSY' ? 1 : wy.stage === 'SOS/SOW' ? 0.75 : wy.stage === 'SPRING/UPTHRUST' ? 0.5 : 0.25) : (wy.stage === 'LPS/LPSY' ? -1 : wy.stage === 'SOS/SOW' ? -0.75 : wy.stage === 'SPRING/UPTHRUST' ? -0.5 : -0.25); addL('Wyckoff Schematic', 0, wy.read, 0, 'Real stage reached: ' + wy.stage + ' (' + wySig.toFixed(2) + ' directional lean, not scored)'); }
  if (ind.trendAlignedVolume) { const tav = ind.trendAlignedVolume; addL('Trend-Aligned Volume', 0, (tav.aligned ? 'Aligned' : 'NOT aligned') + ' — ' + tav.trendDir + ' trend, avg up-day vol ' + (tav.avgUpDayVolume / 1e6).toFixed(1) + 'M vs down-day ' + (tav.avgDownDayVolume / 1e6).toFixed(1) + 'M', 0, 'Schabacker Study VIII — volume should run higher WITH the trend; not scored'); }
  if (ind.darkPoolShare) { const dp = ind.darkPoolShare; addL('Dark Pool Share', 0, (dp.darkPoolSharePct * 100).toFixed(1) + '% of ~weekly volume — FINRA week of ' + dp.weekStartDate + ' (' + dp.tier + ')' + (dp.elevated ? ' ⚠ elevated vs ~12-15% typical market-wide baseline' : ''), 0, 'FINRA OTC Transparency ATS data — real off-exchange volume, reasoned elevated threshold (20%), not backtested for this watchlist'); }
  if (ind.macroSupplemental) { const ms = ind.macroSupplemental; const parts: string[] = []; if (ms.yieldCurveSpread != null) parts.push('10Y-2Y yield curve: ' + ms.yieldCurveSpread.toFixed(2) + ' (' + (ms.yieldCurveInverted ? '⚠ INVERTED' : 'normal') + ', as of ' + ms.yieldCurveAsOfDate + ')'); if (ms.m2YoyGrowthPct != null) parts.push('M2 money supply YoY: ' + ms.m2YoyGrowthPct.toFixed(1) + '% (as of ' + ms.m2AsOfDate + ')'); if (ms.businessCyclePhase) parts.push('Business-cycle phase (Broker Course ep.13): ' + ms.businessCyclePhase.phase); if (parts.length) addL('Macro Supplemental', 0, parts.join('  |  '), 0, 'Yield-curve inversion is a well-documented historical recession-leading indicator; business-cycle phase is the standard textbook 2-consecutive-negative-quarters GDP recession definition (real port from brokerCourseModelV1.gs) — informational only, not independently backtested for this classifier, not a scored vote'); }
  if (ind.dowTheoryConfirmation) { const dt = ind.dowTheoryConfirmation; const vLabel = ({ BULL_CONFIRMED: '✅ BULL CONFIRMED — both DIA & IYT at new 52wk closing highs', BEAR_CONFIRMED: '⚠ BEAR CONFIRMED — both DIA & IYT at new 52wk closing lows', NON_CONFIRMATION_BULL: '⚠ NON-CONFIRMATION — only 1 of DIA/IYT made a new high, distrust the signal', NON_CONFIRMATION_BEAR: '⚠ NON-CONFIRMATION — only 1 of DIA/IYT made a new low, distrust the signal', NEUTRAL: 'neutral — neither average at a 52wk extreme' } as Record<string, string>)[dt.verdict] || dt.verdict; const lagStr = (dt.lagTradingDays != null) ? (dt.lagTradingDays === 0 ? ', same day' : ', ' + dt.lagTradingDays + 'td lag') : ''; addL('Dow Theory Confirmation', 0, vLabel + lagStr + ' (DIA $' + dt.industrials.close.toFixed(2) + ', IYT $' + dt.transports.close.toFixed(2) + ')', 0, 'Edwards & Magee\'s own real foundational rule — both real broad-market averages must independently confirm a new high/low, within the book\'s own "days, weeks, or even a month or two" real allowed lag (v9.90/v0.13 widening, 42 trading days = 2x this book\'s own stated outer bound) — informational only, not a scored vote'); }
  if (ind.evaluativeIndex) { const ei = ind.evaluativeIndex; addL('Evaluative Index (Edwards & Magee)', 0, ei.pctStrong.toFixed(1) + '% Strong (' + ei.strong + '+/' + ei.weak + '-  of ' + (ei.strong + ei.weak) + ', ' + ei.unavailable + ' unavailable) — ' + ei.read, 0, 'Magee\'s own real continuous market-breadth gauge — "the Index will float and adjust itself continually," not a buy/sell signal — real anchors: ~5-9% = historical Bottom zone, ~90%+ = symmetric Top zone — informational only, not a scored vote'); }
  if (ind.playerMapping) { const pmap = ind.playerMapping; addL('Player Mapping (Broker Course)', 0, pmap.tag + (pmap.evidence.length ? ' — ' + pmap.evidence.join('; ') : ''), 0, 'Broker course\'s own real price/volume-SHAPE read (staircase accumulation vs. speculative spike vs. mixed/unclear) — a genuinely different angle from the real 13F institutional-holdings data above (that\'s actual filed positions; this is an inferred read off the chart shape itself) — informational only, not a scored vote'); }
  if (ind.zombieCompanyScreen) { const zc = ind.zombieCompanyScreen; addL('Zombie Company Screen (Broker Course)', 0, (zc.isZombie ? '⚠ ' : '') + zc.read, 0, 'Real interest-coverage-ratio screen — the standard academic "zombie company" definition (BIS/Fed research, interest coverage <1.0), a real independent convention, not invented for or fit to this project — informational only, not a scored vote'); }
  if (ind.sharesOutstandingTrend) { const sot = ind.sharesOutstandingTrend; addL('Shares Outstanding Trend (Broker Course)', 0, (sot.steadilyRising ? '⚠ ' : '') + sot.read, 0, 'Real SEC XBRL shares-outstanding history, course\'s own ep.12 checklist item 2 (repeated dilution red flag) — informational only, not a scored vote'); }
  if (ind.filingKeywordScreen) { const fk = ind.filingKeywordScreen; addL('Filing Keyword Screen (Broker Course)', 0, (fk.anyFound ? '⚠ ' : '') + fk.read, 0, 'Real SEC EDGAR full-text filing search, course\'s own ep.12 checklist item 3 red-flag keyword list — word presence only, not context, worth a manual read not a proven flag on its own — informational only, not a scored vote'); }
  if (ind.relativeStrengthRanking) { const rsr = ind.relativeStrengthRanking; addL('Relative Strength Ranking (Turtle System)', 0, '#' + rsr.rank + '/' + rsr.peerCount + ' in ' + rsr.categories.join('/') + ' (percentile ' + rsr.percentile + ') — ' + rsr.read, 0, 'Appendix E, Original Turtle Trading System — "buy the strongest, short the weakest" within a correlated group, real formula (CurrentPrice-PriceNMonthsAgo)/CurrentN, real peer group = this project\'s own 14-category dark-pool watchlist — cache-only (refreshed ~5:45 AM daily), informational only, not a scored vote, and never framed as a short recommendation (long-only/calls-only strategy)'); }
  if (ind.volumeProgressDivergence && ind.volumeProgressDivergence.flagged) { const vpd = ind.volumeProgressDivergence; addL('Volume/Price Divergence', 0, '⚠ High volume (' + (vpd.avgRecentVolume / 1e6).toFixed(1) + 'M vs ' + (vpd.avgBaseVolume / 1e6).toFixed(1) + 'M avg), only ' + (vpd.netProgressPct * 100).toFixed(1) + '% net price progress', 0, 'Schabacker Study VIII — heavy volume with little progress suggests resistance/distribution being absorbed; not scored'); }
  if (ind.trendMaturity) {
    const tm = ind.trendMaturity; const icon = tm.maturity === 'MATURE' ? '✅' : tm.maturity === 'MATURING' ? '🌿' : '🌱';
    const tmSig = (tm.maturity === 'NEW' && regime === 'TREND_DOWN') ? -1 : 0;
    addL('Trend Maturity', tmSig, icon + ' ' + tm.maturity + ' — ' + tm.monthsSinceCross.toFixed(1) + 'mo since ' + tm.direction + ' cross' + (tm.foundCross ? '' : ' (start of available history)'), tmSig !== 0 ? 1 : 0, 'from broker course ep.5 — course treats a primary trend as confirmed only after 6-9mo / 2-4 earnings reports, not on the crossover alone');
  }
  if (ind.roundNumber && ind.roundNumber.near) addL('Round Number', 0, '$' + ind.roundNumber.nearest + ' (' + (ind.roundNumber.distPct * 100).toFixed(1) + '% away)', 0, 'from broker course ep.6 — round price levels ($10/$100/etc, scaled to price) often act as real psychological S/R');
  {
    const uniqueTypes = [...new Set(((ind.chartPatterns || []) as Array<{ type: string }>).map((p) => p.type))];
    uniqueTypes.forEach((type) => {
      const rule = PATTERN_SCORE_RULES_V9_50[type];
      if (!rule) return;
      if (rule.regime && rule.regime !== regime) return;
      addL('Chart Pattern: ' + type, rule.signal, type + (rule.regime ? ' (real effect, ' + rule.regime + ' regime)' : ' (real effect, all regimes)'), 1, 'from real backtest evidence, not the broker course directly — see SIGNAL_EVIDENCE_TABLE_RESULTS.md. Contributes ' + (rule.signal > 0 ? 'bullish' : 'bearish') + ' regardless of the pattern\'s nominal textbook meaning, matching what real forward returns actually showed.');
    });
  }
  if (((ind.chartPatterns || []) as Array<{ type: string }>).some((p) => p.type === 'SCALLOP_SERIES')) {
    addL('Chart Pattern: SCALLOP_SERIES', 1, 'SCALLOP_SERIES (real effect, all regimes)', 1, 'from real backtest evidence, tests/edwards_magee_predictive_value_test.js + tests/scallop_series_power_check_test.js (2026-09-02) — fired mean fwd return 5.92% vs not-fired 2.05% (n=2198/11477, p~0), verified not a single-ticker/outlier artifact via 3 concrete checks before promoting.');
  }
  if (fund && fund.marketCap) {
    const dtb = ((ind.chartPatterns || []) as Array<{ type: string; date1: Date; date2: Date }>).find((p) => p.type === 'DOUBLE_TOP' || p.type === 'DOUBLE_BOTTOM');
    if (dtb) {
      const roundTripBars = Math.round(((dtb.date2 as unknown as number) - (dtb.date1 as unknown as number)) / 86400000);
      const cap = doubleTopBottomMarketCapContext(dtb.type, fund.marketCap, roundTripBars);
      if (cap) addL(dtb.type + ' — Market-Cap Context', 0, cap.tier + '-cap (' + cap.expectedReliability + '), ' + roundTripBars + 'd round-trip', 0, 'from broker course ep.6 — ' + cap.note);
    }
  }
  if (ind.singleCandle) addL('Candle: ' + ind.singleCandle.type, 0, ind.singleCandle.type + ' — ' + ind.singleCandle.courseDirection + ' (' + ind.singleCandle.note + ')', 0, 'from broker course ep.3/6 — single-candle classification, raw-transcript + video re-verified 2026-08-23');
  if (ind.weeklyVolatility && ind.weeklyVolatility.tier !== 'Normal') addL('Weekly Volatility', ind.weeklyVolatility.tier === 'Hot' ? 1 : -1, ind.weeklyVolatility.read, 1, 'from broker course ep.1 — raw-verified against the transcript, a real dual hot/coiled read, not a decoration');
  if (ind.monthlyVolatility && ind.monthlyVolatility.tier !== 'Normal') addL('Monthly Volatility', 0, ind.monthlyVolatility.read, 0, 'from broker course ep.1 — raw-verified against the transcript, a real dual hot/coiled read, not a decoration');
  // D10 (plain text only; weight 0, display): the levels from the last year within +/-50% of price, on the right side of it.
  let srShown = ind.srLevels;
  if (deps.plainText && ind.srLevels && chart && chart.highs && chart.lows && isFinite(ind.last)) {
    try {
      const p50 = ind.pctFromSma50;
      srShown = recentSrLevels(chart, ind.last, p50 > 0 ? 'up' : p50 < 0 ? 'down' : 'flat');
    } catch { srShown = ind.srLevels; }
    if (!srShown.resistanceLevels.length && ind.srLevels.resistanceLevels.length) addL('Resistance Level', 0, 'none above price in the last year', 0, 'swing-high clusters from the last ~252 trading days within 50% of price; none sits above today\'s price');
  }
  if (srShown && srShown.resistanceLevels.length && ind.srLevels.resistanceLevels.length) { // same row count as legacy
    const r = srShown.resistanceLevels[0];
    addL('Resistance Level', 0, '$' + r.level.toFixed(2) + ' — ' + r.tier + ' (' + r.touchCount + ' touches)' + (r.trendFavored ? ' — trend-favored' : ''), 0, 'from broker course ep.3/4 — real, spoken PRIMARY/SECONDARY/MINOR tiering + trend-conditional weighting (resistance matters more in a downtrend)');
  }
  if (deps.plainText && ind.srLevels && srShown && srShown !== ind.srLevels && !srShown.supportLevels.length && ind.srLevels.supportLevels.length) {
    addL('Support Level', 0, 'none below price in the last year', 0, 'swing-low clusters from the last ~252 trading days within 50% of price; none sits below today\'s price');
  }
  if (srShown && srShown.supportLevels.length && ind.srLevels.supportLevels.length) { // same row count as legacy
    const s = srShown.supportLevels[0];
    addL('Support Level', 0, '$' + s.level.toFixed(2) + ' — ' + s.tier + ' (' + s.touchCount + ' touches)' + (s.trendFavored ? ' — trend-favored' : ''), 0, 'from broker course ep.3/4 — real, spoken PRIMARY/SECONDARY/MINOR tiering + trend-conditional weighting (support matters more in an uptrend)');
  }
  if (ind.srMultiTimeframe && ind.srMultiTimeframe.resistance && ind.srMultiTimeframe.resistance.strength !== 'DAILY_ONLY') {
    const r = ind.srMultiTimeframe.resistance;
    addL('Resistance — Multi-Timeframe', 0, '$' + r.level.toFixed(2) + ' confirmed on ' + r.strength.replace(/_/g, ' ').replace('+', ' + ').toLowerCase(), 0, 'from broker course ep.3-5 — 5+ real worked examples (TSLA/PYPL/ZM/JWN/ANF): a level confirmed on a higher timeframe is materially stronger than the same level on daily alone');
  }
  if (ind.srMultiTimeframe && ind.srMultiTimeframe.support && ind.srMultiTimeframe.support.strength !== 'DAILY_ONLY') {
    const s = ind.srMultiTimeframe.support;
    addL('Support — Multi-Timeframe', 0, '$' + s.level.toFixed(2) + ' confirmed on ' + s.strength.replace(/_/g, ' ').replace('+', ' + ').toLowerCase(), 0, 'from broker course ep.3-5 — same multi-timeframe confluence rule as Resistance above');
  }
  if (ind.speculativeSpike && ind.speculativeSpike.isSpike) addL('Speculative Spike', 0, ind.speculativeSpike.read, 0, 'from broker course ep.1/3');
  if (ind.dpoSignature && ind.dpoSignature.triggered) addL('DPO Delayed Breakout', 0, ind.dpoSignature.read, 0, 'from broker course ep.9 — real PLTR worked example; KNOWN_DPO_TICKERS_V7 is a small, disclosed, manually-curated list, not a fetched field');
  if (ind.secondaryDay && ind.secondaryDay.triggered) addL('Secondary Day', 0, '⚡ Broke above yesterday\'s high ($' + ind.secondaryDay.yesterdayHigh.toFixed(2) + ') after a high-volume day (' + ind.secondaryDay.yesterdayVolRatio.toFixed(2) + 'x)', 0, 'from broker course ep.7 — momentum-continuation entry: a strong-volume day followed by a break above its high often draws algo/momentum traders');
  if (ind.lockupExpiration) {
    const lu = ind.lockupExpiration;
    addL('Lock-up Expiration', 0, (lu.status === 'UPCOMING' ? '⏳ Insider lock-up expires in ' + lu.daysUntilExpiration + 'd' : '✅ Insider lock-up expired ' + Math.abs(lu.daysUntilExpiration) + 'd ago') + ' (' + dateStringInTz(lu.lockupDate, tz) + ')', 0, 'from broker course ep.8/9 — typical ~180-day post-IPO insider/employee selling restriction; a real, timeable event, not itself scored');
  }
  if (ind.recentReverseSplit) {
    const rs = ind.recentReverseSplit;
    addL('Reverse Split', 0, '⚠ ' + rs.ratio + ' reverse split ' + rs.daysAgo + 'd ago (' + dateStringInTz(rs.date, tz) + ')', 0, 'from broker course ep.10 — instructor\'s own real avoid-heuristic: recently reverse-split tickers show elevated manipulation/volatility risk, he removes them from his own watchlist');
  }
  let shortInterestData: ShortInterestInput | null;
  if (existingShortInterest !== undefined) {
    shortInterestData = existingShortInterest;
  } else {
    const cached = await deps.readBrokerData(chart.ticker);
    shortInterestData = (cached && cached.shortInterest != null) ? { shortInterest: cached.shortInterest, daysToCover: cached.daysToCover, settlementDate: cached.settlementDate } : null;
  }
  const shortPctOfFloat = (shortInterestData && fund && fund.shareFloat) ? (shortInterestData.shortInterest as number) / fund.shareFloat : null;
  const squeezeSetup = shortSqueezeSetup(shortPctOfFloat, ind.last, ind.high52);
  if (squeezeSetup && squeezeSetup.triggered) addL('Short Squeeze Setup', 0, '🔥 High short interest (' + ((shortPctOfFloat as number) * 100).toFixed(1) + '% of float) breaking to a NEW HIGH', 0, 'from broker course ep.9, reinforced live in ep.13\'s real GME case study — explicitly distinguished from mere short-covering off a low; kept because it identifies a LONG opportunity, never a short');
  addL('Price vs SMA50', ind.pctFromSma50 == null ? 0 : (ind.pctFromSma50 > 3 ? 1 : ind.pctFromSma50 < -3 ? -1 : ind.pctFromSma50 > 0 ? 0.5 : -0.5), ind.pctFromSma50 == null ? 'N/A — insufficient history' : (ind.pctFromSma50 > 0 ? '+' : '') + ind.pctFromSma50.toFixed(2) + '%  SMA=' + ind.sma50.toFixed(2), ind.pctFromSma50 == null ? 0 : 3, ind.pctFromSma50 == null ? '<50 days history' : (ind.above50 ? 'Above 50MA' : 'Below 50MA'));
  addL('ADX(14)', ind.adx14 > 25 && ind.adxBullish ? 1 : ind.adx14 > 25 && !ind.adxBullish ? -1 : ind.adxBullish ? 0.3 : -0.3, ind.adx14.toFixed(1) + (ind.adx14 > 25 ? ' TRENDING' : ' WEAK') + (ind.adxBullish ? ' (+DI>-DI)' : ' (-DI>+DI)'), 3, ind.adx14 > 40 ? 'Very strong trend' : ind.adx14 > 25 ? 'Trending' : 'Sideways');
  addL('RSI Weekly', ind.rsiWeekly < 40 ? 1 : ind.rsiWeekly > 65 ? -1 : ind.rsiWeekly > 55 ? 0.5 : ind.rsiWeekly < 45 ? -0.5 : 0, ind.rsiWeekly.toFixed(1), 3, 'Weekly: ' + (ind.rsiWeekly < 40 ? 'oversold' : ind.rsiWeekly > 65 ? 'overbought' : 'neutral'));
  addL('ROC(52) — ~13wk', ind.roc52 > 20 ? 1 : ind.roc52 < -20 ? -1 : ind.roc52 > 0 ? 0.5 : -0.5, (ind.roc52 > 0 ? '+' : '') + ind.roc52.toFixed(1) + '% (~13wk)', 2, '~13-week (quarterly) performance');
  addL('Fibonacci Level', ind.fibPct > 0.618 ? 1 : ind.fibPct < 0.382 ? -1 : ind.fibPct > 0.5 ? 0.5 : -0.5, (ind.fibPct * 100).toFixed(1) + '% of 52wk range', 2, ind.fibPct > 0.786 ? 'Near 52wk high' : ind.fibPct > 0.618 ? 'Above 61.8%' : ind.fibPct < 0.236 ? 'Near 52wk low' : ind.fibPct < 0.382 ? 'Below 38.2%' : 'Mid-range');
  addL('52wk Range', ind.range52Pct > 70 ? 1 : ind.range52Pct < 30 ? -1 : 0, ind.range52Pct.toFixed(1) + '%  H=$' + ind.high52.toFixed(2) + '  L=$' + ind.low52.toFixed(2), 2, ind.range52Pct > 80 ? 'Near 52wk high' : ind.range52Pct < 20 ? 'Near 52wk low' : 'Mid-range');
  addL('OBV (50d)', ind.obvLongSlope > 0 ? 1 : ind.obvLongSlope < 0 ? -1 : 0, ind.obvLongSlope > 0 ? 'Accumulation' : 'Distribution', 2, 'Long-term volume flow');
  addL('ATR Regime', ind.atrRatio > 1.3 ? -0.5 : ind.atrRatio < 0.7 ? 0.5 : 0, 'ATR=$' + ind.atr14.toFixed(2) + '  x' + ind.atrRatio.toFixed(2), 1, ind.atrRatio > 1.3 ? 'Expanding vol' : ind.atrRatio < 0.7 ? 'Contracting' : 'Normal');
  addL('Price vs SMA150', ind.sma150 ? (ind.last > ind.sma150 ? 0.5 : -0.5) : 0, ind.sma150 ? ((ind.last / ind.sma150 - 1) * 100 > 0 ? '+' : '') + ((ind.last / ind.sma150 - 1) * 100).toFixed(2) + '%  SMA=' + ind.sma150.toFixed(2) : 'N/A', 2, 'Intermediate MA');
  if (ind.rs) {
    const rs63 = ind.rs.rs63;
    addL('Relative Strength vs SPY', rs63 > 10 ? 1 : rs63 < -10 ? -1 : rs63 > 0 ? 0.5 : -0.5, (rs63 >= 0 ? '+' : '') + rs63.toFixed(1) + '% (3mo)  ' + (ind.rs.outperforming ? 'OUTPERFORM' : 'UNDERPERFORM'), 4, 'Stock vs S&P 500 over 3 months — ' + (ind.rs.outperforming ? 'leading the market' : 'lagging the market'));
  }
  if (ind.monthlyStructure) {
    const ms = ind.monthlyStructure;
    addL('Monthly Structure (10mo SMA)', ms.monthlyTrend === 'above' ? 0.7 : -0.7,
      '$' + ind.last.toFixed(2) + ' vs 10mo SMA $' + ms.monthlySma.toFixed(2) + ' (' + ms.monthlyTrend + ')',
      3, 'Long-term monthly trend read — the "10-month rule," based on ' + ms.monthsAvailable + ' months of history');
  }

  const gannNorm = (gann.score - 50) / 50;
  addL('📐 Gann Angular', gannNorm, gann.score + '/100  |  riding ' + gann.lowerAngle + '→' + gann.upperAngle + '  |  1×1 ' +
    (gann.gannMaster ? (gann.gannMaster < chart.currentPrice ? 'SUPPORT @ $' + gann.gannMaster.toFixed(2) : 'RESISTANCE @ $' + gann.gannMaster.toFixed(2)) : 'N/A'),
  2, 'Pivot: ' + gann.pivot.dateStr + ' @ $' + gann.pivot.price.toFixed(2) +
    '  |  price unit: $' + gann.priceUnit.toFixed(2) + '/day');

  if (fund) {
    const cp = chart.currentPrice;
    {
      const legacyPE = fund.forwardPE != null ? fund.forwardPE : fund.trailingPE;
      const legacyPEIsForward = fund.forwardPE != null;
      if (legacyPE) addF('P/E (' + (legacyPEIsForward ? 'Fwd' : 'TTM') + ')', legacyPE < 15 ? 1 : legacyPE > 40 ? -1 : legacyPE < 25 ? 0.5 : -0.3, legacyPE.toFixed(1) + 'x', 3, legacyPE < 15 ? 'Undervalued' : legacyPE > 40 ? 'Expensive' : 'Fair');
    }
    if (fund.pegRatio && fund.pegRatio > 0) addF('PEG Ratio', fund.pegRatio < 1 ? 1 : fund.pegRatio > 2 ? -1 : fund.pegRatio < 1.5 ? 0.5 : -0.3, fund.pegRatio.toFixed(2) + 'x', 2, fund.pegRatio < 1 ? 'Undervalued vs growth' : fund.pegRatio > 2 ? 'Expensive' : 'Fair');
    if (fund.revenueGrowth != null) { const rg = fund.revenueGrowth * 100; addF('Revenue Growth', rg > 20 ? 1 : rg > 10 ? 0.5 : rg > 0 ? 0 : rg > -10 ? -0.5 : -1, (rg > 0 ? '+' : '') + rg.toFixed(1) + '%', 3, rg > 20 ? 'Strong' : rg > 10 ? 'Solid' : rg > 0 ? 'Slow' : 'Declining'); }
    if (fund.earningsGrowth != null) { const eg = fund.earningsGrowth * 100; addF('EPS Growth', eg > 20 ? 1 : eg > 10 ? 0.5 : eg > 0 ? 0 : -0.5, (eg > 0 ? '+' : '') + eg.toFixed(1) + '%', 3, eg > 20 ? 'Strong EPS' : eg > 0 ? 'Positive' : 'Declining'); }
    if (fund.profitMargins != null) { const pm = fund.profitMargins * 100; addF('Net Profit Margin', pm > 15 ? 1 : pm > 5 ? 0.5 : pm > 0 ? 0 : -1, pm.toFixed(1) + '%', 2, pm > 20 ? 'Excellent' : pm > 10 ? 'Good' : pm > 0 ? 'Thin' : 'Unprofitable'); }
    if (fund.returnOnEquity != null) { const roe = fund.returnOnEquity * 100; addF('ROE', roe > 20 ? 1 : roe > 10 ? 0.5 : roe > 0 ? 0 : -0.5, roe.toFixed(1) + '%', 2, roe > 20 ? 'Excellent' : roe > 0 ? 'Moderate' : 'Negative'); }
    if (fund.targetMean && cp) {
      const up = (fund.targetMean / cp - 1) * 100; let hl = '';
      if (fund.targetHigh) hl += 'H=$' + fund.targetHigh.toFixed(2);
      if (fund.targetLow) hl += (hl ? '  ' : '') + 'L=$' + fund.targetLow.toFixed(2);
      if (fund.numAnalysts) hl += (hl ? '  ' : '') + fund.numAnalysts + ' analysts';
      addF('Analyst Target', up > 20 ? 1 : up > 5 ? 0.5 : up > -5 ? 0 : -1, '$' + fund.targetMean.toFixed(2) + '  (' + (up > 0 ? '+' : '') + up.toFixed(1) + '%)', 4, hl || 'consensus mean');
    }
    if (fund.recMean) { const rm = fund.recMean; addF('Analyst Rating', rm < 2 ? 1 : rm < 2.5 ? 0.7 : rm < 3.5 ? 0.2 : -1, fund.recKey || 'N/A', 4, ''); }
    if (fund.beta) addF('Beta', 0, fund.beta.toFixed(2) + 'x market', 0, fund.beta > 1.5 ? 'High vol' : fund.beta < 0.8 ? 'Low vol' : 'Market-like');
    if (fund.marketCap) { const mc = fund.marketCap; const tier = mc >= 200e9 ? 'Mega cap' : mc >= 10e9 ? 'Large cap' : mc >= 2e9 ? 'Mid cap' : mc >= 300e6 ? 'Small cap' : 'Micro cap'; const mcStr = mc >= 1e12 ? '$' + (mc / 1e12).toFixed(2) + 'T' : mc >= 1e9 ? '$' + (mc / 1e9).toFixed(2) + 'B' : '$' + (mc / 1e6).toFixed(0) + 'M'; addF('Market Cap', 0, mcStr, 0, tier); }
    if (fund.shareFloat) {
      const floatStr = fund.shareFloat >= 1e9 ? (fund.shareFloat / 1e9).toFixed(2) + 'B' : (fund.shareFloat / 1e6).toFixed(1) + 'M';
      const todaysVol = chart.volumes && chart.volumes.length ? chart.volumes[chart.volumes.length - 1] : null;
      let note = floatTier(fund.shareFloat) || '';
      if (todaysVol != null) {
        const volToFloat = todaysVol / fund.shareFloat;
        note += '  ·  Vol/Float ' + (volToFloat * 100).toFixed(1) + '%' + (volToFloat >= 1 ? ' ⚠ EXTREME (vol ≥ entire float)' : volToFloat >= 0.25 ? ' ⚠ elevated' : '');
      }
      addF('Float', 0, floatStr + ' shares', 0, note);
    }
    if (fund.dividend && fund.price) { const dy = fund.dividend / fund.price * 100; addF('Dividend Yield', 0, dy.toFixed(2) + '%', 0, dy > 4 ? 'High yield' : dy > 2 ? 'Solid income' : 'Pays dividend'); }
    if (fund.grossMargins != null) { const gm = fund.grossMargins * 100; addF('Gross Margin', gm > 50 ? 1 : gm > 30 ? 0.5 : gm > 15 ? 0 : -0.5, gm.toFixed(1) + '%', 1, gm > 50 ? 'High-margin' : gm > 30 ? 'Good' : 'Low'); }
    if (fund.sector) addF('Sector/Industry', 0, (fund.sector || '') + (fund.industry ? '/' + fund.industry : ''), 0, '');
  }

  const computeScore = (signals: readonly Signal[]): number => {
    let wSum = 0, wTotal = 0; signals.forEach((s) => { wSum += s.signal * s.weight; wTotal += s.weight; });
    return wTotal === 0 ? 50 : Math.min(100, Math.max(0, Math.round((wSum / wTotal + 1) / 2 * 100)));
  };
  const categoryScores = (signals: readonly Signal[], catWeights: Readonly<Record<string, number>>): { cats: Record<string, CategoryScore>; overall: number; overallSig: number } => {
    const byCat: Record<string, { wSum: number; wTot: number; count: number }> = {};
    signals.forEach((s) => {
      const c = s.cat || 'Other';
      if (!byCat[c]) byCat[c] = { wSum: 0, wTot: 0, count: 0 };
      byCat[c].wSum += s.signal * s.weight; byCat[c].wTot += s.weight; byCat[c].count++;
    });
    const cats: Record<string, CategoryScore> = {};
    Object.keys(byCat).forEach((c) => {
      const sig = byCat[c].wTot === 0 ? 0 : byCat[c].wSum / byCat[c].wTot;
      cats[c] = { signal: sig, score: Math.round((sig + 1) / 2 * 100), count: byCat[c].count };
    });
    let num = 0, den = 0;
    Object.keys(cats).forEach((c) => { const w = catWeights[c] != null ? catWeights[c] : 0.1; num += cats[c].signal * w; den += w; });
    const overallSig = den === 0 ? 0 : num / den;
    return { cats, overall: Math.min(100, Math.max(0, Math.round((overallSig + 1) / 2 * 100))), overallSig };
  };

  const shortW = SHORT_WEIGHTS_BY_REGIME[regime as string] || SHORT_WEIGHTS_BY_REGIME.DEFAULT;
  const longW = LONG_WEIGHTS_BY_REGIME[regime as string] || LONG_WEIGHTS_BY_REGIME.DEFAULT;
  const usedDefaultWeights = !SHORT_WEIGHTS_BY_REGIME[regime as string];
  const shortCatRes = categoryScores(shortSignals, shortW);
  const longCatRes = categoryScores(longSignals, longW);
  const shortScore = shortCatRes.overall;
  const longScore = longCatRes.overall;
  const fundScore = (fund && fundSignals.filter((s) => s.weight > 0).length > 0) ? computeScore(fundSignals.filter((s) => s.weight > 0)) : null;

  const conflictOf = (res: { cats: Record<string, CategoryScore> }): Conflict => {
    const t = res.cats.Trend ? res.cats.Trend.signal : 0, m = res.cats.Momentum ? res.cats.Momentum.signal : 0;
    if (t * m < 0 && Math.abs(t) > 0.25 && Math.abs(m) > 0.25) {
      return { conflict: true, note: 'Trend (' + (t > 0 ? 'up' : 'down') + ') and momentum (' + (m > 0 ? 'up' : 'down') + ') disagree — lower confidence' };
    }
    return { conflict: false, note: 'Trend and momentum broadly agree' };
  };
  const shortConflict = conflictOf(shortCatRes), longConflict = conflictOf(longCatRes);

  const fw = fundScore !== null ? 0.20 : 0, tw = 1 - fw;
  let shortConviction = Math.round(shortScore * (tw * 0.6 + 0.4) + (fundScore || 50) * fw * 0.4);
  let longConviction = Math.round(longScore * (tw * 0.5 + 0.5) + (fundScore || 50) * fw * 0.5);
  if (shortConflict.conflict) shortConviction = Math.round(shortConviction * 0.75 + 50 * 0.25);
  if (longConflict.conflict) longConviction = Math.round(longConviction * 0.8 + 50 * 0.2);
  shortConviction = Math.min(100, Math.max(0, shortConviction));
  longConviction = Math.min(100, Math.max(0, longConviction));

  const verdict = (s: number): string => (s >= 70 ? '🟢 BULLISH' : s >= 57 ? '🟡 SLIGHTLY BULLISH' : s >= 43 ? '⚪ NEUTRAL' : s >= 30 ? '🟠 SLIGHTLY BEARISH' : '🔴 BEARISH');

  return {
    shortSignals, longSignals, fundSignals,
    shortScore, longScore, fundScore,
    shortW, longW, regimeUsedForWeights: regime || 'DEFAULT', usedDefaultWeights,
    shortCats: shortCatRes.cats, longCats: longCatRes.cats,
    shortConflict, longConflict,
    divergence: ind.divergence, macdDivergence: ind.macdDivergence, obvDivergence: ind.obvDivergence, rs: ind.rs,
    shortVerdict: verdict(shortScore), longVerdict: verdict(longScore),
    fundVerdict: fundScore !== null ? verdict(fundScore) : 'N/A',
    shortConviction, longConviction,
  };
}
