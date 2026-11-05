/**
 * Broker Course Phase 12 -- the comparison report (:2324-2605, 2
 * functions): the existing engine's verdict set against the Broker Course
 * model and, when present, the Schabacker, Edwards & Magee and Turtle
 * models. Model 5 of 5. Downstream tooling, not course methodology -- the
 * one phase sanctioned to read the engine's own output.
 *
 * ══ BOTH SELF-FETCH PATHS ARE LIFTED OUT ══════════════════════════════
 * Legacy rebuilt the broker report from scratch when none was passed
 * (`existingNewModelReport !== undefined ? ... : buildBrokerCourseReportV1(
 * ticker, log)`, :2325), and re-ran the WHOLE engine pipeline -- chart,
 * indicators, gann, fundamentals, confluence, tech plan, decision -- if ANY
 * one of techPlan/fundScore/decision was `== null` (:2337-2349), discarding
 * whichever had been supplied. Its only production caller (engine :1583)
 * always passes the engine's own three, and the broker report as an object
 * or null -- never undefined -- so neither path ran in production. Here
 * the engine inputs are required and the broker report is
 * `BrokerCourseReport | null`. The formatter's `CONFIG_V7.version` global
 * (:2566) becomes an optional `engineVersion` argument.
 *
 * Inputs are typed structurally (only the fields actually read), so the
 * engine's Decision and every model's report satisfy them as-is.
 *
 * ══ THE VERDICT ══════════════════════════════════════════════════════
 * Each voice maps to bullish / cautionary / mixed. The engine via the
 * (fundBand, timing) table below, with any BLOCKED action forced to
 * cautionary; every model via its synthesis.netRead, whose three strings
 * are identical across all four models ('Net read leans supportive' /
 * '... cautionary' / '... mixed/neutral') -- checked, so the substring
 * match is sound. Two voices (engine + broker only) give the old binary
 * agree; any of the other three models adds the N-way verdict:
 *   ALL_AGREE     one direction
 *   MAJORITY      a direction held by more than half; EVERY dissenter is
 *                 named (the v1.3 fix -- 132 real multi-dissenter cases)
 *   SPLIT         two directions tied at exactly half
 *   NO_CONSENSUS  otherwise
 * With only three directions, NO_CONSENSUS means "every voice differs"
 * only at three voices: measured on real data it is always 2-1-1 at four
 * and 2-2-1 at five -- and five's "two clean pairs" reads NO_CONSENSUS
 * where four's reads SPLIT (deliberate per :2482-2484).
 */

import type { BrokerCourseReport } from './report.ts';

export type Direction = 'bullish' | 'cautionary' | 'mixed';

export interface ComparisonTechPlan {
  readonly regime: string;
  readonly techScore: number;
  readonly timing: string;
}

export interface ComparisonFundScore {
  readonly score: number | null;
  readonly verdict?: string | null;
}

export interface ComparisonDecision {
  readonly fundBand: string;
  readonly action: string;
  readonly finalConviction: number;
  readonly headline: string;
}

export interface ModelSynthesis {
  readonly netRead: string;
  readonly bullish: readonly string[];
  readonly cautionary: readonly string[];
}

export interface ModelReportLike {
  readonly synthesis: ModelSynthesis;
}

export interface ComparisonInputs {
  readonly techPlan: ComparisonTechPlan;
  readonly fundScore: ComparisonFundScore;
  readonly decision: ComparisonDecision;
  readonly newModelReport: BrokerCourseReport | null;
  readonly schabackerReport?: ModelReportLike | null;
  readonly edwardsMageeReport?: ModelReportLike | null;
  readonly turtleReport?: ModelReportLike | null;
}

export type ComparisonVerdict = 'ALL_AGREE' | 'MAJORITY' | 'SPLIT' | 'NO_CONSENSUS';

/**
 * The per-model keys and `verdict`/`dissentingModel` are ABSENT -- not
 * null -- unless at least one of the three extra models was passed; legacy
 * guarantees a byte-identical 2-way shape otherwise.
 */
