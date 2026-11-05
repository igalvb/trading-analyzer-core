/**
 * `npm run ticker -- TICKER [--ladder-stock] [--ladder-options] [--stock-only] [--memory] [--no-ai] [--debug]`:
 * the Full Ticker Analysis (runCompleteTickerAnalysisV7Continued, jobs/automation/tickerRuns.ts):
 * the options analysis (its six tabs, snapshot and overlay), then the stock analysis fed the
 * options picks, the price chart, and the Bottom Line summary -- all on the real spreadsheet,
 * written once at the end. `--stock-only` is runAnalysisV7FromMenu (the stock analysis alone).
 *
 * The price chart: Sheets charts are not written through the API by this backend, so the chart
 * is saved as out/<TICKER>-chart.html (ops/priceChartHtml.ts, F-C1); --no-chart-file skips it.
 * stdout is the printed report (cli.ts renderRunText); the technical log goes to stderr.
 * Phase 1 (docs/SHEETS_CLEANUP_PLAN.md (c)): the run first resets the 20 fixed analysis tabs
 * (reports/fixedTabs.ts) and keeps the set of pages it then produced (TickerJob.produced, the PDF's list).
 * Exit status: 0 completed, 1 aborted, 2 usage error.
 */

import { finish } from './core/finish.ts';
import { runEntryMain } from './app/sheetGuardExit.ts';
import fs from 'node:fs';
import path from 'node:path';
import { compose, type Services } from './compose.ts';
import { formatLine, LogLevel, textLog } from './core/logger.ts';
import type { CliIo } from './cli.ts';
import { STD_IO, renderRunText } from './cli.ts';
import { runCompleteTickerAnalysisContinued, type TickerRunDeps } from './jobs/automation/tickerRuns.ts';
import { runFullAnalysis } from './reports/options/run.ts';
import { showPriceChart, chartWorkbook, type ChartStore } from './ops/priceChart.ts';
import { renderPriceChartHtml, priceChartFileName } from './ops/priceChartHtml.ts';
import { computeStockEntryLadder, computeStockExitLadder } from './analysis/ladders.ts';
import { buildBottomLineSummary } from './reports/bottomLine/summarySheet.ts';
import type { TickerArtifacts } from './analysis/runTicker.ts';
import type { ReportWorkbook } from './sheets/reportSheet.ts';
import type { HttpTransport } from './net/http.ts';
import { withSheetWrites, isUnlockFailure, UNLOCK_FAILED_LINE } from './app/sheetWrites.ts';
import { resetFixedAnalysisTabs, finishFixedAnalysisTabs } from './reports/fixedTabs.ts';

export interface EntryOverrides {
  readonly transport?: HttpTransport;
  readonly clock?: { now(): number };
  readonly initialTabs?: Record<string, unknown[][]>;
  /** Where the chart file goes (default ./out). */
  readonly outDir?: string;
  /** Tests: a fake Claude SDK for `--opus` (Analyze's second opinion). */
  readonly claudeSdk?: import('./ai/claudeReview.ts').ClaudeSdk;
}

/** What one Full Ticker Analysis produced: the exit code, the workbook it wrote, the analysis, the chart page. */
export interface TickerJob {
  readonly code: number;
  readonly ticker: string;
  readonly workbook: ReportWorkbook | null;
  readonly timeZone: string;
  readonly art: TickerArtifacts | null;
  readonly chartHtml: string | null;
  /** Master Lock lines for the printed report. */
  readonly lockLines: readonly string[];
  /** The fixed analysis tabs this run wrote after the reset (reports/fixedTabs.ts); the PDF prints only these. */
  readonly produced: ReadonlySet<string>;
  /** Row 30: the run's services (Analyze reads the Portfolio with them for a held ticker's exit plan). */
  readonly services?: Services;
}

export async function tickerMain(argv: readonly string[], io: CliIo = STD_IO, over: EntryOverrides = {}): Promise<number> {
  const job = await runTickerJob(argv, io, over);
  if (!job.workbook) return job.code;
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  if (job.chartHtml && !flags.has('--no-chart-file')) {
    const dir = over.outDir ?? 'out';
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, priceChartFileName(job.ticker)), job.chartHtml);
    io.err('price chart written to ' + path.join(dir, priceChartFileName(job.ticker)) + '\n');
  }
  if (job.art) io.out(renderRunText(job.art, job.workbook, job.timeZone));
  if (job.lockLines.length) io.out(job.lockLines.join('\n') + '\n');
  return job.code;
}

