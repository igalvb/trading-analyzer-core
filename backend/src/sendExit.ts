/**
 * `npm run send-exit [-- --ai-status] [--no-send] [--out DIR]` (Telegram /exit, owner 2026-10-27).
 *
 * Sends the SAVED Exit Report (as the last nightly, and AI run if any, left it on the Sheet) as a PDF, the bottom line
 * as its caption and no separate message (notify/policy.ts). Nothing is re-run. `--ai-status` only prints "missing" when the AI section still holds the placeholder
 * (the workflow then runs the Exit AI first), else "present".
 * Plan #47: the portfolio view by Claude Opus is in the PDF (the saved AI section); the caption carries its first line.
 * Exit: 0 done, 1 the tab could not be read or sent, 2 configuration.
 */

import { finish } from './core/finish.ts';
import { runEntryMain } from './app/sheetGuardExit.ts';
import { STD_IO, type CliIo } from './cli.ts';
import { composeServices } from './compose.ts';
import { formatLine, LogLevel } from './core/logger.ts';
import { EXIT_SHEET_TAB, AI_PLACEHOLDER, PORTFOLIO_VIEW_TITLE } from './reports/exitSheet/text.ts';
import { reportDocument } from './reports/pdf/workbookHtml.ts';
import { sheetGridHtml, sheetHasText, sheetFindText } from './reports/pdf/sheetGridHtml.ts';
import { bottomLine } from './notify/policy.ts';
import { prepareDelivery, deliverPdf, dateStamp, type DeliverDeps } from './reports/pdf/deliver.ts';
import type { sheets_v4 } from 'googleapis';

export interface SendExitDeps extends DeliverDeps {
  /** Tests: the tab instead of the Sheet. */
  readonly readTab?: () => Promise<sheets_v4.Schema$Sheet | null>;
  readonly now?: () => number;
}

/** The saved portfolio view is read up to this length (the /exit caption uses its first line; the PDF has it all). */
export const SAVED_PORTFOLIO_VIEW_MAX_CHARS = 3000;

/** Plan #47: the saved portfolio view (its title row, then column A until the first holding's row), or null. */
export function savedPortfolioView(tab: sheets_v4.Schema$Sheet): string | null {
  const colA = (tab.data?.[0]?.rowData ?? []).map((r) => String(r.values?.[0]?.formattedValue ?? ''));
  const start = colA.indexOf('▣ ' + PORTFOLIO_VIEW_TITLE);
  if (start < 0) return null;
  const out: string[] = [];
  for (const t of colA.slice(start + 1)) {
    if (t.startsWith('▸ ')) break;
    if (t.trim()) out.push(t.trim());
  }
  if (!out.length) return null;
  const text = out.join('\n');
  return '📊 ' + PORTFOLIO_VIEW_TITLE + '\n' + (text.length > SAVED_PORTFOLIO_VIEW_MAX_CHARS ? text.slice(0, SAVED_PORTFOLIO_VIEW_MAX_CHARS) + ' … (the rest is in the PDF)' : text);
}

/** The bottom line: "Exit Report (from 5 Nov 2026 21:10)" and, when saved, the portfolio view's first line. */
export function savedExitCaption(runTime: string, view: string | null): string {
  const first = view ? (view.split('\n').slice(1).find((l) => l.trim()) ?? '') : '';
  return bottomLine('Exit Report' + (runTime ? ' (from ' + runTime + ')' : ''), [], first ? '📊 ' + first : null);
}

export async function sendExitMain(argv: readonly string[], io: CliIo = STD_IO, deps: SendExitDeps = {}): Promise<number> {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const outIdx = argv.indexOf('--out');
  const outDir = outIdx >= 0 ? (argv[outIdx + 1] ?? 'out') : 'out';
  let readTab = deps.readTab;
  if (!readTab) {
    const s = await composeServices({ storage: 'sheets', env: io.env ?? process.env, mode: 'ticker', noAi: true, logLevel: LogLevel.INFO, logSink: (l) => io.err(formatLine(l) + '\n') });
    readTab = async () => {
      // Three spreadsheets: the Exit Report lives in the reports spreadsheet once routing is on.
      const r = await (s.reportsSheets ?? s.sheets)!.tabWithFormats(s.ctx, EXIT_SHEET_TAB);
      if (!r.ok) throw new Error(String(r.error.detail));
      return r.value;
    };
  }
  const tab = await readTab().catch((e) => { io.err('Exit report: ' + String(e) + '\n'); return null; });
  if (flags.has('--ai-status')) { io.out(tab && sheetHasText(tab, AI_PLACEHOLDER) ? 'missing\n' : 'present\n'); return tab ? 0 : 1; }
  const d = prepareDelivery(io, !flags.has('--no-send'), deps, '');
  if (!d) return 2;
  const section = tab ? sheetGridHtml(tab) : null;
  if (!section) { io.out('Exit report: the saved tab could not be read.\n'); return 1; }
  const runTime = (sheetFindText(tab!, 'Run time:') ?? '').replace(/^Run time:\s*/, '');
  const now = (deps.now ?? Date.now)();
  const view = savedPortfolioView(tab!);
  return deliverPdf(io, d, {
    label: 'Exit report (saved)', outDir, pdfName: `v13-report-exit-saved-${dateStamp(now)}.pdf`,
    html: reportDocument({ title: 'Exit Strategy Report', subtitle: runTime ? 'Report from ' + runTime : 'Saved report', facts: [], lines: ['As saved on the Sheet by the last run, with its AI section.'] }, [section], null),
    caption: savedExitCaption(runTime, view),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Three spreadsheets: a maintenance pause ends cleanly (exit 0), a guard refusal with exit 2 (app/sheetGuardExit.ts).
  runEntryMain(() => sendExitMain(process.argv.slice(2)), STD_IO, { notify: !process.argv.includes('--no-send') && !process.argv.includes('--ai-status') }, finish);
}
