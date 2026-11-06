/**
 * Per-ticker price history tabs ('💾 ' + ticker): read, rewrite, append.
 *
 * Ports fullStockAnalysisV10_9.gs:5991-6084 -- readPriceCacheV7_,
 * isPriceCacheFreshV7_, writePriceCacheV7_, appendPriceCacheV7_ -- onto the
 * same tab layout, so the tabs legacy already filled are read as they are:
 *   row 1   A1 'META', B1 a JSON object (ticker, currentPrice, prevClose,
 *           currency, ipoDate, splits) -- key order kept for byte parity
 *   row 2   Date | Open | High | Low | Close | Volume (bold, #eceff1)
 *   row 3+  one bar per row, column A formatted yyyy-mm-dd
 *
 * Two stores implement the same interface:
 *  - MemoryPriceHistoryStore: a cell grid with Apps Script getLastRow
 *    semantics, used as the parity twin of the legacy sheet in tests.
 *  - SheetPriceHistoryStore: the real tabs through SheetsClient. The Sheets
 *    API returns date cells as serial numbers counted in the SPREADSHEET's
 *    time zone (which is how Apps Script stored legacy's Date cells), so
 *    serials are converted with that zone, never as UTC days.
 *
 * Errors: legacy let a sheet failure throw out of writePriceCacheV7_. Here a
 * failed Sheets call is reported through onError and the store degrades to
 * "no cache" (read) or "not saved" (write/append). The run then refetches
 * next time instead of dying -- a deliberate difference, flagged in FL-1.
 */

import type { sheets_v4 } from 'googleapis';
import type { FetchedChart } from '../types/chart.ts';
import type { RunContext } from '../core/context.ts';
import type { StepResult, StepError } from '../core/result.ts';
import type { SheetRow } from '../sheets/coerce.ts';
import type { ValueRangeUpdate } from '../sheets/client.ts';
import { a1, priceHistoryTab } from '../sheets/tabs.ts';
import { wallClockInTz } from '../core/dates.ts';

export const PRICE_HISTORY_HEADER: readonly string[] = ['Date', 'Open', 'High', 'Low', 'Close', 'Volume'];

const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock minus UTC, in ms, for `timeZone` at the instant `utcMs`. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  let f = offsetFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    offsetFormatters.set(timeZone, f);
  }
  const p = f.formatToParts(new Date(utcMs));
  const g = (t: Intl.DateTimeFormatPartTypes): number => Number((p.find((x) => x.type === t) as Intl.DateTimeFormatPart).value);
  const wall = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return wall - Math.floor(utcMs / 1000) * 1000;
}

/** A Sheets date serial: wall-clock days since 1899-12-30 in the spreadsheet's zone. */
export function dateToSheetsSerial(d: Date, timeZone: string): number {
  const ms = d.getTime();
  return (ms + zoneOffsetMs(ms, timeZone) - SHEETS_EPOCH_MS) / MS_PER_DAY;
}

export function sheetsSerialToDate(serial: number, timeZone: string): Date {
  const wall = Math.round(serial * MS_PER_DAY) + SHEETS_EPOCH_MS;
  let utc = wall - zoneOffsetMs(wall, timeZone);
  utc = wall - zoneOffsetMs(utc, timeZone);
  return new Date(utc);
}

/**
 * The B1 META cell (writePriceCacheV7_ / appendPriceCacheV7_). `savedAt` (P0, 2026-10-30) is appended as the
 * LAST key and only when the chart carries one -- fetchYahooChart sets it only outside legacy-parity mode and only
 * when the last bar is the current New York day's session -- so every legacy META stays byte-identical.
 */
export function encodePriceMeta(data: FetchedChart): string {
  const meta: Record<string, unknown> = {
    ticker: data.ticker, currentPrice: data.currentPrice, prevClose: data.prevClose, currency: data.currency,
    ipoDate: data.ipoDate ? data.ipoDate.toISOString() : null,
    splits: (data.splits || []).map((s) => ({ date: s.date.toISOString(), numerator: s.numerator, denominator: s.denominator })),
  };
  if (typeof data.savedAt === 'number' && Number.isFinite(data.savedAt)) meta.savedAt = new Date(data.savedAt).toISOString();
  return JSON.stringify(meta);
}

