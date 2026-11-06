/**
 * `npm run paper-weekly -- [--no-send] [--week YYYY-MM-DD] [--out DIR]`
 *
 * The paper test's weekly report by hand (reports/paperWeekly.ts): reads 📈 Paper Values and 📒 Paper Log (no fetch),
 * prints the week's table, and sends the PDF to Telegram with its bottom line as the caption (notify/policy.ts). The
 * week is the last full Mon-Fri week before today (New York), or the week holding --week. A sent week is recorded
 * (PAPER_WEEKLY_KEY), so the Saturday Nightly does not send it again; a hand run always sends.
 * --no-send: print only (and save the PDF in --out when a browser is found).
 * Exit: 0 done, 1 no paper day in that week or the PDF/Telegram failed, 2 configuration.
 */

import { finish } from './core/finish.ts';
import { runEntryMain } from './app/sheetGuardExit.ts';
import { STD_IO, type CliIo } from './cli.ts';
import { composeServices } from './compose.ts';
import { formatLine, LogLevel, textLog } from './core/logger.ts';
import { withSheetWrites, isUnlockFailure, UNLOCK_FAILED_LINE } from './app/sheetWrites.ts';
import type { EntryOverrides } from './ticker.ts';
import { findChrome, htmlToPdf } from './reports/pdf/chromePdf.ts';
import { readWeekly, weeklyText, weeklyCaption, weeklyHtml, weekOf, lastFullWeek, dayIn, maybeSendPaperWeekly } from './reports/paperWeekly.ts';
import fs from 'node:fs';
import path from 'node:path';

export interface PaperWeeklyDeps {
  readonly over?: EntryOverrides;
  readonly now?: () => number;
  readonly toPdf?: ((html: string, pdfPath: string) => Promise<void>) | null;
  readonly fetchImpl?: typeof fetch;
}

export async function paperWeeklyMain(argv: readonly string[], io: CliIo = STD_IO, deps: PaperWeeklyDeps = {}): Promise<number> {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const arg = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const env = io.env ?? process.env;
  const send = !flags.has('--no-send');
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim(), chatId = (env.TELEGRAM_CHAT_ID ?? '').trim();
  if (send && (!token || !chatId)) { io.err('Telegram is not set up: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are needed (or use --no-send).\n'); return 2; }
  const wanted = arg('--week');
  if (wanted !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(wanted)) { io.err('--week takes a day as YYYY-MM-DD.\n'); return 2; }
  const over = deps.over ?? {};
  const s = await composeServices({
    storage: flags.has('--memory') ? 'memory' : 'sheets', env, mode: 'ticker', noAi: true,
    logLevel: flags.has('--debug') ? LogLevel.DEBUG : LogLevel.INFO, logSink: (l) => io.err(formatLine(l) + '\n'),
    ...(over.transport ? { transport: over.transport } : {}), ...(over.clock ? { clock: over.clock } : {}), ...(over.initialTabs ? { initialTabs: over.initialTabs } : {}),
  });
  const now = (deps.now ?? (() => s.clock.now()))();
  const week = wanted ? weekOf(wanted) : lastFullWeek(dayIn(now, s.timeZone));
  const report = await readWeekly(s.tabStore, week);
  if (!report) { io.out('Paper weekly: no paper day in the week of ' + week.monday + ' (📈 Paper Values).\n'); return 1; }
  io.out(weeklyText(report) + '\n\nCaption: ' + weeklyCaption(report) + '\n');
  const toPdf = deps.toPdf !== undefined ? deps.toPdf : (() => { const chrome = findChrome(env); return chrome ? (html: string, pdf: string) => htmlToPdf(html, pdf, chrome) : null; })();
  const outDir = arg('--out') ?? 'out';
  if (!send) {
    if (!toPdf) return 0;
    fs.mkdirSync(outDir, { recursive: true });
    const p = path.join(outDir, 'paper-week-' + week.monday + '.pdf');
    return toPdf(weeklyHtml(report), p).then(() => { io.out('Paper weekly: PDF saved to ' + p + '\n'); return 0; }, (e: unknown) => { io.out('Paper weekly: the PDF could not be made: ' + String(e) + '\n'); return 1; });
  }
  if (!toPdf) { io.err('No Chrome or Chromium found to make the PDF (set CHROME_PATH).\n'); return 2; }
  const log = textLog(s.ctx.log);
  const run = await withSheetWrites(s, async () => {
    const r = await maybeSendPaperWeekly({ store: s.tabStore, kv: s.kv, telegram: { deps: { token, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }, chatId }, toPdf, log, now, timeZone: s.timeZone, force: true, week, outDir });
    await s.flushStores();
    return r;
  }).catch((e: unknown) => { if (isUnlockFailure(e)) { io.out(UNLOCK_FAILED_LINE + '\n'); return null; } throw e; });
  if (!run) return 1;
  io.out('Paper weekly: ' + (run.value === 'sent' ? 'sent to Telegram.' : 'not sent (' + run.value + '; details in the log).') + '\n');
  for (const l of run.reportLines) io.out(l + '\n');
  return run.value === 'sent' ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runEntryMain(() => paperWeeklyMain(process.argv.slice(2)), STD_IO, { notify: !process.argv.includes('--no-send') }, finish);
}
