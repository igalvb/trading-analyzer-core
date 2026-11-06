/**
 * `npm run claude-order`: appends ONE order of the paper account "🤖 Claude, free choice" (paper/paperClaude.ts) to
 * the '🤖 Claude Picks' tab of the reports spreadsheet (made with its header when missing). The order is checked
 * first with the same rules the paper night uses; an invalid one is refused with one line and nothing is written.
 * Decided = now, New York ("YYYY-MM-DD HH:MM"): before 09:30 on a trading day it fills at that day's open, else at
 * the next open. The paper night fills it and writes its Status (FILLED date + price / REJECTED reason).
 *
 *   npm run claude-order -- BUY NVDA stock 20000 "reason..."
 *   npm run claude-order -- BUY NVDA call 150 2027-01-15 20000 "reason..."
 *   npm run claude-order -- SELL NVDA stock 50 "reason..."            (50 shares; leave the number out = all)
 *   npm run claude-order -- SELL NVDA call 150 2027-01-15 2 "reason..."
 *   npm run claude-order -- SELL ALL NVDA stock "reason..."
 *   npm run claude-order -- SELL ALL NVDA call 150 2027-01-15 "reason..."
 *
 * Needs GOOGLE_SERVICE_ACCOUNT_JSON (the robot key) and REPORTS_SPREADSHEET_ID (else SPREADSHEET_ID), as the other CLIs.
 */

import { pathToFileURL } from 'node:url';
import { CLAUDE_PICKS_TAB, CLAUDE_PICKS_HEADER, checkClaudeOrder, claudePosName, type ClaudeFields } from './paper/paperClaude.ts';
import { finish } from './core/finish.ts';

export const CLAUDE_ORDER_USAGE = 'usage: npm run claude-order -- BUY|SELL|SELL ALL <TICKER> stock|call [<strike> <expiry YYYY-MM-DD>] [<amount $ (BUY) | shares/contracts (SELL)>] "<reason>"';

const KINDS = new Set(['stock', 'etf', 'call', 'put']);
const isNum = (x: string | undefined): boolean => x != null && x.trim() !== '' && Number.isFinite(Number(x.replace(/[$,]/g, '')));

/** The command line as the tab's fields (Decided added by the caller); a string = why it cannot be read. */
export function parseClaudeArgs(args: readonly string[]): Omit<ClaudeFields, 'decided'> | string {
  const a = [...args];
  let action = (a.shift() ?? '').toUpperCase();
  if (action === 'SELL-ALL' || action === 'SELLALL' || action === 'SELL_ALL') action = 'SELL ALL';
  // "SELL ALL NVDA stock": SELL ALL; "SELL ALL stock" would be a sale of the ticker ALL
  if (action === 'SELL' && (a[0] ?? '').toUpperCase() === 'ALL' && KINDS.has((a[2] ?? '').toLowerCase())) { a.shift(); action = 'SELL ALL'; }
  const ticker = a.shift() ?? '', kind = (a.shift() ?? '').toLowerCase();
  if (!action || !ticker || !kind) return CLAUDE_ORDER_USAGE;
  let strike = '', expiry = '', amount = '', qty = '';
  if (kind === 'call' || kind === 'put') { strike = a.shift() ?? ''; expiry = a.shift() ?? ''; }
  if (action === 'BUY') amount = a.shift() ?? '';
  else if (action !== 'SELL ALL' && isNum(a[0])) qty = a.shift() as string;
  return { action, ticker, kind, strike, expiry, amount, qty, reason: a.join(' ') };
}

/** Now in New York: 'YYYY-MM-DD HH:MM' and the day. */
export function nyNow(ms: number): { stamp: string; day: string } {
  const day = new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const hm = new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return { stamp: day + ' ' + hm, day };
}

/** The tab row (CLAUDE_PICKS_HEADER order; Status empty). */
export function claudeRowOf(f: ClaudeFields): string[] {
  return [f.decided, f.action.trim().toUpperCase().replace(/\s+/g, ' '), f.ticker.trim().toUpperCase(), f.kind.trim().toLowerCase() === 'call' ? 'call' : 'stock', f.strike.trim(), f.expiry.trim(), f.amount.trim().replace(/[$,]/g, ''), f.qty.trim(), f.reason.trim(), ''];
}

/** The default writer: appends the row to '🤖 Claude Picks' in the reports spreadsheet, made with its header when missing. */
export async function appendClaudePick(env: Readonly<Record<string, string | undefined>>, row: readonly string[]): Promise<void> {
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
  if (!Object.hasOwn(ids.value, CLAUDE_PICKS_TAB)) {
    const added = await c.addTabs(ctx, [CLAUDE_PICKS_TAB]);
    if (!added.ok) throw new Error('the ' + CLAUDE_PICKS_TAB + ' tab could not be created');
    out.push([...CLAUDE_PICKS_HEADER]);
  }
  out.push([...row]);
  const res = await c.append(ctx, a1(CLAUDE_PICKS_TAB, 'A1'), out);
  if (!res.ok) throw new Error('the row could not be appended');
}

export interface ClaudeOrderDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: number;
  readonly out: (line: string) => void;
  /** Tests: the writer. */
  readonly append?: (env: Readonly<Record<string, string | undefined>>, row: readonly string[]) => Promise<void>;
}

/** Checks and appends one order; 0 = appended, 1 = refused or not written (one line says why). */
export async function runClaudeOrder(args: readonly string[], d: ClaudeOrderDeps): Promise<number> {
  const p = parseClaudeArgs(args);
  if (typeof p === 'string') { d.out('refused: ' + p); return 1; }
  const now = nyNow(d.now);
  const f: ClaudeFields = { ...p, decided: now.stamp };
  const c = checkClaudeOrder(f, now.day);
  if (!c.ok) { d.out('refused: ' + c.why); return 1; }
  const row = claudeRowOf(f);
  const done = await (d.append ?? appendClaudePick)(d.env, row).then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e)));
  if (done) { d.out('not written: ' + done); return 1; }
  const o = c.order;
  d.out('appended to ' + CLAUDE_PICKS_TAB + ': ' + o.action + ' ' + claudePosName(o) + (o.amount != null ? ' $' + o.amount : o.qty != null ? ' ' + o.qty : o.action !== 'BUY' ? ' (all)' : '') + ', decided ' + now.stamp + ' New York; it fills at ' + (o.preOpen ? 'the open of ' + o.decided + ' if that is a trading day, else the next open' : 'the next open after ' + o.decided));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runClaudeOrder(process.argv.slice(2), { env: process.env, now: Date.now(), out: (l) => process.stdout.write(l + '\n') }).then((code) => finish(code), () => finish(1));
}
