/**
 * The pedagogical-report helpers of fullStockAnalysisV10_9.gs, ported verbatim
 * (strings, thresholds, branch order and coercions are the oracle):
 *   pmV7_ :8827-8832, fundDriverContextV7_ :8835-8845, techIndicatorRowsV7_ :8848-8858,
 *   bottomLineV7_ :8861-8874, renderAiReviewV7_ :8878-8895, scoreBar :8988
 *
 * F-I1: pm / fundDriverContext / techIndicatorRows / bottomLine have no caller in
 * the legacy code (dead there); they are ported for parity and for later use.
 * F-I2: scoreBar of NaN / undefined / non-numeric text is '' (an empty bar).
 * F-I3: renderAiReview(undefined | null) renders the literal text "undefined" / "null".
 * F-I4: bottomLine without a finalConviction prints "confidence undefined/100 (Very Low)".
 */

export interface PointTag {
  readonly s: string;
  readonly mark: string;
}

/** pmV7_ (:8827): a driver's signed points as a short tag and a marker. Accepts anything isNaN accepts, like legacy. */
export function pm(p: unknown): PointTag {
  if (p == null || isNaN(p as number)) return { s: 'n/a', mark: '•' };
  if ((p as number) > 0.001) return { s: '+' + Number(p).toFixed(2), mark: '✓' };
  if ((p as number) < -0.001) return { s: '−' + Math.abs(Number(p)).toFixed(2), mark: '⚠' };
  return { s: '0.00', mark: '•' };
}

/** fundDriverContextV7_ (:8835): the plain-English meaning of a fundamental driver; the first matching label wins. */
export function fundDriverContext(label: unknown, p: unknown): string {
  const pos = (p as number) > 0.001, neg = (p as number) < -0.001, L = String(label || '').toLowerCase();
  if (L.indexOf('growth') >= 0)       return pos ? 'Sales are growing at a healthy, consistent pace — a real engine for the stock.' : neg ? 'Growth is weak or shrinking — little momentum in the business itself.' : 'Growth is only average.';
  if (L.indexOf('margin') >= 0)       return pos ? 'Profit margins are improving — the company keeps more of every dollar it sells.' : neg ? 'Margins are thin and/or getting worse — profitability is under pressure.' : 'Margins are steady but unremarkable.';
  if (L.indexOf('rule of 40') >= 0)   return pos ? 'Growth plus profitability clear the "40" health bar investors like to see.' : neg ? 'Growth plus profitability fall short of the "40" health bar — an unbalanced mix.' : 'Right around the "40" line — balanced but not standout.';
  if (L.indexOf('profitab') >= 0 || L.indexOf('quality') >= 0) return pos ? 'Returns on capital are strong — a high-quality operation.' : neg ? 'Returns on capital are weak — lower-quality economics.' : 'Returns on capital are average.';
  if (L.indexOf('valuation') >= 0 || L.indexOf('peer') >= 0)   return pos ? 'It trades cheaper than similar companies — relatively good value.' : neg ? 'It trades richer than its peers — you are paying a premium versus similar names.' : 'Roughly in line with peers on value.';
  if (L.indexOf('analyst') >= 0)      return pos ? 'Wall-Street analysts are net-positive and see upside to their price targets.' : neg ? 'Analysts are cautious and see limited upside.' : 'Analyst opinion is mixed.';
  if (L.indexOf('p/e') >= 0 || L.indexOf('peg') >= 0) return pos ? 'The earnings multiple is reasonable for the growth on offer.' : neg ? 'A very high earnings multiple — the stock is priced for a lot of future success, which is risky if it stumbles.' : 'The earnings multiple is about fair.';
  return pos ? 'Reads as a plus for owning the business.' : neg ? 'Reads as a minus for owning the business.' : 'Roughly neutral for owning the business.';
}

export interface TechIndicators {
  readonly rsi14: number;
  readonly histogram: number;
  readonly adx14: number;
  readonly atr14: number;
  readonly stochK: number;
  readonly mfi14: number;
  readonly rs?: { readonly rs63: number } | null;
}

export interface IndicatorRow {
  readonly label: string;
  readonly value: string;
  readonly note: string;
}

/** techIndicatorRowsV7_ (:8848): each technical indicator as { label, value, note }; a missing field throws a TypeError, like legacy. */
export function techIndicatorRows(ind: TechIndicators): IndicatorRow[] {
  const r: IndicatorRow[] = [], rsi = ind.rsi14;
  r.push({ label: 'Momentum (RSI 14)', value: rsi.toFixed(1) + ' / 100', note: rsi < 30 ? 'Oversold — beaten down, can be due for a bounce.' : rsi < 45 ? 'Weak momentum — sellers still in control.' : rsi <= 55 ? 'Neutral momentum.' : rsi <= 70 ? 'Healthy upward momentum.' : 'Overbought — extended, pullback risk.' });
  r.push({ label: 'Trend momentum (MACD histogram)', value: ind.histogram.toFixed(2), note: ind.histogram > 0 ? 'Positive — short-term momentum is building upward.' : 'Negative — short-term momentum is pointing down.' });
  r.push({ label: 'Trend strength (ADX 14)', value: ind.adx14.toFixed(1), note: ind.adx14 > 25 ? 'A strong, established trend is in place — respect its direction.' : ind.adx14 < 20 ? 'No real trend — price is choppy / sideways.' : 'A trend is developing but not yet strong.' });
  r.push({ label: 'Typical daily move (ATR 14)', value: '$' + ind.atr14.toFixed(2), note: 'How much the stock usually moves in a day — used to size the stop and targets.' });
  r.push({ label: 'Short-term timing (Stochastic %K)', value: ind.stochK.toFixed(1), note: ind.stochK < 20 ? 'Oversold zone.' : ind.stochK > 80 ? 'Overbought zone.' : 'Mid-range.' });
  r.push({ label: 'Money flow (MFI 14)', value: ind.mfi14.toFixed(1), note: ind.mfi14 < 20 ? 'Money is flowing out (oversold).' : ind.mfi14 > 80 ? 'Money is flowing in (overbought).' : 'Balanced money flow.' });
  if (ind.rs) r.push({ label: 'Vs. the market (3-mo relative strength)', value: (ind.rs.rs63 >= 0 ? '+' : '') + ind.rs.rs63.toFixed(1) + '%', note: ind.rs.rs63 >= 0 ? 'Outperforming the S&P over the last 3 months.' : 'Lagging the S&P over the last 3 months — a relative weakness.' });
  return r;
}

