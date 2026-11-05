/**
 * Owner complaint 2026-11-05 ("EXIT on 13 of 15 holdings -- total bullshit") and the owner rules of the same day.
 * Behind the profile flag `exit.weeklyStops` (built default OFF). Pure: chart in, numbers and plain sentences out.
 *
 * The owner swing-trades weeks to years and pays 25% tax on a gain, so an exit reads the WEEKLY chart and needs high
 * conviction of a LARGE further fall:
 *
 *   1. Stale breach. The old daily stop (highest high since entry - 3 daily ATR) first broken more than 10 trading
 *      days ago, price never back above it, is an OLD signal, not a fresh EXIT: "stop broken on <date>, -X% since".
 *   2. Weekly stop = highest weekly CLOSE of the last 26 complete weeks (or since the entry week, when more recent)
 *      - 3 x weekly ATR(14). Breach = a complete weekly close below it.
 *   3. EXIT only when ALL hold (rule A): (1) weekly trend broken = weekly close below the weekly stop AND below the
 *      40-week average; (2) downside to the next major weekly support >= 30% of the price; (3) fundamentals not
 *      strong (the engine's own fundamental score below its own-worthy bar of 70; unknown = not confirmed).
 *      Rule B (tax): a position in profit pays 25% of the gain when sold, so the downside must also exceed the tax
 *      cost (as % of the position) + 10 points.
 *   4. Targets coherent: T1 > price, T2 > T1, never a target at or below the stop, nothing above 3x the price
 *      (falls back to the next resistance); no valid target = null ("no valid target").
 *   5. TRIM only at a reached target worth >= +25% over the cost after the tax (rule C).
 */

import type { Chart } from '../types/chart.ts';
import { wilderArray } from './series.ts';
import { voteShortfall, type VoteSummary } from './exitVote.ts';

export const WEEKLY_STOPS = {
  /** Rule 1: a breach older than this many trading days is stale. */
  staleTradingDays: 10,
  /** Rule 2: the weekly chandelier anchor window (complete weeks) and the ATR multiple / period. */
  anchorWeeks: 26, atrMult: 3, atrWeeks: 14,
  /** Rule A1: the weekly trend average. */
  trendWeeks: 40,
  /** Rule A2: a weekly swing low needs this many weeks on each side; looked for over this many weeks. */
  supportSwingWeeks: 6, supportLookbackWeeks: 260,
  minDownsidePct: 30,
  /** Rule A3: the fundamental score's own-worthy bar (analysis/fundamentalScore.ts verdict). */
  ownWorthyScore: 70,
  /** Rule B: the downside must beat the tax cost by this many points. */
  taxMarginPts: 10,
  /** Rule C: the after-tax gain over the cost a target must give before a trim. */
  trimMinAfterTaxGainPct: 25,
  /** Targets: nothing above this multiple of the price; T1 at least this far above the price. */
  maxTargetMult: 3, minTargetGapPct: 2,
  /** Options: a call with more than this many days left follows the weekly stop. */
  optionWeeklyDays: 180,
} as const;

