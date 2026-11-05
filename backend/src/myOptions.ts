/**
 * `npm run my-options`: refreshMyOptionsValue (myOptionsValueTracker.gs, jobs/myOptions.ts) on the
 * real spreadsheet -- the current value of every option on the Portfolio sheet, written once.
 * Scheduled by .github/workflows/my-options.yml around 17:00 New York; separate from the nightly.
 * flags: --memory (dry run on an empty workbook), --debug. Exit status 0, or 1 on a crash.
 */

import { finish } from './core/finish.ts';
import { runEntryMain } from './app/sheetGuardExit.ts';
import { composeServices } from './compose.ts';
import { formatLine, LogLevel, textLog } from './core/logger.ts';
import type { CliIo } from './cli.ts';
import { STD_IO } from './cli.ts';
import { withSheetWrites, isUnlockFailure, UNLOCK_FAILED_LINE } from './app/sheetWrites.ts';
import { refreshMyOptionsValue, MYOPT_PORTFOLIO_SHEET_NAME } from './jobs/myOptions.ts';
import type { EntryOverrides } from './ticker.ts';
import { activeProfile } from './profile/active.ts';

export async function myOptionsMain(argv: readonly string[], io: CliIo = STD_IO, over: EntryOverrides = {}): Promise<number> {
  // GENERIC_PLAN P2 (C22): the job is a profile feature; off = nothing read, nothing written.
  if (!activeProfile().features.myOptions) { io.out('My Options is off in the profile (features.myOptions); nothing done.\n'); return 0; }
  const flags = new Set(argv);
  const s = await composeServices({
    storage: flags.has('--memory') ? 'memory' : 'sheets', env: io.env, mode: 'ticker',
    logLevel: flags.has('--debug') ? LogLevel.DEBUG : LogLevel.INFO, logSink: (l) => io.err(formatLine(l) + '\n'),
    ...(over.transport ? { transport: over.transport } : {}), ...(over.clock ? { clock: over.clock } : {}), ...(over.initialTabs ? { initialTabs: over.initialTabs } : {}),
  });
  const wb = await s.openWorkbook([MYOPT_PORTFOLIO_SHEET_NAME]);
  const alerts: string[] = [];
  let lockLines: readonly string[] = [];
  try {
    const run = await withSheetWrites(s, async () => {
      await refreshMyOptionsValue({ workbook: wb, http: s.http, timeZone: s.timeZone, log: textLog(s.ctx.log), alert: (m) => { alerts.push(m); } });
      await wb.flush();
      await s.flushStores();
    });
    lockLines = run.reportLines;
    // The options table was not found: the job could not do anything (docs/LOGGING_SPEC.md: CRITICAL).
    if (alerts.length) s.ctx.log.critical('My Options: nothing refreshed, the options table was not found on the Portfolio tab', { alerts: alerts.length });
  } catch (e) {
    if (isUnlockFailure(e)) { io.out(UNLOCK_FAILED_LINE + '\n'); return 1; }
    throw e;
  }
  io.out([alerts.length ? alerts.join('\n') : 'My Options values refreshed.', ...lockLines].join('\n') + '\n');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Three spreadsheets: a maintenance pause ends cleanly (exit 0), a guard refusal with exit 2 (app/sheetGuardExit.ts).
  runEntryMain(() => myOptionsMain(process.argv.slice(2)), STD_IO, { notify: false }, finish);
}
