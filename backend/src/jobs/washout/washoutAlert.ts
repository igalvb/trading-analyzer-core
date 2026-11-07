/**
 * The Washout ADD alert (owner 2026-11-07; docs/RESEARCH_WASHOUT_ROTATION_2026-11-07.md: the W1 washout is a useful
 * add-on trigger, not a strategy). Profile `alerts.washout` ('off' default; 'on' = this).
 *
 * Nightly, for the holdings and the Buy report's watchlist: the W1 signal at tonight's close (analysis/washout.ts,
 * the research lab's own function) AND fundamentals "Strong" where the engine has a fundamentals score (>= 70; no
 * score = no alert). When it fires: ONE Telegram line per stock (the owner is needed), a line in the Buy report, and
 * the dashboard's Buy rows; silent otherwise (notify/policy.ts). Each line also states the market regime from QQQ
 * (in a bear market the alert still fires, with "smaller size"). At most one Telegram line per stock per 10 trading
 * days (the stock's own bars since its last line). Display and alert only: no buy/sell rule or score reads this.
 */

import type { PropertyStore } from '../../storage/kv.ts';
import { orElse } from '../../core/guard.ts';
import { washoutReadLast, regimeWords, marketRegime, WASHOUTS, type MarketRegime, type WashoutRead } from '../../analysis/washout.ts';

/** Profile `alerts.washout`: 'on' = the alert; 'off' (the default) = nothing at all. */
export const washoutAlertsOn = (p: { readonly alerts: { readonly washout: string } }): boolean => p.alerts.washout === 'on';

/** Fundamentals "Strong" (the engine's 🟢 Own-worthy band). */
export const STRONG_FUNDAMENTALS = 70;
/** At most one Telegram line per stock per this many trading days. */
export const WASHOUT_DEDUPE_TRADING_DAYS = 10;
/** A last bar older than this (calendar days before the run day) is not tonight's close: no alert. */
export const WASHOUT_MAX_BAR_AGE_DAYS = 4;
/** The property-store key of the last Telegram line per stock ({ticker: 'YYYY-MM-DD'}). */
export const WASHOUT_LAST_KEY = 'WASHOUT_ALERT_LAST_V1';

export interface WashoutCandidate {
  readonly ticker: string;
  /** Held (an add level) or only on the watchlist (a buy level). */
  readonly held: boolean;
  /** 'YYYY-MM-DD', ascending, one per close. */
  readonly dates: readonly string[];
  readonly closes: readonly number[];
  /** The engine's fundamentals score (0-100); null = none (no alert). */
  readonly fundScore: number | null;
}

export interface WashoutHit {
  readonly ticker: string;
  readonly date: string;
  readonly held: boolean;
  readonly read: WashoutRead;
  readonly fundScore: number;
  /** The Telegram / Buy report line. */
  readonly line: string;
  /** A line was sent for this stock within the last 10 trading days: Telegram stays silent (the Buy line stays). */
  readonly deduped: boolean;
}

export interface WashoutNight {
  readonly hits: readonly WashoutHit[];
  readonly regime: MarketRegime | null;
}

const pct = (x: number): string => Math.round(x * 100) + '%';
const dayMs = (d: string): number => Date.parse(d + 'T12:00:00Z');

/** "🟢 Washout: MU closed 2.7 SD under its 20-day average, 41% off its high, long trend still rising — an add level ...". */
export function washoutLine(ticker: string, read: WashoutRead, held: boolean, regime: MarketRegime | null): string {
  return '🟢 Washout: ' + ticker + ' closed ' + (read.sdUnder ?? 0).toFixed(1) + ' SD under its 20-day average, ' + pct(read.offHigh ?? 0)
    + ' off its high, long trend still rising — ' + (held ? 'an add level' : 'a buy level') + ' (long-term, no stop). Loan bar: beats QQQ? · '
    + regimeWords(regime) + '.';
}

/** Trading days (the stock's own bars) after `last`, up to and including the newest bar. */
export function tradingDaysSince(dates: readonly string[], last: string): number {
  let n = 0;
  for (let i = dates.length - 1; i >= 0 && (dates[i] as string) > last; i--) n++;
  return n;
}

/**
 * Tonight's washout hits (pure). `last` = the day of each stock's last Telegram line. A stock fires when W1 fires at
 * its newest close, that close is tonight's (not older than WASHOUT_MAX_BAR_AGE_DAYS before `today`), and its
 * fundamentals score is >= STRONG_FUNDAMENTALS. `deduped` when its last line is fewer than 10 of its trading days ago.
 */
