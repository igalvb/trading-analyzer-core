/**
 * buildNarrativeV7_ (fullStockAnalysisV10_9.gs:5030-5121): the seven plain-English paragraphs of the dashboard's
 * narrative block, ported exactly. Pure: it reads only its arguments and returns [{ heading, body }].
 *
 * No injected dependencies. Every sentence is legacy's text, ported for parity (the oracle); the findings listed in
 * the FL-7h handback (F-H7..F-H12) are ported as they are, not repaired.
 */

import { IV_CHAIN_PCT_LABEL, putCallText } from '../../analysis/options/labels.ts';

type Num = number | null | undefined;
export interface NarrativeParagraph { readonly heading: string; readonly body: string }
export interface NarrativeChart { readonly currentPrice: number; readonly prevClose: number }
export interface NarrativeIndicators {
  readonly above200: boolean; readonly above50: boolean; readonly range52Pct: number; readonly low52: Num; readonly high52: Num;
  readonly goldenCross: boolean; readonly deathCross: boolean; readonly atr14: number; readonly rsi14: number; readonly histogram: number;
  readonly bbSqueeze: boolean; readonly bbPctB: number; readonly volRatio: number; readonly stochK: number; readonly willR: number;
  readonly adx14: number; readonly adxBullish: boolean; readonly pctFromSma200: Num; readonly pctFromSma50: Num;
  readonly rsiWeekly: number; readonly roc52: Num;
}
export interface NarrativeGann {
  readonly score: number; readonly pivot: { readonly dateStr: string; readonly price: Num }; readonly priceUnit: Num;
  readonly lowerAngle: string; readonly upperAngle: string; readonly gannMaster?: Num;
}
export interface NarrativeConfluence {
  readonly entryCenter: number; readonly entryLow: Num; readonly entryHigh: Num; readonly entryConfidence: string;
  readonly exitCenter: number; readonly exitLow: Num; readonly exitHigh: Num; readonly exitConfidence: string;
}
export interface NarrativeScores {
  readonly shortScore: number; readonly longScore: number; readonly shortVerdict: string; readonly longVerdict: string;
  readonly shortConviction: number; readonly longConviction: number;
}
export interface NarrativeFundamentals {
  readonly forwardPE?: Num; readonly trailingPE?: Num; readonly pegRatio?: Num; readonly revenueGrowth?: Num;
  readonly profitMargins?: Num; readonly returnOnEquity?: Num; readonly targetMean?: Num; readonly recKey?: string | null;
}
export interface NarrativeOptions { readonly available?: boolean; readonly confirm?: string; readonly putCallOI?: Num; readonly netBiasPct?: Num; readonly ivRank?: Num }
export interface NarrativeTechPlan { readonly techScore: number; readonly regime: string; readonly timing: string }
export interface NarrativeDecision { readonly finalConviction: number; readonly action: string }
export interface NarrativeFundResult { readonly score?: Num; readonly verdict?: string | null }

