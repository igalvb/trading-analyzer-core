/**
 * F-36 option B (built, OFF by default until the user confirms -- it changes
 * what the OWN score sees on a saved-copy run): the Finnhub metric series and
 * the peer list are kept in their own tab instead of inside the FUND_
 * property, so a saved-copy run can score with trends and peers like a live
 * run. A Sheets cell holds at most 50,000 characters, so the series JSON is
 * split across up to SERIES_CHUNKS cells.
 *
 * Layout ('💾 Fundamentals Series'): Ticker | SavedAt (ISO) | Peers (JSON) | Series chunk 1 .. n
 */

import type { TabCell, TabStore } from './tabStore.ts';

export const FUNDAMENTALS_SERIES_TAB = '💾 Fundamentals Series';
export const SERIES_CHUNK_CHARS = 45_000;
export const SERIES_CHUNKS = 10;
const N_COLS = 3 + SERIES_CHUNKS;

export interface SavedSeries {
  readonly series: unknown;
  readonly peers: string[] | null;
  readonly savedAt: string;
}

export interface FundamentalsSeriesStore {
  save(ticker: string, series: unknown, peers: readonly string[] | null | undefined, savedAt: Date): Promise<void>;
  load(ticker: string): Promise<SavedSeries | null>;
}

export function tabSeriesStore(store: TabStore): FundamentalsSeriesStore {
  return {
    async save(ticker, series, peers, savedAt) {
      const json = series == null ? '' : JSON.stringify(series);
      if (json.length > SERIES_CHUNK_CHARS * SERIES_CHUNKS) throw new Error('fundamentals series for ' + ticker + ' is ' + json.length + ' characters, over the ' + SERIES_CHUNK_CHARS * SERIES_CHUNKS + ' this tab holds');
      const chunks: string[] = [];
      for (let i = 0; i < SERIES_CHUNKS; i++) chunks.push(json.slice(i * SERIES_CHUNK_CHARS, (i + 1) * SERIES_CHUNK_CHARS));
      const row: TabCell[] = [ticker.toUpperCase(), savedAt.toISOString(), peers == null ? '' : JSON.stringify(peers), ...chunks];
      await store.ensure(FUNDAMENTALS_SERIES_TAB);
      const rows = (await store.read(FUNDAMENTALS_SERIES_TAB, N_COLS)) ?? [];
      const header = ['Ticker', 'SavedAt', 'Peers', ...Array.from({ length: SERIES_CHUNKS }, (_, i) => 'Series ' + (i + 1))];
      const body = rows.length && rows[0][0] === 'Ticker' ? rows.slice(1) : rows;
      const at = body.findIndex((r) => String(r[0]).toUpperCase() === ticker.toUpperCase());
      if (at >= 0) await store.write(FUNDAMENTALS_SERIES_TAB, at + 2, [row]);
      else {
        if (!rows.length) await store.write(FUNDAMENTALS_SERIES_TAB, 1, [header]);
        await store.write(FUNDAMENTALS_SERIES_TAB, body.length + 2, [row]);
      }
    },
    async load(ticker) {
      const rows = await store.read(FUNDAMENTALS_SERIES_TAB, N_COLS);
      if (!rows) return null;
      const r = rows.find((x) => String(x[0]).toUpperCase() === ticker.toUpperCase());
      if (!r) return null;
      const json = r.slice(3).map((c) => String(c ?? '')).join('');
      return { series: json ? JSON.parse(json) : null, peers: r[2] ? JSON.parse(String(r[2])) : null, savedAt: String(r[1]) };
    },
  };
}
