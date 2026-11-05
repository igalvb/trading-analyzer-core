/**
 * The Edwards & Magee model report (edwardsMageeModelV1.gs, 11 functions).
 *
 * ══ WHAT THIS FILE IS, AND WHAT IT IS NOT ══════════════════════════════
 * It computes NOTHING. Every one of the eleven functions is a pure
 * transform of objects the main engine already built for the same ticker in
 * the same run -- `ind`, `techPlan`, `chartPatterns` go in, labelled and
 * book-cited report objects come out. Measured, not assumed: a
 * comment-stripped scan of the whole file finds zero calls to any function
 * outside it.
 *
 * That makes it the cleanest of the five model files and the right one to
 * port first. It also means it cannot diverge numerically from the engine
 * -- there is no arithmetic here to get wrong, only labelling.
 *
 * ══ THREE INPUTS THAT ARE NOT INDICATORS ═══════════════════════════════
 * `dowTheoryConfirmation`, `evaluativeIndex` and `relativeStrengthRanking`
 * are NOT among the 115 indicator fields. They are attached to `ind` by
 * separate daily trigger caches (macro_fetchers, darkPoolTracker), so in
 * any isolated run they are simply absent and every read degrades to
 * `available: false`.
 *
 * That is exactly the vacuous-verification trap that hid the wyckoff and
 * macro-regime bugs: comparing null-to-null proves nothing. The parity test
 * therefore INJECTS synthetic values for all three and exercises every
 * verdict arm, rather than confirming that both sides agree on "no data".
 */

import type { Indicators } from '../../types/indicators.ts';
import { assumedAccountText, shortDate, type ModelTextOptions } from './modelText.ts';

/**
 * Indicators plus the three trigger-cache attachments.
 *
 * Typed as a separate shape rather than widened into `Indicators` because
 * they genuinely are not indicators -- nothing in computeIndicators
 * produces them, and pretending otherwise would make the 115-field
 * assertion a lie.
 */
export interface EnrichedIndicators extends Indicators {
  readonly dowTheoryConfirmation?: DowTheoryCache | null;
  readonly evaluativeIndex?: EvaluativeIndexCache | null;
  readonly relativeStrengthRanking?: RelativeStrengthCache | null;
}

export interface DowTheoryCache {
  readonly verdict: string;
  readonly industrials: { readonly close: number };
  readonly transports: { readonly close: number };
}

export interface EvaluativeIndexCache {
  readonly pctStrong: number;
  readonly strong: number;
  readonly weak: number;
  readonly unavailable: number;
  readonly read: string;
}

export interface PeerRef {
  readonly ticker: string;
}

export interface RelativeStrengthCache {
  readonly categories: readonly string[];
  readonly rank: number;
  readonly peerCount: number;
  readonly percentile: number;
  readonly read: string;
  readonly topPeers: readonly PeerRef[];
  readonly bottomPeers: readonly PeerRef[];
}

/** Everything the model reads off the tech plan. All Tier C outputs. */
export interface ModelTechPlan {
  readonly basingPointStop?: {
    readonly level: number; readonly basingPointDate: Date; readonly basingPointPrice: number;
    readonly stopPct: number; readonly sensitivityTier: string;
  } | null;
  readonly nNormalizedPositionSize?: {
    readonly shares: number; readonly stopLevel: number;
    readonly dollarRisk: number; readonly riskPctOfAccount: number;
  } | null;
  readonly compositeLeverage?: {
    readonly leverage: number; readonly normalRangeForPrice: number; readonly tier: string;
  } | null;
  readonly fanPrinciple?: {
    readonly triggered: boolean; readonly brokenCount: number; readonly flattening: boolean;
    readonly originDate: Date; readonly originPrice: number;
  } | null;
  readonly trendChannel?: {
    readonly basicTrendline: { readonly currentValue: number };
    readonly returnLine: { readonly currentValue: number };
    readonly shortfall: number; readonly projectedOvershoot: number | null;
  } | null;
}

// ── 1. Dow Theory (Ch3-5.1) ────────────────────────────────────────────

/**
 * The verdict labels, keyed by cache verdict.
 *
 * An unrecognised verdict falls through to the raw string (`|| dt.verdict`),
 * so a new cache value surfaces visibly rather than rendering as undefined.
 */
