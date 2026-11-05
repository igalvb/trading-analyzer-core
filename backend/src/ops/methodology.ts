/**
 * buildMethodologySheetV7 (fullStockAnalysisV10_9.gs:5446-5527): the static
 * '📖 Methodology' reference tab. The section/entry text is data
 * (METHODOLOGY_SECTIONS: 6 sections, 49 entries, extracted from the legacy
 * calls and parity-tested against the oracle's call log); the write sequence
 * is legacy's, call for call.
 */

import type { ReportWorkbook } from '../sheets/reportSheet.ts';
import { IV_CHAIN_PCT_LABEL, IV_CHAIN_PCT_MEANING, MIN_DAYS_FOR_IV_CONTEXT, PUT_CALL_BANDS_TEXT, PUT_CALL_LABEL } from '../analysis/options/labels.ts';

export const METHODOLOGY_TAB = '📖 Methodology';

export type MethodologyEntry = readonly [name: string, description: string, note: string];

export interface MethodologySection {
  readonly title: string;
  readonly color: string;
  readonly entries: readonly MethodologyEntry[];
}

export const METHODOLOGY_SECTIONS: readonly MethodologySection[] = [
  {
    title: '📋 Price / Entry-Exit Methods', color: '#37474f',
    entries: [
      ['Bollinger lower/upper band', 'A band 2 standard deviations from the 20-day average price. Price near the lower band suggests it\'s statistically stretched to the downside; near the upper band, stretched up.', ''],
      ['SMA20/50/150/200 (as support/resistance)', 'The average closing price over that many days. When price sits above its own SMA, that SMA line often acts as a floor (support) if price pulls back to it; below it, a ceiling (resistance).', 'SMA50/150 added to this system on this pass -- previously only SMA20/200 were used here.'],
      ['Fibonacci retracement (38.2%, 50%)', 'Levels derived from a mathematical ratio sequence, applied to a recent price swing. Widely watched because many traders use them, which can become self-fulfilling.', ''],
      ['Fibonacci 161.8% extension', 'A projection beyond the original price swing, using the same ratio sequence -- typically used as a longer-range upside target.', ''],
      ['Pivot Points (S1/S2, R1/R2)', 'Classic support/resistance levels computed from the prior period\'s high/low/close. Widely used by day traders.', ''],
      ['ATR pullback (1.5×ATR)', 'Current price minus 1.5x the Average True Range -- a common rule-of-thumb for "how far a healthy pullback typically goes" before a stock likely finds support.', ''],
      ['Gann support/resistance (angles)', 'A price/time relationship system where a diagonal line is drawn from a significant price pivot at a fixed slope (e.g. $X per trading day). Where price sits relative to these angles is read as support/resistance.', 'A minority, more esoteric technique -- not universally used by traders the way moving averages or RSI are.'],
      ['Square of Nine (Sq9) harmonic levels', 'A Gann-derived technique using a specific numerical spiral to derive price levels believed to have geometric significance.', 'Niche technique, included for completeness, not a mainstream method.'],
      ['52-week high/low', 'The highest and lowest closing prices over the trailing year. The 52-week high in particular is a widely-watched psychological resistance level.', ''],
      ['Analyst consensus / high target', 'The average (consensus) and highest individual price target among covering analysts.', 'Reflects analyst opinion, not an independent technical or fundamental calculation.'],
    ],
  },
  {
    title: '📊 Short-Term Technical Indicators (Days/Weeks)', color: '#1b5e20',
    entries: [
      ['RSI(14)', 'Relative Strength Index -- measures how fast and how much price has moved recently, on a 0-100 scale. Above 70 is conventionally "overbought," below 30 "oversold."', 'More reliable as a reversal signal in a range-bound/choppy market; can stay "overbought" for a long time during a strong trend without reversing.'],
      ['MACD (Moving Average Convergence Divergence)', 'The difference between two moving averages (typically 12 and 26-day), plus a signal line. When the MACD line crosses above its signal line, that\'s read as bullish momentum.', 'More reliable in a trending market; prone to false signals (whipsaws) in a choppy market.'],
      ['Stochastic %K/%D', 'Compares the current closing price to its recent trading range, also 0-100. Similar interpretation to RSI (overbought/oversold).', 'Same regime-sensitivity as RSI -- more reliable when range-bound.'],
      ['Williams %R', 'A momentum oscillator similar to Stochastic, inverted scale (0 to -100).', ''],
      ['CCI(20) (Commodity Channel Index)', 'Measures how far price has moved from its statistical average -- used to spot potential trend starts or extremes.', ''],
      ['MFI(14) (Money Flow Index)', 'Similar to RSI but incorporates trading volume, sometimes called "volume-weighted RSI."', ''],
      ['OBV (On-Balance Volume)', 'A running total that adds volume on up days and subtracts it on down days -- used to confirm whether a price move has genuine volume support behind it.', 'Tends to matter across most market conditions, not just specific regimes.'],
      ['EMA9/21 (Exponential Moving Averages)', 'Similar to simple moving averages but weight recent prices more heavily, so they react faster to new price action.', ''],
      ['CMF(20) (Chaikin Money Flow)', 'Measures buying vs. selling pressure over 20 days, incorporating both price and volume.', ''],
      ['ROC(10) (Rate of Change)', 'The percentage price change over the last 10 days -- a simple, direct momentum measure.', ''],
      ['RSI Divergence', 'When price makes a new low but RSI does NOT make a correspondingly lower low (or the reverse for highs) -- often read as an early sign the current move is losing strength.', ''],
      ['Aroon(25)', 'Measures how long it\'s been since price made a new 25-day high vs. a new 25-day low. A recent high with no recent low reads as a strong uptrend, and vice versa.', 'Reads flat/neutral by design during a real sideways market -- that\'s the indicator correctly reporting no dominant trend, not a malfunction.'],
      ['Donchian(20) (Donchian Channel)', 'The highest high and lowest low over the last 20 days -- the classic "Turtle Trading" breakout channel. Price pressing the upper band reads bullish, the lower band bearish.', ''],
      ['Parabolic SAR', 'A trailing stop-and-reverse indicator that flips sides when price crosses it. Below price = uptrend, above price = downtrend.', 'Designed for trending markets -- whipsaws (frequent flips) in a real choppy/range-bound market, same regime-sensitivity as MACD.'],
      ['SuperTrend', 'An ATR-based trend line, similar purpose to Parabolic SAR but built from real, measured volatility (ATR) rather than a fixed acceleration formula.', 'Same trending-market bias as Parabolic SAR -- both are trend-following overlays, not range-bound tools.'],
      ['Ichimoku Cloud', 'A Japanese charting system combining trend direction, support/resistance ("the cloud"), and momentum in one view. Price above the cloud reads bullish, below reads bearish, inside the cloud reads as no clear trend.', 'The cloud shown today reflects a real calculation from 26 real trading days ago, displaced forward -- a standard, correct part of how this indicator works, not a delay/lag bug.'],
    ],
  },
  {
    title: '📈 Long-Term Technical Indicators (Months/Years)', color: '#0d47a1',
    entries: [
      ['Price vs. SMA200', 'Whether price is above or below its 200-day average -- one of the most widely-used simple definitions of "primary trend."', ''],
      ['Golden Cross / Death Cross', 'When the 50-day average crosses above (golden) or below (death) the 200-day average -- a classic, widely-watched long-term trend signal.', ''],
      ['ADX(14) (Average Directional Index)', 'Measures how STRONG a trend is (not its direction) -- low ADX suggests a weak/sideways market regardless of which way price is drifting.', ''],
      ['RSI Weekly', 'The same RSI calculation, but using weekly instead of daily candles -- a slower, longer-horizon momentum read.', ''],
      ['ROC(52) — ~13wk', 'The percentage price change over the trailing 52 TRADING DAYS (~13 weeks / ~2.5 months, not 1 year — v9.46: was mislabeled "annual"/"1yr" throughout the file).', ''],
      ['Relative Strength vs. SPY', 'How the stock has performed compared to the S&P 500 over the same period -- outperformance vs. the broad market.', 'Currently only compares against the broad index, not sector-specific peers.'],
      ['Gann Angular (structural)', 'The same Gann angle technique as the entry/exit methods above, applied here as a long-term structural trend read.', ''],
    ],
  },
  {
    title: '💰 Fundamentals Drivers (OWN Score)', color: '#4a148c',
    entries: [
      ['Revenue/share trend', 'Whether revenue-per-share has been rising over the past several quarters -- a growth trajectory signal, distinct from a single period\'s growth rate.', ''],
      ['Margin trajectory', 'Whether net profit margin is improving or declining -- profitability trend, not just current-level profitability.', ''],
      ['Rule of 40', 'A common growth-company heuristic: revenue growth rate + free cash flow margin should exceed 40 for a healthy, efficient growth business.', ''],
      ['Profitability/quality (ROE, Net Margin)', 'Current-level profitability metrics -- how efficiently the company turns equity/revenue into profit right now.', ''],
      ['Valuation vs. peers (EV/Sales)', 'How expensive the stock is relative to a set of comparable companies, using Enterprise Value/Sales.', ''],
      ['Analyst view', 'Blended analyst rating and price target, relative to current price.', ''],
      ['P/E & PEG', 'Price/Earnings ratio and PEG (P/E relative to growth rate) -- classic valuation multiples.', ''],
    ],
  },
  {
    title: '⚡ Options Metrics', color: '#e65100',
    entries: [
      ['IV Percentile', 'How expensive options are priced right now, RELATIVE to this same stock\'s own historical range -- not an absolute number. High percentile means options are pricier than usual for this specific stock.', ''],
      ['Put/Call Open Interest ratio', 'Total open put contracts divided by open call contracts. Below ~0.7 suggests upside positioning; above ~1.1 suggests downside/hedging positioning.', ''],
      ['LEAPS lean', 'Whether long-dated (1-2yr+) option positioning skews bullish or bearish -- often read as reflecting more patient, institutional conviction than short-dated options.', ''],
      ['Dollar-weighted conviction (options)', 'A blended score: 50% dollar value committed to a position + 20% holding pattern + 15% urgency (volume spike) + 10% time-to-expiry + 5% relative IV.', ''],
      ['OI-Persistence', 'Compares today\'s open interest in a specific contract to the LAST time this same ticker was analyzed -- builds up real signal over repeated runs, not a single snapshot.', ''],
    ],
  },
  {
    title: '🌊 Regime & Risk Mechanics', color: '#c62828',
    entries: [
      ['ATR (Average True Range)', 'How much the stock typically moves in a single day, in dollars -- the base volatility measurement everything else in risk-sizing is built from.', ''],
      ['Regime (TREND_UP / TREND_DOWN / CHOP / HIGH_VOL)', 'A classification of current market conditions, used to gate whether a "BUY NOW" recommendation is even allowed, and to set the stop-loss distance.', ''],
      ['Stop multiplier by regime', 'The distance from entry to stop-loss, as a multiple of ATR: 2.0x in HIGH_VOL (wider, since volatility itself is elevated), 1.25x in a clean trend (tighter, the trend is doing the work), 1.5x otherwise (CHOP).', ''],
      ['OWN-as-filter Final Conviction', 'Once fundamentals (OWN score) clear a threshold, Final Conviction is driven by technical timing alone. Below that threshold, technical timing gets reduced on an accelerating curve; below a hard floor, it\'s blocked entirely regardless of chart.', ''],
    ],
  },
];