/**
 * readPriceCacheV7_'s decoding (fullStockAnalysisV10_9.gs:5996-6013). A
 * broken META makes the whole tab unreadable; a row whose first cell is not
 * a date is skipped; no valid rows at all is "no cache".
 */
export function decodePriceHistory(
  ticker: string,
  metaCell: unknown,
  dataRows: readonly (readonly unknown[])[],
  cellToDate: (v: unknown) => Date | null,
): FetchedChart | null {
  try {
    let meta: any;
    try {
      meta = JSON.parse(metaCell as string);
    } catch {
      return null;
    }
    const dates: Date[] = [];
    const opens: number[] = [];
    const highs: number[] = [];
    const lows: number[] = [];
    const closes: number[] = [];
    const volumes: number[] = [];
    dataRows.forEach((r) => {
      const d = cellToDate(r[0]);
      if (!d) return;
      dates.push(d);
      opens.push(r[1] as number);
      highs.push(r[2] as number);
      lows.push(r[3] as number);
      closes.push(r[4] as number);
      volumes.push(r[5] as number);
    });
    if (!dates.length) return null;
    const savedAt = typeof meta.savedAt === 'string' ? Date.parse(meta.savedAt) : NaN;
    return {
      ...(Number.isFinite(savedAt) ? { savedAt } : {}),
      opens, highs, lows, closes, volumes, dates, ticker: meta.ticker || ticker,
      currentPrice: meta.currentPrice, prevClose: meta.prevClose, currency: meta.currency || 'USD',
      ipoDate: meta.ipoDate ? new Date(meta.ipoDate) : null,
      splits: Array.isArray(meta.splits)
        ? meta.splits.map((s: any) => ({ date: new Date(s.date), numerator: s.numerator, denominator: s.denominator }))
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * isPriceCacheFreshV7_ (fullStockAnalysisV10_9.gs:6020-6030): the last bar's
 * UTC date is today or yesterday. See F-30 for what this means for a run
 * scheduled after the close.
 */
export function isPriceCacheFresh(cached: FetchedChart | null | undefined, now: Date): boolean {
  if (!cached || !cached.dates || !cached.dates.length) return false;
  const lastStr = cached.dates[cached.dates.length - 1].toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86400000);
  return lastStr === now.toISOString().slice(0, 10) || lastStr === yesterday.toISOString().slice(0, 10);
}

/** The exchange's own zone, for the session rule below. */
export const MARKET_TIME_ZONE = 'America/New_York';
const MARKET_CLOSE_MINUTES = 16 * 60;
const MS_PER_CALENDAR_DAY = 86_400_000;

/**
 * The date (yyyy-MM-dd, New York) of the most recent COMPLETED regular
 * NYSE session at `now`: today once it is 16:00 in New York on a weekday,
 * otherwise the previous weekday.
 *
 * Monday-Friday only. No NYSE holiday calendar exists in the repo or the
 * fixtures, so a holiday counts as a session (F-41): on a holiday night the
 * cache looks one session short, the 1mo refresh finds nothing new, and
 * fetchYahooChart falls through to a full 2y refetch -- extra requests, the
 * same data. Early closes (13:00) need no special case: by 16:00 they are
 * over too.
 */
export function lastCompletedSessionDate(now: Date): string {
  const w = wallClockInTz(now.getTime(), MARKET_TIME_ZONE);
  let day = Date.UTC(w.year, w.month - 1, w.day);
  const isWeekday = (ms: number): boolean => {
    const d = new Date(ms).getUTCDay();
    return d >= 1 && d <= 5;
  };
  if (!(isWeekday(day) && w.hour * 60 + w.minute >= MARKET_CLOSE_MINUTES)) {
    do {
      day -= MS_PER_CALENDAR_DAY;
    } while (!isWeekday(day));
  }
  return new Date(day).toISOString().slice(0, 10);
}

/** True when `ms`, read in New York, is at or after 16:00 on the session day `sessionDay` (yyyy-MM-dd), or later. */
function isAtOrAfterClose(ms: number, sessionDay: string): boolean {
  const w = wallClockInTz(ms, MARKET_TIME_ZONE);
  const day = marketDay(ms);
  return day > sessionDay || (day === sessionDay && w.hour * 60 + w.minute >= MARKET_CLOSE_MINUTES);
}

/** The New York calendar date (yyyy-MM-dd) at `ms`. */
export function marketDay(ms: number): string {
  const w = wallClockInTz(ms, MARKET_TIME_ZONE);
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

/**
 * NYSE full-day closures, 2025-2027 (nyse.com holiday calendar, incl. the 2025-01-09 national day of mourning).
 * Used ONLY by isRegularSessionOpen (the P0 live-price rule) so a holiday morning makes no request; the
 * completed-session rule (lastCompletedSessionDate, F-41) still has no holiday calendar. A year missing from this
 * list just has no known holidays: on such a holiday /analyze makes one 1mo request per ticker that finds nothing new.
 */
export const NYSE_HOLIDAYS: ReadonlySet<string> = new Set([
  '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);

const MARKET_OPEN_MINUTES = 9 * 60 + 30;

/**
 * P0 (gap 1, 2026-10-30): the regular NYSE session is open at `now` -- a weekday that is not in NYSE_HOLIDAYS,
 * 09:30 <= New York time < 16:00. Early closes (13:00) are treated as 16:00.
 */
export function isRegularSessionOpen(now: Date): boolean {
  const w = wallClockInTz(now.getTime(), MARKET_TIME_ZONE);
  const wd = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
  if (wd === 0 || wd === 6 || NYSE_HOLIDAYS.has(marketDay(now.getTime()))) return false;
  const m = w.hour * 60 + w.minute;
  return m >= MARKET_OPEN_MINUTES && m < MARKET_CLOSE_MINUTES;
}

/**
 * P0 (2026-10-30): can the cached LAST bar still be an in-progress (partial) session bar?
 *
 * How the save time is known: fetchYahooChart (outside legacy-parity mode) stamps `savedAt` (the run clock, ISO,
 * last key of the META JSON) whenever the bar it saves last is the current New York day's session. A bar
 * timestamp cannot be used (Yahoo stamps daily bars at the session open, Nasdaq at 00:00 UTC) and META had no
 * fetch time before this fix. So:
 *   - last bar dated today (NY): partial unless `savedAt` is at/after today's 16:00 New York close (an older
 *     cache with no `savedAt` counts as partial, so it is refreshed once and stamped);
 *   - last bar dated before today: partial only when `savedAt` says it was saved before that day's 16:00 close
 *     (e.g. a catch-up run at 09:55 saved the open of yesterday's session). A bar with no `savedAt` is final --
 *     every cache written before this fix, and every bar fetched after its own session.
 * Early closes (13:00) are not known: such a bar saved between 13:00 and 16:00 is refreshed once more, harmless.
 */
export function isLastBarPossiblyPartial(cached: FetchedChart | null | undefined, now: Date): boolean {
  if (!cached || !cached.dates || !cached.dates.length) return false;
  const barDay = cached.dates[cached.dates.length - 1].toISOString().slice(0, 10);
  const today = marketDay(now.getTime());
  const savedAt = typeof cached.savedAt === 'number' && Number.isFinite(cached.savedAt) ? cached.savedAt : null;
  if (barDay === today) return savedAt === null || !isAtOrAfterClose(savedAt, barDay);
  if (barDay < today) return savedAt !== null && !isAtOrAfterClose(savedAt, barDay);
  return false;
}

/**
 * F-30, approved fix (2026-10-22): "the last bar is on or after the most recent
 * completed session" (see the live-run note in the body: it is no longer ANDed with legacy's rule).
 * The two differ only on Tuesday-Friday between the 16:00 New York close and
 * 00:00 UTC with the previous day's bar cached -- exactly where the nightly
 * run sits -- and on holiday nights (F-41).
 *
 * The bar's session date is its UTC calendar date -- the same date legacy's
 * own rule reads. Yahoo stamps daily bars 13:30/14:30 UTC and Nasdaq at
 * 00:00 UTC, so the UTC date is the session date for both; the New York
 * date would put a Nasdaq bar on the previous day.
 */
export function isPriceCacheFreshForSession(cached: FetchedChart | null | undefined, now: Date): boolean {
  if (!cached || !cached.dates || !cached.dates.length) return false;
  const last = cached.dates[cached.dates.length - 1];
  // LIVE RUN FINDING (2026-10-25): this used to ALSO require legacy's "today or yesterday" rule, which is blind to
  // weekends: on a Saturday/Sunday/Monday-UTC night Friday's bar (the correct latest bar) read as stale, so the macro
  // regime came back "unavailable". The user's approved F-30 wording is only "last bar >= most recent completed
  // session", so that is now the whole rule. (legacyFreshness still restores legacy's own rule.)
  return last.toISOString().slice(0, 10) >= lastCompletedSessionDate(now);
}

export interface PriceHistoryStore {
  read(ticker: string): Promise<FetchedChart | null>;
  /** Full rewrite of the tab (writePriceCacheV7_). */
  write(ticker: string, data: FetchedChart): Promise<void>;
  /** Refreshes META and appends the last `newRowCount` bars of `merged` (appendPriceCacheV7_). */
  append(ticker: string, merged: FetchedChart, newRowCount: number): Promise<void>;
}

export type PriceCell = string | number | boolean | Date;

export function pad6(r: readonly unknown[] | undefined): unknown[] {
  const out = [...(r ?? [])];
  while (out.length < 6) out.push('');
  return out.slice(0, 6);
}

export function validDateCell(v: unknown): Date | null {
  return Object.prototype.toString.call(v) === '[object Date]' && !Number.isNaN((v as Date).getTime()) ? (v as Date) : null;
}

/** A cell grid per tab, with Apps Script getLastRow semantics. */
export class MemoryPriceHistoryStore implements PriceHistoryStore {
  readonly tabs = new Map<string, PriceCell[][]>();

  private lastRow(grid: PriceCell[][]): number {
    for (let i = grid.length - 1; i >= 0; i--) if ((grid[i] ?? []).some((c) => c !== '' && c != null)) return i + 1;
    return 0;
  }

  /** The tab's used range, six columns wide -- comparable to the legacy sheet's getValues(). */
  snapshot(ticker: string): PriceCell[][] | null {
    const grid = this.tabs.get(priceHistoryTab(ticker));
    if (!grid) return null;
    return grid.slice(0, this.lastRow(grid)).map((r) => pad6(r) as PriceCell[]);
  }

  async read(ticker: string): Promise<FetchedChart | null> {
    const grid = this.tabs.get(priceHistoryTab(ticker));
    if (!grid) return null;
    const lastRow = this.lastRow(grid);
    if (lastRow < 3) return null;
    return decodePriceHistory(ticker, (grid[0] ?? [])[1] ?? '', grid.slice(2, lastRow).map(pad6), validDateCell);
  }

  async write(ticker: string, data: FetchedChart): Promise<void> {
    const grid: PriceCell[][] = [['META', encodePriceMeta(data)], [...PRICE_HISTORY_HEADER]];
    for (let i = 0; i < data.dates.length; i++) {
      grid.push([new Date(data.dates[i].getTime()), data.opens[i], data.highs[i], data.lows[i], data.closes[i], data.volumes[i]]);
    }
    this.tabs.set(priceHistoryTab(ticker), grid);
  }

  async append(ticker: string, merged: FetchedChart, newRowCount: number): Promise<void> {
    const grid = this.tabs.get(priceHistoryTab(ticker));
    if (!grid) {
      await this.write(ticker, merged);
      return;
    }
    grid[0] = ['META', encodePriceMeta(merged)];
    if (newRowCount <= 0) return;
    const total = merged.dates.length;
    const startIdx = total - newRowCount;
    let row = this.lastRow(grid);
    for (let i = 0; i < newRowCount; i++) {
      const j = startIdx + i;
      grid[row++] = [new Date(merged.dates[j].getTime()), merged.opens[j], merged.highs[j], merged.lows[j], merged.closes[j], merged.volumes[j]];
    }
  }
}

/** The SheetsClient operations the Sheets-backed store needs. SheetsClient satisfies it. */
export interface PriceSheetsApi {
  tabIds(ctx: RunContext): Promise<StepResult<Record<string, number>>>;
  batchGet(ctx: RunContext, ranges: readonly string[]): Promise<StepResult<SheetRow[][]>>;
  batchUpdate(ctx: RunContext, updates: readonly ValueRangeUpdate[]): Promise<StepResult<number>>;
  batchClear(ctx: RunContext, ranges: readonly string[]): Promise<StepResult<number>>;
  formatBatch(ctx: RunContext, requests: readonly sheets_v4.Schema$Request[]): Promise<StepResult<number>>;
  /** C3: adds tabs in ONE call and returns their new sheetIds (title -> id) from the reply. Optional (test fakes leave it out). */
  addTabs?(ctx: RunContext, titles: readonly string[]): Promise<StepResult<Record<string, number>>>;
  /** Every tab's grid size (rows, columns). Optional: used only to grow a tab before a write past its grid. */
  tabGrids?(ctx: RunContext): Promise<StepResult<ReadonlyArray<{ readonly sheetId: number; readonly title: string; readonly rowCount: number; readonly columnCount: number }>>>;
}

const HEADER_BACKGROUND = { red: 0xec / 255, green: 0xef / 255, blue: 0xf1 / 255 };

export function dateFormatRequest(sheetId: number, fromRow0: number, toRow0: number): sheets_v4.Schema$Request {
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: fromRow0, endRowIndex: toRow0, startColumnIndex: 0, endColumnIndex: 1 },
      cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } } },
      fields: 'userEnteredFormat.numberFormat',
    },
  };
}

