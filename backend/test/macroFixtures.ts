/**
 * Responses for FL-3.
 *
 * REAL: FRED DGS10 and FEDFUNDS, the CSV exports in legacy/historical_data
 * (dgs10.csv, fedfunds.csv) -- FRED's own format, '.' for missing values.
 * SYNTHETIC: everything else. Nasdaq history for the macro basket is built
 * from the stock fixtures under a FIXED, arbitrary mapping (TLT from JNJ,
 * GLD from KO, ...) -- only the shape and the arithmetic matter, not the
 * market meaning. M2SL / T10Y2Y / GDPC1 CSVs, short-interest and FMP
 * ratio bodies are invented in the real formats.
 */

import fs from 'node:fs';
import path from 'node:path';
import { scrubUrl, type RecordedExchange } from '../src/net/http.ts';
import { FIXTURE_DIR, loadRawFixture } from './fixtures.ts';

export const MACRO_SOURCES: Readonly<Record<string, readonly [string, number]>> = {
  SPY: ['SPY', 1], TLT: ['JNJ', 0.8], GLD: ['KO', 3], XLP: ['POOL', 0.2], XLU: ['UQZA', 0.15], XLV: ['JNJ', 0.9],
  XLY: ['AMD', 1.5], XLI: ['DECK', 0.3], XLB: ['JPM', 0.4], DIA: ['SPY', 0.9], IYT: ['MQZC', 0.7], IBIT: ['IBIT', 1],
};

function mdy(iso: string): string {
  const [y, m, d] = iso.split('-');
  return m + '/' + d + '/' + y;
}

export interface NasdaqOptions {
  /** Last fixture date to include (ISO). */
  readonly end: string;
  /** Number of bars (newest back). */
  readonly bars: number;
  /** Multiplies closes from this offset (0 = oldest kept bar) on, to steer trends. */
  readonly tilt?: (k: number, n: number) => number;
  /** Insert a few unparseable rows. */
  readonly holes?: boolean;
}

/** A Nasdaq /historical body, newest first, '$'-prefixed prices and comma volumes. */
export function nasdaqHistoricalBody(ticker: string, o: NasdaqOptions): string {
  const [src, scale] = MACRO_SOURCES[ticker] ?? ['SPY', 1];
  const raw = loadRawFixture(src);
  const idx: number[] = [];
  for (let i = 0; i < raw.dates.length; i++) if (raw.dates[i] <= o.end) idx.push(i);
  const kept = idx.slice(-o.bars);
  const rows = kept.map((i, k) => {
    const t = (o.tilt ? o.tilt(k, kept.length) : 1) * scale;
    const c = raw.closes[i] * t;
    const h = (raw.highs?.[i] ?? raw.closes[i]) * t;
    const l = (raw.lows?.[i] ?? raw.closes[i]) * t;
    return { date: mdy(raw.dates[i]), close: '$' + c.toFixed(2), volume: Math.round(raw.volumes?.[i] ?? 0).toLocaleString('en-US'), open: '$' + c.toFixed(2), high: '$' + h.toFixed(2), low: '$' + l.toFixed(2) };
  });
  if (o.holes && rows.length > 10) {
    rows[3] = { ...rows[3], close: 'N/A' };
    rows[7] = { ...rows[7], volume: 'N/A' };
  }
  return JSON.stringify({ data: { symbol: ticker, totalRecords: rows.length, tradesTable: { headers: {}, rows: rows.reverse() } }, message: null, status: { rCode: 200 } });
}

export function realFredCsv(name: 'dgs10' | 'fedfunds'): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name + '.csv'), 'utf8');
}

/** A FRED CSV export: `observation_date,ID` then one row per observation. */
export function fredCsv(id: string, rows: ReadonlyArray<readonly [string, number | '.']>, header = 'observation_date'): string {
  return [header + ',' + id, ...rows.map(([d, v]) => d + ',' + v)].join('\n') + '\n';
}

export function monthly(start: [number, number], n: number, f: (i: number) => number | '.'): Array<[string, number | '.']> {
  return Array.from({ length: n }, (_, i) => {
    const y = start[0] + Math.floor((start[1] - 1 + i) / 12);
    const m = ((start[1] - 1 + i) % 12) + 1;
    return [y + '-' + String(m).padStart(2, '0') + '-01', f(i)];
  });
}

export function shortInterestBody(variant: 'ok' | 'empty' | 'noInterest' | 'numberInterest'): string {
  if (variant === 'empty') return JSON.stringify({ data: { shortInterestTable: { rows: [] } } });
  if (variant === 'noInterest') return JSON.stringify({ data: { shortInterestTable: { rows: [{ settlementDate: '09/30/2026', interest: '' }] } } });
  if (variant === 'numberInterest') return JSON.stringify({ data: { shortInterestTable: { rows: [{ settlementDate: '09/30/2026', interest: 1234 }] } } });
  return JSON.stringify({ data: { shortInterestTable: { rows: [
    { settlementDate: '09/30/2026', interest: '12,345,678', avgDailyShareVolume: '4,000,000', daysToCover: 3.09 },
    { settlementDate: '09/15/2026', interest: '11,000,000', avgDailyShareVolume: '4,100,000', daysToCover: 2.68 },
  ] } } });
}

export function recordedGet(url: string, status: number, body: string): RecordedExchange {
  return { request: { method: 'GET', url: scrubUrl(url) }, response: { status, bodyBase64: Buffer.from(body, 'utf8').toString('base64') } };
}
