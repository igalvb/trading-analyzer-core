/**
 * Business-based exit alerts (owner-approved build 2026-11-07; profile flag `exit.businessAlerts`: off | shadow | on,
 * default off). SHADOW ONLY: nothing here changes an EXIT / REVIEW / HOLD verdict, a score or a buy rule. The owner's
 * rule: a strong stock is never sold at a loss on price; an exit comes from a fundamental break or a black swan, and
 * this module only RAISES THE ALERT (the owner decides).
 *
 * Per holding (a company; an option counts as its underlying), each check answers TRIGGERED, CLEAR or UNKNOWN.
 * Missing or degraded data is UNKNOWN, never CLEAR. The checks:
 *   REVENUE  revenue growth turns negative (the stored value before the current one was >= 0) or is below the floor
 *   MARGIN   the net (profit) margin fell by more than N points vs the value in force 90 days ago
 *   RATING   the analysts' mean rating score worsened by >= 1 step vs 90 days ago, or the rating left Buy / Strong Buy
 *   TARGET   the mean analyst target was cut by >= 20% vs 90 days ago
 *   SEC_DILUTION   a NEW offering / dilution / convertible hit in the nightly SEC full-text search (the count rose
 *                  since the last stored count; an alert stays up 30 days)
 *   SEC_DISTRESS   going-concern or auditor-change wording: NOT in the nightly search today, so UNKNOWN until it is
 * and ONE market-wide check for the whole book:
 *   MARKET   VIX close >= 35, or QQQ down 10% or more over 5 trading days. A BUY POINT, NEVER AN EXIT (owner yes
 *            2026-11-07; history: QQQ higher a year later after 27 of 28 shocks since 2008, docs/BUSINESS_EXIT_ALERTS_
 *            2026-11-07.md): labelled MARKET_BUY_POINT, and its ONE Telegram line goes out in shadow AND on (it is a buy
 *            alert, not an exit alert), at most once per 10 trading days (QQQ's own bars)
 *
 * Data: tonight's analysis (the same fundamentals '💾 Fundamentals History' stores), the stored history rows before
 * tonight, the SEC keyword counts the analysis already fetched (no extra provider call), the VIX and QQQ charts.
 * State (one key in the property store): when each alert was first seen and last sent, and the last SEC counts.
 * Telegram: the stock alerts only in mode 'on' (ONE line per NEW trigger, at most once per 30 days per stock per
 * trigger; in shadow they stay in the report and the log); the market-shock buy point in shadow and on (see above).
 */

import type { TabCell } from '../../storage/tabStore.ts';
import type { FundamentalsRecord } from '../../storage/fundamentalsHistory.ts';
import { fundamentalsRecordOf, recordOfRow } from '../../storage/fundamentalsHistory.ts';
import type { TickerArtifacts } from '../../analysis/runTicker.ts';
import type { Chart } from '../../types/chart.ts';
import type { PropertyStore } from '../../storage/kv.ts';
import type { Logger } from '../../core/logger.ts';
import { orElse, orElseAsync } from '../../core/guard.ts';
import { formatDateInTz } from '../../core/dates.ts';
import { notifyIfNeeded, type TelegramTarget } from '../../notify/policy.ts';
import type { BusinessAlertsView } from '../../reports/exitSheet/types.ts';
import { BUSINESS_ALERTS_MODES, type BusinessAlertsMode } from '../../profile/schema.ts';

// ── thresholds (ONE place; docs/BUSINESS_EXIT_ALERTS_2026-11-07.md has the proposal table) ─────────────────────────

export const BUSINESS_ALERT_RULES = {
  /** (1) Revenue growth (a ratio, -0.05 = -5%) below this is an alert on its own. */
  revenueFloor: -0.05,
  /** (1) A turn from >= 0 to < 0 counts as new for this many days after the night it was first stored. */
  eventWindowDays: 30,
  /** (2) Net margin fall, in percentage points, vs the value in force `lookbackDays` ago (strictly more than this). */
  marginDropPoints: 10,
  /** (2), (3) The baseline: the stored value in force this many calendar days before tonight. */
  lookbackDays: 90,
  /** (3) Mean rating score (1 = Strong Buy ... 5 = Sell) worsening by at least this many steps. */
  ratingStepsWorse: 1,
  /** (3) The ratings that count as "Buy" (lower case, '_' and '-' read as spaces). */
  buyRatings: ['buy', 'strong buy'] as readonly string[],
  /** (3) Mean analyst target cut by at least this fraction. */
  targetCut: 0.20,
  /** (4) The nightly SEC search keywords that count as dilution. */
  secDilutionKeywords: ['offering', 'dilution', 'convertible'] as readonly string[],
  /** (4) Distress wording (not in the nightly search yet: UNKNOWN until a search supplies these counts). */
  secDistressKeywords: ['going concern', 'certifying accountant'] as readonly string[],
  /** (4) A new SEC hit stays an alert this many days. */
  secWindowDays: 30,
  /** (5) VIX close at or above this. */
  vixShock: 35,
  /** (5) QQQ change over `qqqDays` trading days at or below this (-0.10 = -10%). */
  qqqFall: -0.10,
  qqqDays: 5,
  /** Telegram and "new" marking: once per this many days per stock per trigger. */
  dedupeDays: 30,
  /** (5) The market-shock buy point's Telegram line: at most once per this many trading days (QQQ's bars). */
  marketDedupeTradingDays: 10,
  /** State entries older than this are dropped. */
  stateKeepDays: 120,
} as const;

export type { BusinessAlertsMode };

export type TriggerId = 'REVENUE' | 'MARGIN' | 'RATING' | 'TARGET' | 'SEC_DILUTION' | 'SEC_DISTRESS' | 'MARKET';
export type CheckState = 'TRIGGERED' | 'CLEAR' | 'UNKNOWN';

