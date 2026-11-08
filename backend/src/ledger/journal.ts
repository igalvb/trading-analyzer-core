/**
 * The advice journal (owner-approved build 2026-11-08; docs/LEDGER.md "The advice journal"): a durable log of every
 * piece of advice the system and Claude give, so a year later we can see whether it was followed and whether it was
 * right. DISPLAY AND RECORD ONLY: nothing here feeds a buy / sell rule, a score or a verdict.
 *
 *   The file    ledger/journal.jsonl on the private `data` branch (schema.ts LedgerJournalEntry), append-only. Written
 *               by the Nightly (ledger/journalNight.ts, only while profile storage.ledger is shadow or on) and by
 *               Claude for chat advice (`npm run journal-add`, src/journalAdd.ts).
 *   Dedupe      one line per NEW or CHANGED advice per subject (the ticker, or an option's holding label) and source
 *               (selectNewEntries): the reports' rows (exit, buy) when the advice first appears or changes (an Exit
 *               HOLD only after an EXIT / REVIEW); an alert (washout, market shock, business, event check) when it is
 *               not already on file for the same subject within ALERT_REPEAT_DAYS (or its triggers changed); any line
 *               whose id is already on file is never written twice.
 *   Acted?      computed at each dashboard build, never stored (actedOf): the owner's trades of that ticker (tradesOf:
 *               ledger/edits.jsonl, holdings.json dated lots, buy dates and closed positions) within ACTED_TRADING_DAYS
 *               trading days after the advice (weekdays; market holidays are not known here).
 *   Right?      computed from the price history (scoreEntry): the stock's return and QQQ's over the same window, at
 *               +1w, +1m, +3m and +1y. BUY / ADD / BUY_POINT right when the stock beat QQQ; EXIT / AVOID right when it
 *               trailed QQQ; HOLD right when it did not trail QQQ by more than HOLD_TOLERANCE_PTS points; REVIEW /
 *               ALERT / WAIT informational (returns shown, no verdict); 'pending' until the horizon has passed. A
 *               market-wide BUY_POINT (no ticker) is right when QQQ rose. An option's advice is scored on its
 *               underlying stock.
 *   $ value     the owner's rule of thumb (RULE_OF_THUMB_USD per buy): following a BUY / ADD / BUY_POINT = that
 *               amount in the stock instead of QQQ; following an EXIT = that amount moved from the stock into QQQ.
 *               "What you did" counts the edge only when the advice was followed (minus it when the opposite was
 *               done). No tax, no fees, no position size from the ledger: a yardstick, not a P&L.
 *
 * Pure: no I/O here (the store reads and appends the file; the dashboard build reads the price history).
 */

import { LEDGER_SCHEMA, JOURNAL_ADVICE, JOURNAL_SOURCES, LEDGER_FILES, type JournalAdvice, type JournalSource, type LedgerEdit, type LedgerHoldings, type LedgerJournalEntry } from './schema.ts';

export type { JournalAdvice, JournalSource, LedgerJournalEntry };

/** An alert already on file for the same subject within this many calendar days is not written again. */
export const ALERT_REPEAT_DAYS = 14;
/** Acted: the owner's trades of the ticker within this many trading days after the advice. */
export const ACTED_TRADING_DAYS = 5;
/** HOLD is right when the stock did not trail QQQ by more than this many points. */
export const HOLD_TOLERANCE_PTS = 5;
/** The owner's rule of thumb for one opportunity (docs/HANDOFF_2026-10-31.md: about $5k per stock). */
export const RULE_OF_THUMB_USD = 5_000;
/** Longest detail kept. */
export const DETAIL_MAX = 300;
/** The yardstick. */
export const JOURNAL_INDEX = 'QQQ';

export const JOURNAL_HORIZONS = [
  { id: '1w', label: '+1 week', days: 7, months: 0 },
  { id: '1m', label: '+1 month', days: 0, months: 1 },
  { id: '3m', label: '+3 months', days: 0, months: 3 },
  { id: '1y', label: '+1 year', days: 0, months: 12 },
] as const;
export type HorizonId = (typeof JOURNAL_HORIZONS)[number]['id'];

