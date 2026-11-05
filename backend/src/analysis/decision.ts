/**
 * The decision engine -- synthesizeDecisionV7 (:3171-3330) plus its closure:
 * computePositionSizeV7_ (:179-198) and the macro-regime conviction modifier.
 *
 * This is the function the whole pipeline exists to reach. Everything else
 * -- 115 indicators, 29 chart patterns, confluence, Gann, the tech plan --
 * feeds exactly two numbers into here (techScore and the R:R geometry) plus
 * one fundamental score, and this file turns them into the verdict the user
 * reads.
 *
 * ══ TWO DELIBERATE STRUCTURAL CHANGES ══════════════════════════════════
 *
 * 1. macroRead IS AN INJECTED PARAMETER. The legacy function calls
 *    getCachedMacroRegime_() internally (:3238), which READS THE SHEET
 *    through a 7-function chain (readMacroPriceCache_, isPriceCacheFreshV7_,
 *    alignSeries_Macro, classifyMacroRegimeAt_Macro, plus three sibling
 *    caches). A sheet read buried inside the decision function is the single
 *    worst thing about this code path:
 *      - it makes the decision engine untestable in isolation, and
 *      - in the oracle sandbox SpreadsheetApp.getActiveSpreadsheet() returns
 *        null, so it ALWAYS returned {available:false} -- meaning the macro
 *        modifier would have been verified only against its own no-op branch.
 *    Injecting it moves the read to the data layer where it belongs and makes
 *    the modifier genuinely testable. Verified by injecting the oracle's own
 *    `_macroRegimeCache` global so both sides see identical macro states.
 *    The NUMBERS are untouched: RISK_OFF -4, RISK_ON +2, anything else 0.
 *
 * 2. STATUS USES StatusAccumulator, not a mutated plain object. Legacy
 *    setStatusV7 (:651-653) mutated a shared `status` object. See
 *    core/status.ts for why that shape was replaced. Same two states
 *    (ok / degraded) on the same key, same trigger.
 *
 * Everything else is byte-identical, including every emoji, every en-dash,
 * every minus sign (the options notes use U+2212 MINUS SIGN, not hyphen --
 * see OPTIONS_CONFLICT_NOTE), and `toLocaleString()` grouping in the Size
 * line.
 *
 * ══ VERIFIED ═══════════════════════════════════════════════════════════
 * 2026-10-07, differentially against the oracle:
 *   - 181,440 field comparisons over 48 real fixture tech plans x 14
 *     fundamental scores x 6 options variants x 5 macro states
 *   - 18,144 more over 28 synthetic tech plans built to straddle every
 *     branch boundary (rrToT1 in {null,3.0,1.5,1.49,1.0,0.999,0.75,0.5,
 *     0.01,0,-0.5,-2}, null t1/t2/timeToEntry/secular, both sizing
 *     rejection paths, the cash-account cap path)
 *   - all 4 fundBands, all 3 timings, the blocked path, both R:R branches,
 *     T1 promotion notes, and both Size-line branches exercised
 *   - macro modifier proven NON-VACUOUS: measured deltas are exactly
 *     +2 (RISK_ON), -4 (RISK_OFF), 0 (NEUTRAL) against the unavailable base
 */

import type { FundBand } from '../types/decision.ts';
import { OWN_FILTER_THRESHOLD, OWN_BLOCK_FLOOR } from '../types/decision.ts';
import type { Timing, EntryPlan } from './techPlan/entryPlan.ts';
import type { OptionsAnalysis } from './techPlan/scoring.ts';
import { StatusAccumulator, StepState } from '../core/status.ts';
import { logDetail, reportSentence } from '../core/result.ts';