const DAY_MS = 86_400_000;
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
const mondayOf = (day: string): string => {
  const t = Date.parse(day + 'T00:00:00Z');
  const dow = new Date(t).getUTCDay();
  return new Date(t - ((dow + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
};
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const usd = (n: number): string => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n: number): string => n.toFixed(1) + '%';
const dayText = (day: string): string => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(day + 'T00:00:00Z'));

// ── weekly bars ────────────────────────────────────────────────────────

export interface WeeklyOhlc { readonly weekOf: string; readonly lastDay: string; readonly high: number; readonly low: number; readonly close: number; readonly firstIdx: number; readonly lastIdx: number }

/**
 * Monday-Friday weekly bars (UTC session date, the same rule as options/weeklyExit.ts). `complete` drops the last
 * week unless it ended on a Friday or `nowMs` is already past that week.
 */
export function weeklyOhlc(chart: Pick<Chart, 'dates' | 'highs' | 'lows' | 'closes'>, nowMs?: number): { bars: WeeklyOhlc[]; lastPartial: boolean } {
  const bars: WeeklyOhlc[] = [];
  const n = Math.min(chart.dates.length, chart.closes.length);
  for (let i = 0; i < n; i++) {
    const c = chart.closes[i], h = chart.highs[i], l = chart.lows[i], d = chart.dates[i];
    if (!fin(c) || !d) continue;
    const day = isoDay(new Date(d)), wk = mondayOf(day), last = bars[bars.length - 1];
    const hi = fin(h) ? h : c, lo = fin(l) ? l : c;
    if (last && last.weekOf === wk) bars[bars.length - 1] = { ...last, lastDay: day, high: Math.max(last.high, hi), low: Math.min(last.low, lo), close: c, lastIdx: i };
    else bars.push({ weekOf: wk, lastDay: day, high: hi, low: lo, close: c, firstIdx: i, lastIdx: i });
  }
  const last = bars[bars.length - 1];
  let lastPartial = false;
  if (last && new Date(last.lastDay + 'T00:00:00Z').getUTCDay() !== 5) {
    lastPartial = nowMs == null ? false : Date.parse(last.weekOf + 'T00:00:00Z') + 5 * DAY_MS > nowMs;
  }
  return { bars: lastPartial ? bars.slice(0, -1) : bars, lastPartial };
}

// ── rule 1: the old daily stop and when it was first broken ───────────

export interface StaleBreach {
  /** The old stop today (highest high since entry - 3 daily ATR). */
  readonly oldStop: number;
  readonly breached: boolean;
  /** First day of the current unbroken run of closes below the (running) old stop; null when not breached. */
  readonly firstBrokenDay: string | null;
  readonly tradingDaysSince: number | null;
  /** Price change since the close of the first broken day, %. */
  readonly changeSincePct: number | null;
  readonly stale: boolean;
}

export function oldStopBreach(chart: Pick<Chart, 'dates' | 'highs' | 'lows' | 'closes'>, entryIdx: number): StaleBreach | null {
  const { highs, lows, closes, dates } = chart;
  const n = closes.length;
  if (n < 20 || entryIdx < 0 || entryIdx >= n) return null;
  const tr: number[] = [];
  for (let i = 1; i < n; i++) tr.push(Math.max(highs[i]! - lows[i]!, Math.abs(highs[i]! - closes[i - 1]!), Math.abs(lows[i]! - closes[i - 1]!)));
  const atr = wilderArray(tr, 14); // atr[k] is the ATR on bar k + 14
  const atrAt = (i: number): number | null => (i - 14 >= 0 && i - 14 < atr.length ? atr[i - 14]! : null);
  const stops: Array<number | null> = new Array(n).fill(null);
  let hh = -Infinity;
  for (let i = entryIdx; i < n; i++) {
    hh = Math.max(hh, highs[i]!);
    const a = atrAt(i);
    stops[i] = a == null ? null : hh - WEEKLY_STOPS.atrMult * a;
  }
  const oldStop = stops[n - 1];
  if (oldStop == null) return null;
  const below = (i: number): boolean => stops[i] != null && closes[i]! < (stops[i] as number);
  if (!below(n - 1)) return { oldStop, breached: false, firstBrokenDay: null, tradingDaysSince: null, changeSincePct: null, stale: false };
  let j = n - 1;
  while (j - 1 >= entryIdx && below(j - 1)) j--;
  const since = n - 1 - j;
  return {
    oldStop, breached: true, firstBrokenDay: isoDay(new Date(dates[j]!)), tradingDaysSince: since,
    changeSincePct: (closes[n - 1]! / closes[j]! - 1) * 100, stale: since > WEEKLY_STOPS.staleTradingDays,
  };
}

/** "old stop $514.74 broken on Nov 18, 2024, -73.7% since (old signal)". */
export function staleBreachText(b: StaleBreach): string {
  return 'old stop ' + usd(b.oldStop) + ' broken on ' + dayText(b.firstBrokenDay as string) + ', ' + ((b.changeSincePct as number) >= 0 ? '+' : '−') + pct(Math.abs(b.changeSincePct as number)) + ' since (old signal)';
}

// ── rule 2 / A1 / A2: the weekly read ─────────────────────────────────

export interface WeeklyRead {
  readonly weekClose: number;
  readonly weekDay: string;
  readonly stop: number;
  readonly anchorClose: number;
  readonly weeklyAtr: number;
  readonly breached: boolean;
  readonly ma40: number | null;
  readonly belowMa40: boolean;
  /** A1: weekly close below the weekly stop AND below the 40-week average. */
  readonly trendBroken: boolean;
  readonly support: number | null;
  readonly supportWeek: string | null;
  /** % fall from the price to the support (positive); null when no support below. */
  readonly downsidePct: number | null;
}

export function weeklyRead(chart: Pick<Chart, 'dates' | 'highs' | 'lows' | 'closes'>, opts: { readonly entryDay?: string | null; readonly nowMs?: number; readonly price?: number } = {}): WeeklyRead | null {
  const { bars } = weeklyOhlc(chart, opts.nowMs);
  if (bars.length < WEEKLY_STOPS.atrWeeks + 2) return null;
  const tr: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!, p = bars[i - 1]!;
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
  }
  const atrs = wilderArray(tr, WEEKLY_STOPS.atrWeeks);
  const weeklyAtr = atrs[atrs.length - 1];
  if (!fin(weeklyAtr)) return null;
  const last = bars[bars.length - 1]!;
  let from = Math.max(0, bars.length - WEEKLY_STOPS.anchorWeeks);
  if (opts.entryDay) {
    const ew = mondayOf(opts.entryDay);
    const ei = bars.findIndex((b) => b.weekOf >= ew);
    if (ei > from) from = ei;
  }
  const anchorClose = Math.max(...bars.slice(from).map((b) => b.close));
  const stop = anchorClose - WEEKLY_STOPS.atrMult * weeklyAtr;
  const closes = bars.map((b) => b.close);
  const ma40 = closes.length >= WEEKLY_STOPS.trendWeeks ? closes.slice(-WEEKLY_STOPS.trendWeeks).reduce((a, b) => a + b, 0) / WEEKLY_STOPS.trendWeeks : null;
  const breached = last.close < stop;
  const belowMa40 = ma40 != null && last.close < ma40;
  const price = fin(opts.price) ? opts.price : chart.closes[chart.closes.length - 1]!;
  const sup = majorWeeklySupport(bars, price);
  return {
    weekClose: last.close, weekDay: last.lastDay, stop, anchorClose, weeklyAtr, breached, ma40, belowMa40,
    trendBroken: breached && belowMa40,
    support: sup ? sup.price : null, supportWeek: sup ? sup.weekOf : null,
    downsidePct: sup ? ((price - sup.price) / price) * 100 : null,
  };
}