export interface BottomLineFund {
  readonly score?: number | null;
  readonly pricedForPerfection?: unknown;
  readonly drivers?: ReadonlyArray<{ readonly label: string; readonly points: number }> | null;
}

export interface BottomLineTech {
  readonly regime?: string | null;
  readonly timing?: string | null;
}

export interface BottomLineDecision {
  readonly action?: string;
  readonly finalConviction?: number | string | null;
}

export interface BottomLineOptions {
  readonly available?: boolean;
  readonly confirm?: string;
}

/** bottomLineV7_ (:8861): the one-sentence bottom line plus the conviction word. fundResult / techPlan / decision must be objects (a null throws, like legacy). */
export function bottomLine(
  ticker: string, fundResult: BottomLineFund, techPlan: BottomLineTech, decision: BottomLineDecision, opts?: BottomLineOptions | null,
): { convWord: string; text: string } {
  const fc = decision.finalConviction as number;
  const convWord = fc >= 67 ? 'High' : fc >= 50 ? 'Moderate' : fc >= 33 ? 'Low' : 'Very Low';
  const s = fundResult.score;
  const ownWord = s == null ? 'an unrated' : s >= 57 ? 'a solid' : s >= 43 ? 'a mixed-quality' : 'a weak';
  const pricey = fundResult.pricedForPerfection || (fundResult.drivers || []).some((d) => /p\/e|peg|valuation/i.test(d.label) && d.points < 0);
  const valWord = pricey ? 'at a rich (expensive) price' : 'at a reasonable price';
  const trendWord = techPlan.regime === 'TREND_UP' ? 'trending up' : techPlan.regime === 'TREND_DOWN' ? 'trending down' : 'moving sideways';
  const timeWord = techPlan.timing === 'BUY_NOW' ? 'a good time to buy' : techPlan.timing === 'WAIT_PULLBACK' ? 'better to wait for a dip' : 'a poor time to buy';
  let optClause = 'No options data was loaded, so smart-money positioning is not factored in yet.';
  if (opts && opts.available) optClause = opts.confirm === 'confirm' ? 'Options traders lean the SAME way, which adds confidence.' : opts.confirm === 'conflict' ? 'Options traders lean the OTHER way — a mixed signal that lowers confidence.' : 'Options positioning is roughly neutral.';
  const text = ticker + ' is ' + ownWord + ' business (score ' + (s == null ? 'N/A' : s + '/100') + '), ' + valWord + '. The chart is ' + trendWord + ' right now, so it is ' + timeWord + '. ' + optClause + ' Bottom line: ' + decision.action + ' — confidence ' + fc + '/100 (' + convWord + ').';
  return { convWord: convWord, text: text };
}

export interface AiReviewRow {
  readonly text: string[];
  readonly meta: { readonly merge: boolean; readonly bold?: boolean; readonly bg?: string; readonly color?: string; readonly size?: number; readonly wrap?: boolean };
}

/**
 * renderAiReviewV7_ (:8878): the AI's plain-text briefing as styled rows. Markdown markers (**, `, leading #)
 * are stripped; UPPERCASE or colon-ending short lines become bold subtitles, "- " / "• " / "* " lines become
 * bullets, the rest wraps. Input that yields no row gives one row holding the cleaned text.
 */
export function renderAiReview(text: unknown): AiReviewRow[] {
  const out: AiReviewRow[] = [];
  const clean = String(text).replace(/\*\*/g, '').replace(/`/g, '').replace(/^#+\s*/gm, '');
  clean.split(/\r?\n/).forEach((raw) => {
    const line = raw.replace(/\s+$/, '').trim();
    if (!line) return;
    const isHeader = /^[A-Z0-9][A-Za-z0-9 &/()'?\-]{1,50}:?$/.test(line) && (line.endsWith(':') || line === line.toUpperCase());
    if (isHeader) {
      out.push({ text: [line.replace(/:$/, '')], meta: { merge: true, bold: true, bg: '#ede7f6', color: '#4a148c', size: 11 } });
    } else if (/^[-•*]\s+/.test(line)) {
      out.push({ text: ['   • ' + line.replace(/^[-•*]\s+/, '')], meta: { merge: true, wrap: true } });
    } else {
      out.push({ text: [line], meta: { merge: true, wrap: true } });
    }
  });
  if (!out.length) out.push({ text: [clean], meta: { merge: true, wrap: true } });
  return out;
}

/** scoreBar (:8988): a 10-block bar for a 0-100 score (clamped, rounded to the nearest tenth). */
export function scoreBar(score: unknown): string {
  const f = Math.round(Math.min(100, Math.max(0, score as number)) / 10);
  return '█'.repeat(f) + '░'.repeat(10 - f);
}
