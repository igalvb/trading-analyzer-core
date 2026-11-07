/**
 * The phone dashboard's data (docs/DASHBOARD.md): ONE JSON file, `data/dashboard.json`, built from the tabs the runs
 * already write. Nothing is fetched and nothing is decided here: every number is read from a tab (or derived from
 * numbers in one, e.g. value = shares x price), so the dashboard shows what the reports show.
 *
 *   Portfolio              every holding, crypto included (the Exit report skips crypto; the dashboard shows it with
 *                          the sheet's own price and value), the open calls, and the CLOSED positions section (History)
 *   📒 Transactions         stock sales, matched first-in first-out against the buys (History)
 *   📤 Exit Report          the table of contents rows (holding, action, gain, stop, flags) and the NEEDS ATTENTION lines
 *   Exit Target History    the latest remembered T1 / T2 per holding
 *   🛒 Buy Report           the FULL RANKING rows (rank, ticker, conviction, fundamentals, timing, entry zone, verdict)
 *   📈 Decision History     the latest decision per ticker (Analyze tab)
 *   📈 Paper Values / 📒 Paper Log / 🔎 Paper Reads   the paper test (reports/paperWeekly.ts parses the first two)
 *   📈 Options Reads / 📐 Options Measures / 🌐 Market Options Read   the options read (shown, not scored)
 *   🩺 Run Health          the watchdog's rows (Runs tab); the minutes when GitHub was not asked
 *   🤖 Claude Ideas        Claude's recommendations list, no money (paper/claudeIdeas.ts; Paper tab, Ideas section)
 *   ledger/* (data branch) the net worth screen and the growth graph (ledger/networth.ts), when the `data` branch is
 *                          checked out (DATA_BRANCH_DIR, default <repo>/data-branch); absent: `networth` and `growth`
 *                          are left out (named in `missing`)
 *
 * The structured rows the pipelines write are preferred; a report tab is read only through its fixed table header
 * (reports/exitSheet/text.ts tocColumns, reports/buySheet/text.ts rankingColumns), never through free text.
 *
 * Schema: DASHBOARD_SCHEMA. Every section is optional: a tab that is missing or cannot be read leaves its section out
 * (named in `missing`), and the builder never throws (core/guard.ts orElse logs the failure). No secret, no sheet id
 * and no key is ever put in the JSON: only tab values and the profile's display words.
 *
 * Pure builder (buildDashboard) + thin I/O (readDashboardSources).
 */

import type { Logger } from '../core/logger.ts';
import { orElse } from '../core/guard.ts';
import type { TabCell, TabStore } from '../storage/tabStore.ts';
import { findHeaderRow, cell, toNumber, toDate, toStringSafe, toUpperTicker, type SheetRow, type SheetValue } from '../sheets/coerce.ts';
import { OPTIONS_REQUIRED, PURCHASE_DATE_COLUMNS, endsOpenOptions } from '../sheets/readers/portfolio.ts';
import { Tabs } from '../sheets/tabs.ts';
import { BITCOIN_ETF_TICKERS } from '../types/bitcoinEtfs.ts';
import { parseValues, parseLog, buildWeekly, foldSubAccounts, weekOf, weeklyCaption, QQQ_ROW, LIST_ROW, type ValueRow, type LogRow } from '../reports/paperWeekly.ts';
import { LOG_TAB, VALUES_TAB, READS_TAB, LOG_HEADER, VALUES_HEADER, READS_HEADER } from '../paper/paperLog.ts';
import { OPTIONS_READS_TAB, OPTIONS_READS_HEADER, OPTIONS_MEASURES_TAB, OPTIONS_MEASURES_HEADER, MARKET_OPTIONS_TAB, MARKET_OPTIONS_HEADER } from '../storage/optionsReadsTab.ts';
import { EXIT_SHEET_TAB, T as EXIT_TEXT } from '../reports/exitSheet/text.ts';
import { BUY_SHEET_TAB, T as BUY_TEXT } from '../reports/buySheet/text.ts';
import { EXIT_TARGET_HISTORY_SHEET, EXIT_TARGET_HISTORY_HEADERS } from '../stores/exitTargetHistory.ts';
import { DECISION_HISTORY_HEADERS, DECISION_HISTORY_OPTIONS_HEADERS } from '../stores/decisionHistory.ts';
import { TRANSACTIONS_SHEET, TRANSACTIONS_HEADERS } from '../portfolio/transactions.ts';
import { RUN_HEALTH_TAB, RUN_HEALTH_HEADER } from '../watchdog.ts';
import { FREE_MINUTES } from '../reports/digest/actionsMinutes.ts';
import { CLAUDE_IDEAS_TAB, CLAUDE_IDEAS_HEADER, parseIdeaZone, ideaStatusOf } from '../paper/claudeIdeas.ts';
import { buildNetWorth, buildGrowth, type LedgerSources, type NetWorth, type Growth } from '../ledger/networth.ts';

/** Bump when a field changes meaning or is removed (the app checks it); adding a field keeps the number. */
export const DASHBOARD_SCHEMA = 1;
/** The New York zone every "as of" is shown in (the market's). */
export const DASHBOARD_ZONE = 'America/New_York';
/** Nights of history the new options measures need before they may score (docs/OPTIONS_WEIGHTS_DUE_DILIGENCE). */
export const MEASURE_NIGHTS_NEEDED = 60;
/** Most Run Health rows sent (newest first). */
export const MAX_RUN_ROWS = 80;

export type Grid = readonly (readonly TabCell[])[];

/** The raw tabs (null = the tab is missing or could not be read). */
export interface DashboardSources {
  readonly portfolio?: Grid | null;
  readonly transactions?: Grid | null;
  readonly exitReport?: Grid | null;
  readonly exitTargets?: Grid | null;
  readonly buyReport?: Grid | null;
  readonly decisions?: Grid | null;
  readonly paperValues?: Grid | null;
  readonly paperLog?: Grid | null;
  readonly paperReads?: Grid | null;
  readonly optionsReads?: Grid | null;
  readonly optionsMeasures?: Grid | null;
  readonly marketOptions?: Grid | null;
  readonly runHealth?: Grid | null;
  readonly claudeIdeas?: Grid | null;
  /** The ledger files of the `data` branch (ledger/networth.ts readLedgerSources); null / absent = not checked out. */
  readonly ledger?: LedgerSources | null;
}

export interface DashboardContext {
  readonly nowMs: number;
  readonly taxRate: number;
  /** The user's list (profile lists.core). */
  readonly list: readonly string[];
  /** The profile's display words for the list and its yardsticks. */
  readonly labels: { readonly list: string; readonly holdCore: string; readonly holdList: string };
  readonly timeZone: string;
  readonly version?: string | null;
  readonly paper?: { readonly start: string | null; readonly end: string | null } | null;
  /** GitHub minutes when the workflow could ask GitHub; null = summed from 🩺 Run Health. */
  readonly minutes?: { readonly used: number; readonly cap: number } | null;
  readonly logger?: Logger | null;
  /** The day's USD/ILS rate when known from elsewhere; else the newest ledger snapshot's. */
  readonly fxUsdIls?: { readonly usdIls: number; readonly date?: string | null } | null;
}

// ── output shape ──────────────────────────────────────────────────────────────────────────────────────────────────

export type HoldingKind = 'stock' | 'etf' | 'btc' | 'crypto' | 'call' | 'put';
export type HoldingGroup = 'stocks' | 'btc' | 'crypto' | 'calls';