/** The nearest confirmed weekly swing low below the price over the last 5 years (6 weeks lower on each side). */
export function majorWeeklySupport(bars: readonly WeeklyOhlc[], price: number): { price: number; weekOf: string } | null {
  const w = WEEKLY_STOPS.supportSwingWeeks;
  const start = Math.max(w, bars.length - WEEKLY_STOPS.supportLookbackWeeks);
  let best: { price: number; weekOf: string } | null = null;
  for (let i = start; i < bars.length - w; i++) {
    const lo = bars[i]!.low;
    if (!(lo < price)) continue;
    let ok = true;
    for (let k = i - w; k <= i + w && ok; k++) if (k !== i && bars[k]!.low < lo) ok = false;
    if (ok && (!best || lo > best.price)) best = { price: lo, weekOf: bars[i]!.weekOf };
  }
  return best;
}

// ── rule 4: coherent targets ──────────────────────────────────────────

export interface CoherentTargets {
  readonly t1: number | null;
  readonly t2: number | null;
  /** Plain note when a target was replaced or dropped; null when the engine's targets were kept. */
  readonly note: string | null;
}

/**
 * T1 > price (by at least 2%), T2 > T1 (by at least 5%), both above the stop, neither above 3x the price. The engine's
 * own T1/T2 are kept when they pass; otherwise the next valid candidate (the engine's exit-method levels, the prior
 * weekly highs) takes the place.
 */
