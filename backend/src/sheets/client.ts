/**
 * SheetsClient -- the ONLY place in this codebase that touches googleapis.
 *
 * Four operations are exported. Nothing else may call the Sheets API.
 *
 * The governing pattern, stated once here so every later phase inherits it:
 *   READ EVERYTHING AT THE START. ACCUMULATE IN MEMORY. FLUSH AT THE END.
 *
 * A naive one-call-per-row port of the legacy code would issue hundreds of
 * requests and hit 429 immediately. Batched properly the same work is single
 * digits. A batch request counts as ONE call regardless of how many
 * sub-requests it carries -- that is what makes this cheap.
 */

import type { sheets_v4 } from 'googleapis';
import type { RunContext } from '../core/context.ts';
import { runStep } from '../core/runStep.ts';
import { currentSignal } from '../core/cancel.ts';
import { reportSentence, ok } from '../core/result.ts';
import type { StepResult } from '../core/result.ts';
import type { SheetRow } from './coerce.ts';
import { RateLimiter } from './limiter.ts';
import { a1 } from './tabs.ts';
import { labelledReason } from '../reports/messages/catalog.ts';
import { createSheetsApi, parseServiceAccount, type ServiceAccountCredentials } from './serviceAccount.ts';

// GENERIC_PLAN P5: moved to serviceAccount.ts (no tab registry import, so profile-fetch can run before a profile exists).
export { createSheetsApi, parseServiceAccount, type ServiceAccountCredentials };

/** Headroom under the real 60/min/user/project binding limit. */
const DEFAULT_RATE_PER_MIN = 50;
/**
 * F-B7-12: calls allowed back to back before the steady rate applies. A full bucket of 50 plus 50 refilled
 * let about 100 calls into one minute, and Google refused reads (quota 60 per minute per user) in the
 * third real nightly. Any 60-second window now holds at most DEFAULT_BURST + DEFAULT_RATE_PER_MIN = 55.
 */
const DEFAULT_BURST = 5;

export interface ValueRangeUpdate {
  readonly range: string;
  readonly values: SheetRow[];
}

export type LockPhase = 'lock' | 'unlock';

/** One tab's colour. `themed` is true for a theme colour (its rgb is not known, `color` is then null). */
export interface TabColorInfo {
  readonly sheetId: number;
  readonly title: string;
  /** Lower-case '#rrggbb', or null when the tab has no colour (or a theme colour). */
  readonly color: string | null;
  readonly themed: boolean;
}
export interface TabGrid {
  readonly sheetId: number;
  readonly title: string;
  readonly rowCount: number;
  readonly columnCount: number;
}
export interface TabColorChange {
  readonly sheetId: number;
  /** '#rrggbb' to set, null to clear. */
  readonly color: string | null;
}

/** Status keys of the Master Lock steps (shared by the client and masterLock.ts so a failure shows once). */
export const LOCK_STEP_KEYS = { lock: 'sheets.lockTabs', unlock: 'sheets.unlockTabs' } as const;

/** The fixed report sentence for a failed lock or unlock step. */
export function lockFailureSentence(phase: LockPhase) {
  return reportSentence(labelledReason('Sheet lock', phase === 'lock' ? 'SHEET_LOCK_FAILED' : 'SHEET_UNLOCK_FAILED'));
}

/** A Sheets API colour (fractions, zero fields omitted) -> lower-case '#rrggbb'. */
export function colorToHex(c: sheets_v4.Schema$Color | null | undefined): string | null {
  if (!c) return null;
  const h = (v: number | null | undefined): string => Math.round((v ?? 0) * 255).toString(16).padStart(2, '0');
  return '#' + h(c.red) + h(c.green) + h(c.blue);
}

function rgbOfHex(hex: string): sheets_v4.Schema$Color {
  const h = hex.replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error('not a #rrggbb colour: ' + hex);
  return { red: parseInt(h.slice(0, 2), 16) / 255, green: parseInt(h.slice(2, 4), 16) / 255, blue: parseInt(h.slice(4, 6), 16) / 255 };
}