/**
 * The user's real account parameters, ported from CONFIG_V7.account (:16).
 *
 * Hardcoded on purpose -- this system analyses one person's portfolio, and a
 * config layer for a single user is complexity with no payoff.
 *
 * FLAGGED (F-12): legacy CONFIG_V7.account also declares `maxHeatPct: 6`.
 * A grep across all ten legacy files finds exactly one occurrence -- that
 * declaration. NOTHING reads it. So there is no portfolio-level risk cap
 * anywhere in the system: per-trade risk is capped at 1% of the account, but
 * total simultaneous heat across open positions is unbounded. Reproduced as
 * found (the field is simply absent here, since absent and never-read are the
 * same behaviour) and flagged rather than implemented.
 */
export const ACCOUNT = {
  /** Dollars. */
  size: 10_000,
  /** Percent of account risked per trade at full conviction. */
  riskPct: 1,
} as const;

export interface AccountConfig {
  readonly size: number;
  readonly riskPct: number;
}

export interface PositionSize {
  readonly shares: number;
  readonly cost: number;
  readonly dollarRisk: number;
  readonly perShareRisk: number;
  readonly riskPct: number;
  /** 0.5 at conviction 0, 1.0 at conviction 100. */
  readonly convScale: number;
}

/**
 * Fixed-fractional position sizing, scaled by conviction (:179-198).
 *
 * Returns null -- not a zero-share result -- whenever the inputs cannot
 * produce a real position, so the caller omits the line entirely rather than
 * printing "0 sh". The four null paths are all reachable and all tested:
 * non-finite price, a stop at or above entry, a per-share risk so large that
 * zero shares are affordable, and a share price above the whole account.
 *
 * Display and education only. Places no orders.
 */
export function computePositionSize(
  entryPrice: number,
  stopPrice: number,
  finalConviction: number,
  account: AccountConfig = ACCOUNT,
): PositionSize | null {
  // The legacy try/catch (:180, :197) existed because CONFIG_V7 could in
  // principle be missing. Here the shape is guaranteed by the type system,
  // so the catch is gone rather than carried as dead weight; every real
  // rejection below is an explicit, named guard.
  const acct = (account && account.size) || 0;
  const riskPct = (account && account.riskPct) || 1;
  if (!(acct > 0) || !Number.isFinite(entryPrice) || !Number.isFinite(stopPrice)) return null;

  const perShareRisk = entryPrice - stopPrice;
  if (!(perShareRisk > 0)) return null;

  const convScale = 0.5 + 0.5 * (Math.max(0, Math.min(100, finalConviction || 0)) / 100);
  const dollarRisk = acct * (riskPct / 100) * convScale;

  let shares = Math.floor(dollarRisk / perShareRisk);
  if (!(shares > 0)) return null;

  let cost = shares * entryPrice;
  // Cash-account cap: never let one position exceed the whole account.
  if (cost > acct) {
    shares = Math.floor(acct / entryPrice);
    cost = shares * entryPrice;
  }
  if (!(shares > 0)) return null;

  return { shares, cost, dollarRisk: shares * perShareRisk, perShareRisk, riskPct, convScale };
}

/** What the decision engine needs from the macro layer. Nothing more. */
export interface MacroRead {
  readonly available: boolean;
  readonly regime?: string;
}

/**
 * The tech-plan fields the decision engine actually reads.
 *
 * Tier A contributes techScore; Tier B contributes the rest. Tiers C and D
 * are display-only and deliberately absent -- which is the proof that the
 * decision path does not depend on them.
 */
export interface DecisionTechPlan extends EntryPlan {
  readonly techScore: number;
  readonly secular?: { readonly verdict: string; readonly why: string } | null;
  readonly dataWarning?: string | null;
}

export interface DecisionFundResult {
  readonly score: number | null;
  readonly verdict?: string | null;
  readonly dataWarning?: string | null;
}

