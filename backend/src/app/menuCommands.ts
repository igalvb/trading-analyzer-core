/**
 * The legacy spreadsheet-menu items as CLI commands (`npm run analyze`'s cli.ts dispatches here; MENU_ENTRY_POINTS in
 * reports/options/ui.ts maps every menu handler to one of these). Each command composes the services, runs the ported
 * function, writes the workbook once inside the Master Lock (app/sheetWrites.ts) and prints plain text on stdout; the
 * technical log goes to stderr.
 *
 *   options [TICKER]            runFullAnalysis (default TSLA): the options tabs, snapshot and overlay
 *   options-call TICKER         recommendedCallReport, printed (showRecommendedCallV7)
 *   options-diagnose            diagnose: one Cboe call, written to the 🔬 Log tab; stdout gets one plain line
 *   chart [TICKER]              showPriceChart + renderPriceChartHtml -> out/<TICKER>-chart.html (F-C1: no Sheets chart);
 *                               no TICKER = the ticker on the dashboard header, as legacy; data on the fixed
 *                               '📊 Price Chart' tab (phase 1)
 *   exit-report                 the nightly's exit.report job alone (Exit pipeline -> Exit sheet)
 *   position T PRICE DATE       analyzePosition (analyzePositionV7, not a menu item in legacy) -> the fixed '📌 Position' tab
 *   check-keys                  checkApiKeysConfigured: names of missing keys only, never a value
 *   cleanup-price-caches        cleanupPriceCacheSheets: a dry run unless --yes (--yes is the YES of the legacy dialog)
 *   sheet-size                  diagnoseSheetSize (every tab loaded)
 *   methodology                 buildMethodologySheet
 *   help                        cliHelpText
 *
 * Storage: the real spreadsheet by default; --memory is a dry run on an empty (or test-seeded) workbook.
 * Exit status: 0 done, 1 the command could not finish (or check-keys found missing keys), 2 usage error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { composeServices, TICKER_RUN_PRELOAD, ANALYSIS_TAB, type Services } from '../compose.ts';
import { formatLine, LogLevel, textLog } from '../core/logger.ts';
import type { CliIo } from '../cli.ts';
import { tabText } from '../cli.ts';
import type { EntryOverrides } from '../ticker.ts';
import { withSheetWrites, isUnlockFailure, UNLOCK_FAILED_LINE } from './sheetWrites.ts';
import { buildNightlyApp } from './nightlyApp.ts';
import { runFullAnalysis, diagnose, recommendedCallReport } from '../reports/options/run.ts';
import { OptionsTabs, DEFAULT_TICKER } from '../reports/options/tabs.ts';
import { showPriceChart, chartWorkbook, PRICE_CHART_TAB, type ChartStore } from '../ops/priceChart.ts';
import { renderPriceChartHtml, priceChartFileName } from '../ops/priceChartHtml.ts';
import { computeStockEntryLadder, computeStockExitLadder } from '../analysis/ladders.ts';
import { toAnalysisChart } from '../analysis/runTicker.ts';
import { analyzePosition, POSITION_TAB } from '../portfolio/positions/analyzePosition.ts';
import { runTimeText } from '../reports/fixedTabs.ts';
import { checkApiKeysConfigured } from '../ops/apiKeys.ts';
import { cleanupPriceCacheSheets, DeletableWorkbook, openPriceCacheWorkbook, sheetsTabDeleter, serialAwareDate, type CleanupWorkbook } from '../ops/priceCaches.ts';
import { Tabs, MIGRATION_MARKER_TAB } from '../sheets/tabs.ts';
import { RS_RANKING_TAB } from '../storage/rsRankingTab.ts';
import { FUNDAMENTALS_SERIES_TAB } from '../storage/fundamentalsSeriesTab.ts';
import { diagnoseSheetSize } from '../ops/sheetSize.ts';
import { buildMethodologySheet, METHODOLOGY_TAB } from '../ops/methodology.ts';
import { cliHelpText } from '../ops/menuHelp.ts';
import { MemoryWorkbookBackend } from '../sheets/reportSheet.ts';

/**
 * Finding F-B3-1 (fixed here): legacy's cleanup takes every '💾 ' tab whose last column-A value is a date older than
 * 90 days. That prefix also names the data-store tabs, among them append-only histories that must never be deleted
 * ('💾 13F Cache' can go 90 days without a new filing). The command hides these tabs from the scan; the oracle-tested
 * findStalePriceCacheSheets / cleanupPriceCacheSheets are unchanged.
 */