export const TRIGGER_LABELS: Readonly<Record<TriggerId, string>> = {
  REVENUE: 'Revenue growth', MARGIN: 'Net margin', RATING: 'Analyst rating', TARGET: 'Analyst target',
  SEC_DILUTION: 'SEC filings (dilution)', SEC_DISTRESS: 'SEC filings (going concern / auditor)', MARKET: 'Market shock',
};

/** (5) The market trigger's label when it fires (owner wording 2026-11-07). Never an exit. */
export const MARKET_BUY_POINT = 'Market shock — historically a buy point (27 of 28 since 2008 higher a year later); the big-loan case if your strong stocks wash out too';

export interface CheckResult {
  readonly id: TriggerId;
  readonly state: CheckState;
  /** Plain sentence with the numbers. */
  readonly text: string;
  /** Where the figure came from (the stored source label, 'SEC full-text search', 'VIX / QQQ daily closes'). */
  readonly source: string | null;
  /** 'YYYY-MM-DD' the triggering value was first seen; null unless TRIGGERED. */
  readonly date: string | null;
  /** TRIGGERED and not seen in the last dedupeDays (set by evaluateBusinessAlerts). */
  readonly isNew?: boolean;
}

/** One fundamentals point (the '💾 Fundamentals History' fields the checks read). Ratios as stored (0.05 = 5%). */
export interface FundPoint {
  readonly date: string;
  readonly revenueGrowth: number | null;
  readonly profitMargin: number | null;
  readonly analystTarget: number | null;
  readonly ratingScore: number | null;
  readonly rating: string | null;
  readonly source: string;
}

export interface SecHits {
  /** Keyword -> filings in the search window (365 days); null = SEC could not answer for that keyword. */
  readonly hits: Readonly<Record<string, number | null>>;
}

export interface HoldingAlertInput {
  readonly ticker: string;
  /** Stored history for the ticker, dates before tonight (any order). */
  readonly history: readonly FundPoint[];
  /** Tonight's values (null = tonight's analysis has no fundamentals for it). */
  readonly latest: FundPoint | null;
  /** Tonight's SEC keyword counts (null = the search did not run for this stock). */
  readonly sec: SecHits | null;
}

export interface MarketInput {
  readonly vix: { readonly close: number; readonly date: string } | null;
  /**
   * QQQ daily closes, oldest first (at least qqqDays + 1 needed); `dates` ('YYYY-MM-DD', one per close) count the
   * trading days of the buy point's Telegram dedupe (absent = weekdays).
   */
  readonly qqq: { readonly closes: readonly number[]; readonly date: string; readonly dates?: readonly string[] } | null;
}

export interface BusinessAlertState {
  readonly v: 1;
  /** 'TICKER|TRIGGER' -> the day it was last marked new (report / log). */
  readonly seen: Readonly<Record<string, string>>;
  /** 'TICKER|TRIGGER' -> the day its Telegram line was last sent. */
  readonly sent: Readonly<Record<string, string>>;
  /** Ticker -> the last SEC counts stored (the baseline for "new"). */
  readonly sec: Readonly<Record<string, { readonly date: string; readonly hits: Readonly<Record<string, number>> }>>;
  /** Ticker -> the day a new SEC dilution hit was first seen (kept up secWindowDays). */
  readonly secNew: Readonly<Record<string, string>>;
}

export const EMPTY_STATE: BusinessAlertState = { v: 1, seen: {}, sent: {}, sec: {}, secNew: {} };
export const BUSINESS_ALERTS_STATE_KEY = 'BUSINESS_ALERTS_STATE_V1';
export const MARKET_KEY = 'MARKET';

// ── small helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const dayMs = (d: string): number => Date.parse(d.slice(0, 10) + 'T00:00:00Z');
export const daysBetween = (from: string, to: string): number => Math.round((dayMs(to) - dayMs(from)) / DAY_MS);
export const addDays = (d: string, n: number): string => new Date(dayMs(d) + n * DAY_MS).toISOString().slice(0, 10);
const pct = (r: number, dp = 1): string => (r * 100 >= 0 ? '+' : '') + (r * 100).toFixed(dp) + '%';
const pctPlain = (r: number, dp = 1): string => (r * 100).toFixed(dp) + '%';
const usd = (n: number): string => '$' + n.toFixed(2);
const round = (v: number, dp: number): number => { const f = 10 ** dp; return Math.round(v * f) / f; };
const normRating = (s: string | null): string | null => (s == null || s.trim() === '' ? null : s.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' '));
const isBuy = (s: string | null): boolean => { const n = normRating(s); return n != null && BUSINESS_ALERT_RULES.buyRatings.includes(n); };
const srcOf = (p: FundPoint | null | undefined): string | null => (p && p.source.trim() ? p.source.trim() : null);

type NumKey = 'revenueGrowth' | 'profitMargin' | 'analystTarget' | 'ratingScore';
/** Stored precision (fundamentalsHistory.ts FIELDS), so tonight's raw value compares equal to the stored one. */
const DP: Readonly<Record<NumKey, number>> = { revenueGrowth: 4, profitMargin: 4, analystTarget: 2, ratingScore: 2 };

/** Tonight's point rounded like a stored row. */
export function roundedPoint(p: FundPoint): FundPoint {
  const r = (k: NumKey): number | null => (fin(p[k]) ? round(p[k] as number, DP[k]) : null);
  return { ...p, revenueGrowth: r('revenueGrowth'), profitMargin: r('profitMargin'), analystTarget: r('analystTarget'), ratingScore: r('ratingScore') };
}