/**
 * The options object as the decision engine reads it.
 *
 * `confirm` and `notes` are REQUIRED, not optional, and that is deliberate.
 * Legacy :3318 is a single statement doing BOTH
 * `optAnalysis.confirm.toUpperCase()` and `optAnalysis.notes.join(' · ')`,
 * with no guard on either. Verified by execution: calling the oracle with
 * `{available:true}` and no `confirm` throws `TypeError: Cannot read
 * properties of undefined (reading 'toUpperCase')` at
 * fullStockAnalysisV10_9.gs:3318.
 *
 * A tolerant port here would instead have printed the literal string
 * "Options: UNDEFINED — " into the user's report, which is strictly worse
 * than the crash. So the shape is made unrepresentable: if `available` is
 * true these two fields exist, and the compiler enforces it.
 * No silent fallback, no behavioural divergence.
 */
export interface DecisionOptions extends OptionsAnalysis {
  readonly confirm: string;
  readonly notes: readonly string[];
}

export interface Decision {
  readonly headline: string;
  readonly action: string;
  readonly lines: string[];
  readonly fundBand: FundBand;
  readonly timing: Timing;
  readonly finalConviction: number;
  readonly dataWarnings: string[];
  readonly optionsConfirm: string | null;
  /**
   * The conviction trace. Legacy embedded this only inside the rendered
   * "Final Conviction:" line; exposed separately here so the report builders
   * and the AI prompt can use it without re-parsing a string.
   */
  readonly convNotes: string[];
}

/**
 * The 4x3 action matrix (:3182-3187).
 *
 * Rows are fundamental bands, columns are buy-timing. Every one of the 12
 * verdicts is BUY-FRAMED -- that is a real property of this engine, and it is
 * why the Exit report needs its own reframing layer.
 */
const MATRIX: Record<FundBand, Record<Timing, { emoji: string; label: string }>> = {
  own: {
    BUY_NOW: { emoji: '✅', label: 'BUY NOW' },
    WAIT_PULLBACK: { emoji: '⏳', label: 'GREAT COMPANY — SET A BUY LIMIT' },
    AVOID: { emoji: '⚠️', label: 'GOOD COMPANY, BAD TAPE' },
  },
  mixed: {
    BUY_NOW: { emoji: '➖', label: 'Tradeable, not a conviction owner' },
    WAIT_PULLBACK: { emoji: '➖', label: 'Only-if-it-dips trade' },
    AVOID: { emoji: '🚫', label: 'Stand aside' },
  },
  weak: {
    BUY_NOW: { emoji: '🩳', label: 'Technical bounce only (not own-worthy)' },
    WAIT_PULLBACK: { emoji: '🚫', label: 'Skip — weak fundamentals, no entry edge' },
    AVOID: { emoji: '🔴', label: 'Avoid entirely' },
  },
  unknown: {
    BUY_NOW: { emoji: '❔', label: 'No fundamentals — technical-only bounce' },
    WAIT_PULLBACK: { emoji: '❔', label: 'No fundamentals — technical-only, wait for entry' },
    AVOID: { emoji: '❔', label: 'No fundamentals — avoid, weak tape' },
  },
};

const TIMING_LABEL: Record<Timing, string> = {
  BUY_NOW: 'BUY NOW ✅',
  WAIT_PULLBACK: 'WAIT ⏳',
  AVOID: 'AVOID ⚠️',
};

/** Maximum conviction haircut from a sub-1.0 R:R (:3278). */
const MAX_RR_REDUCTION = 0.40;

/**
 * These three strings contain U+2212 MINUS SIGN, not U+002D HYPHEN-MINUS.
 * Named constants so the distinction survives editing -- a hyphen here is a
 * silent parity break that no type checker would catch.
 */
const OPTIONS_CONFLICT_NOTE = 'options CONFLICT −10';
const LEAPS_HEDGED_NOTE = 'LEAPS hedged −5';
const MACRO_NOTE_SUFFIX = ' (weak/unconfirmed signal — see MACRO_REGIME_VALIDATION_RESULTS.md)';

