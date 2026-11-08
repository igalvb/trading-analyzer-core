/**
 * `npm run dashboard-build -- [--out out/dashboard] [--data FILE] [--memory] [--debug]`
 *
 * Builds the phone dashboard's site folder (docs/DASHBOARD.md): reads the tabs the runs wrote (dashboard/data.ts; no
 * fetch, nothing written to any sheet), then writes the app shell, data/dashboard.json, the Pages Function and the
 * icons (dashboard/site.ts). The workflows then upload the folder to Cloudflare Pages (wrangler), when the owner has
 * set that up.
 *   --data FILE   use this JSON as data/dashboard.json instead of reading the sheets (a fake file for a local look)
 *   --memory      no spreadsheet (every section empty; checks the build itself)
 * The GitHub minutes are asked from GitHub when GITHUB_TOKEN and GITHUB_REPOSITORY are set (the Nightly), else they
 * are summed from 🩺 Run Health. The ledger (net worth, growth graph) is read from a checked-out `data` branch:
 * DATA_BRANCH_DIR, default <repo>/data-branch; without it those two sections are left out. The growth graph's estimated
 * past (ledger/estimate.ts) reads the long price history of the held tickers from LONG_HISTORY_DIR (default
 * ../long-history/prices, the `prices` branch the workflows check out; read whatever LONG_HISTORY says, display only);
 * without it there is no estimate. Prints the file list and the sections left out; never a value, id or key.
 * Exit: 0 written, 2 configuration (no sheet access), 1 the folder could not be written.
 */

import fs from 'node:fs';
import path from 'node:path';
import { finish } from './core/finish.ts';
import { runEntryMain } from './app/sheetGuardExit.ts';
import { STD_IO, type CliIo } from './cli.ts';
import { composeServices } from './compose.ts';
import { formatLine, LogLevel } from './core/logger.ts';
import type { EntryOverrides } from './ticker.ts';
import { activeProfile } from './profile/active.ts';
import { LABELS } from './profile/labels.ts';
import { buildDashboard, readDashboardSources } from './dashboard/data.ts';
import { writeSite } from './dashboard/site.ts';
import { readLedgerSources, DEFAULT_DATA_BRANCH_DIR } from './ledger/networth.ts';
import { neededSeries, readPriceSeries } from './ledger/estimate.ts';
import { journalSeriesKeys } from './ledger/journal.ts';
import { longHistoryFromEnv } from './storage/longHistory.ts';
import { readActionsMinutes, FREE_MINUTES } from './reports/digest/actionsMinutes.ts';
import { fetchYahooChartRaw } from './fetch/yahoo.ts';

export interface DashboardBuildDeps {
  readonly over?: EntryOverrides;
  readonly now?: () => number;
  readonly fetchImpl?: typeof fetch;
}

/** The core version (the VERSION file at the repository root), or null. */
function coreVersion(): string | null {
  const p = path.resolve(import.meta.dirname, '..', '..', 'VERSION');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() || null : null;
}

