/**
 * The paper test's WEEKLY report (owner 2026-11-06): every Sunday morning (Israel), one PDF to Telegram with a
 * 2-line bottom line as its caption (notify/policy.ts, docs/TELEGRAM_POLICY.md). Nothing is fetched and nothing is
 * decided here: every number comes from the two append-only paper tabs the nightly writes (paper/paperLog.ts):
 *   📈 Paper Values  one row per account per trading day (value after tax, holds)
 *   📒 Paper Log     every order decided at the close and every fill at the open
 *
 *   the week         Mon-Fri of the week just ended; its trading days are the days of that week found in 📈 Paper
 *                    Values (a holiday week has 4).
 *   this week %      the value on the week's last day against the last value before the week (an account that joined
 *                    during the week: against the cash it started with).
 *   since start %    against the cash every account starts with (PAPER_CASH), from the account's first row: an account
 *                    that joined late starts there, and the yardsticks are measured from that same day for it.
 *   vs yardstick     since start % minus the yardstick's own % over the same days, in points.
 *
 * The yardsticks are the rows 📈 Paper Values names 'Hold QQQ' and the profile's whole-list label (LABELS.holdCoreShort);
 * that tab holds names only, so they are found by the names paperLog.valuesRows writes.
 *
 * Sent ONCE per week (maybeSendPaperWeekly): on the Nightly whose date in the run's time zone (New York) is a Saturday
 * (03:23 UTC Sunday), after the paper step; the week is stored under PAPER_WEEKLY_KEY in the property store so a second
 * Saturday run does not send it again. By hand: `npm run paper-weekly` (src/paperWeekly.ts). Nothing here throws.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TabStore, TabCell } from '../storage/tabStore.ts';
import type { PropertyStore } from '../storage/kv.ts';
import { LOG_TAB, VALUES_TAB, LOG_HEADER, VALUES_HEADER } from '../paper/paperLog.ts';
import { PAPER_CASH } from '../paper/paperTrading.ts';
import { LABELS } from '../profile/labels.ts';
import { htmlEsc } from './pdf/workbookHtml.ts';
import { bottomLine, sendPdfs, type TelegramTarget } from '../notify/policy.ts';

/** The property-store key holding the Monday (YYYY-MM-DD) of the last week sent. */
export const PAPER_WEEKLY_KEY = 'PAPER_WEEKLY_LAST';
/** The QQQ yardstick's row name in 📈 Paper Values (paperLog.valuesRows). */
export const QQQ_ROW = 'Hold QQQ';
/** The whole-list yardstick's row name (paper key lab.list; the profile's label). */
export const LIST_ROW: string = LABELS.holdCoreShort;

export interface ValueRow { readonly day: string; readonly account: string; readonly group: string; readonly value: number; readonly holds: string }
export interface LogRow {
  readonly day: string; readonly when: string; readonly account: string; readonly action: string; readonly stock: string;
  readonly qty: string; readonly price: string; readonly value: string; readonly tax: string; readonly why: string;
}

const dayText = (c: TabCell | undefined): string => (c instanceof Date ? c.toISOString().slice(0, 10) : String(c ?? '').trim());
const cellText = (c: TabCell | undefined): string => (c instanceof Date ? c.toISOString().slice(0, 10) : c == null ? '' : String(c));
const isDay = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** 📈 Paper Values rows (the header and anything without a day left out). */
export function parseValues(rows: readonly (readonly TabCell[])[]): ValueRow[] {
  const out: ValueRow[] = [];
  for (const r of rows) {
    const day = dayText(r[0]);
    const value = Number(r[3]);
    if (!isDay(day) || !String(r[1] ?? '').trim() || !Number.isFinite(value) || r[3] === '') continue;
    out.push({ day, account: String(r[1]).trim(), group: String(r[2] ?? '').trim(), value, holds: cellText(r[5]) });
  }
  return out;
}

/** 📒 Paper Log rows (the header left out). */
export function parseLog(rows: readonly (readonly TabCell[])[]): LogRow[] {
  const out: LogRow[] = [];
  for (const r of rows) {
    const day = dayText(r[0]);
    if (!isDay(day)) continue;
    out.push({ day, when: cellText(r[1]), account: cellText(r[2]), action: cellText(r[3]), stock: cellText(r[4]), qty: cellText(r[5]), price: cellText(r[6]), value: cellText(r[7]), tax: cellText(r[8]), why: cellText(r[9]) });
  }
  return out;
}