export function coherentTargets(price: number, stop: number | null, t1: number | null, t2: number | null, candidates: readonly number[]): CoherentTargets {
  const lo = Math.max(price * (1 + WEEKLY_STOPS.minTargetGapPct / 100), stop != null ? stop * 1.0001 : -Infinity);
  const hi = price * WEEKLY_STOPS.maxTargetMult;
  const ok = (x: number | null | undefined): x is number => fin(x) && x >= lo && x <= hi;
  const seen = new Set<number>();
  const pool = [t1, t2, ...candidates].filter(ok).sort((a, b) => a - b).filter((x) => { const k = Math.round(x * 100); if (seen.has(k)) return false; seen.add(k); return true; });
  const n1 = ok(t1) ? t1 : (pool[0] ?? null);
  const n2 = n1 == null ? null : (ok(t2) && t2 > n1 * 1.05 ? t2 : (pool.find((x) => x > n1 * 1.05) ?? null));
  const changes: string[] = [];
  if (n1 !== t1) changes.push(t1 == null ? 'no engine T1' : 'engine T1 ' + usd(t1) + (t1 <= price ? ' is not above the price' : stop != null && t1 <= stop ? ' is below the stop' : ' is not usable'));
  if (n2 !== t2) changes.push(t2 == null ? 'no engine T2' : 'engine T2 ' + usd(t2) + (n1 != null && Math.abs(t2 - n1) < 0.005 ? ' is used as T1' : t2 > hi ? ' is more than 3x the price' : t2 <= price ? ' is not above the price' : stop != null && t2 <= stop ? ' is below the stop' : ' is not above T1'));
  return { t1: n1, t2: n2, note: changes.length ? 'Targets checked: ' + changes.join('; ') + (n1 == null ? '; no valid target.' : '; the next resistance is used.') : null };
}

// ── rules A/B/C: the decision ─────────────────────────────────────────

export type WeeklyAction = 'EXIT' | 'REVIEW' | 'TRIM' | 'HOLD';

export interface WeeklyDecisionInput {
  readonly price: number;
  readonly weekly: WeeklyRead | null;
  readonly stale: StaleBreach | null;
  /** The daily technical read is AVOID (the old "technical read negative"). */
  readonly dailyNegative: boolean;
  /** The engine's own fundamental score (0-100); null = unknown (an ETF, or not loaded). */
  readonly fundScore: number | null;
  /** Average cost per unit (share); null = unknown. Options pass null (no tax gate on the underlying). */
  readonly cost: number | null;
  readonly taxRate: number;
  /** The engine's T1/T2 (before the coherence check) and whether the price is at or above them. */
  readonly reachedTarget: number | null;
  readonly targets: CoherentTargets;
  /** The model vote (exitVote.ts); absent = rules A-C only. */
  readonly vote?: VoteSummary | null;
}

export interface WeeklyDecision {
  readonly action: WeeklyAction;
  /** Plain-English headline, starting with Exit: / Review: / Consider trimming: / Hold:. */
  readonly headline: string;
  /** One line per rule, for the report. */
  readonly lines: readonly string[];
  readonly taxCostUsdPerUnit: number | null;
  readonly taxCostPct: number | null;
  /** T1 passes rule C (>= +25% after tax over the cost). */
  readonly t1WorthTrimming: boolean | null;
}

export function afterTaxGainPct(target: number, cost: number, taxRate: number): number {
  const g = (target - cost) / cost;
  return (g > 0 ? g * (1 - taxRate) : g) * 100;
}

/**
 * Rules A-C, then the model vote (exitVote.ts, owner 2026-11-05 "take into account ALL the models"): an EXIT also
 * needs the vote's bar; when the vote is short the EXIT becomes a REVIEW. A clear sell vote with an intact weekly
 * trend is a REVIEW, never an EXIT. Every headline ends with the vote count.
 */
