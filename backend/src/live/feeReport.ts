/**
 * The fee report (phase 1, 1.5; decides D1): for each supported paper account, how often it trades, what the IBKR
 * fees would cost a $1,000 account, and whether it still beats 📊 Hold QQQ and 📊 Hold the research list after fees and after
 * the profile's tax (EXIT_TAX_RATE), with the deepest falls.
 *
 * Two sources:
 *   live paper   the paper test's own trades and values so far (StoredPaper), each trade scaled to the live start
 *                money and charged the fee model (a trade under the fee filter is skipped, as the bot would);
 *                fewer than MIN_LIVE_DAYS trading days are too few for a verdict;
 *   research     the 2010-2026 simulation of each account's setup on the 14 researched stocks
 *                (research/portfolioLab.ts runPortfolio, the same rules as the paper accounts), run once without
 *                and once with the fee as a cost per order at the $1,000 slot size (costBps; QQQ orders included).
 *                It needs the research price and reads files, so it is run by the CLI (`npm run live-fee-report --
 *                --prices DIR --reads DIR`) and its result is kept in researchFees.ts for the nightly.
 * An account is offered only when it beats both yardsticks after fees in every research period and, once the live
 * paper record is long enough, there too. The best offered account is the one with the largest compounded research
 * result after fees (the live result when there is no research row).
 */

import type { StoredPaper } from '../paper/paperJob.ts';
import { PAPER_CASH, PAPER_DECIDE_FROM } from '../paper/paperTrading.ts';
import { SUPPORTED_ACCOUNTS } from './target.ts';
import { orderFee, type LiveConfig } from './liveConfig.ts';
import { roundShares } from './planner.ts';
import { compareWithPaper } from './liveLog.ts';
import { LABELS } from '../profile/labels.ts';
import { EXIT_TAX_PCT } from '../portfolio/exitTax.ts';
import { PAPER_RESEARCH_14 } from '../paper/paperLab.ts';

export const MIN_LIVE_DAYS = 20;
export const TRADING_DAYS_A_YEAR = 252;

export interface ResearchPeriod {
  readonly period: string;
  readonly years: number;
  /** Stock trades (buys + sells, QQQ not counted). */
  readonly trades: number;
  /** Return after tax, %, without and with the fees. */
  readonly afterTaxPct: number;
  readonly afterFeesPct: number;
  readonly fallPct: number;
  readonly qqqPct: number;
  readonly qqqFallPct: number;
  readonly list14Pct: number;
  readonly list14FallPct: number;
}
export interface ResearchFeeRow {
  readonly id: string;
  readonly label: string;
  readonly slots: number;
  /** The fee as basis points of a $1,000 / slots order. */
  readonly feeBps: number;
  /** Orders a year: every stock trade and its QQQ counter-order (funding a buy, parking a sale). */
  readonly ordersPerYear: number;
  readonly feeDragPctYear: number;
  readonly periods: readonly ResearchPeriod[];
}
export interface ResearchFeeTable { readonly generatedOn: string; readonly startValue: number; readonly note: string; readonly rows: readonly ResearchFeeRow[] }

export interface LiveFeeStats {
  readonly tradingDays: number;
  readonly orders: number;
  readonly skipped: number;
  readonly fees: number;
  readonly ordersPerYear: number | null;
  readonly feeDragPctYear: number | null;
  /** On the live start money, after tax and after the fees. */
  readonly afterFees: number | null;
  readonly qqq: number | null;
  readonly list14: number | null;
  readonly fallPct: number;
  readonly qqqFallPct: number;
  readonly list14FallPct: number;
  readonly enough: boolean;
}

export interface FeeReportRow {
  readonly id: string;
  readonly label: string;
  readonly slots: number;
  readonly live: LiveFeeStats | null;
  readonly research: ResearchFeeRow | null;
  readonly beatsBoth: boolean;
  /** Why it is or is not offered, in a few words. */
  readonly verdict: string;
}
export interface FeeReport { readonly rows: readonly FeeReportRow[]; readonly offered: readonly string[]; readonly best: string | null; readonly line: string }

