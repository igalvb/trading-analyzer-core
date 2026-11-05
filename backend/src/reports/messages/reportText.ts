/**
 * Report-text helpers (FL-9c). They route report-facing strings through the catalog so raw error text, URLs and
 * status codes stay in the LOG. `legacyReportText: true` restores the old text exactly (parity tests only).
 */

import { messageOf } from '../../core/errors.ts';
import { classifyError, labelledReason, reasonLine, reasonSentence, type ReasonCode } from './catalog.ts';
import { findReportLeaks } from './leakScan.ts';

export interface ReportTextOptions {
  /** true = the old text, byte for byte (parity tests). Default: plain English. */
  readonly legacyReportText?: boolean;
  /** Receives the technical detail that plain mode keeps out of the report. Wire to the log. */
  readonly onDetail?: (line: string) => void;
}

/** The thrown value as text, for logs only. Never throws. */
export function detailOf(e: unknown): string {
  try { return messageOf(e); } catch { return 'unprintable error'; }
}

function note(opts: ReportTextOptions | undefined, line: string): void {
  try { if (opts && opts.onDetail) opts.onDetail(line); } catch { /* a failing log hook never breaks a report */ }
}

/** A report cell for a section that threw. Legacy: '⚠️ <label> error: <message cut to max>'. Plain: '⚠️ <label>: This section could not be built.' */
export function sectionErrorText(label: string, e: any, max: number, opts?: ReportTextOptions): string {
  if (opts && opts.legacyReportText) return '⚠️ ' + label + ' error: ' + e.message.substring(0, max);
  note(opts, 'report section "' + label + '" failed: ' + detailOf(e));
  return '⚠️ ' + labelledReason(label, 'SECTION_UNAVAILABLE');
}

export interface StatusLike { readonly label?: string; readonly detail?: string; readonly reasonCode?: ReasonCode }

/** One 'Affected:' item of the data-status banner. Legacy: detail, else label. Plain: label, plus the reason line when a code is set. */
export function statusConsequence(s: StatusLike, opts?: ReportTextOptions): string {
  if (opts && opts.legacyReportText) return s.detail || s.label || '';
  const label = s.label || '';
  if (s.reasonCode) return label ? label + ': ' + reasonLine(s.reasonCode) : reasonLine(s.reasonCode);
  return label;
}

/** The failure sheet's 'Reason:' text (plain mode only; the legacy text stays inline in buildFailureSheet). */
export function failureReason(error: unknown, opts?: ReportTextOptions): string {
  note(opts, 'analysis failed: ' + detailOf(error).substring(0, 300));
  if (!error) return reasonLine('SECTION_UNAVAILABLE');
  return reasonLine(classifyError(error));
}

/** An exit-row summary for a failed read. Keeps the 'ERROR' prefix (row order and colour test for it) and drops the colon. */
export function exitSummaryError(legacyText: string, code: ReasonCode, opts?: ReportTextOptions): string {
  if (opts && opts.legacyReportText) return legacyText;
  note(opts, 'exit row: ' + legacyText);
  return 'ERROR — ' + reasonLine(code);
}

/** 'not found — <reason>' for a recommended-option pick. Plain mode keeps the reason only when it is clean, authored text. */
export function notFoundText(reason: unknown, opts?: ReportTextOptions): string {
  if (opts && opts.legacyReportText) return 'not found — ' + reason;
  const text = typeof reason === 'string' ? reason.trim() : '';
  const internal = /\b(?:field|feed|payload|endpoint|schema)\b/i.test(text);
  if (text && !internal && findReportLeaks(text).length === 0) return 'not found — ' + text;
  note(opts, 'option pick not found, raw reason: ' + String(reason));
  return 'not found — ' + reasonSentence(internal ? 'FIELD_MISSING' : 'NO_DATA_FOR_TICKER');
}