const DOW_VERDICT_LABELS: Readonly<Record<string, string>> = {
  BULL_CONFIRMED: 'BULL CONFIRMED — both DIA (Industrials proxy) & IYT (Transports proxy) at new 52wk closing highs',
  BEAR_CONFIRMED: 'BEAR CONFIRMED — both DIA & IYT at new 52wk closing lows',
  NON_CONFIRMATION_BULL: 'NON-CONFIRMATION — only 1 of DIA/IYT made a new high; the book\'s own real named concept for "distrust the signal"',
  NON_CONFIRMATION_BEAR: 'NON-CONFIRMATION — only 1 of DIA/IYT made a new low; distrust the signal',
  NEUTRAL: 'neutral — neither real broad-market average at a 52wk extreme',
};

export type DowTheoryRead =
  | { readonly available: false; readonly note: string }
  | {
    readonly available: true; readonly verdict: string; readonly read: string;
    readonly industrials: { readonly close: number };
    readonly transports: { readonly close: number };
    readonly note: string;
  };

/**
 * Market-level, not per-ticker: the same DIA/IYT verdict applies to every
 * ticker in the run. The book's foundational rule is that BOTH averages
 * must independently confirm before a signal is trusted -- which is why
 * "non-confirmation" is its own named outcome rather than just "neutral".
 */
export function edwardsMageeDowTheory(ind: EnrichedIndicators): DowTheoryRead {
  const dt = ind.dowTheoryConfirmation;
  if (!dt) {
    return {
      available: false,
      note: 'Dow Theory Confirmation unavailable (trigger cache stale/missing — see refreshMacroRegimeCacheV1, macro_fetchers_v0_12.gs).',
    };
  }
  return {
    available: true,
    verdict: dt.verdict,
    read: DOW_VERDICT_LABELS[dt.verdict] || dt.verdict,
    industrials: dt.industrials,
    transports: dt.transports,
    note: 'Ch3-5.1 — the book\'s own real foundational rule: both real broad-market averages must independently confirm a new high/low before the signal is trusted. Market-level, applies the same way for every ticker in this run.',
  };
}

// ── 2. Basing point + progressive stop (Ch27/28/28.1) ──────────────────

export interface StopsRead {
  readonly basingPoint: Record<string, unknown>;
  readonly progressive: Record<string, unknown>;
}

/**
 * Surfaces the Ch28 basing-point stop and the Ch27 progressive stop as one
 * section.
 *
 * The two are different in kind, which the notes make explicit: the basing
 * point is a standing stop LEVEL, while the progressive stop is a
 * single-day TRIGGER ("for the day only") on climactic volume. Reporting
 * them together without that distinction would read as two competing
 * levels.
 */
export function edwardsMageeStops(techPlan: ModelTechPlan, ind: EnrichedIndicators): StopsRead {
  const bps = techPlan.basingPointStop;
  const basingPoint = bps
    ? {
      available: true, level: bps.level, basingPointDate: bps.basingPointDate,
      basingPointPrice: bps.basingPointPrice, stopPct: bps.stopPct,
      sensitivityTier: bps.sensitivityTier,
      note: 'Ch27/28/28.1 — the real "Three Days Away" confirmed swing point + the book\'s own 6-price-tier x 3-sensitivity-tier stop-distance table, distinct from Schabacker\'s own classical stop (flat ATR-scaled buffer, no confirmation wait).',
    }
    : {
      available: false,
      note: 'Basing Point stop unavailable for this ticker (e.g. no confirmed swing point yet).',
    };

  const psf = ind.progressiveStopFlag as
    { level: number; volumeRatio: number; daysSinceCross: number } | null | undefined;
  const progressive = psf
    ? {
      triggered: true, level: psf.level, volumeRatio: psf.volumeRatio,
      daysSinceCross: psf.daysSinceCross,
      note: 'Ch27 — real Progressive/Hair-Trigger Stop trigger: exceptionally heavy volume (>3x avg) on an UP day after an established uptrend — "nine times out of ten" better off tightening to 1/8 point under today\'s close, for the day only.',
    }
    : {
      triggered: false,
      note: 'No Progressive Stop trigger today (needs exceptionally heavy volume on an up day, well into an established uptrend).',
    };

  return { basingPoint, progressive };
}

// ── 3. Evaluative Index (Ch38) ─────────────────────────────────────────

