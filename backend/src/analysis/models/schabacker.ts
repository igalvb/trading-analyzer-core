/**
 * The Schabacker model report (schabackerModelV1.gs, 10 functions + 2 tables).
 *
 * Every read cites a specific Study of Richard W. Schabacker's 1932
 * "Technical Analysis and Stock Market Profits". Like the Edwards & Magee
 * model, it computes nothing: `ind`, `techPlan` and `chart` go in, labelled
 * and cited report objects come out.
 *
 * ══ CLOSURE: ZERO EXTERNAL DEPENDENCIES ════════════════════════════════
 * Measured with a scanner that strips comments AND string contents -- the
 * third iteration, after two earlier versions produced false positives from
 * prose. Exactly one non-local identifier appeared, `withVolumeWeight`, and
 * that is a local arrow function inside schabackerSRTrendLineReadV1_. Both
 * top-level tables are genuinely used.
 *
 * ══ WHAT MAKES THIS MODEL DIFFERENT FROM EDWARDS & MAGEE ═══════════════
 * This book is notable for its NEGATIVE findings, and the report is built
 * to preserve them. Schabacker tested ideas and reported what failed:
 * triangle measuring, gap measuring, time cycles, Point & Figure, intraday
 * charts, Dow Theory for single stocks. Those are not omissions here --
 * they are an explicit `exclusions` list that the report PRINTS, each with
 * the book's own verdict. The measuring-rule section carries its own
 * exclusion note for the same reason.
 *
 * That is also the source of the disclosed conflict with Edwards & Magee
 * (see edwardsMagee.ts): one book publishes a gap-measuring formula, this
 * one says "no reliance can be placed" on it. Neither is shipped.
 */

import type { Indicators } from '../../types/indicators.ts';
import type { Regime } from '../techPlan/scoring.ts';
import type { Driver } from '../techPlan/drivers.ts';
import { countDistinct, roundNumberText, shortDate, type ModelTextOptions } from './modelText.ts';

/** Chart fields the model reads. `relativeSwingPower` is an optional attach. */
export interface ModelChart {
  readonly currentPrice?: number | null;
  readonly relativeSwingPower?: {
    readonly ratio: number; readonly etf: string; readonly sector: string;
  } | null;
}

/** Tech-plan fields the model reads. */
export interface SchabackerTechPlan {
  readonly regime: Regime;
  readonly techScore: number;
  readonly drivers?: readonly Driver[] | null;
  readonly classicalStop?: {
    readonly level: number; readonly basingPointDate: Date;
    readonly basingPointPrice: number; readonly direction: string;
  } | null;
}

export type PatternGroup = 'reversal' | 'continuation' | 'context-dependent' | 'not-covered';

export interface TaxonomyEntry {
  readonly group: PatternGroup;
  readonly note: string;
}

/**
 * The book's own pattern taxonomy, mapped onto this engine's pattern types.
 *
 * ══ THE 'not-covered' GROUP IS THE HONEST PART ═════════════════════════
 * STAIRCASE, CUP_AND_HANDLE, BULL_TRAP and BEAR_TRAP are later, non-1932
 * conventions with no Schabacker citation. Rather than force-fit them into
 * the book's vocabulary, they are labelled as outside it -- so a reader can
 * tell which of this engine's 29 detectors the book actually speaks to.
 *
 * The notes carry the book's own reliability RANKINGS, which are what make
 * this table more than a lookup: Head & Shoulders is its #1 reversal,
 * Rounding Turn #2, Triangle family #3, Multiple Tops #4, and Complex
 * Reversal is explicitly TIED with Head & Shoulders. Double Top carries the
 * book's own deflating statistic -- "probably not more than a third" of
 * popularly-labelled double tops actually reverse.
 */
