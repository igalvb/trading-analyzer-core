/**
 * buildBottomLineSummaryV7 (fullStockAnalysisV10_9.gs:5326-5438): the
 * '📋 Bottom Line' tab (legacy: '📋 Bottom Line — <ticker>', kept with deps.legacyReportText;
 * phase 1 of docs/SHEETS_CLEANUP_PLAN.md) -- one conclusion per strategy, from values
 * runFullAnalysis already computed (no fetches, no recomputation). The write
 * sequence is legacy's, call for call.
 *
 * Injected: deps.clock (legacy `new Date()` in the header) and deps.timeZone
 * (legacy used the script zone implicitly). The expiry text uses
 * Date#toDateString(), which has no zone parameter, so the process TZ must be
 * America/New_York (F-I7).
 *
 * Legacy quirks, kept only with deps.legacyReportText (parity tests); FIXED by default:
 *   F-I5 rrToT1AtSpot + entryPrice with a null rrToT1 threw a TypeError after the tab
 *        was cleared and half written (fixed: the "(vs ...)" part is left out); a null
 *        techPlan threw too (fixed: read as an empty plan, every line says N/A);
 *   F-I6 "not found — " + the pick's reason verbatim; "1 sell rungs" (fixed by FL-9c);
 *   F-I8 any error in the ladder block became "N/A this run" with no trace (fixed: the
 *        catalog line "This section could not be built.", the error to onReportDetail).
 */

import type { ReportSheet, ReportWorkbook } from '../../sheets/reportSheet.ts';
import { computeStockEntryLadder, computeStockExitLadder } from '../../analysis/ladders.ts';
import { notFoundText, detailOf } from '../messages/reportText.ts';
import { reasonLine } from '../messages/catalog.ts';
import { readExtraModels, extraModelRows } from '../../analysis/extraModels.ts';
import { jamesBottomLines } from '../../analysis/jamesPages.ts';
import { james2BottomLines } from '../../analysis/jamesPhase2Pages.ts';
import { james3BottomLines } from '../../analysis/jamesPhase3Pages.ts';
import { james4BottomLines } from '../../analysis/jamesPhase4Pages.ts';
import { james5BottomLines } from '../../analysis/jamesPhase5Pages.ts';
import { occExpiryText } from '../../core/dates.ts';
import { pickLabel } from '../../analysis/options/labels.ts';

/** The fixed tab name every run writes (docs/SHEETS_CLEANUP_PLAN.md (c)); row 1 names the ticker and the run time. */
export const BOTTOM_LINE_TAB = '📋 Bottom Line';
/** Legacy's per-ticker name: BOTTOM_LINE_TAB_PREFIX + ticker. Legacy-parity only (and `npm run cleanup-report-tabs`). */
export const BOTTOM_LINE_TAB_PREFIX = '📋 Bottom Line — ';

/** The Bottom Line tab's name: fixed, or legacy's per-ticker name in legacy-parity mode. */
export function bottomLineTabName(ticker: string, legacy = false): string {
  return legacy ? BOTTOM_LINE_TAB_PREFIX + ticker : BOTTOM_LINE_TAB;
}

export interface BottomLineSheetDeps {
  readonly clock: { now(): number };
  readonly timeZone: string;
  /** FL-9c: true = the old text ('not found — <raw reason>', '1 sell rungs'; parity tests only). Default: plain English. */
  readonly legacyReportText?: boolean;
  /** Phase 1 (fixed tabs): true = legacy's per-ticker tab name. Default: legacyReportText (the parity flag). */
  readonly legacyTabName?: boolean;
  /** FL-9c: receives the raw pick reason that plain mode keeps out of the report. */
  readonly onReportDetail?: (line: string) => void;
  /**
   * FL-17b: the run's ExtraModelsReport (analysis/extraModels.ts): Wyckoff (original method), Trend 150 / 200, the
   * 2-of-3 combo and the labelled older engine Wyckoff read, one line each after the LILO line. Display only.
   * Absent (undefined) = the lines are left out (and always in legacy mode); null = one "did not run" line.
   */
  readonly extraModels?: unknown;
  /**
   * E1 (option A, label only): the run's "✅ AT YOUR BUY LIMIT — ..." text (analysis/atBuyLimit.ts) when the price
   * is inside or below the buy zone, above the stop, with timing WAIT_PULLBACK. It leads the Overall Action line
   * (the engine's action and the conviction stay). Ignored in legacy mode.
   */
  readonly atBuyLimit?: string | null;
  /**
   * B1 option B (display only): "Next resistance: $X (+Y%, methods) · R:R to it Z" (analysis/nextResistance.ts),
   * one line after the R:R lines. T1 and its R:R stay the plan's. Ignored in legacy mode.
   */
  readonly nextResistance?: string | null;
}

