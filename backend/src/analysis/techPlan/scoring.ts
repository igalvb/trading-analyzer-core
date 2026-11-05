/**
 * Tier A of computeTechnicalPlanV7: regime detection and the weighted signal
 * score.
 *
 * ══ WHY computeTechnicalPlanV7 IS SPLIT ════════════════════════════════
 * The function is 260 lines of orchestration over 13 helpers totalling 530
 * more -- 790 lines in all. Porting it as one unit would mean handing over a
 * large unverified translation, the same mistake avoided with chartPatterns.
 *
 * The source itself provides the seam: 8 of the 13 helpers are annotated
 * "purely additive ... does not affect stop/rrToT1/rrToT2". So:
 *
 *   Tier A (this file)  regime, techScore, overallSig, headline weights  ~120 ln
 *   Tier B              deriveExitTargets, timeToPrice, stopRR, timing   ~100 ln
 *   Tier C              the 8 additive stop/sizing/channel helpers        428 ln
 *   Tier D              drivers array + secular read                     ~140 ln
 *
 * A+B are the ENTIRE decision path -- the end-to-end fingerprint
 * (finalConviction, action, fundBand, timing, regime) depends on nothing in C
 * or D. So A+B unblock synthesizeDecisionV7 and the headline parity gate.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Verified 2026-10-05: 3,995 comparisons, all exact. All four regimes
 * exercised, 48 distinct techScores spanning 25-73, with and without options
 * analysis, with and without a benchmark series.
 */

import type { Chart } from '../../types/chart.ts';
import type { Indicators } from '../../types/indicators.ts';
import type { GannRead } from '../gann.ts';

export type Regime = 'TREND_UP' | 'TREND_DOWN' | 'CHOP' | 'HIGH_VOL';

export type SignalCategory = 'Momentum' | 'Trend' | 'Volume' | 'Volatility' | 'Position' | 'Options';

/** Only the fields the scorer reads. */
export interface OptionsAnalysis {
  readonly available: boolean;
  readonly dirSig?: number;
  readonly leapsLean?: number;
}

export interface WeightedSignal {
  cat: SignalCategory;
  /** Clamped to [-1, 1]. */
  sig: number;
  /** Base weight after the regime multiplier is applied. */
  weight: number;
}

export interface TechScoreCore {
  regime: Regime;
  techScore: number;
  overallSig: number;
  headlineWeights: Record<string, number>;
  /** See F-10 -- structurally always false. */
  headlineUsedDefaultWeights: boolean;
  signals: WeightedSignal[];
}

/**
 * Classifies the market regime from trend strength and volatility.
 *
 * HIGH_VOL is checked FIRST and short-circuits, so a volatile uptrend reports
 * HIGH_VOL rather than TREND_UP. Volatility dominates: the regime is about how
 * tradeable conditions are, not just direction.
 *
 * Both TREND_UP and TREND_DOWN require sma200 to exist AND the sma50/sma200
 * relationship AND price on the matching side of sma50. Anything else is CHOP
 * -- so insufficient history lands in CHOP, which is the honest default.
 */
export function detectRegime(ind: Indicators): Regime {
  const trending = (ind.adx14 as number) > 25;
  const highVol = (ind.atrRatio as number) > 1.3;
  if (highVol) return 'HIGH_VOL'; // volatility wins over direction

  const up = ind.sma200 != null && (ind.sma50 || 0) > ind.sma200 && (ind.pctFromSma50 as number) > 0;
  const down = ind.sma200 != null && (ind.sma50 || 0) < ind.sma200 && (ind.pctFromSma50 as number) < 0;
  if (trending && up) return 'TREND_UP';
  if (trending && down) return 'TREND_DOWN';
  return 'CHOP';
}

/**
 * Per-indicator-type weight multipliers by regime.
 *
 * The thesis: an indicator's reliability is regime-dependent. Momentum
 * oscillators are discounted to 0.7x in a trend (where they stay pinned at an
 * extreme) and boosted to 1.3x in chop (where mean-reversion actually works).
 * Trend-strength indicators get the inverse treatment.
 *
 * Every table lists all four real regimes, which is why DEFAULT is dead (F-10).
 */
