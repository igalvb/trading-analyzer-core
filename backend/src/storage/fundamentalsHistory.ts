/**
 * Requirement K (V13 §3.K; owner decision 2026-11-04, backlog row 39): the fundamentals the engine reads,
 * plus the 13F holder count and the broker short-interest data the analysis already had, kept as
 * APPEND-ONLY history in '💾 Fundamentals History' (data spreadsheet).
 *
 *   one row per ticker per day a value changed:  Date | Ticker | <fields> | Source
 *
 * Written by the nightly step 'fundamentals.history' after the analysis, from the values each ticker's
 * analysis already fetched (no extra provider call). A row is appended only when at least one field
 * differs from the ticker's last stored row (Date and Source are not compared: the source label carries
 * the fetch date). Display and storage only: nothing here feeds a score.
 *
 * Retention: grows forever, like the other '💾' histories (protected from the price-cache cleanup).
 */

import type { TickerArtifacts } from '../analysis/runTicker.ts';
import { HistoryHeaders } from '../sheets/writers/appendHistory.ts';
import { Tabs } from '../sheets/tabs.ts';
import type { TabCell, TabStore } from './tabStore.ts';

export const FUNDAMENTALS_HISTORY_TAB = Tabs.FUNDAMENTALS_HISTORY;
export const FUNDAMENTALS_HISTORY_HEADER: readonly string[] = HistoryHeaders.FUNDAMENTALS;
const N_COLS = FUNDAMENTALS_HISTORY_HEADER.length;
/** The compared value columns: everything between Ticker and Source. */
const FIRST_VALUE = 2;
const LAST_VALUE = N_COLS - 2;

export interface FundamentalsRecord {
  /** yyyy-mm-dd, the night's date in the script zone. */
  readonly date: string;
  readonly ticker: string;
  readonly revenueGrowth: number | null;
  readonly earningsGrowth: number | null;
  readonly grossMargin: number | null;
  readonly profitMargin: number | null;
  readonly returnOnEquity: number | null;
  readonly forwardPE: number | null;
  readonly trailingPE: number | null;
  readonly peg: number | null;
  readonly priceToBook: number | null;
  readonly debtToEquity: number | null;
  readonly currentRatio: number | null;
  readonly analystTarget: number | null;
  readonly analysts: number | null;
  readonly ratingScore: number | null;
  readonly rating: string | null;
  readonly shortInterest: number | null;
  readonly daysToCover: number | null;
  readonly shortPctFloat: number | null;
  readonly holders13F: number | null;
  /** Shares held by those filers together (latest 13F). */
  readonly shares13F: number | null;
  readonly source: string;
}

/** Field order of the value columns (matches the header). Decimals keep provider float noise out of "changed". */
const FIELDS: readonly { readonly key: keyof FundamentalsRecord; readonly dp: number | null }[] = [
  { key: 'revenueGrowth', dp: 4 }, { key: 'earningsGrowth', dp: 4 }, { key: 'grossMargin', dp: 4 }, { key: 'profitMargin', dp: 4 },
  { key: 'returnOnEquity', dp: 4 }, { key: 'forwardPE', dp: 2 }, { key: 'trailingPE', dp: 2 }, { key: 'peg', dp: 2 },
  { key: 'priceToBook', dp: 2 }, { key: 'debtToEquity', dp: 2 }, { key: 'currentRatio', dp: 2 }, { key: 'analystTarget', dp: 2 },
  { key: 'analysts', dp: 0 }, { key: 'ratingScore', dp: 2 }, { key: 'rating', dp: null }, { key: 'shortInterest', dp: 0 },
  { key: 'daysToCover', dp: 2 }, { key: 'shortPctFloat', dp: 4 }, { key: 'holders13F', dp: 0 }, { key: 'shares13F', dp: 0 },
];

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v: number, dp: number): number => { const f = 10 ** dp; return Math.round(v * f) / f; };

/**
 * The 13F filers (of the tracked list) holding the stock in their latest filing, and their shares together; null
 * when the analysis had no 13F data. Counted from `holdings.shares` (the Position13F object the broker report keeps).
 */