export const CLEANUP_PROTECTED_TABS: ReadonlySet<string> = new Set([
  Tabs.INSTITUTIONAL_HISTORY, Tabs.BROKER_DATA_HISTORY, Tabs.MACRO_SNAPSHOT, Tabs.FUNDAMENTALS_HISTORY, Tabs.SCRIPT_PROPERTIES,
  RS_RANKING_TAB, FUNDAMENTALS_SERIES_TAB, MIGRATION_MARKER_TAB,
]);

export const MENU_COMMANDS = [
  'options', 'options-call', 'options-diagnose', 'chart', 'exit-report', 'position',
  'check-keys', 'cleanup-price-caches', 'sheet-size', 'methodology', 'help',
] as const;
export type MenuCommand = (typeof MENU_COMMANDS)[number];

export function isMenuCommand(c: unknown): c is MenuCommand {
  return typeof c === 'string' && (MENU_COMMANDS as readonly string[]).includes(c);
}

export async function runMenuCommand(cmd: MenuCommand, rest: readonly string[], io: CliIo, over: EntryOverrides = {}): Promise<number> {
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const args = rest.filter((a) => !a.startsWith('--'));
  const env = io.env ?? process.env;
  const say = (lines: readonly string[]): void => { if (lines.length) io.out(lines.join('\n') + '\n'); };

  if (cmd === 'help') { say([cliHelpText()]); return 0; }
  if (cmd === 'check-keys') {
    const shown: string[] = [];
    const r = checkApiKeysConfigured({ env, log: (m) => io.err(m + '\n'), alert: (m) => { shown.push(m); } });
    say(r.missing.length ? shown : ['All 4 required API keys are present.']);
    return r.missing.length ? 1 : 0;
  }

  const ticker = (args[0] ?? '').trim().toUpperCase();
  // F-G1: refused before anything is fetched.
  if (cmd === 'options-call' && !ticker) { io.err('Please give a ticker symbol, for example: options-call TSLA\n'); return 2; }
  if (cmd === 'position' && (!ticker || args.length < 3)) { io.err('Please give the ticker, the entry price and the entry date, for example: position TSLA 250 2025-03-03\n'); return 2; }

  const s = await composeServices({
    storage: flags.has('--memory') ? 'memory' : 'sheets', env, mode: 'ticker', noAi: true,
    logLevel: flags.has('--debug') ? LogLevel.DEBUG : LogLevel.INFO, logSink: (l) => io.err(formatLine(l) + '\n'),
    ...(over.transport ? { transport: over.transport } : {}), ...(over.clock ? { clock: over.clock } : {}), ...(over.initialTabs ? { initialTabs: over.initialTabs } : {}),
  });
  const out: string[] = [];
  try {
    const run = await withSheetWrites(s, () => runOne(s, cmd, ticker, args, flags, out, over));
    say([...out, ...run.reportLines]);
    return run.value;
  } catch (e) {
    if (isUnlockFailure(e)) { say([...out, UNLOCK_FAILED_LINE]); return 1; }
    s.ctx.log.error('menu command ' + cmd + ' failed: ' + (e instanceof Error ? e.message : String(e)), { stack: e instanceof Error ? String(e.stack).split('\n').slice(0, 6).join(' | ') : '' });
    say([...out, 'The ' + cmd + ' command did not finish. Details are in the log.']);
    return 1;
  }
}

