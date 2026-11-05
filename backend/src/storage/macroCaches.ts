/**
 * The three small Sheet caches of the macro / broker-data layer, ported
 * from dataLayerV1.gs onto TabStore:
 *   macroPriceCacheSheetName_ / readMacroPriceCache_ / writeMacroPriceCache_  :1740-1774
 *   readMacroSnapshotV1_ / writeMacroSnapshotV1_                               :1016-1049
 *   readBrokerDataCacheV1_ / writeBrokerDataCacheV1_                           :952-1014
 * with their constants (fullStockAnalysisV10_9.gs:8658-8666,
 * macro_fetchers_v0_15.gs:151). Layouts, header text and every read rule
 * are legacy's, so the tabs legacy already filled read back as they are.
 *
 * Every function swallows store errors exactly where legacy did: reads
 * return null ("not available"), writes are non-fatal.
 *
 * Not changed here (pending a user decision): Tabs.BROKER_DATA_HISTORY is
 * marked "append-only history" by the Phase-1 plan; this ports legacy's
 * one-row-per-ticker upsert unchanged.
 */

import { Tabs } from '../sheets/tabs.ts';
import type { TabStore, TabCell } from './tabStore.ts';

/** macro_fetchers_v0_15.gs:151. */
export const MACRO_PRICE_TAB_PREFIX = '💾 Macro ';
/** fullStockAnalysisV10_9.gs:8666 -- applies to the broker-data AND the macro-snapshot caches. */
export const BROKER_DATA_CACHE_STALE_DAYS = 5;

export const MACRO_PRICE_HEADER: readonly string[] = ['Date', 'High', 'Low', 'Close', 'Volume'];
export const MACRO_SNAPSHOT_HEADER: readonly string[] = ['Date', 'DGS10 (JSON)', 'FEDFUNDS (JSON)', 'GDPC1 (JSON)'];
export const BROKER_DATA_HEADER: readonly string[] = ['Ticker', 'Date', 'ShortInterest', 'DaysToCover', 'SettlementDate', 'InterestCoverageRatio'];

/** A Nasdaq-sourced daily series (parseNasdaqHistoricalResponse_Macro's shape). */
export interface MacroSeries {
  readonly ticker: string;
  readonly dates: Date[];
  readonly closes: number[];
  readonly highs: number[];
  readonly lows: number[];
  readonly volumes: number[];
}

export interface MacroSnapshot {
  readonly date: Date;
  readonly dgs10: number[] | null;
  readonly fedfunds: number[] | null;
  readonly gdpSeries: number[] | null;
}

export interface BrokerDataRecord {
  readonly date: Date;
  readonly shortInterest: number | null;
  readonly daysToCover: number | null;
  readonly settlementDate: string | null;
  readonly interestCoverageRatio: number | null;
}

export interface BrokerDataInput {
  readonly shortInterest: number | null;
  readonly daysToCover: unknown;
  readonly settlementDate: unknown;
  readonly interestCoverageRatio: number | null;
}

const isDate = (v: unknown): v is Date => Object.prototype.toString.call(v) === '[object Date]';

/** macroPriceCacheSheetName_ (dataLayerV1.gs:1740-1743). */
export function macroPriceTab(ticker: string): string {
  const clean = String(ticker).replace(/[[\]*/\\?:]/g, '');
  return (MACRO_PRICE_TAB_PREFIX + clean).slice(0, 100);
}

/** readMacroPriceCache_ (dataLayerV1.gs:1745-1760). Rows whose first cell is not a valid date are skipped. */
export async function readMacroPriceCache(store: TabStore, ticker: string): Promise<MacroSeries | null> {
  try {
    const rows = await store.read(macroPriceTab(ticker), 5, [0]);
    if (!rows) return null;
    if (rows.length < 2) return null;
    const dates: Date[] = [], highs: number[] = [], lows: number[] = [], closes: number[] = [], volumes: number[] = [];
    rows.slice(1).forEach((r) => {
      const d = r[0];
      if (!isDate(d) || isNaN(d.getTime())) return;
      dates.push(d); highs.push(r[1] as number); lows.push(r[2] as number); closes.push(r[3] as number); volumes.push(r[4] as number);
    });
    if (!dates.length) return null;
    return { ticker, dates, closes, highs, lows, volumes };
  } catch {
    return null;
  }
}

/** writeMacroPriceCache_ (dataLayerV1.gs:1762-1774): a full rewrite of the ticker's tab. */
export async function writeMacroPriceCache(store: TabStore, ticker: string, data: MacroSeries): Promise<void> {
  try {
    const name = macroPriceTab(ticker);
    const created = await store.ensure(name);
    if (!created) await store.clear(name);
    await store.write(name, 1, [[...MACRO_PRICE_HEADER]], { header: true });
    const n = data.dates.length;
    const rows: TabCell[][] = new Array(n);
    for (let i = 0; i < n; i++) rows[i] = [data.dates[i], data.highs[i], data.lows[i], data.closes[i], data.volumes[i]];
    await store.write(name, 2, rows, { dateColumns: [0], datePattern: 'yyyy-mm-dd' });
  } catch {
    /* non-fatal -- caching is supplementary */
  }
}