export async function dashboardBuildMain(argv: readonly string[], io: CliIo = STD_IO, deps: DashboardBuildDeps = {}): Promise<number> {
  const arg = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const env = io.env ?? process.env;
  const outDir = path.resolve(arg('--out') ?? 'out/dashboard');
  const dataFile = arg('--data');
  let json: string;
  if (dataFile) {
    if (!fs.existsSync(dataFile)) { io.err('--data: no file at ' + dataFile + '\n'); return 2; }
    json = fs.readFileSync(dataFile, 'utf8');
  } else {
    const over = deps.over ?? {};
    const s = await composeServices({
      storage: argv.includes('--memory') ? 'memory' : 'sheets', env, mode: 'ticker', noAi: true,
      logLevel: argv.includes('--debug') ? LogLevel.DEBUG : LogLevel.INFO, logSink: (l) => io.err(formatLine(l) + '\n'),
      ...(over.transport ? { transport: over.transport } : {}), ...(over.clock ? { clock: over.clock } : {}), ...(over.initialTabs ? { initialTabs: over.initialTabs } : {}),
    });
    const now = (deps.now ?? (() => s.clock.now()))();
    const log = (m: string): void => s.ctx.log.warning(m);
    const ledgerDir = path.resolve(env.DATA_BRANCH_DIR || DEFAULT_DATA_BRANCH_DIR);
    const ledger = readLedgerSources(ledgerDir, s.ctx.log);
    if (!ledger) s.ctx.log.info('dashboard: no ledger folder (the data branch is not checked out); net worth and growth left out');
    const priceHistory = ledger?.holdings ? readPriceSeries(path.resolve(longHistoryFromEnv(env).dir), neededSeries(ledger.holdings), s.ctx.log) : null;
    if (ledger?.holdings) s.ctx.log.info('dashboard: long price history for the growth estimate: ' + (priceHistory?.size ?? 0) + ' of ' + neededSeries(ledger.holdings).length + ' tickers');
    // The advice journal (ledger/journal.ts): its tickers and QQQ from the same long price history (display only).
    const journalPrices = ledger?.journal?.length ? readPriceSeries(path.resolve(longHistoryFromEnv(env).dir), journalSeriesKeys(ledger.journal), s.ctx.log) : null;
    if (ledger?.journal?.length) s.ctx.log.info('dashboard: advice journal ' + ledger.journal.length + ' line(s); price history for ' + (journalPrices?.size ?? 0) + ' of ' + journalSeriesKeys(ledger.journal).length + ' tickers');
    const sources = { ...(await readDashboardSources(s.tabStore, log)), ledger, priceHistory, journalPrices };
    const minutes = env.GITHUB_TOKEN && env.GITHUB_REPOSITORY
      ? await readActionsMinutes({ env, now, totalTimeoutMs: 30_000, log: (m) => s.ctx.log.info(m), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl as never } : {}) })
        .then((m) => ({ used: m.minutes, cap: FREE_MINUTES }), (e: unknown) => { log('dashboard: GitHub minutes not read (' + String(e instanceof Error ? e.message : e).slice(0, 120) + '); summed from Run Health'); return null; })
      : null;
    // Today's USD/ILS for the net worth screen (Yahoo ILS=X); without it the newest snapshot's rate is used.
    const fxChart = ledger ? await fetchYahooChartRaw(s.http, 'ILS=X', '1mo').catch(() => null) : null;
    const fxLast = fxChart && fxChart.closes.length ? fxChart.closes[fxChart.closes.length - 1] ?? null : null;
    const fxUsdIls = fxLast != null && Number.isFinite(fxLast) && fxLast > 0 ? { usdIls: fxLast, date: new Date(now).toISOString().slice(0, 10) } : null;
    if (ledger && !fxUsdIls) s.ctx.log.info('dashboard: USD/ILS not read today; the newest snapshot rate is used');
    const p = activeProfile();
    const data = buildDashboard(sources, {
      ...(fxUsdIls ? { fxUsdIls } : {}),
      nowMs: now, taxRate: p.tax.rate, list: p.lists.core, labels: { list: LABELS.list, holdCore: LABELS.holdCoreShort, holdList: LABELS.holdList },
      timeZone: p.user.timeZone, version: coreVersion(), paper: { start: p.paper.start, end: p.paper.end }, minutes, logger: s.ctx.log,
    });
    json = JSON.stringify(data);
    io.out('Dashboard data: ' + Math.round(json.length / 1024) + ' KB; sections left out: ' + (data.missing.length ? data.missing.join(', ') : 'none') + '\n');
  }
  const files = await Promise.resolve().then(() => writeSite(outDir, json)).catch((e: unknown) => { io.err('Dashboard: the folder could not be written: ' + String(e) + '\n'); return null; });
  if (!files) return 1;
  io.out('Dashboard: ' + files.length + ' files written to ' + outDir + ' (' + files.join(', ') + ')\n');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runEntryMain(() => dashboardBuildMain(process.argv.slice(2)), STD_IO, { notify: false }, finish);
}
