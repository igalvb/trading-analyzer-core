/**
 * FL-18a: Sheets cleanup phase 4a (docs/SHEETS_CLEANUP_PLAN.md). The bulk price read skips the '💾 Macro *',
 * data-store and '💾 Migration' tabs; `trim-macro-tabs` shrinks the Macro tabs 26 -> 5 columns, dry run
 * unless --yes, and never touches a row, so the 10-year macro history stays as it is.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { sheets_v4 } from 'googleapis';
import { BulkPriceHistoryStore, isBulkPriceTab } from '../src/storage/bulkPriceHistory.ts';
import { SheetPriceHistoryStore, type PriceSheetsApi } from '../src/storage/priceHistory.ts';
import { planTrim, runTrimPriceTabs, columnLetter, MACRO_TRIM, MACRO_TAB_COLUMNS, type TrimSheets } from '../src/trimPriceTabs.ts';
import { MACRO_PRICE_HEADER } from '../src/storage/macroCaches.ts';
import type { TabGrid, ValueRangeUpdate } from '../src/sheets/client.ts';
import type { SheetRow } from '../src/sheets/coerce.ts';
import type { FetchedChart } from '../src/types/chart.ts';
import { createContext } from '../src/core/context.ts';
import { LogLevel } from '../src/core/logger.ts';

const TZ = 'America/New_York';
const ctx = () => createContext({ mode: 'test', minLevel: LogLevel.ERROR });
const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const colIndex = (letters: string): number => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);

/** One in-memory spreadsheet behind both seams (PriceSheetsApi and TrimSheets), with grid sizes. */
class MemSheet implements PriceSheetsApi {
  readonly tabs = new Map<string, { sheetId: number; rows: SheetRow[]; columnCount: number; rowCount: number }>();
  readonly reads: string[] = [];
  readonly formats: sheets_v4.Schema$Request[] = [];
  private next = 1;
  add(title: string, rows: SheetRow[], columnCount = 26, rowCount = Math.max(rows.length, 1000)): void {
    this.tabs.set(title, { sheetId: this.next++, rows: rows.map((r) => [...r]), columnCount, rowCount });
  }
  private parse(range: string): { tab: string; c0: number; c1: number; r0: number } {
    const m = /^'((?:[^']|'')+)'(?:!([A-Z]+)(\d+)?(?::([A-Z]+)\d*)?)?$/.exec(range);
    if (!m) throw new Error('bad range ' + range);
    const tab = m[1]!.replace(/''/g, "'");
    const c0 = m[2] ? colIndex(m[2]) : 1;
    return { tab, c0, c1: m[4] ? colIndex(m[4]) : m[2] ? c0 : 10_000, r0: m[3] ? Number(m[3]) : 1 };
  }
  async tabIds() { return { ok: true as const, value: Object.fromEntries([...this.tabs].map(([t, v]) => [t, v.sheetId])) }; }
  async tabGrids(): Promise<{ ok: true; value: TabGrid[] }> {
    return { ok: true, value: [...this.tabs].map(([title, v]) => ({ title, sheetId: v.sheetId, columnCount: v.columnCount, rowCount: v.rowCount })) };
  }
  async batchGet(_c: unknown, ranges: readonly string[]) {
    this.reads.push(...ranges);
    return { ok: true as const, value: ranges.map((r) => {
      const { tab, c0, c1, r0 } = this.parse(r);
      const t = this.tabs.get(tab);
      if (!t) return [];
      if (c1 > t.columnCount && c1 !== 10_000) throw new Error('range exceeds grid limits: ' + r);
      return t.rows.slice(r0 - 1).map((row) => row.slice(c0 - 1, c1)).filter((row) => row.some((v) => v !== '' && v != null));
    }) };
  }
  async batchUpdate(_c: unknown, updates: readonly ValueRangeUpdate[]) {
    for (const u of updates) {
      const { tab, r0 } = this.parse(u.range);
      const t = this.tabs.get(tab);
      if (!t) throw new Error('no tab ' + tab);
      u.values.forEach((vals, i) => { const row = (t.rows[r0 - 1 + i] ??= []); vals.forEach((v, j) => { row[j] = v; }); });
    }
    return { ok: true as const, value: updates.length };
  }
  async batchClear(_c: unknown, ranges: readonly string[]) { for (const r of ranges) this.tabs.get(this.parse(r).tab)!.rows = []; return { ok: true as const, value: ranges.length }; }
  async formatBatch(_c: unknown, requests: readonly sheets_v4.Schema$Request[]) {
    this.formats.push(...requests);
    for (const r of requests) {
      if (r.addSheet) this.add(String(r.addSheet.properties?.title), [], 6);
      const p = r.updateSheetProperties?.properties;
      if (p?.gridProperties?.columnCount != null) {
        const t = [...this.tabs.values()].find((v) => v.sheetId === p.sheetId)!;
        if (t.rows.some((row) => row.slice(p.gridProperties!.columnCount!).some((v) => v !== '' && v != null))) throw new Error('would drop data');
        t.columnCount = p.gridProperties.columnCount;
      }
    }
    return { ok: true as const, value: requests.length };
  }
}