export interface BottomLineFundResult {
  readonly score?: number | null;
  readonly verdict?: string | null;
}

export interface BottomLineTechPlan {
  readonly techScore?: number | null;
  readonly timing?: string | null;
  readonly regime?: string | null;
  readonly secular?: { readonly verdict: string; readonly why: string } | null;
  readonly atr14?: number | null;
  readonly stop?: number | null;
  readonly entryPrice?: number | null;
  readonly entryCount?: unknown;
  readonly entryLow?: number;
  readonly entryHigh?: number;
  readonly t1?: { readonly price: number } | null;
  readonly t2?: { readonly price: number } | null;
  readonly rrToT1?: number | null;
  readonly rrToT1AtSpot?: number | null;
}

export interface BottomLineDecisionLike {
  readonly action?: string;
  readonly finalConviction?: number | null;
}

/** A recommended-call pick as the orchestrator passes it: not found (with a reason) or found (with its contract). */
export interface BottomLinePick {
  readonly found?: boolean;
  readonly reason?: string;
  readonly contract?: { readonly strike: number | string; readonly expUnix: number; readonly delta: number; readonly iv?: number | null };
}

export function buildBottomLineSummary(
  ss: ReportWorkbook, ticker: string, fundResult: BottomLineFundResult | null | undefined, techPlan: BottomLineTechPlan,
  decision: BottomLineDecisionLike | null | undefined, leapsCallArg: BottomLinePick | null | undefined, shortTermCallArg: BottomLinePick | null | undefined,
  deps: BottomLineSheetDeps,
): void {
  const legacy = !!deps.legacyReportText;
  // F-I5: a missing tech plan is read as empty (legacy throws on techPlan.techScore after clearing the tab)
  if (!legacy && !techPlan) techPlan = {};
  const sheetName = bottomLineTabName(ticker, deps.legacyTabName ?? legacy);
  const existing = ss.getSheetByName(sheetName);
  if (existing) { existing.clearContents(); existing.clearFormats(); }
  const sh: ReportSheet = existing ?? ss.insertSheet(sheetName);
  sh.setTabColor('#4a148c');

  let row = 1;
  sh.getRange(row, 1, 1, 2).merge().setValue('📋 BOTTOM LINE — ' + ticker + '   |   ' + new Date(deps.clock.now()).toLocaleString('en-US', { timeZone: deps.timeZone })).setBackground('#1a237e').setFontColor('#fff').setFontSize(13).setFontWeight('bold'); row += 2;

  sh.getRange(row, 1, 1, 2).setValues([['Strategy', 'Conclusion']]).setFontWeight('bold').setBackground('#616161').setFontColor('#fff'); row++;

  function line(label: string, text: string, bg?: string | null): void {
    sh.getRange(row, 1).setValue(label).setFontWeight('bold');
    sh.getRange(row, 2).setValue(text).setWrap(true);
    if (bg) sh.getRange(row, 1, 1, 2).setBackground(bg);
    row++;
  }

  // Overall: the single headline verdict
  const atLimit = !legacy && deps.atBuyLimit ? deps.atBuyLimit + '  ·  Engine: ' : '';
  line('🏆 Overall Action', atLimit + (decision && decision.action ? decision.action : 'N/A') + '  (Final Conviction: ' + (decision && decision.finalConviction != null ? decision.finalConviction : 'N/A') + '/100)', atLimit ? '#e8f5e9' : '#ede7f6');

  // Fundamentals
  if (fundResult && fundResult.score != null) {
    line('💰 Fundamentals (OWN)', fundResult.score + '/100 — ' + (fundResult.verdict || ''));
  } else {
    line('💰 Fundamentals (OWN)', 'N/A this run');
  }

  // Stock: short-term timing (a null techPlan throws here, like legacy)
  line('📊 Stock Timing (short-term)', (techPlan.techScore != null ? techPlan.techScore + '/100' : 'N/A') + ' — ' + (techPlan.timing || 'N/A') + '  (regime: ' + (techPlan.regime || 'N/A') + ')');

  // Stock: secular
  if (techPlan.secular) {
    line('📈 Stock Secular (5-10yr hold)', techPlan.secular.verdict + ' — ' + techPlan.secular.why);
  } else {
    line('📈 Stock Secular (5-10yr hold)', 'N/A this run');
  }

  // ATR / risk
  if (techPlan.atr14 != null && techPlan.stop != null) {
    const riskPerShare = (techPlan.entryPrice != null) ? Math.abs(techPlan.entryPrice - techPlan.stop) : null;
    line('📏 ATR / Risk', '$' + techPlan.atr14.toFixed(2) + ' ATR  ·  Stop $' + techPlan.stop.toFixed(2) + (riskPerShare != null ? '  ·  Risk $' + riskPerShare.toFixed(2) + '/share' : ''));
  } else {
    line('📏 ATR / Risk', 'N/A this run');
  }

  // LILO: the same ladder functions the chart uses; any error here is swallowed (F-I8)
  try {
    const entryLadder = computeStockEntryLadder({ entryCount: techPlan.entryCount, entryLow: techPlan.entryLow as number, entryHigh: techPlan.entryHigh as number });
    const exitLadder = computeStockExitLadder(techPlan);
    if (entryLadder.length || exitLadder.length) {
      const buyRange = entryLadder.length ? '$' + Math.min(...entryLadder.map((r) => r.price)).toFixed(2) + '–$' + Math.max(...entryLadder.map((r) => r.price)).toFixed(2) : 'none';
      const sellRange = exitLadder.length ? exitLadder.map((r) => '$' + r.price.toFixed(2)).join(', ') : 'none';
      const rungWord = (n: number): string => (!deps.legacyReportText && n === 1) ? ' rung' : ' rungs';
      line('🪜 LILO Ladder', entryLadder.length + ' buy' + rungWord(entryLadder.length) + ' (' + buyRange + ')  ·  ' + exitLadder.length + ' sell' + rungWord(exitLadder.length) + ' (' + sellRange + ')');
    } else {
      line('🪜 LILO Ladder', 'no rungs this run (insufficient confluence alignment)');
    }
  } catch (e) {
    if (legacy) line('🪜 LILO Ladder', 'N/A this run');
    else {
      // F-I8: say the section failed, in catalog words; the technical detail goes to the log
      try { if (deps.onReportDetail) deps.onReportDetail('bottom line: LILO ladder failed: ' + detailOf(e)); } catch { /* a log hook never breaks the report */ }
      line('🪜 LILO Ladder', reasonLine('SECTION_UNAVAILABLE'));
    }
  }

  // James's models, phase 1: "🪜 James — LILO v2" and "💰 James — Profit-Taking" next to the LILO line (display only)
  if (!legacy && deps.extraModels) {
    try { const j = readExtraModels(deps.extraModels)?.james; if (j) for (const [label, text] of jamesBottomLines(j)) line(label, text); } catch { /* display only: a failure here never breaks the report */ }
    // phase 2: ↩️ Mean Reversion, 🔁 Pair Rotation, 🏆 Winners & Layering
    try { const j = readExtraModels(deps.extraModels)?.james2; if (j) for (const [label, text] of james2BottomLines(j)) line(label, text); } catch { /* display only */ }
    // phase 3: 🔄 Multi-Year Cycle, 🪤 Market Maker Stages
    try { const j = readExtraModels(deps.extraModels)?.james3; if (j) for (const [label, text] of james3BottomLines(j)) line(label, text); } catch { /* display only */ }
    // phase 4: 🎯 James — LEAPS (and ⚖️ James — Option Fair Value when a flag fires)
    try { const j = readExtraModels(deps.extraModels)?.james4; if (j) for (const [label, text] of james4BottomLines(j)) line(label, text); } catch { /* display only */ }
    // phase 5: ✅ James — Quality Gate
    try { const j = readExtraModels(deps.extraModels)?.james5; if (j) for (const [label, text] of james5BottomLines(j)) line(label, text); } catch { /* display only */ }
  }

  // FL-17b: the newer models, one line each (display only; nothing above depends on them)
  if (!legacy && deps.extraModels !== undefined) {
    const extra = readExtraModels(deps.extraModels);
    if (!extra) line('🏛️ Wyckoff, Trend and Combo models', reasonLine('NOT_RUN'));
    else for (const [label, text] of extraModelRows(extra, { withEverything: true })) line((label.startsWith('Wyckoff') ? '🏛️ ' : label.startsWith('Trend') ? '📈 ' : '🧩 ') + label, text);
  }

  // Options: LEAPS and short-term picks. The short-term pick is cross-checked against the equity timing.
  function optionLine(label: string, pick: BottomLinePick | null | undefined, checkTimingConflict: boolean): void {
    if (!pick) { line(label, 'not available this run (run via 🚀 Full Ticker Analysis for options data)'); return; }
    if (!pick.found) { line(label, notFoundText(pick.reason, { legacyReportText: deps.legacyReportText, onDetail: deps.onReportDetail })); return; }
    const c = pick.contract as NonNullable<BottomLinePick['contract']>;
    const expDate = new Date(c.expUnix * 1000);
    let text = '$' + c.strike + ' call, exp ' + (legacy ? expDate.toDateString() : occExpiryText(c.expUnix)) + '  ·  delta ' + c.delta.toFixed(2) + '  ·  IV ' + (c.iv ? (c.iv * 100).toFixed(1) + '%' : 'N/A');
    let bg: string | null = null;
    if (checkTimingConflict && (techPlan.timing === 'WAIT_PULLBACK' || techPlan.timing === 'AVOID')) {
      text += '  ⚠ Equity signal says ' + techPlan.timing + ' — buying this now runs ahead of that plan';
      bg = '#fff3e0';
    }
    line(label, text, bg);
  }
  optionLine(legacy ? '📞 Options — LEAPS (>1yr)' : '📞 Options — ' + pickLabel(true, 0.75), leapsCallArg, false);
  optionLine(legacy ? '📞 Options — Short-term (<1yr)' : '📞 Options — ' + pickLabel(false, 0.50), shortTermCallArg, true);

  // R:R gate: only when it fired
  if (techPlan.rrToT1 != null) {
    const rr1 = techPlan.rrToT1;
    if (rr1 < 1.5) {
      line('⚠ R:R Gate', 'T1 R:R ' + rr1.toFixed(2) + (rr1 < 1.0 ? ' — marginal structure' : ' — thin, size accordingly'), rr1 < 1.0 ? '#fff3e0' : null);
    }
  }
  // R:R at today's price, always shown when present. F-I5: legacy throws on rrToT1.toFixed when rrToT1 is null; fixed by leaving the comparison out.
  if (techPlan.rrToT1AtSpot != null) {
    const rr1Spot = techPlan.rrToT1AtSpot;
    line('📍 R:R at today\'s price', 'T1 R:R ' + rr1Spot.toFixed(2) + (techPlan.entryPrice != null && (legacy || techPlan.rrToT1 != null) ? ' (vs ' + (techPlan.rrToT1 as number).toFixed(2) + ' at the $' + techPlan.entryPrice.toFixed(2) + ' ladder entry)' : ''), rr1Spot < 1.0 ? '#fff3e0' : null);
  }
  // B1 option B (display only): the nearest valid resistance next to T1
  if (!legacy && deps.nextResistance) line('🧱 Next resistance', deps.nextResistance.replace(/^Next resistance: /, '') + '  (T1 stays the plan\'s target)');

  sh.setColumnWidth(1, 220);
  sh.setColumnWidth(2, 620);
  sh.activate();
}