export function decideWeekly(i: WeeklyDecisionInput): WeeklyDecision {
  const d = decideRules(i);
  const v = i.vote;
  if (!v) return d;
  const body = d.headline.replace(/^(Exit|Review|Hold|Consider trimming): /, '');
  const voteTxt = ' Model vote: ' + v.text + '.';
  const lines = ['Model vote: ' + v.text + (v.majority ? ' — the exit bar (2/3 with a read, the engine and a trend model) is met.' : ' — the exit bar is not met: ' + voteShortfall(v) + '.'), ...d.lines];
  if (d.action === 'EXIT' && !v.majority) {
    return { ...d, lines, action: 'REVIEW', headline: 'Review: the exit rules point to an exit (' + body.replace(/\.$/, '') + '), but the models do not agree: ' + v.text + ' — ' + voteShortfall(v) + '.' };
  }
  if (d.action === 'HOLD' && v.majority) return { ...d, lines, action: 'REVIEW', headline: 'Review: most models say sell (' + v.text + '), but not an exit: ' + body };
  return { ...d, lines, headline: d.headline + voteTxt };
}

function decideRules(i: WeeklyDecisionInput): WeeklyDecision {
  const lines: string[] = [];
  const w = i.weekly;
  const staleTxt = i.stale && i.stale.breached && i.stale.stale ? staleBreachText(i.stale) : null;
  if (staleTxt) lines.push('Old daily stop: ' + staleTxt + '; the stop is re-anchored to the weekly chart.');
  else if (i.stale && i.stale.breached) lines.push('Daily stop ' + usd(i.stale.oldStop) + ' broken on ' + dayText(i.stale.firstBrokenDay as string) + ' (' + i.stale.tradingDaysSince + ' trading days ago, a fresh break); the exit decision reads the weekly chart.');
  if (w) {
    lines.push('Weekly stop ' + usd(w.stop) + ' (highest weekly close ' + usd(w.anchorClose) + ' − 3 × weekly ATR ' + usd(w.weeklyAtr) + '); week to ' + dayText(w.weekDay) + ' closed ' + usd(w.weekClose) + (w.breached ? ' — below it' : ' — above it') + '.');
    lines.push('40-week average ' + (w.ma40 == null ? 'not available' : usd(w.ma40) + (w.belowMa40 ? ' — weekly close below it' : ' — weekly close above it')) + '.');
    lines.push(w.support == null ? 'Next major weekly support: none below the price in 5 years, so the downside cannot be measured.'
      : 'Next major weekly support ' + usd(w.support) + ' (week of ' + dayText(w.supportWeek as string) + '), ' + pct(w.downsidePct as number) + ' below the price.');
  } else lines.push('Weekly read not available (too little weekly history).');
  lines.push(i.fundScore == null ? 'Fundamental score: not available, so "fundamentals not strong" cannot be confirmed.'
    : 'Fundamental score ' + i.fundScore + (i.fundScore >= WEEKLY_STOPS.ownWorthyScore ? ' — own-worthy (70+), strong.' : ' — below the own-worthy bar of 70.'));
  let taxCostUsdPerUnit: number | null = null, taxCostPct: number | null = null;
  if (i.cost != null && i.cost > 0) {
    const gain = i.price - i.cost;
    if (gain > 0) {
      taxCostUsdPerUnit = i.taxRate * gain;
      taxCostPct = (taxCostUsdPerUnit / i.price) * 100;
      lines.push('Tax cost if sold now: ' + usd(taxCostUsdPerUnit) + ' per share (' + pct(taxCostPct) + ' of the position, ' + Math.round(i.taxRate * 100) + '% of the gain).');
    } else {
      taxCostPct = 0;
      lines.push('In a loss (' + pct(((i.price - i.cost) / i.cost) * 100) + '): no tax cost if sold; the loss may offset other gains (tax-loss benefit).');
    }
  }
  if (i.targets.note) lines.push(i.targets.note);
  let t1WorthTrimming: boolean | null = null;
  if (i.cost != null && i.cost > 0 && i.targets.t1 != null) {
    const g = afterTaxGainPct(i.targets.t1, i.cost, i.taxRate);
    t1WorthTrimming = g >= WEEKLY_STOPS.trimMinAfterTaxGainPct;
    if (!t1WorthTrimming) lines.push('T1 ' + usd(i.targets.t1) + ' is only ' + (g >= 0 ? '+' : '') + pct(g) + ' over your cost after tax (a trim needs +' + WEEKLY_STOPS.trimMinAfterTaxGainPct + '%): no sale planned at T1.');
  }

  const a1 = !!w && w.trendBroken;
  const a2 = !!w && w.downsidePct != null && w.downsidePct >= WEEKLY_STOPS.minDownsidePct;
  const a3 = i.fundScore != null && i.fundScore < WEEKLY_STOPS.ownWorthyScore;
  const b = a2 && (taxCostPct == null || (w!.downsidePct as number) > taxCostPct + WEEKLY_STOPS.taxMarginPts);
  const tail = staleTxt ? ' (' + staleTxt + '.)' : '';
  const base = { lines, taxCostUsdPerUnit, taxCostPct, t1WorthTrimming };
  if (a1 && a2 && a3 && b) {
    return { ...base, action: 'EXIT', headline: 'Exit: the weekly trend is broken (weekly close ' + usd(w!.weekClose) + ' below the weekly stop ' + usd(w!.stop) + ' and the 40-week average), the next major weekly support is ' + pct(w!.downsidePct as number) + ' lower, and the fundamentals are not strong' + (taxCostPct ? '; the expected fall beats the ' + pct(taxCostPct) + ' tax cost' : '') + '.' };
  }
  if (a1) {
    const missing: string[] = [];
    if (!a2) missing.push(w!.downsidePct == null ? 'no measurable downside to a weekly support' : 'the next weekly support is only ' + pct(w!.downsidePct) + ' lower (an exit needs 30%+)');
    if (!a3) missing.push(i.fundScore == null ? 'the fundamentals cannot be confirmed weak' : 'the fundamentals are strong (score ' + i.fundScore + ')');
    if (a2 && !b) missing.push('the expected fall does not beat the tax cost (' + pct(taxCostPct ?? 0) + ') + 10 points');
    return { ...base, action: 'REVIEW', headline: 'Review: the weekly trend is broken (weekly close ' + usd(w!.weekClose) + ' below the weekly stop ' + usd(w!.stop) + ' and the 40-week average), but not an exit: ' + missing.join('; ') + '.' + tail };
  }
  if (w && w.breached && w.ma40 == null) {
    return { ...base, action: 'REVIEW', headline: 'Review: the weekly close ' + usd(w.weekClose) + ' is below the weekly stop ' + usd(w.stop) + ', but there is too little history for the 40-week average, so the weekly trend break cannot be confirmed; not an exit.' + tail };
  }
  if (i.stale && i.stale.breached && !i.stale.stale) {
    return { ...base, action: 'REVIEW', headline: 'Review: the daily stop ' + usd(i.stale.oldStop) + ' broke ' + i.stale.tradingDaysSince + ' trading days ago, but the weekly trend is not broken' + (w ? ' (weekly stop ' + usd(w.stop) + ')' : '') + '; not an exit.' };
  }
  if (i.reachedTarget != null) {
    const g = i.cost != null && i.cost > 0 ? afterTaxGainPct(i.reachedTarget, i.cost, i.taxRate) : null;
    if (g != null && g >= WEEKLY_STOPS.trimMinAfterTaxGainPct) return { ...base, action: 'TRIM', headline: 'Consider trimming: the price reached the target ' + usd(i.reachedTarget) + ', +' + pct(g) + ' over your cost after tax.' + tail };
    const why = g == null ? 'the cost basis is missing, so the after-tax gain cannot be checked' : 'it is only ' + (g >= 0 ? '+' : '') + pct(g) + ' over your cost after tax (a trim needs +25%)';
    return { ...base, action: 'HOLD', headline: 'Hold: the target ' + usd(i.reachedTarget) + ' was reached, but ' + why + '.' + tail };
  }
  const notes: string[] = [];
  if (i.dailyNegative) notes.push('the daily technical read is negative, but the weekly trend is intact');
  const wTxt = !w ? '' : w.breached ? ' (weekly close ' + usd(w.weekClose) + ' is below the weekly stop ' + usd(w.stop) + ' but above the 40-week average' + (w.ma40 != null ? ' ' + usd(w.ma40) : '') + ')'
    : ' (weekly close ' + usd(w.weekClose) + ' above the weekly stop ' + usd(w.stop) + ')';
  return { ...base, action: 'HOLD', headline: 'Hold: the weekly trend is intact' + wTxt + (notes.length ? '; ' + notes.join('; ') : '') + '.' + tail };
}