/** A 10-year '💾 Macro <T>' tab as storage/macroCaches.ts writes it (header + one row per day, A:E). */
function macroRows(days = 2514): SheetRow[] {
  const rows: SheetRow[] = [[...MACRO_PRICE_HEADER]];
  for (let i = 0; i < days; i++) rows.push([40000 + i, 101 + i, 99 + i, 100 + i, 1_000_000 + i]);
  return rows;
}

function chart(ticker: string, days: number): FetchedChart {
  const start = Date.UTC(2026, 0, 5, 21);
  const dates: Date[] = [], opens: number[] = [], highs: number[] = [], lows: number[] = [], closes: number[] = [], volumes: number[] = [];
  for (let i = 0; i < days; i++) { dates.push(new Date(start + i * 86_400_000)); opens.push(100 + i); highs.push(102 + i); lows.push(98 + i); closes.push(101 + i); volumes.push(1000 + i); }
  return { ticker, dates, opens, highs, lows, closes, volumes, currentPrice: 100 + days, currency: 'USD', ipoDate: null, splits: [] } as unknown as FetchedChart;
}

const NON_PRICE = ['💾 Macro SPY', '💾 Macro IYT', '💾 Macro Snapshot', '💾 13F Cache', '💾 Broker Data Cache', '💾 RS Ranking',
  '💾 Script Properties', '💾 Fundamentals History', '💾 Fundamentals Series', '💾 Migration'];

describe('FL-18a — the bulk price read skips Macro, cache and marker tabs', () => {
  test('isBulkPriceTab: price tabs yes; Macro, data-store, marker and non-💾 tabs no', () => {
    for (const t of ['💾 TSLA', '💾 ^VIX', '💾 BTC-USD', '💾 SPY', '💾 BRK.B']) assert.equal(isBulkPriceTab(t), true, t);
    for (const t of [...NON_PRICE, 'Portfolio', '🔬 Log']) assert.equal(isBulkPriceTab(t), false, t);
  });

  test('load reads only the price tabs; reads still work; a flush leaves the Macro history untouched', async () => {
    const sheet = new MemSheet();
    const seed = new SheetPriceHistoryStore(ctx(), sheet, TZ);
    sheet.add('💾 TSLA', [], 6);
    sheet.add('💾 SPY', [], 6);
    await seed.write('TSLA', chart('TSLA', 20));
    await seed.write('SPY', chart('SPY', 20));
    for (const t of NON_PRICE) sheet.add(t, t.startsWith('💾 Macro ') && t !== '💾 Macro Snapshot' ? macroRows(50) : [['Key', 'Value']]);
    const macroBefore = structuredClone(sheet.tabs.get('💾 Macro SPY')!.rows);
    sheet.reads.length = 0;

    const bulk = new BulkPriceHistoryStore(ctx(), sheet, TZ);
    assert.equal((await bulk.read('TSLA'))?.closes.length, 20);
    assert.deepEqual(sheet.reads.map((r) => r.replace(/!.*$/, '')).sort(), ["'💾 SPY'", "'💾 TSLA'"]);
    await bulk.write('SPY', chart('SPY', 25));
    await bulk.flush();
    assert.equal((await new SheetPriceHistoryStore(ctx(), sheet, TZ).read('SPY'))?.closes.length, 25);
    assert.deepEqual(sheet.tabs.get('💾 Macro SPY')!.rows, macroBefore);
  });
});