export type EvaluativeIndexRead =
  | { readonly available: false; readonly note: string }
  | {
    readonly available: true; readonly pctStrong: number; readonly strong: number;
    readonly weak: number; readonly unavailable: number; readonly read: string;
    readonly note: string;
  };

/**
 * Magee's continuous market-breadth gauge.
 *
 * The book is explicit that this is NOT a discrete buy/sell signal -- "the
 * Index will float and adjust itself continually" -- and the note says so,
 * because a percentage with historical anchors invites exactly that misuse.
 */
export function edwardsMageeEvaluativeIndex(ind: EnrichedIndicators): EvaluativeIndexRead {
  const ei = ind.evaluativeIndex;
  if (!ei) {
    return {
      available: false,
      note: 'Evaluative Index unavailable (trigger cache stale/missing — see refreshEvaluativeIndexV1, darkPoolTrackerV1.gs).',
    };
  }
  return {
    available: true,
    pctStrong: ei.pctStrong, strong: ei.strong, weak: ei.weak,
    unavailable: ei.unavailable, read: ei.read,
    note: 'Ch38 — Magee\'s own real, continuous market-breadth gauge (85-ticker basket, SMA50>SMA200 Bull/Bear classification). "The Index will float and adjust itself continually" — a real, disclosed continuous read, explicitly NOT a discrete buy/sell signal. Real anchors: ~5-9% Strong = historical Bottom zone, ~90%+ = symmetric Top zone.',
  };
}

// ── 4. Position risk (Ch42, Appendix A/E) ──────────────────────────────

export interface PositionRiskRead {
  readonly sizing: Record<string, unknown>;
  readonly leverage: Record<string, unknown>;
}

/** Both reads are explicitly a CROSS-CHECK against the engine's own sizing, not a replacement. */
export function edwardsMageePositionRisk(techPlan: ModelTechPlan): PositionRiskRead {
  const nps = techPlan.nNormalizedPositionSize;
  const sizing = nps
    ? {
      available: true, shares: nps.shares, stopLevel: nps.stopLevel,
      dollarRisk: nps.dollarRisk, riskPctOfAccount: nps.riskPctOfAccount,
      note: 'Appendix E (Turtle System) — real, volatility-normalized 2nd opinion: sizes the position so a full 2N move (N=20-day Wilder-smoothed True Range) costs exactly 2% of account equity. A cross-check against the main engine\'s own conviction-scaled sizing, not a replacement.',
    }
    : { available: false, note: 'N-normalized position size unavailable for this ticker.' };

  const cl = techPlan.compositeLeverage;
  const leverage = cl
    ? {
      available: true, leverage: cl.leverage, normalRangeForPrice: cl.normalRangeForPrice,
      tier: cl.tier,
      note: 'Appendix A — real (S×N)/15.5 formula (simplified for a cash-only, no-margin strategy, T/C=1), combining this ticker\'s own volatility (Sensitivity Index, approximated via atrRatio, same approximation the Basing Point stop already makes) with its price-level\'s own typical range.',
    }
    : { available: false, note: 'Composite Leverage unavailable for this ticker.' };

  return { sizing, leverage };
}

// ── 5. Fan principle + trend channel (Ch14) ────────────────────────────

export interface FanTrendChannelRead {
  readonly fanPrinciple: Record<string, unknown>;
  readonly trendChannel: Record<string, unknown>;
}

/**
 * Note the fan read surfaces `flattening`, which F-15 established is only
 * a first-vs-third-line comparison and can be true for a non-monotonic fan.
 * Carried through unchanged -- the model report shows what the engine
 * computed, and the finding belongs against the engine, not here.
 */
