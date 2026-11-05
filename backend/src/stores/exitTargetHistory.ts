/**
 * F-X2 / FL-9i design B: "Exit Target History", a small append-only tab that remembers, per holding, the exit
 * targets and the sell plan shown on a given day, so a later run can say whether a remembered target was reached and
 * continue a staged plan after a partial sale. One row is appended only when the anchor changes:
 *   NEW            first time this holding is seen
 *   SPLIT          the chart shows a split after the anchor day (new plan)
 *   QUANTITY_UP    more shares or contracts than the anchor (new plan for the whole new position)
 *   QUANTITY_DOWN  fewer than the anchor: a partial sale; the plan CONTINUES (stage 2 / 3), targets re-saved
 *   COST_CHANGED   same quantity, average cost moved more than 0.5% (the rows were edited: new plan)
 *   TARGET_REACHED the current price reached a remembered target (plan continues, targets re-saved)
 *   AGED_90_DAYS   the anchor is 90 days old or more (plan continues, targets re-saved)
 * Rows are never edited or deleted. The tab name has no '💾 ' prefix, so the price-cache cleanup never sees it.
 * Report text from here is one short plain line per holding.
 */

import type { ReportSheet, ReportWorkbook } from '../sheets/reportSheet.ts';
import { formatDateInTz } from '../core/dates.ts';
import { sheetsSerialToDate } from '../storage/priceHistory.ts';
import type { PlanAmounts, SellRule, StageMemory } from '../portfolio/sellPlan.ts';

export const EXIT_TARGET_HISTORY_SHEET = 'Exit Target History';
export const EXIT_TARGET_HISTORY_HEADERS: readonly string[] = [
  'Date', 'Holding', 'Ticker', 'Quantity', 'Average cost', 'Price', 'T1', 'T2', 'Entry date',
  'Plan', 'Plan started', 'Plan quantity', 'Planned at T1', 'Planned at T2', 'Why',
];
export const REANCHOR_AFTER_DAYS = 90;
const HISTORY_ZONE = 'America/New_York';
const EPS = 1e-9;

export type AnchorWhy = 'NEW' | 'SPLIT' | 'QUANTITY_UP' | 'QUANTITY_DOWN' | 'COST_CHANGED' | 'TARGET_REACHED' | 'AGED_90_DAYS';
const WHY: readonly AnchorWhy[] = ['NEW', 'SPLIT', 'QUANTITY_UP', 'QUANTITY_DOWN', 'COST_CHANGED', 'TARGET_REACHED', 'AGED_90_DAYS'];
const RULES: readonly SellRule[] = ['THIRDS_RUNNER', 'HALVES_FULL_EXIT'];

export interface TargetAnchor {
  /** 'YYYY-MM-DD' (New York day). */
  readonly date: string;
  readonly key: string;
  readonly ticker: string;
  readonly quantity: number;
  readonly avgCost: number | null;
  readonly price: number | null;
  readonly t1: number | null;
  readonly t2: number | null;
  readonly entryDate: string | null;
  readonly plan: SellRule;
  readonly planStarted: string;
  readonly planQuantity: number;
  readonly plannedAtT1: number;
  readonly plannedAtT2: number;
  readonly why: AnchorWhy;
}

/** One holding: the ticker for a stock, ticker + strike + expiry for an option (two contracts on one ticker stay apart). */
export function holdingKey(kind: 'STOCK' | 'OPTION', ticker: string, strike?: number | null, expiry?: string | null): string {
  return kind === 'OPTION' ? ticker + ' CALL ' + (strike ?? '?') + ' ' + (expiry ?? '?') : ticker;
}

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** A Date, a Sheets serial number, or a 'YYYY-MM-DD...' string -> 'YYYY-MM-DD' (New York day). Anything else: null. */
export function dayOf(v: unknown, timeZone: string = HISTORY_ZONE): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : formatDateInTz(v, timeZone, 'yyyy-MM-dd');
  if (typeof v === 'number' && Number.isFinite(v)) return formatDateInTz(sheetsSerialToDate(v, timeZone), timeZone, 'yyyy-MM-dd');
  if (typeof v === 'string') { const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim()); return m ? (m[1] as string) : null; }
  return null;
}

