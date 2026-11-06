/**
 * Fix 2026-11-06: the weekly-stops Exit report reached 1,139 rows and Sheets refused the write ("exceeds grid limits.
 * Max rows: 1000"), leaving the Exit Report tab empty. A tab written past its grid is grown first (appendDimension).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SheetsWorkbookBackend, type TabChange } from '../src/sheets/reportSheet.ts';
import { createContext } from '../src/core/context.ts';
import { LogLevel } from '../src/core/logger.ts';
import type { PriceSheetsApi } from '../src/storage/priceHistory.ts';

const ctx = () => createContext({ mode: 'test', minLevel: LogLevel.ERROR, backoffBaseMs: 1, backoffMaxMs: 2, sleep: async () => {} });
const ok = <T>(value: T) => ({ ok: true as const, value });

function fakeApi(rowCount: number, withGrids = true) {
  const calls: string[] = [];
  const formats: unknown[][] = [];
  const api: PriceSheetsApi = {
    tabIds: async () => ok({ '📤 Exit Report': 7 }),
    batchGet: async () => ok([]),
    batchUpdate: async (_c, u) => { calls.push('values:' + u.length); return ok(u.length); },
    batchClear: async () => { calls.push('clear'); return ok(1); },
    formatBatch: async (_c, r) => { calls.push('format:' + r.length); formats.push([...r]); return ok(r.length); },
    ...(withGrids ? { tabGrids: async () => { calls.push('grids'); return ok([{ sheetId: 7, title: '📤 Exit Report', rowCount, columnCount: 26 }]); } } : {}),
  };
  return { api, calls, formats };
}

const change = (rows: number): TabChange => ({ cells: Array.from({ length: rows }, (_, i) => ({ row: i + 1, col: 1, value: 'r' + (i + 1) })), ops: [], cleared: true } as unknown as TabChange);

test('a write past the grid grows the tab first, then writes', async () => {
  const f = fakeApi(1000);
  await new SheetsWorkbookBackend(ctx(), f.api, 'America/New_York').applyTabs([['📤 Exit Report', change(1139)]]);
  const i = f.calls.indexOf('grids'), g = f.calls.findIndex((c, k) => k > i && c.startsWith('format:')), v = f.calls.findIndex((c) => c.startsWith('values:'));
  assert.ok(i >= 0 && g > i && v > g, f.calls.join(','));
  assert.deepEqual(f.formats.at(-1), [{ appendDimension: { sheetId: 7, dimension: 'ROWS', length: 339 } }]);
});

test('a write inside the default grid makes no extra call', async () => {
  const f = fakeApi(1000);
  await new SheetsWorkbookBackend(ctx(), f.api, 'America/New_York').applyTabs([['📤 Exit Report', change(400)]]);
  assert.ok(!f.calls.includes('grids'));
  assert.ok(!f.formats.some((r) => JSON.stringify(r).includes('appendDimension')));
});

test('a tab already big enough is not grown', async () => {
  const f = fakeApi(2000);
  await new SheetsWorkbookBackend(ctx(), f.api, 'America/New_York').applyTabs([['📤 Exit Report', change(1139)]]);
  assert.ok(!f.formats.some((r) => JSON.stringify(r).includes('appendDimension')));
});