/** googleapis per-call options: only the step's cancellation signal. */
type CallOptions = { signal?: AbortSignal };

export interface SheetsClientOptions {
  readonly spreadsheetId: string;
  readonly api: sheets_v4.Sheets;
  readonly limiter?: RateLimiter;
}

/**
 * The default limiter (5 burst + 50 a minute: at most 55 calls in any 60 s window). Google's 60-a-minute
 * quota is per user and project, so the three spreadsheets (My Portfolio, reports, data) share ONE of these:
 * three separate limiters would let up to 165 calls into a minute and get refused (plan (d) "Quotas").
 */
export function createSheetsLimiter(now?: () => number, sleepFn?: (ms: number) => Promise<void>): RateLimiter {
  return new RateLimiter(DEFAULT_BURST, DEFAULT_RATE_PER_MIN / 60_000, now, sleepFn);
}

/** One tab as the migration and guard see it (one metadata call for all of them). */
export interface TabMeta {
  readonly sheetId: number;
  readonly title: string;
  readonly hidden: boolean;
  readonly rowCount: number;
  readonly columnCount: number;
}

/** The tab list and the spreadsheet-level developer metadata, read in ONE call (startup guard). */
export interface SpreadsheetState {
  readonly title: string;
  readonly tabs: readonly TabMeta[];
  /** metadataKey -> metadataValue (spreadsheet-level only). */
  readonly metadata: Readonly<Record<string, string>>;
}

/** True for a request that adds, deletes, copies or renames a tab (the cached tab ids are then stale). */
export function changesTabs(r: sheets_v4.Schema$Request): boolean {
  if (r.addSheet || r.deleteSheet || r.duplicateSheet) return true;
  // A rename changes the map; frozen rows, tab colour and the like do not.
  const fields = r.updateSheetProperties?.fields;
  return fields != null && /(^|,)\s*(title|\*)\s*(,|$)/.test(fields);
}

export class SheetsClient {
  readonly spreadsheetId: string;
  private readonly api: sheets_v4.Sheets;
  private readonly limiter: RateLimiter;
  private calls = 0;
  /**
   * F-B7-1: the tab title -> sheetId map, kept for the run. Every per-ticker store read and write
   * asked for it first, doubling the calls under the 50-per-minute limit. Cleared by any
   * formatBatch that adds, deletes, copies or renames a tab.
   */
  private tabIdCache: Readonly<Record<string, number>> | null = null;

  constructor(opts: SheetsClientOptions) {
    this.spreadsheetId = opts.spreadsheetId;
    this.api = opts.api;
    this.limiter = opts.limiter ?? createSheetsLimiter();
  }

  /** Forgets the kept tab-id map (after a tab was copied in from another spreadsheet). */
  invalidateTabIds(): void {
    this.tabIdCache = null;
  }

  /** The tab list with sizes and hidden flags, and the spreadsheet-level developer metadata: ONE call. */
  async spreadsheetState(ctx: RunContext): Promise<StepResult<SpreadsheetState>> {
    return runStep(
      ctx,
      { key: 'sheets.state', label: 'Read the spreadsheet structure', onFailure: reportSentence('Could not read the spreadsheet structure.'), retry: 'auto', timeoutMs: 20_000 },
      async () => {
        const res = await this.guarded((o) => this.api.spreadsheets.get({
          spreadsheetId: this.spreadsheetId,
          fields: 'properties.title,sheets.properties(title,sheetId,hidden,gridProperties(rowCount,columnCount)),developerMetadata(metadataKey,metadataValue,location(spreadsheet))',
        }, o));
        const tabs: TabMeta[] = [];
        for (const s of res.data.sheets ?? []) {
          const p = s.properties;
          if (!p || typeof p.title !== 'string') continue;
          tabs.push({ sheetId: p.sheetId ?? 0, title: p.title, hidden: !!p.hidden, rowCount: p.gridProperties?.rowCount ?? 0, columnCount: p.gridProperties?.columnCount ?? 0 });
        }
        const metadata: Record<string, string> = {};
        for (const m of res.data.developerMetadata ?? []) {
          if (typeof m.metadataKey === 'string' && (m.location?.spreadsheet ?? true)) metadata[m.metadataKey] = m.metadataValue ?? '';
        }
        return { title: res.data.properties?.title ?? '', tabs, metadata };
      },
    );
  }

