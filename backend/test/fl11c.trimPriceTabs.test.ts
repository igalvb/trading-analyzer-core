/** FL-11c: trim-price-tabs (F-B7-10). Only certain price-history tabs, only when columns G onward are empty; dry run by default. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planTrim, runTrimPriceTabs, PRICE_TAB_COLUMNS, type TrimSheets } from '../src/trimPriceTabs.ts';
import type { TabGrid } from '../src/sheets/client.ts';
import type { SheetRow } from '../src/sheets/coerce.ts';
import { createContext } from '../src/core/context.ts';
import { LogLevel } from '../src/core/logger.ts';

const HEAD: SheetRow[] = [['META', '{"v":1}'], ['Date', 'Open', 'High', 'Low', 'Close', 'Volume']];
const g = (title: string, sheetId: number, columnCount = 26, rowCount = 1000): TabGrid => ({ title, sheetId, columnCount, rowCount });

describe('FL-11c — planTrim', () => {
  test('a price tab with nothing after F is trimmed; everything else is left alone with a reason', () => {
    const grids = [g('💾 TSLA', 1), g('💾 MQZC', 2), g('💾 13F Cache', 3), g('💾 IBIT', 4, 6), g('Portfolio', 5), g('💾 NVDA', 6)];
    const head = new Map<string, SheetRow[]>([['💾 TSLA', HEAD], ['💾 MQZC', HEAD], ['💾 13F Cache', [['CUSIP', 'x']]], ['💾 NVDA', HEAD]]);
    const beyond = new Map<string, SheetRow[]>([['💾 TSLA', []], ['💾 MQZC', [[''], ['', 'note']]], ['💾 13F Cache', []], ['💾 NVDA', [['', '']]]]);
    const p = planTrim(grids, head, beyond);
    assert.deepEqual(p.trim.map((t) => t.title), ['💾 TSLA', '💾 NVDA']);
    assert.deepEqual(p.kept, [{ title: '💾 MQZC', reason: 'has data after column F' }, { title: '💾 13F Cache', reason: 'not a price-history tab' }]);
    assert.equal(p.cellsFreed, 2 * 1000 * (26 - PRICE_TAB_COLUMNS));
  });
});

describe('FL-11c — runTrimPriceTabs', () => {
  const env = { GOOGLE_SERVICE_ACCOUNT_JSON: '{}', SPREADSHEET_ID: 'x' };
  const ctx = createContext({ mode: 'test', minLevel: LogLevel.ERROR });
  function fake() {
    const sent: unknown[] = [];
    const sheets = {
      tabGrids: async () => ({ ok: true, value: [g('💾 TSLA', 1), g('💾 Macro SPY', 2, 26, 2514)] }),
      batchGet: async (_c: unknown, ranges: readonly string[]) => ({ ok: true, value: ranges.map((r) => (r.includes('A1:F2') ? (r.includes('Macro') ? [['Date']] : HEAD) : [])) }),
      formatBatch: async (_c: unknown, reqs: unknown[]) => { sent.push(...reqs); return { ok: true, value: reqs.length }; },
    } as unknown as TrimSheets;
    return { sheets, sent };
  }
  test('dry run by default: nothing is sent', async () => {
    const { sheets, sent } = fake();
    const out: string[] = [];
    assert.equal(await runTrimPriceTabs({ env, argv: [], out: (l) => out.push(l), errOut: () => {}, makeSheets: () => sheets, ctx }), 0);
    assert.deepEqual(sent, []);
    assert.match(out.join('\n'), /1 tab\(s\) to shrink/);
    assert.match(out.join('\n'), /Dry run/);
  });
  test('--yes: one request per trimmed tab, columnCount only', async () => {
    const { sheets, sent } = fake();
    assert.equal(await runTrimPriceTabs({ env, argv: ['--yes'], out: () => {}, errOut: () => {}, makeSheets: () => sheets, ctx }), 0);
    assert.deepEqual(sent, [{ updateSheetProperties: { properties: { sheetId: 1, gridProperties: { columnCount: 6 } }, fields: 'gridProperties.columnCount' } }]);
  });
  test('missing configuration: exit 2, names only', async () => {
    const err: string[] = [];
    assert.equal(await runTrimPriceTabs({ env: {}, argv: [], out: () => {}, errOut: (l) => err.push(l) }), 2);
    assert.match(err[0] as string, /GOOGLE_SERVICE_ACCOUNT_JSON, SPREADSHEET_ID/);
  });
});