// ── the week ──────────────────────────────────────────────────────────────────────────────────────────────────────

const addDays = (day: string, n: number): string => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/** 0 = Sunday ... 6 = Saturday. */
const weekday = (day: string): number => new Date(day + 'T12:00:00Z').getUTCDay();

export interface PaperWeek { readonly monday: string; readonly friday: string }

/** The Mon-Fri week holding `day` (a Saturday or Sunday: the week just before it). */
export function weekOf(day: string): PaperWeek {
  const w = weekday(day);
  const monday = addDays(day, w === 0 ? -6 : 1 - w);
  return { monday, friday: addDays(monday, 4) };
}

/** The last full week before `today`: its Friday is before today (on a Friday, the week before). */
export function lastFullWeek(today: string): PaperWeek {
  const w = weekday(today);
  return weekOf(addDays(today, -(w === 5 ? 7 : w === 6 ? 1 : w === 0 ? 2 : w + 2)));
}

/** The date (YYYY-MM-DD) of `ms` in `timeZone`. */
export const dayIn = (ms: number, timeZone: string): string => new Date(ms).toLocaleDateString('en-CA', { timeZone });

/** True on the run whose date in `timeZone` (New York) is a Saturday: the weekly report's night. */
export function isWeeklyNight(nowMs: number, timeZone: string): boolean {
  return weekday(dayIn(nowMs, timeZone)) === 6;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dm = (day: string): [number, string] => [Number(day.slice(8, 10)), MONTHS[Number(day.slice(5, 7)) - 1] as string];
/** "2-6 Nov", or "30 Oct-3 Nov" across a month end. */
export function weekLabel(first: string, last: string): string {
  const [d1, m1] = dm(first), [d2, m2] = dm(last);
  return m1 === m2 ? d1 + '-' + d2 + ' ' + m2 : d1 + ' ' + m1 + '-' + d2 + ' ' + m2;
}

// ── the report ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface WeeklyAccount {
  readonly account: string;
  readonly group: string;
  readonly yardstick: boolean;
  /** The account's first row (its start). */
  readonly joined: string;
  readonly value: number;
  /** % (1.2 = +1.2%). */
  readonly weekPct: number;
  readonly sincePct: number;
  /** Points against each yardstick over the account's own days; null when the yardstick is missing (or for itself). */
  readonly vsQqq: number | null;
  readonly vsList: number | null;
  /** % fall from the highest value, over every row to the week's end. */
  readonly deepestFall: number;
  readonly buys: number;
  readonly sells: number;
  readonly holds: string;
}

export interface WeeklyReport {
  readonly week: PaperWeek;
  /** The week's trading days found in 📈 Paper Values, oldest first. */
  readonly days: readonly string[];
  readonly label: string;
  /** Every account (yardsticks included), grouped in the tab's order, best since start first within each group. */
  readonly accounts: readonly WeeklyAccount[];
  readonly groups: readonly string[];
  readonly best: readonly WeeklyAccount[];
  readonly worst: readonly WeeklyAccount[];
  readonly beatBoth: { readonly n: number; readonly m: number };
  readonly qqq: WeeklyAccount | null;
  readonly list: WeeklyAccount | null;
  /** Every 📒 Paper Log row of the week, in the tab's order. */
  readonly trades: readonly LogRow[];
}

const isYardstickGroup = (g: string): boolean => g.startsWith('📊');
const pct = (v: number, base: number): number => (base > 0 ? (v / base - 1) * 100 : 0);

/**
 * Log rows written under a part of an account ("Everything together, shares half" / ", LEAPS half": paperLab.ts ALL_SHARES)
 * belong to the 📈 Paper Values account they are part of ("Everything together (...)"): folded into it, the part shown in
 * the trade log's When column (fix 2026-11-06, live QA: the account's trade log and its trade counts were empty).
 */