export function headerFormatRequest(sheetId: number): sheets_v4.Schema$Request {
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 6 },
      cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: HEADER_BACKGROUND } },
      fields: 'userEnteredFormat(textFormat,backgroundColor)',
    },
  };
}

/**
 * The real tabs. `timeZone` must be the SPREADSHEET's zone
 * (spreadsheets.get properties.timeZone) -- not the script's, not UTC.
 *
 * getLastRow is replaced by the row count of this run's own read (or a
 * column-A read when there was none); correct while this store is the only
 * writer of the tab during the run.
 */
export class SheetPriceHistoryStore implements PriceHistoryStore {
  private readonly ctx: RunContext;
  private readonly api: PriceSheetsApi;
  private readonly timeZone: string;
  private readonly onError?: (e: StepError) => void;
  private readonly lastRowByTab = new Map<string, number>();

  constructor(ctx: RunContext, api: PriceSheetsApi, timeZone: string, onError?: (e: StepError) => void) {
    this.ctx = ctx;
    this.api = api;
    this.timeZone = timeZone;
    this.onError = onError;
  }

  private fail(r: { readonly ok: false; readonly error: StepError }): void {
    this.onError?.(r.error);
  }

  private row(data: FetchedChart, j: number): SheetRow {
    return [dateToSheetsSerial(data.dates[j], this.timeZone), data.opens[j], data.highs[j], data.lows[j], data.closes[j], data.volumes[j]];
  }

