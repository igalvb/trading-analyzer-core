/**
 * Every CLI entry's sheet writes run inside the Master Lock (decision F-73, sheets/masterLock.ts withUnlockedSheets):
 * unlock -> the run -> lock again in a `finally`, so a crash in the middle still leaves the sheet locked. Memory mode
 * has no sheet: the run is called as is. The workflows keep their own `npm run lock-sheets` step (if: always()) as the
 * backstop for a killed process.
 *
 * A failed unlock stops the run before anything is written (SheetLockError, isUnlockFailure); the entry prints
 * UNLOCK_FAILED_LINE. A failed re-lock comes back as a plain report line for the entry to print. The technical detail
 * of both is in the log (masterLock.ts logs it).
 */

import type { Services } from '../compose.ts';
import { withUnlockedSheets, SheetLockError, type MasterLockSheets } from '../sheets/masterLock.ts';
import { labelledReason } from '../reports/messages/catalog.ts';

export interface SheetWriteRun<T> {
  readonly value: T;
  /** Plain report lines (a failed re-lock). Empty when all went well. */
  readonly reportLines: readonly string[];
}

export async function withSheetWrites<T>(s: Pick<Services, 'ctx' | 'sheets'> & Partial<Pick<Services, 'reportsSheets' | 'dataSheets'>>, fn: () => Promise<T>): Promise<SheetWriteRun<T>> {
  if (!s.sheets) return { value: await fn(), reportLines: [] };
  // Three spreadsheets (plan (d) "Master Lock"): unlock My Portfolio, then the reports and data spreadsheets, each
  // inside the one before. A failed unlock on any of them stops the run before writing, and every sheet already
  // unlocked is locked again by its own `finally`.
  const sheets: MasterLockSheets[] = [s.sheets, ...[s.reportsSheets, s.dataSheets].filter((x): x is NonNullable<typeof x> => !!x)];
  const nest = async (i: number): Promise<SheetWriteRun<T>> => {
    if (i >= sheets.length) return { value: await fn(), reportLines: [] };
    const r = await withUnlockedSheets(s.ctx, sheets[i] as MasterLockSheets, () => nest(i + 1));
    return { value: r.value.value, reportLines: [...r.value.reportLines, ...r.reportLines] };
  };
  return nest(0);
}

/** The plain line for a failed unlock: nothing was written. */
export const UNLOCK_FAILED_LINE = labelledReason('Sheet lock', 'SHEET_UNLOCK_FAILED');

export function isUnlockFailure(e: unknown): e is SheetLockError {
  return e instanceof SheetLockError;
}