export function foldSubAccounts(values: readonly ValueRow[], log: readonly LogRow[]): (LogRow & { readonly part?: string })[] {
  const names = [...new Set(values.map((v) => v.account))];
  const known = new Set(names);
  const parentOf = new Map<string, string | null>();
  return log.map((t) => {
    if (known.has(t.account)) return t;
    if (!parentOf.has(t.account)) {
      const head = t.account.split(',')[0]!.trim();
      const cands = head && head !== t.account ? names.filter((n) => n === head || n.startsWith(head + ' (')) : [];
      parentOf.set(t.account, cands.length === 1 ? cands[0]! : null);
    }
    const parent = parentOf.get(t.account);
    return parent ? { ...t, account: parent, part: t.account.slice(t.account.indexOf(',') + 1).trim() } : t;
  });
}

/**
 * The week's report from the two tabs' rows, or null when 📈 Paper Values has no day in that week. Every account with
 * a row on or before the week's Friday is in it.
 */
export function buildWeekly(values: readonly ValueRow[], log: readonly LogRow[], week: PaperWeek): WeeklyReport | null {
  const upTo = values.filter((r) => r.day <= week.friday);
  const days = [...new Set(upTo.filter((r) => r.day >= week.monday).map((r) => r.day))].sort();
  if (!days.length) return null;
  const firstDay = upTo.reduce((m, r) => (r.day < m ? r.day : m), days[0] as string);
  const byAcc = new Map<string, ValueRow[]>();
  for (const r of upTo) { const l = byAcc.get(r.account); if (l) l.push(r); else byAcc.set(r.account, [r]); }
  for (const l of byAcc.values()) l.sort((a, b) => a.day.localeCompare(b.day));
  const valueOn = (acc: string, day: string): number | null => {
    const l = byAcc.get(acc);
    if (!l) return null;
    let v: number | null = null;
    for (const r of l) { if (r.day > day) break; v = r.value; }
    return v;
  };
  const lastDay = days[days.length - 1] as string;
  // The yardstick's % from `from` (the account's first day) to the week's end; from the test's first day: its own since-start.
  const yardPct = (yard: string, from: string): number | null => {
    const end = valueOn(yard, lastDay);
    if (end == null) return null;
    if (from <= firstDay) return pct(end, PAPER_CASH);
    const start = valueOn(yard, from);
    return start == null ? null : pct(end, start);
  };
  const counts = new Map<string, { buys: number; sells: number }>();
  // Fix 2026-11-06: rows logged under a part of an account ("Everything together, shares half") count for that account.
  const trades = foldSubAccounts(values, log).filter((t) => t.day >= week.monday && t.day <= week.friday);
  for (const t of trades) {
    if (t.when !== 'filled') continue;
    const c = counts.get(t.account) ?? { buys: 0, sells: 0 };
    if (t.action === 'BOUGHT') c.buys++; else if (t.action === 'SOLD') c.sells++;
    counts.set(t.account, c);
  }
  const groups: string[] = [];
  const accounts: WeeklyAccount[] = [];
  for (const [account, rows] of byAcc) {
    const last = rows[rows.length - 1] as ValueRow;
    const first = rows[0] as ValueRow;
    const before = [...rows].reverse().find((r) => r.day < week.monday);
    let peak = 0, fall = 0;
    for (const r of rows) { peak = Math.max(peak, r.value); fall = Math.max(fall, peak > 0 ? (1 - r.value / peak) * 100 : 0); }
    const sincePct = pct(last.value, PAPER_CASH);
    const vs = (yard: string): number | null => { if (yard === account) return null; const y = yardPct(yard, first.day); return y == null ? null : sincePct - y; };
    const group = last.group || first.group;
    if (!groups.includes(group)) groups.push(group);
    const c = counts.get(account) ?? { buys: 0, sells: 0 };
    accounts.push({
      account, group, yardstick: isYardstickGroup(group), joined: first.day, value: last.value,
      weekPct: pct(last.value, before ? before.value : PAPER_CASH), sincePct, vsQqq: vs(QQQ_ROW), vsList: vs(LIST_ROW),
      deepestFall: fall, buys: c.buys, sells: c.sells, holds: last.holds,
    });
  }
  // The yardsticks' group last, the others in the tab's order.
  groups.sort((a, b) => Number(isYardstickGroup(a)) - Number(isYardstickGroup(b)));
  const sorted = groups.flatMap((g) => accounts.filter((a) => a.group === g).sort((a, b) => b.sincePct - a.sincePct || a.account.localeCompare(b.account)));
  const players = sorted.filter((a) => !a.yardstick);
  const byWeek = [...players].sort((a, b) => b.weekPct - a.weekPct || a.account.localeCompare(b.account));
  const beat = players.filter((a) => a.vsQqq != null && a.vsQqq > 0 && a.vsList != null && a.vsList > 0).length;
  return {
    week, days, label: weekLabel(days[0] as string, lastDay), accounts: sorted, groups, best: byWeek.slice(0, 5), worst: byWeek.slice(-5).reverse(),
    beatBoth: { n: beat, m: players.length }, qqq: sorted.find((a) => a.account === QQQ_ROW) ?? null, list: sorted.find((a) => a.account === LIST_ROW) ?? null, trades,
  };
}