  async read(ticker: string): Promise<FetchedChart | null> {
    const tab = priceHistoryTab(ticker);
    const ids = await this.api.tabIds(this.ctx);
    if (!ids.ok) { this.fail(ids); return null; }
    if (!(tab in ids.value)) return null;
    const res = await this.api.batchGet(this.ctx, [a1(tab, 'A1:F')]);
    if (!res.ok) { this.fail(res); return null; }
    const rows = res.value[0] ?? [];
    this.lastRowByTab.set(tab, rows.length);
    if (rows.length < 3) return null;
    const tz = this.timeZone;
    return decodePriceHistory(ticker, (rows[0] ?? [])[1] ?? '', rows.slice(2).map(pad6),
      (v) => (typeof v === 'number' && Number.isFinite(v) ? sheetsSerialToDate(v, tz) : null));
  }

  async write(ticker: string, data: FetchedChart): Promise<void> {
    const tab = priceHistoryTab(ticker);
    let ids = await this.api.tabIds(this.ctx);
    if (!ids.ok) { this.fail(ids); return; }
    if (tab in ids.value) {
      const cleared = await this.api.batchClear(this.ctx, [a1(tab)]);
      if (!cleared.ok) { this.fail(cleared); return; }
    } else {
      // F-B7-10: the 6 columns written below (A:F), not Google's default 26.
      const added = await this.api.formatBatch(this.ctx, [{ addSheet: { properties: { title: tab, gridProperties: { columnCount: PRICE_HISTORY_HEADER.length } } } }]);
      if (!added.ok) { this.fail(added); return; }
      ids = await this.api.tabIds(this.ctx);
      if (!ids.ok) { this.fail(ids); return; }
    }
    const n = data.dates.length;
    const values: SheetRow[] = [['META', encodePriceMeta(data)], [...PRICE_HISTORY_HEADER]];
    for (let i = 0; i < n; i++) values.push(this.row(data, i));
    const wrote = await this.api.batchUpdate(this.ctx, [{ range: a1(tab, `A1:F${n + 2}`), values }]);
    if (!wrote.ok) { this.fail(wrote); return; }
    this.lastRowByTab.set(tab, n + 2);
    const sheetId = ids.value[tab];
    if (sheetId !== undefined) {
      const fmt = await this.api.formatBatch(this.ctx, [headerFormatRequest(sheetId), dateFormatRequest(sheetId, 2, n + 2)]);
      if (!fmt.ok) this.fail(fmt);
    }
  }

