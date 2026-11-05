/**
 * myOptionsValueTracker.gs, ported in full (the fetch half,
 * myOpt_fetchCurrentPrice, is fetch/cboe.ts since FL-6a):
 *   MYOPT_PORTFOLIO_SHEET_NAME :26, myOpt_parseDate :32-56, myOpt_findTable :68-87,
 *   findPortfolioStockTableV1_ :99-118, parsePortfolioNumberV1_ :128-132,
 *   refreshMyOptionsValue :135-185, installMyOptionsEndOfDayTrigger :187-196
 *
 * refreshMyOptionsValue writes each held option's current market value
 * (mid x 100 x contracts) into the Portfolio tab's 'current market value'
 * column -- only those cells; nothing else on the user's tab is rewritten.
 * Kept from legacy: the scan stops at the first blank ticker (F-67; the
 * Phase-1 portfolio reader, sheets/readers/portfolio.ts, does not).
 *
 * The trigger (~17:00 daily) becomes MY_OPTIONS_DAILY_JOB for the workflow.
 */

import type { HttpClient } from '../net/http.ts';
import { wallClockInTz } from '../core/dates.ts';
import { myOptFetchCurrentPrice } from '../fetch/cboe.ts';
import type { ReportSheet, ReportWorkbook } from '../sheets/reportSheet.ts';
import type { TabCell } from '../storage/tabStore.ts';

export const MYOPT_PORTFOLIO_SHEET_NAME = 'Portfolio';