export function edwardsMageeFanTrendChannel(techPlan: ModelTechPlan): FanTrendChannelRead {
  const fp = techPlan.fanPrinciple;
  const fanPrinciple = fp
    ? {
      available: true, triggered: fp.triggered, brokenCount: fp.brokenCount,
      flattening: fp.flattening, originDate: fp.originDate, originPrice: fp.originPrice,
      note: 'Ch14 — real "Three-Fan Rule": as a correction unfolds, price breaks progressively flatter trendlines drawn from the correction\'s own starting extreme; when the 3rd such line breaks, the book\'s own real claim is the correction is over ("works in the great majority of cases," not independently backtested here).',
    }
    : {
      available: false,
      note: 'Fan Principle read unavailable (needs a clear regime — TREND_UP/TREND_DOWN — and a real correction with 3 confirmed opposite-direction swing points).',
    };

  const tc = techPlan.trendChannel;
  const trendChannel = tc
    ? {
      available: true, basicTrendlineNow: tc.basicTrendline.currentValue,
      returnLineNow: tc.returnLine.currentValue,
      shortfall: tc.shortfall, projectedOvershoot: tc.projectedOvershoot,
      note: 'Ch14 (Fig.156) — real symmetric Trend Channel/Return Line rule: if a swing falls short of its own boundary by some margin, the book\'s own claim is the NEXT swing will overshoot the OPPOSITE boundary by that same margin. Applies to that opposite boundary\'s own value when the next swing occurs (both lines are sloped), not a fixed price today.',
    }
    : {
      available: false,
      note: 'Trend Channel read unavailable (needs a clear regime and at least 1 completed swing after the channel\'s own 2 defining points).',
    };

  return { fanPrinciple, trendChannel };
}

// ── 6. Double top/bottom spacing (Ch37) ────────────────────────────────

export interface SpacingPattern {
  readonly type: string;
  readonly weeksApart: number;
  readonly magnitudePct: number;
  readonly meetsBook: boolean;
}

export interface SpacingCheckRead {
  readonly patterns: readonly SpacingPattern[];
  readonly note: string;
}

/**
 * LABELS existing detections; does not re-detect anything.
 *
 * The book's full-confidence bar (>=6 weeks apart, >=15% intervening move)
 * is strictly tighter than this engine's own 5%/3% detection bar. So a
 * pattern can fire in chartPatterns and still fail here -- `meetsBook` is a
 * quality FLAG, never a gate. Patterns without the field are dropped
 * entirely rather than reported as failing it.
 */
export function edwardsMageeSpacingCheck(chartPatterns: unknown): SpacingCheckRead {
  const list = (chartPatterns || []) as Array<{
    type?: string;
    emSpacingCheck?: { weeksApart: number; magnitudePct: number; meetsBook: boolean };
  }>;
  const withSpacing = list
    .filter((p) => (p.type === 'DOUBLE_TOP' || p.type === 'DOUBLE_BOTTOM') && p.emSpacingCheck)
    .map((p) => ({
      type: p.type as string,
      weeksApart: (p.emSpacingCheck as { weeksApart: number }).weeksApart,
      magnitudePct: (p.emSpacingCheck as { magnitudePct: number }).magnitudePct,
      meetsBook: (p.emSpacingCheck as { meetsBook: boolean }).meetsBook,
    }));
  return {
    patterns: withSpacing,
    note: 'Ch37 (p549) — real, quantified confirmation-quality bar: the book\'s own full-confidence read requires the 2 Tops/Bottoms be >=6 weeks apart with >=15% intervening move. A confirmation-quality FLAG, not a gate — the pattern above still fires on this engine\'s own existing, looser 5%/3% detection bar regardless of whether it meets this stricter bar.',
  };
}

// ── 7. Relative strength ranking (Appendix E) ──────────────────────────

export type RelativeStrengthRead =
  | { readonly available: false; readonly note: string }
  | ({ readonly available: true; readonly note: string } & RelativeStrengthCache);

/**
 * "Buy the strongest, short the weakest" within a correlated group --
 * except the short half is deliberately dropped. Relative weakness is
 * surfaced as a CAUTION only, never a short recommendation, because the
 * user's strategy is long-only/calls-only.
 */
export function edwardsMageeRelativeStrength(ind: EnrichedIndicators): RelativeStrengthRead {
  const rsr = ind.relativeStrengthRanking;
  if (!rsr) {
    return {
      available: false,
      note: 'Relative Strength Ranking unavailable (ticker not in any of the 14 real correlated-group categories, or trigger cache stale/missing — see refreshRelativeStrengthRankingV1_, darkPoolTrackerV1.gs).',
    };
  }
  return {
    available: true,
    categories: rsr.categories, rank: rsr.rank, peerCount: rsr.peerCount,
    percentile: rsr.percentile, read: rsr.read,
    topPeers: rsr.topPeers, bottomPeers: rsr.bottomPeers,
    note: 'Appendix E, Original Turtle Trading System — "buy the strongest, short the weakest" within a correlated group, real formula (CurrentPrice-PriceNMonthsAgo)/CurrentN, real peer group = this project\'s own 14-category dark-pool watchlist. Relative weakness is surfaced as a real caution only, never a short recommendation (this user\'s own long-only/calls-only strategy).',
  };
}

