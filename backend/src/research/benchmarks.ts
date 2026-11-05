/**
 * The two yardsticks every simulation table carries (owner 2026-10-28: "I always want to compare just holding the
 * 14 stocks and holding QQQ"): holding QQQ, and holding the owner's list equally, bought at the period's first open
 * and held, after the 25% tax on the gain at the end, with the deepest fall from a high on the way (before tax).
 *
 * G5 (docs/models/MASTER_PLAN.md T4, T6): both pay the shared `costBps` once, at the entry; and the list has a
 * "join when listed" variant next to it (the plain one leaves out a stock not trading on the period's first day).
 */

import type { PriceSeries } from '../backtest/data.ts';
import { PERIODS } from './lab.ts';
import { holdBag, type PortfolioInput } from './portfolioLab.ts';
import { EXIT_TAX_RATE } from '../portfolio/exitTax.ts';

export interface Bench {
  readonly finalTaxed: number; readonly maxDrawdownPct: number;
  /** G5: the share left in cash at each day's close (the money the equal split could not place). */
  readonly cashShareByDay?: ReadonlyMap<string, number>;
}

export interface HoldOptions {
  /** G5: the trading cost in basis points, paid once at the entry (part of the cost basis). Default 0. */
  readonly costBps?: number;
  /**
   * G5(e), "join when listed": a ticker that first trades inside the period (PLTR in 2020-2023, ALAB in 2024-2026)
   * is in the split too; its equal share of the starting money waits in cash and buys at the open of its first
   * trading day. Off (default): only the tickers trading on the period's first day share the money.
   */
  readonly join?: boolean;
}

/** Equal money in each ticker (those trading on the first day, or with `join` every one listed by the end), bought at its first open and held. */
export function holdCurve(series: readonly PriceSeries[], days: readonly string[], cash: number, o: HoldOptions = {}): Bench {
  const first = days[0] as string, lastDay = days[days.length - 1] as string;
  const live = series.filter((s) => (s.dates[0] as string) <= (o.join ? lastDay : first) && (!o.join || s.dates.some((d) => d >= first && d <= lastDay)));
  const c = (o.costBps ?? 0) / 10_000;
  const lots = live.map((s) => {
    const idx = new Map(s.dates.map((d, i) => [d, i]));
    const i0 = idx.get(first) ?? s.dates.findIndex((d) => d >= first);
    const pc = (s.opens[i0] as number) * (1 + c);
    const n = Math.floor(cash / live.length / pc);
    return { s, idx, n, cost: n * pc, last: s.opens[i0] as number, entry: o.join ? (s.dates[i0] as string) : first };
  });
  // join: the money of a ticker not listed yet waits in cash until its first trading day
  const bought = new Set(o.join ? [] : lots);
  let left = cash - [...bought].reduce((a, l) => a + l.cost, 0);
  let peak = 0, dd = 0, v = cash;
  const cashShareByDay = new Map<string, number>();
  for (const d of days) {
    for (const l of lots) if (!bought.has(l) && l.entry <= d) { bought.add(l); left -= l.cost; }
    v = left;
    for (const l of bought) { const k = l.idx.get(d); if (k != null) l.last = l.s.closes[k] as number; v += l.n * l.last; }
    peak = Math.max(peak, v); dd = Math.max(dd, (1 - v / peak) * 100);
    cashShareByDay.set(d, live.length && v > 0 ? left / v : 1);
  }
  const taxed = left + [...bought].reduce((a, l) => { const val = l.n * l.last; return a + val - Math.max(0, val - l.cost) * EXIT_TAX_RATE; }, 0);
  return { finalTaxed: live.length ? taxed : cash, maxDrawdownPct: dd, cashShareByDay };
}

/** The yardsticks of one results table: per PERIODS period, QQQ, the list, and the list joining when listed (T6). */
export interface Benchmarks { readonly qqq: Bench[]; readonly list: Bench[]; readonly listJoin?: Bench[] }

export function benchmarksFor(bag: readonly string[], inp: PortfolioInput, cash: number, o: { readonly costBps?: number } = {}): Benchmarks & { listJoin: Bench[] } {
  const per = PERIODS.map((p) => inp.qqq.dates.filter((d) => d >= p.start && d <= p.end));
  const bagSeries = bag.map((t) => inp.series.get(t)).filter((s): s is PriceSeries => !!s);
  return {
    qqq: per.map((days) => holdCurve([inp.qqq], days, cash, { costBps: o.costBps })),
    list: per.map((days, k) => ({ ...holdCurve(bagSeries, days, cash, { costBps: o.costBps }), finalTaxed: holdBag(bag, inp, PERIODS[k]!.start, PERIODS[k]!.end, cash, o.costBps) })),
    listJoin: per.map((days) => holdCurve(bagSeries, days, cash, { costBps: o.costBps, join: true })),
  };
}

/** T6: the note under every table that shows the two list yardsticks. */
export const JOIN_WHEN_LISTED_NOTE = 'The plain list yardstick leaves out a stock not trading on the period\'s first day (PLTR in 2020-2023, ALAB in 2024-2026), '
  + 'while the models trade it once listed; the "join when listed" row gives such a stock its equal share of the starting money, waiting in cash until its first trading day.';