  /** sheets.copyTo: copies one tab into another spreadsheet (named "Copy of X" there). Reads this spreadsheet only. */
  async copyTabTo(ctx: RunContext, sheetId: number, destinationSpreadsheetId: string): Promise<StepResult<{ sheetId: number; title: string }>> {
    return runStep(
      ctx,
      { key: 'sheets.copyTo', label: 'Copy one tab to another spreadsheet', onFailure: reportSentence('Could not copy a tab to the other spreadsheet.'), retry: 'auto', timeoutMs: 120_000 },
      async () => {
        const res = await this.guarded((o) => this.api.spreadsheets.sheets.copyTo({ spreadsheetId: this.spreadsheetId, sheetId, requestBody: { destinationSpreadsheetId } }, o));
        return { sheetId: res.data.sheetId ?? 0, title: res.data.title ?? '' };
      },
    );
  }

  /**
   * Read-only: the given tabs with formulas, pivot tables, data validation, charts, filter views and
   * conditional formats, plus the named ranges (the migration's reference check). ONE call.
   */
  async referenceScan(ctx: RunContext, titles: readonly string[]): Promise<StepResult<sheets_v4.Schema$Spreadsheet>> {
    return runStep(
      ctx,
      { key: 'sheets.referenceScan', label: 'Read formulas and references', onFailure: reportSentence('Could not read the formulas of the spreadsheet.'), retry: 'auto', timeoutMs: 120_000 },
      async () => {
        const res = await this.guarded((o) => this.api.spreadsheets.get({
          spreadsheetId: this.spreadsheetId, ranges: titles.map((t) => a1(t)), includeGridData: true,
          fields: 'namedRanges(name,range),sheets(properties(title,sheetId),charts(chartId,spec),filterViews(title,range),basicFilter(range),conditionalFormats,data(rowData(values(userEnteredValue(formulaValue),pivotTable(source),dataValidation))))',
        }, o));
        return res.data;
      },
    );
  }

  /** Total real API calls this run. Logged at the end so quota pressure is visible. */
  callCount(): number {
    return this.calls;
  }

  /**
   * Row 34: inside a cancelled step (cancel.ts) no call starts, a limiter wait ends without taking a
   * token, and the call in flight gets the step's signal (googleapis aborts the request).
   */
  private async guarded<T>(fn: (options: CallOptions) => Promise<T>): Promise<T> {
    const signal = currentSignal();
    await this.limiter.acquire(signal);
    this.calls++;
    return fn(signal ? { signal } : {});
  }

  /**
   * Reads many ranges in ONE API call.
   *
   * valueRenderOption defaults to UNFORMATTED_VALUE so numbers arrive as
   * numbers rather than locale-formatted strings. Dates then arrive as
   * Sheets serial numbers -- which is exactly why coerce.toDate() exists and
   * why raw cells are typed opaquely.
   */
  async batchGet(
    ctx: RunContext,
    ranges: readonly string[],
    opts: { valueRenderOption?: 'UNFORMATTED_VALUE' | 'FORMATTED_VALUE' | 'FORMULA' } = {},
  ): Promise<StepResult<SheetRow[][]>> {
    return runStep(
      ctx,
      {
        key: 'sheets.batchGet',
        label: `Read ${ranges.length} range(s) from the spreadsheet`,
        onFailure: reportSentence('Could not read part of the spreadsheet, so some sections below may be incomplete.'),
        retry: 'auto',
        timeoutMs: 30_000,
      },
      async () => {
        const res = await this.guarded((o) =>
          this.api.spreadsheets.values.batchGet({
            spreadsheetId: this.spreadsheetId,
            ranges: [...ranges],
            valueRenderOption: opts.valueRenderOption ?? 'UNFORMATTED_VALUE',
            dateTimeRenderOption: 'SERIAL_NUMBER',
          }, o),
        );
        const vrs = res.data.valueRanges ?? [];
        // Order is guaranteed to match the requested ranges. Missing/empty
        // ranges come back without a `values` field -- normalise to [].
        return ranges.map((_, i) => (vrs[i]?.values ?? []) as SheetRow[]);
      },
    );
  }