describe('FL-18a — planTrim with MACRO_TRIM', () => {
  const g = (title: string, sheetId: number, columnCount = 26, rowCount = 2515): TabGrid => ({ title, sheetId, columnCount, rowCount });
  test('only header-checked Macro tabs with nothing after E; the Snapshot and price tabs are never candidates', () => {
    const grids = [g('💾 Macro SPY', 1), g('💾 Macro TLT', 2), g('💾 Macro GLD', 3), g('💾 Macro Snapshot', 4), g('💾 TSLA', 5), g('💾 Macro IYT', 6, 5)];
    const head = new Map<string, SheetRow[]>([['💾 Macro SPY', [[...MACRO_PRICE_HEADER]]], ['💾 Macro TLT', [[...MACRO_PRICE_HEADER]]], ['💾 Macro GLD', [['Date', 'Open']]]]);
    const beyond = new Map<string, SheetRow[]>([['💾 Macro SPY', []], ['💾 Macro TLT', [[''], ['note']]], ['💾 Macro GLD', []]]);
    const p = planTrim(grids, head, beyond, MACRO_TRIM);
    assert.deepEqual(p.trim.map((t) => t.title), ['💾 Macro SPY']);
    assert.deepEqual(p.kept, [{ title: '💾 Macro TLT', reason: 'has data after column E' }, { title: '💾 Macro GLD', reason: 'not a Macro price tab' }]);
    assert.equal(p.cellsFreed, 2515 * (26 - MACRO_TAB_COLUMNS));
  });
  test('columnLetter', () => {
    assert.deepEqual([1, 5, 6, 26, 27, 30, 52, 53].map(columnLetter), ['A', 'E', 'F', 'Z', 'AA', 'AD', 'AZ', 'BA']);
  });
});