/** History before `today` plus tonight's point, oldest first (a stored row of tonight's date is dropped). */
function seriesOf(i: HoldingAlertInput, today: string): FundPoint[] {
  const past = i.history.filter((p) => p.date && p.date < today).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return i.latest ? [...past, roundedPoint({ ...i.latest, date: today })] : past;
}

/** The value in force on `day`: the last point dated on or before it with the field set. */
function valueOn<K extends keyof FundPoint>(pts: readonly FundPoint[], key: K, day: string): { readonly v: NonNullable<FundPoint[K]>; readonly p: FundPoint } | null {
  for (let k = pts.length - 1; k >= 0; k--) {
    const p = pts[k]!;
    if (p.date > day) continue;
    const v = p[key];
    if (v != null && v !== '') return { v: v as NonNullable<FundPoint[K]>, p };
  }
  return null;
}

/**
 * The latest value of `key`, the day that value was first stored (the start of its run of equal values) and the
 * value before that run (null = none stored). Points without the field are skipped.
 */
function changeOf<K extends keyof FundPoint>(pts: readonly FundPoint[], key: K, same: (a: FundPoint[K], b: FundPoint[K]) => boolean): { latest: FundPoint[K]; since: string; prev: FundPoint[K] | null; prevPoint: FundPoint | null } | null {
  const with_ = pts.filter((p) => p[key] != null && p[key] !== '');
  if (!with_.length) return null;
  const last = with_[with_.length - 1]!;
  let k = with_.length - 1;
  while (k > 0 && same(with_[k - 1]![key], last[key])) k--;
  return { latest: last[key], since: with_[k]!.date, prev: k > 0 ? with_[k - 1]![key] : null, prevPoint: k > 0 ? with_[k - 1]! : null };
}

const numSame = (a: unknown, b: unknown): boolean => fin(a) && fin(b) && Math.abs(a - b) < 1e-9;

/** The first stored date (null = nothing stored before tonight). */
export function historyStartOf(history: readonly FundPoint[], today: string): string | null {
  let first: string | null = null;
  for (const p of history) if (p.date && p.date < today && (first === null || p.date < first)) first = p.date;
  return first;
}

const needHistory = (first: string | null, today: string): string => {
  const days = BUSINESS_ALERT_RULES.lookbackDays;
  return first ? 'not known yet: the stored history starts ' + first + ' (' + daysBetween(first, today) + ' days), the check needs ' + days + ' days'
    : 'not known yet: no stored history before tonight, the check needs ' + days + ' days';
};

// ── the checks (pure) ─────────────────────────────────────────────────────────────────────────────────────────────

/** (1) Revenue growth turns negative, or is below the floor. */
export function checkRevenue(i: HoldingAlertInput, today: string): CheckResult {
  const R = BUSINESS_ALERT_RULES;
  const pts = seriesOf(i, today);
  const lat = i.latest ? roundedPoint(i.latest).revenueGrowth : null;
  if (lat == null) return { id: 'REVENUE', state: 'UNKNOWN', text: 'no revenue growth figure tonight', source: srcOf(i.latest), date: null };
  const ch = changeOf(pts, 'revenueGrowth', numSame)!;
  if (lat < R.revenueFloor) {
    return { id: 'REVENUE', state: 'TRIGGERED', text: 'revenue growth ' + pct(lat) + ', below the ' + pct(R.revenueFloor, 0) + ' floor' + (ch.since < today ? ' (since ' + ch.since + ')' : ''), source: srcOf(i.latest), date: ch.since };
  }
  if (lat >= 0) return { id: 'REVENUE', state: 'CLEAR', text: 'revenue growth ' + pct(lat), source: srcOf(i.latest), date: null };
  // Negative but above the floor: an alert only when it TURNED (the value before was >= 0), within the event window.
  if (ch.prev == null) return { id: 'REVENUE', state: 'UNKNOWN', text: 'revenue growth ' + pct(lat) + ' (negative); no earlier stored value to tell whether it just turned', source: srcOf(i.latest), date: null };
  const prev = ch.prev as number;
  if (prev >= 0 && daysBetween(ch.since, today) <= R.eventWindowDays) {
    return { id: 'REVENUE', state: 'TRIGGERED', text: 'revenue growth turned negative: ' + pct(lat) + ', was ' + pct(prev) + ' (stored ' + ch.prevPoint!.date + ')', source: srcOf(i.latest), date: ch.since };
  }
  return { id: 'REVENUE', state: 'CLEAR', text: 'revenue growth ' + pct(lat) + (prev >= 0 ? ', negative since ' + ch.since + ' (older than ' + R.eventWindowDays + ' days, not a new break)' : ', already negative before (' + pct(prev) + ')'), source: srcOf(i.latest), date: null };
}

/** (2) Net margin fell by more than N points vs the value in force lookbackDays ago. */
export function checkMargin(i: HoldingAlertInput, today: string): CheckResult {
  const R = BUSINESS_ALERT_RULES;
  const lat = i.latest ? roundedPoint(i.latest).profitMargin : null;
  if (lat == null) return { id: 'MARGIN', state: 'UNKNOWN', text: 'no net margin figure tonight', source: srcOf(i.latest), date: null };
  const pts = seriesOf(i, today);
  const base = valueOn(pts, 'profitMargin', addDays(today, -R.lookbackDays));
  if (!base) return { id: 'MARGIN', state: 'UNKNOWN', text: needHistory(historyStartOf(i.history, today), today), source: srcOf(i.latest), date: null };
  const b = base.v as number;
  const drop = (b - lat) * 100;
  const text = 'net margin ' + pctPlain(lat) + ' vs ' + pctPlain(b) + ' on ' + base.p.date + ' (' + (drop > 0 ? '-' : '+') + Math.abs(drop).toFixed(1) + ' points)';
  if (drop > R.marginDropPoints) return { id: 'MARGIN', state: 'TRIGGERED', text, source: srcOf(i.latest), date: changeOf(pts, 'profitMargin', numSame)!.since };
  return { id: 'MARGIN', state: 'CLEAR', text, source: srcOf(i.latest), date: null };
}