export function holders13FOf(a: TickerArtifacts): { readonly holders: number | null; readonly shares: number | null } {
  const h = (a.reports.broker as { institutional13F?: Record<string, { latest?: { holdings?: unknown } | null } | null> | null } | null | undefined)?.institutional13F;
  if (!h) return { holders: null, shares: null };
  let holders = 0, shares = 0;
  for (const q of Object.values(h)) {
    const raw = q?.latest?.holdings;
    const s = typeof raw === 'number' ? raw : num((raw as { shares?: unknown } | null | undefined)?.shares);
    if (s != null && s > 0) { holders++; shares += s; }
  }
  return { holders, shares };
}

/** The record of one analysis, or null when it carried no fundamentals at all (nothing worth storing). */
export function fundamentalsRecordOf(a: TickerArtifacts, date: string): FundamentalsRecord | null {
  const f = a.fund ?? null;
  const h13 = holders13FOf(a);
  const broker = a.reports.broker as { news?: { shortInterestData?: { shortInterest?: unknown; daysToCover?: unknown } | null; shortPctOfFloat?: unknown } } | null | undefined;
  const si = broker?.news?.shortInterestData ?? null;
  const rec: FundamentalsRecord = {
    date, ticker: String(a.ticker).toUpperCase(),
    revenueGrowth: num(f?.revenueGrowth), earningsGrowth: num(f?.earningsGrowth), grossMargin: num(f?.grossMargins),
    profitMargin: num(f?.profitMargins), returnOnEquity: num(f?.returnOnEquity), forwardPE: num(f?.forwardPE),
    trailingPE: num(f?.trailingPE), peg: num(f?.pegRatio), priceToBook: num(f?.priceToBook), debtToEquity: num(f?.debtToEquity),
    currentRatio: num(f?.currentRatio), analystTarget: num(f?.targetMean), analysts: num(f?.numAnalysts), ratingScore: num(f?.recMean),
    rating: f?.recKey ? String(f.recKey) : null,
    shortInterest: num(si?.shortInterest), daysToCover: num(si?.daysToCover), shortPctFloat: num(broker?.news?.shortPctOfFloat),
    holders13F: h13.holders, shares13F: h13.shares,
    source: String(a.fundSource ?? ''),
  };
  return FIELDS.some((x) => rec[x.key] != null) ? rec : null;
}

/** The sheet row (rounded; a missing value is an empty cell). */
export function fundamentalsRow(r: FundamentalsRecord): TabCell[] {
  return [
    r.date, r.ticker,
    ...FIELDS.map((x) => { const v = r[x.key]; return v == null ? '' : x.dp == null ? String(v) : round(v as number, x.dp); }),
    r.source,
  ];
}

const cellKey = (v: unknown): string => {
  if (v == null || v === '') return '';
  if (typeof v === 'number') return String(v);
  const s = String(v).trim();
  const n = Number(s);
  return s !== '' && Number.isFinite(n) ? String(n) : s;
};

/** Whether two rows differ in any value column (Date, Ticker and Source are not compared). */
export function valuesChanged(a: readonly TabCell[], b: readonly TabCell[] | undefined): boolean {
  if (!b) return true;
  for (let i = FIRST_VALUE; i <= LAST_VALUE; i++) if (cellKey(a[i]) !== cellKey(b[i])) return true;
  return false;
}

const dateKey = (v: TabCell | undefined): string => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v ?? '').trim().slice(0, 10);
};

/** The last stored row per ticker (latest Date; on a tie the later row). Header skipped. */
export function lastRowByTicker(rows: readonly (readonly TabCell[])[]): Map<string, readonly TabCell[]> {
  const out = new Map<string, readonly TabCell[]>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    const t = String(r[1] ?? '').trim().toUpperCase();
    if (!t) continue;
    const prev = out.get(t);
    if (!prev || dateKey(r[0]) >= dateKey(prev[0])) out.set(t, r);
  }
  return out;
}

export interface FundamentalsHistoryWrite {
  readonly appended: number;
  readonly unchanged: number;
}

/**
 * Appends tonight's records whose values changed since the ticker's last stored row. One read and one
 * write of the tab (plus one header write the first time). Throws on a store error; the nightly step
 * catches it.
 */
