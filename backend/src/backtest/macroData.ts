/**
 * Backlog 37 (simulation v2, owner answer 4a): the macro reads rebuilt point in time.
 *
 * The engine's macro inputs come from the nightly's macro refresh (fetch/macro/refresh.ts): the 9-ETF risk-appetite
 * regime and Dow Theory (DIA / IYT) from Nasdaq's historical API, and M2, the 10y-2y yield curve, real GDP, the 10-year
 * yield and the fed funds rate from FRED's CSV export. Here those requests are answered from a local archive, cut at the
 * simulated day, so the PRODUCTION refresh code fills the caches each simulated day and the engine reads them as live.
 * No model or score code is touched.
 *
 * Point in time:
 *   - an ETF bar is served when dated on or before the simulated day (the same rule as the stock bars: the decision is
 *     at that day's close);
 *   - a FRED observation is served only from the day it was published (FRED_RELEASE_RULES; conservative lags), never
 *     earlier. Values are the archive's vintage (revised numbers, see docs/models/results/simulation-v2.md).
 * A series absent from the archive (or with no bar yet on the day) is a 404, which the engine already handles as
 * "unavailable" (the regime adds 0 to the conviction; Dow Theory / M2 / GDP stay empty).
 *
 * The archive: legacy/historical_data/macro/<TICKER>.json (columnar, like the price files) and <id lower case>.csv.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lastIndexOnOrBefore, seriesFromRaw, type PriceSeries } from './data.ts';
import { MACRO_REGIME_TICKERS, DOW_THEORY_TICKERS } from '../analysis/macroRegime.ts';
import { FRED_CSV_URL } from '../fetch/macro/fred.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MACRO_DIR = path.join(here, '..', '..', 'legacy', 'historical_data', 'macro');

/** The ETFs the macro refresh asks Nasdaq for (the regime basket, then Dow Theory). */
export const MACRO_ETFS: readonly string[] = [...MACRO_REGIME_TICKERS, ...DOW_THEORY_TICKERS];
/** The FRED series the macro refresh and the macro snapshot ask for. */
export const MACRO_FRED_SERIES: readonly string[] = ['M2SL', 'T10Y2Y', 'GDPC1', 'DGS10', 'FEDFUNDS'];

export interface FredRow { readonly date: string; readonly raw: string }

export interface MacroArchive {
  readonly etfs: ReadonlyMap<string, PriceSeries>;
  readonly fred: ReadonlyMap<string, readonly FredRow[]>;
}

/**
 * When an observation (FRED's observation_date, 'YYYY-MM-DD') was public, as the first calendar day it may be used:
 *   daily  -- the next calendar day (FRED posts a day's Treasury rates the next business day);
 *   FEDFUNDS (monthly average, dated the month's 1st) -- the 8th of the next month (released in its first days);
 *   M2SL (monthly, H.6) -- the 1st of the month after next (released around the 4th Tuesday of the next month);
 *   GDPC1 (quarterly, dated the quarter's 1st) -- the 1st of the 4th month after the quarter starts (the advance
 *   estimate comes about 4 weeks after the quarter ends).
 * Each lag is at or beyond the real publication delay, so a value can be late but never early.
 */
export type ReleaseRule = 'nextDay' | 'monthPlus1Day8' | 'monthPlus2' | 'monthPlus4';
export const FRED_RELEASE_RULES: Readonly<Record<string, ReleaseRule>> = {
  T10Y2Y: 'nextDay', DGS10: 'nextDay', FEDFUNDS: 'monthPlus1Day8', M2SL: 'monthPlus2', GDPC1: 'monthPlus4',
};

const iso = (y: number, m0: number, d: number): string => new Date(Date.UTC(y, m0, d)).toISOString().slice(0, 10);

/** The first day an observation dated `obsDate` may be used under `rule`. */
export function firstUsableDay(obsDate: string, rule: ReleaseRule): string {
  const y = Number(obsDate.slice(0, 4)), m0 = Number(obsDate.slice(5, 7)) - 1, d = Number(obsDate.slice(8, 10));
  switch (rule) {
    case 'nextDay': return iso(y, m0, d + 1);
    case 'monthPlus1Day8': return iso(y, m0 + 1, 8);
    case 'monthPlus2': return iso(y, m0 + 2, 1);
    case 'monthPlus4': return iso(y, m0 + 4, 1);
  }
}

