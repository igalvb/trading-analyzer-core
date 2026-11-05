/** FL-7a-2b / FL-7c test helpers: Yahoo chart bodies built from the fixtures, and a clock just after their last bar. */

import { loadRawFixture } from './fixtures.ts';
import { yahooJson } from './yahooFixtures.ts';

export function fixtureBodies(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [sym, file] of [['TSLA', 'TSLA'], ['SPY', 'SPY'], ['^VIX', '_VIX'], ['NVDA', 'NVDA'], ['AAPL', 'TSLA'], ['IBIT', 'IBIT']] as const) {
    const raw = loadRawFixture(file);
    out[sym] = yahooJson({ ...raw, ticker: sym }, { from: Math.max(0, raw.closes.length - 504) });
  }
  return out;
}

/** The evening after the fixtures' last bar, so an empty price cache fetches the full 2y history. */
export function clockAfterFixtures(): { now: () => number } {
  const raw = loadRawFixture('TSLA');
  const t = Date.parse(raw.dates[raw.dates.length - 1] + 'T23:00:00Z');
  return { now: () => t };
}