/** The live paper record of one account, on the live start money. */
export function liveFeeStats(p: StoredPaper, id: string, cfg: Pick<LiveConfig, 'startValue' | 'minTrade' | 'fractional' | 'fees'>): LiveFeeStats {
  const st = SUPPORTED_ACCOUNTS.find((s) => s.id === id);
  const k = cfg.startValue / (st?.cash ?? PAPER_CASH);
  let orders = 0, skipped = 0, fees = 0;
  for (const t of p.trades) {
    if (t.strategy !== id || !(t.price > 0)) continue;
    const v = t.value * k, fullExit = t.side === 'SELL' && t.ticker !== 'QQQ';
    const shares = fullExit ? v / t.price : roundShares(v / t.price, cfg.fractional);
    if (shares * t.price < cfg.minTrade && !fullExit) { skipped++; continue; }
    orders++; fees += orderFee(shares, t.price, cfg.fees);
  }
  const days = p.state.marks.filter((m) => m.values[id] != null).length;
  const years = days / TRADING_DAYS_A_YEAR;
  const cmp = compareWithPaper(p.state, id, { day: p.state.joins?.[id]?.day ?? PAPER_DECIDE_FROM, value: cfg.startValue });
  return {
    tradingDays: days, orders, skipped, fees, ordersPerYear: days ? orders / years : null, feeDragPctYear: days ? (fees / cfg.startValue / years) * 100 : null,
    afterFees: cmp.twin == null ? null : cmp.twin - fees, qqq: cmp.qqq, list14: cmp.list14, fallPct: cmp.twinFall, qqqFallPct: cmp.qqqFall, list14FallPct: cmp.list14Fall,
    enough: days >= MIN_LIVE_DAYS,
  };
}

const growth = (r: ResearchFeeRow): number => r.periods.reduce((g, x) => g * (1 + x.afterFeesPct / 100), 1);

export function buildFeeReport(p: StoredPaper | null, research: ResearchFeeTable | null, cfg: Pick<LiveConfig, 'startValue' | 'minTrade' | 'fractional' | 'fees'>): FeeReport {
  const rows: FeeReportRow[] = SUPPORTED_ACCOUNTS.map((st) => {
    const live = p ? liveFeeStats(p, st.id, cfg) : null;
    const res = research?.rows.find((r) => r.id === st.id) ?? null;
    const lost: string[] = [];
    if (res) for (const x of res.periods) {
      if (!(x.afterFeesPct > x.qqqPct)) lost.push('trails Hold QQQ in ' + x.period);
      else if (!(x.afterFeesPct > x.list14Pct)) lost.push('trails ' + LABELS.holdList + ' in ' + x.period);
    }
    const liveCounts = !!live && live.enough && live.afterFees != null;
    if (liveCounts && !(live!.afterFees! > (live!.qqq ?? Infinity))) lost.push('trails Hold QQQ in the live paper test');
    else if (liveCounts && !(live!.afterFees! > (live!.list14 ?? Infinity))) lost.push('trails ' + LABELS.holdList + ' in the live paper test');
    const evidence = !!res || liveCounts;
    const beatsBoth = evidence && !lost.length;
    const verdict = !evidence ? 'no research row and the live record is too short' : beatsBoth ? 'beats both after fees and tax' : lost[0]!;
    return { id: st.id, label: st.label, slots: st.slots, live, research: res, beatsBoth, verdict };
  });
  const offered = rows.filter((r) => r.beatsBoth);
  const score = (r: FeeReportRow): number => (r.research ? growth(r.research) : (r.live?.afterFees ?? 0) / cfg.startValue);
  const best = [...offered].sort((x, y) => score(y) - score(x) || x.id.localeCompare(y.id))[0] ?? null;
  const line = best ? 'Best after fees and tax: ' + best.label + ' (' + offered.length + ' of ' + rows.length + ' accounts beat Hold QQQ and ' + LABELS.holdList + ')'
    : 'No paper account beats both Hold QQQ and ' + LABELS.holdList + ' after fees and tax: nothing to follow.';
  return { rows, offered: offered.map((r) => r.id), best: best?.id ?? null, line };
}

const pct = (v: number): string => (v >= 0 ? '+' : '') + v.toFixed(0) + '%';
const money = (v: number | null): string => (v == null ? '—' : '$' + v.toFixed(0));