// ── 8/9. Exclusions and the disclosed source conflict ──────────────────

export interface Exclusion {
  readonly item: string;
  readonly reason: string;
}

/**
 * What this model deliberately does NOT implement, and why.
 *
 * Kept as data rather than prose because the report prints it: a reader can
 * see that a chapter was considered and rejected, rather than wondering
 * whether it was missed.
 */
export function edwardsMageeExclusions(): Exclusion[] {
  return [
    { item: 'Appendix E\'s full Turtle entry/exit/pyramiding system as a standalone strategy', reason: 'Confirmed the core mechanic (Donchian(20) breakout channel) is ALREADY built in this engine, explicitly attributed to Turtle Trading in the code\'s own comments — a second, parallel Turtle-branded entry system would duplicate existing functionality, not add to it.' },
    { item: 'Appendix E\'s futures-specific market list, contract-rollover rules, notional-account mechanics', reason: 'Real, but genuinely out of scope — this engine is stocks/ETFs only.' },
    { item: 'Appendix A Chapter D\'s 1964-73 per-company Sensitivity Index data table', reason: 'Confirmed obsolete — wrong era, mostly-defunct/renamed companies, functionally superseded by real modern beta / this project\'s own existing ind.atrRatio.' },
    { item: 'Ch25 margin/short-selling mechanics', reason: 'Real, but this user\'s own standing trading strategy is long-only/calls-only — no buildable detail would ever be used.' },
    { item: 'Ch36\'s moving-average-as-mechanical-trendline material', reason: 'Already well covered by this project\'s existing SMA/EMA indicator set — no new buildable signal.' },
  ];
}

export interface SourceConflict {
  readonly topic: string;
  readonly thisBook: string;
  readonly schabacker: string;
  readonly note: string;
}

/**
 * A genuine disagreement between the two sources, flagged rather than
 * silently resolved.
 *
 * Edwards & Magee publish a working gap-measuring formula; Schabacker
 * tested the idea and says "no reliance can be placed" on it. This engine
 * ships neither, which is itself the honest outcome of the conflict.
 */
export function edwardsMageeSourceConflict(): SourceConflict {
  return {
    topic: 'Continuation/Runaway Gap measuring reliability',
    thisBook: 'A real, working measuring formula with real historical examples showing it worked (Ch12/Ch32).',
    schabacker: 'Explicit, tested, NEGATIVE verdict: "no reliance can be placed" on gap-measuring theories.',
    note: 'A genuine disagreement between the two real sources this project has now characterized — flagged honestly here rather than silently picking a side. This engine does not currently ship a gap-measuring price target either way.',
  };
}

// ── Top-level builder ──────────────────────────────────────────────────

export interface EdwardsMageeSynthesis {
  readonly bullish: readonly string[];
  readonly cautionary: readonly string[];
  readonly netRead: string;
}

export interface EdwardsMageeReport {
  readonly ticker: string;
  readonly dowTheory: DowTheoryRead;
  readonly stops: StopsRead;
  readonly evaluativeIndex: EvaluativeIndexRead;
  readonly positionRisk: PositionRiskRead;
  readonly fanTrendChannel: FanTrendChannelRead;
  readonly spacingCheck: SpacingCheckRead;
  readonly relativeStrength: RelativeStrengthRead;
  readonly exclusions: readonly Exclusion[];
  readonly sourceConflict: SourceConflict;
  readonly synthesis: EdwardsMageeSynthesis;
}