/** (3a) Rating: the score worsened by >= 1 step vs lookbackDays ago, or the rating left Buy / Strong Buy (event window). */
export function checkRating(i: HoldingAlertInput, today: string): CheckResult {
  const R = BUSINESS_ALERT_RULES;
  const pts = seriesOf(i, today);
  const latP = i.latest ? roundedPoint(i.latest) : null;
  const parts: string[] = [];
  let unknown = false;
  let trig: { text: string; date: string } | null = null;
  // Left Buy: the rating before the current one was Buy / Strong Buy and the current one is not.
  if (!latP || normRating(latP.rating) == null) { unknown = true; parts.push('no rating tonight'); }
  else {
    const ch = changeOf(pts, 'rating', (a, b) => normRating(a as string | null) === normRating(b as string | null))!;
    if (!isBuy(latP.rating) && ch.prev != null && isBuy(ch.prev as string) && daysBetween(ch.since, today) <= R.eventWindowDays) {
      trig = { text: 'rating left Buy: ' + latP.rating + ', was ' + ch.prev + ' (stored ' + ch.prevPoint!.date + ')', date: ch.since };
    } else if (!isBuy(latP.rating) && ch.prev == null) { unknown = true; parts.push('rating ' + latP.rating + ' (no earlier stored rating)'); }
    else parts.push('rating ' + latP.rating);
  }
  // Score step: vs the value in force lookbackDays ago.
  if (!latP || latP.ratingScore == null) { unknown = true; parts.push('no rating score tonight'); }
  else {
    const base = valueOn(pts, 'ratingScore', addDays(today, -R.lookbackDays));
    if (!base) { unknown = true; parts.push('rating score ' + latP.ratingScore.toFixed(2) + ', change ' + needHistory(historyStartOf(i.history, today), today)); }
    else {
      const worse = latP.ratingScore - (base.v as number);
      const t = 'rating score ' + latP.ratingScore.toFixed(2) + ' vs ' + (base.v as number).toFixed(2) + ' on ' + base.p.date + ' (1 = Strong Buy, 5 = Sell)';
      if (worse >= R.ratingStepsWorse - 1e-9) trig = trig ? { text: trig.text + '; ' + t, date: trig.date } : { text: 'rating downgrade: ' + t, date: changeOf(pts, 'ratingScore', numSame)!.since };
      else parts.push(t);
    }
  }
  if (trig) return { id: 'RATING', state: 'TRIGGERED', text: trig.text, source: srcOf(i.latest), date: trig.date };
  return { id: 'RATING', state: unknown ? 'UNKNOWN' : 'CLEAR', text: parts.join('; '), source: srcOf(i.latest), date: null };
}

/** (3b) Mean analyst target cut by >= targetCut vs lookbackDays ago. */
export function checkTarget(i: HoldingAlertInput, today: string): CheckResult {
  const R = BUSINESS_ALERT_RULES;
  const lat = i.latest ? roundedPoint(i.latest).analystTarget : null;
  if (lat == null) return { id: 'TARGET', state: 'UNKNOWN', text: 'no analyst target tonight', source: srcOf(i.latest), date: null };
  const pts = seriesOf(i, today);
  const base = valueOn(pts, 'analystTarget', addDays(today, -R.lookbackDays));
  if (!base) return { id: 'TARGET', state: 'UNKNOWN', text: 'target ' + usd(lat) + ', change ' + needHistory(historyStartOf(i.history, today), today), source: srcOf(i.latest), date: null };
  const b = base.v as number;
  if (!(b > 0)) return { id: 'TARGET', state: 'UNKNOWN', text: 'the stored target on ' + base.p.date + ' is not usable', source: srcOf(i.latest), date: null };
  const ch = lat / b - 1;
  const text = 'mean analyst target ' + usd(lat) + ' vs ' + usd(b) + ' on ' + base.p.date + ' (' + pct(ch) + ')';
  if (ch <= -R.targetCut + 1e-12) return { id: 'TARGET', state: 'TRIGGERED', text: 'analyst target cut: ' + text, source: srcOf(i.latest), date: changeOf(pts, 'analystTarget', numSame)!.since };
  return { id: 'TARGET', state: 'CLEAR', text, source: srcOf(i.latest), date: null };
}

const SEC_SOURCE = 'SEC full-text search (365-day counts)';

/**
 * (4a) A NEW dilution hit: tonight's 365-day count of an offering / dilution / convertible keyword is above the last
 * stored count. A hit seen within secWindowDays stays an alert. No stored count yet = UNKNOWN (tonight's is stored).
 */
