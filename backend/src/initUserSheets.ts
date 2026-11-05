/**
 * GENERIC_PLAN P7: npm run init-user-sheets. Fills a NEW user's blank "My Portfolio" spreadsheet with the template
 * input tabs: Portfolio (the stock table and the options table, headers only, plus the CLOSED section label) and
 * 🎯 Watchlist (header + the profile's watchlistSeed) and an empty 💾 Script Properties (the runs' key-value store;
 * a run refuses a sheet without it). Every other tab (reports, data, history) is made by the runs.
 *
 * Why not "copy a template file": a robot account cannot own new Drive files (no storage), so the user makes 3 blank
 * sheets, shares them with the robot (SETUP_GUIDE P-4), and this fills them.
 *
 * SAFE BY CONSTRUCTION: it only ADDS a tab that does not exist. An existing Portfolio or Watchlist tab is never
 * written, so running it on the owner's sheet changes nothing. Prints no ids or values.
 */

import { finish } from './core/finish.ts';
import { activeProfile } from './profile/active.ts';
import { Tabs } from './sheets/tabs.ts';
import { STOCK_REQUIRED, OPTIONS_REQUIRED } from './sheets/readers/portfolio.ts';
import { PROPERTY_STORE_HEADER } from './storage/kv.ts';

/** The template Portfolio layout, row by row (A1 down). The readers find each table by its header row. */
export function portfolioTemplateRows(): string[][] {
  const stockHeader = ['Ticker', 'type', 'sub-type', 'amount', 'price per item', 'value of inverstment', 'cost avg per stock', 'Purchase Date', 'URLS / comments'];
  const optionsHeader = ['Ticker', 'type', 'positions', 'last trade Date', 'strike', 'PUT/CALL', 'avg price - Premium paid', 'cost basis', 'current market value', 'URLS / comments', 'Purchase Date'];
  const closedHeader = ['Ticker', 'type', 'positions', 'last trade Date', 'strike', 'PUT/CALL', 'avg price - Premium paid', 'cost basis', 'Sell Price', 'Sell Date'];
  return [
    ['Stocks (type: stock or crypto). One row per holding. Purchase Date: the day you bought (empty = an assumed date).'],
    stockHeader,
    ['', '', '', '', '', '', '', '', ''],
    ['Options (calls only). One row per contract line.'],
    ['OPEN positions'],
    optionsHeader,
    ['', '', '', '', '', '', '', '', '', '', ''],
    ['CLOSED positions'],
    closedHeader,
  ];
}

/** Every header the readers require is in the template (guards drift between template and readers). */
export function templateCoversReaders(): boolean {
  const rows = portfolioTemplateRows();
  const has = (req: readonly string[]): boolean => rows.some((r) => req.every((h) => r.includes(h)));
  return has(STOCK_REQUIRED) && has(OPTIONS_REQUIRED);
}

export interface InitDeps {
  readonly listTabs: () => Promise<string[]>;
  readonly addTab: (title: string) => Promise<void>;
  readonly write: (title: string, rows: string[][]) => Promise<void>;
  readonly watchlistSeed: readonly string[];
  readonly out: (line: string) => void;
}

export async function initUserSheets(d: InitDeps): Promise<number> {
  const tabs = await d.listTabs();
  const plan: Array<[string, string[][]]> = [
    [Tabs.PORTFOLIO, portfolioTemplateRows()],
    [Tabs.WATCHLIST, [['Ticker'], ...d.watchlistSeed.map((t) => [t])]],
    // The runs refuse a sheet without this tab (sheets/threeSheets.ts checkStartup), so a new sheet needs it, empty.
    [Tabs.SCRIPT_PROPERTIES, [[...PROPERTY_STORE_HEADER]]],
  ];
  let added = 0;
  for (const [title, rows] of plan) {
    if (tabs.includes(title)) { d.out('✅ ' + title + ': already there, not touched.'); continue; }
    await d.addTab(title);
    await d.write(title, rows);
    added++;
    d.out('✅ ' + title + ': added with the template headers.');
  }
  d.out(added ? 'Done. Fill in your holdings and watchlist, then run the Setup check.' : 'Nothing to do: the input tabs are already there.');
  return 0;
}

async function live(): Promise<number> {
  const out = (l: string): void => { process.stdout.write(l + '\n'); };
  const sa = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? '').trim();
  const id = (process.env.SPREADSHEET_ID ?? '').trim();
  if (!sa || !id) { out('Missing GOOGLE_SERVICE_ACCOUNT_JSON or SPREADSHEET_ID (SETUP_GUIDE P-3).'); return 2; }
  const { google } = await import('googleapis');
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(sa), scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const api = google.sheets({ version: 'v4', auth });
  const quote = (t: string): string => "'" + t.replace(/'/g, "''") + "'";
  return initUserSheets({
    listTabs: async () => ((await api.spreadsheets.get({ spreadsheetId: id, fields: 'sheets.properties.title' })).data.sheets ?? []).map((s) => s.properties?.title ?? ''),
    addTab: async (title) => { await api.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: [{ addSheet: { properties: { title } } }] } }); },
    write: async (title, rows) => { await api.spreadsheets.values.update({ spreadsheetId: id, range: quote(title) + '!A1', valueInputOption: 'RAW', requestBody: { values: rows } }); },
    watchlistSeed: activeProfile().lists.watchlistSeed,
    out,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  live().then((c) => finish(c), () => { process.stdout.write('init-user-sheets: could not open the sheet (is it shared with the robot as Editor?).\n'); finish(1); });
}