describe('FL-18a — npm run trim-macro-tabs', () => {
  const env = { GOOGLE_SERVICE_ACCOUNT_JSON: '{}', SPREADSHEET_ID: 'x' };
  const MACRO = ['SPY', 'TLT', 'GLD', 'XLP', 'XLU', 'XLV', 'XLY', 'XLI', 'XLB', 'DIA', 'IYT'].map((t) => '💾 Macro ' + t);
  function book(): MemSheet {
    const s = new MemSheet();
    for (const t of MACRO) s.add(t, macroRows(), 26, 2515);
    s.add('💾 Macro Snapshot', [['Date', 'DGS10 (JSON)', 'FEDFUNDS (JSON)', 'GDPC1 (JSON)'], [46000, '[1]', '[2]', '[3]']], 26, 1000);
    s.add('💾 TSLA', [['META', '{}'], ['Date', 'Open', 'High', 'Low', 'Close', 'Volume']], 26, 1000);
    s.add('Portfolio', [['x']], 26, 1000);
    return s;
  }
  const run = (s: MemSheet, argv: string[], out: string[] = []) =>
    runTrimPriceTabs({ env, argv, out: (l) => out.push(l), errOut: (l) => out.push('ERR ' + l), makeSheets: () => s as unknown as TrimSheets, ctx: ctx() });

  test('the npm script is registered and passes --macro', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(BACKEND, 'package.json'), 'utf8'));
    assert.match(pkg.scripts['trim-macro-tabs'], /src\/trimPriceTabs\.ts --macro$/);
  });

  test('dry run: lists the 11 tabs and the cells, changes nothing', async () => {
    const s = book();
    const before = structuredClone([...s.tabs]);
    const out: string[] = [];
    assert.equal(await run(s, ['--macro'], out), 0);
    const text = out.join('\n');
    assert.match(text, /^Trim Macro tabs: 11 tab\(s\) to shrink to 5 columns, 0 '💾 Macro' tab\(s\) left as they are; frees 580965 of /);
    assert.equal(out.filter((l) => l.startsWith('  shrink: ')).length, 11);
    assert.match(text, /shrink: 💾 Macro SPY \(all 2515 rows kept; columns 26 -> 5\)/);
    assert.match(text, /Dry run: nothing changed/);
    assert.deepEqual(s.formats, []);
    assert.deepEqual([...s.tabs], before);
  });

  test('--yes: only the column count of the 11 Macro tabs changes; every row of the 10-year history is kept', async () => {
    const s = book();
    const rowsBefore = new Map(MACRO.map((t) => [t, structuredClone(s.tabs.get(t)!.rows)]));
    assert.equal(await run(s, ['--macro', '--yes']), 0);
    assert.equal(s.formats.length, 11);
    for (const f of s.formats) assert.deepEqual(Object.keys(f), ['updateSheetProperties']);
    for (const f of s.formats) assert.equal(f.updateSheetProperties?.fields, 'gridProperties.columnCount');
    for (const t of MACRO) {
      const tab = s.tabs.get(t)!;
      assert.equal(tab.columnCount, 5, t);
      assert.equal(tab.rowCount, 2515, t);
      assert.deepEqual(tab.rows, rowsBefore.get(t), t);
    }
    assert.equal(s.tabs.get('💾 Macro Snapshot')!.columnCount, 26);
    assert.equal(s.tabs.get('💾 TSLA')!.columnCount, 26);
    assert.equal(s.tabs.get('Portfolio')!.columnCount, 26);
    // Run again: nothing left to do.
    const out: string[] = [];
    assert.equal(await run(s, ['--macro', '--yes'], out), 0);
    assert.match(out[0]!, /^Trim Macro tabs: 0 tab\(s\) to shrink/);
  });

  test('data after column E, even past Z, or a wrong header keeps the tab; the check reads to the real last column', async () => {
    const s = book();
    const spy = s.tabs.get('💾 Macro SPY')!;
    spy.columnCount = 30;
    spy.rows[100]![28] = 'hand note in AC';
    s.tabs.get('💾 Macro TLT')!.rows[0]![1] = 'Open';
    const out: string[] = [];
    assert.equal(await run(s, ['--macro', '--yes'], out), 0);
    assert.ok(s.reads.includes("'💾 Macro SPY'!F1:AD"));
    assert.ok(out.includes('  kept: 💾 Macro SPY (has data after column E)'));
    assert.ok(out.includes('  kept: 💾 Macro TLT (not a Macro price tab)'));
    assert.equal(spy.columnCount, 30);
    assert.equal(s.tabs.get('💾 Macro TLT')!.columnCount, 26);
    assert.equal(s.formats.length, 9);
  });

  test('without --macro the price trim is unchanged: Macro tabs are never shrunk to 6', async () => {
    const s = book();
    const out: string[] = [];
    assert.equal(await run(s, ['--yes'], out), 0);
    assert.match(out[0]!, /^Trim price tabs: 1 tab\(s\) to shrink to 6 columns, 12 '💾' tab\(s\) left as they are/);
    for (const t of MACRO) assert.equal(s.tabs.get(t)!.columnCount, 26);
    assert.equal(s.tabs.get('💾 TSLA')!.columnCount, 6);
  });
});