/** The Full Ticker Analysis without printing: tickerMain prints it, analyzeReport turns it into a PDF. */
export async function runTickerJob(argv: readonly string[], io: CliIo = STD_IO, over: EntryOverrides = {}): Promise<TickerJob> {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const ticker = (argv.filter((a) => !a.startsWith('--'))[0] ?? '').trim().toUpperCase();
  // F-G1: refused before anything is fetched.
  if (!ticker) { io.err('Please give a ticker symbol, for example: npm run ticker -- TSLA\n'); return { code: 2, ticker, workbook: null, timeZone: '', art: null, chartHtml: null, lockLines: [], produced: new Set() }; }
  const c = await compose({
    storage: flags.has('--memory') ? 'memory' : 'sheets', env: io.env, mode: 'ticker', noAi: flags.has('--no-ai'),
    ...(flags.has('--opus') ? { opus: over.claudeSdk ? { sdk: over.claudeSdk } : {} } : {}),
    logLevel: flags.has('--debug') ? LogLevel.DEBUG : LogLevel.INFO, logSink: (l) => io.err(formatLine(l) + '\n'),
    ...(over.transport ? { transport: over.transport } : {}), ...(over.clock ? { clock: over.clock } : {}), ...(over.initialTabs ? { initialTabs: over.initialTabs } : {}),
  });
  const log = textLog(c.ctx.log);
  let last: TickerArtifacts | null = null;
  const charts: ChartStore = new Map();
  let chartHtml: string | null = null;
  const runAnalysis: TickerRunDeps['runAnalysis'] = async (t, ls, lo, leaps, short) => {
    last = await c.analyze(t, !!ls, !!lo, leaps, short);
    return (last.result as never) ?? null;
  };
  const deps: TickerRunDeps = {
    workbook: c.workbook, clock: c.clock, log,
    runOptionsAnalysis: (t) => runFullAnalysis(c.optionsDeps(c.workbook), t) as never,
    runAnalysis,
    showPriceChart: async (t, techPlan, decision, showLadder, recCall) => {
      const r = await showPriceChart({
        workbook: chartWorkbook(c.workbook, charts), fetchChart: (x) => c.fetchChart(x),
        entryLadder: (x) => computeStockEntryLadder(x as never), exitLadder: (x) => computeStockExitLadder(x as never),
        alert: (m) => io.err(m + '\n'), log,
      }, { ticker: t, techPlan: techPlan as never, decision: decision as never, showLadder, recCall: recCall as never });
      if (r) chartHtml = renderPriceChartHtml(r as never);
      return r;
    },
    buildBottomLineSummary: async (ss, t, fr, tp, dec, leaps, short) => buildBottomLineSummary(ss, t, fr as never, tp as never, dec as never, leaps as never, short as never, {
      clock: c.clock, timeZone: c.timeZone, legacyReportText: c.settings.legacyReportText, onReportDetail: (l) => c.ctx.log.child(t).debug(l),
      extraModels: (last as TickerArtifacts | null)?.reports.extraModels ?? null,
      atBuyLimit: (last as TickerArtifacts | null)?.atBuyLimit?.text ?? null,
      nextResistance: (last as TickerArtifacts | null)?.nextResistance?.text ?? null,
    }),
  };
  let lockLines: readonly string[] = [];
  let produced: ReadonlySet<string> = new Set();
  try {
    const run = await withSheetWrites(c, async () => {
      const reset = resetFixedAnalysisTabs(c.workbook, ticker, c.clock.now(), c.timeZone);
      if (flags.has('--stock-only')) await runAnalysis(ticker, flags.has('--ladder-stock'), flags.has('--ladder-options'));
      else await runCompleteTickerAnalysisContinued(deps, ticker, flags.has('--ladder-stock'), flags.has('--ladder-options'));
      produced = finishFixedAnalysisTabs(c.workbook, reset);
      await c.flush();
    });
    lockLines = run.reportLines;
  } catch (e) {
    if (isUnlockFailure(e)) { io.out(UNLOCK_FAILED_LINE + '\n'); return { code: 1, ticker, workbook: null, timeZone: c.timeZone, art: null, chartHtml: null, lockLines: [], produced: new Set() }; }
    throw e;
  }
  const art = last as TickerArtifacts | null;
  return { code: art && !art.aborted ? 0 : 1, ticker, workbook: c.workbook, timeZone: c.timeZone, art, chartHtml, lockLines, produced, services: c };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Three spreadsheets: a maintenance pause ends cleanly (exit 0), a guard refusal with exit 2 (app/sheetGuardExit.ts).
  runEntryMain(() => tickerMain(process.argv.slice(2)), STD_IO, { notify: false }, finish);
}