const PATTERN_TAXONOMY: Readonly<Record<string, TaxonomyEntry>> = {
  HEAD_AND_SHOULDERS: { group: 'reversal', note: 'Study II — book\'s own #1-ranked major reversal formation, the most reliable of the five.' },
  INVERSE_HEAD_AND_SHOULDERS: { group: 'reversal', note: 'Study II — same formation inverted; same top reliability ranking.' },
  DOUBLE_TOP: { group: 'reversal', note: 'Study IV — book\'s own disclosed statistic: "probably not more than a third" of popularly-labeled double tops actually signal reversal; only ones meeting the book\'s specific criteria (comparable peak levels, genuine intervening pullback) are reliable.' },
  DOUBLE_BOTTOM: { group: 'reversal', note: 'Study IV — same reliability caveat as Double Top, mirrored.' },
  TRIPLE_TOP: { group: 'reversal', note: 'Study IV — "Multiple Tops/Bottoms," ranked #4 of the book\'s own top-5 major reversal patterns.' },
  TRIPLE_BOTTOM: { group: 'reversal', note: 'Study IV — same ranking as Triple Top, mirrored.' },
  COMPLEX_TOP: { group: 'reversal', note: 'Study IV — "Complex Reversal," explicitly ranked TIED WITH Head and Shoulders on reliability by the book itself, just rarer.' },
  COMPLEX_BOTTOM: { group: 'reversal', note: 'Study IV — same top-tier reliability ranking as Complex Top, mirrored.' },
  BROADENING_TOP: { group: 'reversal', note: 'Study IV — book\'s own "rule of five" alternating-swing pattern, explicitly called secondary/minor (studied for pictorial kinship to the major 5, not itself in that top-5 list).' },
  BROADENING_BOTTOM: { group: 'reversal', note: 'Study IV — same secondary/minor standing as Broadening Top, mirrored.' },
  DIAMOND_TOP: { group: 'reversal', note: 'Study V — "Minor Reversal Formations": a real but secondary-tier pattern, geometrically an inverted-then-normal Symmetrical Triangle pair.' },
  DIAMOND_BOTTOM: { group: 'reversal', note: 'Study V — same minor-reversal standing as Diamond Top, mirrored.' },
  ROUNDING_TOP: { group: 'reversal', note: 'Study III — "Rounding Turn," book\'s own #2-ranked major reversal pattern.' },
  ROUNDING_BOTTOM: { group: 'reversal', note: 'Study III — same #2 ranking as Rounding Top, mirrored.' },
  ISLAND: { group: 'reversal', note: 'Study V/VII — "Island Reversal": requires both bounding gaps at (roughly) the same price level AND the first gap staying genuinely un-closed until the reversal gap forms — see meetsStrictValidity below.' },
  ASCENDING_TRIANGLE: { group: 'context-dependent', note: 'Study VI — same shape has OPPOSITE forecasting implications depending on prevailing-trend context: continuation with the trend, reversal against it. Not scored by the main engine today (weight 0).' },
  DESCENDING_TRIANGLE: { group: 'context-dependent', note: 'Study VI — same context-dependent read as Ascending Triangle, mirrored. Not scored by the main engine today (weight 0).' },
  SYMMETRICAL_TRIANGLE: { group: 'continuation', note: 'Study III/VI — book\'s own #3-ranked major reversal-or-continuation pattern overall (Triangle family); Symmetrical specifically leans continuation far more often than reversal.' },
  RECTANGLE: { group: 'continuation', note: 'Study VI — classical continuation formation ("Major Continuation Formations").' },
  BULL_FLAG: { group: 'continuation', note: 'Study VI/X — Flag; book\'s own "most accurate measuring forecasts" among all its formations — see measuring-rule section below.' },
  BEAR_FLAG: { group: 'continuation', note: 'Study VI/X — same standing as Bull Flag, mirrored.' },
  PENNANT: { group: 'continuation', note: 'Study VI/X — same family as Flag, same mast-length measuring implication.' },
  HALF_MAST: { group: 'continuation', note: 'Study X — "Half-mast Congestion": looser-shaped cousin of Flag/Pennant (tight, brief, low-volume mid-mast pause), same measuring implication as a true Flag.' },
  STAIRCASE: { group: 'not-covered', note: 'Not a Schabacker-era formation — this is a later, non-1932 pattern convention; no book citation applies.' },
  CUP_AND_HANDLE: { group: 'not-covered', note: 'Not a Schabacker-era formation — this is a later, non-1932 pattern convention; no book citation applies.' },
  BULL_TRAP: { group: 'not-covered', note: 'Not a formal Schabacker formation type, but conceptually matches the book\'s own "false move/shake-out" caution (Study III/VI): even a volume-confirmed break can occasionally be false, with no fully reliable distinguishing criterion.' },
  BEAR_TRAP: { group: 'not-covered', note: 'Same as Bull Trap, mirrored.' },
};

/** Exposed so the parity test can assert the table rather than sample it. */
export const SCHABACKER_PATTERN_TAXONOMY = PATTERN_TAXONOMY;

// ── 1. Trend classification (Study I) ──────────────────────────────────

export interface TrendRead {
  readonly major: { readonly regime: Regime; readonly techScore: number };
  readonly intermediate: { readonly weeklyTrend: string | null; readonly agreement: string };
  readonly minor: { readonly roc10: number | null; readonly mom5: number | null };
  readonly read: string;
}

/**
 * The book's three-tier movement framing: major, intermediate, minor.
 *
 * Reuses the engine's regime for major and its weekly trend for
 * intermediate -- and for the agreement text it REUSES the Multi-Timeframe
 * driver's own note rather than recomputing the comparison, so the two can
 * never disagree. If that driver is missing it falls back to the same
 * "insufficient history" wording the driver itself would have produced.
 *
 * The minor tier is deliberately thin (10-day ROC, 5-day momentum): the
 * book calls day-to-day fluctuation its least significant tier, and the
 * read string says so rather than giving it equal billing.
 */
