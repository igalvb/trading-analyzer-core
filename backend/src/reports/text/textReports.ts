/**
 * The dashboard-adjacent text and failure writers of fullStockAnalysisV10_9.gs, ported call for call:
 *   padRowV7 :3338-3342, colorVerdictRow9V7_ :5022-5028, buildDataStatusBannerV7 :5130-5159,
 *   logDataStatusSummaryV7 :5170-5192, writeTextReportToSheetV7 :5207-5229, buildFailureSheetV7 :5231-5288
 * (buildNarrativeV7_ :5030-5121 is in ./narrative.ts).
 *
 * No injected dependencies. getOrCreate is the ported reports/options/tabs.ts one; CONFIG_V7.tab (:18) and
 * V7_DASH_COLS (:3336) are constants here; `new Date().toLocaleString()` is the ReportTime stamp (script zone, en-US).
 *
 * Legacy report strings are ported EXACTLY (they are the oracle) and kept with legacyReportText. Several print raw
 * detail (a raw error message, a status `detail`): findings F-H1..F-H5 of the FL-7h handback. Plain mode (default)
 * routes them through the catalog (FL-9c). F-H4: plain mode gives 'skipped' its own icon on the failure sheet.
 * F-H6: plain mode's Reason line never throws (failureReason). F-H5: the banner still ignores 'pending' and is now
 * legacy-only on the dashboard; the plain dashboard draws the Data quality box, which lists steps that did not run.
 */

import type { ReportRange, ReportSheet, ReportWorkbook } from '../../sheets/reportSheet.ts';
import { getOrCreate, localeString, type ReportTime } from '../options/tabs.ts';
import type { ReasonCode } from '../messages/catalog.ts';
import { reasonLine } from '../messages/catalog.ts';
import { statusConsequence, failureReason, type ReportTextOptions } from '../messages/reportText.ts';

/** V7_DASH_COLS (:3336). */
export const DASH_COLS = 10;
/** CONFIG_V7.tab (:18): the one-tab dashboard, which the failure sheet reuses. */
export const ANALYSIS_TAB = '📊 Analysis v7';
/** The sources the banner, the run summary and the failure sheet list, in this order (the same list three times in legacy). */
export const STATUS_DISPLAY_ORDER: readonly string[] = ['price', 'fundamentals', 'series', 'peers', 'spyRS', 'indicators', 'gann', 'confluence', 'options', 'macroRegime', 'institutionalHoldings', 'aiReview', 'brokerModel', 'schabackerModel', 'edwardsMageeModel', 'turtleModel', 'darkPool', 'playerMapping', 'zombieCompanyScreen', 'dilutionScreen', 'comparisonReport'];

/** One tracked source (analysis/dataStatus.ts DataStatusEntry, read loosely: legacy tolerates missing fields). */
export interface StatusRow { readonly label?: string; readonly state?: string; readonly detail?: string; readonly reasonCode?: ReasonCode }
export type RunStatus = Readonly<Record<string, StatusRow | undefined | null>>;

/** padRowV7 (:3338-3342): the first V7_DASH_COLS values, padded with ''. */
export function padRow(vals: readonly unknown[]): unknown[] {
  const out = vals.slice(0, DASH_COLS);
  while (out.length < DASH_COLS) out.push('');
  return out;
}

/** colorVerdictRow9V7_ (:5022-5028): the verdict row's tint by conviction (>=65 green, >=50 amber, else red; null/NaN = red). */
export function colorVerdictRow9(sh: ReportSheet, row: number, conviction: number | null | undefined): void {
  const c = conviction as number;
  const bg = c >= 65 ? '#c8e6c9' : c >= 50 ? '#fff9c4' : '#ffcdd2';
  const fg = c >= 65 ? '#1b5e20' : c >= 50 ? '#e65100' : '#b71c1c';
  sh.getRange(row, 1, 1, 9).setBackground(bg);
  sh.getRange(row, 8).setFontWeight('bold').setFontSize(13).setFontColor(fg);
  sh.getRange(row, 9).setFontWeight('bold').setFontColor(fg);
}

export interface BannerMeta {
  readonly merge: boolean; readonly bg: string; readonly color: string; readonly bold?: boolean; readonly size: number;
  readonly wrap?: boolean; readonly italic?: boolean;
}
export interface BannerRow { readonly text: string[]; readonly meta: BannerMeta }