  async append(ticker: string, merged: FetchedChart, newRowCount: number): Promise<void> {
    const tab = priceHistoryTab(ticker);
    const ids = await this.api.tabIds(this.ctx);
    if (!ids.ok) { this.fail(ids); return; }
    if (!(tab in ids.value)) {
      await this.write(ticker, merged);
      return;
    }
    const meta = await this.api.batchUpdate(this.ctx, [{ range: a1(tab, 'B1'), values: [[encodePriceMeta(merged)]] }]);
    if (!meta.ok) { this.fail(meta); return; }
    if (newRowCount <= 0) return;
    let lastRow = this.lastRowByTab.get(tab);
    if (lastRow === undefined) {
      const col = await this.api.batchGet(this.ctx, [a1(tab, 'A:A')]);
      if (!col.ok) { this.fail(col); return; }
      lastRow = (col.value[0] ?? []).length;
    }
    const total = merged.dates.length;
    const startIdx = total - newRowCount;
    const startRow = lastRow + 1;
    const values: SheetRow[] = [];
    for (let i = 0; i < newRowCount; i++) values.push(this.row(merged, startIdx + i));
    const wrote = await this.api.batchUpdate(this.ctx, [{ range: a1(tab, `A${startRow}:F${startRow + newRowCount - 1}`), values }]);
    if (!wrote.ok) { this.fail(wrote); return; }
    this.lastRowByTab.set(tab, startRow + newRowCount - 1);
    const fmt = await this.api.formatBatch(this.ctx, [dateFormatRequest(ids.value[tab], startRow - 1, startRow - 1 + newRowCount)]);
    if (!fmt.ok) this.fail(fmt);
  }
}
