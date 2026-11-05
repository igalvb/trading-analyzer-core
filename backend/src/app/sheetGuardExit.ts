/**
 * How an entry ends when the three-spreadsheet startup guard stops it (sheets/threeSheets.ts):
 *
 *   SheetsPausedError   the migration tool's maintenance pause is on: nothing was written; exit 0 (a clean, green
 *                       run). A Telegram-started run (/analyze, /exit, the Exit Report) also replies in Telegram:
 *                       "Paused for maintenance until about HH:MM UTC; please send it again after that."
 *                       The Telegram relay needs no change: it only starts the workflow, and the workflow answers.
 *   SheetsRefusedError  the switch is in a state the run must not write in: exit 2 with the one plain sentence.
 *
 * Anything else is not ours: null, and the entry ends as before (exit 1 with the stack on stderr), now after one
 * CRITICAL line (core/logFile.ts processLine: stderr and the run's full log file). The refusal itself is logged
 * CRITICAL by the guard (sheets/threeSheets.ts), where the run logger exists; the pause is logged INFO here.
 */

import type { CliIo } from '../cli.ts';
import { sendMessage, type TelegramDeps } from '../notify/telegram.ts';
import { SheetsPausedError, SheetsRefusedError } from '../sheets/threeSheets.ts';
import { processLine } from '../core/logFile.ts';
import { logRunTotals } from '../core/logger.ts';

export interface GuardExitOptions {
  /** True for the Telegram-started entries (analyze-report, exit-report-pdf, send-exit, ai); --no-send turns it off. */
  readonly notify: boolean;
  readonly fetchImpl?: typeof fetch;
}

export async function guardStopCode(e: unknown, io: CliIo, o: GuardExitOptions): Promise<number | null> {
  if (e instanceof SheetsPausedError) {
    io.out(e.message + '\n');
    const env = io.env ?? process.env;
    processLine('INFO', 'run', 'maintenance pause is on: the run did not start (exit 0)', undefined, env, (t) => io.err(t));
    const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim(), chatId = (env.TELEGRAM_CHAT_ID ?? '').trim();
    if (o.notify && token && chatId) {
      const tg: TelegramDeps = { token, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) };
      await sendMessage(tg, chatId, '⏸️ ' + e.message).catch((err: unknown) => { processLine('WARNING', 'run', 'Telegram: the pause notice could not be sent', { detail: String(err) }, env, (t) => io.err(t)); });
    }
    return 0;
  }
  if (e instanceof SheetsRefusedError) {
    io.out(e.message + '\n');
    return 2;
  }
  return null;
}

/** The `if (import.meta.url === ...)` tail of an entry: exit code, or the guard's stop, or 1 with the stack. */
export function runEntryMain(run: () => Promise<number>, io: CliIo, o: GuardExitOptions, finish: (code: number) => void): void {
  run().then((code) => { logRunTotals(code); finish(code); }, async (e) => {
    const code = await guardStopCode(e, io, o).catch((g: unknown) => { processLine('ERROR', 'run', 'the startup-guard exit handling failed', { detail: String(g) }, io.env ?? process.env); return null; });
    if (code !== null) { logRunTotals(code); finish(code); return; }
    logRunTotals(1);
    processLine('CRITICAL', 'run', 'the run stopped on an unexpected error (exit 1)', { detail: String((e as Error)?.message ?? e) }, io.env ?? process.env);
    process.stderr.write(String((e && (e as Error).stack) || e) + '\n');
    finish(1);
  });
}