/** buildNarrativeV7_ (:5030-5121). */
export function buildNarrative(
  ticker: string, chart: NarrativeChart, ind: NarrativeIndicators, gann: NarrativeGann, confluence: NarrativeConfluence,
  scores: NarrativeScores, fund: NarrativeFundamentals | null | undefined, opts: NarrativeOptions | null | undefined,
  techPlan: NarrativeTechPlan, decision: NarrativeDecision, fundResult: NarrativeFundResult | null | undefined,
  textOpts: { readonly plainLabels?: boolean } = {},
): NarrativeParagraph[] {
  const cp = chart.currentPrice;
  const usd = (v: Num): string => (v == null || isNaN(v)) ? 'N/A' : '$' + Number(v).toFixed(2);
  const pct = (v: Num): string => (v == null || isNaN(v)) ? 'N/A' : (v >= 0 ? '+' : '') + Number(v).toFixed(1) + '%';
  const paras: NarrativeParagraph[] = [];

  const dayPct = chart.prevClose ? (cp - chart.prevClose) / chart.prevClose * 100 : 0;
  const trendLong = ind.above200 ? 'a long-term uptrend (price above its 200-day average)' : 'a long-term downtrend (price below its 200-day average)';
  const trendMid = ind.above50 ? 'above the 50-day average' : 'below the 50-day average';
  const posWord = ind.range52Pct > 80 ? 'near the top of' : ind.range52Pct < 20 ? 'near the bottom of' : 'in the middle of';
  paras.push({ heading: '1. Overview & Trend Context', body:
    ticker + ' is trading at ' + usd(cp) + ' (' + pct(dayPct) + ' on the day) and sits ' + posWord +
    ' its 52-week range (' + usd(ind.low52) + ' to ' + usd(ind.high52) + ', currently at ' + ind.range52Pct.toFixed(0) +
    '% of that range). The stock is in ' + trendLong + ' and is ' + trendMid +
    ', so the primary backdrop is ' + (ind.above200 ? 'constructive' : 'cautious') + '. ' +
    (ind.goldenCross ? 'A recent golden cross (50-day crossing above 200-day) adds a fresh bullish signal. ' :
      ind.deathCross ? 'A recent death cross (50-day crossing below 200-day) is a warning sign. ' : '') +
    'Daily volatility (ATR) is ' + usd(ind.atr14) + ', about ' + (ind.atr14 / cp * 100).toFixed(1) + '% of price.' });

  const rsiWord = ind.rsi14 < 30 ? 'oversold' : ind.rsi14 > 70 ? 'overbought' : ind.rsi14 < 45 ? 'slightly weak' : ind.rsi14 > 55 ? 'slightly firm' : 'neutral';
  const macdWord = ind.histogram > 0 ? 'above its signal line (bullish momentum)' : 'below its signal line (bearish momentum)';
  const bbWord = ind.bbSqueeze ? 'The bands are squeezing, which often precedes a sharp move. ' : ind.bbPctB > 0.95 ? 'Price is riding the upper band (stretched). ' : ind.bbPctB < 0.05 ? 'Price is pinned to the lower band (stretched down). ' : '';
  const volWord = ind.volRatio > 1.5 ? 'on notably heavy volume' : ind.volRatio < 0.7 ? 'on light volume' : 'on average volume';
  paras.push({ heading: '2. Short-Term Technical Picture (days–weeks)', body:
    'Momentum is mixed-to-' + (scores.shortScore >= 57 ? 'positive' : scores.shortScore <= 43 ? 'negative' : 'neutral') +
    '. RSI(14) is ' + ind.rsi14.toFixed(0) + ' (' + rsiWord + ') and MACD is ' + macdWord + '. ' +
    'Stochastic %K is ' + ind.stochK.toFixed(0) + ' and Williams %R is ' + ind.willR.toFixed(0) +
    ', so the fast oscillators are ' + (ind.stochK < 20 ? 'oversold' : ind.stochK > 80 ? 'overbought' : 'mid-range') + '. ' + bbWord +
    'The latest session traded ' + volWord + ' (' + ind.volRatio.toFixed(1) + 'x the 20-day average). ' +
    'Net short-term score: ' + scores.shortScore + '/100 (' + scores.shortVerdict.replace(/[^\w\s]/g, '').trim() + ').' });

  const adxWord = ind.adx14 > 40 ? 'a very strong trend' : ind.adx14 > 25 ? 'a defined trend' : 'a weak/sideways trend';
  paras.push({ heading: '3. Long-Term Technical Picture (months–years)', body:
    'ADX(14) is ' + ind.adx14.toFixed(0) + ', indicating ' + adxWord + ', currently favouring the ' +
    (ind.adxBullish ? 'bulls (+DI over -DI)' : 'bears (-DI over +DI)') + '. Price is ' + pct(ind.pctFromSma200) +
    ' versus its 200-day average and ' + pct(ind.pctFromSma50) + ' versus its 50-day. ' +
    'Weekly RSI is ' + ind.rsiWeekly.toFixed(0) + ' (' + (ind.rsiWeekly < 40 ? 'oversold' : ind.rsiWeekly > 65 ? 'overbought' : 'neutral') +
    ') and ~13-week momentum (ROC) is ' + pct(ind.roc52) + '. ' +
    'Net long-term score: ' + scores.longScore + '/100 (' + scores.longVerdict.replace(/[^\w\s]/g, '').trim() + ').' });

  const gannWord = gann.score >= 70 ? 'supportive/bullish' : gann.score >= 50 ? 'neutral' : 'unsupportive/bearish';
  paras.push({ heading: '4. Gann Angular Read', body:
    'Anchored to the swing low of ' + gann.pivot.dateStr + ' at ' + usd(gann.pivot.price) + ' (price unit ' + usd(gann.priceUnit) +
    '/day), price is currently positioned between the ' + gann.lowerAngle + ' (support) and ' + gann.upperAngle + ' (resistance) angles. ' +
    'The Gann score is driven mainly by distance from the master 1×1 line at ' + (gann.gannMaster ? usd(gann.gannMaster) : 'N/A') +
    ', which is ' + (gann.gannMaster && gann.gannMaster < cp ? 'below price and acting as support' : 'far above price and acting as resistance') +
    ' — so even though price holds the lower fan angles, sitting well below the 1×1 keeps the structural read ' + gannWord +
    ' (' + gann.score + '/100 to the long-term score).' });

  if (fund && (fundResult && fundResult.score != null)) {
    const bits: string[] = [];
    // Phase 2 fix (legacy): the same forward-else-trailing P/E preference as the scoring driver.
    const narrPE = fund.forwardPE != null ? fund.forwardPE : fund.trailingPE;
    if (narrPE) bits.push('a P/E of ' + narrPE.toFixed(0) + (narrPE > 40 ? ' (rich)' : narrPE < 15 ? ' (cheap)' : ' (fair)'));
    if (fund.pegRatio && fund.pegRatio > 0) bits.push('a PEG of ' + fund.pegRatio.toFixed(2) + (fund.pegRatio < 1 ? ' (attractive vs growth)' : fund.pegRatio > 2 ? ' (expensive vs growth)' : ''));
    if (fund.revenueGrowth != null) bits.push('revenue growth of ' + pct(fund.revenueGrowth * 100));
    if (fund.profitMargins != null) bits.push('a net margin of ' + (fund.profitMargins * 100).toFixed(1) + '%');
    if (fund.returnOnEquity != null) bits.push('ROE of ' + (fund.returnOnEquity * 100).toFixed(0) + '%');
    let targetSent = '';
    if (fund.targetMean) { const up = (fund.targetMean / cp - 1) * 100; targetSent = ' Analysts see a mean target of ' + usd(fund.targetMean) + ' (' + pct(up) + ' from here' + (fund.recKey ? ', rating ' + fund.recKey : '') + ').'; }
    paras.push({ heading: '5. Fundamental Assessment (OWN)', body:
      ticker + ' shows ' + (bits.length ? bits.join(', ') : 'limited fundamental data') + '.' + targetSent +
      ' The improved v7 OWN score is ' + fundResult.score + '/100 (' + (fundResult.verdict || '').replace(/[^\w\s]/g, '').trim() +
      '), so business quality and valuation are ' + (fundResult.score >= 57 ? 'a tailwind' : fundResult.score <= 43 ? 'a headwind' : 'roughly neutral') + ' for the thesis.' });
  } else {
    paras.push({ heading: '5. Fundamental Assessment (OWN)', body:
      'No fundamental data was available for this run (see the 🔬 Log for the exact API result), so the verdict rests on technical and Gann signals only.' });
  }

  const entryUp = (confluence.entryCenter / cp - 1) * 100, exitUp = (confluence.exitCenter / cp - 1) * 100;
  paras.push({ heading: '6. Entry & Exit Zones', body:
    'Combining independent methods, the buy-the-dip ENTRY zone clusters around ' + usd(confluence.entryLow) + '–' + usd(confluence.entryHigh) +
    ' (center ' + usd(confluence.entryCenter) + ', ' + pct(entryUp) + ' from here) with ' + confluence.entryConfidence + '. ' +
    (entryUp < -2 ? 'That implies waiting for a pullback before adding. ' : 'That is close to the current price, so entries look reasonable now or on minor weakness. ') +
    'The longer-term EXIT/target zone clusters around ' + usd(confluence.exitLow) + '–' + usd(confluence.exitHigh) +
    ' (center ' + usd(confluence.exitCenter) + ', ' + pct(exitUp) + ' upside) with ' + confluence.exitConfidence +
    ', a sensible area to scale out.' });

  let optSent = 'No options snapshot was loaded, so smart-money positioning is not factored into the Final Conviction yet.';
  if (opts && opts.available) {
    optSent = 'Options positioning ' + (opts.confirm === 'confirm' ? 'CONFIRMS the chart (added to conviction)' : opts.confirm === 'conflict' ? 'CONFLICTS with the chart (subtracted from conviction)' : 'is roughly neutral') +
      (textOpts.plainLabels
        // D4 / B3 (fix plan 2026-10-30): the same words as every other page.
        ? ' — put/call OI (whole chain) ' + putCallText(opts.putCallOI) + ', net $ ' + (opts.netBiasPct != null ? ((opts.netBiasPct > 0 ? '+' : '') + opts.netBiasPct + '%') : 'N/A') + ', ' + IV_CHAIN_PCT_LABEL + ' ' + (opts.ivRank != null ? opts.ivRank + 'th' : 'N/A') + '.'
        : ' — Put/Call OI ' + (opts.putCallOI != null ? opts.putCallOI.toFixed(2) : 'N/A') + ', net $ ' + (opts.netBiasPct != null ? ((opts.netBiasPct > 0 ? '+' : '') + opts.netBiasPct + '%') : 'N/A') + ', IV ' + (opts.ivRank != null ? opts.ivRank + 'th %ile' : 'N/A') + '.');
  }
  paras.push({ heading: '7. Bottom Line', body:
    'The pure OWN score (business only) is ' + (fundResult && fundResult.score != null ? fundResult.score + '/100' : 'N/A') +
    ' and the pure BUY-TIMING score (chart only) is ' + techPlan.techScore + '/100 in a ' + techPlan.regime + ' regime (' + techPlan.timing + '). ' +
    optSent + ' Combined, the options-adjusted FINAL CONVICTION is ' + decision.finalConviction + '/100 → ' + decision.action + '. ' +
    'For reference, the v6.1 dual-timeframe read is short ' + scores.shortConviction + '/100 and long ' + scores.longConviction +
    '/100. Treat these zones as a plan, not a guarantee — always size positions to your own risk tolerance.' });

  return paras;
}