export function schabackerTrendRead(ind: Indicators, techPlan: SchabackerTechPlan): TrendRead {
  const major = { regime: techPlan.regime, techScore: techPlan.techScore };
  const mtDriver = (techPlan.drivers || []).find((d) => d.label === 'Multi-Timeframe');
  const intermediate = {
    weeklyTrend: ind.weeklyTrend || null,
    agreement: mtDriver ? mtDriver.note : 'insufficient history for the 40-week comparison',
  };
  const minor = {
    roc10: ind.roc10 != null ? ind.roc10 : null,
    mom5: ind.mom5 != null ? ind.mom5 : null,
  };
  const read = 'Major: ' + major.regime + ' (tech score ' + major.techScore + '/100). '
    + 'Intermediate (weekly): ' + (intermediate.weeklyTrend || 'n/a') + ' — ' + intermediate.agreement + '. '
    + 'Minor (short-term day-to-day fluctuation, book\'s own least-significant tier): '
    + (minor.roc10 != null ? '10-day ROC ' + minor.roc10.toFixed(1) + '%' : 'n/a');
  return { major, intermediate, minor, read };
}

// ── 2. Pattern read (Studies II-VII) ───────────────────────────────────

export interface LabelledPattern {
  readonly type: string;
  readonly group: PatternGroup;
  readonly note: string;
  readonly confirmed: boolean;
}

export interface PatternRead {
  readonly patterns: readonly LabelledPattern[];
  readonly confirmedReversals: readonly LabelledPattern[];
  readonly confirmedContinuations: readonly LabelledPattern[];
}

/**
 * LABELS the engine's existing detections against the book's taxonomy.
 * Detects nothing.
 *
 * `confirmed: p.confirmed === true` is a strict identity check, so the many
 * pattern shapes that use `status` instead of `confirmed` (see
 * chartPatterns.ts -- five distinct output shapes coexist) all read as
 * unconfirmed here. That is the legacy behaviour, reproduced: those
 * patterns can therefore never appear in confirmedReversals or
 * confirmedContinuations, and so can never reach the synthesis.
 */
export function schabackerPatternRead(chartPatterns: unknown): PatternRead {
  const list = (chartPatterns || []) as Array<{ type: string; confirmed?: unknown }>;
  const patterns: LabelledPattern[] = list.map((p) => {
    const tax = PATTERN_TAXONOMY[p.type]
      || { group: 'not-covered' as PatternGroup, note: 'Pattern type not present in the book\'s own taxonomy.' };
    return { type: p.type, group: tax.group, note: tax.note, confirmed: p.confirmed === true };
  });
  return {
    patterns,
    confirmedReversals: patterns.filter((p) => p.group === 'reversal' && p.confirmed),
    confirmedContinuations: patterns.filter((p) => p.group === 'continuation' && p.confirmed),
  };
}

// ── 3. Support/resistance + trend line (Studies VIII-IX) ───────────────

export interface WeightedLevel {
  readonly level: number;
  readonly touchCount: number;
  readonly volumeWeightedStrength: number;
}

export interface SrTrendLineRead {
  readonly memoryFactor: {
    readonly resistance: readonly WeightedLevel[];
    readonly support: readonly WeightedLevel[];
    readonly note: string;
  };
  readonly roleReversal: { readonly note: string };
  readonly criticalLevels: { readonly nearRoundNumber: unknown; readonly note: string };
  readonly halfway: {
    readonly retracedPct: number; readonly classification: string; readonly note: string;
  } | null;
}

/**
 * The "memory factor", role reversal, round numbers and the half-way rule.
 *
 * Only levels that actually carry `volumeWeightedStrength` are surfaced --
 * the book's point is that volume at a touch matters, not touch count, so a
 * level without that measurement has nothing to say here and is dropped
 * rather than listed with a blank.
 *
 * `roleReversal` is a note ONLY. The principle (broken resistance becomes
 * support) is disclosed but not re-verified per level, and the note says so
 * instead of implying a computation happened.
 *
 * FLAGGED (F-19): the legacy signature is (ind, confluence) and
 * `confluence` is never read -- measured as 0 uses in the body. Dropped
 * here rather than carried as dead weight.
 */