  /** Writes many ranges in ONE API call. */
  async batchUpdate(ctx: RunContext, updates: readonly ValueRangeUpdate[]): Promise<StepResult<number>> {
    return runStep(
      ctx,
      {
        key: 'sheets.batchUpdate',
        label: `Write ${updates.length} range(s) to the spreadsheet`,
        onFailure: reportSentence('Could not save part of this report to the spreadsheet.'),
        retry: 'auto',
        timeoutMs: 60_000,
      },
      async () => {
        if (updates.length === 0) return 0;
        const res = await this.guarded((o) =>
          this.api.spreadsheets.values.batchUpdate({
            spreadsheetId: this.spreadsheetId,
            requestBody: {
              valueInputOption: 'RAW',
              data: updates.map((u) => ({ range: u.range, majorDimension: 'ROWS', values: u.values })),
            },
          }, o),
        );
        return res.data.totalUpdatedCells ?? 0;
      },
    );
  }

  /** Appends rows below the existing data in a range. The append-only primitive. */
  async append(ctx: RunContext, range: string, rows: readonly SheetRow[]): Promise<StepResult<number>> {
    return runStep(
      ctx,
      {
        key: 'sheets.append',
        label: `Append ${rows.length} row(s)`,
        onFailure: reportSentence('Could not save new history rows; previously stored data is unaffected.'),
        retry: 'auto',
        timeoutMs: 30_000,
      },
      async () => {
        if (rows.length === 0) return 0;
        const res = await this.guarded((o) =>
          this.api.spreadsheets.values.append({
            spreadsheetId: this.spreadsheetId,
            range,
            valueInputOption: 'RAW',
            // INSERT_ROWS, not OVERWRITE: never touch a row that already exists.
            insertDataOption: 'INSERT_ROWS',
            requestBody: { majorDimension: 'ROWS', values: rows as unknown[][] },
          }, o),
        );
        return res.data.updates?.updatedRows ?? 0;
      },
    );
  }

  /** Structural and formatting changes in ONE call: merges, colours, new tabs. */
  async formatBatch(ctx: RunContext, requests: readonly sheets_v4.Schema$Request[]): Promise<StepResult<number>> {
    return runStep(
      ctx,
      {
        key: 'sheets.formatBatch',
        label: `Apply ${requests.length} formatting request(s)`,
        onFailure: reportSentence('The report was saved but some formatting could not be applied; all values are correct.'),
        retry: 'auto',
        timeoutMs: 60_000,
      },
      async () => {
        if (requests.length === 0) return 0;
        if (requests.some(changesTabs)) this.tabIdCache = null;
        await this.guarded((o) =>
          this.api.spreadsheets.batchUpdate({
            spreadsheetId: this.spreadsheetId,
            requestBody: { requests: [...requests] },
          }, o),
        );
        return requests.length;
      },
    );
  }

  /**
   * C3: adds tabs in ONE call and returns title -> new sheetId from the reply. The kept tab-id map is
   * extended, not cleared (formatBatch would clear it and cost a tabIds call afterwards).
   */
  async addTabs(ctx: RunContext, titles: readonly string[]): Promise<StepResult<Record<string, number>>> {
    return runStep(
      ctx,
      {
        key: 'sheets.addTabs',
        label: `Add ${titles.length} tab(s)`,
        onFailure: reportSentence('Could not save part of this report to the spreadsheet.'),
        retry: 'auto',
        timeoutMs: 60_000,
      },
      async () => {
        if (titles.length === 0) return {};
        const res = await this.guarded((o) =>
          this.api.spreadsheets.batchUpdate({
            spreadsheetId: this.spreadsheetId,
            requestBody: { requests: titles.map((title) => ({ addSheet: { properties: { title } } })) },
          }, o),
        );
        const out: Record<string, number> = {};
        (res.data.replies ?? []).forEach((r, i) => {
          const p = r.addSheet?.properties;
          if (typeof p?.sheetId === 'number') out[typeof p.title === 'string' ? p.title : titles[i]!] = p.sheetId;
        });
        if (titles.every((t) => t in out)) {
          if (this.tabIdCache) this.tabIdCache = { ...this.tabIdCache, ...out };
        } else {
          this.tabIdCache = null;
        }
        return out;
      },
    );
  }