/** readMacroSnapshotV1_ (dataLayerV1.gs:1016-1032): row 2, null when older than 5 days. */
export async function readMacroSnapshot(store: TabStore, nowMs: number): Promise<MacroSnapshot | null> {
  try {
    const rows = await store.read(Tabs.MACRO_SNAPSHOT, 4, [0]);
    if (!rows || rows.length < 2) return null;
    const row = rows[1];
    const date = isDate(row[0]) ? row[0] : new Date(row[0] as string);
    const ageDays = (nowMs - date.getTime()) / 86400000;
    if (ageDays > BROKER_DATA_CACHE_STALE_DAYS) return null;
    return {
      date,
      dgs10: row[1] ? JSON.parse(row[1] as string) : null,
      fedfunds: row[2] ? JSON.parse(row[2] as string) : null,
      gdpSeries: row[3] ? JSON.parse(row[3] as string) : null,
    };
  } catch {
    return null;
  }
}

/** writeMacroSnapshotV1_ (dataLayerV1.gs:1034-1049): the header only when the tab is new; row 2 always. */
export async function writeMacroSnapshot(store: TabStore, now: Date, dgs10: unknown, fedfunds: unknown, gdpSeries: unknown): Promise<void> {
  try {
    const tab = Tabs.MACRO_SNAPSHOT;
    if (await store.ensure(tab)) await store.write(tab, 1, [[...MACRO_SNAPSHOT_HEADER]], { header: true });
    await store.write(tab, 2, [[
      now,
      dgs10 ? JSON.stringify(dgs10) : '',
      fedfunds ? JSON.stringify(fedfunds) : '',
      gdpSeries ? JSON.stringify(gdpSeries) : '',
    ]], { dateColumns: [0] });
  } catch {
    /* non-fatal -- caching is supplementary, must never block a real report */
  }
}

/**
 * readBrokerDataCacheV1_ (dataLayerV1.gs:952-987): the ticker's row (first
 * match, case-insensitive), null when older than 5 days. settlementDate is
 * always returned as a string -- a Date cell is re-stringified as
 * yyyy-mm-dd via toISOString, as legacy does.
 */
export async function readBrokerDataCache(store: TabStore, ticker: string, nowMs: number): Promise<BrokerDataRecord | null> {
  try {
    const rows = await store.read(Tabs.BROKER_DATA_HISTORY, 6, [1, 4]);
    if (!rows) return null;
    if (rows.length < 2) return null;
    const data = rows.slice(1);
    for (let i = 0; i < data.length; i++) {
      if (String(data[i][0]).toUpperCase() === String(ticker).toUpperCase()) {
        const date = isDate(data[i][1]) ? (data[i][1] as Date) : new Date(data[i][1] as string);
        const ageDays = (nowMs - date.getTime()) / 86400000;
        if (ageDays > BROKER_DATA_CACHE_STALE_DAYS) return null;
        const rawSettlement = data[i][4];
        const settlementDate = !rawSettlement ? null : (isDate(rawSettlement) ? rawSettlement.toISOString().slice(0, 10) : String(rawSettlement));
        return {
          date,
          shortInterest: data[i][2] === '' ? null : Number(data[i][2]),
          daysToCover: data[i][3] === '' ? null : Number(data[i][3]),
          settlementDate,
          interestCoverageRatio: data[i][5] === '' ? null : Number(data[i][5]),
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** writeBrokerDataCacheV1_ (dataLayerV1.gs:989-1014): upsert the ticker's row. */
export async function writeBrokerDataCache(store: TabStore, ticker: string, data: BrokerDataInput, now: Date): Promise<void> {
  try {
    const tab = Tabs.BROKER_DATA_HISTORY;
    if (await store.ensure(tab)) await store.write(tab, 1, [[...BROKER_DATA_HEADER]], { header: true });
    const firstCol = (await store.read(tab, 1)) ?? [];
    const lastRow = firstCol.length;
    let targetRow: number | null = null;
    if (lastRow >= 2) {
      for (let i = 1; i < firstCol.length; i++) {
        if (String(firstCol[i][0]).toUpperCase() === String(ticker).toUpperCase()) { targetRow = i + 1; break; }
      }
    }
    if (!targetRow) targetRow = lastRow + 1;
    await store.write(tab, targetRow, [[
      String(ticker).toUpperCase(), now,
      data.shortInterest != null ? data.shortInterest : '',
      data.daysToCover != null ? (data.daysToCover as TabCell) : '',
      (data.settlementDate as TabCell) || '',
      data.interestCoverageRatio != null ? data.interestCoverageRatio : '',
    ]], { dateColumns: [1] });
  } catch {
    /* non-fatal -- caching is supplementary, must never block a real report */
  }
}