/** The plain-words assumption under every $ figure (shown on the dashboard). */
export const VALUE_ASSUMPTION = 'Value: $' + RULE_OF_THUMB_USD.toLocaleString('en-US') + ' per advice (your rule of thumb per buy). Following a BUY = $'
  + RULE_OF_THUMB_USD.toLocaleString('en-US') + ' in the stock instead of QQQ; following an EXIT = $' + RULE_OF_THUMB_USD.toLocaleString('en-US')
  + ' moved from the stock into QQQ. "What you did" counts it only when you followed (minus it when you did the opposite). Before tax and fees; an option is scored on its stock.';

const SOURCE_SET: ReadonlySet<string> = new Set(JOURNAL_SOURCES);
const ADVICE_SET: ReadonlySet<string> = new Set(JOURNAL_ADVICE);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TICKER = /^[A-Z^][A-Z0-9.^=-]{0,11}$/;
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const r2 = (x: number | null): number | null => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const dayMs = (d: string): number => Date.parse(d + 'T12:00:00Z');
export const addDays = (d: string, n: number): string => new Date(dayMs(d) + n * 86_400_000).toISOString().slice(0, 10);
export const isDay = (d: unknown): d is string => typeof d === 'string' && DAY.test(d) && Number.isFinite(dayMs(d)) && new Date(dayMs(d)).toISOString().slice(0, 10) === d;

/** `n` calendar months after `d` (the last day of a shorter month: 31 Jan + 1 month = 28/29 Feb). */
export function addMonths(d: string, n: number): string {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1 + n, 1, 12));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0, 12)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return t.toISOString().slice(0, 10);
}

/** The end day of a horizon after `d`. */
export function horizonEnd(d: string, h: (typeof JOURNAL_HORIZONS)[number]): string {
  return h.months ? addMonths(d, h.months) : addDays(d, h.days);
}

/** The `n`-th weekday after `d` (market holidays are not known here: a weekday counts). */
export function addTradingDays(d: string, n: number): string {
  let x = d, k = 0;
  while (k < n) { x = addDays(x, 1); const w = new Date(dayMs(x)).getUTCDay(); if (w !== 0 && w !== 6) k++; }
  return x;
}

/** What the advice is about: an option's holding label, else the ticker, else the market. */
export function subjectOf(e: Pick<LedgerJournalEntry, 'ticker' | 'refs'>): string {
  const h = e.refs?.holding;
  return (typeof h === 'string' && h.trim() ? h.trim() : e.ticker) || 'MARKET';
}

/** The stable id: day, source, subject, advice ("2026-11-07:exit:CLSK:REVIEW"). */
export function journalId(e: Pick<LedgerJournalEntry, 'date' | 'source' | 'ticker' | 'advice' | 'refs'>): string {
  return e.date + ':' + e.source + ':' + subjectOf(e).replace(/\s+/g, '_') + ':' + e.advice;
}

export interface JournalFields {
  readonly date: string;
  readonly source: string;
  readonly ticker: string | null;
  readonly advice: string;
  readonly detail: string;
  readonly priceAtAdvice?: number | null;
  readonly qqqAtAdvice?: number | null;
  readonly horizon?: string;
  readonly refs?: Readonly<Record<string, string | number | null>>;
}