export interface ComparisonReport {
  readonly ticker: string;
  readonly agree: boolean | null;
  readonly existingDirection: Direction;
  readonly newDirection: Direction | null;
  readonly existingSignals: string[];
  readonly newSignals: string[] | null;
  readonly existingHeadline: string | null;
  readonly newHeadline: string | null;
  readonly newModelUnavailable: boolean;
  readonly sameReasoning: boolean | null;
  readonly schabackerDirection?: Direction | null;
  readonly schabackerSignals?: string[];
  readonly schabackerHeadline?: string;
  readonly edwardsMageeDirection?: Direction | null;
  readonly edwardsMageeSignals?: string[];
  readonly edwardsMageeHeadline?: string;
  readonly turtleDirection?: Direction | null;
  readonly turtleSignals?: string[];
  readonly turtleHeadline?: string;
  readonly verdict?: ComparisonVerdict;
  readonly dissentingModel?: string | null;
}

/**
 * The engine's (fundBand, timing) -> direction, reusing its own decision
 * matrix's labels: an OWN-band WAIT_PULLBACK is "GREAT COMPANY — SET A BUY
 * LIMIT", a bullish setup, not a neutral one. Unknown pairs fall to mixed.
 */
export const EXISTING_DIRECTION_MAP: Readonly<Record<string, Readonly<Record<string, Direction>>>> = {
  own: { BUY_NOW: 'bullish', WAIT_PULLBACK: 'bullish', AVOID: 'cautionary' },
  mixed: { BUY_NOW: 'mixed', WAIT_PULLBACK: 'mixed', AVOID: 'cautionary' },
  weak: { BUY_NOW: 'mixed', WAIT_PULLBACK: 'cautionary', AVOID: 'cautionary' },
  unknown: { BUY_NOW: 'mixed', WAIT_PULLBACK: 'mixed', AVOID: 'cautionary' },
};

/** A model's direction from its net-read text; null when the report is absent. */
export function directionFromReport(report: ModelReportLike | null | undefined): Direction | null {
  if (!report) return null;
  return report.synthesis.netRead.indexOf('supportive') > -1 ? 'bullish'
    : report.synthesis.netRead.indexOf('cautionary') > -1 ? 'cautionary' : 'mixed';
}

/**
 * Builds the comparison. Refuses (null, with legacy's log line) only when
 * no model report at all is available; the engine side is always present.
 *
 * `sameReasoning` is null when the broker report is absent, false whenever
 * the two sides disagree, and otherwise asks whether the broker model's
 * own drivers match the engine's direction. Two quirks, reproduced: on
 * the cautionary branch with no dilution flag and no Fibonacci read it can
 * be null even when they agree, silently dropping the reasons line (0 real
 * cases -- fibRead is always present); and the 'mixed' check looks only at
 * the broker model's bullish/cautionary balance.
 */
