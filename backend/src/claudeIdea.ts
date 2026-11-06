/**
 * `npm run claude-idea`: appends ONE row to Claude's recommendations list, the '🤖 Claude Ideas' tab of the reports
 * spreadsheet (made with its header when missing). No money: an idea is never filled or sized (paper/claudeIdeas.ts).
 * The idea is checked first; a bad one is refused with one line and nothing is written. Date = now, New York.
 *
 *   npm run claude-idea -- NVDA BUY "$120 - $130" 108 165 "3-6 months" "reason..."
 *   npm run claude-idea -- NVDA call BUY "$120 - $130" 108 165 "6-12 months" "reason..."   (kind: stock (default) or call)
 *   npm run claude-idea -- TSLA AVOID - - - "1 month" "reason..."                        (- = none)
 *
 * Needs GOOGLE_SERVICE_ACCOUNT_JSON (the robot key) and REPORTS_SPREADSHEET_ID (else SPREADSHEET_ID), as claude-order.
 */

import { pathToFileURL } from 'node:url';
import { CLAUDE_IDEAS_TAB, CLAUDE_IDEAS_HEADER, IDEA_KINDS, checkClaudeIdea, type IdeaFields } from './paper/claudeIdeas.ts';
import { nyNow } from './claudeOrder.ts';
import { finish } from './core/finish.ts';

export const CLAUDE_IDEA_USAGE = 'usage: npm run claude-idea -- <TICKER> [stock|call] <BUY|WAIT|AVOID|SELL> "<entry zone>" <stop> <target> "<horizon>" "<reason>"';

/** The command line as the idea's fields (date added by the caller); a string = why it cannot be read. */
export function parseIdeaArgs(args: readonly string[]): Omit<IdeaFields, 'date'> | string {
  const a = [...args];
  const ticker = a.shift() ?? '';
  const kind = IDEA_KINDS.includes((a[0] ?? '').toLowerCase()) ? (a.shift() as string) : 'stock';
  const idea = a.shift() ?? '', zone = a.shift() ?? '', stop = a.shift() ?? '', target = a.shift() ?? '', horizon = a.shift() ?? '';
  if (!ticker || !idea || !zone || !stop || !target || !horizon || !a.length) return CLAUDE_IDEA_USAGE;
  return { ticker, kind, idea, zone, stop, target, horizon, reason: a.join(' ') };
}

/** The default writer: appends the row to '🤖 Claude Ideas' in the reports spreadsheet, made with its header when missing. */
export async function appendClaudeIdea(env: Readonly<Record<string, string | undefined>>, row: readonly string[]): Promise<void> {
  const json = (env.GOOGLE_SERVICE_ACCOUNT_JSON ?? '').trim();
  const id = (env.REPORTS_SPREADSHEET_ID ?? '').trim() || (env.SPREADSHEET_ID ?? '').trim();
  if (!json || !id) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON / REPORTS_SPREADSHEET_ID not set');
  const { SheetsClient, createSheetsApi, parseServiceAccount } = await import('./sheets/client.ts');
  const { a1 } = await import('./sheets/tabs.ts');
  const { createContext } = await import('./core/context.ts');
  const ctx = createContext({ mode: 'lock' });
  const c = new SheetsClient({ spreadsheetId: id, api: createSheetsApi(parseServiceAccount(json)) });
  const ids = await c.tabIds(ctx);
  if (!ids.ok) throw new Error('the reports sheet tab list could not be read');
  const out: string[][] = [];
  if (!Object.hasOwn(ids.value, CLAUDE_IDEAS_TAB)) {
    const added = await c.addTabs(ctx, [CLAUDE_IDEAS_TAB]);
    if (!added.ok) throw new Error('the ' + CLAUDE_IDEAS_TAB + ' tab could not be created');
    out.push([...CLAUDE_IDEAS_HEADER]);
  }
  out.push([...row]);
  const res = await c.append(ctx, a1(CLAUDE_IDEAS_TAB, 'A1'), out);
  if (!res.ok) throw new Error('the row could not be appended');
}

export interface ClaudeIdeaDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: number;
  readonly out: (line: string) => void;
  /** Tests: the writer. */
  readonly append?: (env: Readonly<Record<string, string | undefined>>, row: readonly string[]) => Promise<void>;
}

/** Checks and appends one idea; 0 = appended, 1 = refused or not written (one line says why). */
export async function runClaudeIdea(args: readonly string[], d: ClaudeIdeaDeps): Promise<number> {
  const p = parseIdeaArgs(args);
  if (typeof p === 'string') { d.out('refused: ' + p); return 1; }
  const now = nyNow(d.now);
  const c = checkClaudeIdea({ ...p, date: now.stamp });
  if (!c.ok) { d.out('refused: ' + c.why); return 1; }
  const done = await (d.append ?? appendClaudeIdea)(d.env, c.row).then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e)));
  if (done) { d.out('not written: ' + done); return 1; }
  const r = c.row;
  d.out('appended to ' + CLAUDE_IDEAS_TAB + ': ' + r[3] + ' ' + r[1] + (r[2] === 'call' ? ' (call)' : '') + ', zone ' + r[4] + ', stop ' + r[5] + ', target ' + r[6] + ', ' + r[7] + ' (' + now.stamp + ' New York; status open)');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runClaudeIdea(process.argv.slice(2), { env: process.env, now: Date.now(), out: (l) => process.stdout.write(l + '\n') }).then((code) => finish(code), () => finish(1));
}
