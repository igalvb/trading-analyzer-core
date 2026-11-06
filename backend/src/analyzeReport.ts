/**
 * `npm run analyze-report -- TICKER [--memory] [--no-ai] [--no-opus] [--no-send] [--out DIR]`
 *
 * The Full Ticker Analysis (the same run as `npm run ticker`, Sheet written unless --memory), then:
 *   - one PDF: a cover page (verdict, conviction, timing, price), then every report tab the run produced
 *     (TickerJob.produced: the fixed tabs it wrote after the phase-1 reset, reports/fixedTabs.ts),
 *     in reading order (reportTabOrder: Bottom Line, All Models, Analysis, every model, LILO, the comparison,
 *     the Options Decision, the options tabs),
 *     then the price chart;
 *   - the PDF to TELEGRAM_CHAT_ID with the bottom line as its caption, no separate message (skipped with --no-send).
 * Row 30: when the ticker is on the Portfolio sheet, its exit plan (the nightly's Exit step for that holding alone,
 * reports/exitPlan.ts) is the first page after the cover, and the caption says the action.
 * Owner 2026-11-01: with the AI on, Claude Opus gives a second opinion on Gemini's review (ai/analyzeOpus.ts; off with
 * --no-opus): its text sits under Gemini's on the Analysis page (Sheet and PDF), its one-line summary is on the cover. No key: one plain line, the run goes on. Display only.
 * The PDF is also saved to out/ (the workflow keeps it as an artifact).
 * Nothing here computes a score: the PDF shows the cells the run wrote.
 * Exit: 0 done, 1 the analysis aborted or the PDF/Telegram failed, 2 usage or configuration.
 */

import { processLine } from './core/logFile.ts';
import { finish } from './core/finish.ts';
import { runEntryMain } from './app/sheetGuardExit.ts';
import { runTickerJob, type TickerJob } from './ticker.ts';
import { STD_IO, type CliIo } from './cli.ts';
import { ANALYSIS_TAB, MODEL_TABS } from './analysis/runTicker.ts';
import { BOTTOM_LINE_TAB } from './reports/bottomLine/summarySheet.ts';
import { OptionsTabs } from './reports/options/tabs.ts';
import { tabHtml, reportDocument, type ReportCover } from './reports/pdf/workbookHtml.ts';
import { bottomLine } from './notify/policy.ts';
import { prepareDelivery, deliverPdf, dateStamp, type DeliverDeps } from './reports/pdf/deliver.ts';
import type { ReportSheet } from './sheets/reportSheet.ts';
import { heldExitPlan, type HeldExitPlan } from './reports/exitPlan.ts';

/**
 * The tabs in reading order (FL-17e, owner 2026-10-28): Bottom Line, All Models, Analysis, each model on its own page,
 * LILO, the model comparison, the Options Decision, then the options tabs. Puts are left out (long-only); the log and
 * data tabs are not reports. The names are fixed (phase 1): the same for every ticker.
 */
export function reportTabOrder(): string[] {
  return [
    BOTTOM_LINE_TAB, MODEL_TABS.allModels, ANALYSIS_TAB,
    MODEL_TABS.broker, MODEL_TABS.schabacker, MODEL_TABS.edwardsMagee, MODEL_TABS.turtle,
    MODEL_TABS.wyckoff, MODEL_TABS.marketMaker, MODEL_TABS.trend, MODEL_TABS.combo, MODEL_TABS.lilo, MODEL_TABS.liloV2, MODEL_TABS.profitTaking, MODEL_TABS.meanReversion, MODEL_TABS.pair, MODEL_TABS.winners, MODEL_TABS.cycle, MODEL_TABS.qualityGate, MODEL_TABS.comparison,
    MODEL_TABS.optionsDecision, MODEL_TABS.jamesLeaps, MODEL_TABS.jamesFairValue,
    OptionsTabs.DASHBOARD, OptionsTabs.TOP10, OptionsTabs.CALLS, OptionsTabs.BUCKETS, OptionsTabs.GAMMA,
  ];
}

const fmtPrice = (n: unknown): string => (typeof n === 'number' && Number.isFinite(n) ? '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—');
const TIMING: Readonly<Record<string, string>> = { BUY_NOW: 'Buy now', WAIT_PULLBACK: 'Wait for pullback', AVOID: 'Avoid' };
const BAND: Readonly<Record<string, string>> = { own: 'Strong', mixed: 'Mixed', weak: 'Weak', unknown: 'Unknown' };

/** The verdict in a few fields, from the run's own decision (no new numbers). */
export function verdictOf(job: TickerJob): { action: string; conviction: string; timing: string; fundamentals: string; price: string; headline: string } {
  const d = job.art?.result?.decision as { action?: string; finalConviction?: number; timing?: string; fundBand?: string; headline?: string } | undefined;
  return {
    action: d?.action ?? (job.art?.aborted ? 'Not analysed' : '—'),
    conviction: typeof d?.finalConviction === 'number' ? d.finalConviction + '/100' : '—',
    timing: d?.timing ? (TIMING[d.timing] ?? d.timing) : '—',
    fundamentals: d?.fundBand ? (BAND[d.fundBand] ?? d.fundBand) : '—',
    price: fmtPrice(job.art?.chart?.currentPrice),
    headline: d?.headline ?? job.art?.aborted ?? '',
  };
}