  /** Tab titles that currently exist. One metadata call, touches no data. */
  async listTabs(ctx: RunContext): Promise<StepResult<string[]>> {
    return runStep(
      ctx,
      {
        key: 'sheets.listTabs',
        label: 'List spreadsheet tabs',
        onFailure: reportSentence('Could not read the spreadsheet structure.'),
        retry: 'auto',
        timeoutMs: 20_000,
      },
      async () => {
        const res = await this.guarded((o) =>
          this.api.spreadsheets.get({ spreadsheetId: this.spreadsheetId, fields: 'sheets.properties.title' }, o),
        );
        return (res.data.sheets ?? [])
          .map((s) => s.properties?.title)
          .filter((t): t is string => typeof t === 'string');
      },
    );
  }

  /**
   * Tab title -> numeric sheetId. One metadata call. Formatting requests
   * (repeatCell etc.) address a tab by sheetId, not by title.
   */
  async tabIds(ctx: RunContext): Promise<StepResult<Record<string, number>>> {
    if (this.tabIdCache) return ok({ ...this.tabIdCache });
    const res = await runStep(
      ctx,
      {
        key: 'sheets.tabIds',
        label: 'List spreadsheet tab ids',
        onFailure: reportSentence('Could not read the spreadsheet structure.'),
        retry: 'auto',
        timeoutMs: 20_000,
      },
      async () => {
        const res = await this.guarded((o) =>
          this.api.spreadsheets.get({ spreadsheetId: this.spreadsheetId, fields: 'sheets.properties(title,sheetId)' }, o),
        );
        const out: Record<string, number> = {};
        for (const s of res.data.sheets ?? []) {
          const title = s.properties?.title;
          const id = s.properties?.sheetId;
          if (typeof title === 'string' && typeof id === 'number') out[title] = id;
        }
        return out;
      },
    );
    if (res.ok) this.tabIdCache = { ...res.value };
    return res;
  }

  /** Every tab's grid size (trim-price-tabs). One metadata call, touches no data. */
  async tabGrids(ctx: RunContext): Promise<StepResult<TabGrid[]>> {
    return runStep(
      ctx,
      {
        key: 'sheets.tabGrids',
        label: 'Read tab sizes',
        onFailure: reportSentence('Could not read the spreadsheet structure.'),
        retry: 'auto',
        timeoutMs: 20_000,
      },
      async () => {
        const res = await this.guarded((o) =>
          this.api.spreadsheets.get({ spreadsheetId: this.spreadsheetId, fields: 'sheets.properties(title,sheetId,gridProperties(rowCount,columnCount))' }, o),
        );
        const out: TabGrid[] = [];
        for (const s of res.data.sheets ?? []) {
          const p = s.properties;
          if (!p || typeof p.sheetId !== 'number' || typeof p.title !== 'string') continue;
          out.push({ sheetId: p.sheetId, title: p.title, rowCount: p.gridProperties?.rowCount ?? 0, columnCount: p.gridProperties?.columnCount ?? 0 });
        }
        return out;
      },
    );
  }

