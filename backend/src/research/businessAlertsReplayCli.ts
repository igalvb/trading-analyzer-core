/**
 * History check of the business-based exit alerts (jobs/exit/businessAlerts.ts; owner build 2026-11-07). Replays the
 * SAME check functions over whatever history exists and prints every trigger with the stock's next 3 / 6 / 12-month
 * return and QQQ's over the same days (markdown, stdout). Research only: nothing here is read by a report or a rule.
 *
 *   node src/research/businessAlertsReplayCli.ts --prices DIR [--series FILE] [--fund-history FILE] [--book T1,T2,...]
 *
 *   --prices DIR         price files <TICKER>.json ({ dates: ['YYYY-MM-DD'], closes }), QQQ.json and _VIX.json required
 *   --series FILE        quarterly series by ticker ({ T: { netMargin: [{ period, v }], salesPerShare: [...] } }, the
 *                        Finnhub /stock/metric `series.quarterly` shape) -> triggers (1) and (2), point in time = the
 *                        quarter end + FILING_LAG_DAYS; TTM revenue growth and TTM net margin (closest to the live fields)
 *   --fund-history FILE  the '💾 Fundamentals History' tab as TSV (header row first) -> triggers (1)-(3) as stored
 *   --book               tickers whose average forward return is shown next to QQQ for each market-shock day (5)
 *
 * Forward windows: 63 / 126 / 252 trading days from the first close on or after the trigger day ("3 / 6 / 12 months").
 * No look-ahead: each trigger uses only data dated on or before its day.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  BUSINESS_ALERT_RULES, EMPTY_STATE, addDays, checkMargin, checkRating, checkRevenue, checkTarget, evaluateBusinessAlerts, historyByTicker,
  type BusinessAlertState, type CheckResult, type FundPoint,
} from '../jobs/exit/businessAlerts.ts';

export const FILING_LAG_DAYS = 45;
export const FORWARD_DAYS = [63, 126, 252] as const;

export interface Series { readonly dates: readonly string[]; readonly closes: readonly number[] }
interface QPoint { readonly period: string; readonly v: number }

/** The first index whose date is on or after `day`; -1 when none. */
export function indexOnOrAfter(s: Series, day: string): number {
  let lo = 0, hi = s.dates.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if ((s.dates[mid] as string) < day) lo = mid + 1; else hi = mid; }
  return lo < s.dates.length ? lo : -1;
}

/** Forward return over n trading days from the first close on/after `day`; null when the series ends first. */
export function forward(s: Series | undefined, day: string, n: number): number | null {
  // A day before the series starts (the stock did not trade yet, or the file starts later) has no forward return.
  if (!s || !s.dates.length || day < (s.dates[0] as string)) return null;
  const i = indexOnOrAfter(s, day);
  if (i < 0 || i + n >= s.closes.length) return null;
  const a = s.closes[i] as number, b = s.closes[i + n] as number;
  return a > 0 && b > 0 ? b / a - 1 : null;
}

/**
 * Point-in-time fundamentals from a quarterly series: for each quarter with 8 quarters on file, TTM revenue growth
 * (sum of the last 4 quarters' sales per share vs the 4 before) and TTM net margin (sales-weighted), dated the quarter
 * end + FILING_LAG_DAYS. Sales per share stands in for revenue (a share-count change moves it too).
 */
export function pointsFromQuarterly(q: { netMargin?: QPoint[]; salesPerShare?: QPoint[] }, source: string): FundPoint[] {
  const sps = new Map((q.salesPerShare ?? []).map((p) => [p.period, p.v]));
  const nm = new Map((q.netMargin ?? []).map((p) => [p.period, p.v]));
  const periods = [...sps.keys()].sort();
  const out: FundPoint[] = [];
  for (let k = 7; k < periods.length; k++) {
    const last4 = periods.slice(k - 3, k + 1), prev4 = periods.slice(k - 7, k - 3);
    const s4 = last4.map((p) => sps.get(p) as number), p4 = prev4.map((p) => sps.get(p) as number);
    if ([...s4, ...p4].some((v) => !Number.isFinite(v))) continue;
    const ttm = s4.reduce((a, b) => a + b, 0), ttmPrev = p4.reduce((a, b) => a + b, 0);
    const margins = last4.map((p) => nm.get(p));
    const margin = margins.every((m) => typeof m === 'number' && Number.isFinite(m)) && ttm > 0 ? last4.reduce((a, p, j) => a + (margins[j] as number) * (s4[j] as number), 0) / ttm : null;
    out.push({
      date: addDays(periods[k] as string, FILING_LAG_DAYS),
      revenueGrowth: ttmPrev > 0 ? ttm / ttmPrev - 1 : null,
      profitMargin: margin,
      analystTarget: null, ratingScore: null, rating: null, source: source + ' quarter ending ' + periods[k],
    });
  }
  return out;
}

