/**
 * npm run cleanup-report-tabs [-- --yes] [--legacy-tabs]: deletes the old per-ticker report tabs that phase 1 of
 * docs/SHEETS_CLEANUP_PLAN.md replaced with fixed tabs ('📋 Bottom Line', '📊 Price Chart').
 *
 * Only a tab whose name is EXACTLY one of the two old patterns is touched:
 *   '📋 Bottom Line — <ticker>'   and   '📊 <ticker> Chart'
 * where <ticker> is a ticker symbol (capitals, digits, '.', '^', '-'; 1 to 12 characters). Nothing else is
 * matched: not the fixed tabs, not '📌 Position — <ticker>', not any of the owner's tabs. Nothing is lost:
 * the next Analyze writes the fixed tabs again, and every run's PDF is in Telegram and the workflow artifacts.
 * Dry run unless --yes. Exit code: 0 done, 1 a read or write failed, 2 configuration missing or unusable.
 *
 * --legacy-tabs (opt-in, one-time; owner 2026-11-04, backlog row 39): ALSO deletes the two unused legacy tabs
 * '🎯 Watchlist Summary' and '📤 Exit Strategy' (exact names; nothing writes them any more). They may sit in My
 * Portfolio (SPREADSHEET_ID) or, after the sheets split, in the reports sheet (REPORTS_SPREADSHEET_ID), so with
 * this flag both sheets are checked, for these two names only. Never touched without the flag. Still a dry run
 * unless --yes. The new '📤 Exit Report' tab is not matched.
 */

import { processLine } from './core/logFile.ts';
import { pathToFileURL } from 'node:url';
import { createContext, type RunContext } from './core/context.ts';
import { SheetsClient, createSheetsApi, parseServiceAccount } from './sheets/client.ts';
import { WATCHLIST_SUMMARY_SHEET } from './stores/watchlist.ts';
import { EXIT_STRATEGY_TAB } from './reports/exit/exitReport.ts';

const TICKER = '[A-Z0-9.^-]{1,12}';
const OLD_BOTTOM_LINE = new RegExp('^📋 Bottom Line — ' + TICKER + '$', 'u');
const OLD_CHART = new RegExp('^📊 ' + TICKER + ' Chart$', 'u');

/** The two unused legacy tabs `--legacy-tabs` removes (exact names). */
export const LEGACY_UNUSED_TABS: readonly string[] = [WATCHLIST_SUMMARY_SHEET, EXIT_STRATEGY_TAB];
export const LEGACY_TABS_FLAG = '--legacy-tabs';

/** True only for the two exact legacy per-ticker report tab patterns. */
export function isOldReportTab(name: string): boolean {
  return OLD_BOTTOM_LINE.test(name) || OLD_CHART.test(name);
}

export type CleanupSheets = Pick<SheetsClient, 'tabIds' | 'formatBatch'>;

export interface CleanupCliDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly argv: readonly string[];
  readonly out: (line: string) => void;
  readonly errOut: (line: string) => void;
  /** spreadsheetId: SPREADSHEET_ID, or REPORTS_SPREADSHEET_ID for the --legacy-tabs pass on the reports sheet. */
  readonly makeSheets?: (env: Readonly<Record<string, string | undefined>>, spreadsheetId: string) => CleanupSheets;
  readonly ctx?: RunContext;
}

interface LegacyPass { readonly label: string; readonly sheets: CleanupSheets; readonly ids: Readonly<Record<string, number>>; readonly names: readonly string[] }