export const joinName = (listName: string): string => listName + ' (join when listed)';

const pct = (v: number, cash: number): string => ((v / cash - 1) * 100 >= 0 ? '+' : '') + ((v / cash - 1) * 100).toFixed(0) + '%';

/**
 * The two rows for a table: `lead` label cells, the three periods, then `tail` cells where the cell named
 * 'fall' gets the deepest fall and the rest stay empty.
 * With `b.listJoin` (benchmarksFor always gives it), a third row: the list joining when listed (T6).
 */
export function benchRows(b: Benchmarks, cash: number, lead: number, tail: readonly string[], listName = 'Hold your list equally'): string[] {
  const row = (name: string, x: Bench[]): string => '| **' + name + '** | ' + Array(lead - 1).fill('—').map((c) => c + ' | ').join('') + x.map((y) => pct(y.finalTaxed, cash)).join(' | ') + ' | '
    + tail.map((c) => (c === 'fall' ? '-' + Math.max(...x.map((y) => y.maxDrawdownPct)).toFixed(0) + '%' : '—')).join(' | ') + ' |';
  return [row('Hold QQQ', b.qqq), row(listName, b.list), ...(b.listJoin ? [row(joinName(listName), b.listJoin)] : [])];
}

// ---------------------------------------------------------------------------------------------------------------
// G5 report columns (docs/models/MASTER_PLAN.md section 4, G5(a); James's Rule #131 "Miracle of Compounding" and his
// "out of every decade, there are 30 pivotal days to be invested"): for every row of a results table, per period the
// growth a year (CAGR, after tax), the doubling time and what $100,000 becomes in 5 / 10 / 20 years at that rate; the
// deepest fall with the gain needed to recover from it; and the best-days check (how many of the period's best QQQ
// days the row spent mostly in cash).

/** James: 30 pivotal days per decade, so 3 a year: 30 for 2010-2019, 12 for 2020-2023, 8 for 2024-2026. */
export const BEST_DAYS_PER_YEAR = 3;
/** Rule #131's table starts from $100,000. */
export const FV_BASE = 100_000;
export const FV_YEARS: readonly number[] = [5, 10, 20];