export function checkSecDilution(i: HoldingAlertInput, today: string, state: BusinessAlertState): CheckResult {
  const R = BUSINESS_ALERT_RULES;
  const since = state.secNew[i.ticker];
  const active = since && daysBetween(since, today) <= R.secWindowDays ? since : null;
  if (!i.sec) return { id: 'SEC_DILUTION', state: active ? 'TRIGGERED' : 'UNKNOWN', text: active ? 'a new dilution filing hit on ' + active + ' (tonight the SEC search did not run for this stock)' : 'the SEC filing search did not run for this stock tonight', source: SEC_SOURCE, date: active };
  const missing = R.secDilutionKeywords.filter((k) => !fin(i.sec!.hits[k]));
  const base = state.sec[i.ticker];
  const rose = base ? R.secDilutionKeywords.filter((k) => fin(i.sec!.hits[k]) && fin(base.hits[k]) && (i.sec!.hits[k] as number) > (base.hits[k] as number)) : [];
  if (rose.length) {
    const what = rose.map((k) => '"' + k + '" ' + base!.hits[k] + ' -> ' + i.sec!.hits[k]).join(', ');
    return { id: 'SEC_DILUTION', state: 'TRIGGERED', text: 'new SEC filing hit since ' + base!.date + ': ' + what, source: SEC_SOURCE, date: today };
  }
  if (active) return { id: 'SEC_DILUTION', state: 'TRIGGERED', text: 'a new dilution filing hit on ' + active + ' (within ' + R.secWindowDays + ' days)', source: SEC_SOURCE, date: active };
  if (missing.length) return { id: 'SEC_DILUTION', state: 'UNKNOWN', text: 'the SEC search could not check: ' + missing.join(', '), source: SEC_SOURCE, date: null };
  if (!base) return { id: 'SEC_DILUTION', state: 'UNKNOWN', text: 'first night: tonight\'s filing counts are stored as the starting point', source: SEC_SOURCE, date: null };
  return { id: 'SEC_DILUTION', state: 'CLEAR', text: 'no new offering / dilution / convertible hit since ' + base.date, source: SEC_SOURCE, date: null };
}

/** (4b) Going concern / auditor change: only when a search supplies those counts; otherwise UNKNOWN (never clean). */
export function checkSecDistress(i: HoldingAlertInput, _today: string, state: BusinessAlertState): CheckResult {
  const R = BUSINESS_ALERT_RULES;
  const hits = i.sec?.hits ?? null;
  if (!hits || R.secDistressKeywords.some((k) => !fin(hits[k]))) {
    return { id: 'SEC_DISTRESS', state: 'UNKNOWN', text: 'going-concern and auditor-change wording is not part of the nightly SEC search', source: SEC_SOURCE, date: null };
  }
  const base = state.sec[i.ticker];
  if (!base || R.secDistressKeywords.some((k) => !fin(base.hits[k]))) return { id: 'SEC_DISTRESS', state: 'UNKNOWN', text: 'first night for this wording: tonight\'s counts are the starting point', source: SEC_SOURCE, date: null };
  const rose = R.secDistressKeywords.filter((k) => (hits[k] as number) > (base.hits[k] as number));
  if (rose.length) return { id: 'SEC_DISTRESS', state: 'TRIGGERED', text: 'new SEC filing wording since ' + base.date + ': ' + rose.map((k) => '"' + k + '"').join(', '), source: SEC_SOURCE, date: _today };
  return { id: 'SEC_DISTRESS', state: 'CLEAR', text: 'no new going-concern or auditor-change wording since ' + base.date, source: SEC_SOURCE, date: null };
}

/** (5) One market-wide check for the whole book. */
export function checkMarket(m: MarketInput): CheckResult {
  const R = BUSINESS_ALERT_RULES;
  const src = 'VIX / QQQ daily closes';
  const bits: string[] = [];
  const hit: string[] = [];
  let date: string | null = null;
  if (m.vix && fin(m.vix.close)) {
    bits.push('VIX ' + m.vix.close.toFixed(1) + ' (' + m.vix.date + ')');
    if (m.vix.close >= R.vixShock) { hit.push('VIX ' + m.vix.close.toFixed(1) + ' >= ' + R.vixShock); date = m.vix.date; }
  }
  const c = m.qqq?.closes.filter(fin) ?? [];
  if (m.qqq && c.length > R.qqqDays && (c[c.length - 1 - R.qqqDays] as number) > 0) {
    const ch = (c[c.length - 1] as number) / (c[c.length - 1 - R.qqqDays] as number) - 1;
    bits.push('QQQ ' + pct(ch) + ' over ' + R.qqqDays + ' days (' + m.qqq.date + ')');
    if (ch <= R.qqqFall + 1e-12) { hit.push('QQQ ' + pct(ch) + ' in ' + R.qqqDays + ' days'); date = date ?? m.qqq.date; }
  }
  if (hit.length) return { id: 'MARKET', state: 'TRIGGERED', text: hit.join(' and '), source: src, date };
  const haveVix = !!(m.vix && fin(m.vix.close)), haveQqq = bits.length - (haveVix ? 1 : 0) > 0;
  if (!haveVix || !haveQqq) return { id: 'MARKET', state: 'UNKNOWN', text: (bits.length ? bits.join(', ') + '; ' : '') + 'not known: ' + [!haveVix ? 'VIX' : '', !haveQqq ? 'QQQ' : ''].filter(Boolean).join(' and ') + ' not available tonight', source: src, date: null };
  return { id: 'MARKET', state: 'CLEAR', text: bits.join(', ') + ': no shock', source: src, date: null };
}

// ── the book ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface HoldingAlerts {
  readonly ticker: string;
  readonly checks: readonly CheckResult[];
  readonly triggered: readonly CheckResult[];
  /** ALERT = at least one trigger; NONE = every check clear; UNKNOWN = no trigger and at least one check not known. */
  readonly status: 'ALERT' | 'NONE' | 'UNKNOWN';
  readonly historyFrom: string | null;
}

export interface BusinessAlertsResult {
  readonly mode: Exclude<BusinessAlertsMode, 'off'>;
  readonly today: string;
  readonly holdings: readonly HoldingAlerts[];
  readonly market: CheckResult;
  /** The new triggers ('TICKER|TRIGGER' key, line), in report order. */
  readonly fresh: ReadonlyArray<{ readonly key: string; readonly ticker: string; readonly check: CheckResult }>;
  /**
   * The Telegram lines to send: mode 'on', every active stock alert not sent within dedupeDays; both modes, the
   * market-shock buy point when not sent within marketDedupeTradingDays trading days.
   */
  readonly telegram: ReadonlyArray<{ readonly key: string; readonly line: string }>;
  /** The state after tonight (seen, SEC counts); `sent` is updated by markSent after a line is delivered. */
  readonly nextState: BusinessAlertState;
  /** The earliest stored fundamentals date over the book (null = none). */
  readonly historyFrom: string | null;
}