export interface DashHolding {
  readonly key: string;
  readonly ticker: string;
  readonly label: string;
  readonly kind: HoldingKind;
  readonly group: HoldingGroup;
  readonly qty: number | null;
  readonly price: number | null;
  /** 'live' = tonight's close from the paper reads; 'report' = the Exit report's "Current price" (same night); 'sheet' = the Portfolio sheet's own value. */
  readonly priceSource: 'live' | 'report' | 'sheet' | null;
  readonly value: number | null;
  readonly cost: number | null;
  readonly gain: number | null;
  readonly gainPct: number | null;
  readonly tax: number | null;
  readonly afterTax: number | null;
  readonly entryDate: string | null;
  readonly strike?: number | null;
  readonly expiry?: string | null;
  readonly dte?: number | null;
  readonly underlying?: number | null;
  /** False for crypto (the Exit report does not analyse it). */
  readonly analysed: boolean;
  readonly note: string | null;
  readonly action: string | null;
  readonly stopText: string | null;
  readonly stop: number | null;
  readonly t1: number | null;
  readonly t2: number | null;
  readonly flags: string | null;
  readonly why: string | null;
  /** The Portfolio tab's sub-type cell as written (the allocation pie); absent when the tab has none. */
  readonly subType?: string | null;
}

export interface DashGroupTotal { readonly id: HoldingGroup; readonly label: string; readonly count: number; readonly value: number; readonly cost: number; readonly gain: number }

export interface DashExitItem {
  readonly holding: string; readonly ticker: string; readonly kind: 'STOCK' | 'OPTION'; readonly strike: number | null;
  readonly action: string; readonly gainPct: number | null; readonly gainText: string; readonly stopText: string; readonly stop: number | null;
  readonly flags: string; readonly why: string | null;
  /** An option's expiry (YYYY-MM-DD) from the holding label; null for a stock. */
  readonly expiry: string | null;
  /** From the holding's own section of the report: the current price (stock), the trailing stop level (also when breached), T1 / T2 (null = no valid target). */
  readonly detail: { readonly price: number | null; readonly stopLevel: number | null; readonly t1: number | null; readonly t2: number | null } | null;
}

export interface DashBuyItem {
  readonly rank: number | null; readonly ticker: string; readonly conviction: number | null; readonly convictionText: string;
  readonly fundamentals: string; readonly timing: string; readonly zone: readonly [number, number] | null; readonly zoneText: string;
  readonly verdict: string; readonly verdictKey: string; readonly updated: string;
  readonly price: number | null; readonly zoneState: 'in' | 'above' | 'below' | null; readonly distancePct: number | null;
  /** Tonight's Washout ADD alert line for this stock (the Buy report's "🟢 Washout:" line); absent when none. */
  readonly washout?: string;
}

/** The Buy report's Washout ADD alert lines ("🟢 Washout: MU closed ..."), by ticker. */
export const WASHOUT_LINE = /^🟢 Washout: ([A-Z0-9.^=-]{1,12}) /;

export interface DashHistoryItem {
  readonly date: string | null; readonly year: number | null; readonly ticker: string; readonly label: string; readonly kind: 'stock' | 'call' | 'put' | 'other';
  readonly qty: number | null; readonly cost: number | null; readonly proceeds: number | null; readonly gain: number | null; readonly gainPct: number | null;
  readonly tax: number | null; readonly heldDays: number | null; readonly source: 'portfolio-closed' | 'transactions';
}

export interface DashPaperAccount {
  readonly name: string; readonly group: string; readonly yardstick: boolean; readonly joined: string; readonly value: number;
  readonly weekPct: number; readonly sincePct: number; readonly vsQqq: number | null; readonly vsList: number | null;
  readonly deepestFall: number; readonly buysThisWeek: number; readonly sellsThisWeek: number; readonly holds: string;
  /** Values on `paper.days` (null before the account joined). */
  readonly series: readonly (number | null)[];
}

export interface DashWeekly { readonly monday: string; readonly friday: string; readonly label: string; readonly caption: string; readonly partial: boolean; readonly best: readonly { readonly name: string; readonly weekPct: number }[]; readonly worst: readonly { readonly name: string; readonly weekPct: number }[]; readonly beat: { readonly n: number; readonly m: number }; readonly qqqWeekPct: number | null; readonly trades: number }

export interface DashRun { readonly date: string; readonly job: string; readonly expected: string; readonly ran: string; readonly result: string; readonly status: 'ok' | 'warn' | 'fail'; readonly minutes: number | null; readonly warnings: number | null; readonly errors: number | null; readonly problem: string; readonly link: string }

export interface DashIdea {
  readonly date: string; readonly day: string | null; readonly ticker: string; readonly kind: string; readonly idea: string;
  readonly zoneText: string; readonly zone: readonly [number, number] | null; readonly stop: number | null; readonly target: number | null;
  readonly horizon: string; readonly reason: string; readonly status: string; readonly open: boolean; readonly outcome: string;
  /** Tonight's close (🔎 Paper Reads) and where it stands against the zone; null when no close is known. */
  readonly price: number | null; readonly zoneState: 'in' | 'above' | 'below' | null; readonly distancePct: number | null;
}

export interface DashboardData {
  readonly schema: number;
  readonly asOf: string;
  readonly asOfText: string;
  readonly version: string | null;
  readonly user: { readonly labels: { readonly list: string; readonly holdCore: string; readonly holdList: string; readonly qqq: string }; readonly taxRate: number; readonly list: readonly string[]; readonly timeZone: string };
  readonly portfolio?: { readonly holdings: readonly DashHolding[]; readonly groups: readonly DashGroupTotal[]; readonly total: { readonly value: number; readonly cost: number; readonly gain: number; readonly tax: number; readonly afterTax: number } };
  /** asOf = the report's run day ("Run time: ..." line, runTime its text); targetsDay = the latest Exit Target History day. */
  readonly exit?: { readonly asOf: string | null; readonly runTime: string | null; readonly targetsDay: string | null; readonly items: readonly DashExitItem[]; readonly counts: Readonly<Record<string, number>> };
  readonly buy?: { readonly runTime: string | null; readonly items: readonly DashBuyItem[] };
  readonly ideas?: { readonly items: readonly DashIdea[] };
  readonly history?: { readonly items: readonly DashHistoryItem[]; readonly years: readonly { readonly year: number; readonly count: number; readonly gain: number; readonly tax: number }[] };
  readonly paper?: {
    readonly start: string | null; readonly end: string | null; readonly days: readonly string[]; readonly accounts: readonly DashPaperAccount[];
    /** Every 📒 Paper Log row by account: [day, when, action, stock, qty, price, value, tax, why]. */
    readonly trades: Readonly<Record<string, readonly (readonly string[])[]>>;
    readonly weekly: readonly DashWeekly[]; readonly qqq: string; readonly list: string;
  };
  readonly options?: {
    readonly day: string | null;
    readonly rows: readonly { readonly ticker: string; readonly status: string; readonly pcOi: number | null; readonly pcVol: number | null; readonly netBiasPct: number | null; readonly dirSig: number | null; readonly ivPct: number | null; readonly frontIv: number | null; readonly backIv: number | null; readonly leapsLean: string; readonly term: string }[];
    readonly measures: { readonly day: string | null; readonly need: number; readonly rows: readonly { readonly ticker: string; readonly smirk: number | null; readonly ivSpread: number | null; readonly osRatio: number | null; readonly pcOi: number | null; readonly nights: number | null; readonly convictionPts: number | null }[] };
    readonly market: readonly { readonly etf: string; readonly spot: number | null; readonly pcOi: number | null; readonly skew: number | null; readonly iv30: number | null; readonly rv20: number | null; readonly vix: number | null; readonly read: string }[];
  };
  readonly models?: { readonly day: string | null; readonly names: readonly string[]; readonly rows: readonly { readonly model: string; readonly bull: number; readonly neutral: number; readonly bear: number }[]; readonly stocks: readonly { readonly ticker: string; readonly close: number | null; readonly conviction: number | null; readonly timing: string; readonly verdict: string; readonly stop: number | null; readonly zone: string; readonly t1: number | null; readonly t2: number | null; readonly reads: Readonly<Record<string, string>> }[] };
  readonly decisions?: { readonly latest: readonly { readonly date: string | null; readonly ticker: string; readonly own: number | null; readonly timing: number | null; readonly conviction: number | null; readonly action: string; readonly options: string }[] };
  readonly runs?: { readonly items: readonly DashRun[] };
  readonly minutes?: { readonly used: number; readonly cap: number; readonly source: 'github' | 'run-health' };
  readonly market?: readonly { readonly name: string; readonly value: number | null }[];
  /** Everything the owner has, from the ledger (stocks, crypto and calls priced live), in USD and ILS. */
  readonly networth?: NetWorth;
  /** The growth graph: one snapshot per day and the money in / out marks. */
  readonly growth?: Growth;
  /** Sections left out (their tab missing or unreadable). */
  readonly missing: readonly string[];
}

