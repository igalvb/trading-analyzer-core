/**
 * FL-11e: BulkPriceHistoryStore (F-B7-11). Same cells as SheetPriceHistoryStore, far fewer Sheets calls:
 * every saved price tab read at the start, every change written at the end.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { sheets_v4 } from 'googleapis';
import { BulkPriceHistoryStore } from '../src/storage/bulkPriceHistory.ts';
import { SheetPriceHistoryStore, type PriceSheetsApi } from '../src/storage/priceHistory.ts';
import type { FetchedChart } from '../src/types/chart.ts';
import type { SheetRow } from '../src/sheets/coerce.ts';
import type { ValueRangeUpdate } from '../src/sheets/client.ts';
import { createContext } from '../src/core/context.ts';
import { LogLevel } from '../src/core/logger.ts';

const TZ = 'America/New_York';
const ctx = () => createContext({ mode: 'test', minLevel: LogLevel.ERROR });

/** An in-memory spreadsheet behind the PriceSheetsApi seam, counting calls by kind. */
class FakeSheet implements PriceSheetsApi {
  readonly grids = new Map<string, SheetRow[]>();
  readonly ids = new Map<string, number>();
  readonly calls: string[] = [];
  private next = 1;
  addTab(title: string, rows: SheetRow[] = []): void { this.ids.set(title, this.next++); this.grids.set(title, rows.map((r) => [...r])); }
  private parse(range: string): { tab: string; row: number } {
    const m = /^'((?:[^']|'')+)'(?:!([A-Z]+)(\d+)?(?::[A-Z]+\d*)?)?$/.exec(range);
    if (!m) throw new Error('bad range ' + range);
    return { tab: m[1]!.replace(/''/g, "'"), row: m[3] ? Number(m[3]) : 1 };
  }
  async tabIds() { this.calls.push('tabIds'); return { ok: true as const, value: Object.fromEntries(this.ids) }; }
  async batchGet(_c: unknown, ranges: readonly string[]) {
    this.calls.push('batchGet');
    return { ok: true as const, value: ranges.map((r) => {
      const g = this.grids.get(this.parse(r).tab) ?? [];
      let last = g.length; while (last > 0 && !(g[last - 1] ?? []).some((v) => v !== '' && v != null)) last--;
      return g.slice(0, last).map((row) => row.slice(0, 6));
    }) };
  }
  async batchUpdate(_c: unknown, updates: readonly ValueRangeUpdate[]) {
    this.calls.push('batchUpdate');
    for (const u of updates) {
      const { tab, row } = this.parse(u.range);
      const g = this.grids.get(tab);
      if (!g) throw new Error('no tab ' + tab);
      u.values.forEach((vals, i) => { const r = (g[row - 1 + i] ??= []); vals.forEach((v, j) => { r[j] = v; }); });
    }
    return { ok: true as const, value: updates.length };
  }
  async batchClear(_c: unknown, ranges: readonly string[]) { this.calls.push('batchClear'); for (const r of ranges) this.grids.set(this.parse(r).tab, []); return { ok: true as const, value: ranges.length }; }
  async formatBatch(_c: unknown, requests: readonly sheets_v4.Schema$Request[]) {
    this.calls.push('formatBatch');
    for (const r of requests) if (r.addSheet) this.addTab(String(r.addSheet.properties?.title));
    return { ok: true as const, value: requests.length };
  }
}

function chart(ticker: string, days: number, start = Date.UTC(2026, 0, 5, 21)): FetchedChart {
  const dates: Date[] = [], opens: number[] = [], highs: number[] = [], lows: number[] = [], closes: number[] = [], volumes: number[] = [];
  for (let i = 0; i < days; i++) {
    dates.push(new Date(start + i * 86_400_000));
    const p = 100 + i;
    opens.push(p); highs.push(p + 2); lows.push(p - 2); closes.push(p + 1); volumes.push(1000 + i);
  }
  return { ticker, dates, opens, highs, lows, closes, volumes, currentPrice: 100 + days, currency: 'USD', ipoDate: null, splits: [] } as unknown as FetchedChart;
}

const same = (a: FetchedChart | null, b: FetchedChart | null): void => {
  assert.ok(a && b);
  assert.deepEqual(a!.dates.map((d) => d.getTime()), b!.dates.map((d) => d.getTime()));
  assert.deepEqual([a!.opens, a!.highs, a!.lows, a!.closes, a!.volumes], [b!.opens, b!.highs, b!.lows, b!.closes, b!.volumes]);
};

describe('FL-11e — BulkPriceHistoryStore', () => {
  test('reads the same data the per-ticker store wrote, with 1 + ceil(n/40) calls for n tabs', async () => {
    const sheet = new FakeSheet();
    const old = new SheetPriceHistoryStore(ctx(), sheet, TZ);
    const tickers = Array.from({ length: 85 }, (_, i) => 'T' + i);
    for (const t of tickers) await old.write(t, chart(t, 30));
    sheet.addTab('💾 13F Cache', [['not', 'a', 'price', 'tab']]);
    sheet.calls.length = 0;
    const bulk = new BulkPriceHistoryStore(ctx(), sheet, TZ);
    for (const t of tickers) same(await bulk.read(t), chart(t, 30));
    assert.equal(await bulk.read('NOPE'), null);
    assert.deepEqual(sheet.calls, ['tabIds', 'batchGet', 'batchGet', 'batchGet'], '86 price-prefixed tabs = 3 reads of 40');
  });

  test('writes and appends wait for flush; a read in the same run sees them; flush writes cells the per-ticker store reads back', async () => {
    const sheet = new FakeSheet();
    const old = new SheetPriceHistoryStore(ctx(), sheet, TZ);
    await old.write('AAA', chart('AAA', 30));
    sheet.calls.length = 0;
    const bulk = new BulkPriceHistoryStore(ctx(), sheet, TZ);
    await bulk.read('AAA');
    const callsAfterLoad = sheet.calls.length;
    await bulk.append('AAA', chart('AAA', 32), 2);
    await bulk.write('NEW', chart('NEW', 20));
    assert.equal(sheet.calls.length, callsAfterLoad, 'no call before flush');
    same(await bulk.read('AAA'), chart('AAA', 32));
    assert.equal(bulk.pendingCount(), 2);
    await bulk.flush();
    assert.equal(bulk.pendingCount(), 0);
    assert.deepEqual(sheet.calls.slice(callsAfterLoad), ['tabIds', 'formatBatch', 'tabIds', 'batchUpdate', 'formatBatch'], 'add the new tab, one values call, one format call');
    const reader = new SheetPriceHistoryStore(ctx(), sheet, TZ);
    same(await reader.read('AAA'), chart('AAA', 32));
    same(await reader.read('NEW'), chart('NEW', 20));
  });

  test('a shorter rewrite blanks the old extra rows', async () => {
    const sheet = new FakeSheet();
    await new SheetPriceHistoryStore(ctx(), sheet, TZ).write('BBB', chart('BBB', 40));
    const bulk = new BulkPriceHistoryStore(ctx(), sheet, TZ);
    await bulk.read('BBB');
    await bulk.write('BBB', chart('BBB', 25, Date.UTC(2026, 2, 2, 21)));
    await bulk.flush();
    same(await new SheetPriceHistoryStore(ctx(), sheet, TZ).read('BBB'), chart('BBB', 25, Date.UTC(2026, 2, 2, 21)));
  });

  test('flush with nothing changed makes no call', async () => {
    const sheet = new FakeSheet();
    const bulk = new BulkPriceHistoryStore(ctx(), sheet, TZ);
    await bulk.flush();
    assert.deepEqual(sheet.calls, []);
  });
});