/** Checks the fields; ok = the entry (schema, id, detail cut), else one sentence why not. */
export function makeJournalEntry(f: JournalFields, at?: string): { readonly ok: true; readonly entry: LedgerJournalEntry } | { readonly ok: false; readonly why: string } {
  const source = String(f.source ?? '').trim(), advice = String(f.advice ?? '').trim().toUpperCase();
  if (!isDay(f.date)) return { ok: false, why: 'the date "' + String(f.date) + '" is not a day (YYYY-MM-DD)' };
  if (!SOURCE_SET.has(source)) return { ok: false, why: 'the source must be one of ' + JOURNAL_SOURCES.join(', ') + ', not "' + source + '"' };
  if (!ADVICE_SET.has(advice)) return { ok: false, why: 'the advice must be one of ' + JOURNAL_ADVICE.join(', ') + ', not "' + advice + '"' };
  const raw = f.ticker == null ? '' : String(f.ticker).trim().toUpperCase();
  const ticker = raw === '' || raw === '-' ? null : raw;
  if (ticker != null && !TICKER.test(ticker)) return { ok: false, why: 'the ticker "' + raw + '" is not a ticker (or - for the market)' };
  const detail = String(f.detail ?? '').replace(/\s+/g, ' ').trim().slice(0, DETAIL_MAX);
  if (!detail) return { ok: false, why: 'the detail (the short reason) is empty' };
  const price = (v: unknown): number | null | 'bad' => (v == null ? null : fin(v) && v > 0 ? Math.round(v * 10_000) / 10_000 : 'bad');
  const p = price(f.priceAtAdvice), q = price(f.qqqAtAdvice);
  if (p === 'bad' || q === 'bad') return { ok: false, why: 'a price must be a positive number' };
  const refs = f.refs && Object.keys(f.refs).length ? { ...f.refs } : undefined;
  const base = { date: f.date, source: source as JournalSource, ticker, advice: advice as JournalAdvice, refs };
  return {
    ok: true,
    entry: {
      schema: LEDGER_SCHEMA, id: journalId(base), date: f.date, source: base.source, ticker, advice: base.advice, detail,
      priceAtAdvice: p, qqqAtAdvice: q, horizon: String(f.horizon ?? '').trim().slice(0, 80), ...(refs ? { refs } : {}), ...(at ? { at } : {}),
    },
  };
}

// ── dedupe ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The sources whose rows the reports show every night: a line only when the advice first appears or changes. */
export const REPORT_SOURCES: ReadonlySet<JournalSource> = new Set(['exit', 'buy']);
/** The alert sources: shown only on the nights they fire. */
export const ALERT_SOURCES: ReadonlySet<JournalSource> = new Set(['washout', 'marketShock', 'business', 'eventCheck']);

/**
 * The candidates to append (in order), given the lines already on file. Never a line whose id is on file; for the
 * report sources only a first or changed advice (an Exit HOLD only right after an EXIT / REVIEW); for the alerts only
 * one not on file for the subject within ALERT_REPEAT_DAYS with the same signature (refs.sig); everything else (ideas,
 * chat, top 5) once per id.
 */
export function selectNewEntries(existing: readonly LedgerJournalEntry[], candidates: readonly LedgerJournalEntry[]): LedgerJournalEntry[] {
  const ids = new Set(existing.map((e) => e.id));
  const key = (e: LedgerJournalEntry): string => e.source + '|' + subjectOf(e);
  const last = new Map<string, LedgerJournalEntry>();
  const all = [...existing].map((e, i) => [e, i] as const).sort((a, b) => a[0].date.localeCompare(b[0].date) || a[1] - b[1]).map(([e]) => e);
  for (const e of all) last.set(key(e), e);
  const alerts = new Map<string, LedgerJournalEntry[]>();
  for (const e of all) if (ALERT_SOURCES.has(e.source)) (alerts.get(key(e)) ?? alerts.set(key(e), []).get(key(e))!).push(e);
  const out: LedgerJournalEntry[] = [];
  for (const c of candidates) {
    if (ids.has(c.id)) continue;
    const k = key(c), prev = last.get(k);
    if (REPORT_SOURCES.has(c.source)) {
      if (prev && prev.advice === c.advice) continue;
      if (c.source === 'exit' && c.advice === 'HOLD' && !(prev && (prev.advice === 'EXIT' || prev.advice === 'REVIEW'))) continue;
    } else if (ALERT_SOURCES.has(c.source)) {
      const sig = String(c.refs?.sig ?? '');
      const recent = (alerts.get(k) ?? []).some((e) => e.advice === c.advice && String(e.refs?.sig ?? '') === sig && e.date <= c.date && dayMs(c.date) - dayMs(e.date) < ALERT_REPEAT_DAYS * 86_400_000);
      if (recent) continue;
      (alerts.get(k) ?? alerts.set(k, []).get(k)!).push(c);
    }
    ids.add(c.id);
    last.set(k, c);
    out.push(c);
  }
  return out;
}