export interface YMD {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const MONTHS: Readonly<Record<string, number>> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** A string JS's Date parser reads as an absolute instant (date-only ISO = UTC, or an explicit zone). */
const ABSOLUTE = /^\d{4}-\d{2}(-\d{2})?$|[zZ]$|[+-]\d{2}:?\d{2}$/;

/**
 * myOpt_parseDate (:32-56): a Date, "Mar19'27" / "JUN17'27" style, or
 * whatever `new Date(str)` accepts -- as local calendar fields in the
 * script's zone, as Apps Script read them. F-69: a date-only ISO string
 * ('2027-06-17') is parsed as UTC midnight, so west of UTC it reads as the
 * day before; kept.
 */
export function myOptParseDate(val: unknown, timeZone: string): YMD | null {
  if (val instanceof Date && !isNaN(val.getTime())) {
    const w = wallClockInTz(val.getTime(), timeZone);
    return { year: w.year, month: w.month, day: w.day };
  }
  const str = String(val || '').trim();
  if (!str) return null;
  const mShort = str.match(/^([A-Za-z]{3})\s*(\d{1,2})['\s]*(\d{2,4})$/);
  if (mShort) {
    const mm = MONTHS[mShort[1].toLowerCase()];
    const dd = parseInt(mShort[2], 10);
    let yy = parseInt(mShort[3], 10);
    if (yy < 100) yy += 2000;
    if (mm && dd && yy) return { year: yy, month: mm, day: dd };
  }
  const d = new Date(str);
  if (!isNaN(d.getTime())) {
    if (ABSOLUTE.test(str)) {
      const w = wallClockInTz(d.getTime(), timeZone);
      return { year: w.year, month: w.month, day: w.day };
    }
    // Parsed as local wall-clock fields: those fields are the answer in any zone.
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  }
  return null;
}

export type TableLocation = { readonly sheet: ReportSheet; readonly headerRow: number; readonly col: Record<string, number> } | { readonly error: string };

function locate(ss: ReportWorkbook, mustHave: readonly [string, string], required: readonly string[], kind: string, notFound: string): TableLocation {
  const sh = ss.getSheetByName(MYOPT_PORTFOLIO_SHEET_NAME);
  if (!sh) return { error: 'No sheet named "' + MYOPT_PORTFOLIO_SHEET_NAME + '" found.' };
  const data = sh.getDataRange().getValues();
  for (let r = 0; r < data.length; r++) {
    const row = data[r].map((c) => String(c || '').trim());
    if (row.indexOf(mustHave[0]) === -1 || row.indexOf(mustHave[1]) === -1) continue;
    const col: Record<string, number> = {};
    row.forEach((h, i) => { if (h) col[h] = i; });
    const missing = required.filter((k) => col[k] == null);
    if (missing.length) return { error: 'Found ' + kind + ', but missing column(s): ' + missing.join(', ') };
    return { sheet: sh, headerRow: r + 1, col };
  }
  return { error: notFound };
}

/** myOpt_findTable (:68-87): the options table on 'Portfolio', by its header row. */
export function myOptFindTable(ss: ReportWorkbook): TableLocation {
  return locate(ss, ['last trade Date', 'positions'], ['Ticker', 'positions', 'last trade Date', 'strike', 'PUT/CALL', 'current market value'],
    'options table', 'Could not find options table header row containing "last trade Date" and "positions".');
}

/** findPortfolioStockTableV1_ (:99-118): the stock/crypto table on 'Portfolio'. */
export function findPortfolioStockTable(ss: ReportWorkbook): TableLocation {
  return locate(ss, ['cost avg per stock', 'Ticker'], ['Ticker', 'type', 'amount', 'cost avg per stock'],
    'stock/crypto table', 'Could not find stock/crypto table header row containing "cost avg per stock" and "Ticker".');
}

/** parsePortfolioNumberV1_ (:128-132): '$48.10' -> 48.1; unparseable -> null. */
export function parsePortfolioNumber(v: unknown): number | null {
  if (typeof v === 'number') return isNaN(v) ? null : v;
  const n = parseFloat(String(v || '').replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}

export interface MyOptionsDeps {
  readonly workbook: ReportWorkbook;
  readonly http: HttpClient;
  /** The script's zone (Date cells). */
  readonly timeZone: string;
  /** Logger.log. */
  readonly log?: (message: string) => void;
  /** SpreadsheetApp.getUi().alert (none in a scheduled run). */
  readonly alert?: (text: string) => void;
}

/** refreshMyOptionsValue (:135-185). The workbook must have loaded 'Portfolio'. */
export async function refreshMyOptionsValue(deps: MyOptionsDeps): Promise<void> {
  const log = deps.log ?? ((): void => {});
  const ss = deps.workbook;
  const loc = myOptFindTable(ss);
  if ('error' in loc) {
    log('❌ refreshMyOptionsValue: ' + loc.error);
    try { if (deps.alert) deps.alert(loc.error); } catch { /* no UI */ }
    return;
  }
  const sh = loc.sheet, col = loc.col;
  const lastCol = sh.getLastColumn();
  const numRows = sh.getLastRow() - loc.headerRow;
  if (numRows < 1) throw new Error('The number of rows in the range must be at least 1.');
  const data = sh.getRange(loc.headerRow + 1, 1, numRows, lastCol).getValues();
  let updated = 0, skipped = 0;

  for (let i = 0; i < data.length; i++) {
    const row: TabCell[] = data[i];
    const r = loc.headerRow + 1 + i;
    const ticker = String(row[col['Ticker']] || '').toUpperCase().trim();
    if (!ticker) break;

    const strike = parseFloat(row[col['strike']] as string);
    const sideRaw = String(row[col['PUT/CALL']] || '').toLowerCase().trim();
    const side = sideRaw === 'put' ? 'put' : 'call';
    const contracts = parseFloat(row[col['positions']] as string);
    const expiryCell = row[col['last trade Date']];
    const parsedDate = myOptParseDate(expiryCell, deps.timeZone);

    if (isNaN(strike) || isNaN(contracts) || !parsedDate) {
      log('⚠️ Skipping row ' + r + ': invalid strike/positions/date (' + expiryCell + ')');
      skipped++;
      continue;
    }

    const result = await myOptFetchCurrentPrice({ http: deps.http, log }, ticker, strike, parsedDate, side);
    const targetCell = sh.getRange(r, col['current market value'] + 1);
    if (!result.found || result.mid == null) {
      targetCell.setValue('N/A — ' + (result as { reason?: string }).reason);
      skipped++;
    } else {
      targetCell.setValue(result.mid * 100 * contracts);
      targetCell.setNumberFormat('$#,##0.00');
      updated++;
    }
  }
  log('✅ refreshMyOptionsValue: ' + updated + ' updated, ' + skipped + ' skipped.');
}

/** installMyOptionsEndOfDayTrigger (:187-196) -> the workflow schedule. */
export const MY_OPTIONS_DAILY_JOB = {
  key: 'myOptions.refresh', handler: 'refreshMyOptionsValue', installer: 'installMyOptionsEndOfDayTrigger',
  everyDays: 1, atHour: 17, nearMinute: null, run: refreshMyOptionsValue,
} as const;