async function runOne(s: Services, cmd: MenuCommand, ticker: string, args: readonly string[], flags: ReadonlySet<string>, out: string[], over: EntryOverrides): Promise<number> {
  const log = textLog(s.ctx.log);
  switch (cmd) {
    case 'options': {
      const t = ticker || DEFAULT_TICKER;
      const wb = await s.openWorkbook(TICKER_RUN_PRELOAD);
      const r = await runFullAnalysis(s.optionsDeps(wb), t);
      await wb.flush();
      out.push(r ? 'Options analysis written for ' + t + '.' : 'The options analysis for ' + t + ' did not finish. Details are in the log.');
      return r ? 0 : 1;
    }
    case 'options-call': {
      const wb = await s.openWorkbook(TICKER_RUN_PRELOAD);
      out.push(await recommendedCallReport(s.optionsDeps(wb), ticker));
      await wb.flush();
      return 0;
    }
    case 'options-diagnose': {
      const wb = await s.openWorkbook(TICKER_RUN_PRELOAD);
      await diagnose(s.optionsDeps(wb));
      await wb.flush();
      // the diagnostic itself (URL, HTTP code, raw sample) is technical: log only
      const lines = tabText(wb, OptionsTabs.LOG, s.timeZone);
      for (const l of lines) log('options diagnostic: ' + l);
      const working = lines.some((l) => l.startsWith('RESULT') && l.includes('✅'));
      out.push(working ? 'The options data source is working.' : 'The options data source did not answer as expected. Details are in the log.');
      return working ? 0 : 1;
    }
    case 'chart': {
      const wb = await s.openWorkbook(ticker ? [ANALYSIS_TAB, PRICE_CHART_TAB] : ['*']);
      const charts: ChartStore = new Map();
      const r = await showPriceChart({
        workbook: chartWorkbook(wb, charts), fetchChart: (x) => s.fetchChart(x),
        entryLadder: (x) => computeStockEntryLadder(x as never), exitLadder: (x) => computeStockExitLadder(x as never),
        alert: (m) => { out.push(m); }, log,
      }, ticker ? { ticker } : {});
      await wb.flush();
      if (!r) return 1;
      const dir = over.outDir ?? 'out';
      const file = path.join(dir, priceChartFileName(r.ticker));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, renderPriceChartHtml(r as never));
      out.push('Price chart for ' + r.ticker + ' written to ' + file + ' (its data is on the ' + r.sheetName + ' tab).');
      return 0;
    }
    case 'exit-report': {
      const app = await buildNightlyApp(s);
      const job = app.deps.jobs['exit.report'];
      const o = job ? await job() : undefined;
      await s.flushStores();
      out.push(o && o.state === 'degraded' && o.reason ? o.reason : 'The Exit Strategy report was updated.');
      return 0;
    }
    case 'position': {
      const wb = await s.openWorkbook([POSITION_TAB]);
      const r = await analyzePosition(wb, ticker, Number(args[1]), String(args[2]), {
        fetchChart: async (x) => { const c = await s.fetchChart(x); return c ? toAnalysisChart(c as never) : null; }, log,
        runTime: runTimeText(s.clock.now(), s.timeZone),
      });
      await wb.flush();
      out.push(r.status === 'alert' ? r.alert : 'Position check for ' + ticker + ' written to the ' + r.sheetName + ' tab.');
      return r.status === 'alert' ? 1 : 0;
    }
    case 'cleanup-price-caches': {
      const wb = await openPriceCacheWorkbook(s.backend);
      const backend = s.backend;
      // Three spreadsheets: the price tabs live in the data spreadsheet once routing is on.
      const deleter = s.sheets ? sheetsTabDeleter(s.ctx, s.dataSheets ?? s.sheets)
        : async (name: string): Promise<void> => { if (backend instanceof MemoryWorkbookBackend) backend.tabs.delete(name); };
      const book = new DeletableWorkbook(wb, deleter);
      const view: CleanupWorkbook = {
        getSheets: () => book.getSheets().filter((sh) => !CLEANUP_PROTECTED_TABS.has(sh.getName())),
        getSheetByName: (n) => (CLEANUP_PROTECTED_TABS.has(n) ? null : book.getSheetByName(n)),
        deleteSheet: (sh) => book.deleteSheet(sh),
      };
      const r = await cleanupPriceCacheSheets({
        workbook: view, clock: s.clock, log, apply: flags.has('--yes'),
        alert: (m, title) => { out.push(title ? title + '\n' + m : m); },
        // the legacy YES/NO dialog: --yes is the YES
        confirm: () => true,
        toDate: serialAwareDate(s.timeZone),
      });
      if (r.mode === 'dry-run') out.push('Nothing was deleted. Run again with --yes to delete these tabs.');
      return 0;
    }
    case 'sheet-size': {
      const wb = await s.openWorkbook(['*']);
      diagnoseSheetSize(wb, { alert: (m) => { out.push(m); } });
      await wb.flush();
      return 0;
    }
    case 'methodology': {
      const wb = await s.openWorkbook([METHODOLOGY_TAB]);
      buildMethodologySheet(wb, { alert: (m) => { out.push(m); }, plainLabels: !s.opts.legacyParity });
      await wb.flush();
      return 0;
    }
    default:
      return 2; // help and check-keys never reach here
  }
}
