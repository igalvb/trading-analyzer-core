/**
 * F-B7-11: the saved price tabs ('💾 <TICKER>'), read in bulk and written in bulk.
 *
 * SheetPriceHistoryStore makes 1 read and 2 to 4 writes per ticker, one ticker at a time. The first real
 * nightly (2026-10-27) touched about 200 tickers across the dark-pool, ranking, macro and analysis steps,
 * so those calls, queued behind the Sheets limit of about 50 a minute, set the run time (1 h 35 min).
 * The client's own rule (sheets/client.ts) is READ EVERYTHING AT THE START, ACCUMULATE, FLUSH AT THE END.
 *
 * This store follows it:
 *   - the first read loads every '💾 ' tab's A1:F in chunks (a few calls for ~125 tabs);
 *   - writes and appends are kept in memory (a later read in the same run sees them);
 *   - flush() writes every changed tab back: one call to add missing tabs, then a few value and format calls.
 * The saved tabs are a cache: if a run dies before flush(), the next run fetches the prices again.
 * The cells written are the same as SheetPriceHistoryStore.write (META row, header, one row per bar).
 * If the bulk load fails, reads fall back to the per-ticker store.
 *
 * Sheets cleanup phase 4a: the '💾 ' prefix also names the 11 '💾 Macro <TICKER>' tabs (about 2,500 rows each),
 * the data-store tabs and the '💾 Migration' marker. None of them is a price tab, so the bulk read skips them
 * (isBulkPriceTab). It never wrote them; now it no longer reads them either.
 */

import type { sheets_v4 } from 'googleapis';
import type { RunContext } from '../core/context.ts';
import type { StepError } from '../core/result.ts';
import type { FetchedChart } from '../types/chart.ts';
import type { SheetRow } from '../sheets/coerce.ts';
import type { ValueRangeUpdate } from '../sheets/client.ts';
import { MIGRATION_MARKER_TAB, PRICE_HISTORY_PREFIX, Tabs, a1, priceHistoryTab } from '../sheets/tabs.ts';
import { MACRO_PRICE_TAB_PREFIX } from './macroCaches.ts';
import { RS_RANKING_TAB } from './rsRankingTab.ts';
import { FUNDAMENTALS_SERIES_TAB } from './fundamentalsSeriesTab.ts';
import {
  SheetPriceHistoryStore, decodePriceHistory, encodePriceMeta, dateToSheetsSerial, sheetsSerialToDate,
  pad6, dateFormatRequest, headerFormatRequest, PRICE_HISTORY_HEADER,
  type PriceHistoryStore, type PriceSheetsApi,
} from './priceHistory.ts';

/** Ranges per values.batchGet (they travel in the URL). */
const READ_CHUNK = 40;
/** Tabs per values.batchUpdate (each is about 500 rows x 6 cells). */
const WRITE_CHUNK = 25;
/** Requests per formatBatch. */
const FORMAT_CHUNK = 200;

/**
 * The '💾 ' tabs that are not price tabs: the data stores (Tabs registry, RS Ranking, Fundamentals Series) and
 * the migration marker of docs/SHEETS_CLEANUP_PLAN.md (phase 2 writes it; it is skipped here already).
 */
export const NOT_PRICE_TABS: ReadonlySet<string> = new Set<string>([
  ...Object.values(Tabs).filter((t) => t.startsWith(PRICE_HISTORY_PREFIX)),
  RS_RANKING_TAB, FUNDAMENTALS_SERIES_TAB, MIGRATION_MARKER_TAB,
]);

/** True for a saved price tab ('💾 <TICKER>'); false for '💾 Macro *', the data-store tabs and the marker. */
export function isBulkPriceTab(title: string): boolean {
  return title.startsWith(PRICE_HISTORY_PREFIX) && !title.startsWith(MACRO_PRICE_TAB_PREFIX) && !NOT_PRICE_TABS.has(title);
}

export class BulkPriceHistoryStore implements PriceHistoryStore {
  private readonly ctx: RunContext;
  private readonly api: PriceSheetsApi;
  private readonly timeZone: string;
  private readonly onError?: (e: StepError) => void;
  private readonly fallback: SheetPriceHistoryStore;
  /** Tab -> its A1:F rows as read at the start. Null until loaded (or when loading failed). */
  private grids: Map<string, SheetRow[]> | null = null;
  private loading: Promise<boolean> | null = null;
  /** Tab -> the full data to write at flush (a write or an append in this run). */
  private readonly dirty = new Map<string, { ticker: string; data: FetchedChart }>();

  constructor(ctx: RunContext, api: PriceSheetsApi, timeZone: string, onError?: (e: StepError) => void) {
    this.ctx = ctx;
    this.api = api;
    this.timeZone = timeZone;
    this.onError = onError;
    this.fallback = new SheetPriceHistoryStore(ctx, api, timeZone, onError);
  }

  /** Changed tabs not yet written. */
  pendingCount(): number {
    return this.dirty.size;
  }