export interface ReplayEvent {
  readonly ticker: string;
  readonly day: string;
  readonly check: CheckResult;
  /** The same trigger also fired on the previous evaluation of this ticker (a continuing condition, not an onset). */
  readonly repeat: boolean;
  readonly fwd: readonly (number | null)[];
  readonly qqq: readonly (number | null)[];
}

/** Replays checks (1)-(3) on every point of a ticker (each point is "tonight", the earlier points the stored history). */
export function replayFundamentals(ticker: string, points: readonly FundPoint[], prices: Series | undefined, qqq: Series): ReplayEvent[] {
  const pts = [...points].sort((a, b) => (a.date < b.date ? -1 : 1));
  const out: ReplayEvent[] = [];
  const last = new Map<string, boolean>();
  for (let k = 0; k < pts.length; k++) {
    const today = pts[k]!.date;
    const input = { ticker, history: pts.slice(0, k), latest: pts[k]!, sec: null };
    for (const c of [checkRevenue(input, today), checkMargin(input, today), checkRating(input, today), checkTarget(input, today)]) {
      const fired = c.state === 'TRIGGERED';
      if (fired) out.push({ ticker, day: today, check: c, repeat: last.get(c.id) === true, fwd: FORWARD_DAYS.map((n) => forward(prices, today, n)), qqq: FORWARD_DAYS.map((n) => forward(qqq, today, n)) });
      if (c.state !== 'UNKNOWN') last.set(c.id, fired);
    }
  }
  return out;
}

/** Replays the market check (5) on every trading day, with the live 30-day dedupe (only NEW alerts are listed). */
export function replayMarket(vix: Series, qqq: Series, book: ReadonlyMap<string, Series>): Array<{ day: string; check: CheckResult; qqq: (number | null)[]; book: (number | null)[]; bookN: number[] }> {
  const R = BUSINESS_ALERT_RULES;
  let state: BusinessAlertState = EMPTY_STATE;
  const out: Array<{ day: string; check: CheckResult; qqq: (number | null)[]; book: (number | null)[]; bookN: number[] }> = [];
  for (let i = R.qqqDays; i < qqq.dates.length; i++) {
    const day = qqq.dates[i] as string;
    const vi = indexOnOrAfter(vix, day);
    const v = vi >= 0 && vix.dates[vi] === day ? { close: vix.closes[vi] as number, date: day } : null;
    const r = evaluateBusinessAlerts({ mode: 'shadow', today: day, holdings: [], state, market: { vix: v, qqq: { closes: qqq.closes.slice(i - R.qqqDays, i + 1), date: day } } });
    state = r.nextState;
    if (!r.fresh.length) continue;
    const bookFwd = FORWARD_DAYS.map((n) => { const xs = [...book.values()].map((s) => forward(s, day, n)).filter((x): x is number => x != null); return xs.length ? { m: xs.reduce((a, b) => a + b, 0) / xs.length, n: xs.length } : null; });
    out.push({ day, check: r.market, qqq: FORWARD_DAYS.map((n) => forward(qqq, day, n)), book: bookFwd.map((b) => (b ? b.m : null)), bookN: bookFwd.map((b) => (b ? b.n : 0)) });
  }
  return out;
}