// ── the owner's trades (acted?) ───────────────────────────────────────────────────────────────────────────────────

export interface JournalTrade {
  readonly ticker: string;
  readonly side: 'buy' | 'sell';
  readonly date: string;
  /** Where it was seen: 'lot', 'bought', 'closed', 'edit:<kind>'. */
  readonly from: string;
}

const nyDayOf = (iso: unknown): string | null => {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) : null;
};
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const tickerOf = (v: Record<string, unknown> | null): string | null => (v && typeof v.ticker === 'string' && v.ticker.trim() ? v.ticker.trim().toUpperCase() : null);
const amountOf = (v: Record<string, unknown> | null): number | null => (v ? (fin(v.qty) ? v.qty : fin(v.contracts) ? v.contracts : null) : null);

/**
 * Every buy and sell the ledger knows: dated lots, buy dates and closed positions of holdings.json, and the dashboard
 * edits (a new holding = a buy on its buy day, else the edit's day; a quantity up / down = a buy / sell on the edit's
 * day; a removed holding = a sale; a new dated lot = a buy on its day). Puts are left out (long-only). One per ticker,
 * side and day.
 */
export function tradesOf(holdings: LedgerHoldings | null | undefined, edits: readonly LedgerEdit[] | null | undefined): JournalTrade[] {
  const out = new Map<string, JournalTrade>();
  const add = (ticker: string | null, side: 'buy' | 'sell', date: unknown, from: string): void => {
    if (!ticker || !isDay(date)) return;
    const k = ticker + '|' + side + '|' + date;
    if (!out.has(k)) out.set(k, { ticker, side, date, from });
  };
  for (const s of holdings?.stocks ?? []) {
    if (!s) continue;
    const t = tickerOf(s as never);
    add(t, 'buy', s.bought, 'bought');
    for (const l of Array.isArray(s.lots) ? s.lots : []) if (l) add(t, 'buy', l.date, 'lot');
  }
  for (const o of holdings?.options ?? []) if (o && o.side !== 'put') add(tickerOf(o as never), 'buy', o.bought, 'bought');
  for (const c of holdings?.closed ?? []) {
    if (!c || c.kind === 'put') continue;
    add(tickerOf(c as never), 'buy', c.bought, 'closed');
    add(tickerOf(c as never), 'sell', c.sold, 'closed');
  }
  for (const e of edits ?? []) {
    if (!e || e.file !== LEDGER_FILES.holdings) continue;
    const day = nyDayOf(e.at), before = obj(e.before), after = obj(e.after);
    if (before && before.side === 'put') continue;
    if (e.kind === 'add' && after && after.side !== 'put') add(tickerOf(after), 'buy', isDay(after.bought) ? after.bought : day, 'edit:add');
    else if (e.kind === 'remove' && before) add(tickerOf(before), 'sell', day, 'edit:remove');
    else if (e.kind === 'change' && before && after) {
      const a = amountOf(before), b = amountOf(after);
      if (a != null && b != null && b > a + 1e-9) add(tickerOf(after), 'buy', day, 'edit:change');
      else if (a != null && b != null && b < a - 1e-9) add(tickerOf(after), 'sell', day, 'edit:change');
    } else if (e.kind === 'sell' && before) {
      const sale = obj(after?.closed ?? null);
      add(tickerOf(before), 'sell', sale && isDay(sale.sold) ? sale.sold : day, 'edit:sell');
    } else if (e.kind === 'lot' && before && after) {
      const had = new Set((Array.isArray(before.lots) ? before.lots : []).map((l) => JSON.stringify(l)));
      for (const l of Array.isArray(after.lots) ? after.lots : []) if (!had.has(JSON.stringify(l))) add(tickerOf(after), 'buy', obj(l)?.date, 'edit:lot');
    }
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));
}

