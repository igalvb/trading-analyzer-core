/**
 * FRED's public CSV export (no key): https://fred.stlouisfed.org/graph/fredgraph.csv?id=SERIES
 *
 * Three legacy readers, ported exactly:
 *   fetchFredSeriesV1     dataLayerV1.gs:1384-1399  -- values only; any failure is null
 *   fetchFredSeries_Macro dataLayerV1.gs:1933-1947  -- {dates, values}; a non-200 is logged
 *   fetchM2_Macro         dataLayerV1.gs:1910-1931  -- the same for M2SL, plus a header check
 * The two _Macro readers have NO try/catch in legacy: a network error (or an
 * empty body, where reading the header throws) propagates to the caller,
 * computeMacroSupplemental, which logs it. Kept.
 *
 * Rows whose value does not parse (FRED writes '.' for a missing value) are
 * skipped.
 */

import type { HttpClient } from '../../net/http.ts';

export const FRED_CSV_URL = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=';

export type MacroLog = (msg: string) => void;

export interface FredSeries {
  readonly dates: string[];
  readonly values: number[];
}

function csvLines(text: string): string[] {
  return text.split('\n').filter((l) => l.trim().length);
}

function parseRows(lines: readonly string[]): FredSeries {
  const dates: string[] = [], values: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 2) continue;
    const v = parseFloat(parts[1]);
    if (isNaN(v)) continue;
    dates.push(parts[0]); values.push(v);
  }
  return { dates, values };
}

/** fetchFredSeriesV1 (dataLayerV1.gs:1384-1399). */
export async function fetchFredSeriesValues(http: HttpClient, seriesId: string): Promise<number[] | null> {
  const url = FRED_CSV_URL + seriesId;
  try {
    const res = await http.fetch({ url, muteHttpExceptions: true });
    if (res.status !== 200) return null;
    const lines = csvLines(res.text());
    const values: number[] = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length < 2) continue;
      const v = parseFloat(parts[1]);
      if (!isNaN(v)) values.push(v);
    }
    return values;
  } catch {
    return null;
  }
}

/** fetchFredSeries_Macro (dataLayerV1.gs:1933-1947). Throws on a network error, as legacy does. */
export async function fetchFredSeriesMacro(http: HttpClient, seriesId: string, log: MacroLog): Promise<FredSeries | null> {
  const res = await http.fetch({ url: FRED_CSV_URL + seriesId, muteHttpExceptions: true });
  if (res.status !== 200) { log(seriesId + ' fetch failed: HTTP ' + res.status); return null; }
  return parseRows(csvLines(res.text()));
}

/** fetchM2_Macro (dataLayerV1.gs:1910-1931). Throws on a network error or an empty body, as legacy does. */
export async function fetchM2Macro(http: HttpClient, log: MacroLog): Promise<FredSeries | null> {
  const res = await http.fetch({ url: FRED_CSV_URL + 'M2SL', muteHttpExceptions: true });
  if (res.status !== 200) {
    log('M2 fetch failed: HTTP ' + res.status);
    return null;
  }
  const lines = csvLines(res.text());
  const header = lines[0];
  if (header.indexOf('observation_date') === -1 && header.indexOf('DATE') === -1) {
    log('WARNING: unexpected M2 CSV header: ' + header + ' -- field-name assumption may be wrong, check before trusting this data.');
  }
  return parseRows(lines);
}