export function reportHtml(job: TickerJob, nowMs: number, exitPlan: HeldExitPlan | null = null): string {
  const v = verdictOf(job);
  const when = new Date(nowMs).toLocaleString('en-GB', { timeZone: job.timeZone || 'America/New_York', dateStyle: 'medium', timeStyle: 'short' });
  const cover: ReportCover = {
    title: job.ticker + ' — Full Ticker Analysis',
    subtitle: when + ' (New York time)',
    facts: [['Verdict', v.action], ['Conviction', v.conviction], ['Timing', v.timing], ['Fundamentals', v.fundamentals], ['Price', v.price]],
    lines: [v.headline, ...(job.art?.opusReview ? ['', job.art.opusReview.summary] : []), ...(job.art?.dataQuality.length ? ['', 'Some data was missing; see the Data quality box on the Analysis page.'] : [])].filter((l, i) => l !== '' || i > 0),
  };
  const sections: string[] = [];
  const plan = exitPlan ? tabHtml(exitPlan.sheet, job.timeZone) : null;
  if (plan) sections.push(plan);
  const wb = job.workbook;
  if (wb) {
    // only the pages this run produced: the reset left a "not produced" line on every other fixed tab
    for (const name of reportTabOrder()) {
      if (!job.produced.has(name)) continue;
      const sh: ReportSheet | null = wb.getSheetByName(name);
      if (!sh) continue;
      const h = tabHtml(sh, job.timeZone);
      if (h) sections.push(h);
    }
  }
  return reportDocument(cover, sections, job.chartHtml);
}

/**
 * The Telegram caption, the bottom line (notify/policy.ts; no separate message): "TSLA — Buy · 72/100 · Buy now ·
 * $250.00 · held: HOLD" and the headline on a second line. Opus's summary and the rest are on the PDF's cover.
 */
export function telegramCaption(job: TickerJob, exitPlan: HeldExitPlan | null = null): string {
  const v = verdictOf(job);
  return bottomLine(`${job.ticker} — ${v.action}`, [v.conviction !== '—' ? v.conviction : null, v.timing !== '—' ? v.timing : null, v.price !== '—' ? v.price : null, exitPlan ? 'held: ' + (exitPlan.actions.join(' / ') || '—') : null], v.headline || null);
}

/** The run log's one-line result: verdict, conviction, timing, price, entry zone, stop and reward to risk. */
export function resultFields(job: TickerJob): Record<string, string | number | null> {
  const v = verdictOf(job);
  const tp = (job.art?.result as { techPlan?: { entryLow?: unknown; entryHigh?: unknown; stop?: unknown; rrToT1?: unknown } } | undefined)?.techPlan;
  const n = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
  return { verdict: v.action, conviction: v.conviction, timing: v.timing, price: v.price, entryLow: n(tp?.entryLow), entryHigh: n(tp?.entryHigh), stop: n(tp?.stop), rrToT1: n(tp?.rrToT1) };
}

export interface AnalyzeReportDeps extends DeliverDeps {
  readonly run?: (argv: readonly string[], io: CliIo) => Promise<TickerJob>;
  /** Tests: the held ticker's exit plan (default: reports/exitPlan.ts with the run's services). */
  readonly exitPlan?: (job: TickerJob) => Promise<HeldExitPlan | null>;
  readonly now?: () => number;
}

export async function analyzeReportMain(argv: readonly string[], io: CliIo = STD_IO, deps: AnalyzeReportDeps = {}): Promise<number> {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const outIdx = argv.indexOf('--out');
  const outDir = outIdx >= 0 ? (argv[outIdx + 1] ?? 'out') : 'out';
  const ticker = (argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out')[0] ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9.^-]{1,12}$/.test(ticker)) { io.err('Please give a ticker symbol, for example: npm run analyze-report -- TSLA\n'); return 2; }
  const d = prepareDelivery(io, !flags.has('--no-send'), deps, '');
  if (!d) return 2;

  const passOn = [ticker, ...(flags.has('--memory') ? ['--memory'] : []), ...(flags.has('--no-ai') ? ['--no-ai'] : flags.has('--no-opus') ? [] : ['--opus']), ...(flags.has('--debug') ? ['--debug'] : [])];
  const job = await (deps.run ?? ((a, i) => runTickerJob(a, i)))(passOn, { ...io, out: (s) => io.err(s) });
  if (!job.workbook) { io.out(`${ticker}: the analysis did not run (details in the log).\n`); return job.code || 1; }

  // Fix 2026-11-06: the run log carries the bottom line and the levels (they were only in the PDF), so a batch of runs
  // can be read back from the logs (e.g. buy zones for the whole list on a sharp-drop day).
  processLine('INFO', 'analyze:' + ticker, 'result', resultFields(job), io.env ?? process.env, (t) => io.err(t));
  const now = (deps.now ?? Date.now)();
  const plan = await (deps.exitPlan ?? ((j: TickerJob) => (j.services ? heldExitPlan(j.services, j.ticker, j.art) : Promise.resolve(null))))(job).catch((e) => {
    processLine('WARNING', 'analyze:' + ticker, 'exit plan not added to the report', { detail: String(e) }, io.env ?? process.env, (t) => io.err(t));
    return null;
  });
  const sent = await deliverPdf(io, d, {
    label: ticker, html: reportHtml(job, now, plan), outDir,
    pdfName: `v13-report-${ticker.replace(/[^A-Z0-9.-]/g, '_')}-analysis-${dateStamp(now)}.pdf`,
    caption: telegramCaption(job, plan),
  });
  return sent || job.code;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Three spreadsheets: a maintenance pause ends cleanly (exit 0), a guard refusal with exit 2 (app/sheetGuardExit.ts).
  runEntryMain(() => analyzeReportMain(process.argv.slice(2)), STD_IO, { notify: !process.argv.includes('--no-send') }, finish);
}