function bucket(status: RunStatus): { failed: StatusRow[]; skipped: StatusRow[]; degraded: StatusRow[] } {
  const failed: StatusRow[] = [], skipped: StatusRow[] = [], degraded: StatusRow[] = [];
  STATUS_DISPLAY_ORDER.forEach((k) => {
    const s = status[k]; if (!s) return;
    if (s.state === 'failed') failed.push(s);
    else if (s.state === 'skipped') skipped.push(s);
    else if (s.state === 'degraded') degraded.push(s);
  });
  return { failed, skipped, degraded };
}

/** buildDataStatusBannerV7 (:5130-5159): the green all-OK row, or the red summary row plus the 'Affected:' row. No status renders nothing. */
export function buildDataStatusBanner(status: RunStatus | null | undefined, opts?: ReportTextOptions): BannerRow[] {
  if (!status) return [];
  const { failed, skipped, degraded } = bucket(status);

  if (degraded.length === 0 && failed.length === 0 && skipped.length === 0) {
    return [{ text: ['✅ All data sources OK — full-confidence report.'],
      meta: { merge: true, bg: '#1b5e20', color: '#fff', bold: true, size: 10 } }];
  }

  const consequences = failed.concat(skipped).concat(degraded)
    .map((s) => statusConsequence(s, opts))
    .filter(Boolean);
  const parts: string[] = [];
  if (failed.length) parts.push(failed.length + ' failed');
  if (skipped.length) parts.push(skipped.length + ' skipped');
  if (degraded.length) parts.push(degraded.length + ' degraded');
  const summary = '⚠ PARTIAL DATA — this report relies on incomplete inputs. ' + parts.join(', ') + '.';

  return [
    { text: [summary], meta: { merge: true, bg: '#b71c1c', color: '#fff', bold: true, size: 11, wrap: true } },
    { text: ['Affected: ' + consequences.join('   •   ')], meta: { merge: true, bg: '#fff3e0', color: '#b71c1c', italic: true, size: 10, wrap: true } },
  ];
}

/** logDataStatusSummaryV7 (:5170-5192): the one-line end-of-run summary for the log (technical detail is allowed there). */
export function logDataStatusSummary(status: RunStatus | null | undefined, log: ((line: string) => void) | null | undefined): void {
  if (!status || typeof log !== 'function') return;
  const { failed, skipped, degraded } = bucket(status);
  if (!failed.length && !skipped.length && !degraded.length) {
    log('✅ Run Summary: all data sources OK.');
    return;
  }
  const parts: string[] = [];
  if (failed.length) parts.push(failed.length + ' failed');
  if (skipped.length) parts.push(skipped.length + ' skipped');
  if (degraded.length) parts.push(degraded.length + ' degraded');
  const detail = failed.concat(skipped).concat(degraded)
    .map((s) => s.label + (s.detail ? ' (' + s.detail + ')' : ''))
    .join('   •   ');
  log('🔍 Run Summary: ' + parts.join(', ') + ' — ' + detail);
}

/**
 * The sheet surface writeTextReportToSheetV7 needs beyond ReportSheet: the row grid. ReportSheet has neither method,
 * so the caller supplies a sheet that has them (see the leftovers in the FL-7h handback).
 */
export type TextReportSheet = ReportSheet & {
  getMaxRows(): number;
  insertRowsAfter(afterPosition: number, howMany: number): unknown;
};

/** writeTextReportToSheetV7 (:5207-5229): one line per row in column A; '===' title lines and '1. ' section lines are bold and tinted. */
export function writeTextReportToSheet(sh: TextReportSheet, text: unknown, accentColor?: string | null): void {
  try { sh.getDataRange().breakApart(); } catch (e) { /* a sheet that was not read: nothing to unmerge (legacy swallows it) */ }
  sh.clearContents(); sh.clearFormats();
  sh.setTabColor(accentColor || '#455a64');
  const lines = String(text || '').split('\n');
  // v9.46 (legacy): never write past the sheet's current row grid.
  if (sh.getMaxRows() < lines.length) sh.insertRowsAfter(sh.getMaxRows(), lines.length - sh.getMaxRows());
  sh.getRange(1, 1, lines.length, 1).setValues(lines.map((l) => [l]));
  sh.setColumnWidth(1, 900);
  lines.forEach((l, i) => {
    const row = i + 1;
    if (l.indexOf('===') === 0) {
      sh.getRange(row, 1).setFontWeight('bold').setFontSize(13).setBackground(accentColor || '#455a64').setFontColor('#fff');
    } else if (/^\d+\.\s/.test(l)) {
      sh.getRange(row, 1).setFontWeight('bold').setFontSize(11).setBackground('#eceff1');
    }
  });
  sh.setFrozenRows(1);
}