/** The rows of one FRED series public on `day` (unknown series: the strictest rule, monthPlus4). */
export function fredRowsAsOf(id: string, rows: readonly FredRow[], day: string): FredRow[] {
  const rule = FRED_RELEASE_RULES[id] ?? 'monthPlus4';
  return rows.filter((r) => firstUsableDay(r.date, rule) <= day);
}

/** FRED's CSV text as of `day` (the export's own header); null when nothing was public yet. */
export function fredCsvAsOf(id: string, rows: readonly FredRow[], day: string): string | null {
  const keep = fredRowsAsOf(id, rows, day);
  if (!keep.length) return null;
  return 'observation_date,' + id + '\n' + keep.map((r) => r.date + ',' + r.raw).join('\n') + '\n';
}

export function parseFredCsv(text: string): FredRow[] {
  const out: FredRow[] = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const [date, raw] = line.split(',');
    if (date && raw !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(date)) out.push({ date, raw: raw.trim() });
  }
  return out;
}

const fmtNum = (n: number): string => String(Math.round(n * 10000) / 10000);
const fmtVol = (n: number): string => Math.round(n).toLocaleString('en-US');

/**
 * Nasdaq's historical body (newest row first, 'MM/DD/YYYY' dates, numbers as text) holding the bars dated on or
 * before `day`; null when there is none.
 */
export function nasdaqHistoricalBodyAsOf(s: PriceSeries, day: string): string | null {
  const to = lastIndexOnOrBefore(s, day);
  if (to < 0) return null;
  const rows: Array<Record<string, string>> = [];
  for (let i = to; i >= 0; i--) {
    const d = s.dates[i] as string;
    rows.push({
      date: d.slice(5, 7) + '/' + d.slice(8, 10) + '/' + d.slice(0, 4), close: fmtNum(s.closes[i] as number), volume: fmtVol(s.volumes[i] as number),
      open: fmtNum(s.opens[i] as number), high: fmtNum(s.highs[i] as number), low: fmtNum(s.lows[i] as number),
    });
  }
  return JSON.stringify({ data: { symbol: s.ticker, totalRecords: rows.length, tradesTable: { asOf: null, rows } }, message: null, status: { rCode: 200 } });
}

const NASDAQ_HIST = /^https:\/\/api\.nasdaq\.com\/api\/quote\/([^/]+)\/historical\?/;

/** The archive's answer to one request as of `day`: a body, or null (404) for a request it does not serve. */
export function macroBodyAsOf(archive: MacroArchive, url: string, day: string): string | null {
  const m = NASDAQ_HIST.exec(url);
  if (m) {
    const s = archive.etfs.get(decodeURIComponent(m[1] as string));
    return s ? nasdaqHistoricalBodyAsOf(s, day) : null;
  }
  if (url.startsWith(FRED_CSV_URL)) {
    const id = url.slice(FRED_CSV_URL.length);
    const rows = archive.fred.get(id);
    return rows ? fredCsvAsOf(id, rows, day) : null;
  }
  return null;
}

/** The archive as PointInTimeTransport's responder for the requests other than the stock charts. */
export function macroResponder(archive: MacroArchive): (url: string, day: string) => string | null {
  return (url, day) => macroBodyAsOf(archive, url, day);
}

/** The local archive; a missing file leaves that series out (it then reads as unavailable). */
export function loadMacroArchive(dir: string = MACRO_DIR): MacroArchive {
  const etfs = new Map<string, PriceSeries>();
  const fred = new Map<string, FredRow[]>();
  for (const t of MACRO_ETFS) {
    const f = path.join(dir, t + '.json');
    if (fs.existsSync(f)) etfs.set(t, seriesFromRaw(t, JSON.parse(fs.readFileSync(f, 'utf8'))));
  }
  for (const id of MACRO_FRED_SERIES) {
    const f = path.join(dir, id.toLowerCase() + '.csv');
    if (fs.existsSync(f)) fred.set(id, parseFredCsv(fs.readFileSync(f, 'utf8')));
  }
  return { etfs, fred };
}

/** What the archive holds and what it lacks (for the run's report). */
export function describeArchive(a: MacroArchive): string {
  const etf = MACRO_ETFS.map((t) => { const s = a.etfs.get(t); return s ? t + ' ' + s.dates[0] + '..' + s.dates[s.dates.length - 1] : t + ' MISSING'; });
  const fr = MACRO_FRED_SERIES.map((id) => { const r = a.fred.get(id); return r && r.length ? id + ' ' + r[0]!.date + '..' + r[r.length - 1]!.date : id + ' MISSING'; });
  return 'Macro archive: ' + etf.join(', ') + '; ' + fr.join(', ') + '.';
}