// ── small helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

const rowsOf = (g: Grid | null | undefined): SheetRow[] => (g ?? []).map((r) => [...r] as SheetRow);
const n = (v: unknown): number | null => toNumber(v as SheetValue);
const s = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : toStringSafe(v as SheetValue));
const r2 = (x: number | null): number | null => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const r4 = (x: number | null): number | null => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10_000) / 10_000);
/** A date cell (Date, Sheets serial, ISO or M/D/YYYY text) as YYYY-MM-DD; null when it is not a date. */
export function dayOf(v: unknown): string | null {
  if (v === '' || v == null) return null;
  if (typeof v === 'number' && (v < 20_000 || v > 80_000)) return null;
  const d = toDate(v as SheetValue);
  return d ? d.toISOString().slice(0, 10) : null;
}
const daysBetween = (a: string, b: string): number => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86_400_000);

/** "Fri 6 Nov 2026, 23:40 NY". */
export function asOfText(nowMs: number): string {
  const d = new Date(nowMs);
  const part = (o: Intl.DateTimeFormatOptions): string => d.toLocaleString('en-GB', { timeZone: DASHBOARD_ZONE, ...o });
  return part({ weekday: 'short' }) + ' ' + part({ day: 'numeric' }) + ' ' + part({ month: 'short' }) + ' ' + part({ year: 'numeric' }) + ', '
    + part({ hour: '2-digit', minute: '2-digit', hour12: false }) + ' NY';
}

/** The column index of each header name in row `at` of the grid (first match), or the given fallback order. */
function columnsOf(rows: SheetRow[], header: readonly string[]): { readonly at: (name: string) => number; readonly dataFrom: number } {
  const first = (rows[0] ?? []).map((c) => toStringSafe(c));
  const hasHeader = first[0] === header[0];
  return { at: (name) => { const i = hasHeader ? first.indexOf(name) : -1; return i >= 0 ? i : header.indexOf(name); }, dataFrom: hasHeader ? 1 : 0 };
}

/** The rows of the latest day (column 0) of a one-block-per-night tab. */
function latestDayRows(rows: SheetRow[], dataFrom: number): { day: string | null; rows: SheetRow[] } {
  let day: string | null = null;
  for (const r of rows.slice(dataFrom)) { const d = dayOf(r[0]); if (d && (!day || d > day)) day = d; }
  return { day, rows: day ? rows.slice(dataFrom).filter((r) => dayOf(r[0]) === day) : [] };
}

/** A grid row whose cells j..j+k equal `header` (a report tab's fixed table header): its row index and first column. */
function findTable(rows: SheetRow[], header: readonly string[]): { row: number; col: number } | null {
  for (let r = 0; r < rows.length; r++) {
    const cells = (rows[r] ?? []).map((c) => toStringSafe(c));
    for (let j = 0; j + header.length <= cells.length + 1; j++) {
      if (header.every((h, k) => h === '' || cells[j + k] === h)) return { row: r, col: j };
    }
  }
  return null;
}

const DOLLARS = /\$\s?(-?[\d,]+(?:\.\d+)?)/g;
const dollarsIn = (text: string): number[] => [...text.matchAll(DOLLARS)].map((m) => Number((m[1] as string).replace(/,/g, ''))).filter(Number.isFinite);

// ── live prices: tonight's closes from 🔎 Paper Reads ─────────────────────────────────────────────────────────────

export function livePrices(reads: Grid | null | undefined): Map<string, number> {
  const rows = rowsOf(reads), c = columnsOf(rows, READS_HEADER);
  const out = new Map<string, { day: string; close: number }>();
  for (const r of rows.slice(c.dataFrom)) {
    const day = dayOf(r[0]), t = toUpperTicker(r[c.at('Stock')]), close = n(r[c.at('Close')]);
    if (!day || !t || close == null) continue;
    const had = out.get(t);
    if (!had || day >= had.day) out.set(t, { day, close });
  }
  return new Map([...out].map(([t, v]) => [t, v.close]));
}

// ── the Exit report: table of contents + needs attention ─────────────────────────────────────────────────────────

