/**
 * 💵 Live Log (reports sheet; append-only like 📒 Paper Log, one block of rows per trading day, never rewritten;
 * paper/paperLog.ts appendNight: a day already written is not written again).
 *
 * Order rows: Day · When (planned / approved / sent / filled / cancelled / skipped / refused) · Ticker · Side · Qty · Limit ·
 * Fill price · Fee · Why (the paper twin's reason) · Rail checks · Order ref · Account followed.
 * One daily values row (When = 'daily values'), all after tax at the profile's rate (EXIT_TAX_RATE) as in the paper test, in the columns after them:
 * Live value · Tax owed this year · Money added for tax · Live value after tax · Paper twin after tax · 📊 Hold QQQ ·
 * 📊 Hold the research list (profile labels) · the deepest fall of each (live, twin, QQQ, the research list).
 * The twin and the two yardsticks are the paper test's values after tax, scaled to the live start money from the
 * live start day (the same basis: the tax rate on each holding's gain, sales taxed when made).
 */

import type { TabCell, TabStore } from '../storage/tabStore.ts';
import type { PaperState } from '../paper/paperTrading.ts';
import { PAPER_CASH } from '../paper/paperTrading.ts';
import { PLANNED_DRY, type Accounting } from './account.ts';
import type { Plan } from './planner.ts';
import type { RailResult } from './rails.ts';
import { LABELS } from '../profile/labels.ts';

export const LIVE_LOG_TAB = '💵 Live Log';
export const LIVE_LOG_HEADER: readonly string[] = [
  'Day', 'When', 'Ticker', 'Side', 'Qty', 'Limit', 'Fill price', 'Fee', 'Why', 'Rail checks', 'Order ref', 'Account followed',
  'Live value', 'Tax owed this year', 'Money added for tax', 'Live value after tax', 'Paper twin after tax', '📊 Hold QQQ after tax', '📊 ' + LABELS.holdList + ' after tax',
  'Deepest fall: live', 'Deepest fall: twin', 'Deepest fall: Hold QQQ', 'Deepest fall: ' + LABELS.holdList,
];
export const LIVE_LOG_COLS = LIVE_LOG_HEADER.length;
export const DAILY_VALUES = 'daily values';
const COL_LIVE_AFTER_TAX = 15;

export interface Comparison {
  /** Each after tax, scaled to the live start money from the live start day; null when the paper test has no value. */
  readonly twin: number | null;
  readonly qqq: number | null;
  readonly list14: number | null;
  /** Deepest falls from a high since the live start, %. */
  readonly twinFall: number;
  readonly qqqFall: number;
  readonly list14Fall: number;
}

const fallOf = (vals: readonly number[]): number => { let peak = 0, dd = 0; for (const v of vals) { peak = Math.max(peak, v); dd = Math.max(dd, peak > 0 ? (1 - v / peak) * 100 : 0); } return dd; };

/**
 * The twin and the yardsticks on the live account's basis: each paper value after tax divided by its value on the
 * live start day (the last mark on or before it; the test's starting money when the live start is earlier) and
 * multiplied by the live start money.
 */
export function compareWithPaper(state: PaperState, account: string, start: { day: string; value: number }): Comparison {
  const marks = state.marks;
  let i0 = -1;
  for (let i = 0; i < marks.length; i++) if (marks[i]!.day <= start.day) i0 = i;
  const one = (key: string): { now: number | null; fall: number } => {
    const base = i0 >= 0 ? marks[i0]!.values[key] : PAPER_CASH;
    const series = marks.slice(Math.max(0, i0)).map((m) => m.values[key]).filter((v): v is number => v != null);
    const now = series.length ? series[series.length - 1]! : null;
    if (base == null || !(base > 0) || now == null) return { now: null, fall: 0 };
    return { now: (now / base) * start.value, fall: fallOf(i0 >= 0 ? series : [base, ...series]) };
  };
  const t = one(account), q = one('qqq'), l = one('lab.list14');
  return { twin: t.now, qqq: q.now, list14: l.now, twinFall: t.fall, qqqFall: q.fall, list14Fall: l.fall };
}

/** The live account's deepest fall (after tax), from the log's earlier daily values and tonight's. */
export function liveFall(logRows: readonly (readonly TabCell[])[], tonight: number, startValue: number): number {
  const past = logRows.filter((r) => String(r[1]) === DAILY_VALUES).map((r) => Number(r[COL_LIVE_AFTER_TAX])).filter((v) => Number.isFinite(v) && v > 0);
  return fallOf([startValue, ...past, tonight]);
}

const r2 = (v: number): number => Math.round(v * 100) / 100;
const qtyCell = (q: number): number => Math.round(q * 10_000) / 10_000;
const blanks = (n: number): TabCell[] => Array.from({ length: n }, () => '');

