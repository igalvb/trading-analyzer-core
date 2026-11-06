/**
 * `npm run exit-report-pdf -- [--memory] [--no-send] [--out DIR]`
 *
 * The nightly's Exit step alone (the same job as the `exit-report` menu command: every holding on the
 * Portfolio tab -> the Exit Report tab and Exit Target History, inside the Master Lock), then the
 * Exit Report tab as a PDF to Telegram, the bottom line as its caption (notify/policy.ts). Nothing here computes a number: the
 * PDF shows the cells the Exit step wrote.
 * Exit: 0 done, 1 the step or the PDF/Telegram failed, 2 configuration.
 */

import { finish } from './core/finish.ts';
import { runEntryMain } from './app/sheetGuardExit.ts';
import { STD_IO, type CliIo } from './cli.ts';
import { composeServices, type Services } from './compose.ts';
import { formatLine, LogLevel } from './core/logger.ts';
import { withSheetWrites, isUnlockFailure, UNLOCK_FAILED_LINE } from './app/sheetWrites.ts';
import { buildNightlyApp } from './app/nightlyApp.ts';
import { EXIT_SHEET_TAB } from './reports/exitSheet/text.ts';
import type { ReportWorkbook } from './sheets/reportSheet.ts';
import type { EntryOverrides } from './ticker.ts';
import { tabHtml, reportDocument } from './reports/pdf/workbookHtml.ts';
import { notifyIfNeeded, bottomLine } from './notify/policy.ts';
import { exitActionCounts, exitCountsText } from './reports/digest/nightlyDigest.ts';
import type { ExitReportInput } from './reports/exitSheet/types.ts';
import { prepareDelivery, deliverPdf, dateStamp, type DeliverDeps } from './reports/pdf/deliver.ts';

export interface ExitReportPdfDeps extends DeliverDeps {
  readonly over?: EntryOverrides;
  readonly now?: () => number;
}

export async function exitReportPdfMain(argv: readonly string[], io: CliIo = STD_IO, deps: ExitReportPdfDeps = {}): Promise<number> {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const outIdx = argv.indexOf('--out');
  const outDir = outIdx >= 0 ? (argv[outIdx + 1] ?? 'out') : 'out';
  const d = prepareDelivery(io, !flags.has('--no-send'), deps, '');
  if (!d) return 2;
  const over = deps.over ?? {};
  const base = await composeServices({
    storage: flags.has('--memory') ? 'memory' : 'sheets', env: io.env ?? process.env, mode: 'ticker', noAi: true,
    logLevel: flags.has('--debug') ? LogLevel.DEBUG : LogLevel.INFO, logSink: (l) => io.err(formatLine(l) + '\n'),
    ...(over.transport ? { transport: over.transport } : {}), ...(over.clock ? { clock: over.clock } : {}), ...(over.initialTabs ? { initialTabs: over.initialTabs } : {}),
  });
  // Keep the workbooks the Exit step opens, to draw the tab it wrote.
  const opened: ReportWorkbook[] = [];
  const s: Services = { ...base, openWorkbook: async (p) => { const w = await base.openWorkbook(p); opened.push(w); return w; } };
  let reason = '';
  let stepFailed = false;
  let built: ExitReportInput | null = null;
  try {
    await withSheetWrites(s, async () => {
      const app = await buildNightlyApp(s);
      const job = app.deps.jobs['exit.report'];
      const o = job ? await job() : undefined;
      built = app.digest.exit?.input ?? null;
      if (!job) stepFailed = true;
      if (o && o.state === 'degraded' && o.reason) reason = o.reason;
      await s.flushStores();
    });
  } catch (e) {
    if (isUnlockFailure(e)) { io.out(UNLOCK_FAILED_LINE + '\n'); return 1; }
    // A whole step the report depends on: CRITICAL in the run log (raw text in detail, never in the report).
    base.ctx.log.critical('exit report step failed; no Exit Report is sent', { detail: e instanceof Error ? e.stack ?? e.message : String(e) });
    stepFailed = true;
  }
  const sheet = opened.map((w) => w.getSheetByName(EXIT_SHEET_TAB)).find((sh) => sh && (sh.calls.length || sh.created)) ?? null;
  const section = sheet ? tabHtml(sheet, base.timeZone) : null;
  if (stepFailed || !section) {
    io.out('Exit report: the step did not finish (details in the log).\n');
    if (d.send) await notifyIfNeeded({ deps: d.tg, chatId: d.chatId }, '⚠️ Exit Report: the run did not finish. Details are in the GitHub run log.', (m) => base.ctx.log.warning('Telegram: the did-not-finish notice could not be sent', { detail: m }));
    return 1;
  }
  const now = (deps.now ?? Date.now)();
  const when = new Date(now).toLocaleString('en-GB', { timeZone: base.timeZone, dateStyle: 'medium', timeStyle: 'short' });
  const html = reportDocument({ title: 'Exit Strategy Report', subtitle: when + ' (New York time)', facts: [], lines: reason ? [reason] : ['Every holding on the Portfolio tab, with its action, stop, targets, how many to sell and tax.'] }, [section], null);
  const sent = await deliverPdf(io, d, {
    label: 'Exit report', html, outDir, pdfName: `v13-report-exit-${dateStamp(now)}.pdf`,
    caption: exitCaption(built, when, reason),
  });
  return sent;
}

/** The bottom line: "Exit Report 5 Nov 2026, 21:10: 1 EXIT, 13 HOLD", and the step's partial reason on a second line. */
export function exitCaption(input: ExitReportInput | null, when: string, reason = ''): string {
  return bottomLine('Exit Report ' + when, [input ? exitCountsText(exitActionCounts(input)) : null], reason ? '⚠️ ' + reason : null);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Three spreadsheets: a maintenance pause ends cleanly (exit 0), a guard refusal with exit 2 (app/sheetGuardExit.ts).
  runEntryMain(() => exitReportPdfMain(process.argv.slice(2)), STD_IO, { notify: !process.argv.includes('--no-send') }, finish);
}
