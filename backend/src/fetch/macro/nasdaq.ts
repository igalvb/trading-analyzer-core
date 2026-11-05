/**
 * Nasdaq's public quote API (no key; a browser User-Agent and Referer are
 * required): short interest and daily ETF history.
 *
 *   fetchNasdaqShortInterestV7            dataLayerV1.gs:1294-1307
 *   fetchNasdaqShortInterestV1            dataLayerV1.gs:1401-1418
 *   parseNasdaqHistoricalResponse_Macro   dataLayerV1.gs:1699-1724
 *   nasdaqHistoricalUrl_Macro_            dataLayerV1.gs:1726-1728
 *   fetchHistoricalOHLCV_Macro            dataLayerV1.gs:1730-1738
 *
 * The two short-interest readers are the same request and parse; they
 * differ only in that V1 builds its URL outside the try (so a ticker that
 * encodeURIComponent rejects throws instead of returning null). Both kept.
 * Logging goes to `log` (legacy: Logger.log).
 */

import type { HttpClient } from '../../net/http.ts';
import type { MacroSeries } from '../../storage/macroCaches.ts';
import type { MacroLog } from './fred.ts';

export const NASDAQ_HEADERS: Readonly<Record<string, string>> = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.nasdaq.com/' };

export interface ShortInterest {
  readonly shortInterest: number;
  readonly settlementDate: unknown;
  readonly daysToCover: unknown;
}

const shortInterestUrl = (ticker: string): string => 'https://api.nasdaq.com/api/quote/' + encodeURIComponent(ticker) + '/short-interest?assetclass=stocks';

function parseShortInterest(text: string): ShortInterest | null {
  const j = JSON.parse(text);
  const rows = j && j.data && j.data.shortInterestTable && j.data.shortInterestTable.rows;
  if (!rows || !rows[0] || !rows[0].interest) return null;
  return { shortInterest: parseInt(rows[0].interest.replace(/,/g, ''), 10), settlementDate: rows[0].settlementDate, daysToCover: rows[0].daysToCover };
}

/** fetchNasdaqShortInterestV7 (dataLayerV1.gs:1294-1307). */
export async function fetchNasdaqShortInterest(http: HttpClient, ticker: string): Promise<ShortInterest | null> {
  try {
    const res = await http.fetch({ url: shortInterestUrl(ticker), headers: NASDAQ_HEADERS, muteHttpExceptions: true });
    if (res.status !== 200) return null;
    return parseShortInterest(res.text());
  } catch {
    return null;
  }
}

/** fetchNasdaqShortInterestV1 (dataLayerV1.gs:1401-1418): the URL is built outside the try. */
export async function fetchNasdaqShortInterestV1(http: HttpClient, ticker: string, why?: (reason: string) => void): Promise<ShortInterest | null> {
  const url = shortInterestUrl(ticker);
  try {
    const res = await http.fetch({ url, headers: NASDAQ_HEADERS, muteHttpExceptions: true });
    if (res.status !== 200) { if (why) why('HTTP ' + res.status); return null; }
    const out = parseShortInterest(res.text());
    if (out == null && why) why('no data');
    return out;
  } catch (e) {
    if (why) why('network error: ' + (e as Error).message);
    return null;
  }
}

/** nasdaqHistoricalUrl_Macro_ (dataLayerV1.gs:1726-1728): ETF history since 2000. */
export function nasdaqHistoricalUrl(ticker: string): string {
  return 'https://api.nasdaq.com/api/quote/' + encodeURIComponent(ticker) + '/historical?assetclass=etf&fromdate=2000-01-01&limit=9999';
}

/**
 * parseNasdaqHistoricalResponse_Macro (dataLayerV1.gs:1699-1724). Nasdaq
 * lists newest first; the result is oldest first, dated at UTC midnight. A
 * row whose close/high/low does not parse is skipped. A malformed row (no
 * date) throws -- the caller's try catches it, as in legacy.
 */
export function parseNasdaqHistorical(ticker: string, status: number, text: string, log: MacroLog): MacroSeries | null {
  if (status !== 200) {
    log('Fetch failed for ' + ticker + ': HTTP ' + status);
    return null;
  }
  let json: any;
  try { json = JSON.parse(text); } catch (e) { log('Parse exception for ' + ticker + ': ' + (e as Error).message); return null; }
  const rows = json.data && json.data.tradesTable && json.data.tradesTable.rows;
  if (!rows || !rows.length) { log('No rows for ' + ticker); return null; }
  const chrono = rows.slice().reverse();
  const dates: Date[] = [], closes: number[] = [], highs: number[] = [], lows: number[] = [], volumes: number[] = [];
  chrono.forEach((r: any) => {
    const [m, d, y] = r.date.split('/');
    const close = parseFloat(String(r.close).replace(/[$,]/g, ''));
    const high = parseFloat(String(r.high).replace(/[$,]/g, ''));
    const low = parseFloat(String(r.low).replace(/[$,]/g, ''));
    const vol = parseFloat(String(r.volume).replace(/,/g, ''));
    if (isNaN(close) || isNaN(high) || isNaN(low)) return;
    dates.push(new Date(Date.UTC(+y, +m - 1, +d))); closes.push(close); highs.push(high); lows.push(low); volumes.push(isNaN(vol) ? 0 : vol);
  });
  if (!dates.length) return null;
  return { ticker, dates, closes, highs, lows, volumes };
}

/** fetchHistoricalOHLCV_Macro (dataLayerV1.gs:1730-1738). */
export async function fetchHistoricalOHLCV(http: HttpClient, ticker: string, log: MacroLog): Promise<MacroSeries | null> {
  try {
    const res = await http.fetch({ url: nasdaqHistoricalUrl(ticker), headers: NASDAQ_HEADERS, muteHttpExceptions: true });
    return parseNasdaqHistorical(ticker, res.status, res.text(), log);
  } catch (e) {
    log('Fetch exception for ' + ticker + ': ' + (e as Error).message);
    return null;
  }
}