export interface EvaluateInput {
  readonly mode: Exclude<BusinessAlertsMode, 'off'>;
  readonly today: string;
  readonly holdings: readonly HoldingAlertInput[];
  readonly market: MarketInput;
  readonly state: BusinessAlertState | null;
}

const isFresh = (map: Readonly<Record<string, string>>, key: string, today: string): boolean => {
  const d = map[key];
  return !d || daysBetween(d, today) >= BUSINESS_ALERT_RULES.dedupeDays;
};

/** Trading days after `last` up to and including `today`: QQQ's own bars when given, else weekdays. */
export function tradingDaysAfter(last: string, today: string, dates?: readonly string[]): number {
  if (dates && dates.length) return dates.filter((d) => d > last && d <= today).length;
  let n = 0;
  for (let d = addDays(last, 1); d <= today; d = addDays(d, 1)) { const w = new Date(dayMs(d)).getUTCDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}

/** The market-shock buy point's ONE Telegram line (never an exit). */
export function marketBuyLine(c: CheckResult): string {
  return '🟢 ' + MARKET_BUY_POINT + ': ' + c.text + (c.date ? ' (' + c.date + ')' : '') + '. Not an exit.';
}

/** One line for the phone / the log. */
export function alertLineOf(ticker: string, c: CheckResult): string {
  return 'Business alert' + (ticker === MARKET_KEY ? '' : ' ' + ticker) + ': ' + TRIGGER_LABELS[c.id] + ': ' + c.text + ' (' + [c.source, c.date].filter(Boolean).join(', ') + '). Shadow: no verdict changed.';
}

function prune(m: Readonly<Record<string, string>>, today: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, d] of Object.entries(m)) if (daysBetween(d, today) <= BUSINESS_ALERT_RULES.stateKeepDays) out[k] = d;
  return out;
}

/** Pure: every check of every holding, the market check, what is new and the next state. */
export function evaluateBusinessAlerts(x: EvaluateInput): BusinessAlertsResult {
  const st = x.state ?? EMPTY_STATE;
  const seen = prune(st.seen, x.today);
  const secNew = prune(st.secNew, x.today);
  const sec: Record<string, { date: string; hits: Record<string, number> }> = {};
  for (const [t, s] of Object.entries(st.sec)) if (daysBetween(s.date, x.today) <= BUSINESS_ALERT_RULES.stateKeepDays) sec[t] = { date: s.date, hits: { ...s.hits } };
  const fresh: Array<{ key: string; ticker: string; check: CheckResult }> = [];
  const active: Array<{ key: string; ticker: string; check: CheckResult }> = [];
  const mark = (ticker: string, c: CheckResult): CheckResult => {
    if (c.state !== 'TRIGGERED') return c;
    const key = ticker + '|' + c.id;
    const isNew = isFresh(st.seen, key, x.today);
    if (isNew) { seen[key] = x.today; fresh.push({ key, ticker, check: { ...c, isNew } }); }
    active.push({ key, ticker, check: { ...c, isNew } });
    return { ...c, isNew };
  };
  const seenTickers = new Set<string>();
  const holdings: HoldingAlerts[] = [];
  for (const h of x.holdings) {
    const t = h.ticker.toUpperCase();
    if (seenTickers.has(t)) continue;
    seenTickers.add(t);
    const i = { ...h, ticker: t };
    const checks = [checkRevenue(i, x.today), checkMargin(i, x.today), checkRating(i, x.today), checkTarget(i, x.today), checkSecDilution(i, x.today, st), checkSecDistress(i, x.today, st)].map((c) => mark(t, c));
    const dil = checks.find((c) => c.id === 'SEC_DILUTION');
    if (dil && dil.state === 'TRIGGERED' && dil.date === x.today) secNew[t] = x.today;
    // Tonight's counts become the baseline (only the keywords SEC answered; an unanswered one keeps the old count).
    if (h.sec) {
      const prev = sec[t]?.hits ?? {};
      const hits: Record<string, number> = { ...prev };
      for (const [k, v] of Object.entries(h.sec.hits)) if (fin(v)) hits[k] = v;
      if (Object.keys(hits).length) sec[t] = { date: x.today, hits };
    }
    const triggered = checks.filter((c) => c.state === 'TRIGGERED');
    holdings.push({ ticker: t, checks, triggered, status: triggered.length ? 'ALERT' : checks.some((c) => c.state === 'UNKNOWN') ? 'UNKNOWN' : 'NONE', historyFrom: historyStartOf(h.history, x.today) });
  }
  const stockActive = active.slice();
  const market = mark(MARKET_KEY, checkMarket(x.market));
  // Telegram follows its own dedupe (`sent`, written only after a delivery): an alert first seen in shadow, or whose
  // line failed to send, still goes out once the mode is 'on'.
  const telegram = x.mode === 'on' ? stockActive.filter((f) => isFresh(st.sent, f.key, x.today)).map((f) => ({ key: f.key, line: alertLineOf(f.ticker, f.check) })) : [];
  // The market shock is a buy point: its line goes out in shadow and on, once per marketDedupeTradingDays trading days.
  const mKey = MARKET_KEY + '|MARKET', mLast = st.sent[mKey];
  if (market.state === 'TRIGGERED' && (!mLast || tradingDaysAfter(mLast, x.today, x.market.qqq?.dates) >= BUSINESS_ALERT_RULES.marketDedupeTradingDays)) {
    telegram.push({ key: mKey, line: marketBuyLine(market) });
  }
  const starts = holdings.map((h) => h.historyFrom).filter((d): d is string => d != null).sort();
  return {
    mode: x.mode, today: x.today, holdings, market, fresh, telegram,
    nextState: { v: 1, seen, sent: prune(st.sent, x.today), sec, secNew },
    historyFrom: starts[0] ?? null,
  };
}