/** Reads the two tabs (no fetch) and builds the week's report; null when the tab has no day of that week. */
export async function readWeekly(store: TabStore, week: PaperWeek): Promise<WeeklyReport | null> {
  const values = parseValues((await store.read(VALUES_TAB, VALUES_HEADER.length)) ?? []);
  const log = parseLog((await store.read(LOG_TAB, LOG_HEADER.length)) ?? []);
  return buildWeekly(values, log, week);
}

export const signed = (x: number): string => (x >= 0 ? '+' : '') + x.toFixed(1) + '%';
const points = (x: number | null): string => (x == null ? '—' : (x >= 0 ? '+' : '') + x.toFixed(1));
const money = (v: number): string => (v < 0 ? '-' : '') + '$' + Math.round(Math.abs(v)).toLocaleString('en-US');

/** The bottom line: "Paper week 2-6 Nov: best <account> +1.2% · Hold QQQ -2.1% · 18 of 52 beat both" (≤ 2 lines, ~200 chars). */
export function weeklyCaption(r: WeeklyReport): string {
  const best = r.best[0];
  return bottomLine('Paper week ' + r.label, [
    best ? 'best ' + best.account + ' ' + signed(best.weekPct) : null,
    r.qqq ? QQQ_ROW + ' ' + signed(r.qqq.weekPct) : null,
    r.beatBoth.n + ' of ' + r.beatBoth.m + ' beat both',
  ]);
}

/** The column titles of the main table. */
export const WEEKLY_COLUMNS: readonly string[] = ['Account', 'Value after tax', 'This week %', 'Since start %', 'vs 📊 ' + QQQ_ROW + ' (pts, since start)', 'vs 📊 ' + LIST_ROW + ' (pts)', 'Deepest fall', 'Trades this week (buys / sells)', 'Holds now'];

/** One account as the main table's cells (plain text). */
export function weeklyCells(a: WeeklyAccount): string[] {
  return [(a.yardstick ? '📊 ' : '') + a.account, money(a.value), signed(a.weekPct), signed(a.sincePct), points(a.vsQqq), points(a.vsList),
    a.deepestFall >= 0.05 ? '-' + a.deepestFall.toFixed(1) + '%' : '0%', a.buys + ' / ' + a.sells, a.holds || (a.yardstick ? '—' : 'cash')];
}

/** The report as plain text (the CLI prints it). */
export function weeklyText(r: WeeklyReport): string {
  const lines = ['Paper week ' + r.label + ' (' + r.days.length + ' trading days: ' + r.days.join(', ') + ')',
    'Beat both yardsticks since start: ' + r.beatBoth.n + ' of ' + r.beatBoth.m, '',
    'Best 5 this week: ' + r.best.map((a) => a.account + ' ' + signed(a.weekPct)).join(' · '),
    'Worst 5 this week: ' + r.worst.map((a) => a.account + ' ' + signed(a.weekPct)).join(' · '), ''];
  for (const g of r.groups) {
    lines.push('[' + g + ']');
    for (const a of r.accounts.filter((x) => x.group === g)) lines.push('  ' + weeklyCells(a).join(' | '));
  }
  lines.push('', 'All trades this week: ' + r.trades.length + ' row(s) of the Paper Log');
  return lines.join('\n');
}

const cls = (v: number | null): string => (v == null ? '' : v >= 0 ? 'up' : 'down');