  private async load(): Promise<boolean> {
    const ids = await this.api.tabIds(this.ctx);
    if (!ids.ok) { this.onError?.(ids.error); return false; }
    const titles = Object.keys(ids.value).filter(isBulkPriceTab);
    const grids = new Map<string, SheetRow[]>();
    for (let i = 0; i < titles.length; i += READ_CHUNK) {
      const chunk = titles.slice(i, i + READ_CHUNK);
      const r = await this.api.batchGet(this.ctx, chunk.map((t) => a1(t, 'A1:F')));
      if (!r.ok) { this.onError?.(r.error); return false; }
      chunk.forEach((t, j) => grids.set(t, r.value[j] ?? []));
    }
    this.grids = grids;
    this.ctx.log.info('Saved price tabs loaded in bulk', { tabs: titles.length, calls: 1 + Math.ceil(titles.length / READ_CHUNK) });
    return true;
  }

  private ready(): Promise<boolean> {
    if (!this.loading) this.loading = this.load();
    return this.loading;
  }

  async read(ticker: string): Promise<FetchedChart | null> {
    const tab = priceHistoryTab(ticker);
    const pending = this.dirty.get(tab);
    if (pending) return pending.data;
    if (!(await this.ready()) || !this.grids) return this.fallback.read(ticker);
    const rows = this.grids.get(tab);
    if (!rows || rows.length < 3) return null;
    const tz = this.timeZone;
    return decodePriceHistory(ticker, (rows[0] ?? [])[1] ?? '', rows.slice(2).map(pad6),
      (v) => (typeof v === 'number' && Number.isFinite(v) ? sheetsSerialToDate(v, tz) : null));
  }

  async write(ticker: string, data: FetchedChart): Promise<void> {
    this.dirty.set(priceHistoryTab(ticker), { ticker, data });
  }

  async append(ticker: string, merged: FetchedChart, _newRowCount: number): Promise<void> {
    this.dirty.set(priceHistoryTab(ticker), { ticker, data: merged });
  }

  /** The cells SheetPriceHistoryStore.write puts on a tab, padded with blank rows to `minRows` (clears a shorter rewrite). */
  rowsFor(data: FetchedChart, minRows: number): SheetRow[] {
    const values: SheetRow[] = [['META', encodePriceMeta(data), '', '', '', ''], [...PRICE_HISTORY_HEADER]];
    for (let i = 0; i < data.dates.length; i++) {
      values.push([dateToSheetsSerial(data.dates[i], this.timeZone), data.opens[i], data.highs[i], data.lows[i], data.closes[i], data.volumes[i]]);
    }
    while (values.length < minRows) values.push(['', '', '', '', '', '']);
    return values;
  }

  /** Writes every changed tab. Failures are reported through onError; the cache simply stays as it was. */
  async flush(): Promise<void> {
    if (this.dirty.size === 0) return;
    const items = [...this.dirty.entries()];
    const first = await this.api.tabIds(this.ctx);
    if (!first.ok) { this.onError?.(first.error); return; }
    let sheetIds: Record<string, number> = first.value;
    const missing = items.map(([tab]) => tab).filter((tab) => !(tab in sheetIds));
    if (missing.length) {
      const added = await this.api.formatBatch(this.ctx, missing.map((title) => ({ addSheet: { properties: { title, gridProperties: { columnCount: PRICE_HISTORY_HEADER.length } } } })));
      if (!added.ok) { this.onError?.(added.error); return; }
      const again = await this.api.tabIds(this.ctx);
      if (!again.ok) { this.onError?.(again.error); return; }
      sheetIds = again.value;
    }
    const updates: ValueRangeUpdate[] = [];
    const formats: sheets_v4.Schema$Request[] = [];
    for (const [tab, { data }] of items) {
      const oldRows = this.grids?.get(tab)?.length ?? 0;
      const values = this.rowsFor(data, oldRows);
      updates.push({ range: a1(tab, `A1:F${values.length}`), values });
      const sheetId = sheetIds[tab];
      if (sheetId !== undefined) formats.push(headerFormatRequest(sheetId), dateFormatRequest(sheetId, 2, data.dates.length + 2));
    }
    let failed = false;
    for (let i = 0; i < updates.length; i += WRITE_CHUNK) {
      const r = await this.api.batchUpdate(this.ctx, updates.slice(i, i + WRITE_CHUNK));
      if (!r.ok) { this.onError?.(r.error); failed = true; }
    }
    for (let i = 0; i < formats.length; i += FORMAT_CHUNK) {
      const r = await this.api.formatBatch(this.ctx, formats.slice(i, i + FORMAT_CHUNK));
      if (!r.ok) this.onError?.(r.error);
    }
    if (!failed) {
      for (const [tab, { data }] of items) this.grids?.set(tab, this.rowsFor(data, 0));
      this.dirty.clear();
    }
    this.ctx.log.info('Saved price tabs written in bulk', { tabs: items.length, added: missing.length, failed });
  }
}
