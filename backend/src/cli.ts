/**
 * The command line. `analyze TICKER` runs the full single-ticker analysis
 * (runAnalysisV7) on live data and prints the report as text; the
 * technical log goes to stderr, so stdout is the report alone.
 *
 *   node --env-file-if-exists=.env src/cli.ts analyze TSLA            no spreadsheet (every cache starts empty)
 *   node --env-file-if-exists=.env src/cli.ts analyze TSLA --sheet    the real spreadsheet, written at the end
 *   flags: --no-ai (skip Gemini), --debug (technical log at DEBUG), --legacy-parity
 *
 * The other commands are the legacy spreadsheet-menu items (app/menuCommands.ts); `cli help` lists them.
 * Every sheet write runs inside the Master Lock (app/sheetWrites.ts: unlock -> write -> lock again).
 *
 * Exit status: 0 when the analysis completed, 1 when it aborted, 2 on a usage error.
 */

import { finish } from './core/finish.ts';
import { runEntryMain } from './app/sheetGuardExit.ts';
import { compose, ANALYSIS_TAB, MODEL_TABS } from './compose.ts';
import { formatLine, LogLevel } from './core/logger.ts';
import { dataQualityLines, labelledReason } from './reports/messages/catalog.ts';
import { findReportLeaks } from './reports/messages/leakScan.ts';
import { dateStringInTz } from './analysis/macroRegime.ts';
import type { ReportWorkbook } from './sheets/reportSheet.ts';
import type { HttpTransport } from './net/http.ts';
import type { TickerArtifacts } from './analysis/runTicker.ts';
import { isMenuCommand, runMenuCommand } from './app/menuCommands.ts';
import { withSheetWrites, isUnlockFailure, UNLOCK_FAILED_LINE } from './app/sheetWrites.ts';

export const USAGE = [
  'usage: cli <command> [args]',
  '  analyze TICKER [--sheet] [--no-ai] [--debug] [--legacy-parity]   full analysis of one ticker, printed as text',
  'the legacy menu items (real spreadsheet; --memory = dry run on an empty workbook):',
  '  options [TICKER]                       options analysis (default TSLA): the options tabs, snapshot and overlay',
  '  options-call TICKER                    the recommended LEAPS and short-term calls, printed',
  '  options-diagnose                       one options-data connection check (details in the log)',
  '  chart [TICKER]                         price chart data tab plus out/<TICKER>-chart.html',
  '  exit-report                            the Exit Strategy report (the nightly step, run alone)',
  '  position TICKER ENTRY_PRICE ENTRY_DATE exit read for one position, on its own tab',
  '  check-keys                             which required API keys are missing (names only)',
  '  cleanup-price-caches [--yes]           price-cache tabs older than 90 days (deleted only with --yes)',
  '  sheet-size                             the size of every tab, written to a report tab',
  '  methodology                            the Methodology tab',
  '  help                                   what each command does (the old menu items)',
].join('\n');

export const DETAILS_IN_LOG = 'Details are in the log.';

/** A tab's cells as text lines: one line per non-empty row, cells joined by '  |  '. */
export function tabText(ss: ReportWorkbook, tab: string, timeZone: string): string[] {
  const sh = ss.getSheetByName(tab);
  if (!sh) return [];
  return sh.grid().map((row) => row
    .map((v) => (v instanceof Date ? dateStringInTz(v, timeZone) : String(v ?? '')).trim())
    .filter((s) => s !== '')
    .join('  |  '))
    .filter((l) => l !== '');
}

/** The data-quality box for the printed report: catalog lines, leak-scanned, one pointer to the log. Empty when clean. */
export function dataQualityBox(art: TickerArtifacts): string[] {
  if (!art.dataQuality.length) return [];
  const lines = dataQualityLines(art.dataQuality).map((l) => (findReportLeaks(l).length ? labelledReason('Data quality', 'SECTION_UNAVAILABLE') : l));
  return [...lines, DETAILS_IN_LOG];
}

/** The whole printed report for one run: data-quality box, dashboard, then each model tab. */
export function renderRunText(art: TickerArtifacts, ss: ReportWorkbook, timeZone: string): string {
  const out: string[] = [];
  const rule = (t: string) => out.push('', '══════ ' + t + ' ══════');
  rule(art.ticker + ' — ' + ANALYSIS_TAB);
  const box = dataQualityBox(art);
  if (box.length) out.push(...box, '');
  out.push(...tabText(ss, ANALYSIS_TAB, timeZone));
  for (const tab of Object.values(MODEL_TABS)) {
    const text = art.texts[tab];
    if (text == null) continue;
    rule(tab);
    out.push(text);
  }
  return out.join('\n') + '\n';
}

export interface CliIo {
  readonly out: (s: string) => void;
  readonly err: (s: string) => void;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export const STD_IO: CliIo = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) };

/** Tests and `record`: a transport or clock instead of the network and the system time. */
export interface CliOverrides {
  readonly transport?: HttpTransport;
  readonly clock?: { now(): number };
}

export async function main(argv: readonly string[], io: CliIo = STD_IO, over: CliOverrides = {}): Promise<number> {
  const [cmd, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const args = rest.filter((a) => !a.startsWith('--'));
  if (cmd !== 'analyze') {
    if (isMenuCommand(cmd)) return runMenuCommand(cmd, rest, io);
    io.err(USAGE + '\n'); return 2;
  }
  const ticker = (args[0] ?? '').trim().toUpperCase();
  // F-G1: a missing ticker is refused before anything is fetched.
  if (!ticker) { io.err('Please give a ticker symbol, for example: analyze TSLA\n'); return 2; }
  const c = await compose({
    storage: flags.has('--sheet') ? 'sheets' : 'memory', env: io.env, noAi: flags.has('--no-ai'), legacyParity: flags.has('--legacy-parity'),
    logLevel: flags.has('--debug') ? LogLevel.DEBUG : LogLevel.INFO, logSink: (l) => io.err(formatLine(l) + '\n'),
    ...(over.transport ? { transport: over.transport } : {}), ...(over.clock ? { clock: over.clock } : {}),
  });
  let art: TickerArtifacts;
  let lockLines: readonly string[] = [];
  try {
    const run = await withSheetWrites(c, async () => { const a = await c.analyze(ticker); await c.flush(); return a; });
    art = run.value; lockLines = run.reportLines;
  } catch (e) {
    if (isUnlockFailure(e)) { io.out(UNLOCK_FAILED_LINE + '\n'); return 1; }
    throw e;
  }
  io.out(renderRunText(art, c.workbook, c.timeZone) + (lockLines.length ? lockLines.join('\n') + '\n' : ''));
  return art.aborted ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Three spreadsheets: a maintenance pause ends cleanly (exit 0), a guard refusal with exit 2 (app/sheetGuardExit.ts).
  runEntryMain(() => main(process.argv.slice(2)), STD_IO, { notify: false }, finish);
}