/** Tonight's rows: every planned order, every refused or skipped trade, and the daily values row. */
export function liveLogRows(day: string, plan: Plan | null, rails: RailResult | null, acc: Accounting, cmp: Comparison, liveFallPct: number, account: string, note?: string): TabCell[][] {
  const rows: TabCell[][] = [];
  const tail = blanks(LIVE_LOG_COLS - 12);
  if (plan && rails) {
    const refused = new Map(rails.orderRefusals.map((x) => [x.ref, x.why]));
    for (const o of plan.orders) {
      const planRefused = rails.planRefusals.length > 0, why = refused.get(o.ref);
      rows.push([day, why || planRefused ? 'refused (dry run)' : PLANNED_DRY, o.ticker, o.side, qtyCell(o.qty), r2(o.price), '', o.fee, o.why, why ? 'REFUSED: ' + why : rails.checks, o.ref, account, ...tail]);
    }
    for (const s of plan.skipped) rows.push([day, 'skipped (dry run)', s.ticker, s.side, '', '', '', '', s.why + ' ($' + s.value.toFixed(2) + ')', '', '', account, ...tail]);
    if (!plan.orders.length && rails.planRefusals.length) rows.push([day, 'refused (dry run)', '', '', '', '', '', '', '', rails.checks, '', account, ...tail]);
  }
  rows.push([day, DAILY_VALUES, '', '', '', '', '', '', note ?? (plan ? 'drift after the plan ' + plan.driftPct.toFixed(1) + '% of the account' : ''), '', '', account,
    r2(acc.value), r2(acc.taxOwed), r2(acc.moneyAddedForTax), r2(acc.valueAfterTax), cmp.twin == null ? '' : r2(cmp.twin), cmp.qqq == null ? '' : r2(cmp.qqq), cmp.list14 == null ? '' : r2(cmp.list14),
    -r2(liveFallPct) || 0, -r2(cmp.twinFall) || 0, -r2(cmp.qqqFall) || 0, -r2(cmp.list14Fall) || 0]);
  return rows;
}

/**
 * Phase 3: the rows of what really happened to a plan, under the plan's decision day (so the next night's
 * appendNight still finds its own day free): 'approved' (the owner's ✅), 'sent' (an order the broker received),
 * 'filled' (each execution, partial ones too), 'cancelled' (left unfilled at the window's end, or by the kill switch),
 * 'skipped' (not sent, with why), 'credit accepted' (a small dividend or interest credit taken into the bot's record
 * without the owner, reconcile.ts AUTO_ACCEPT_CREDIT_USD). Written by `appendLiveRows`, which never writes the same row twice (a retry or a
 * restart of the executor re-derives its rows from the broker and adds only the new ones).
 */
export type LiveWhen = 'approved' | 'sent' | 'filled' | 'cancelled' | 'skipped' | 'credit accepted';
export const LIVE_WHENS: readonly LiveWhen[] = ['approved', 'sent', 'filled', 'cancelled', 'skipped', 'credit accepted'];

export interface LiveEvent {
  /** The plan's decision day. */
  readonly day: string;
  readonly when: LiveWhen;
  readonly ticker?: string;
  readonly side?: 'BUY' | 'SELL' | '';
  readonly qty?: number | null;
  readonly limit?: number | null;
  readonly fill?: number | null;
  readonly fee?: number | null;
  /** Plain words; also part of the row's identity, so keep it free of clock times. */
  readonly why: string;
  readonly checks?: string;
  readonly ref?: string;
  /** The paper account followed. */
  readonly account: string;
}

const cell = (v: number | null | undefined, f: (x: number) => number): TabCell => (v == null || !Number.isFinite(v) ? '' : f(v));

export function liveEventRow(e: LiveEvent): TabCell[] {
  return [e.day, e.when, e.ticker ?? '', e.side ?? '', cell(e.qty, qtyCell), cell(e.limit, (x) => Math.round(x * 10_000) / 10_000), cell(e.fill, (x) => Math.round(x * 10_000) / 10_000), cell(e.fee, r2), e.why, e.checks ?? '', e.ref ?? '', e.account, ...blanks(LIVE_LOG_COLS - 12)];
}

const rowKey = (r: readonly TabCell[]): string => [r[0], r[1], r[2], r[3], r[8], r[10]].map((x) => String(x ?? '')).join('\u0001');

/** Appends the rows not already in 💵 Live Log (same day, when, ticker, side, why and order ref). Returns how many. */
export async function appendLiveRows(store: TabStore, rows: readonly TabCell[][]): Promise<number> {
  if (!rows.length) return 0;
  await store.ensure(LIVE_LOG_TAB);
  const have = (await store.read(LIVE_LOG_TAB, LIVE_LOG_COLS)) ?? [];
  if (!have.length) { await store.write(LIVE_LOG_TAB, 1, [[...LIVE_LOG_HEADER]]); have.push([...LIVE_LOG_HEADER]); }
  const seen = new Set(have.map(rowKey));
  const add: TabCell[][] = [];
  for (const r of rows) { const k = rowKey(r); if (!seen.has(k)) { seen.add(k); add.push(r); } }
  if (add.length) await store.write(LIVE_LOG_TAB, have.length + 1, add);
  return add.length;
}