/** followed / opposite / no action; 'waiting' while the window is still open with nothing done; 'traded' for advice with no direction; 'n/a' for the market. */
export type Acted = 'followed' | 'opposite' | 'no action' | 'waiting' | 'traded' | 'n/a';

const BUYISH: ReadonlySet<JournalAdvice> = new Set(['BUY', 'ADD', 'BUY_POINT']);
/** Sources given during the day (a trade the same day counts); the reports and alerts come after the close. */
const SAME_DAY_SOURCES: ReadonlySet<JournalSource> = new Set(['claudeChat', 'claudeIdea', 'top5']);

/** Did the owner act on it (the first matching trade, when one)? */
export function actedOf(e: Pick<LedgerJournalEntry, 'date' | 'source' | 'ticker' | 'advice'>, trades: readonly JournalTrade[], today: string): { readonly acted: Acted; readonly trade: JournalTrade | null } {
  if (!e.ticker) return { acted: 'n/a', trade: null };
  const end = addTradingDays(e.date, ACTED_TRADING_DAYS);
  const from = SAME_DAY_SOURCES.has(e.source) ? e.date : addDays(e.date, 1);
  const inWin = trades.filter((t) => t.ticker === e.ticker && t.date >= from && t.date <= end);
  const buy = inWin.find((t) => t.side === 'buy') ?? null, sell = inWin.find((t) => t.side === 'sell') ?? null;
  const open = today <= end;
  const none = (followedWhenNone: boolean): { acted: Acted; trade: null } => ({ acted: open ? 'waiting' : followedWhenNone ? 'followed' : 'no action', trade: null });
  if (BUYISH.has(e.advice)) return buy ? { acted: 'followed', trade: buy } : sell ? { acted: 'opposite', trade: sell } : none(false);
  if (e.advice === 'EXIT') return sell ? { acted: 'followed', trade: sell } : buy ? { acted: 'opposite', trade: buy } : none(false);
  if (e.advice === 'HOLD') return sell ? { acted: 'opposite', trade: sell } : buy ? { acted: 'followed', trade: buy } : none(true);
  if (e.advice === 'WAIT' || e.advice === 'AVOID') return buy ? { acted: 'opposite', trade: buy } : sell ? { acted: 'followed', trade: sell } : none(true);
  const t = inWin[0] ?? null;
  return t ? { acted: 'traded', trade: t } : none(false);
}

// ── right? ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface JournalSeries { readonly dates: readonly string[]; readonly closes: readonly number[] }

/** The last close on or before `d` (dates ascending); null when none. */
export function closeOnOrBefore(s: JournalSeries | null | undefined, d: string): { readonly date: string; readonly close: number } | null {
  if (!s || !s.dates.length) return null;
  let lo = 0, hi = Math.min(s.dates.length, s.closes.length) - 1, at = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if ((s.dates[mid] as string) <= d) { at = mid; lo = mid + 1; } else hi = mid - 1; }
  for (let i = at; i >= 0; i--) { const c = s.closes[i]; if (fin(c) && c > 0) return { date: s.dates[i] as string, close: c }; }
  return null;
}

export type Verdict = 'right' | 'wrong' | 'info' | 'pending' | 'no data';

export interface HorizonScore {
  readonly id: HorizonId;
  readonly end: string;
  readonly status: Verdict;
  /** % return over the window (null until scored). */
  readonly stockPct: number | null;
  readonly qqqPct: number | null;
  /** stock − QQQ, in points. */
  readonly excessPts: number | null;
  /** $ edge of following, at RULE_OF_THUMB_USD (BUY / ADD / BUY_POINT / EXIT with a ticker; else null). */
  readonly edgeUsd: number | null;
}