const INDICATOR_REGIME_MULT: Record<string, Record<string, number>> = {
  momentumOscillator: { TREND_UP: 0.7, TREND_DOWN: 0.7, CHOP: 1.3, HIGH_VOL: 1.0, DEFAULT: 1.0 },
  fastTrendFollowing: { TREND_UP: 0.8, TREND_DOWN: 0.8, CHOP: 1.1, HIGH_VOL: 1.1, DEFAULT: 1.0 },
  trendStrength: { TREND_UP: 1.3, TREND_DOWN: 1.3, CHOP: 0.7, HIGH_VOL: 1.0, DEFAULT: 1.0 },
  divergence: { TREND_UP: 1.2, TREND_DOWN: 1.2, CHOP: 0.8, HIGH_VOL: 1.0, DEFAULT: 1.0 },
  volatility: { TREND_UP: 0.8, TREND_DOWN: 0.8, CHOP: 1.2, HIGH_VOL: 1.3, DEFAULT: 1.0 },
  volume: { TREND_UP: 1.2, TREND_DOWN: 1.2, CHOP: 0.8, HIGH_VOL: 1.1, DEFAULT: 1.0 },
};

/**
 * Category weights for the headline score, also regime-adaptive.
 *
 * Trend and Momentum dominate in a trending regime (0.34 / 0.30); in CHOP the
 * weight spreads out and Volatility and Position roughly triple. Options holds
 * a constant 0.12 across every regime.
 *
 * TREND_UP and TREND_DOWN are intentionally IDENTICAL -- the weighting is about
 * how much to trust each category, not which direction it points.
 */
const HEADLINE_WEIGHTS_BY_REGIME: Record<string, Record<string, number>> = {
  TREND_UP: { Momentum: 0.3, Trend: 0.34, Volume: 0.12, Volatility: 0.04, Position: 0.08, Options: 0.12 },
  TREND_DOWN: { Momentum: 0.3, Trend: 0.34, Volume: 0.12, Volatility: 0.04, Position: 0.08, Options: 0.12 },
  CHOP: { Momentum: 0.22, Trend: 0.24, Volume: 0.14, Volatility: 0.14, Position: 0.14, Options: 0.12 },
  HIGH_VOL: { Momentum: 0.22, Trend: 0.24, Volume: 0.12, Volatility: 0.2, Position: 0.1, Options: 0.12 },
  DEFAULT: { Momentum: 0.27, Trend: 0.31, Volume: 0.13, Volatility: 0.07, Position: 0.1, Options: 0.12 },
};

/**
 * Computes the regime and the weighted technical score.
 *
 * SCORING IS TWO-STAGE, and the distinction matters:
 *   1. Within a category, signals are averaged by their own weights.
 *   2. Category averages are then combined using the regime's headline weights.
 * So adding a fifth Momentum signal dilutes the other four rather than
 * increasing Momentum's overall influence. The category weights, not the signal
 * count, control category influence.
 *
 * Every signal is clamped to [-1, 1] on the way in, so a helper returning an
 * out-of-range value cannot distort the total.
 *
 * Two signals are conditionally ABSENT rather than zero -- pctFromSma200 and
 * the golden/death-cross signal are skipped entirely when sma200 is
 * unavailable. That reduces Trend's internal weight total rather than voting
 * neutral, which is the right behaviour: unknown is not the same as neutral.
 * The Options pair is likewise absent unless options analysis is available.
 *
 * ══ FLAGGED FINDING F-10 — reproduced, not fixed ════════════════════════
 * Both DEFAULT fallbacks are unreachable. detectRegime returns exactly one of
 * the four real regimes, and both weight tables define all four -- so
 * `HEADLINE_WEIGHTS_BY_REGIME[regime]` and `table[regime]` are always defined.
 *
 * Consequently `headlineUsedDefaultWeights` is PERMANENTLY FALSE. It is
 * exported with the legacy comment "exposed for the dashboard transparency
 * line", i.e. a transparency indicator that structurally cannot report
 * anything. Confirmed across 940 cases covering all four regimes: zero used
 * the default weights. Reproduced to hold parity.
 * ═══════════════════════════════════════════════════════════════════════
 */