/**
 * Builds the whole report.
 *
 * ══ THE SYNTHESIS IS A COUNT, NOT A SCORE ══════════════════════════════
 * `netRead` compares `bullish.length` against `cautionary.length` and
 * nothing else. Every signal weighs exactly the same: a Dow Theory bear
 * confirmation counts as much as a double-bottom spacing flag.
 *
 * That is deliberate and it is the same discipline as the Schabacker
 * report -- no fabricated numeric score, and no re-deriving the main
 * engine's own conviction. The engine owns scoring; this report owns
 * citation. A weighted score here would be a second, uncalibrated opinion
 * competing with `finalConviction`, which is precisely what the decision
 * engine's OWN-as-filter design exists to avoid.
 *
 * Worth knowing when reading it: ties return "mixed/neutral", and a report
 * with zero signals on both sides also returns "mixed/neutral" -- those two
 * states are indistinguishable in `netRead` alone.
 *
 * Returns null on any throw, logging through the injected `log` rather than
 * writing anywhere itself.
 *
 * ══ FLAGGED (F-17): THREE OF SEVEN PARAMETERS ARE DEAD ═════════════════
 * Legacy's signature is `(ticker, ind, gann, confluence, techPlan, chart,
 * log)`. A comment-stripped scan of the body finds `gann`, `confluence` and
 * `chart` appearing exactly once each -- the parameter declaration itself,
 * zero times in the body. This port's signature drops all three. Verified
 * two ways: the parity test hands the oracle all seven and the port four
 * across 2,000+ comparisons with identical results, and a dedicated test
 * feeds the oracle garbage in those three slots and gets a byte-identical
 * report back. A parameter never read is not behaviour.
 */
export function buildEdwardsMageeReport(
  ticker: string,
  ind: EnrichedIndicators,
  techPlan: ModelTechPlan,
  log?: (msg: string) => void,
): EdwardsMageeReport | null {
  try {
    const dowTheory = edwardsMageeDowTheory(ind);
    const stops = edwardsMageeStops(techPlan, ind);
    const evaluativeIndex = edwardsMageeEvaluativeIndex(ind);
    const positionRisk = edwardsMageePositionRisk(techPlan);
    const fanTrendChannel = edwardsMageeFanTrendChannel(techPlan);
    const spacingCheck = edwardsMageeSpacingCheck(ind.chartPatterns);
    const relativeStrength = edwardsMageeRelativeStrength(ind);
    const exclusions = edwardsMageeExclusions();
    const sourceConflict = edwardsMageeSourceConflict();

    const bullish: string[] = [];
    const cautionary: string[] = [];

    if (dowTheory.available) {
      if (dowTheory.verdict === 'BULL_CONFIRMED') {
        bullish.push('Dow Theory: both real broad-market averages confirm a new high (Ch3-5.1)');
      } else if (dowTheory.verdict === 'BEAR_CONFIRMED') {
        cautionary.push('Dow Theory: both real broad-market averages confirm a new low (Ch3-5.1)');
      } else if (dowTheory.verdict === 'NON_CONFIRMATION_BULL'
        || dowTheory.verdict === 'NON_CONFIRMATION_BEAR') {
        cautionary.push('Dow Theory: real non-confirmation — only 1 of DIA/IYT confirmed, distrust the signal (Ch3-5.1)');
      }
    }
    if (evaluativeIndex.available) {
      // indexOf(...) === 0, i.e. startsWith. Only the OVERSOLD/OVERBOUGHT
      // extremes contribute; every intermediate read is deliberately silent.
      if (evaluativeIndex.read.indexOf('OVERSOLD') === 0) {
        bullish.push('Evaluative Index: real breadth reading in the historical Bottom-zone anchor (Ch38)');
      } else if (evaluativeIndex.read.indexOf('OVERBOUGHT') === 0) {
        cautionary.push('Evaluative Index: real breadth reading in the symmetric Top-zone anchor (Ch38)');
      }
    }
    if (stops.progressive.triggered) {
      cautionary.push('Progressive Stop: real climactic-volume trigger fired today — book\'s own real "nine times out of ten" caution (Ch27)');
    }
    if (fanTrendChannel.fanPrinciple.available && fanTrendChannel.fanPrinciple.triggered) {
      bullish.push('Fan Principle: real 3rd fan line broken — book\'s own claim the correction is over, Primary trend resuming (Ch14)');
    }
    spacingCheck.patterns.forEach((p) => {
      if (!p.meetsBook) return;
      if (p.type === 'DOUBLE_TOP') {
        cautionary.push('Double Top meets the book\'s own real >=6wk/>=15% full-confidence bar (Ch37)');
      } else {
        bullish.push('Double Bottom meets the book\'s own real >=6wk/>=15% full-confidence bar (Ch37)');
      }
    });
    if (relativeStrength.available) {
      const rs = relativeStrength;
      if (rs.read.indexOf('STRONG') === 0) {
        bullish.push('Relative Strength Ranking: #' + rs.rank + '/' + rs.peerCount + ' in '
          + rs.categories.join('/') + ' — among the strongest in its real peer group (Appendix E)');
      } else if (rs.read.indexOf('WEAK') === 0) {
        cautionary.push('Relative Strength Ranking: #' + rs.rank + '/' + rs.peerCount + ' in '
          + rs.categories.join('/') + ' — among the weakest in its real peer group, a caution not a short signal (Appendix E)');
      }
    }

    const netRead = bullish.length > cautionary.length ? 'Net read leans supportive'
      : cautionary.length > bullish.length ? 'Net read leans cautionary'
        : 'Net read is mixed/neutral — no clear lean';

    return {
      ticker, dowTheory, stops, evaluativeIndex, positionRisk, fanTrendChannel,
      spacingCheck, relativeStrength, exclusions, sourceConflict,
      synthesis: { bullish, cautionary, netRead },
    };
  } catch (e) {
    log?.('Edwards & Magee model: report build failed for ' + ticker + ' — '
      + (e && (e as Error).message ? (e as Error).message : String(e)));
    return null;
  }
}