export function daysBetween(fromDay: string, toDay: string): number {
  const a = Date.parse(fromDay + 'T00:00:00Z'), b = Date.parse(toDay + 'T00:00:00Z');
  return Math.round((b - a) / 86_400_000);
}

function rowToAnchor(r: readonly unknown[], timeZone: string): TargetAnchor | null {
  const date = dayOf(r[0], timeZone);
  const key = typeof r[1] === 'string' ? r[1] : null;
  const quantity = numOrNull(r[3]);
  const plan = RULES.find((x) => x === r[9]);
  const why = WHY.find((x) => x === r[14]) ?? 'NEW';
  const planQuantity = numOrNull(r[11]), atT1 = numOrNull(r[12]), atT2 = numOrNull(r[13]);
  if (!date || !key || quantity == null || !plan || planQuantity == null || atT1 == null || atT2 == null) return null;
  return {
    date, key, ticker: String(r[2] ?? ''), quantity, avgCost: numOrNull(r[4]), price: numOrNull(r[5]), t1: numOrNull(r[6]), t2: numOrNull(r[7]),
    entryDate: dayOf(r[8], timeZone), plan, planStarted: dayOf(r[10], timeZone) ?? date, planQuantity, plannedAtT1: atT1, plannedAtT2: atT2, why,
  };
}

/** The latest anchor per holding. No tab = an empty map (first run). Unreadable rows are skipped. */
export function readLatestAnchors(ss: ReportWorkbook, timeZone: string = HISTORY_ZONE): Map<string, TargetAnchor> {
  const out = new Map<string, TargetAnchor>();
  const sh = ss.getSheetByName(EXIT_TARGET_HISTORY_SHEET);
  if (!sh) return out;
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const a = rowToAnchor(data[i] as unknown[], timeZone);
    if (a) out.set(a.key, a);
  }
  return out;
}