export function computeTechScoreCore(
  ind: Indicators,
  gann: GannRead,
  chart: Pick<Chart, 'currentPrice'>,
  optAnalysis: OptionsAnalysis | null,
): TechScoreCore {
  const cp = chart.currentPrice;
  const signals: WeightedSignal[] = [];
  const regime = detectRegime(ind);

  function add(cat: SignalCategory, sig: number, weight: number, indicatorType?: string): void {
    let w = weight;
    if (indicatorType && INDICATOR_REGIME_MULT[indicatorType]) {
      const table = INDICATOR_REGIME_MULT[indicatorType] as Record<string, number>;
      w = weight * (table[regime] != null ? (table[regime] as number) : (table['DEFAULT'] as number));
    }
    signals.push({ cat, sig: Math.max(-1, Math.min(1, sig)), weight: w });
  }

  // ── Momentum ────────────────────────────────────────────────────────
  // Oscillators use a four-band pattern: full conviction at the extremes
  // (<30 / >70), half conviction in the leaning zones, neutral in the middle.
  const rsi = ind.rsi14 as number;
  add('Momentum', rsi < 30 ? 1 : rsi > 70 ? -1 : rsi > 55 ? 0.5 : rsi < 45 ? -0.5 : 0, 3, 'momentumOscillator');

  // MACD needs histogram AND slope agreeing for full conviction; histogram
  // alone gives a half signal. Note there is no neutral band -- it always
  // returns at least +/-0.5.
  const hist = ind.histogram as number;
  const histSlope = ind.histSlope as number;
  add('Momentum', hist > 0 && histSlope > 0 ? 1 : hist < 0 && histSlope < 0 ? -1 : hist > 0 ? 0.5 : -0.5, 3, 'fastTrendFollowing');

  const stochK = ind.stochK as number;
  add('Momentum', stochK < 20 ? 1 : stochK > 80 ? -1 : stochK > (ind.stochD as number) ? 0.5 : -0.5, 2, 'momentumOscillator');

  const stochRSI = ind.stochRSI as number;
  add('Momentum', stochRSI < 20 ? 1 : stochRSI > 80 ? -1 : stochRSI > 55 ? 0.5 : stochRSI < 45 ? -0.5 : 0, 2, 'momentumOscillator');

  const mfi = ind.mfi14 as number;
  add('Momentum', mfi < 20 ? 1 : mfi > 80 ? -1 : mfi > 55 ? 0.5 : mfi < 45 ? -0.5 : 0, 2, 'momentumOscillator');

  const divType = (ind.divergence as { type?: string } | null)?.type;
  add('Momentum', divType === 'bullish' ? 1 : divType === 'bearish' ? -1 : 0, 3, 'divergence');

  // ── Trend ───────────────────────────────────────────────────────────
  // ABSENT, not neutral, when sma200 is unavailable -- see the note above.
  if (ind.pctFromSma200 != null) {
    const p = ind.pctFromSma200;
    add('Trend', p > 5 ? 1 : p < -5 ? -1 : p > 0 ? 0.5 : -0.5, 4);
  }
  if (ind.sma200 != null) {
    add('Trend', ind.goldenCross ? 1 : ind.deathCross ? -1 : (ind.sma50 as number) > ind.sma200 ? 0.5 : -0.5, 4);
  }

  const adx = ind.adx14 as number;
  add('Trend', adx > 25 && ind.adxBullish ? 1 : adx > 25 && !ind.adxBullish ? -1 : 0, 3, 'trendStrength');

  // Gann's 0-100 score mapped to [-1, 1]. Weight 2, deliberately reduced from
  // 4 in an earlier version -- Gann is treated as confirmation, not a primary
  // trend driver.
  add('Trend', (gann.score - 50) / 50, 2);

  if (ind.rs) {
    const rs63 = (ind.rs as { rs63: number }).rs63;
    add('Trend', rs63 > 10 ? 1 : rs63 < -10 ? -1 : rs63 > 0 ? 0.5 : -0.5, 3);
  }

  // ── Volume ──────────────────────────────────────────────────────────
  // Volume is DIRECTIONLESS on its own, so it inherits direction from price
  // versus sma20. Heavy volume (>1.5x) votes full strength in that direction;
  // moderate volume (>1.0x) votes 0.3x. Below average it abstains.
  const volDir = cp > (ind.sma20 || 0) ? 1 : cp < (ind.sma20 || 0) ? -1 : 0;
  const volRatio = ind.volRatio as number;
  add('Volume', volRatio > 1.5 ? volDir : volRatio > 1 ? 0.3 * volDir : 0, 2, 'volume');
  add('Volume', (ind.obvShortSlope as number) > 0 ? 1 : (ind.obvShortSlope as number) < 0 ? -1 : 0, 2, 'volume');
  add('Volume', (ind.cmf20 as number) > 0.1 ? 1 : (ind.cmf20 as number) < -0.1 ? -1 : 0, 2, 'volume');

  // ── Volatility ──────────────────────────────────────────────────────
  // Both are weak (weight 1) and directionally mild. A squeeze is mildly
  // bullish; elevated ATR mildly bearish, compressed mildly bullish.
  add('Volatility', ind.bbSqueeze ? 0.3 : 0, 1, 'volatility');
  const atrRatio = ind.atrRatio as number;
  add('Volatility', atrRatio > 1.3 ? -0.3 : atrRatio < 0.7 ? 0.3 : 0, 1, 'volatility');

  // ── Position ────────────────────────────────────────────────────────
  // Where price sits in its 52-week range. Note this is MOMENTUM-flavoured,
  // not mean-reverting: high in range is positive.
  const fibPct = ind.fibPct as number;
  add('Position', fibPct > 0.618 ? 0.5 : fibPct < 0.236 ? -0.5 : 0, 2);
  const range52 = ind.range52Pct as number;
  add('Position', range52 > 80 ? 0.3 : range52 < 20 ? -0.3 : 0, 1);

  // ── Options ─────────────────────────────────────────────────────────
  // The single heaviest signal in the system at weight 5. LEAPS lean is both
  // scaled by 0.6 AND weighted 3 -- a double discount, since structural
  // long-term positioning is weaker evidence about near-term direction.
  if (optAnalysis && optAnalysis.available) {
    add('Options', optAnalysis.dirSig as number, 5);
    add('Options', (optAnalysis.leapsLean as number) * 0.6, 3);
  }

  // ── Aggregate ───────────────────────────────────────────────────────
  const catWeight = (HEADLINE_WEIGHTS_BY_REGIME[regime] ||
    HEADLINE_WEIGHTS_BY_REGIME['DEFAULT']) as Record<string, number>;
  const headlineUsedDefaultWeights = !HEADLINE_WEIGHTS_BY_REGIME[regime]; // always false — F-10

  // Stage 1: weighted average within each category.
  const byCat: Record<string, { wSum: number; wTot: number }> = {};
  signals.forEach((s) => {
    if (!byCat[s.cat]) byCat[s.cat] = { wSum: 0, wTot: 0 };
    const b = byCat[s.cat] as { wSum: number; wTot: number };
    b.wSum += s.sig * s.weight;
    b.wTot += s.weight;
  });

  // Stage 2: combine categories using the headline weights. Only categories
  // that actually produced signals participate, and the 0.1 fallback covers a
  // category absent from the weight table.
  let num = 0;
  let den = 0;
  Object.keys(byCat).forEach((c) => {
    const b = byCat[c] as { wSum: number; wTot: number };
    const sig = b.wTot ? b.wSum / b.wTot : 0;
    const w = catWeight[c] || 0.1;
    num += sig * w;
    den += w;
  });

  const overallSig = den ? num / den : 0;
  // Maps [-1, 1] to [0, 100]. A perfectly neutral read scores 50.
  const techScore = Math.round(((overallSig + 1) / 2) * 100);

  return { regime, techScore, overallSig, headlineWeights: catWeight, headlineUsedDefaultWeights, signals };
}
