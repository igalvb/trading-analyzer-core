/**
 * The sheets-mode storage of composeServices (compose.ts), over one spreadsheet (today) or three
 * (docs/SHEETS_CLEANUP_PLAN.md (d), phase 2).
 *
 * The startup guard (sheets/threeSheets.ts checkStartup) runs first and decides:
 *   - flag unset on My Portfolio -> today's behaviour: property store, tab store, price tabs and report workbooks
 *     all on SPREADSHEET_ID, whatever REPORTS_/DATA_SPREADSHEET_ID say;
 *   - flag set and every check passing -> routing: data tabs on DATA_SPREADSHEET_ID, report tabs on
 *     REPORTS_SPREADSHEET_ID, the owner's tabs on SPREADSHEET_ID (sheets/routing.ts);
 *   - a refusal (SheetsRefusedError) or the maintenance pause (SheetsPausedError) is thrown to the entry.
 *
 * Every SheetsClient here shares ONE RateLimiter (Google's 60-a-minute quota is per user and project).
 */

import type { sheets_v4 } from 'googleapis';
import type { RunContext } from '../core/context.ts';
import { SheetsClient, createSheetsApi, createSheetsLimiter, parseServiceAccount } from '../sheets/client.ts';
import type { RateLimiter } from '../sheets/limiter.ts';
import { SheetPropertyStore, type PropertyStore } from '../storage/kv.ts';
import { SheetTabStore, type TabStore } from '../storage/tabStore.ts';
import type { PriceHistoryStore } from '../storage/priceHistory.ts';
import { BulkPriceHistoryStore } from '../storage/bulkPriceHistory.ts';
import { SheetsWorkbookBackend, type WorkbookBackend } from '../sheets/reportSheet.ts';
import { SheetTabFormatter, type TabFormatter } from '../sheets/formatOps.ts';
import { Tabs } from '../sheets/tabs.ts';
import { RoutingFormatter, RoutingTabStore, RoutingWorkbookBackend } from '../sheets/routing.ts';
import { checkStartup, sheetIdsFromEnv } from '../sheets/threeSheets.ts';

export interface SheetsStorage {
  readonly kv: PropertyStore;
  readonly tabStore: TabStore;
  readonly priceStore: PriceHistoryStore;
  readonly backend: WorkbookBackend;
  /** My Portfolio. */
  readonly sheets: SheetsClient;
  /** The two new spreadsheets; null while routing is off. */
  readonly reportsSheets: SheetsClient | null;
  readonly dataSheets: SheetsClient | null;
  /** Formatting of TabStore tabs (the Dark Pool Tracker), on the sheet that holds each tab. */
  readonly tabFormatter: TabFormatter;
  readonly routed: boolean;
  flushStores(): Promise<void>;
}

export interface SheetsStorageOptions {
  /** Tests: a fake googleapis Sheets object instead of the service account. */
  readonly api?: sheets_v4.Sheets;
  readonly limiter?: RateLimiter;
  readonly now: () => number;
}

export async function buildSheetsStorage(
  ctx: RunContext, env: Readonly<Record<string, string | undefined>>, timeZone: string, o: SheetsStorageOptions,
): Promise<SheetsStorage> {
  const json = env.GOOGLE_SERVICE_ACCOUNT_JSON, id = env.SPREADSHEET_ID;
  if ((!json && !o.api) || !id) {
    ctx.log.critical('sheets mode without GOOGLE_SERVICE_ACCOUNT_JSON / SPREADSHEET_ID: the spreadsheet cannot be reached');
    throw new Error('sheets mode needs GOOGLE_SERVICE_ACCOUNT_JSON and SPREADSHEET_ID in the environment (.env)');
  }
  const api = o.api ?? createSheetsApi(parseServiceAccount(json as string));
  const limiter = o.limiter ?? createSheetsLimiter();
  const clients = new Map<string, SheetsClient>();
  const clientFor = (spreadsheetId: string): SheetsClient => {
    let c = clients.get(spreadsheetId);
    if (!c) { c = new SheetsClient({ spreadsheetId, api, limiter }); clients.set(spreadsheetId, c); }
    return c;
  };
  const ids = sheetIdsFromEnv(env);
  const client = clientFor(id);
  const decision = await checkStartup(ctx, ids, { portfolio: client, open: clientFor, now: o.now() });
  for (const w of decision.warnings) ctx.log.warning(w);

  const kvClient = decision.mode === 'routed' ? clientFor(decision.dataId) : client;
  const loaded = await SheetPropertyStore.load(ctx, kvClient, Tabs.SCRIPT_PROPERTIES);
  if (!loaded.ok) {
    ctx.log.critical('startup: the property store tab could not be loaded; the run cannot start', { detail: String(loaded.error.detail) });
    throw new Error('could not load the property store tab: ' + String(loaded.error.detail));
  }
  const sheetKv = loaded.value;
  // F-B7-11: read all saved price tabs at the start, write the changed ones at the end (flushStores).
  const bulkPrices = new BulkPriceHistoryStore(ctx, kvClient, timeZone, (e) => ctx.log.warning('price cache write failed', { detail: String(e.detail) }));
  const flushStores = async (): Promise<void> => {
    const r = await sheetKv.flush(ctx);
    if (!r.ok) ctx.log.error('property store flush failed', { detail: String(r.error.detail) });
    await bulkPrices.flush();
  };

  if (decision.mode === 'single') {
    return {
      kv: sheetKv, tabStore: new SheetTabStore(ctx, client, timeZone), priceStore: bulkPrices,
      backend: new SheetsWorkbookBackend(ctx, client, timeZone), sheets: client, reportsSheets: null, dataSheets: null,
      tabFormatter: new SheetTabFormatter(ctx, client), routed: false, flushStores,
    };
  }

  const reports = clientFor(decision.reportsId), data = clientFor(decision.dataId);
  const allow = { onRefuse: (m: string) => ctx.log.error('Sheet allow-list: ' + m) };
  ctx.log.info('Three spreadsheets: routing on (reports and data tabs in their own spreadsheets)');
  return {
    kv: sheetKv,
    tabStore: new RoutingTabStore({
      portfolio: new SheetTabStore(ctx, client, timeZone), reports: new SheetTabStore(ctx, reports, timeZone), data: new SheetTabStore(ctx, data, timeZone),
    }, allow),
    priceStore: bulkPrices,
    backend: new RoutingWorkbookBackend({
      portfolio: new SheetsWorkbookBackend(ctx, client, timeZone), reports: new SheetsWorkbookBackend(ctx, reports, timeZone), data: new SheetsWorkbookBackend(ctx, data, timeZone),
    }, allow),
    sheets: client, reportsSheets: reports, dataSheets: data,
    tabFormatter: new RoutingFormatter({ portfolio: new SheetTabFormatter(ctx, client), reports: new SheetTabFormatter(ctx, reports), data: new SheetTabFormatter(ctx, data) }),
    routed: true, flushStores,
  };
}