function historySheet(ss: ReportWorkbook): ReportSheet {
  let sh = ss.getSheetByName(EXIT_TARGET_HISTORY_SHEET);
  if (!sh) sh = ss.insertSheet(EXIT_TARGET_HISTORY_SHEET);
  const row1 = sh.getRange(1, 1, 1, EXIT_TARGET_HISTORY_HEADERS.length).getValues()[0] ?? [];
  if (row1[0] !== EXIT_TARGET_HISTORY_HEADERS[0]) {
    sh.getRange(1, 1, 1, EXIT_TARGET_HISTORY_HEADERS.length).setValues([[...EXIT_TARGET_HISTORY_HEADERS]]).setFontWeight('bold').setBackground('#37474f').setFontColor('#fff');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Append-only: new rows after the last row, never an edit of a past row. */
export function appendAnchors(ss: ReportWorkbook, rows: readonly TargetAnchor[]): void {
  if (!rows.length) return;
  const sh = historySheet(ss);
  for (const a of rows) {
    sh.appendRow([a.date, a.key, a.ticker, a.quantity, a.avgCost ?? '', a.price ?? '', a.t1 ?? '', a.t2 ?? '', a.entryDate ?? '',
      a.plan, a.planStarted, a.planQuantity, a.plannedAtT1, a.plannedAtT2, a.why]);
  }
}

export interface CurrentForAnchor {
  readonly key: string;
  readonly ticker: string;
  readonly kind: 'STOCK' | 'OPTION';
  readonly quantity: number;
  readonly avgCost: number | null;
  readonly price: number | null;
  readonly t1: number | null;
  readonly t2: number | null;
  readonly entryDate: string | null;
  /** The fresh split for today's quantity (portfolio/sellPlan.ts planAmounts). */
  readonly amounts: PlanAmounts;
  /** 'YYYY-MM-DD' of every split in the chart. */
  readonly splitDays: readonly string[];
}

export interface AnchorDecision {
  /** The row to append, or null when the remembered anchor still holds. */
  readonly append: TargetAnchor | null;
  readonly why: AnchorWhy | null;
  /** The plan to continue (or the fresh one). */
  readonly stage: StageMemory;
  /** One short plain line for the report. */
  readonly line: string;
}

/** 'Oct 1, 2026' for a 'YYYY-MM-DD' day. */
export function shortDay(day: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(day + 'T00:00:00Z'));
}

/** $1,234.56: the same money format as the Exit report (audit #49). */
const usd = (n: number): string => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyText = (n: number): string => String(Math.round(n * 10000) / 10000);
const targetsText = (t1: number | null, t2: number | null): string =>
  [t1 != null ? 'T1 ' + usd(t1) : null, t2 != null ? 'T2 ' + usd(t2) : null].filter(Boolean).join(', ') || 'no targets';

export function decideAnchor(prev: TargetAnchor | null, cur: CurrentForAnchor, today: string): AnchorDecision {
  const freshStage: StageMemory = { originalQuantity: cur.amounts.quantity, plannedAtT1: cur.amounts.atT1, plannedAtT2: cur.amounts.atT2, since: today, rule: cur.amounts.rule };
  const row = (why: AnchorWhy, st: StageMemory): TargetAnchor => ({
    date: today, key: cur.key, ticker: cur.ticker, quantity: cur.quantity, avgCost: cur.avgCost, price: cur.price, t1: cur.t1, t2: cur.t2, entryDate: cur.entryDate,
    plan: st.rule, planStarted: st.since, planQuantity: st.originalQuantity, plannedAtT1: st.plannedAtT1, plannedAtT2: st.plannedAtT2, why,
  });
  const decide = (why: AnchorWhy, st: StageMemory, line: string): AnchorDecision => ({ append: row(why, st), why, stage: st, line });

  if (!prev) return decide('NEW', freshStage, 'Exit targets saved today for later runs: ' + targetsText(cur.t1, cur.t2) + '.');
  const since = shortDay(prev.date);
  const carried: StageMemory = prev.plan === cur.amounts.rule
    ? { originalQuantity: prev.planQuantity, plannedAtT1: prev.plannedAtT1, plannedAtT2: prev.plannedAtT2, since: prev.planStarted, rule: prev.plan }
    : freshStage;

  if (cur.splitDays.some((d) => d > prev.date && d <= today)) return decide('SPLIT', freshStage, 'A stock split happened after ' + since + ', so this is a new plan and the targets were saved again today.');
  if (cur.quantity > prev.quantity + EPS) return decide('QUANTITY_UP', freshStage, 'You added to this position after ' + since + ' (' + qtyText(prev.quantity) + ' to ' + qtyText(cur.quantity) + '), so this is a new plan for the whole position.');
  if (cur.quantity < prev.quantity - EPS) return decide('QUANTITY_DOWN', carried, 'Since ' + since + ' the position went from ' + qtyText(prev.quantity) + ' to ' + qtyText(cur.quantity) + '; the plan continues and the targets were saved again today.');
  if (prev.avgCost != null && prev.avgCost > 0 && cur.avgCost != null && Math.abs(cur.avgCost - prev.avgCost) / prev.avgCost > 0.005) {
    return decide('COST_CHANGED', freshStage, 'The average cost changed after ' + since + ', so this is a new plan and the targets were saved again today.');
  }
  if (cur.price != null && ((prev.t2 != null && cur.price >= prev.t2) || (prev.t1 != null && cur.price >= prev.t1))) {
    const second = prev.t2 != null && cur.price >= prev.t2;
    return decide('TARGET_REACHED', carried, 'The ' + (second ? 'second' : 'first') + ' target saved on ' + since + ' (' + usd((second ? prev.t2 : prev.t1) as number) + ') has been reached; the targets were saved again today.');
  }
  if (daysBetween(prev.date, today) >= REANCHOR_AFTER_DAYS) return decide('AGED_90_DAYS', carried, 'The targets saved on ' + since + ' were ' + REANCHOR_AFTER_DAYS + ' or more days old, so they were saved again today.');
  return { append: null, why: null, stage: carried, line: 'Targets saved on ' + since + ': ' + targetsText(prev.t1, prev.t2) + ', not reached yet.' };
}