export function schabackerSrTrendLineRead(ind: Indicators): SrTrendLineRead {
  const srLevels = (ind.srLevels || {}) as {
    resistanceLevels?: unknown[]; supportLevels?: unknown[];
  };
  const withVolumeWeight = (levels: unknown[] | undefined): WeightedLevel[] =>
    ((levels || []) as Array<{ level: number; touchCount: number; volumeWeightedStrength: number | null }>)
      .filter((l) => l.volumeWeightedStrength != null)
      .map((l) => ({
        level: l.level, touchCount: l.touchCount,
        volumeWeightedStrength: l.volumeWeightedStrength as number,
      }));

  const halfwayRead = ind.halfwayRetracementRead as
    { retracedPct: number; classification: string } | null | undefined;

  return {
    memoryFactor: {
      resistance: withVolumeWeight(srLevels.resistanceLevels),
      support: withVolumeWeight(srLevels.supportLevels),
      note: 'Study IX "memory factor" — higher volume at a touch means a stronger future level, not just touch-count/recency. Informational, not scored.',
    },
    roleReversal: {
      note: 'Study VIII/IX — a broken resistance level becomes support (and vice versa) once decisively crossed; disclosed principle, not independently re-verified per-level here (see srLevels above for which levels are currently in play).',
    },
    criticalLevels: {
      nearRoundNumber: ind.roundNumber || null,
      note: 'Study IX — the book calls out round 50/100-point levels as having outsized psychological significance; reuses the engine\'s existing round-numbers feature.',
    },
    halfway: halfwayRead
      ? {
        retracedPct: halfwayRead.retracedPct,
        classification: halfwayRead.classification,
        note: 'Study IX "Half-way Intermediate Movement Theory" — retracement of half or less of the prior swing is normal; more than half (book\'s own safer cutoff: two-thirds) raises real suspicion of a major-trend reversal.',
      }
      : null,
  };
}

// ── 4. Gap classification (Study VII) ──────────────────────────────────

/**
 * The book's four-type gap taxonomy plus its own reliability verdicts.
 *
 * Note which one the book calls most important: EXHAUSTION, not BREAKAWAY.
 * An exhaustion gap says the CURRENT move is running out of strength -- it
 * contradicts the trend rather than confirming it -- which is why the
 * synthesis below treats a down-move exhaustion gap as bullish.
 */
const GAP_RELIABILITY: Readonly<Record<string, string>> = {
  COMMON: 'Study VII — least significant of the four; the book\'s own "doesn\'t interest me" default.',
  BREAKAWAY: 'Study VII — significant when touch/volume-confirmed; marks the start of a new move out of a genuine consolidation.',
  RUNAWAY: 'Study VII — a continuation ("measuring") gap occurring mid-move, confirming the existing trend is still intact.',
  EXHAUSTION: 'Study VII — the book\'s own words: "the most important of the four." Signals the CURRENT move is running out of strength, not confirming it.',
  ISLAND: 'Study V/VII — see Island Reversal in the pattern-read section above; validity depends on the two-part same-level/stayed-open rule.',
};

export const SCHABACKER_GAP_RELIABILITY = GAP_RELIABILITY;

export interface LabelledGap {
  readonly date: unknown;
  readonly direction: string;
  readonly level: number;
  readonly gapType: string;
  readonly reliabilityNote: string;
  readonly hindsightDependent: boolean;
  /** Only meaningful for ISLAND; null for every other type. */
  readonly meetsStrictValidity: boolean | null;
}

export interface GapRead {
  readonly gaps: readonly LabelledGap[];
  readonly mostImportant: readonly LabelledGap[];
}

/**
 * Labels the most recent gaps, default last 10.
 *
 * `hindsightDependent` is carried through honestly: some classifications
 * can only be made after the fact, and a reader deserves to know which.
 * `meetsStrictValidity` is deliberately null for non-ISLAND types rather
 * than false -- "not applicable" and "failed the test" are different
 * claims.
 */
export function schabackerGapRead(priceGaps: unknown, lookback?: number | null): GapRead {
  const n = lookback || 10;
  const recent = ((priceGaps || []) as Array<Record<string, unknown>>)
    .slice(-n)
    .filter((g) => g.gapType);
  const gaps: LabelledGap[] = recent.map((g) => ({
    date: g.date != null ? g.date : null,
    direction: g.type as string,
    level: g.level as number,
    gapType: g.gapType as string,
    reliabilityNote: GAP_RELIABILITY[g.gapType as string]
      || 'No book-cited reliability note for this classification.',
    hindsightDependent: g.gapTypeHindsightDependent === true,
    meetsStrictValidity: g.gapType === 'ISLAND' ? g.meetsStrictValidity === true : null,
  }));
  return { gaps, mostImportant: gaps.filter((g) => g.gapType === 'EXHAUSTION') };
}

// ── 5. Measuring rules (Study X) ───────────────────────────────────────

export interface MeasuringObjective {
  readonly type: string;
  readonly measuredTarget: number;
}

export interface MeasuringRulesRead {
  readonly objectives: readonly MeasuringObjective[];
  readonly excludedNote: string;
}