/** The state after a Telegram line was delivered. */
export function markSent(s: BusinessAlertState, key: string, today: string): BusinessAlertState {
  return { ...s, sent: { ...s.sent, [key]: today } };
}

/** The stored state, or the empty one (a missing or unreadable value starts fresh). */
export function parseState(raw: string | null): BusinessAlertState {
  if (!raw) return EMPTY_STATE;
  const j = JSON.parse(raw) as Partial<BusinessAlertState> | null;
  if (!j || typeof j !== 'object' || j.v !== 1) return EMPTY_STATE;
  const obj = (o: unknown): Record<string, never> => (o && typeof o === 'object' && !Array.isArray(o) ? o as Record<string, never> : {});
  return { v: 1, seen: obj(j.seen), sent: obj(j.sent), sec: obj(j.sec), secNew: obj(j.secNew) };
}

// ── report view ───────────────────────────────────────────────────────────────────────────────────────────────────

/** What the Exit report shows (reports/exitSheet/types.ts). Plain sentences only. */
export type BusinessAlertsViewData = BusinessAlertsView;

const checkLine = (c: CheckResult): string => (c.id === 'MARKET' && c.state === 'TRIGGERED' ? MARKET_BUY_POINT : TRIGGER_LABELS[c.id]) + ': ' + c.text + ' (' + [c.source, c.date].filter(Boolean).join(', ') + ')' + (c.isNew ? ' NEW' : '');

export function businessAlertsView(r: BusinessAlertsResult): BusinessAlertsViewData {
  const R = BUSINESS_ALERT_RULES;
  const intro = [
    'For information only: these alerts do not change any verdict, score or buy rule in this report. ' + (r.mode === 'on' ? 'A new alert is also sent to Telegram (once per ' + R.dedupeDays + ' days per stock and alert).' : 'The stock alerts stay in this report (shadow: not sent to Telegram).')
      + ' A market shock is a buy point, never an exit: its one Telegram line goes out ' + (r.mode === 'on' ? '' : 'even in shadow, ') + 'once per ' + R.marketDedupeTradingDays + ' trading days.',
    'Alerts: revenue growth turns negative or is below ' + pct(R.revenueFloor, 0) + '; net margin down more than ' + R.marginDropPoints + ' points vs ' + R.lookbackDays + ' days ago; rating score worse by '
      + R.ratingStepsWorse + '+ step or the rating leaves Buy; analyst target cut ' + Math.round(R.targetCut * 100) + '%+ vs ' + R.lookbackDays + ' days ago; a new offering, dilution or convertible SEC filing hit; market: VIX '
      + R.vixShock + '+ or QQQ ' + pct(R.qqqFall, 0) + ' in ' + R.qqqDays + ' days. Missing data is "not known", never "clear".',
    r.historyFrom ? 'Fundamentals history on file from ' + r.historyFrom + ' (' + daysBetween(r.historyFrom, r.today) + ' days)'
      + (daysBetween(r.historyFrom, r.today) < R.lookbackDays ? '; the ' + R.lookbackDays + '-day checks stay "not known" until ' + addDays(r.historyFrom, R.lookbackDays) + '.' : '.')
      : 'No fundamentals history on file before tonight: the ' + R.lookbackDays + '-day checks are "not known" for now.',
  ];
  const holdings = r.holdings.map((h) => {
    const unknown = h.checks.filter((c) => c.state === 'UNKNOWN').map((c) => TRIGGER_LABELS[c.id]);
    const notKnown = unknown.length ? 'Not known: ' + unknown.join(', ') + '.' : '';
    if (h.triggered.length) return { ticker: h.ticker, alert: true, text: 'ALERT. ' + h.triggered.map(checkLine).join('. ') + '.' + (notKnown ? ' ' + notKnown : '') };
    return { ticker: h.ticker, alert: false, text: 'No alert.' + (notKnown ? ' ' + notKnown : '') };
  });
  return { mode: r.mode, intro, market: { alert: r.market.state === 'TRIGGERED', text: (r.market.state === 'TRIGGERED' ? 'BUY POINT. ' : r.market.state === 'UNKNOWN' ? 'Not known. ' : 'No alert. ') + checkLine(r.market) }, holdings };
}

/** The run-log lines: one per holding with a trigger, plus the market when it triggered, plus one count line. */
export function businessAlertsLogLines(r: BusinessAlertsResult): string[] {
  const out: string[] = [];
  for (const h of r.holdings) if (h.triggered.length) out.push('business alert (' + r.mode + '): ' + h.ticker + ': ' + h.triggered.map(checkLine).join('; '));
  if (r.market.state === 'TRIGGERED') out.push('market shock (buy point, never an exit): ' + checkLine(r.market));
  const n = (s: HoldingAlerts['status']): number => r.holdings.filter((h) => h.status === s).length;
  out.push('business alerts (' + r.mode + '): ' + n('ALERT') + ' with an alert, ' + n('NONE') + ' clear, ' + n('UNKNOWN') + ' partly not known; market ' + r.market.state.toLowerCase() + '; ' + r.fresh.length + ' new');
  return out;
}

// ── inputs from what the run already has ──────────────────────────────────────────────────────────────────────────

