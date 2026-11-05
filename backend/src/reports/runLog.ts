/**
 * makeLogger (fullStockAnalysisV10_9.gs:8762-8780): the stock analysis's
 * run log on the '🔬 Log' tab -- appended (a separator line, then one
 * "h:mm:ss AM  message" row per call, in the script's zone), never cleared.
 * Legacy's SpreadsheetApp.flush() every third line has no equivalent; the
 * workbook is flushed once at the end of the run. The workbook must have
 * loaded '🔬 Log' (getLastRow).
 */

import type { Clock } from '../core/context.ts';
import type { ReportWorkbook } from '../sheets/reportSheet.ts';
import { getOrCreate, OptionsTabs } from './options/tabs.ts';

export const RUN_LOG_SEPARATOR = '─'.repeat(29);

export type RunLog = (msg: string) => void;

export function makeLogger(ss: ReportWorkbook, deps: { readonly timeZone: string; readonly clock?: Clock }): RunLog {
  const sh = getOrCreate(ss, OptionsTabs.LOG);
  const lastRow = sh.getLastRow();
  if (lastRow > 0) sh.getRange(lastRow + 1, 1).setValue(RUN_LOG_SEPARATOR);
  let logRow = lastRow + 2;
  return (msg: string): void => {
    const now = deps.clock ? deps.clock.now() : Date.now();
    sh.getRange(logRow++, 1).setValue(new Date(now).toLocaleTimeString('en-US', { timeZone: deps.timeZone }) + '  ' + msg);
  };
}