export function buildComparisonReportV1(
  ticker: string,
  inputs: ComparisonInputs,
  log?: (msg: string) => void,
): ComparisonReport | null {
  const newModel = inputs.newModelReport;
  const schabacker = inputs.schabackerReport;
  const edwardsMagee = inputs.edwardsMageeReport;
  const turtle = inputs.turtleReport;
  if (!newModel && !schabacker && !edwardsMagee && !turtle) {
    log?.('Comparison: no model report available at all for ' + ticker);
    return null;
  }

  const techPlan = inputs.techPlan;
  const fundScore = inputs.fundScore;
  const decision = inputs.decision;
  const existingDecision = decision;

  const isBlocked = existingDecision && existingDecision.action && existingDecision.action.indexOf('BLOCKED') > -1;
  const existingDirection: Direction = isBlocked ? 'cautionary'
    : ((EXISTING_DIRECTION_MAP[decision.fundBand] && EXISTING_DIRECTION_MAP[decision.fundBand][techPlan.timing]) || 'mixed');

  const newDirection = directionFromReport(newModel);
  const agree = newModel ? (existingDirection === newDirection) : null;

  const existingSignals = [
    'Regime: ' + techPlan.regime, 'Tech score: ' + techPlan.techScore + '/100',
    'Timing: ' + techPlan.timing, 'OWN score: ' + (fundScore.score != null ? fundScore.score + '/100 ' + fundScore.verdict : 'N/A'),
    'Final Conviction: ' + (existingDecision ? existingDecision.finalConviction + '/100 — ' + existingDecision.action : 'N/A'),
  ];
  const newSignals = newModel ? newModel.synthesis.bullish.concat(newModel.synthesis.cautionary) : null;

  const baseResult: ComparisonReport = {
    ticker, agree, existingDirection, newDirection,
    existingSignals, newSignals,
    existingHeadline: existingDecision ? existingDecision.headline : null,
    newHeadline: newModel ? newModel.synthesis.netRead : null,
    newModelUnavailable: !newModel,
    sameReasoning: !newModel ? null : agree && (existingDirection === 'bullish'
      ? (newModel.playerMapping.tag === 'Institutional-Accumulation-Signature' || newModel.technique.tag !== 'No specific entry technique identified')
      : existingDirection === 'cautionary'
        ? (newModel.fundamentalsScreen.tag === 'Dilution/Pump-Dump Risk Flagged' || (newModel.technical.fibRead && newModel.technical.fibRead.trendIntact === false))
        : newModel.synthesis.bullish.length === newModel.synthesis.cautionary.length),
  };

  if (!schabacker && !edwardsMagee && !turtle) return baseResult;

  const namedDirections: Array<{ name: string; dir: Direction | null }> = [{ name: 'existingEngine', dir: existingDirection }];
  if (newModel) namedDirections.push({ name: 'newModel', dir: newDirection });
  const extra: Record<string, unknown> = {};
  if (schabacker) {
    const schabackerDirection = directionFromReport(schabacker);
    extra.schabackerDirection = schabackerDirection;
    extra.schabackerSignals = schabacker.synthesis.bullish.concat(schabacker.synthesis.cautionary);
    extra.schabackerHeadline = schabacker.synthesis.netRead;
    namedDirections.push({ name: 'schabackerModel', dir: schabackerDirection });
  }
  if (edwardsMagee) {
    const edwardsMageeDirection = directionFromReport(edwardsMagee);
    extra.edwardsMageeDirection = edwardsMageeDirection;
    extra.edwardsMageeSignals = edwardsMagee.synthesis.bullish.concat(edwardsMagee.synthesis.cautionary);
    extra.edwardsMageeHeadline = edwardsMagee.synthesis.netRead;
    namedDirections.push({ name: 'edwardsMageeModel', dir: edwardsMageeDirection });
  }
  if (turtle) {
    const turtleDirection = directionFromReport(turtle);
    extra.turtleDirection = turtleDirection;
    extra.turtleSignals = turtle.synthesis.bullish.concat(turtle.synthesis.cautionary);
    extra.turtleHeadline = turtle.synthesis.netRead;
    namedDirections.push({ name: 'turtleModel', dir: turtleDirection });
  }

  const dirCounts: Record<string, number> = {};
  namedDirections.forEach((m) => {
    dirCounts[m.dir as string] = (dirCounts[m.dir as string] || 0) + 1;
  });
  const uniqueDirs = Object.keys(dirCounts);
  const maxCount = Math.max(...uniqueDirs.map((d) => dirCounts[d]));
  const modalDirs = uniqueDirs.filter((d) => dirCounts[d] === maxCount);
  let verdict: ComparisonVerdict;
  let dissentingModel: string | null = null;
  if (uniqueDirs.length === 1) {
    verdict = 'ALL_AGREE';
  } else if (maxCount > namedDirections.length / 2) {
    verdict = 'MAJORITY';
    const dissenters = namedDirections.filter((m) => m.dir !== modalDirs[0]);
    dissentingModel = dissenters.map((m) => m.name).join(', ');
  } else if (modalDirs.length === 2 && maxCount === namedDirections.length / 2) {
    verdict = 'SPLIT';
  } else {
    verdict = 'NO_CONSENSUS';
  }

  return Object.assign({}, baseResult, extra, { verdict, dissentingModel }) as ComparisonReport;
}

