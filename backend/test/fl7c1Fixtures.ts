/**
 * Shared fixtures for the FL-7c1 tests: the legacy-side adapters that give a
 * ReportWorkbook the Apps Script methods it lacks (autoResizeColumns and the
 * chart API), a FakeSpreadsheet loader, and chart/price-cache data.
 *
 * LegacyChartBuilder is written independently of the port's SpecChartBuilder
 * on purpose, so the two cross-check each other.
 */

import { ReportWorkbook, MemoryWorkbookBackend, type ReportSheet } from '../src/sheets/reportSheet.ts';
import { FakeSpreadsheet } from './gasFakes.ts';
import type { FetchedChart } from '../src/types/chart.ts';

export const NOW = Date.parse('2026-10-23T15:00:00Z');
export const DAY = 86400000;

export type Rows = Record<string, unknown[][]>;

export function openBook(initial: Rows = {}, preload: readonly string[] = ['*']): Promise<ReportWorkbook> {
  return ReportWorkbook.open(new MemoryWorkbookBackend(initial as never), preload);
}

/** The legacy ui object: alert(msg) or alert(title, msg, buttons); records [msg] or [msg, title]. */
export function legacyUi(alerts: unknown[][], yes = true) {
  return {
    alert: (...a: unknown[]) => {
      alerts.push(a.length >= 2 ? [String(a[1]), String(a[0])] : [String(a[0])]);
      return a.length === 3 && a[2] === 'YES_NO' ? (yes ? 'YES' : 'NO') : 'OK';
    },
    ButtonSet: { OK: 'OK', YES_NO: 'YES_NO' },
    Button: { YES: 'YES', NO: 'NO' },
  };
}

/** The port's alert sink, in the same [msg] / [msg, title] shape as legacyUi. */
export const portAlert = (sink: unknown[][]) => (m: string, t?: string): void => { sink.push(t === undefined ? [m] : [m, t]); };

export class LegacyChartBuilder {
  opts: Record<string, unknown> = {};
  ranges: unknown[] = [];
  numHeaders: unknown;
  pos: unknown[] | undefined;
  asLineChart() { return this; }
  addRange(r: { row: number; col: number; numRows: number; numCols: number }) { this.ranges.push({ row: r.row, col: r.col, numRows: r.numRows, numCols: r.numCols }); return this; }
  setNumHeaders(n: unknown) { this.numHeaders = n; return this; }
  setOption(k: string, v: unknown) { this.opts[k] = v; return this; }
  setPosition(...a: unknown[]) { this.pos = a; return this; }
  build() {
    return { type: 'line', ranges: this.ranges, numHeaders: this.numHeaders, options: this.opts, position: this.pos ? { row: this.pos[0], col: this.pos[1], offsetX: this.pos[2], offsetY: this.pos[3] } : null };
  }
}

export type LegacyChartStore = Map<string, unknown[]>;

/** A ReportWorkbook as legacy sees SpreadsheetApp.getActiveSpreadsheet(): plus autoResizeColumns and the chart methods. */
export function legacyBook(book: ReportWorkbook, charts: LegacyChartStore = new Map()): any {
  const deco = (sh: ReportSheet): any => new Proxy(sh, {
    get(t, p) {
      if (p === 'autoResizeColumns') return (s: number, n: number) => { t.calls.push(['autoResizeColumns', s, n]); return t; };
      if (p === 'getCharts') return () => [...(charts.get(t.getName()) ?? [])];
      if (p === 'removeChart') return (c: unknown) => { const l = charts.get(t.getName()) ?? []; const i = l.indexOf(c); if (i >= 0) l.splice(i, 1); };
      if (p === 'newChart') return () => new LegacyChartBuilder();
      if (p === 'insertChart') return (c: unknown) => { charts.set(t.getName(), [...(charts.get(t.getName()) ?? []), c]); };
      const v = Reflect.get(t, p, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return {
    getSheetByName: (n: string) => { const s = book.getSheetByName(n); return s && deco(s); },
    insertSheet: (n: string) => deco(book.insertSheet(n)),
    getSheets: () => book.getSheets().map(deco),
  };
}

/** A FakeSpreadsheet loaded from rows; deleting `failOn` throws, as a Sheets error would. */
export function fakeSpreadsheet(initial: Rows, failOn?: string): FakeSpreadsheet {
  class Failing extends FakeSpreadsheet {
    deleteSheet(s: any): void {
      if (failOn && s.getName() === failOn) throw new Error('boom');
      super.deleteSheet(s);
    }
  }
  const ss = new Failing('raw');
  for (const [name, grid] of Object.entries(initial)) {
    const sheet = ss.insertSheet(name);
    grid.forEach((r, i) => sheet.getRange(i + 1, 1, 1, r.length).setValues([r]));
  }
  return ss;
}

/** A price-cache tab: META row, header row, then one data row per date. */
export const priceTab = (...dates: unknown[]): unknown[][] => [['META', '{}'], ['Date', 'Close'], ...dates.map((d) => [d, 1])];

/** Price-cache tabs around the 90-day cutoff, plus every kind of tab the scan must skip. */
export const staleTabs = (): Rows => ({
  '💾 OLD1': priceTab(new Date(NOW - 400 * DAY), new Date(Date.parse('2026-01-01T00:00:00Z'))),
  '💾 OLD2': priceTab(new Date(Date.parse('2026-07-01T00:00:00Z'))),
  '💾 OLD3': priceTab(new Date(Date.parse('2026-07-01T00:00:00Z'))),
  '💾 EDGE90': priceTab(new Date(NOW - 90 * DAY)),
  '💾 EDGE90P': priceTab(new Date(NOW - 90 * DAY - 1)),
  '💾 FRESH': priceTab(new Date(NOW - 3 * DAY)),
  '💾 Macro FRED': priceTab(new Date(Date.parse('2026-02-01T00:00:00Z'))),
  '💾 SHORT': [['META', '{}'], [new Date(Date.parse('2025-01-01T00:00:00Z')), 1]],
  '💾 TEXT': priceTab('not a date'),
  '💾 BAD': priceTab(new Date(NaN)),
  '💾 Script Properties': [['key', 'value'], ['a', 'b'], ['zzz', 'c']],
  Other: priceTab(new Date(Date.parse('2020-01-01T00:00:00Z'))),
});

/** Daily bars from 2025-01-02. `f(i)` is the close of bar i; high/low are close +/- 1. */
export function bars(n: number, f: (i: number) => number = (i) => 100 + 10 * Math.sin(i / 9) + i * 0.05): FetchedChart {
  const closes = Array.from({ length: n }, (_, i) => f(i));
  return {
    ticker: 'X', dates: closes.map((_, i) => new Date(Date.UTC(2025, 0, 2 + i))), opens: closes, highs: closes.map((c) => c + 1), lows: closes.map((c) => c - 1),
    closes, volumes: closes.map(() => 1000), splits: [], ipoDate: null, currentPrice: closes[n - 1], prevClose: closes[n - 2], currency: 'USD',
  };
}