// ── Plain-text formatter ───────────────────────────────────────────────

/**
 * Renders the report as plain text, one numbered section per category.
 *
 * ══ WHY THE HEADER IS "── X ──" AND NOT "=== X ===" ════════════════════
 * A real live Sheet showed this exact cell as #ERROR!. Apps Script's
 * setValue() treats any string starting with '=' as a FORMULA, so a header
 * like "=== TICKER ..." is parsed as invalid formula syntax. It had been
 * broken since the report was first built and was only noticed via an xlsx
 * export.
 *
 * The constraint is specific to the Sheets write path, which this backend
 * still uses -- so the convention is carried forward deliberately, not
 * copied by habit. Any new report header must not begin with '='.
 *
 * Unavailable sections print their own `note` inline rather than being
 * omitted, so a gap in the data is visible as a gap.
 */
export function formatEdwardsMageeReport(report: EdwardsMageeReport | null, opts: ModelTextOptions = {}): string {
  if (!report) return 'No report — data unavailable.';
  const plain = !!opts.plainText;
  const lines: string[] = [];
  const push = (s: string): void => {
    lines.push(s);
  };

  push('── ' + report.ticker + ' — Edwards & Magee Model v1 ──');
  push('');
  push('1. DOW THEORY CONFIRMATION (Ch3-5.1)');
  push('  ' + (report.dowTheory.available
    ? report.dowTheory.read + ' (DIA $' + report.dowTheory.industrials.close.toFixed(2)
      + ', IYT $' + report.dowTheory.transports.close.toFixed(2) + ')'
    : report.dowTheory.note));
  push('');

  push('2. BASING POINT + PROGRESSIVE STOP (Ch27/28/28.1)');
  const bp = report.stops.basingPoint as {
    available: boolean; level: number; basingPointPrice: number;
    basingPointDate: Date; stopPct: number; sensitivityTier: string; note: string;
  };
  if (bp.available) {
    // basingPointDate is concatenated directly, so it renders via Date's
    // default toString -- locale and timezone dependent. Reproduced as-is.
    push('  Basing Point stop: $' + bp.level.toFixed(2) + ' (basing point $'
      + bp.basingPointPrice.toFixed(2) + ' on ' + (plain ? shortDate(bp.basingPointDate, opts.timeZone) : bp.basingPointDate) + ', '
      + (bp.stopPct * 100).toFixed(0) + '%/' + bp.sensitivityTier + ')');
  } else {
    push('  ' + bp.note);
  }
  const prog = report.stops.progressive as
    { triggered: boolean; level: number; volumeRatio: number };
  push('  Progressive Stop: ' + (prog.triggered
    ? 'TRIGGERED — tighten to $' + prog.level.toFixed(2) + ' ('
      + prog.volumeRatio.toFixed(1) + 'x avg volume)'
    : 'not triggered today'));
  push('');

  push('3. EVALUATIVE INDEX (Ch38)');
  push('  ' + (report.evaluativeIndex.available
    ? report.evaluativeIndex.pctStrong.toFixed(1) + '% Strong ('
      + report.evaluativeIndex.strong + '+/' + report.evaluativeIndex.weak + '-) — '
      + report.evaluativeIndex.read
    : report.evaluativeIndex.note));
  push('');

  push('4. POSITION-SIZING / COMPOSITE LEVERAGE (Ch42, Appendix A/E)');
  const sz = report.positionRisk.sizing as {
    available: boolean; shares: number; stopLevel: number;
    dollarRisk: number; riskPctOfAccount: number; note: string;
  };
  if (sz.available) {
    push('  N-normalized size: ' + sz.shares + ' shares, stop $' + sz.stopLevel.toFixed(2)
      + ', risk $' + sz.dollarRisk.toFixed(0) + ' (' + sz.riskPctOfAccount.toFixed(1)
      + (plain ? '% ' + assumedAccountText() + ')' : '% of account)'));
  } else {
    push('  ' + sz.note);
  }
  const lv = report.positionRisk.leverage as
    { available: boolean; leverage: number; tier: string; note: string };
  if (lv.available) push('  Composite Leverage: ' + lv.leverage.toFixed(2) + 'x (' + lv.tier + ')');
  else push('  ' + lv.note);
  push('');

  push('5. FAN PRINCIPLE + TREND CHANNEL (Ch14)');
  const fan = report.fanTrendChannel.fanPrinciple as
    { available: boolean; brokenCount: number; triggered: boolean; note: string };
  if (fan.available) {
    push('  Fan Principle: ' + fan.brokenCount + '/3 fan lines broken'
      + (fan.triggered ? ' — TRIGGERED (correction likely over)' : ''));
  } else {
    push('  Fan Principle: ' + fan.note);
  }
  const tch = report.fanTrendChannel.trendChannel as
    { available: boolean; projectedOvershoot: number | null; note: string };
  if (tch.available) {
    push('  Trend Channel: ' + (tch.projectedOvershoot != null
      ? 'last swing fell short by $' + tch.projectedOvershoot.toFixed(2)
        + ' — projects the same overshoot on the opposite boundary next'
      : 'last swing reached/exceeded its own boundary'));
  } else {
    push('  Trend Channel: ' + tch.note);
  }
  push('');

  push('6. DOUBLE TOP/BOTTOM SPACING CHECK (Ch37)');
  if (!report.spacingCheck.patterns.length) {
    push('  No Double Top/Bottom currently carries this field.');
  }
  // Note: the "none" line and the per-pattern lines are NOT exclusive in
  // legacy -- the forEach runs regardless. With an empty list it emits
  // nothing, so the behaviour matches, but the shape is worth preserving.
  report.spacingCheck.patterns.forEach((p) => push('  - ' + p.type + ': ' + p.weeksApart
    + ' weeks apart, ' + p.magnitudePct + '% move — '
    + (p.meetsBook ? 'MEETS' : 'below') + ' the book\'s full-confidence bar'));
  push('');

  push('7. RELATIVE STRENGTH RANKING (Appendix E, Turtle System)');
  if (report.relativeStrength.available) {
    const rs = report.relativeStrength;
    push('  #' + rs.rank + '/' + rs.peerCount + ' in ' + rs.categories.join('/')
      + ' (percentile ' + rs.percentile + ') — ' + rs.read);
    push('  Top: ' + rs.topPeers.map((p) => p.ticker).join(', ')
      + '  |  Bottom: ' + rs.bottomPeers.map((p) => p.ticker).join(', '));
  } else {
    push('  ' + report.relativeStrength.note);
  }
  push('');

  push('8. REAL SOURCE CONFLICT, DISCLOSED');
  push('  ' + report.sourceConflict.topic + ': this book says "' + report.sourceConflict.thisBook
    + '" vs. Schabacker\'s "' + report.sourceConflict.schabacker + '"');
  push('');

  push('9. EXPLICIT EXCLUSIONS');
  report.exclusions.forEach((e) => push('  - ' + e.item + ': ' + e.reason));
  push('');

  push('10. FINAL SYNTHESIS: ' + report.synthesis.netRead);
  report.synthesis.bullish.forEach((b) => push('  [+] ' + b));
  report.synthesis.cautionary.forEach((c) => push('  [-] ' + c));

  return lines.join('\n');
}