export async function runCleanupReportTabs(deps: CleanupCliDeps): Promise<number> {
  const missing = ['GOOGLE_SERVICE_ACCOUNT_JSON', 'SPREADSHEET_ID'].filter((n) => !(deps.env[n] ?? '').trim());
  if (missing.length) { deps.errOut('Clean up report tabs: missing environment variable(s): ' + missing.join(', ')); return 2; }
  /** The client for one spreadsheet, or the error line when the credentials are unusable. */
  const make = (spreadsheetId: string): CleanupSheets | string => {
    try {
      return deps.makeSheets
        ? deps.makeSheets(deps.env, spreadsheetId)
        : new SheetsClient({ spreadsheetId, api: createSheetsApi(parseServiceAccount(deps.env['GOOGLE_SERVICE_ACCOUNT_JSON'] as string)) });
    } catch (e) {
      return 'Clean up report tabs: ' + (e instanceof Error ? e.message : 'the Google credentials are unusable');
    }
  };
  const portfolioId = deps.env['SPREADSHEET_ID'] as string;
  const reportsId = (deps.env['REPORTS_SPREADSHEET_ID'] ?? '').trim();
  const legacyTabs = deps.argv.includes(LEGACY_TABS_FLAG);
  const sheets = make(portfolioId);
  if (typeof sheets === 'string') { deps.errOut(sheets); return 2; }
  const ctx = deps.ctx ?? createContext({ mode: 'lock' });
  const ids = await sheets.tabIds(ctx);
  if (!ids.ok) { deps.errOut('Clean up report tabs: the tab list could not be read. Details are in the log.'); return 1; }
  const old = Object.keys(ids.value).filter(isOldReportTab).sort();
  deps.out(`Clean up report tabs: ${old.length} old per-ticker report tab(s) found.`);
  for (const name of old) deps.out('  ' + name);

  // --legacy-tabs: the two unused legacy tabs, in My Portfolio and (when it is a different sheet) the reports sheet.
  const found = (tabIds: Readonly<Record<string, number>>): string[] => LEGACY_UNUSED_TABS.filter((n) => Object.hasOwn(tabIds, n));
  const passes: LegacyPass[] = [];
  if (legacyTabs) {
    passes.push({ label: 'My Portfolio', sheets, ids: ids.value, names: found(ids.value) });
    if (reportsId && reportsId !== portfolioId.trim()) {
      const rs = make(reportsId);
      if (typeof rs === 'string') { deps.errOut(rs); return 2; }
      const rids = await rs.tabIds(ctx);
      if (!rids.ok) { deps.errOut('Clean up report tabs: the tab list of the reports sheet could not be read. Details are in the log.'); return 1; }
      passes.push({ label: 'the reports sheet', sheets: rs, ids: rids.value, names: found(rids.value) });
    }
    for (const p of passes) {
      deps.out(`Clean up report tabs: ${p.names.length} unused legacy tab(s) found in ${p.label}.`);
      for (const name of p.names) deps.out('  ' + name);
    }
  }

  if (!deps.argv.includes('--yes')) { deps.out('Dry run: nothing deleted. Run again with --yes to delete them.'); return 0; }
  // My Portfolio: the per-ticker tabs and (with the flag) the legacy tabs go in ONE batch.
  const here = [...old, ...(passes[0]?.names ?? [])];
  if (here.length) {
    const r = await sheets.formatBatch(ctx, here.map((name) => ({ deleteSheet: { sheetId: ids.value[name] as number } })));
    if (!r.ok) { deps.errOut('Clean up report tabs: the tabs could not be deleted. Nothing was half-done: the Sheet applies the whole batch or none of it.'); return 1; }
    deps.out(`Clean up report tabs: ${here.length} tab(s) deleted.`);
  }
  for (const p of passes.slice(1)) {
    if (!p.names.length) continue;
    const r = await p.sheets.formatBatch(ctx, p.names.map((name) => ({ deleteSheet: { sheetId: p.ids[name] as number } })));
    if (!r.ok) { deps.errOut(`Clean up report tabs: the legacy tabs in ${p.label} could not be deleted. Nothing was half-done there.`); return 1; }
    deps.out(`Clean up report tabs: ${p.names.length} tab(s) deleted in ${p.label}.`);
  }
  return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  runCleanupReportTabs({ env: process.env, argv: process.argv.slice(2), out: (l) => console.log(l), errOut: (l) => console.error(l) }).then(
    (code) => { process.exitCode = code; },
    (e: unknown) => { console.error('Clean up report tabs: unexpected failure.'); processLine('CRITICAL', 'cleanup', 'stopped on an unexpected error (exit 1)', { detail: String(e) }); process.exitCode = 1; },
  );
}
