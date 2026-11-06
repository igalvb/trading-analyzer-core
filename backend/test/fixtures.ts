/**
 * Real-ticker OHLCV fixtures, and the chart objects built from them.
 *
 * The construction below is not invented -- it mirrors exactly how the
 * legacy project's own tests build a chart from these files
 * (composite_leverage_predictive_value_test.js:87-100), including the two
 * details that are easy to get wrong:
 *
 *   - `dates` are ISO date STRINGS in the file and must become Date objects
 *     at UTC midnight. Using local-midnight would shift bars by a day in
 *     some timezones.
 *   - `splits[].date` is UNIX SECONDS, not milliseconds -- hence *1000.
 *
 * Getting either wrong produces a chart that looks fine and yields subtly
 * different indicator values, which is exactly the class of silent
 * divergence the parity suite exists to catch.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCorePath } from '../scripts/coreManifest.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.join(here, '..', 'legacy', 'historical_data');

/**
 * Not every fixture has full OHLCV. `_VIX.json` (a volatility INDEX, not a
 * stock) has only `ticker`/`dates`/`closes` -- an index has no real
 * open/high/low/volume/split data. `opens`/`highs`/`lows`/`volumes`/`splits`
 * are therefore optional, and buildChart() below degrades gracefully for
 * whichever are missing rather than assuming every fixture is a full stock.
 */
export interface RawFixture {
  readonly ticker: string;
  readonly fetchedAt: string;
  readonly barCount: number;
  readonly dates: string[];
  readonly opens?: number[];
  readonly highs?: number[];
  readonly lows?: number[];
  readonly closes: number[];
  readonly volumes?: number[];
  readonly splits?: Array<{ date: number; numerator: number; denominator: number }>;
  readonly dividends?: unknown[];
}

/** The chart object the legacy engine consumes. */
export interface OracleChart {
  ticker: string;
  dates: Date[];
  opens: number[];
  highs: number[];
  lows: number[];
  closes: number[];
  volumes: number[];
  splits: Array<{ date: Date; numerator: number; denominator: number }>;
  ipoDate: Date | null;
  currentPrice: number;
  prevClose: number;
  currency: string;
}

/**
 * Tickers the end-to-end parity gate must cover.
 *
 * Present today (26 ticker files + ^VIX): 21 neutral made-up tickers (real bars) plus
 * DECK, JNJ, JPM, KO, POOL.
 *
 * MISSING and required before the gate is meaningful: GBTC, BTC, FBTC, BITB
 * -- four spot Bitcoin ETFs. IBIT is present.
 */
export const REQUIRED_HELD_FIXTURES = ['GBTC', 'BTC', 'FBTC', 'BITB', 'IBIT'] as const;

export function fixturesPresent(): boolean {
  return fs.existsSync(FIXTURE_DIR);
}

export function listFixtures(): string[] {
  if (!fixturesPresent()) return [];
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    // The core's fixtures only (core-manifest.json): a private overlay's extra price files are not test fixtures.
    .filter((f) => isCorePath('backend/legacy/historical_data/' + f))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

export function loadRawFixture(ticker: string): RawFixture {
  const file = path.join(FIXTURE_DIR, `${ticker}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`fixture not found: ${ticker} (looked in ${FIXTURE_DIR})`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as RawFixture;
}

/**
 * Builds a chart from a fixture, optionally truncated to the first `bars`
 * entries.
 *
 * Truncation matters for parity testing: running an indicator at several
 * different history lengths exercises the "insufficient data -> null"
 * branches, which is where a port is most likely to diverge.
 */
export function buildChart(raw: RawFixture, bars?: number): OracleChart {
  const n = bars ?? raw.dates.length;
  const dates = raw.dates.slice(0, n).map((d) => new Date(`${d}T00:00:00Z`));
  const closes = raw.closes.slice(0, n);

  // Indexes like VIX have no real open/high/low/volume -- fall back to the
  // close price for the price-shaped fields (a reasonable synthetic default
  // for something with no real intraday range) and to empty for volume/splits,
  // rather than assuming every fixture is a full stock.
  const opens = (raw.opens ?? closes).slice(0, n);
  const highs = (raw.highs ?? closes).slice(0, n);
  const lows = (raw.lows ?? closes).slice(0, n);
  const volumes = (raw.volumes ?? closes.map(() => 0)).slice(0, n);

  return {
    ticker: raw.ticker,
    dates,
    opens,
    highs,
    lows,
    closes,
    volumes,
    // UNIX seconds in the file, hence *1000.
    splits: (raw.splits ?? []).map((s) => ({
      date: new Date(s.date * 1000),
      numerator: s.numerator,
      denominator: s.denominator,
    })),
    ipoDate: dates[0] ?? null,
    currentPrice: closes[closes.length - 1] ?? 0,
    prevClose: closes[closes.length - 2] ?? 0,
    currency: 'USD',
  };
}

export function loadChart(ticker: string, bars?: number): OracleChart {
  return buildChart(loadRawFixture(ticker), bars);
}

/**
 * Minimum history before indicators are meaningful. 200 is the legacy
 * project's own WARMUP convention (chop_power_check.js:21), reused rather
 * than invented so parity runs compare like with like.
 */
export const WARMUP_BARS = 200;