/**
 * Surfaces the measured targets already computed on H&S/Flag/Pennant/
 * Half-mast patterns.
 *
 * The `excludedNote` is not boilerplate -- it is the whole point of the
 * section. Triangle and gap measuring are omitted because the book TESTED
 * them and concluded "no reliance can be placed" on either, and the note
 * also carries the book's own caveat that every objective is a rough
 * probable target, never a guarantee.
 */
export function schabackerMeasuringRules(chartPatterns: unknown): MeasuringRulesRead {
  const objectives = ((chartPatterns || []) as Array<{ type: string; measuredTarget?: number | null }>)
    .filter((p) => p.measuredTarget != null)
    .map((p) => ({ type: p.type, measuredTarget: p.measuredTarget as number }));
  return {
    objectives,
    excludedNote: 'Study X — Triangle and Gap measuring-rule price theories are explicitly excluded from this section: the book\'s own tested conclusion is "no reliance can be placed" on either. Every objective above is a rough, probable target, never a guarantee (book\'s own worked examples show real under/overshoot).',
  };
}

// ── 6. Classical stop (Study X) ────────────────────────────────────────

export type ClassicalStopRead =
  | { readonly available: false; readonly note: string }
  | {
    readonly available: true; readonly level: number; readonly basingPointDate: Date;
    readonly basingPointPrice: number; readonly direction: string; readonly note: string;
  };

/**
 * Surfaces the classical stop as its own cited output.
 *
 * Takes a single snapshot with no entry context, so it deliberately does
 * NOT walk forward -- and the note says "static at this basing point"
 * rather than leaving the reader to assume it trails. The real trailing
 * version needs an entry date and lives in exitRead.ts
 * (computeClassicalStopTrailing), which is the correct call site.
 */
export function schabackerClassicalStop(
  classicalStop: SchabackerTechPlan['classicalStop'],
): ClassicalStopRead {
  if (!classicalStop) {
    return {
      available: false,
      note: 'Classical stop unavailable for this ticker (e.g. insufficient price history).',
    };
  }
  return {
    available: true,
    level: classicalStop.level,
    basingPointDate: classicalStop.basingPointDate,
    basingPointPrice: classicalStop.basingPointPrice,
    direction: classicalStop.direction,
    note: 'Study X — real swing basing point + volatility-scaled buffer + round-number avoidance, distinct from the main engine\'s ATR-multiple stop. Not empirically validated (same standing caveat as every other threshold in this engine). Static at this basing point — does not currently walk forward with new swing points.',
  };
}

// ── 7. Trading tactics (Study XII) ─────────────────────────────────────

export interface TradingTacticsRead {
  readonly priceLevelFit: string;
  readonly relativeSwingPower: {
    readonly ratio: number; readonly etf: string;
    readonly sector: string; readonly note: string;
  } | null;
  readonly diversificationNote: string;
}

/**
 * The book's price-level guidance for a beginner's program.
 *
 * ══ THE BAND ORDER MATTERS, AND LEAVES A GAP ═══════════════════════════
 * Branches run: < $10 cautioned, $15-60 ideal, > $60 above-range, else
 * below-range-but-above-the-caution-line. That final `else` catches
 * $10 <= price < $15 -- a real band the book treats as neither ideal nor
 * cautioned, and reproducing the order is what preserves it. Reordering the
 * branches would silently reclassify those stocks.
 *
 * Falls back from chart.currentPrice to ind.last, and reports 'n/a' when
 * both are absent rather than guessing.
 */
export function schabackerTradingTactics(chart: ModelChart, ind: Indicators): TradingTacticsRead {
  const price = chart.currentPrice != null ? chart.currentPrice : ind.last;
  let priceLevelFit: string;
  if (price == null) priceLevelFit = 'n/a';
  else if (price < 10) priceLevelFit = 'CAUTIONED — below $10, book\'s own "erratic then long stagnant stretches" caution for very low-priced stocks.';
  else if (price >= 15 && price <= 60) priceLevelFit = 'IDEAL — within the book\'s own $15-60 range for a beginning trader\'s program.';
  else if (price > 60) priceLevelFit = 'Above the book\'s own $15-60 ideal range — very high-priced stocks show less profitable % moves per the book.';
  else priceLevelFit = 'Below the book\'s own $15-60 ideal range but above its $10 caution line.';

  const rsp = chart.relativeSwingPower || null;
  const relativeSwingPower = rsp
    ? {
      ratio: rsp.ratio, etf: rsp.etf, sector: rsp.sector,
      note: 'Study XII — swings '
        + (rsp.ratio >= 1
          ? ((rsp.ratio - 1) * 100).toFixed(0) + '% wider than'
          : ((1 - rsp.ratio) * 100).toFixed(0) + '% narrower than')
        + ' its own sector average.',
    }
    : null;

  return {
    priceLevelFit,
    relativeSwingPower,
    diversificationNote: 'Study XII — book\'s own diversification/list-size guidance is a portfolio-level judgment (how many tickers to actively chart/trade at once), not a single-ticker computation; not derived here for lack of the user\'s own full position list in this scope.',
  };
}