/** The verdict rule per advice (see the file header). */
export function verdictOf(advice: JournalAdvice, stockPct: number, qqqPct: number, market: boolean): 'right' | 'wrong' | 'info' {
  const excess = stockPct - qqqPct;
  if (advice === 'BUY' || advice === 'ADD' || advice === 'BUY_POINT') return (market ? qqqPct > 0 : excess > 0) ? 'right' : 'wrong';
  if (advice === 'EXIT' || advice === 'AVOID') return market ? 'info' : excess < 0 ? 'right' : 'wrong';
  if (advice === 'HOLD') return market ? 'info' : excess >= -HOLD_TOLERANCE_PTS ? 'right' : 'wrong';
  return 'info';
}

/** $ edge of following, at the rule of thumb; null for advice with no trade in it. */
export function edgeOf(advice: JournalAdvice, stockPct: number, qqqPct: number, market: boolean): number | null {
  if (market) return null;
  if (BUYISH.has(advice)) return r2(RULE_OF_THUMB_USD * (stockPct - qqqPct) / 100);
  if (advice === 'EXIT') return r2(RULE_OF_THUMB_USD * (qqqPct - stockPct) / 100);
  return null;
}

/**
 * The entry at each horizon. Start: priceAtAdvice / qqqAtAdvice, else the history's close on (or before) the advice
 * day. End: the close on or before the horizon's end day. 'pending' until the end day has passed (or its close is not
 * in the history yet, for a week); 'no data' when there is no price for it.
 */
export function scoreEntry(e: Pick<LedgerJournalEntry, 'date' | 'ticker' | 'advice' | 'priceAtAdvice' | 'qqqAtAdvice'>, series: (key: string) => JournalSeries | null | undefined, today: string): HorizonScore[] {
  const market = !e.ticker;
  const st = market ? series(JOURNAL_INDEX) : series(e.ticker as string), qq = series(JOURNAL_INDEX);
  const start = (s: JournalSeries | null | undefined, given: number | null): number | null => (fin(given) && given > 0 ? given : closeOnOrBefore(s, e.date)?.close ?? null);
  const s0 = market ? start(qq, e.qqqAtAdvice) : start(st, e.priceAtAdvice), q0 = start(qq, e.qqqAtAdvice);
  return JOURNAL_HORIZONS.map((h) => {
    const end = horizonEnd(e.date, h);
    const blank = (status: Verdict): HorizonScore => ({ id: h.id, end, status, stockPct: null, qqqPct: null, excessPts: null, edgeUsd: null });
    if (today < end) return blank('pending');
    if (s0 == null || q0 == null || !st || !qq) return blank('no data');
    const s1 = closeOnOrBefore(st, end), q1 = closeOnOrBefore(qq, end);
    const fresh = (x: { date: string } | null): boolean => !!x && x.date > addDays(end, -5) && x.date >= e.date;
    if (!fresh(s1) || !fresh(q1)) return blank(dayMs(today) - dayMs(end) <= 7 * 86_400_000 ? 'pending' : 'no data');
    const stockPct = r2(((s1 as { close: number }).close / s0 - 1) * 100) as number, qqqPct = r2(((q1 as { close: number }).close / q0 - 1) * 100) as number;
    return { id: h.id, end, status: verdictOf(e.advice, stockPct, qqqPct, market), stockPct, qqqPct, excessPts: r2(stockPct - qqqPct), edgeUsd: edgeOf(e.advice, stockPct, qqqPct, market) };
  });
}

// ── the dashboard section ─────────────────────────────────────────────────────────────────────────────────────────

export interface JournalRow {
  readonly id: string;
  readonly date: string;
  readonly source: JournalSource;
  readonly ticker: string | null;
  readonly subject: string;
  readonly advice: JournalAdvice;
  readonly detail: string;
  readonly horizon: string;
  /** The price then: priceAtAdvice, else the history's close on (or before) the advice day. */
  readonly price: number | null;
  readonly qqq: number | null;
  readonly acted: Acted;
  readonly trade: { readonly side: 'buy' | 'sell'; readonly date: string } | null;
  readonly scores: readonly HorizonScore[];
  /** The $ edge you actually got per horizon: the edge when followed, minus it when opposite, 0 otherwise (null = not scored). */
  readonly yoursUsd: Readonly<Record<HorizonId, number | null>>;
}