const DAY_MS = 86_400_000;
/** Calendar years from `start` to `end` ('YYYY-MM-DD'). */
export function yearsBetween(start: string, end: string): number {
  return (Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / DAY_MS / 365.25;
}

/** How many best days a period counts: 3 a year, rounded (30 / 12 / 8 for the three PERIODS). */
export function bestDaysCount(start: string, end: string): number {
  return Math.max(1, Math.round(BEST_DAYS_PER_YEAR * yearsBetween(start, end)));
}

/** The `n` days of the period with QQQ's largest close-to-close gain (both closes inside the period), by date. */
export function bestDays(qqq: PriceSeries, start: string, end: string, n: number): string[] {
  const moves: Array<{ d: string; r: number }> = [];
  for (let i = 1; i < qqq.dates.length; i++) {
    const d = qqq.dates[i] as string, prev = qqq.dates[i - 1] as string;
    if (prev < start || d > end) continue;
    moves.push({ d, r: (qqq.closes[i] as number) / (qqq.closes[i - 1] as number) - 1 });
  }
  return moves.sort((a, b) => b.r - a.r || a.d.localeCompare(b.d)).slice(0, n).map((x) => x.d).sort();
}

export interface BestDaysCheck {
  /** Best days the row has a reading for. */
  readonly n: number;
  /** Of those, the days it held half or more of the account in cash ("out of the market"). */
  readonly missed: number;
  /** The average share in cash on those days, %. */
  readonly cashSharePct: number;
}

/** The best-days check: the cash share on each best day (at that day's close; money in QQQ counts as invested). */
export function bestDaysCheck(best: readonly string[], cashShareByDay: ReadonlyMap<string, number> | undefined): BestDaysCheck | null {
  if (!cashShareByDay) return null;
  const xs = best.map((d) => cashShareByDay.get(d)).filter((x): x is number => x != null);
  if (!xs.length) return null;
  return { n: xs.length, missed: xs.filter((x) => x >= 0.5).length, cashSharePct: (xs.reduce((a, b) => a + b, 0) / xs.length) * 100 };
}

/** Growth a year from `cash` to `final` over [start, end]; null for a period under a month or a total loss. */
export function cagr(final: number, cash: number, start: string, end: string): number | null {
  const y = yearsBetween(start, end);
  if (!(y > 1 / 12) || !(final > 0) || !(cash > 0)) return null;
  return (final / cash) ** (1 / y) - 1;
}

/** Rule #131: years to double at a growth rate, ln 2 / ln(1 + g); null when it never doubles (g <= 0). */
export function doublingYears(g: number | null): number | null {
  return g == null || !(g > 0) ? null : Math.log(2) / Math.log(1 + g);
}

/** Rule #131: what `base` becomes after `years` at growth `g` a year. */
export function futureValue(g: number, years: number, base = FV_BASE): number {
  return base * (1 + g) ** years;
}

/** The gain needed to recover from a fall: a fall of X% needs X / (100 - X) (a -50% fall needs +100%, -80% needs +400%). */
export function recoveryNeededPct(fallPct: number): number {
  return fallPct >= 100 ? Infinity : (fallPct / (100 - fallPct)) * 100;
}

const money = (v: number): string => (v >= 1e6 ? '$' + (v / 1e6).toFixed(2) + 'M' : '$' + Math.round(v / 1000) + 'k');
const signed = (x: number, dp: number): string => (x >= 0 ? '+' : '') + x.toFixed(dp);

/** One row's result in one period, as the report columns need it. */
export interface PeriodOutcome {
  readonly finalTaxed: number;
  readonly maxDrawdownPct: number;
  readonly cashShareByDay?: ReadonlyMap<string, number> | undefined;
}

/** "+14.2%/yr, doubles in 5.2 yrs, $100,000 → $197k / $389k / $1.51M". */
export function growthCell(o: PeriodOutcome, cash: number, start: string, end: string): string {
  const g = cagr(o.finalTaxed, cash, start, end);
  if (g == null) return '—';
  const dbl = doublingYears(g);
  return signed(g * 100, 1) + '%/yr, ' + (dbl == null ? 'never doubles' : 'doubles in ' + dbl.toFixed(1) + ' yrs') + ', $100,000 → ' + FV_YEARS.map((y) => money(futureValue(g, y))).join(' / ');
}

/** "-55% (needs +122% to get back)". */
export function fallCell(fallPct: number): string {
  const r = recoveryNeededPct(fallPct);
  return '-' + fallPct.toFixed(0) + '% (needs ' + (Number.isFinite(r) ? '+' + r.toFixed(0) + '%' : 'more than any gain') + ' to get back)';
}

/** "2 of 30 mostly in cash (7% cash on average)". */
export function bestDaysCell(c: BestDaysCheck | null, n: number): string {
  if (!c) return '—';
  return c.missed + ' of ' + n + ' mostly in cash (' + c.cashSharePct.toFixed(0) + '% cash on average)';
}

/** The report table's two header lines: per period the growth, then the deepest fall, then per period the best days. */
export function reportHeader(): string[] {
  return [
    '| Row | ' + PERIODS.map((p) => p.name + ': a year after tax, doubling time, $100,000 in 5 / 10 / 20 yrs').join(' | ') + ' | Deepest fall (gain needed to get back) | '
      + PERIODS.map((p) => p.name + ': its ' + bestDaysCount(p.start, p.end) + ' best QQQ days').join(' | ') + ' |',
    '|---|' + PERIODS.map(() => '---|').join('') + '---|' + PERIODS.map(() => '---|').join(''),
  ];
}

/** One report row: `outcomes` holds one entry per PERIODS period (null when the row has no result there). */
export function reportRow(name: string, outcomes: ReadonlyArray<PeriodOutcome | null>, qqq: PriceSeries, cash: number): string {
  const growth = PERIODS.map((p, i) => { const o = outcomes[i]; return o ? growthCell(o, cash, p.start, p.end) : '—'; });
  const falls = outcomes.filter((o): o is PeriodOutcome => !!o).map((o) => o.maxDrawdownPct);
  const best = PERIODS.map((p, i) => {
    const n = bestDaysCount(p.start, p.end), o = outcomes[i];
    return o ? bestDaysCell(bestDaysCheck(bestDays(qqq, p.start, p.end, n), o.cashShareByDay), n) : '—';
  });
  return '| ' + name + ' | ' + growth.join(' | ') + ' | ' + (falls.length ? fallCell(Math.max(...falls)) : '—') + ' | ' + best.join(' | ') + ' |';
}

/**
 * The whole report-columns table for a results file: the yardsticks first (holding QQQ and holding the list
 * equally, plus its "join when listed" variant with the T6 note, from benchmarksFor), then each row.
 */
export function reportTable(bench: Benchmarks, rows: ReadonlyArray<{ name: string; outcomes: ReadonlyArray<PeriodOutcome | null> }>, qqq: PriceSeries, cash: number, listName = 'Hold your list equally'): string[] {
  return [
    '', 'Rule #131 reporting and the best-days check (James): growth a year after the 25% tax, years to double, what $100,000 becomes in 5 / 10 / 20 years at that rate; '
      + 'the deepest fall and the gain needed to get back from it; and how many of each period\'s best QQQ days (3 a year) the row spent mostly in cash (money in QQQ counts as invested).', '',
    ...(bench.listJoin ? [JOIN_WHEN_LISTED_NOTE, ''] : []),
    ...reportHeader(),
    reportRow('**Hold QQQ**', bench.qqq, qqq, cash),
    reportRow('**' + listName + '**', bench.list, qqq, cash),
    ...(bench.listJoin ? [reportRow('**' + joinName(listName) + '**', bench.listJoin, qqq, cash)] : []),
    ...rows.map((r) => reportRow(r.name, r.outcomes, qqq, cash)),
  ];
}