export function washoutNight(cands: readonly WashoutCandidate[], regime: MarketRegime | null, last: Readonly<Record<string, string>>, today: string): WashoutNight {
  const hits: WashoutHit[] = [];
  const seen = new Set<string>();
  for (const c of cands) {
    const t = c.ticker.toUpperCase();
    if (seen.has(t)) continue;
    seen.add(t);
    const n = Math.min(c.dates.length, c.closes.length);
    if (!n || c.fundScore == null || !Number.isFinite(c.fundScore) || c.fundScore < STRONG_FUNDAMENTALS) continue;
    const date = c.dates[n - 1] as string;
    if (!(dayMs(today) - dayMs(date) <= WASHOUT_MAX_BAR_AGE_DAYS * 86_400_000)) continue;
    const read = washoutReadLast(c.closes.slice(0, n), WASHOUTS.W1);
    if (!read.fired) continue;
    const prev = last[t];
    const deduped = typeof prev === 'string' && tradingDaysSince(c.dates.slice(0, n), prev) < WASHOUT_DEDUPE_TRADING_DAYS;
    hits.push({ ticker: t, date, held: c.held, read, fundScore: c.fundScore, line: washoutLine(t, read, c.held, regime), deduped });
  }
  return { hits, regime };
}

/** The stored last-line days (a bad or absent value = none). */
export async function readWashoutLast(kv: PropertyStore): Promise<Record<string, string>> {
  const raw = await kv.get(WASHOUT_LAST_KEY);
  if (!raw) return {};
  const v = orElse<unknown>(null, 'washout alert: stored days', () => JSON.parse(raw), null);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e[1])));
}

export interface WashoutSendDeps {
  readonly kv: PropertyStore;
  /** ONE Telegram line (notify/policy.ts notifyIfNeeded); true when sent. */
  readonly send: (line: string) => Promise<boolean>;
  readonly log: (m: string) => void;
}

/**
 * Sends one line per hit that is not deduped, and records the day of each line sent (a line not sent is not recorded,
 * so it is tried again the next night the signal holds). Nothing to send = nothing at all. Returns the tickers sent.
 */
export async function sendWashoutAlerts(d: WashoutSendDeps, night: WashoutNight): Promise<string[]> {
  const todo = night.hits.filter((h) => !h.deduped);
  if (!todo.length) { if (night.hits.length) d.log('washout alert: ' + night.hits.length + ' signal(s), already sent in the last ' + WASHOUT_DEDUPE_TRADING_DAYS + ' trading days'); return []; }
  const last = await readWashoutLast(d.kv);
  const sent: string[] = [];
  for (const h of todo) {
    if (await d.send(h.line)) { sent.push(h.ticker); last[h.ticker] = h.date; }
  }
  if (sent.length) await d.kv.set(WASHOUT_LAST_KEY, JSON.stringify(last));
  d.log('washout alert: ' + sent.length + ' line(s) sent' + (sent.length ? ' (' + sent.join(', ') + ')' : ''));
  return sent;
}

export interface WashoutGatherDeps {
  /** Held stocks, and the Buy report's watchlist (a ticker in both counts as held). */
  readonly held: readonly string[];
  readonly watchlist: readonly string[];
  /** A stock's daily closes ('YYYY-MM-DD' ascending); null = no chart tonight (no alert). */
  readonly chart: (ticker: string) => Promise<{ readonly dates: readonly string[]; readonly closes: readonly number[] } | null>;
  /** The engine's fundamentals score tonight; null = none. */
  readonly fundScore: (ticker: string) => Promise<number | null>;
  /** The regime index's closes (QQQ). */
  readonly indexCloses: () => Promise<readonly number[] | null>;
  readonly kv: PropertyStore;
  readonly today: string;
}

/** Tonight's candidates (held first, then the watchlist) from the run's charts and analyses. A stock whose read fails is left out. */
export async function gatherWashoutCandidates(d: Pick<WashoutGatherDeps, 'held' | 'watchlist' | 'chart' | 'fundScore'>, log: (m: string) => void): Promise<WashoutCandidate[]> {
  const held = new Set(d.held.map((t) => t.toUpperCase().trim()).filter(Boolean));
  const all = [...new Set([...held, ...d.watchlist.map((t) => t.toUpperCase().trim()).filter(Boolean)])];
  const cands: WashoutCandidate[] = [];
  for (const t of all) {
    const c = await d.chart(t).catch((e: unknown) => { log('washout alert: no chart for ' + t + ': ' + String(e)); return null; });
    if (!c || !c.closes.length) continue;
    const fundScore = await d.fundScore(t).catch(() => null);
    cands.push({ ticker: t, held: held.has(t), dates: c.dates, closes: c.closes, fundScore });
  }
  return cands;
}

/**
 * Tonight's candidates and regime from the run's charts and analyses, then washoutNight. A stock whose read fails is
 * left out. `pre` = candidates already gathered this run (the event check shares them).
 */
export async function gatherWashoutNight(d: WashoutGatherDeps, log: (m: string) => void, pre?: readonly WashoutCandidate[]): Promise<WashoutNight> {
  const cands = pre ?? await gatherWashoutCandidates(d, log);
  const q = await d.indexCloses().catch((e: unknown) => { log('washout alert: market regime not read: ' + String(e)); return null; });
  const regime = q ? marketRegime(q)?.regime ?? null : null;
  return washoutNight(cands, regime, await readWashoutLast(d.kv), d.today);
}