export interface JournalScore {
  readonly source: JournalSource | 'all';
  readonly count: number;
  readonly horizons: ReadonlyArray<{ readonly id: HorizonId; readonly right: number; readonly wrong: number; readonly pending: number; readonly info: number; readonly hitPct: number | null; readonly ifFollowedUsd: number | null; readonly yoursUsd: number | null }>;
  /** Followed / (followed + opposite + no action), for advice with a direction whose window has closed; null = none. */
  readonly followedPct: number | null;
  readonly decided: number;
}

export interface DashJournal {
  readonly asOf: string;
  readonly horizons: ReadonlyArray<{ readonly id: HorizonId; readonly label: string }>;
  readonly assumption: string;
  readonly ruleOfThumbUsd: number;
  readonly actedDays: number;
  readonly holdTolerancePts: number;
  readonly rows: readonly JournalRow[];
  readonly scorecard: readonly JournalScore[];
  /** Tickers with no price history (their rows say "no data"). */
  readonly noHistory: readonly string[];
}

export interface JournalBuildInput {
  readonly entries: readonly LedgerJournalEntry[];
  readonly holdings?: LedgerHoldings | null;
  readonly edits?: readonly LedgerEdit[] | null;
  /** Daily closes by ticker (QQQ included) from the long price history. */
  readonly series: ReadonlyMap<string, JournalSeries>;
  /** Tonight's closes (🔎 Paper Reads), added to a series that ends earlier. */
  readonly latest?: ReadonlyMap<string, number> | null;
  /** 'YYYY-MM-DD', New York. */
  readonly today: string;
}

/** The series with tonight's close appended when the history ends before today. */
function withLatest(s: JournalSeries | undefined, close: number | undefined, today: string): JournalSeries | undefined {
  if (!fin(close) || close <= 0) return s;
  if (!s || !s.dates.length) return { dates: [today], closes: [close] };
  const last = s.dates[s.dates.length - 1] as string;
  return last < today ? { dates: [...s.dates, today], closes: [...s.closes, close] } : s;
}

/** Only well-formed lines (a hand-edited line with a bad field is left out, never a NaN on the page). */
export function validEntries(entries: readonly unknown[]): LedgerJournalEntry[] {
  const out: LedgerJournalEntry[] = [];
  const seen = new Set<string>();
  for (const x of entries) {
    const e = obj(x) as Partial<LedgerJournalEntry> | null;
    if (!e || !isDay(e.date) || !SOURCE_SET.has(String(e.source)) || !ADVICE_SET.has(String(e.advice))) continue;
    if (e.ticker != null && (typeof e.ticker !== 'string' || !TICKER.test(e.ticker))) continue;
    const id = typeof e.id === 'string' && e.id ? e.id : journalId(e as LedgerJournalEntry);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      schema: fin(e.schema) ? e.schema : LEDGER_SCHEMA, id, date: e.date, source: e.source as JournalSource, ticker: e.ticker ?? null, advice: e.advice as JournalAdvice,
      detail: typeof e.detail === 'string' ? e.detail.slice(0, DETAIL_MAX) : '', priceAtAdvice: fin(e.priceAtAdvice) && e.priceAtAdvice > 0 ? e.priceAtAdvice : null,
      qqqAtAdvice: fin(e.qqqAtAdvice) && e.qqqAtAdvice > 0 ? e.qqqAtAdvice : null, horizon: typeof e.horizon === 'string' ? e.horizon : '',
      ...(obj(e.refs) ? { refs: e.refs as LedgerJournalEntry['refs'] } : {}),
    });
  }
  return out;
}

const DIRECTIONAL: ReadonlySet<JournalAdvice> = new Set(['BUY', 'ADD', 'BUY_POINT', 'EXIT', 'HOLD', 'WAIT', 'AVOID']);