  /** One tab exactly as the Sheet shows it: displayed text, colours, merges, column widths (read only, one call). */
  async tabWithFormats(ctx: RunContext, title: string): Promise<StepResult<sheets_v4.Schema$Sheet | null>> {
    return runStep(
      ctx,
      { key: 'sheets.tabWithFormats', label: 'Read one tab with its formatting', onFailure: reportSentence('Could not read the report tab.'), retry: 'auto', timeoutMs: 60_000 },
      async () => {
        const res = await this.guarded((o) =>
          this.api.spreadsheets.get({
            spreadsheetId: this.spreadsheetId, ranges: [a1(title)], includeGridData: true,
            fields: 'sheets(properties(title,hidden),merges,data(columnMetadata(pixelSize),rowData(values(formattedValue,effectiveFormat(backgroundColor,textFormat(bold,italic,fontSize,foregroundColor),horizontalAlignment,wrapStrategy)))))',
          }, o),
        );
        return res.data.sheets?.[0] ?? null;
      },
    );
  }

  /** Every tab's colour (Master Lock). One metadata call, touches no data. */
  async tabColors(ctx: RunContext, phase: LockPhase): Promise<StepResult<TabColorInfo[]>> {
    return runStep(
      ctx,
      {
        key: LOCK_STEP_KEYS[phase],
        label: `Read tab colours (${phase})`,
        onFailure: lockFailureSentence(phase),
        retry: 'auto',
        timeoutMs: 20_000,
      },
      async () => {
        const res = await this.guarded((o) =>
          this.api.spreadsheets.get({ spreadsheetId: this.spreadsheetId, fields: 'sheets.properties(title,sheetId,tabColor,tabColorStyle)' }, o),
        );
        const out: TabColorInfo[] = [];
        for (const s of res.data.sheets ?? []) {
          const p = s.properties;
          if (!p || typeof p.sheetId !== 'number' || typeof p.title !== 'string') continue;
          const style = p.tabColorStyle;
          const themed = !!style?.themeColor;
          out.push({ sheetId: p.sheetId, title: p.title, color: themed ? null : colorToHex(style?.rgbColor ?? p.tabColor), themed });
        }
        // C3: the same call lists every tab's id, so the kept tab-id map is filled for free.
        this.tabIdCache = Object.fromEntries(out.map((t) => [t.title, t.sheetId]));
        return out;
      },
    );
  }

  /** Sets (or clears, with null) the colour of many tabs in ONE call. Safe to repeat. */
  async setTabColors(ctx: RunContext, phase: LockPhase, changes: readonly TabColorChange[]): Promise<StepResult<number>> {
    return runStep(
      ctx,
      {
        key: LOCK_STEP_KEYS[phase],
        label: `${phase === 'lock' ? 'Lock' : 'Unlock'} ${changes.length} tab(s)`,
        onFailure: lockFailureSentence(phase),
        retry: 'auto',
        timeoutMs: 60_000,
      },
      async () => {
        if (changes.length === 0) return 0;
        const requests: sheets_v4.Schema$Request[] = changes.map((c) =>
          c.color === null
            ? { updateSheetProperties: { properties: { sheetId: c.sheetId }, fields: 'tabColor,tabColorStyle' } }
            : { updateSheetProperties: { properties: { sheetId: c.sheetId, tabColorStyle: { rgbColor: rgbOfHex(c.color) } }, fields: 'tabColorStyle' } },
        );
        await this.guarded((o) => this.api.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: { requests } }, o));
        return changes.length;
      },
    );
  }

  /**
   * Clears the values (not the formatting) of many ranges in ONE call. Used
   * before a full rewrite of a tab whose new contents may be shorter than
   * the old -- the Apps Script clearContents() equivalent.
   */
  async batchClear(ctx: RunContext, ranges: readonly string[]): Promise<StepResult<number>> {
    return runStep(
      ctx,
      {
        key: 'sheets.batchClear',
        label: `Clear ${ranges.length} range(s)`,
        onFailure: reportSentence('Could not clear part of the spreadsheet before rewriting it.'),
        retry: 'auto',
        timeoutMs: 30_000,
      },
      async () => {
        if (ranges.length === 0) return 0;
        await this.guarded((o) =>
          this.api.spreadsheets.values.batchClear({
            spreadsheetId: this.spreadsheetId,
            requestBody: { ranges: [...ranges] },
          }, o),
        );
        return ranges.length;
      },
    );
  }
}