export function parseExitReport(grid: Grid | null | undefined): DashExitItem[] {
  const rows = rowsOf(grid);
  const at = findTable(rows, EXIT_TEXT.tocColumns);
  if (!at) return [];
  const items: DashExitItem[] = [];
  for (let r = at.row + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const holding = s(row[at.col]), action = s(row[at.col + 1]);
    if (!holding || !action) break;
    const m = /^(\S+)\s+(call|put)\s+\$([\d.,]+)(?:\s+(\d{4}-\d{2}-\d{2}))?/i.exec(holding);
    const gainText = s(row[at.col + 2]), stopText = s(row[at.col + 3]);
    const g = /^([+-]?\d+(?:\.\d+)?)%/.exec(gainText.replace(/\s/g, '').replace('−', '-'));
    items.push({
      holding, ticker: (m ? m[1] as string : holding).toUpperCase(), kind: m ? 'OPTION' : 'STOCK', strike: m ? Number((m[3] as string).replace(/,/g, '')) : null,
      action, gainPct: g ? Number(g[1]) : null, gainText, stopText, stop: /^stop\b/i.test(stopText) ? (dollarsIn(stopText)[0] ?? null) : null,
      flags: s(row[at.col + 4]), why: null, expiry: m?.[4] ?? null, detail: null,
    });
  }
  // Fix 2026-11-06 (live QA): each holding's own section ("═══ <holding> ═══") carries the report's current price, the
  // trailing stop level (also when breached) and T1 / T2 of THIS run; Exit Target History may hold older targets.
  const details = new Map<string, NonNullable<DashExitItem['detail']>>();
  let cur: string | null = null, d: { price: number | null; stopLevel: number | null; t1: number | null; t2: number | null } | null = null;
  for (const row of rows) {
    const k = s(row[0]), v = s(row[1]);
    const sec = /^═══ (.+) ═══$/.exec(k);
    if (sec) { if (cur && d) details.set(cur, d); cur = sec[1] as string; d = { price: null, stopLevel: null, t1: null, t2: null }; continue; }
    if (!d) continue;
    const first = dollarsIn(v.split(/[—,(]/)[0] ?? '')[0] ?? null;
    if (k === 'Current price' || k === 'Current option price') d.price = first;
    else if (/^Trailing stop/.test(k)) d.stopLevel = first;
    else if (k === 'Target 1') d.t1 = first;
    else if (k === 'Target 2') d.t2 = first;
  }
  if (cur && d) details.set(cur, d);
  for (let i = 0; i < items.length; i++) { const x = details.get(items[i]!.holding); if (x) items[i] = { ...items[i]!, detail: x }; }
  // NEEDS ATTENTION: one "holding | sentence" row per urgent holding, then its detail rows, until the next one-cell band.
  const head = rows.findIndex((row) => (row ?? []).some((c) => toStringSafe(c) === EXIT_TEXT.attentionHeader));
  if (head >= 0) {
    const byLabel = new Map(items.map((x, i) => [x.holding, i]));
    for (let r = head + 1; r < rows.length; r++) {
      const cells = (rows[r] ?? []).map((c) => toStringSafe(c));
      const filled = cells.filter(Boolean);
      if (filled.length < 2) { if (filled.length === 1) break; continue; }
      const i = byLabel.get(cells[0] as string);
      if (i !== undefined && !items[i]!.why) items[i] = { ...items[i]!, why: cells[1] as string };
    }
  }
  return items;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/**
 * A report tab's "Run time: Nov 5, 2026, 11:49 PM EST" line (Exit and Buy reports, T.runLabel): the text after the
 * label and its day (YYYY-MM-DD, the report's own zone); null when the tab has no such line.
 */
export function reportRunTime(grid: Grid | null | undefined, label: string = EXIT_TEXT.runLabel): { text: string; day: string | null } | null {
  for (const row of rowsOf(grid).slice(0, 12)) {
    const c = s(row[0]);
    if (!c.startsWith(label)) continue;
    const text = c.slice(label.length).trim();
    const m = /\b([A-Z][a-z]{2})[a-z]* (\d{1,2}), (\d{4})/.exec(text);
    const mi = m ? MONTHS.indexOf(m[1] as string) : -1;
    return { text, day: m && mi >= 0 ? m[3] + '-' + String(mi + 1).padStart(2, '0') + '-' + String(m[2]).padStart(2, '0') : dayOf(text) };
  }
  return null;
}

/** The latest Exit Target History row per holding key: T1 / T2 (and the day). */
export function latestTargets(grid: Grid | null | undefined): Map<string, { day: string | null; t1: number | null; t2: number | null; ticker: string }> {
  const rows = rowsOf(grid), c = columnsOf(rows, EXIT_TARGET_HISTORY_HEADERS);
  const out = new Map<string, { day: string | null; t1: number | null; t2: number | null; ticker: string }>();
  for (const r of rows.slice(c.dataFrom)) {
    const key = s(r[c.at('Holding')]);
    if (!key) continue;
    const day = dayOf(r[c.at('Date')]);
    const had = out.get(key);
    if (had && had.day && day && day < had.day) continue;
    out.set(key, { day, t1: n(r[c.at('T1')]), t2: n(r[c.at('T2')]), ticker: toUpperTicker(r[c.at('Ticker')]) });
  }
  return out;
}

// ── the Buy report: FULL RANKING ─────────────────────────────────────────────────────────────────────────────────

export function parseBuyReport(grid: Grid | null | undefined, prices: ReadonlyMap<string, number>): DashBuyItem[] {
  const rows = rowsOf(grid);
  const at = findTable(rows, BUY_TEXT.rankingColumns.slice(0, 6));
  if (!at) return [];
  const out: DashBuyItem[] = [];
  const wash = new Map<string, string>();
  for (const row of rows) for (const c of row ?? []) { const w = WASHOUT_LINE.exec(s(c)); if (w) wash.set(w[1] as string, s(c).slice(0, 300)); }
  for (let r = at.row + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const head = s(row[at.col]);
    const m = /^#(\d+)\s+(\S+)/.exec(head);
    if (!m) break;
    const ticker = (m[2] as string).toUpperCase(), convictionText = s(row[at.col + 1]), zoneText = s(row[at.col + 4]), verdict = s(row[at.col + 5]);
    const z = dollarsIn(zoneText);
    const zone: readonly [number, number] | null = z.length >= 2 ? [Math.min(z[0] as number, z[1] as number), Math.max(z[0] as number, z[1] as number)] : z.length === 1 ? [z[0] as number, z[0] as number] : null;
    const price = r4(prices.get(ticker) ?? null);
    let zoneState: DashBuyItem['zoneState'] = null, distancePct: number | null = null;
    if (zone && price != null) {
      zoneState = price > zone[1] ? 'above' : price < zone[0] ? 'below' : 'in';
      distancePct = zoneState === 'above' ? r2((price / zone[1] - 1) * 100) : zoneState === 'below' ? r2((price / zone[0] - 1) * 100) : 0;
    }
    const cm = /-?\d+(?:\.\d+)?/.exec(convictionText);
    out.push({
      rank: Number(m[1]), ticker, conviction: cm ? Number(cm[0]) : null, convictionText, fundamentals: s(row[at.col + 2]), timing: s(row[at.col + 3]),
      zone, zoneText, verdict, verdictKey: verdictKeyOf(verdict), updated: s(row[at.col + 7]), price, zoneState, distancePct,
      ...(wash.has(ticker) ? { washout: wash.get(ticker) as string } : {}),
    });
  }
  return out;
}

/** The verdict without its tags, upper case: "BUY NOW", "SET A BUY LIMIT", "WAIT", ... */
export function verdictKeyOf(text: string): string {
  const t = text.toUpperCase();
  for (const k of ['BUY NOW', 'SET A BUY LIMIT', 'BUY LIMIT', 'WAIT', 'AVOID', 'NO VERDICT', 'HOLD', 'WATCH']) if (t.includes(k)) return k;
  return t.split(/[—(·.]/)[0]!.trim() || 'OTHER';
}

// ── Portfolio: holdings (crypto included) and the CLOSED section ───────────────────────────────────────────────────

const STOCK_COLS = { price: ['price per item', 'price'], value: ['value of inverstment', 'value of investment', 'value'], sub: ['sub-type', 'subtype'] } as const;
const firstCol = (cols: Readonly<Record<string, number>>, names: readonly string[]): string | null => names.find((x) => cols[x] !== undefined) ?? null;

function purchaseDay(row: SheetRow, cols: Readonly<Record<string, number>>): string | null {
  for (const name of [...PURCHASE_DATE_COLUMNS, 'Purchase Date', 'Purchase Data']) if (cols[name] !== undefined) return dayOf(cell(row, cols, name));
  return null;
}

function taxView(value: number | null, cost: number | null, rate: number): Pick<DashHolding, 'gain' | 'gainPct' | 'tax' | 'afterTax'> {
  if (value == null || cost == null) return { gain: null, gainPct: null, tax: null, afterTax: null };
  const gain = value - cost, tax = Math.max(0, gain) * rate;
  return { gain: r2(gain), gainPct: cost > 0 ? r2((gain / cost) * 100) : null, tax: r2(tax), afterTax: r2(gain - tax) };
}

export function parseHoldings(grid: Grid | null | undefined, ctx: { readonly taxRate: number; readonly nowMs: number }, prices: ReadonlyMap<string, number>, exit: readonly DashExitItem[], targets: ReturnType<typeof latestTargets>): DashHolding[] {
  const rows = rowsOf(grid);
  const out: DashHolding[] = [];
  const today = new Date(ctx.nowMs).toISOString().slice(0, 10);
  const exitStock = new Map(exit.filter((e) => e.kind === 'STOCK').map((e) => [e.ticker, e]));
  // Fix 2026-11-06 (live QA): two calls of one ticker and strike (IBIT $38 Jun 2027 and Dec 2027) are told apart by the expiry.
  const exitOption = (t: string, strike: number | null, expiry: string | null): DashExitItem | undefined => {
    const same = exit.filter((e) => e.kind === 'OPTION' && e.ticker === t && (strike == null || e.strike === strike));
    return same.find((e) => expiry != null && e.expiry === expiry) ?? same.find((e) => e.expiry == null) ?? (same.length === 1 && expiry == null ? same[0] : undefined);
  };
  const targetFor = (key: string, t: string, strike: number | null, e?: DashExitItem): { t1: number | null; t2: number | null } => {
    if (e?.detail) return { t1: r4(e.detail.t1), t2: r4(e.detail.t2) };
    const direct = targets.get(key);
    if (direct) return { t1: r4(direct.t1), t2: r4(direct.t2) };
    for (const [k, v] of targets) if (v.ticker === t && (strike == null ? !/ CALL | PUT /.test(k) : k.includes(' ' + strike + ' '))) return { t1: r4(v.t1), t2: r4(v.t2) };
    return { t1: null, t2: null };
  };
  const verdictFields = (e: DashExitItem | undefined): Pick<DashHolding, 'action' | 'stopText' | 'stop' | 'flags' | 'why'> =>
    ({ action: e?.action ?? null, stopText: e?.stopText ?? null, stop: e?.stop ?? e?.detail?.stopLevel ?? null, flags: e?.flags || null, why: e?.why ?? null });

  const stockHead = findHeaderRow(rows, ['Ticker', 'cost avg per stock']);
  if (stockHead) {
    const cols = stockHead.columns;
    const priceCol = firstCol(cols, STOCK_COLS.price), valueCol = firstCol(cols, STOCK_COLS.value), subCol = firstCol(cols, STOCK_COLS.sub);
    for (let r = stockHead.rowIndex + 1; r < rows.length; r++) {
      const row = rows[r] ?? [];
      const ticker = toUpperTicker(cell(row, cols, 'Ticker'));
      const type = toStringSafe(cell(row, cols, 'type')).toLowerCase();
      if (!ticker || ticker.includes('*') || ticker.startsWith('TOTAL') || (type !== 'stock' && type !== 'crypto')) continue;
      if (type === 'stock' && /\s/.test(ticker)) continue;
      const qty = n(cell(row, cols, 'amount')), avg = n(cell(row, cols, 'cost avg per stock'));
      const sheetPrice = priceCol ? n(cell(row, cols, priceCol)) : null, sheetValue = valueCol ? n(cell(row, cols, valueCol)) : null;
      const live = type === 'stock' ? prices.get(ticker) ?? null : null;
      const e = type === 'crypto' ? undefined : exitStock.get(ticker);
      // Fix 2026-11-06 (live QA): a stale sheet price (FBTC $35.01 while it traded at $66.17) is replaced by the Exit
      // report's own "Current price" of the same night when there is no paper-read close; crypto keeps the sheet's.
      const reported = e?.detail?.price ?? null;
      const price = live ?? reported ?? sheetPrice ?? (sheetValue != null && qty ? sheetValue / qty : null);
      const value = price != null && qty != null ? price * qty : sheetValue;
      const cost = qty != null && avg != null ? qty * avg : null;
      const subText = subCol ? toStringSafe(cell(row, cols, subCol)).trim() : '';
      const sub = subText.toLowerCase();
      const kind: HoldingKind = type === 'crypto' ? 'crypto' : BITCOIN_ETF_TICKERS.includes(ticker) ? 'btc' : /etf|fund/.test(sub) ? 'etf' : 'stock';
      const crypto = kind === 'crypto';
      const tg = crypto ? { t1: null, t2: null } : targetFor(ticker, ticker, null, e);
      out.push({
        key: (crypto ? 'crypto:' : 'stock:') + ticker + ':' + (r + 1), ticker, label: holdingLabel(ticker, kind), kind, group: kind === 'crypto' ? 'crypto' : kind === 'btc' ? 'btc' : 'stocks',
        qty, price: r4(price), priceSource: live != null ? 'live' : reported != null ? 'report' : price != null ? 'sheet' : null, value: r2(value), cost: r2(cost), ...taxView(value, cost, ctx.taxRate),
        entryDate: purchaseDay(row, cols), analysed: !crypto, note: crypto ? 'not analysed (crypto)' : null,
        ...verdictFields(e), t1: tg.t1, t2: tg.t2, ...(subText ? { subType: subText.slice(0, 60) } : {}),
      });
    }
  }

  const optHead = findHeaderRow(rows, OPTIONS_REQUIRED);
  if (optHead) {
    const cols = optHead.columns;
    for (let r = optHead.rowIndex + 1; r < rows.length; r++) {
      const row = rows[r] ?? [];
      const ticker = toUpperTicker(cell(row, cols, 'Ticker'));
      if (!ticker || ticker.includes('*') || ticker.startsWith('TOTAL')) continue;
      if (endsOpenOptions(ticker)) break;
      const contracts = n(cell(row, cols, 'positions')), strike = n(cell(row, cols, 'strike'));
      const side = toStringSafe(cell(row, cols, 'PUT/CALL')).toLowerCase() === 'put' ? 'put' : 'call';
      const expiry = dayOf(cell(row, cols, 'last trade Date'));
      const premium = n(cell(row, cols, 'avg price - Premium paid'));
      const basis = cols['cost basis'] !== undefined ? n(cell(row, cols, 'cost basis')) : null;
      const value = cols['current market value'] !== undefined ? n(cell(row, cols, 'current market value')) : null;
      const cost = basis ?? (contracts != null && premium != null ? contracts * premium * 100 : null);
      const price = value != null && contracts ? value / (contracts * 100) : null;
      const e = exitOption(ticker, strike, expiry);
      const tg = targetFor(ticker + ' CALL ' + (strike ?? '?') + ' ' + (expiry ?? '?'), ticker, strike, e);
      out.push({
        key: 'option:' + ticker + ':' + (r + 1), ticker, label: ticker + ' ' + (strike ?? '?') + (side === 'put' ? 'P' : 'C') + (expiry ? ' ' + expiry : ''), kind: side, group: 'calls',
        qty: contracts, price: r4(price), priceSource: price != null ? 'sheet' : null, value: r2(value), cost: r2(cost), ...taxView(value, cost, ctx.taxRate),
        entryDate: purchaseDay(row, cols), strike, expiry, dte: expiry ? daysBetween(today, expiry) : null, underlying: r4(prices.get(ticker) ?? null),
        analysed: true, note: null, ...verdictFields(e), t1: tg.t1, t2: tg.t2,
      });
    }
  }
  return out;
}

/**
 * Crypto coins by name, and the one bitcoin fund whose ticker is also the coin's: a holding list with both rows "BTC"
 * (Grayscale Bitcoin Mini Trust and the coin itself) must tell them apart (fix 2026-11-06, live QA).
 */
export const CRYPTO_NAMES: Readonly<Record<string, string>> = { BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana' };
export const FUND_LABELS: Readonly<Record<string, string>> = { BTC: 'BTC (Grayscale mini)' };
export function holdingLabel(ticker: string, kind: HoldingKind): string {
  if (kind === 'crypto') return CRYPTO_NAMES[ticker] ?? ticker;
  if (kind === 'btc') return FUND_LABELS[ticker] ?? ticker;
  return ticker;
}

export const GROUP_LABELS: Readonly<Record<HoldingGroup, string>> = { stocks: 'Stocks & ETFs', btc: 'Bitcoin funds', crypto: 'Crypto', calls: 'Calls' };

export function groupTotals(holdings: readonly DashHolding[]): DashGroupTotal[] {
  return (Object.keys(GROUP_LABELS) as HoldingGroup[]).map((id) => {
    const hs = holdings.filter((h) => h.group === id);
    const sum = (k: 'value' | 'cost' | 'gain'): number => r2(hs.reduce((a, h) => a + (h[k] ?? 0), 0)) as number;
    return { id, label: GROUP_LABELS[id], count: hs.length, value: sum('value'), cost: sum('cost'), gain: sum('gain') };
  }).filter((g) => g.count > 0);
}

/** The Portfolio tab's CLOSED positions section (options sold): one history row each. */
export function parseClosed(grid: Grid | null | undefined, rate: number): DashHistoryItem[] {
  const rows = rowsOf(grid);
  const head = findHeaderRow(rows, ['Ticker', 'Sell Price']);
  if (!head) return [];
  const cols = head.columns, out: DashHistoryItem[] = [];
  for (let r = head.rowIndex + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const ticker = toUpperTicker(cell(row, cols, 'Ticker'));
    if (!ticker || ticker.includes('*') || ticker.startsWith('TOTAL') || ticker === 'TICKER') continue;
    const qty = n(cell(row, cols, 'positions')), strike = n(cell(row, cols, 'strike')), sell = n(cell(row, cols, 'Sell Price'));
    const premium = n(cell(row, cols, 'avg price - Premium paid')), basis = cols['cost basis'] !== undefined ? n(cell(row, cols, 'cost basis')) : null;
    const side = toStringSafe(cell(row, cols, 'PUT/CALL')).toLowerCase() === 'put' ? 'put' : 'call';
    const date = dayOf(cell(row, cols, 'Sell Date')), expiry = dayOf(cell(row, cols, 'last trade Date')), bought = purchaseDay(row, cols);
    if (qty == null && sell == null) continue;
    const cost = basis ?? (qty != null && premium != null ? qty * premium * 100 : null);
    // Fix 2026-11-06 (live): 'Sell Price' is sometimes a per-share option price (like the premium) and sometimes the
    // contract's dollar total (e.g. $9,049 for 1 contract bought at 48.1 = $4,810). A price 10x or more above the
    // per-share premium is read as per contract; otherwise per share (x100).
    const perContract = sell != null && premium != null && premium > 0 && sell >= premium * 10;
    const proceeds = qty != null && sell != null ? qty * sell * (perContract ? 1 : 100) : null;
    out.push(historyItem({ date, ticker, label: ticker + ' ' + (strike ?? '?') + (side === 'put' ? 'P' : 'C') + (expiry ? ' ' + expiry : ''), kind: side, qty, cost, proceeds, heldDays: bought && date ? daysBetween(bought, date) : null, source: 'portfolio-closed' }, rate));
  }
  return out;
}

function historyItem(x: { date: string | null; ticker: string; label: string; kind: DashHistoryItem['kind']; qty: number | null; cost: number | null; proceeds: number | null; heldDays: number | null; source: DashHistoryItem['source'] }, rate: number): DashHistoryItem {
  const gain = x.cost != null && x.proceeds != null ? x.proceeds - x.cost : null;
  return {
    ...x, year: x.date ? Number(x.date.slice(0, 4)) : null, cost: r2(x.cost), proceeds: r2(x.proceeds), gain: r2(gain),
    gainPct: gain != null && x.cost ? r2((gain / x.cost) * 100) : null, tax: gain != null ? r2(Math.max(0, gain) * rate) : null,
  };
}

/** Sales in 📒 Transactions, matched first-in first-out against earlier buys of the same holding. */
export function parseTransactions(grid: Grid | null | undefined, rate: number): DashHistoryItem[] {
  const rows = rowsOf(grid), c = columnsOf(rows, TRANSACTIONS_HEADERS);
  const tx = rows.slice(c.dataFrom).map((r) => ({
    date: dayOf(r[c.at('Date')]), ticker: toUpperTicker(r[c.at('Ticker')]), type: s(r[c.at('Asset Type')]).toLowerCase(), action: s(r[c.at('Action')]).toUpperCase(),
    qty: n(r[c.at('Shares/Contracts')]), price: n(r[c.at('Price')]), strike: n(r[c.at('Strike')]), expiry: s(r[c.at('Expiry')]),
  })).filter((t) => t.ticker && t.qty != null && t.qty > 0 && t.price != null && t.date).sort((a, b) => (a.date as string).localeCompare(b.date as string));
  const lots = new Map<string, { qty: number; price: number; date: string }[]>();
  const out: DashHistoryItem[] = [];
  for (const t of tx) {
    const option = /opt|call|put/.test(t.type);
    const key = t.ticker + '|' + (option ? t.strike + '|' + t.expiry : '');
    const mult = option ? 100 : 1;
    const book = lots.get(key) ?? lots.set(key, []).get(key)!;
    if (/BUY|BOUGHT/.test(t.action)) { book.push({ qty: t.qty as number, price: t.price as number, date: t.date as string }); continue; }
    if (!/SELL|SOLD/.test(t.action)) continue;
    let left = t.qty as number, cost = 0, first: string | null = null, matched = 0;
    while (left > 1e-9 && book.length) {
      const lot = book[0]!, take = Math.min(lot.qty, left);
      cost += take * lot.price * mult; matched += take; first ??= lot.date;
      lot.qty -= take; left -= take;
      if (lot.qty <= 1e-9) book.shift();
    }
    const kind: DashHistoryItem['kind'] = option ? (/put/.test(t.type) ? 'put' : 'call') : 'stock';
    out.push(historyItem({
      date: t.date, ticker: t.ticker, label: option ? t.ticker + ' ' + (t.strike ?? '?') + (kind === 'put' ? 'P' : 'C') + (t.expiry ? ' ' + t.expiry : '') : t.ticker, kind,
      qty: t.qty, cost: matched > 0 && left <= 1e-9 ? cost : null, proceeds: (t.qty as number) * (t.price as number) * mult, heldDays: first ? daysBetween(first, t.date as string) : null, source: 'transactions',
    }, rate));
  }
  return out;
}

export function historyYears(items: readonly DashHistoryItem[], rate: number): { year: number; count: number; gain: number; tax: number }[] {
  const by = new Map<number, { count: number; gain: number }>();
  for (const it of items) {
    if (it.year == null) continue;
    const y = by.get(it.year) ?? { count: 0, gain: 0 };
    y.count++; y.gain += it.gain ?? 0;
    by.set(it.year, y);
  }
  return [...by].sort((a, b) => b[0] - a[0]).map(([year, y]) => ({ year, count: y.count, gain: r2(y.gain) as number, tax: r2(Math.max(0, y.gain) * rate) as number }));
}

// ── the paper test ────────────────────────────────────────────────────────────────────────────────────────────────

export { foldSubAccounts };

export function buildPaper(values: readonly ValueRow[], rawLog: readonly LogRow[], paper: DashboardContext['paper']): NonNullable<DashboardData['paper']> | null {
  const days = [...new Set(values.map((v) => v.day))].sort();
  const last = days[days.length - 1];
  if (!last) return null;
  const log = foldSubAccounts(values, rawLog);
  const now = buildWeekly(values, log, weekOf(last));
  if (!now) return null;
  const byAcc = new Map<string, Map<string, number>>();
  for (const v of values) (byAcc.get(v.account) ?? byAcc.set(v.account, new Map()).get(v.account)!).set(v.day, v.value);
  const accounts: DashPaperAccount[] = now.accounts.map((a) => ({
    name: a.account, group: a.group, yardstick: a.yardstick, joined: a.joined, value: r2(a.value) as number, weekPct: r2(a.weekPct) as number, sincePct: r2(a.sincePct) as number,
    vsQqq: r2(a.vsQqq), vsList: r2(a.vsList), deepestFall: r2(a.deepestFall) as number, buysThisWeek: a.buys, sellsThisWeek: a.sells, holds: a.holds,
    series: days.map((d) => r2(byAcc.get(a.account)?.get(d) ?? null)),
  }));
  const trades: Record<string, string[][]> = {};
  for (const t of log) (trades[t.account] ??= []).push([t.day, t.part ? t.when + ' · ' + t.part : t.when, t.action, t.stock, t.qty, t.price, t.value, t.tax, t.why]);
  const mondays = [...new Set(days.map((d) => weekOf(d).monday))].sort().reverse();
  const weekly: DashWeekly[] = [];
  for (const m of mondays) {
    const w = buildWeekly(values, log, weekOf(m));
    if (!w) continue;
    const short = (x: { account: string; weekPct: number }): { name: string; weekPct: number } => ({ name: x.account, weekPct: r2(x.weekPct) as number });
    weekly.push({ monday: w.week.monday, friday: w.week.friday, label: w.label, caption: weeklyCaption(w), partial: w.week.friday > last || (w.days.length < 5 && w.week.friday >= last), best: w.best.map(short), worst: w.worst.map(short), beat: w.beatBoth, qqqWeekPct: w.qqq ? r2(w.qqq.weekPct) : null, trades: w.trades.length });
  }
  return { start: paper?.start ?? days[0] ?? null, end: paper?.end ?? null, days, accounts, trades, weekly, qqq: QQQ_ROW, list: LIST_ROW };
}

// ── 🤖 Claude Ideas ───────────────────────────────────────────────────────────────────────────────────────────────

/** The '🤖 Claude Ideas' rows, newest first, with tonight's close against the entry zone when known. */
export function parseIdeas(grid: Grid | null | undefined, prices: ReadonlyMap<string, number>): DashIdea[] {
  const R = rowsOf(grid), c = columnsOf(R, CLAUDE_IDEAS_HEADER);
  const out: DashIdea[] = [];
  for (const r of R.slice(c.dataFrom)) {
    const ticker = toUpperTicker(r[c.at('Ticker')]), idea = s(r[c.at('Idea')]).toUpperCase();
    if (!ticker || !idea) continue;
    const zoneText = s(r[c.at('Entry zone')]), zone = parseIdeaZone(zoneText);
    const status = s(r[c.at('Status')]), st = ideaStatusOf(status);
    const price = r4(prices.get(ticker) ?? null);
    let zoneState: DashIdea['zoneState'] = null, distancePct: number | null = null;
    if (zone && price != null) {
      zoneState = price > zone[1] ? 'above' : price < zone[0] ? 'below' : 'in';
      distancePct = zoneState === 'above' ? r2((price / zone[1] - 1) * 100) : zoneState === 'below' ? r2((price / zone[0] - 1) * 100) : 0;
    }
    const date = s(r[c.at('Date')]);
    out.push({
      date, day: dayOf(r[c.at('Date')]), ticker, kind: s(r[c.at('Kind')]).toLowerCase() || 'stock', idea, zoneText, zone,
      stop: n(r[c.at('Stop')]), target: n(r[c.at('Target')]), horizon: s(r[c.at('Horizon')]), reason: s(r[c.at('Reason')]).slice(0, 600),
      status, open: st.open, outcome: st.outcome, price, zoneState, distancePct,
    });
  }
  // Newest first: by the Date cell, a later row first on the same date.
  return out.map((x, i) => [x, i] as const).sort((a, b) => b[0].date.localeCompare(a[0].date) || b[1] - a[1]).map(([x]) => x);
}

// ── options, models, decisions, runs ─────────────────────────────────────────────────────────────────────────────

export function parseOptions(reads: Grid | null | undefined, measures: Grid | null | undefined, market: Grid | null | undefined): NonNullable<DashboardData['options']> | null {
  if (!reads && !measures && !market) return null;
  const R = rowsOf(reads), rc = columnsOf(R, OPTIONS_READS_HEADER), rl = latestDayRows(R, rc.dataFrom);
  const rows = rl.rows.map((r) => ({
    ticker: toUpperTicker(r[rc.at('Ticker')]), status: s(r[rc.at('Status')]), pcOi: r4(n(r[rc.at('P/C OI')])), pcVol: r4(n(r[rc.at('P/C volume')])),
    netBiasPct: r2(n(r[rc.at('Net $ bias %')])), dirSig: n(r[rc.at('dirSig')]), ivPct: r2(n(r[rc.at('Chain IV percentile')])),
    frontIv: r4(n(r[rc.at('Front IV')])), backIv: r4(n(r[rc.at('Back IV')])), leapsLean: s(r[rc.at('LEAPS lean')]), term: s(r[rc.at('Term note')]),
  })).filter((x) => x.ticker);
  const M = rowsOf(measures), mc = columnsOf(M, OPTIONS_MEASURES_HEADER), ml = latestDayRows(M, mc.dataFrom);
  const mrows = ml.rows.map((r) => ({
    ticker: toUpperTicker(r[mc.at('Ticker')]), smirk: r4(n(r[mc.at('Smirk (vol pts)')])), ivSpread: r4(n(r[mc.at('IV spread call−put (vol pts)')])), osRatio: r4(n(r[10])),
    pcOi: r4(n(r[mc.at('P/C OI')])), nights: n(r[mc.at('Nights of history')]), convictionPts: n(r[mc.at('Conviction pts (capped)')]),
  })).filter((x) => x.ticker);
  const K = rowsOf(market), kc = columnsOf(K, MARKET_OPTIONS_HEADER), kl = latestDayRows(K, kc.dataFrom);
  const krows = kl.rows.map((r) => ({
    etf: toUpperTicker(r[kc.at('ETF')]), spot: r4(n(r[kc.at('Spot')])), pcOi: r4(n(r[kc.at('P/C OI')])), skew: r4(n(r[kc.at('Skew (vol pts)')])),
    iv30: r4(n(r[kc.at('ATM IV ~30d')])), rv20: r4(n(r[kc.at('RV20')])), vix: r4(n(r[kc.at('VIX')])), read: s(r[kc.at('Read')]),
  })).filter((x) => x.etf);
  return { day: rl.day ?? ml.day ?? kl.day, rows, measures: { day: ml.day, need: MEASURE_NIGHTS_NEEDED, rows: mrows }, market: krows };
}

/** The model columns of 🔎 Paper Reads, in the tab's order. */
export const MODEL_COLUMNS: readonly string[] = ['Engine', 'Broker Course', 'Schabacker', 'Edwards & Magee', 'Turtle', 'Wyckoff (original)', 'Trend 150', 'Trend 200'];
/** A model's read as bull / neutral / bear (display only). */
export function leanOf(read: string): 'bull' | 'neutral' | 'bear' {
  if (/bear|caution|sell|exit|down|short|distribution|markdown/i.test(read)) return 'bear';
  if (/bull|buy|long|\bup|accumulation|markup/i.test(read)) return 'bull';
  return 'neutral';
}

export function parseModels(reads: Grid | null | undefined): NonNullable<DashboardData['models']> | null {
  const R = rowsOf(reads), c = columnsOf(R, READS_HEADER), l = latestDayRows(R, c.dataFrom);
  if (!l.day) return null;
  const stocks = l.rows.map((r) => ({
    ticker: toUpperTicker(r[c.at('Stock')]), close: r4(n(r[c.at('Close')])), conviction: n(r[c.at('Conviction')]), timing: s(r[c.at('Timing')]), verdict: s(r[c.at('Models verdict')]),
    stop: r4(n(r[c.at('Stop')])), zone: s(r[c.at('LILO buy zone')]), t1: r4(n(r[c.at('T1')])), t2: r4(n(r[c.at('T2')])),
    reads: Object.fromEntries(MODEL_COLUMNS.map((m) => [m, s(r[c.at(m)])])),
  })).filter((x) => x.ticker);
  const rows = MODEL_COLUMNS.map((m) => {
    const t = { model: m, bull: 0, neutral: 0, bear: 0 };
    for (const st of stocks) { const v = st.reads[m]; if (v && v !== '—') t[leanOf(v)]++; }
    return t;
  });
  return { day: l.day, names: MODEL_COLUMNS, rows, stocks };
}

export function parseDecisions(grid: Grid | null | undefined): NonNullable<DashboardData['decisions']> | null {
  if (!grid) return null;
  const header = [...DECISION_HISTORY_HEADERS, ...DECISION_HISTORY_OPTIONS_HEADERS];
  const R = rowsOf(grid), c = columnsOf(R, header);
  const by = new Map<string, NonNullable<DashboardData['decisions']>['latest'][number]>();
  for (const r of R.slice(c.dataFrom)) {
    const t = toUpperTicker(r[c.at('Ticker')]);
    if (!t) continue;
    by.set(t, { date: dayOf(r[c.at('Date')]), ticker: t, own: r2(n(r[c.at('OWN')])), timing: r2(n(r[c.at('TIMING Score')])), conviction: r2(n(r[c.at('Final Conviction')])), action: s(r[c.at('Action')]), options: s(r[c.at('Options (CONFIRM/CONFLICT/neutral/none)')]) });
  }
  return { latest: [...by.values()].sort((a, b) => a.ticker.localeCompare(b.ticker)) };
}

export function parseRuns(grid: Grid | null | undefined): DashRun[] {
  const R = rowsOf(grid), c = columnsOf(R, RUN_HEALTH_HEADER);
  const out: DashRun[] = [];
  for (const r of R.slice(c.dataFrom)) {
    const date = s(r[c.at('Date')]), job = s(r[c.at('Job')]);
    if (!job || !date) continue;
    const result = s(r[c.at('Result')]);
    out.push({
      date: dayOf(r[c.at('Date')]) ?? date, job, expected: s(r[c.at('Expected')]), ran: s(r[c.at('Ran')]), result,
      status: result.includes('❌') ? 'fail' : result.includes('⚠') ? 'warn' : 'ok', minutes: n(r[c.at('Minutes')]), warnings: n(r[c.at('Warnings')]), errors: n(r[c.at('Errors')]),
      problem: s(r[c.at('Top problem')]).slice(0, 300), link: /^https:\/\/github\.com\//.test(s(r[c.at('Run link')])) ? s(r[c.at('Run link')]) : '',
    });
  }
  return out.reverse().slice(0, MAX_RUN_ROWS);
}

/** This month's minutes summed from 🩺 Run Health (each watchdog row covers the last day's runs of one job). */
export function runHealthMinutes(runs: readonly DashRun[], nowMs: number): number {
  const month = new Date(nowMs).toISOString().slice(0, 7);
  return runs.filter((x) => x.date.startsWith(month)).reduce((a, x) => a + (x.minutes ?? 0), 0);
}

// ── the builder ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The whole JSON from the tabs. Never throws: a section that fails is logged and left out (named in `missing`). */
export function buildDashboard(src: DashboardSources, ctx: DashboardContext): DashboardData {
  const log = ctx.logger ?? null;
  const missing: string[] = [];
  const section = <T>(name: string, have: boolean, fn: () => T | null | undefined): T | undefined => {
    if (!have) { missing.push(name); return undefined; }
    const v = orElse(log, 'dashboard section ' + name, fn, null);
    if (v == null) { missing.push(name); return undefined; }
    return v;
  };
  const prices = orElse(log, 'dashboard live prices', () => livePrices(src.paperReads), new Map<string, number>());
  const exitItems = orElse(log, 'dashboard exit rows', () => parseExitReport(src.exitReport), []);
  const targets = orElse(log, 'dashboard exit targets', () => latestTargets(src.exitTargets), new Map());

  const portfolio = section('portfolio', !!src.portfolio, () => {
    const holdings = parseHoldings(src.portfolio, ctx, prices, exitItems, targets);
    if (!holdings.length) return null;
    const sum = (k: 'value' | 'cost' | 'gain'): number => r2(holdings.reduce((a, h) => a + (h[k] ?? 0), 0)) as number;
    const gain = sum('gain'), tax = r2(holdings.reduce((a, h) => a + (h.tax ?? 0), 0)) as number;
    return { holdings, groups: groupTotals(holdings), total: { value: sum('value'), cost: sum('cost'), gain, tax, afterTax: r2(gain - tax) as number } };
  });
  const exit = section('exit', !!src.exitReport, () => {
    if (!exitItems.length) return null;
    const counts: Record<string, number> = {};
    for (const e of exitItems) counts[e.action] = (counts[e.action] ?? 0) + 1;
    const days = [...targets.values()].map((t) => t.day).filter((d): d is string => !!d).sort();
    // Fix 2026-11-06 (live QA): "as of" is the report's own run day, not the target-history day (a day older).
    const run = reportRunTime(src.exitReport, EXIT_TEXT.runLabel);
    const targetsDay = days[days.length - 1] ?? null;
    return { asOf: run?.day ?? targetsDay, runTime: run?.text ?? null, targetsDay, items: exitItems, counts };
  });
  const buy = section('buy', !!src.buyReport, () => { const items = parseBuyReport(src.buyReport, prices); return items.length ? { runTime: reportRunTime(src.buyReport, BUY_TEXT.runLabel)?.text ?? null, items } : null; });
  const history = section('history', !!(src.portfolio || src.transactions), () => {
    const items = [...parseClosed(src.portfolio, ctx.taxRate), ...parseTransactions(src.transactions, ctx.taxRate)].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    return { items, years: historyYears(items, ctx.taxRate) };
  });
  const paper = section('paper', !!src.paperValues, () => buildPaper(parseValues(src.paperValues ?? []), parseLog(src.paperLog ?? []), ctx.paper ?? null));
  const ideas = section('ideas', !!src.claudeIdeas, () => ({ items: parseIdeas(src.claudeIdeas, prices) }));
  const options = section('options', !!(src.optionsReads || src.optionsMeasures || src.marketOptions), () => parseOptions(src.optionsReads, src.optionsMeasures, src.marketOptions));
  const models = section('models', !!src.paperReads, () => parseModels(src.paperReads));
  const decisions = section('decisions', !!src.decisions, () => parseDecisions(src.decisions));
  const runItems = section('runs', !!src.runHealth, () => { const items = parseRuns(src.runHealth); return items.length ? items : null; });
  const minutes = ctx.minutes ? { used: ctx.minutes.used, cap: ctx.minutes.cap, source: 'github' as const }
    : runItems ? { used: runHealthMinutes(runItems, ctx.nowMs), cap: FREE_MINUTES, source: 'run-health' as const } : undefined;
  const networth = section('networth', !!(src.ledger && (src.ledger.holdings || src.ledger.assets)), () =>
    buildNetWorth({ ledger: src.ledger as LedgerSources, live: portfolio?.holdings ?? [], nowMs: ctx.nowMs, fx: ctx.fxUsdIls ?? null, prices }));
  const growth = section('growth', !!(src.ledger && (src.ledger.snapshots || src.ledger.flows)), () => buildGrowth(src.ledger as LedgerSources));
  const market = options?.market.length
    ? [...options.market.map((m) => ({ name: m.etf, value: m.spot })), ...(options.market[0]?.vix != null ? [{ name: 'VIX', value: options.market[0].vix }] : []), ...options.market.filter((m) => m.pcOi != null).slice(0, 1).map((m) => ({ name: m.etf + ' P/C', value: m.pcOi }))]
    : undefined;

  return {
    schema: DASHBOARD_SCHEMA, asOf: new Date(ctx.nowMs).toISOString(), asOfText: asOfText(ctx.nowMs), version: ctx.version ?? null,
    user: { labels: { list: ctx.labels.list, holdCore: ctx.labels.holdCore, holdList: ctx.labels.holdList, qqq: QQQ_ROW }, taxRate: ctx.taxRate, list: [...ctx.list], timeZone: ctx.timeZone },
    ...(portfolio ? { portfolio } : {}), ...(exit ? { exit } : {}), ...(buy ? { buy } : {}), ...(history ? { history } : {}), ...(paper ? { paper } : {}), ...(ideas ? { ideas } : {}),
    ...(options ? { options } : {}), ...(models ? { models } : {}), ...(decisions ? { decisions } : {}), ...(runItems ? { runs: { items: runItems } } : {}),
    ...(minutes ? { minutes } : {}), ...(market ? { market } : {}), ...(networth ? { networth } : {}), ...(growth ? { growth } : {}), missing,
  };
}

// ── thin I/O ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Each tab the builder reads: [source key, tab name, columns, date columns]. */
export const DASHBOARD_TABS: ReadonlyArray<readonly [keyof DashboardSources, string, number, readonly number[]]> = [
  ['portfolio', Tabs.PORTFOLIO, 26, []],
  ['transactions', TRANSACTIONS_SHEET, TRANSACTIONS_HEADERS.length, [0]],
  ['exitReport', EXIT_SHEET_TAB, 12, []],
  ['exitTargets', EXIT_TARGET_HISTORY_SHEET, EXIT_TARGET_HISTORY_HEADERS.length, []],
  ['buyReport', BUY_SHEET_TAB, 12, []],
  ['decisions', Tabs.DECISION_HISTORY, DECISION_HISTORY_HEADERS.length + DECISION_HISTORY_OPTIONS_HEADERS.length, [0]],
  ['paperValues', VALUES_TAB, VALUES_HEADER.length, []],
  ['paperLog', LOG_TAB, LOG_HEADER.length - 1, []],
  ['paperReads', READS_TAB, READS_HEADER.length, []],
  ['optionsReads', OPTIONS_READS_TAB, OPTIONS_READS_HEADER.length, []],
  ['optionsMeasures', OPTIONS_MEASURES_TAB, OPTIONS_MEASURES_HEADER.length, []],
  ['marketOptions', MARKET_OPTIONS_TAB, MARKET_OPTIONS_HEADER.length, []],
  ['runHealth', RUN_HEALTH_TAB, RUN_HEALTH_HEADER.length, []],
  ['claudeIdeas', CLAUDE_IDEAS_TAB, CLAUDE_IDEAS_HEADER.length, []],
];

/** Reads every tab; a tab that is missing or fails is null (one log line), so the build goes on. */
export async function readDashboardSources(store: TabStore, log: (m: string) => void): Promise<DashboardSources> {
  const out: Record<string, Grid | null> = {};
  for (const [key, tab, cols, dates] of DASHBOARD_TABS) {
    out[key] = await store.read(tab, cols, dates).catch((e: unknown) => { log('dashboard: the tab ' + tab + ' could not be read (' + String(e instanceof Error ? e.message : e).slice(0, 160) + ')'); return null; });
  }
  return out as DashboardSources;
}