/**
 * B3 / D4 (fix plan 2026-10-30): the two options entries in the words every page now uses. Legacy's IV entry called
 * the chain percentile a comparison with the stock's own history, which it is not; its put/call cut-offs (0.7 / 1.1)
 * were not the bands the scoring uses.
 */
export const METHODOLOGY_PLAIN_OVERRIDES: Readonly<Record<string, MethodologyEntry>> = {
  'IV Percentile': [IV_CHAIN_PCT_LABEL, 'How expensive near-term options are RELATIVE to the rest of today\'s option chain for this stock: ' + IV_CHAIN_PCT_MEANING + '. Contracts with under ' + MIN_DAYS_FOR_IV_CONTEXT + ' days to expiry are left out. A real IV rank over a year of history will come from the 📉 IV History tab.', ''],
  'Put/Call Open Interest ratio': [PUT_CALL_LABEL, 'Total open put contracts divided by open call contracts, over the whole chain. Bands (the same ones the options scoring uses): ' + PUT_CALL_BANDS_TEXT + '.', ''],
};

/** `plainLabels` (production): METHODOLOGY_PLAIN_OVERRIDES replace legacy's two options entries. */
export function buildMethodologySheet(ss: ReportWorkbook, deps: { readonly alert: (message: string) => void; readonly plainLabels?: boolean }): void {
  const existing = ss.getSheetByName(METHODOLOGY_TAB);
  if (existing) { existing.clearContents(); existing.clearFormats(); }
  const sh = existing ?? ss.insertSheet(METHODOLOGY_TAB);

  let row = 1;
  function section(title: string, color: string): void {
    sh.getRange(row, 1, 1, 3).merge().setValue(title).setBackground(color).setFontColor('#fff').setFontSize(12).setFontWeight('bold');
    row++;
    sh.getRange(row, 1, 1, 3).setValues([['Method / Indicator', 'What it measures / how to read it', 'Notes']]).setFontWeight('bold').setBackground('#eceff1');
    row++;
  }
  function entry(name: string, desc: string, note: string): void {
    sh.getRange(row, 1, 1, 3).setValues([[name, desc, note || '']]).setWrap(true);
    row++;
  }

  for (const s of METHODOLOGY_SECTIONS) {
    section(s.title, s.color);
    for (const e of s.entries) {
      const [name, desc, note] = (deps.plainLabels && METHODOLOGY_PLAIN_OVERRIDES[e[0]]) || e;
      entry(name, desc, note);
    }
  }

  sh.setColumnWidth(1, 220); sh.setColumnWidth(2, 500); sh.setColumnWidth(3, 300);
  sh.setFrozenRows(0);
  deps.alert('Methodology sheet built/refreshed — see the 📖 Methodology tab.');
}
