/**
 * writeDarkPoolTrackerSheetV1_ (darkPoolTrackerV1.gs:239-272) and the tab
 * name DARK_POOL_TRACKER_SHEET_NAME_V1 (:237).
 *
 * Values go in ONE write (the whole grid, blank rows included); formatting
 * goes to the TabFormatter as one op per legacy formatting call, in legacy's
 * order. Values are written RAW, so '12.3%' stays the text legacy built
 * (Sheets' USER_ENTERED would have turned it into the number 0.123 shown as
 * a percentage -- same display, F-58).
 *
 * The header's timestamp is Date#toLocaleString() as Apps Script printed it:
 * en-US in the script's zone.
 */

import type { TabStore, TabCell } from '../../storage/tabStore.ts';
import type { CellRange, FormatOp, TabFormatter } from '../formatOps.ts';
import { DARK_POOL_ELEVATED_THRESHOLD_PCT, type DarkPoolReport } from '../../analysis/darkPool.ts';

/** An existing legacy tab (not new). */
export const DARK_POOL_TRACKER_TAB = '🌊 Dark Pool Tracker';
export const DARK_POOL_TRACKER_WIDTH = 4;

export interface SheetLayout {
  readonly grid: TabCell[][];
  readonly ops: FormatOp[];
}

const rowRange = (row: number): CellRange => ({ row, col: 1, numRows: 1, numCols: 4 });

/** The cells and formatting legacy produced, without touching a sheet. */
export function darkPoolTrackerLayout(report: DarkPoolReport, timeZone: string): SheetLayout {
  const rows = new Map<number, TabCell[]>();
  const ops: FormatOp[] = [{ op: 'tabColor', color: '#01579b' }];
  let row = 1;
  const title = '🌊 Dark Pool Tracker — updated ' + report.generatedAt.toLocaleString('en-US', { timeZone }) +
    '  ·  FINRA OTC Transparency ATS data — Tier1 week ' + (report.t1Week || 'n/a') +
    ', Tier2 week ' + (report.t2Week || 'n/a') +
    '  ·  flagged = dark-pool share > ' + (DARK_POOL_ELEVATED_THRESHOLD_PCT * 100).toFixed(0) + '% (reasoned default, not backtested)';
  ops.push({ op: 'merge', range: rowRange(row) });
  rows.set(row, [title, '', '', '']);
  ops.push(
    { op: 'fontWeight', range: rowRange(row), value: 'bold' }, { op: 'fontSize', range: rowRange(row), value: 11 },
    { op: 'background', range: rowRange(row), value: '#01579b' }, { op: 'fontColor', range: rowRange(row), value: '#fff' },
    { op: 'wrap', range: rowRange(row), value: true },
  );
  row += 2;

  report.categories.forEach((cat) => {
    ops.push({ op: 'merge', range: rowRange(row) });
    rows.set(row, [cat.category, '', '', '']);
    ops.push({ op: 'fontWeight', range: rowRange(row), value: 'bold' }, { op: 'background', range: rowRange(row), value: '#e1f5fe' });
    row++;
    rows.set(row, ['Ticker', 'Dark Pool Vol (shares)', 'Price', 'Dark Pool %']);
    ops.push({ op: 'fontWeight', range: rowRange(row), value: 'bold' }, { op: 'background', range: rowRange(row), value: '#f5f5f5' });
    row++;
    cat.rows.forEach((r) => {
      const pctDisplay = r.darkPoolSharePct != null ? (r.darkPoolSharePct * 100).toFixed(1) + '%' : 'n/a';
      const volDisplay = r.atsShareVolume != null ? r.atsShareVolume : 'n/a';
      const priceDisplay = r.price != null ? r.price : 'n/a';
      rows.set(row, [r.ticker, volDisplay, priceDisplay, pctDisplay]);
      if (r.elevated) {
        ops.push(
          { op: 'background', range: rowRange(row), value: '#ffcdd2' }, { op: 'fontColor', range: rowRange(row), value: '#b71c1c' },
          { op: 'fontWeight', range: rowRange(row), value: 'bold' },
        );
      }
      row++;
    });
    row++;
  });

  ops.push({ op: 'columnWidths', start: 1, count: 4, width: 150 }, { op: 'frozenRows', count: 1 });
  const last = Math.max(...rows.keys());
  const grid: TabCell[][] = [];
  for (let r = 1; r <= last; r++) grid.push(rows.get(r) ?? ['', '', '', '']);
  return { grid, ops };
}

export interface DarkPoolSheetDeps {
  readonly store: TabStore;
  /** Absent: values only (no formatting). Production: SheetTabFormatter. */
  readonly formatter?: TabFormatter;
  /** The script's zone, for the header timestamp. */
  readonly timeZone: string;
}

/** writeDarkPoolTrackerSheetV1_: create the tab, or clear its values and formats; then rewrite it. */
export async function writeDarkPoolTrackerSheet(deps: DarkPoolSheetDeps, report: DarkPoolReport): Promise<void> {
  const created = await deps.store.ensure(DARK_POOL_TRACKER_TAB);
  if (!created) await deps.store.clear(DARK_POOL_TRACKER_TAB);
  const { grid, ops } = darkPoolTrackerLayout(report, deps.timeZone);
  await deps.store.write(DARK_POOL_TRACKER_TAB, 1, grid);
  if (deps.formatter) await deps.formatter.apply(DARK_POOL_TRACKER_TAB, created ? ops : [{ op: 'clearFormats' }, ...ops]);
}