const pc = (x: number | null): string => (x == null ? 'n/a' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%');
const ex = (a: number | null, b: number | null): string => (a == null || b == null ? 'n/a' : pc(a - b));

function readSeries(dir: string, t: string): Series | undefined {
  const f = path.join(dir, t.replace('^', '_') + '.json');
  if (!fs.existsSync(f)) return undefined;
  const j = JSON.parse(fs.readFileSync(f, 'utf8')) as { dates: string[]; closes: number[] };
  return { dates: j.dates.map((d) => String(d).slice(0, 10)), closes: j.closes };
}

function arg(name: string): string | undefined { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; }

function summary(evs: readonly { fwd: readonly (number | null)[]; qqq: readonly (number | null)[] }[]): string {
  return FORWARD_DAYS.map((n, j) => {
    const xs = evs.filter((e) => e.fwd[j] != null && e.qqq[j] != null).map((e) => (e.fwd[j] as number) - (e.qqq[j] as number));
    if (!xs.length) return n + 'd: n/a';
    const beat = xs.filter((x) => x > 0).length;
    const s = [...xs].sort((a, b) => a - b), med = s.length % 2 ? s[(s.length - 1) / 2] as number : ((s[s.length / 2 - 1] as number) + (s[s.length / 2] as number)) / 2;
    return n + 'd: ' + xs.length + ' with data, average vs QQQ ' + pc(xs.reduce((a, b) => a + b, 0) / xs.length) + ', median ' + pc(med) + ', beat QQQ ' + beat + '/' + xs.length;
  }).join('; ');
}

async function main(): Promise<void> {
  const pricesDir = arg('prices');
  if (!pricesDir) throw new Error('usage: businessAlertsReplayCli.ts --prices DIR [--series FILE] [--fund-history FILE] [--book T1,T2]');
  const qqq = readSeries(pricesDir, 'QQQ'), vix = readSeries(pricesDir, '^VIX');
  if (!qqq || !vix) throw new Error('QQQ.json and _VIX.json are needed in ' + pricesDir);
  const p = (s: string): void => { process.stdout.write(s + '\n'); };
  p('Prices: QQQ ' + qqq.dates[0] + ' to ' + qqq.dates.at(-1) + ', VIX ' + vix.dates[0] + ' to ' + vix.dates.at(-1) + '.');

  const fundEvents: ReplayEvent[] = [];
  const seriesFile = arg('series');
  if (seriesFile) {
    const all = JSON.parse(fs.readFileSync(seriesFile, 'utf8')) as Record<string, { netMargin?: QPoint[]; salesPerShare?: QPoint[] }>;
    for (const [t, q] of Object.entries(all)) {
      if (t.endsWith('_rec')) continue;
      const pts = pointsFromQuarterly(q, 'quarterly series');
      const px = readSeries(pricesDir, t);
      p('Series ' + t + ': ' + pts.length + ' point-in-time quarters' + (pts.length ? ' (' + pts[0]!.date + ' to ' + pts.at(-1)!.date + ')' : '') + (px ? ', prices from ' + px.dates[0] : ', NO price file (forward returns n/a)') + '.');
      fundEvents.push(...replayFundamentals(t, pts, px, qqq));
    }
  }
  const histFile = arg('fund-history');
  if (histFile) {
    const rows = fs.readFileSync(histFile, 'utf8').split('\n').filter((l) => l.trim()).map((l) => l.split('\t'));
    const by = historyByTicker(rows);
    const days = [...new Set(rows.slice(1).map((r) => String(r[0]).slice(0, 10)))].sort();
    p('Stored fundamentals history: ' + (rows.length - 1) + ' rows, ' + by.size + ' tickers, ' + days[0] + ' to ' + days.at(-1) + '.');
    for (const [t, pts] of by) fundEvents.push(...replayFundamentals(t, pts, readSeries(pricesDir, t), qqq));
  }
  if (seriesFile || histFile) {
    p('\n### Fundamental triggers (1)-(3)\n');
    p('| Ticker | Day | Trigger | Onset / repeat | What | 3m | QQQ 3m | 6m | QQQ 6m | 12m | QQQ 12m | 12m vs QQQ |');
    p('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const e of fundEvents) p('| ' + [e.ticker, e.day, e.check.id, e.repeat ? 'repeat' : 'onset', e.check.text.replace(/\|/g, '/'), pc(e.fwd[0]!), pc(e.qqq[0]!), pc(e.fwd[1]!), pc(e.qqq[1]!), pc(e.fwd[2]!), pc(e.qqq[2]!), ex(e.fwd[2]!, e.qqq[2]!)].join(' | ') + ' |');
    for (const id of ['REVENUE', 'MARGIN', 'RATING', 'TARGET']) {
      const evs = fundEvents.filter((e) => e.check.id === id);
      if (!evs.length) { p('\n' + id + ': no trigger in the history.'); continue; }
      p('\n' + id + ' all (' + evs.length + '): ' + summary(evs));
      const on = evs.filter((e) => !e.repeat);
      p(id + ' onsets only (' + on.length + '): ' + summary(on));
    }
  }

  const book = new Map<string, Series>();
  for (const t of (arg('book') ?? '').split(',').map((x) => x.trim()).filter(Boolean)) { const s = readSeries(pricesDir, t); if (s) book.set(t, s); }
  const m = replayMarket(vix, qqq, book);
  p('\n### Market shock (5): new alerts (30-day dedupe), ' + m.length + ' since ' + qqq.dates[BUSINESS_ALERT_RULES.qqqDays] + '\n');
  p('| Day | Why | QQQ 3m | QQQ 6m | QQQ 12m | Book 3m vs QQQ | Book 6m vs QQQ | Book 12m vs QQQ | Book stocks |');
  p('|---|---|---|---|---|---|---|---|---|');
  for (const e of m) p('| ' + [e.day, e.check.text, pc(e.qqq[0]!), pc(e.qqq[1]!), pc(e.qqq[2]!), ex(e.book[0]!, e.qqq[0]!), ex(e.book[1]!, e.qqq[1]!), ex(e.book[2]!, e.qqq[2]!), String(e.bookN[2] || e.bookN[0])].join(' | ') + ' |');
  const q12 = m.map((e) => e.qqq[2]).filter((x): x is number => x != null);
  p('\nQQQ 12 months after a new market alert: ' + q12.length + ' with data, average ' + pc(q12.length ? q12.reduce((a, b) => a + b, 0) / q12.length : null) + ', up ' + q12.filter((x) => x > 0).length + '/' + q12.length + '.');
  const q3 = m.map((e) => e.qqq[0]).filter((x): x is number => x != null);
  p('QQQ 3 months after: ' + q3.length + ' with data, average ' + pc(q3.length ? q3.reduce((a, b) => a + b, 0) / q3.length : null) + ', up ' + q3.filter((x) => x > 0).length + '/' + q3.length + '.');
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { process.stderr.write(String(e) + '\n'); process.exit(1); });