/** The scorecard of a set of rows. */
export function scorecardOf(source: JournalSource | 'all', rows: readonly JournalRow[]): JournalScore {
  const horizons = JOURNAL_HORIZONS.map((h) => {
    let right = 0, wrong = 0, pending = 0, info = 0, ifF = 0, yours = 0, priced = 0;
    for (const r of rows) {
      const s = r.scores.find((x) => x.id === h.id);
      if (!s) continue;
      if (s.status === 'right') right++; else if (s.status === 'wrong') wrong++; else if (s.status === 'pending') pending++; else if (s.status === 'info') info++;
      if (s.edgeUsd != null) { ifF += s.edgeUsd; yours += r.yoursUsd[h.id] ?? 0; priced++; }
    }
    return { id: h.id, right, wrong, pending, info, hitPct: right + wrong ? r2((right / (right + wrong)) * 100) : null, ifFollowedUsd: priced ? r2(ifF) : null, yoursUsd: priced ? r2(yours) : null };
  });
  const decided = rows.filter((r) => DIRECTIONAL.has(r.advice) && (r.acted === 'followed' || r.acted === 'opposite' || r.acted === 'no action'));
  return { source, count: rows.length, horizons, followedPct: decided.length ? r2((decided.filter((r) => r.acted === 'followed').length / decided.length) * 100) : null, decided: decided.length };
}

/** The Journal tab: every line with acted? and right? per horizon, newest first, and the scorecard per source. */
export function buildJournal(x: JournalBuildInput): DashJournal {
  const entries = validEntries(x.entries);
  const trades = tradesOf(x.holdings ?? null, x.edits ?? null);
  const cache = new Map<string, JournalSeries | undefined>();
  const series = (k: string): JournalSeries | undefined => {
    if (!cache.has(k)) cache.set(k, withLatest(x.series.get(k), x.latest?.get(k), x.today));
    return cache.get(k);
  };
  const noHistory = new Set<string>();
  const rows: JournalRow[] = entries.map((e) => {
    const scores = scoreEntry(e, series, x.today);
    if (e.ticker && !series(e.ticker)) noHistory.add(e.ticker);
    const a = actedOf(e, trades, x.today);
    const sign = a.acted === 'followed' ? 1 : a.acted === 'opposite' ? -1 : 0;
    const yoursUsd = Object.fromEntries(scores.map((s) => [s.id, s.edgeUsd == null ? null : r2(s.edgeUsd * sign) ?? 0])) as Record<HorizonId, number | null>;
    return {
      id: e.id, date: e.date, source: e.source, ticker: e.ticker, subject: subjectOf(e), advice: e.advice, detail: e.detail, horizon: e.horizon,
      price: e.priceAtAdvice ?? (e.ticker ? r2(closeOnOrBefore(series(e.ticker), e.date)?.close ?? null) : null), qqq: e.qqqAtAdvice ?? r2(closeOnOrBefore(series(JOURNAL_INDEX), e.date)?.close ?? null), acted: a.acted, trade: a.trade ? { side: a.trade.side, date: a.trade.date } : null, scores, yoursUsd,
    };
  }).map((r, i) => [r, i] as const).sort((a, b) => b[0].date.localeCompare(a[0].date) || a[1] - b[1]).map(([r]) => r);
  const sources = JOURNAL_SOURCES.filter((s) => rows.some((r) => r.source === s));
  return {
    asOf: x.today, horizons: JOURNAL_HORIZONS.map((h) => ({ id: h.id, label: h.label })), assumption: VALUE_ASSUMPTION, ruleOfThumbUsd: RULE_OF_THUMB_USD,
    actedDays: ACTED_TRADING_DAYS, holdTolerancePts: HOLD_TOLERANCE_PTS, rows,
    scorecard: [scorecardOf('all', rows), ...sources.map((s) => scorecardOf(s, rows.filter((r) => r.source === s)))],
    noHistory: [...noHistory].sort(),
  };
}

/** The series keys the journal needs from the long price history (its tickers and QQQ). */
export function journalSeriesKeys(entries: readonly unknown[]): string[] {
  return [...new Set([JOURNAL_INDEX, ...validEntries(entries).map((e) => e.ticker).filter((t): t is string => !!t)])];
}