/** Fundamental band boundaries (:3172). 57 and 43 are the legacy cutoffs. */
export function fundBandOf(score: number | null | undefined): FundBand {
  if (score == null) return 'unknown';
  if (score >= 57) return 'own';
  if (score >= 43) return 'mixed';
  return 'weak';
}

/**
 * Turns the fundamental score, the tech plan, the options read and the macro
 * regime into the verdict the user reads.
 *
 * DESIGN AS PORTED (the legacy comments at :3188-3206 state it plainly):
 * fundamentals act as a FILTER, technicals as the DRIVER. Above
 * OWN_FILTER_THRESHOLD, conviction is techScore alone -- fundamentals stop
 * competing with it 50/50. Below it, techScore is cut by an accelerating
 * (squared) curve. At or below OWN_BLOCK_FLOOR it is a hard zero regardless
 * of how good the chart is.
 *
 * FLAGGED (F-11): the blocked path returns before the macro-status write, so
 * a run consisting only of blocked tickers reports macroRegime as `pending`
 * -- "never attempted" -- even though macro availability is a run-global fact
 * independent of any single ticker. Confirmed by execution against the
 * oracle: OWN 80 yields state `ok`, OWN 15 yields `pending`, same injected
 * macro state. Reproduced, not fixed.
 *
 * FLAGGED (F-13): the R:R gate at :3275 applies after conviction has already
 * been clamped to [0,100], and `optionsConfirm` is still populated on the
 * blocked path even though the note says "options adjustments skipped". Both
 * are harmless (the gate only reduces; the field is informational) and both
 * are reproduced exactly.
 */