// ── 8. Exclusions ──────────────────────────────────────────────────────

export interface Exclusion {
  readonly item: string;
  readonly reason: string;
}

/**
 * Seven things this model deliberately does not implement.
 *
 * Five of the seven are the book's OWN tested negative verdicts, quoted.
 * That is unusual and worth preserving: most sources list what works, and
 * this one also reports what it tried and found wanting.
 */
export function schabackerExclusions(): Exclusion[] {
  return [
    { item: 'Point & Figure / intraday charts', reason: 'Book\'s own explicit, tested, NEGATIVE verdict for intraday; Point & Figure "offers no advantages over the ordinary vertical line chart." Also a genuine architecture mismatch — this engine is EOD-bar only.' },
    { item: 'Dow Theory (formal tenets) for single-stock use', reason: 'Book\'s own explicit verdict: "of extremely limited value" for individual-stock trading.' },
    { item: 'Time-cycle theories', reason: 'Book\'s own explicit, tested, NEGATIVE verdict: "not one single reliable rule of time has ever been discovered."' },
    { item: 'Triangle measuring rule', reason: 'Book\'s own explicit, tested, NEGATIVE verdict: "no reliance can be placed."' },
    { item: 'Gap measuring theories (single/multiple)', reason: 'Book\'s own explicit, tested, NEGATIVE verdict.' },
    { item: 'Inverted Triangle', reason: 'Real rarity (~1:30-40 vs. normal triangles), poor directional reliability per the book\'s own repeated caution.' },
    { item: 'Monthly/group/average charts as their own feature', reason: 'Book\'s own explicit verdict: "time more profitably spent on individual charts."' },
  ];
}

// ── Top-level builder ──────────────────────────────────────────────────

export interface SchabackerSynthesis {
  readonly bullish: readonly string[];
  readonly cautionary: readonly string[];
  readonly netRead: string;
}

export interface SchabackerReport {
  readonly ticker: string;
  readonly trend: TrendRead;
  readonly patternRead: PatternRead;
  readonly srTrendLine: SrTrendLineRead;
  readonly gapRead: GapRead;
  readonly measuringRules: MeasuringRulesRead;
  readonly classicalStop: ClassicalStopRead;
  readonly tradingTactics: TradingTacticsRead;
  readonly exclusions: readonly Exclusion[];
  readonly synthesis: SchabackerSynthesis;
}

/**
 * The seven pattern types the synthesis treats as bullish reversals.
 *
 * Everything else in the `reversal` group is treated as bearish -- so this
 * is a whitelist, not a pair of lists, and an unrecognised reversal type
 * would be classified bearish by default. Reproduced as written.
 */
const BULLISH_REVERSAL_TYPES = [
  'INVERSE_HEAD_AND_SHOULDERS', 'DOUBLE_BOTTOM', 'TRIPLE_BOTTOM', 'COMPLEX_BOTTOM',
  'BROADENING_BOTTOM', 'DIAMOND_BOTTOM', 'ROUNDING_BOTTOM',
];

/**
 * Builds the whole report.
 *
 * Same count-not-score synthesis as the Edwards & Magee model: `netRead`
 * compares list lengths and nothing else, every signal weighs the same, and
 * ties are indistinguishable from emptiness.
 *
 * ══ ONE ASYMMETRY WORTH READING TWICE ══════════════════════════════════
 * An EXHAUSTION gap on a DOWN move is BULLISH here, and on an UP move
 * CAUTIONARY -- the opposite of how most gap signals read. That is correct
 * per the book: an exhaustion gap says the move in progress is running out
 * of strength, so it argues against the prevailing direction rather than
 * for it.
 *
 * FLAGGED (F-19): the legacy signature is
 * (ticker, ind, gann, confluence, techPlan, chart, log). Measured on the
 * body with strings and comments stripped: `gann` has 0 uses, and
 * `confluence` has 1 -- passed to schabackerSRTrendLineReadV1_, which
 * itself uses it 0 times. Both are transitively dead, so this takes five
 * parameters, not seven.
 */