/** The report as one HTML page (printed to PDF). */
export function weeklyHtml(r: WeeklyReport): string {
  const head = `<style>@page{size:A4 landscape;margin:10mm}body{font-family:Arial,Helvetica,sans-serif;font-size:10px;color:#111;margin:0}h1{font-size:17px;margin:0 0 4px}h2{font-size:13px;margin:14px 0 5px}
table{border-collapse:collapse;width:100%;margin-bottom:8px}th,td{border:1px solid #ccc;padding:2px 4px;text-align:right;vertical-align:top}th{background:#eef2f7}td.l,th.l{text-align:left}
tr.group td{background:#dfe6ee;font-weight:bold;text-align:left}tr.bench td{background:#fff7d6}.up{color:#0a7a2f}.down{color:#b3261e}.small{color:#555}.top{display:flex;gap:16px}.top>div{flex:1}</style>`;
  const short = (a: WeeklyAccount, i: number): string => `<tr><td>${i + 1}</td><td class="l">${htmlEsc(a.account)}</td><td class="l">${htmlEsc(a.group)}</td><td class="${cls(a.weekPct)}">${signed(a.weekPct)}</td><td class="${cls(a.sincePct)}">${signed(a.sincePct)}</td></tr>`;
  const shortTable = (title: string, list: readonly WeeklyAccount[]): string => `<div><h2>${htmlEsc(title)}</h2><table><tr><th>#</th><th class="l">Account</th><th class="l">Group</th><th>This week</th><th>Since start</th></tr>${list.map(short).join('')}</table></div>`;
  const yard = (a: WeeklyAccount | null, name: string): string => (a ? `📊 ${htmlEsc(name)}: this week ${signed(a.weekPct)}, since start ${signed(a.sincePct)}` : `📊 ${htmlEsc(name)}: not in the tab`);
  const row = (a: WeeklyAccount): string => {
    const c = weeklyCells(a);
    const late = a.joined > (r.accounts.reduce((m, x) => (x.joined < m ? x.joined : m), a.joined)) ? ` <span class="small">(from ${htmlEsc(a.joined)})</span>` : '';
    return `<tr class="${a.yardstick ? 'bench' : ''}"><td class="l">${htmlEsc(c[0] as string)}${late}</td><td>${c[1]}</td><td class="${cls(a.weekPct)}">${c[2]}</td><td class="${cls(a.sincePct)}">${c[3]}</td>`
      + `<td class="${cls(a.vsQqq)}">${c[4]}</td><td class="${cls(a.vsList)}">${c[5]}</td><td>${c[6]}</td><td>${c[7]}</td><td class="l">${htmlEsc(c[8] as string)}</td></tr>`;
  };
  const main = r.groups.map((g) => `<tr class="group"><td colspan="${WEEKLY_COLUMNS.length}">${htmlEsc(g)}</td></tr>` + r.accounts.filter((a) => a.group === g).map(row).join('')).join('');
  const tradeRows = r.trades.map((t) => `<tr><td class="l">${htmlEsc(t.day)}</td><td class="l">${htmlEsc(t.account)}</td><td class="l">${htmlEsc(t.action)}</td><td class="l">${htmlEsc(t.stock)}</td><td>${htmlEsc(t.qty)}</td><td>${htmlEsc(t.price)}</td><td>${htmlEsc(t.value)}</td><td>${htmlEsc(t.tax)}</td><td class="l">${htmlEsc(t.why)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Paper week ${htmlEsc(r.label)}</title>${head}</head><body>`
    + `<h1>📝 Paper test — week ${htmlEsc(r.label)} ${htmlEsc(r.week.friday.slice(0, 4))}</h1>`
    + `<div class="small">${r.days.length} trading day(s): ${htmlEsc(r.days.join(', '))}. Values after the tax on what is still held. Since start = from the account's first day (an account that joined late is compared with the yardsticks from its own first day). Points = since start minus the yardstick's own return over the same days. 📊 = what we compare against.</div>`
    + `<h2>Beat both yardsticks since start: ${r.beatBoth.n} of ${r.beatBoth.m}</h2><div>${yard(r.qqq, QQQ_ROW)}<br>${yard(r.list, LIST_ROW)}</div>`
    + `<div class="top">${shortTable('Best 5 this week', r.best)}${shortTable('Worst 5 this week', r.worst)}</div>`
    + `<h2>Every account (${r.accounts.length})</h2><table><tr>${WEEKLY_COLUMNS.map((c, i) => `<th class="${i === 0 || i === 8 ? 'l' : ''}">${htmlEsc(c)}</th>`).join('')}</tr>${main}</table>`
    + `<h2>All trades this week (${r.trades.length})</h2><table><tr><th class="l">Day</th><th class="l">Account</th><th class="l">Action</th><th class="l">Stock / contract</th><th>Shares / contracts</th><th>Price</th><th>Value</th><th>Tax</th><th class="l">Why</th></tr>${tradeRows}</table>`
    + `</body></html>`;
}

// ── sending ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface WeeklySendDeps {
  readonly store: TabStore;
  readonly kv: PropertyStore;
  readonly telegram: TelegramTarget;
  /** HTML to PDF (headless Chrome); null = no browser: nothing is sent (policy), and the week stays unsent. */
  readonly toPdf: ((html: string, pdfPath: string) => Promise<void>) | null;
  readonly log: (m: string) => void;
  readonly now: number;
  /** The run's time zone (New York): the Saturday check and "today". */
  readonly timeZone: string;
  /** By hand (npm run paper-weekly): no Saturday check and no double-send check; the week is still recorded. */
  readonly force?: boolean;
  /** The week to send (default: the last full week before today). */
  readonly week?: PaperWeek;
  /** Where the PDF is written (default: a new temp folder). */
  readonly outDir?: string;
}