export function synthesizeDecision(
  fundResult: DecisionFundResult,
  techPlan: DecisionTechPlan,
  optAnalysis: DecisionOptions | null | undefined,
  macroRead: MacroRead | null | undefined,
  status?: StatusAccumulator,
  account: AccountConfig = ACCOUNT,
): Decision {
  const fundBand = fundBandOf(fundResult.score);
  const timing = techPlan.timing;

  // A HANDLED upstream failure (stale-cache fundamentals, missing RS) must
  // not go silent just because it did not crash the run. Surfaced on the
  // headline AND in the conviction notes.
  const dataWarnings = [fundResult.dataWarning, techPlan.dataWarning].filter(Boolean) as string[];

  const cell = MATRIX[fundBand][timing];
  let action = cell.emoji + ' ' + cell.label;
  if (dataWarnings.length) action += '  ⚠ PARTIAL DATA';

  const convNotes: string[] = [];
  dataWarnings.forEach((w) => convNotes.push('⚠ PARTIAL DATA: ' + w));

  const isBlocked = fundResult.score != null && fundResult.score <= OWN_BLOCK_FLOOR;
  const T = techPlan.techScore;
  let finalConviction: number;

  if (isBlocked) {
    finalConviction = 0;
    action =
      '🚫 BLOCKED — fundamentals too weak (OWN ' + fundResult.score + '/100), regardless of chart';
    if (dataWarnings.length) action += '  ⚠ PARTIAL DATA';
    convNotes.push(
      'fundamentals block: OWN ' +
        fundResult.score +
        ' ≤ floor ' +
        OWN_BLOCK_FLOOR +
        ' — options adjustments skipped',
    );
  } else {
    // Missing fundamentals default O to 50, which is ABOVE the filter -- so a
    // data outage passes through as "no reduction" and never blocks. That is
    // the legacy behaviour and it is deliberate (:3218-3220).
    const O = fundResult.score != null ? fundResult.score : 50;
    let reduction = 0;
    if (O < OWN_FILTER_THRESHOLD) {
      const frac = (OWN_FILTER_THRESHOLD - O) / (OWN_FILTER_THRESHOLD - OWN_BLOCK_FLOOR);
      reduction = Math.pow(Math.min(1, Math.max(0, frac)), 2);
      convNotes.push(
        'OWN ' +
          O +
          ' below filter (' +
          OWN_FILTER_THRESHOLD +
          ') — TECH reduced ' +
          Math.round(reduction * 100) +
          '%',
      );
    }
    finalConviction = Math.round(T * (1 - reduction));

    if (optAnalysis && optAnalysis.available) {
      if (optAnalysis.confirm === 'confirm') {
        finalConviction += 8;
        convNotes.push('options CONFIRM +8');
      } else if (optAnalysis.confirm === 'conflict') {
        finalConviction -= 10;
        convNotes.push(OPTIONS_CONFLICT_NOTE);
      }
      const lean = optAnalysis.leapsLean;
      if (lean != null && lean >= 0.5) {
        finalConviction += 5;
        convNotes.push('LEAPS accumulation +5');
      } else if (lean != null && lean <= -0.5) {
        finalConviction -= 5;
        convNotes.push(LEAPS_HEDGED_NOTE);
      }
    }

    // Macro modifier: small on purpose. The underlying signal is explicitly
    // weak/unconfirmed, and that is disclosed in the note every time it fires.
    const macroOk = !!(macroRead && macroRead.available);
    if (status) {
      status.set({
        key: 'macroRegime',
        label: 'Macro regime',
        state: macroOk ? StepState.OK : StepState.DEGRADED,
        detail: logDetail(
          macroOk
            ? 'cached read'
            : 'cache stale/missing — refreshed by a separate daily job, not fetched inline',
        ),
        ...(macroOk
          ? {}
          : {
              disclosure: reportSentence(
                'Macro regime was unavailable, so the small macro conviction adjustment was not applied.',
              ),
            }),
      });
    }
    if (macroOk && macroRead) {
      if (macroRead.regime === 'RISK_OFF') {
        finalConviction -= 4;
        convNotes.push('macro regime RISK_OFF −4' + MACRO_NOTE_SUFFIX);
      } else if (macroRead.regime === 'RISK_ON') {
        finalConviction += 2;
        convNotes.push('macro regime RISK_ON +2' + MACRO_NOTE_SUFFIX);
      }
    }
    finalConviction = Math.max(0, Math.min(100, finalConviction));
  }

  // promotionHops was computed in deriveExitTargets but never surfaced
  // anywhere before -- silently moving T1 contradicted this project's own
  // show-your-work pattern.
  if (techPlan.t1 && techPlan.t1.promotionHops) {
    convNotes.push(
      'T1 promoted ' +
        techPlan.t1.promotionHops +
        'x — the nearest confluence cluster was inside the minimum gap above entry, so a farther cluster was used instead',
    );
  }

  // RISK/REWARD QUALITY GATE. A sub-1.0 first-target R:R (risking more than
  // T1 pays) used to print as a confident BUY. The reduction uses the same
  // accelerating squared curve as the OWN filter above, not a flat penalty:
  // near-zero right at the 1.0 boundary, up to MAX_RR_REDUCTION as R:R
  // approaches zero or inverts.
  if (!isBlocked && techPlan.rrToT1 != null) {
    const rr1 = techPlan.rrToT1;
    if (rr1 < 1.0) {
      const frac = Math.min(1, Math.max(0, 1.0 - rr1)); // 0 at rr1=1.0, 1 at rr1<=0
      const rrReduction = Math.pow(frac, 2) * MAX_RR_REDUCTION;
      finalConviction = Math.max(0, Math.round(finalConviction * (1 - rrReduction)));
      convNotes.push(
        'R:R gate: T1 R:R ' +
          rr1.toFixed(2) +
          ' < 1.0 — first target inside 1R, conviction −' +
          Math.round(rrReduction * 100) +
          '%',
      );
      action += '  ⚠ marginal structure (T1 R:R ' + rr1.toFixed(2) + ')';
    } else if (rr1 < 1.5) {
      convNotes.push('R:R note: T1 R:R ' + rr1.toFixed(2) + ' is thin (<1.5) — size accordingly');
    }
  }

  const fundStr =
    fundResult.score != null ? 'OWN ' + fundResult.score + '/100 ' + fundResult.verdict : 'OWN N/A';
  const entryVerb = timing === 'WAIT_PULLBACK' ? 'Buy limit' : 'Buy';
  const entryStr =
    entryVerb +
    ' $' +
    techPlan.entryPrice.toFixed(2) +
    ' (zone $' +
    techPlan.entryLow.toFixed(2) +
    '–$' +
    techPlan.entryHigh.toFixed(2) +
    ')';
  const etaStr = techPlan.timeToEntry ? ', ETA ' + techPlan.timeToEntry.humanText : '';
  const confStr = ', ' + techPlan.entryConfidencePct + '% conf.';

  // The ticker is deliberately absent -- this function takes none. The report
  // builder prepends "{ticker} — " when rendering.
  const headline =
    (dataWarnings.length ? '⚠ PARTIAL DATA  |  ' : '') +
    fundStr +
    '  |  BUY-TIMING: ' +
    TIMING_LABEL[timing] +
    '  |  ' +
    entryStr +
    etaStr +
    confStr +
    '  |  Conviction ' +
    finalConviction +
    '/100';

  const lines = [
    'Entry: $' +
      techPlan.entryPrice.toFixed(2) +
      ' (zone $' +
      techPlan.entryLow.toFixed(2) +
      '–$' +
      techPlan.entryHigh.toFixed(2) +
      ')',
    'ETA: ' +
      (techPlan.timeToEntry ? techPlan.timeToEntry.humanText : 'N/A') +
      '   Confidence: ' +
      techPlan.entryConfidencePct +
      '%',
    'Exit T1: ' +
      (techPlan.t1 ? '$' + techPlan.t1.price.toFixed(2) : 'N/A') +
      (techPlan.t1Time ? ' (' + techPlan.t1Time.humanText + ')' : ''),
    'Exit T2: ' +
      (techPlan.t2 ? '$' + techPlan.t2.price.toFixed(2) : 'N/A') +
      (techPlan.t2Time ? ' (' + techPlan.t2Time.humanText + ')' : ''),
    'Stop: $' +
      techPlan.stop.toFixed(2) +
      '   R:R ' +
      (techPlan.rrToT1 != null ? techPlan.rrToT1.toFixed(2) : 'N/A') +
      ' / ' +
      (techPlan.rrToT2 != null ? techPlan.rrToT2.toFixed(2) : 'N/A'),
  ];

  const pos = computePositionSize(techPlan.entryPrice, techPlan.stop, finalConviction, account);
  if (pos) {
    lines.push(
      'Size: ' +
        pos.shares +
        ' sh (~$' +
        Math.round(pos.cost).toLocaleString() +
        ', risking $' +
        Math.round(pos.dollarRisk).toLocaleString() +
        ' = ' +
        pos.riskPct +
        '% acct × ' +
        pos.convScale.toFixed(2) +
        ' conviction) — sizing is educational, not an order',
    );
  }

  if (optAnalysis && optAnalysis.available) {
    lines.push(
      'Options: ' + optAnalysis.confirm.toUpperCase() + ' — ' + optAnalysis.notes.join(' · '),
    );
  } else {
    lines.push(
      'Options: N/A (run Options Analysis on this ticker first for a positioning read)',
    );
  }

  lines.push(
    'Final Conviction: ' +
      finalConviction +
      '/100' +
      (convNotes.length ? '   [' + convNotes.join(', ') + ']' : ''),
  );

  if (techPlan.secular) {
    lines.push('Secular (own for years?): ' + techPlan.secular.verdict + ' — ' + techPlan.secular.why);
  }

  lines.push('Action: ' + action);

  return {
    headline,
    action,
    lines,
    fundBand,
    timing,
    finalConviction,
    dataWarnings,
    optionsConfirm: optAnalysis && optAnalysis.available ? optAnalysis.confirm : null,
    convNotes,
  };
}