interface RowMeta { merge?: boolean; bg?: string; color?: string; bold?: boolean; italic?: boolean; size?: number; wrap?: boolean; header?: boolean }

/**
 * buildFailureSheetV7 (:5231-5288): the "always leave a readable sheet" tab, on the dashboard's own tab name.
 * `error` is whatever was thrown: an Error (its message), a string, or nothing ('Unknown error').
 */
export function buildFailureSheet(ss: ReportWorkbook, ticker: string | null | undefined, status: RunStatus | null | undefined, error: unknown, time: ReportTime, opts?: ReportTextOptions): void {
  const sh = getOrCreate(ss, ANALYSIS_TAB);
  // Same fix class as P2-2 (legacy): the tab can inherit a stale merge from whichever writer ran last.
  try { sh.getDataRange().breakApart(); } catch (e) { /* a sheet that was not read (legacy swallows it) */ }
  sh.clearContents(); sh.clearFormats(); sh.setTabColor('#b71c1c');

  const rows: unknown[][] = [], meta: RowMeta[] = [];
  function pushRow(vals: readonly unknown[], m?: RowMeta): void { rows.push(padRow(vals)); meta.push(m || {}); }

  pushRow(['⚠ ANALYSIS INCOMPLETE — ' + (ticker || '(no ticker)') + '   ·   ' + localeString(time)],
    { merge: true, bg: '#b71c1c', color: '#fff', bold: true, size: 14, wrap: true });
  const err = error as { message?: unknown } | null | undefined;
  let reasonText: string;
  if (opts && opts.legacyReportText) {
    const msg = (err && err.message) ? (err.message as string) : String(error || 'Unknown error');
    reasonText = msg.substring(0, 300);
  } else {
    reasonText = failureReason(error, opts);
  }
  pushRow(['Reason: ' + reasonText], { merge: true, bg: '#fff3e0', color: '#b71c1c', bold: true, size: 11, wrap: true });
  pushRow([''], {});

  // Per-source status table so the user can see what DID load.
  pushRow(['Data source', 'Status', 'Detail', '', '', '', '', '', '', ''], { header: true, bg: '#eeeeee' });
  const icon: Record<string, string> = { ok: '✅ ok', degraded: '⚠️ degraded', failed: '❌ failed', pending: '⏳ not reached' };
  // F-H4: legacy has no 'skipped' icon (it prints the bare state word); plain mode gives it one
  if (!(opts && opts.legacyReportText)) icon['skipped'] = '⏭ skipped';
  STATUS_DISPLAY_ORDER.forEach((k) => {
    const s = status && status[k]; if (!s) return;
    pushRow([s.label || k, icon[s.state as string] || s.state, (opts && opts.legacyReportText) ? (s.detail || '') : (s.reasonCode ? reasonLine(s.reasonCode) : '')], {});
  });
  pushRow([''], {});
  pushRow(['What to do: check the ticker symbol, or re-run in a minute — external APIs (Yahoo/FMP/Finnhub/Gemini) may be rate-limited. Nothing in your other scripts was affected.'],
    { merge: true, italic: true, color: '#555', size: 10, wrap: true });

  sh.getRange(1, 1, rows.length, DASH_COLS).setValues(rows);
  for (let i = 0; i < rows.length; i++) {
    const r = i + 1, m = meta[i]; if (!m) continue;
    if (m.merge) {
      const rng: ReportRange = sh.getRange(r, 1, 1, DASH_COLS).merge();
      if (m.wrap) rng.setWrap(true);
      if (m.bg) rng.setBackground(m.bg);
      if (m.color) rng.setFontColor(m.color);
      if (m.bold) rng.setFontWeight('bold');
      if (m.italic) rng.setFontStyle('italic');
      if (m.size) rng.setFontSize(m.size);
    } else if (m.header) {
      const rng = sh.getRange(r, 1, 1, DASH_COLS);
      rng.setFontWeight('bold'); if (m.bg) rng.setBackground(m.bg);
    }
  }
  sh.setColumnWidths(1, DASH_COLS, 95);
  sh.setColumnWidth(1, 190);
  sh.setColumnWidth(3, 420);
}