export function fundPointOf(r: FundamentalsRecord): FundPoint {
  return { date: r.date, revenueGrowth: r.revenueGrowth, profitMargin: r.profitMargin, analystTarget: r.analystTarget, ratingScore: r.ratingScore, rating: r.rating, source: r.source };
}

/** The stored history rows (header included) grouped by ticker, as points. */
export function historyByTicker(rows: readonly (readonly TabCell[])[]): Map<string, FundPoint[]> {
  const out = new Map<string, FundPoint[]>();
  for (let k = 1; k < rows.length; k++) {
    const rec = recordOfRow(rows[k]!);
    if (!rec.ticker || !rec.date) continue;
    const list = out.get(rec.ticker) ?? [];
    list.push(fundPointOf(rec));
    out.set(rec.ticker, list);
  }
  return out;
}

/** The SEC keyword counts the analysis' dilution screen kept (ind.filingKeywordScreen.hits), or null. */
export function secHitsOf(ind: unknown): SecHits | null {
  const s = (ind as { filingKeywordScreen?: { hits?: unknown } } | null | undefined)?.filingKeywordScreen;
  const h = s?.hits;
  if (!h || typeof h !== 'object') return null;
  const hits: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) hits[k] = fin(v) ? v : null;
  return { hits };
}

/** The mode a profile value names; anything else is 'off'. */
export function modeOf(v: unknown): BusinessAlertsMode {
  return (BUSINESS_ALERTS_MODES as readonly unknown[]).includes(v) ? v as BusinessAlertsMode : 'off';
}

// ── the nightly runner (I/O; never throws on a data problem) ──────────────────────────────────────────────────────

export interface BusinessAlertsRunDeps {
  readonly mode: Exclude<BusinessAlertsMode, 'off'>;
  /** 'YYYY-MM-DD', the night's date in the script zone. */
  readonly today: string;
  readonly timeZone: string;
  /** The book's companies: stock tickers and option underlyings (deduplicated here). */
  readonly tickers: readonly string[];
  /** Tonight's memoised analysis; null = none (must not start a new analysis). */
  readonly analysis: (ticker: string) => Promise<TickerArtifacts | null>;
  /** The '💾 Fundamentals History' rows, header included; null = no tab. */
  readonly readHistory: () => Promise<readonly (readonly TabCell[])[] | null>;
  readonly getChart: (ticker: string) => Promise<Chart | null | undefined>;
  readonly kv: PropertyStore;
  /** null = no Telegram configured. Shadow sends only the market-shock buy point; on also the stock alerts. */
  readonly telegram: TelegramTarget | null;
  readonly log: Logger;
}

const lastClose = (c: Chart | null | undefined, tz: string): { close: number; date: string; closes: readonly number[]; dates: readonly string[] } | null => {
  if (!c || !c.closes.length) return null;
  const close = c.closes[c.closes.length - 1];
  const d = c.dates[c.dates.length - 1];
  return fin(close) && d ? { close, date: formatDateInTz(d, tz), closes: c.closes, dates: c.dates.slice(-40).map((x) => formatDateInTz(x, tz)) } : null;
};

export async function runBusinessAlerts(d: BusinessAlertsRunDeps): Promise<{ readonly view: BusinessAlertsViewData; readonly result: BusinessAlertsResult }> {
  const log = d.log;
  const rows = await orElseAsync(log, 'business alerts: fundamentals history read (the 90-day checks are not known tonight)', d.readHistory, null);
  const hist = rows ? historyByTicker(rows) : new Map<string, FundPoint[]>();
  const holdings: HoldingAlertInput[] = [];
  for (const t of [...new Set(d.tickers.map((x) => x.toUpperCase()))]) {
    const a = await d.analysis(t).catch((e: unknown) => { log.warning('business alerts: no analysis for ' + t + ' (its checks are not known)', { detail: String(e) }); return null; });
    const rec = a && !a.aborted ? fundamentalsRecordOf(a, d.today) : null;
    holdings.push({ ticker: t, history: hist.get(t) ?? [], latest: rec ? fundPointOf(rec) : null, sec: a && !a.aborted ? secHitsOf(a.ind) : null });
  }
  const chart = (t: string): Promise<Chart | null | undefined> => d.getChart(t).catch((e: unknown) => { log.warning('business alerts: ' + t + ' chart not available (the market check is not known)', { detail: String(e) }); return null; });
  const vix = lastClose(await chart('^VIX'), d.timeZone);
  const qqq = lastClose(await chart('QQQ'), d.timeZone);
  const raw = await orElseAsync(log, 'business alerts: stored state read (starting fresh)', () => d.kv.get(BUSINESS_ALERTS_STATE_KEY), null);
  const state = orElse(log, 'business alerts: stored state parse (starting fresh)', () => parseState(raw), EMPTY_STATE);
  const result = evaluateBusinessAlerts({
    mode: d.mode, today: d.today, holdings, state,
    market: { vix: vix ? { close: vix.close, date: vix.date } : null, qqq: qqq ? { closes: qqq.closes, date: qqq.date, dates: qqq.dates } : null },
  });
  for (const l of businessAlertsLogLines(result)) log.info(l);
  let next = result.nextState;
  for (const m of result.telegram) {
    if (await notifyIfNeeded(d.telegram, m.line, (x) => log.warning(x))) next = markSent(next, m.key, d.today);
  }
  // Written only when something changed (an empty state is never stored).
  const json = JSON.stringify(next);
  if (json !== (raw ?? JSON.stringify(EMPTY_STATE))) {
    await orElseAsync(log, 'business alerts: stored state write (tomorrow may repeat tonight\'s new alerts)', () => d.kv.set(BUSINESS_ALERTS_STATE_KEY, json), undefined);
  }
  return { view: businessAlertsView(result), result };
}