export type WeeklyOutcome = 'sent' | 'not-saturday' | 'already-sent' | 'no-data' | 'no-browser' | 'failed';

/**
 * The weekly hook. On a Saturday night (or `force`) and a week not sent yet: reads the tabs, makes the PDF and sends it
 * with the bottom line as its caption; the week is recorded under PAPER_WEEKLY_KEY only once Telegram took it.
 * Never throws; every outcome is logged.
 */
export async function maybeSendPaperWeekly(d: WeeklySendDeps): Promise<WeeklyOutcome> {
  if (!d.force && !isWeeklyNight(d.now, d.timeZone)) return 'not-saturday';
  const week = d.week ?? lastFullWeek(dayIn(d.now, d.timeZone));
  const done = await d.kv.get(PAPER_WEEKLY_KEY).catch((e: unknown) => { d.log('paper weekly: the last week sent could not be read: ' + String(e)); return null; });
  if (!d.force && done === week.monday) { d.log('paper weekly: the week of ' + week.monday + ' was already sent'); return 'already-sent'; }
  const r = await readWeekly(d.store, week).catch((e: unknown) => { d.log('paper weekly: the paper tabs could not be read: ' + String(e)); return null; });
  if (!r) { d.log('paper weekly: no paper day in the week of ' + week.monday + '; nothing sent'); return 'no-data'; }
  if (!d.toPdf) { d.log('paper weekly: no browser, so no PDF (the 📈 Paper Values tab has it all)'); return 'no-browser'; }
  const toPdf = d.toPdf;
  const name = 'paper-week-' + week.monday + '.pdf';
  const dir = await Promise.resolve().then(() => { if (d.outDir) { fs.mkdirSync(d.outDir, { recursive: true }); return d.outDir; } return fs.mkdtempSync(path.join(os.tmpdir(), 'paper-week-')); })
    .catch((e: unknown) => { d.log('paper weekly: no folder for the PDF: ' + String(e)); return null; });
  if (!dir) return 'failed';
  const file = path.join(dir, name);
  const bytes = await Promise.resolve().then(() => toPdf(weeklyHtml(r), file)).then(() => new Uint8Array(fs.readFileSync(file))).catch((e: unknown) => { d.log('paper weekly: the PDF could not be made (nothing sent): ' + String(e)); return null; });
  if (!bytes) return 'failed';
  const sent = await sendPdfs(d.telegram, [{ name, bytes }], weeklyCaption(r), (m) => d.log('paper weekly: ' + m));
  if (!sent.length) return 'failed';
  await d.kv.set(PAPER_WEEKLY_KEY, week.monday).catch((e: unknown) => d.log('paper weekly: sent, but the week could not be recorded: ' + String(e)));
  d.log('paper weekly: the week ' + r.label + ' sent (' + r.accounts.length + ' accounts, ' + r.trades.length + ' log rows)');
  return 'sent';
}