/** The report as plain text lines (the CLI). */
export function feeReportText(r: FeeReport, research: ResearchFeeTable | null): string[] {
  const out: string[] = ['💵 Live bot fee report (a $1,000 account; IBKR Pro estimate: $0.005 a share, at least $1, at most 1% of the order; ' + EXIT_TAX_PCT + ' tax)', ''];
  if (research) {
    out.push('Research ' + research.rows[0]?.periods.map((x) => x.period).join(' / ') + ' on the ' + PAPER_RESEARCH_14.length + ' researched stocks, after tax, without -> with fees (' + research.generatedOn + '):');
    const q = research.rows[0]?.periods;
    if (q) out.push('  📊 Hold QQQ: ' + q.map((x) => pct(x.qqqPct) + ' (fall -' + x.qqqFallPct.toFixed(0) + '%)').join(' / '), '  📊 ' + LABELS.holdList + ': ' + q.map((x) => pct(x.list14Pct) + ' (fall -' + x.list14FallPct.toFixed(0) + '%)').join(' / '));
  }
  for (const row of r.rows) {
    const x = row.research, l = row.live;
    out.push('', (row.beatsBoth ? '✅ ' : '❌ ') + row.label + ' [' + row.id + ']: ' + row.verdict);
    if (x) {
      out.push('  research: ' + x.ordersPerYear.toFixed(1) + ' orders a year, fee drag ' + x.feeDragPctYear.toFixed(2) + '%/yr (' + x.feeBps.toFixed(0) + ' bp an order)');
      out.push('  ' + x.periods.map((p) => p.period + ' ' + pct(p.afterTaxPct) + ' -> ' + pct(p.afterFeesPct) + ' (fall -' + p.fallPct.toFixed(0) + '%, ' + (p.trades / p.years).toFixed(1) + ' trades/yr)').join(' · '));
    }
    if (l) {
      out.push('  live paper (' + l.tradingDays + ' trading day' + (l.tradingDays === 1 ? '' : 's') + (l.enough ? '' : ', too few for a verdict') + '): ' + l.orders + ' orders (' + l.skipped + ' under the fee filter), fees $' + l.fees.toFixed(2)
        + (l.ordersPerYear != null ? ', ~' + l.ordersPerYear.toFixed(0) + ' orders/yr, drag ' + (l.feeDragPctYear ?? 0).toFixed(1) + '%/yr' : '')
        + '; after fees ' + money(l.afterFees) + ' (fall -' + l.fallPct.toFixed(1) + '%) vs Hold QQQ ' + money(l.qqq) + ' (-' + l.qqqFallPct.toFixed(1) + '%), ' + LABELS.holdList + ' ' + money(l.list14) + ' (-' + l.list14FallPct.toFixed(1) + '%)');
    }
  }
  out.push('', r.line);
  return out;
}

/** The short section for the nightly Telegram message. */
export function feeReportSection(r: FeeReport): string[] {
  const out = ['Fee report ($1,000, after fees and ' + EXIT_TAX_PCT + ' tax; research 2010-26):'];
  for (const row of r.rows) {
    const x = row.research;
    const l = row.live?.enough ? row.live : null;
    out.push((row.beatsBoth ? '✅ ' : '❌ ') + row.label.replace(/ \(list, /, ' (') + (x ? ': ' + x.ordersPerYear.toFixed(0) + ' orders/yr, fees ' + x.feeDragPctYear.toFixed(1) + '%/yr, ' + x.periods.map((p) => pct(p.afterFeesPct)).join('/') + ', fall -' + Math.max(...x.periods.map((p) => p.fallPct)).toFixed(0) + '%' : ': ' + row.verdict)
      + (l ? '; live paper ' + (l.ordersPerYear ?? 0).toFixed(0) + ' orders/yr, ' + money(l.afterFees) + ' (fall -' + l.fallPct.toFixed(0) + '%) vs QQQ ' + money(l.qqq) + ', ' + LABELS.list + ' ' + money(l.list14) : ''));
  }
  const days = Math.max(0, ...r.rows.map((x) => x.live?.tradingDays ?? 0));
  if (r.rows.some((x) => x.live && !x.live.enough)) out.push('Live paper test: ' + days + ' trading day' + (days === 1 ? '' : 's') + ' so far (' + MIN_LIVE_DAYS + ' needed before it counts).');
  const q = r.rows.find((x) => x.research)?.research?.periods;
  if (q) out.push('📊 Hold QQQ ' + q.map((p) => pct(p.qqqPct)).join('/') + ', fall -' + Math.max(...q.map((p) => p.qqqFallPct)).toFixed(0) + '%; 📊 ' + LABELS.holdList + ' ' + q.map((p) => pct(p.list14Pct)).join('/') + ', fall -' + Math.max(...q.map((p) => p.list14FallPct)).toFixed(0) + '%');
  out.push(r.line);
  return out;
}