export function buildSchabackerReport(
  ticker: string,
  ind: Indicators,
  techPlan: SchabackerTechPlan,
  chart: ModelChart,
  log?: (msg: string) => void,
): SchabackerReport | null {
  try {
    const trend = schabackerTrendRead(ind, techPlan);
    const patternRead = schabackerPatternRead(ind.chartPatterns);
    const srTrendLine = schabackerSrTrendLineRead(ind);
    const gapRead = schabackerGapRead(ind.priceGaps);
    const measuringRules = schabackerMeasuringRules(ind.chartPatterns);
    const classicalStop = schabackerClassicalStop(techPlan.classicalStop);
    const tradingTactics = schabackerTradingTactics(chart, ind);
    const exclusions = schabackerExclusions();

    const bullish: string[] = [];
    const cautionary: string[] = [];

    patternRead.confirmedReversals.forEach((p) => {
      if (BULLISH_REVERSAL_TYPES.indexOf(p.type) > -1) {
        bullish.push('Pattern: confirmed bullish reversal (' + p.type + ')');
      } else {
        cautionary.push('Pattern: confirmed bearish reversal (' + p.type + ')');
      }
    });
    gapRead.mostImportant.forEach((g) => {
      // Inverted on purpose -- see the function doc.
      if (g.direction === 'DOWN') {
        bullish.push('Gap: Exhaustion gap on a down-move — downtrend may be ending (Study VII)');
      } else {
        cautionary.push('Gap: Exhaustion gap on an up-move — uptrend may be ending (Study VII)');
      }
    });
    if (srTrendLine.halfway) {
      if (srTrendLine.halfway.classification === 'normal') {
        bullish.push('Retracement: within Schabacker\'s normal half-or-less band, trend structure intact (Study IX)');
      } else if (srTrendLine.halfway.classification === 'suspect-major-reversal') {
        cautionary.push('Retracement: exceeds the book\'s own two-thirds safer cutoff — suspect major reversal (Study IX)');
      }
    }
    const tav = ind.trendAlignedVolume as { aligned: boolean } | null | undefined;
    if (tav) {
      if (tav.aligned) bullish.push('Volume confirms trend direction (Study VIII)');
      else cautionary.push('Volume NOT confirming trend direction (Study VIII)');
    }
    const vpd = ind.volumeProgressDivergence as { flagged: boolean } | null | undefined;
    if (vpd && vpd.flagged) {
      cautionary.push('High volume, minimal net price progress — possible distribution/resistance absorption (Study VIII)');
    }
    if (tradingTactics.priceLevelFit.indexOf('IDEAL') === 0) {
      bullish.push('Price in the book\'s own ideal $15-60 trading range (Study XII)');
    } else if (tradingTactics.priceLevelFit.indexOf('CAUTIONED') === 0) {
      cautionary.push('Price below $10 — book\'s own cautioned range (Study XII)');
    }

    const netRead = bullish.length > cautionary.length ? 'Net read leans supportive'
      : cautionary.length > bullish.length ? 'Net read leans cautionary'
        : 'Net read is mixed/neutral — no clear lean';

    return {
      ticker, trend, patternRead, srTrendLine, gapRead, measuringRules,
      classicalStop, tradingTactics, exclusions,
      synthesis: { bullish, cautionary, netRead },
    };
  } catch (e) {
    log?.('Schabacker model: report build failed for ' + ticker + ' — '
      + (e && (e as Error).message ? (e as Error).message : String(e)));
    return null;
  }
}

// ── Plain-text formatter ───────────────────────────────────────────────

/**
 * Renders the report as plain text.
 *
 * The header uses '── X ──' rather than '=== X ===' for the same reason as
 * every other report in this project: Apps Script's setValue() treats a
 * leading '=' as a FORMULA, which rendered a real live Sheet cell as
 * #ERROR!. See the note in edwardsMagee.ts.
 *
 * ══ FLAGGED (F-18): THE UNAVAILABLE STOP NOTE PRINTS TWICE ═════════════
 * Section 6 is:
 *
 *     if (available) { push(stop line) } else { push(note) }
 *     push('  ' + (note || ''))          <- unconditional
 *
 * On the AVAILABLE path that trailing push is the intended note line. On
 * the UNAVAILABLE path the note has already been pushed by the else, so it
 * prints a second time, verbatim, on the next line.
 *
 * Confirmed by execution against the oracle, not inferred from reading:
 *
 *   [1] "  Classical stop unavailable for this ticker (e.g. insufficient price history)."
 *   [2] "  Classical stop unavailable for this ticker (e.g. insufficient price history)."
 *
 * Reproduced exactly, NOT fixed -- it is user-visible report text and the
 * port-fidelity rule applies. The parity test pins the duplication so a
 * future cleanup is a deliberate decision rather than an accident.
 */