export async function appendFundamentalsHistory(store: TabStore, records: readonly FundamentalsRecord[]): Promise<FundamentalsHistoryWrite> {
  if (!records.length) return { appended: 0, unchanged: 0 };
  const tab = FUNDAMENTALS_HISTORY_TAB;
  if (await store.ensure(tab)) await store.write(tab, 1, [[...FUNDAMENTALS_HISTORY_HEADER]], { header: true });
  let rows = (await store.read(tab, N_COLS)) ?? [];
  if (!rows.length) { await store.write(tab, 1, [[...FUNDAMENTALS_HISTORY_HEADER]], { header: true }); rows = [[...FUNDAMENTALS_HISTORY_HEADER]]; }
  const last = lastRowByTicker(rows);
  const add: TabCell[][] = [];
  for (const r of records) {
    const row = fundamentalsRow(r);
    if (!valuesChanged(row, last.get(r.ticker))) continue;
    add.push(row);
    last.set(r.ticker, row);
  }
  if (add.length) await store.write(tab, rows.length + 1, add);
  return { appended: add.length, unchanged: records.length - add.length };
}

const cellNum = (v: TabCell | undefined): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Parses one stored row back into a record. */
export function recordOfRow(r: readonly TabCell[]): FundamentalsRecord {
  const o: Record<string, unknown> = { date: dateKey(r[0]), ticker: String(r[1] ?? '').trim().toUpperCase(), source: String(r[N_COLS - 1] ?? '') };
  FIELDS.forEach((x, i) => {
    const v = r[FIRST_VALUE + i];
    o[x.key] = x.dp == null ? (v == null || v === '' ? null : String(v)) : cellNum(v);
  });
  return o as unknown as FundamentalsRecord;
}

/**
 * Point-in-time read: the ticker's fundamentals as they were stored on or before `asOf` (yyyy-mm-dd or a
 * Date, compared by calendar date), or null when nothing was stored by then. Since a row is written only
 * when something changed, the latest row on or before the day is the value in force that day.
 */
export async function latestFundamentals(store: TabStore, ticker: string, asOf: string | Date): Promise<FundamentalsRecord | null> {
  const rows = (await store.read(FUNDAMENTALS_HISTORY_TAB, N_COLS)) ?? [];
  return latestFundamentalsIn(rows, ticker, asOf);
}

/** latestFundamentals over rows already read (header included). */
export function latestFundamentalsIn(rows: readonly (readonly TabCell[])[], ticker: string, asOf: string | Date): FundamentalsRecord | null {
  const t = String(ticker).trim().toUpperCase();
  const day = asOf instanceof Date ? asOf.toISOString().slice(0, 10) : String(asOf).slice(0, 10);
  let best: readonly TabCell[] | null = null;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    if (String(r[1] ?? '').trim().toUpperCase() !== t) continue;
    const d = dateKey(r[0]);
    if (!d || d > day) continue;
    if (!best || d >= dateKey(best[0])) best = r;
  }
  return best ? recordOfRow(best) : null;
}

export interface FundamentalsHistoryNightDeps {
  readonly store: TabStore;
  /** yyyy-mm-dd in the script zone. */
  readonly day: string;
  /** Tonight's analysed tickers. */
  readonly tickers: readonly string[];
  /** The memoised analysis (null when it failed or did not settle). Must not call a provider. */
  readonly analysis: (ticker: string) => Promise<TickerArtifacts | null>;
  readonly log: (msg: string) => void;
}

export const FUNDAMENTALS_HISTORY_NOT_STORED = 'Tonight\'s fundamentals were not added to the Fundamentals History tab; the reports are unchanged.';

/** The nightly step 'fundamentals.history'. Never throws: a store error makes it 'degraded'. */
export async function runFundamentalsHistoryNight(d: FundamentalsHistoryNightDeps): Promise<{ readonly state: 'ok' | 'degraded'; readonly reason?: string }> {
  const store = async (): Promise<FundamentalsHistoryWrite & { readonly without: number }> => {
    const records: FundamentalsRecord[] = [];
    for (const t of d.tickers) {
      const a = await d.analysis(t).catch((e: unknown) => { d.log('fundamentals history: ' + t + ' left out (no analysis result: ' + String(e) + ')'); return null; });
      const r = a && !a.aborted ? fundamentalsRecordOf(a, d.day) : null;
      if (r) records.push(r);
    }
    return { ...(await appendFundamentalsHistory(d.store, records)), without: d.tickers.length - records.length };
  };
  return store().then(
    (w) => { d.log('fundamentals history: ' + w.appended + ' row(s) added, ' + w.unchanged + ' unchanged, ' + w.without + ' without fundamentals'); return { state: 'ok' as const }; },
    (e: unknown) => { d.log('fundamentals history: not stored tonight: ' + String(e)); return { state: 'degraded' as const, reason: FUNDAMENTALS_HISTORY_NOT_STORED }; },
  );
}