/**
 * The text written to the "🔀 Model Comparison" sheet (engine :1584).
 *
 * ══ FLAGGED (F-29): "2 vs 2" WITH TWO VOICES ══════════════════════════
 * SPLIT is labelled 'SPLIT (2 vs 2, no real majority)' unconditionally,
 * but the rule also fires with TWO voices -- engine plus one other model,
 * disagreeing 1-1 -- whenever the broker report is unavailable. Measured:
 * 486 two-voice SPLITs on real engine and model output. Reproduced, not
 * fixed.
 *
 * Also reproduced: the MAJORITY line names dissenters by internal
 * identifier (existingEngine, schabackerModel, ...); and the engine-vs-
 * broker "Agreement is for ... reasons" line prints under N-way bottom
 * lines too, where it describes only that one pair (567 real cases).
 *
 * `engineVersion` replaces legacy's read of the global CONFIG_V7.version;
 * omitted or empty, the label is just "main engine", as in legacy.
 */
export function formatComparisonReportV1(comparison: ComparisonReport | null, engineVersion?: string | null): string {
  if (!comparison) return 'No comparison — data fetch failed.';
  const lines: string[] = [];
  const push = (s: string): void => {
    lines.push(s);
  };
  push('── ' + comparison.ticker + ' — Comparison Report ──');
  push('');
  if (comparison.verdict) {
    const verdictLabel = comparison.verdict === 'ALL_AGREE' ? 'ALL AGREE'
      : comparison.verdict === 'MAJORITY' ? 'MAJORITY (' + comparison.dissentingModel + ' dissents)'
        : comparison.verdict === 'SPLIT' ? 'SPLIT (2 vs 2, no real majority)'
          : 'NO CONSENSUS';
    const voiceParts = ['existing engine: ' + comparison.existingDirection];
    if (!comparison.newModelUnavailable) voiceParts.push('new model: ' + comparison.newDirection);
    if (comparison.schabackerDirection) voiceParts.push('Schabacker model: ' + comparison.schabackerDirection);
    if (comparison.edwardsMageeDirection) voiceParts.push('Edwards & Magee model: ' + comparison.edwardsMageeDirection);
    if (comparison.turtleDirection) voiceParts.push('Turtle model: ' + comparison.turtleDirection);
    push('BOTTOM LINE: ' + verdictLabel + ' (' + voiceParts.join(', ') + ')');
  } else {
    push('BOTTOM LINE: ' + (comparison.agree ? 'AGREE' : 'CONFLICT')
      + ' (existing engine: ' + comparison.existingDirection + ', new model: ' + comparison.newDirection + ')');
  }
  if (comparison.agree && comparison.sameReasoning != null) {
    push('  Agreement is for ' + (comparison.sameReasoning ? 'related' : 'DIFFERENT') + ' reasons — see signals below.');
  }
  push('');
  const existingEngineLabel = engineVersion ? ('main engine ' + engineVersion) : 'main engine';
  push('EXISTING ENGINE (' + existingEngineLabel + '): ' + comparison.existingHeadline);
  comparison.existingSignals.forEach((s) => push('  - ' + s));
  push('');
  if (!comparison.newModelUnavailable) {
    push('NEW MODEL (brokerCourseModelV1.gs): ' + comparison.newHeadline);
    (comparison.newSignals as string[]).forEach((s) => push('  - ' + s));
  } else {
    push('NEW MODEL (brokerCourseModelV1.gs): unavailable — see this run\'s own log for why.');
  }
  if (comparison.schabackerHeadline) {
    push('');
    push('SCHABACKER MODEL (schabackerModelV1.gs): ' + comparison.schabackerHeadline);
    (comparison.schabackerSignals as string[]).forEach((s) => push('  - ' + s));
  }
  if (comparison.edwardsMageeHeadline) {
    push('');
    push('EDWARDS & MAGEE MODEL (edwardsMageeModelV1.gs): ' + comparison.edwardsMageeHeadline);
    (comparison.edwardsMageeSignals as string[]).forEach((s) => push('  - ' + s));
  }
  if (comparison.turtleHeadline) {
    push('');
    push('TURTLE MODEL (turtleModelV1.gs): ' + comparison.turtleHeadline);
    (comparison.turtleSignals as string[]).forEach((s) => push('  - ' + s));
  }
  return lines.join('\n');
}