export function formatSchabackerReport(report: SchabackerReport | null, opts: ModelTextOptions = {}): string {
  if (!report) return 'No report — data unavailable.';
  const plain = !!opts.plainText;
  const lines: string[] = [];
  const push = (s: string): void => {
    lines.push(s);
  };

  push('── ' + report.ticker + ' — Schabacker Model v1 ──');
  push('');
  push('1. TREND CLASSIFICATION (Study I)');
  push('  ' + report.trend.read);
  push('');

  push('2. REVERSAL/CONTINUATION PATTERN READ (Studies II-VII)');
  if (!report.patternRead.patterns.length) push('  No chart patterns currently detected.');
  if (plain) {
    // D14: one line per distinct pattern read, with a count (legacy listed BULL_TRAP x4 verbatim).
    countDistinct(report.patternRead.patterns, (p) => p.type + '|' + p.group + '|' + p.confirmed + '|' + p.note).forEach(({ item: p, count }) => {
      push('  - ' + p.type + ' [' + p.group + ']' + (p.confirmed ? ' — CONFIRMED' : ' — forming') + (count > 1 ? ' (detected ' + count + ' times)' : ''));
      push('      ' + p.note);
    });
  } else report.patternRead.patterns.forEach((p) => {
    push('  - ' + p.type + ' [' + p.group + ']' + (p.confirmed ? ' — CONFIRMED' : ' — forming'));
    push('      ' + p.note);
  });
  push('');

  push('3. SUPPORT/RESISTANCE + TREND-LINE READ (Studies VIII-IX)');
  push('  ' + report.srTrendLine.roleReversal.note);
  push('  ' + report.srTrendLine.memoryFactor.note);
  if (report.srTrendLine.criticalLevels.nearRoundNumber) {
    // JSON.stringify of the raw read, as legacy does -- not a formatted
    // sentence. Reproduced because the output is user-visible.
    push('  Near round number: ' + (plain ? roundNumberText(report.srTrendLine.criticalLevels.nearRoundNumber) : JSON.stringify(report.srTrendLine.criticalLevels.nearRoundNumber)));
  }
  if (report.srTrendLine.halfway) {
    push('  Half-way retracement: ' + (report.srTrendLine.halfway.retracedPct * 100).toFixed(1)
      + '% — ' + report.srTrendLine.halfway.classification + '. ' + report.srTrendLine.halfway.note);
  }
  push('');

  push('4. GAP CLASSIFICATION (Study VII)');
  if (!report.gapRead.gaps.length) push('  No recent gaps.');
  report.gapRead.gaps.forEach((g) => push('  - ' + g.direction + ' gap @ ' + g.level.toFixed(2)
    + ': ' + g.gapType
    + (g.hindsightDependent ? ' (hindsight-dependent)' : '')
    + (g.meetsStrictValidity != null ? ', meetsStrictValidity=' + g.meetsStrictValidity : '')
    + ' — ' + g.reliabilityNote));
  push('');

  push('5. MEASURING-RULE PRICE OBJECTIVES (Study X)');
  if (!report.measuringRules.objectives.length) {
    push('  No pattern currently carries a measured objective.');
  }
  report.measuringRules.objectives.forEach((o) => push('  - ' + o.type + ': $'
    + o.measuredTarget.toFixed(2)));
  push('  ' + report.measuringRules.excludedNote);
  push('');

  push('6. CLASSICAL STOP-LOSS (Study X)');
  if (report.classicalStop.available) {
    // basingPointDate concatenated directly -> Date's default toString,
    // which is locale and timezone dependent. Reproduced as-is.
    push('  Stop: $' + report.classicalStop.level.toFixed(2) + ' (basing point $'
      + report.classicalStop.basingPointPrice.toFixed(2) + ' on '
      + (plain ? shortDate(report.classicalStop.basingPointDate as never, opts.timeZone) : report.classicalStop.basingPointDate) + ', ' + report.classicalStop.direction + ')');
  } else {
    push('  ' + report.classicalStop.note);
  }
  // F-18 lives on the next line. Unconditional by design in legacy, which
  // is why the unavailable path prints its note twice (plain text prints it once).
  if (!(plain && !report.classicalStop.available)) push('  ' + (report.classicalStop.note || ''));
  push('');

  push('7. TRADING TACTICS (Study XII)');
  push('  Price-level fit: ' + report.tradingTactics.priceLevelFit);
  if (report.tradingTactics.relativeSwingPower) {
    const rsp = report.tradingTactics.relativeSwingPower;
    push('  Relative swing power: ' + rsp.ratio.toFixed(2) + 'x vs ' + rsp.etf + '/'
      + rsp.sector + ' — ' + rsp.note);
  }
  push('  ' + report.tradingTactics.diversificationNote);
  push('');

  push('8. EXPLICIT EXCLUSIONS');
  report.exclusions.forEach((e) => push('  - ' + e.item + ': ' + e.reason));
  push('');

  push('9. FINAL SYNTHESIS: ' + report.synthesis.netRead);
  report.synthesis.bullish.forEach((b) => push('  [+] ' + b));
  report.synthesis.cautionary.forEach((c) => push('  [-] ' + c));

  return lines.join('\n');
}
