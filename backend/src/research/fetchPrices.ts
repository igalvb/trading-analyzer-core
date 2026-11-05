/**
 * Strategy research (owner 2026-10-28: the models must beat holding QQQ substantially). Downloads daily price
 * history (2007 to today, split-adjusted, no dividends, the same shape as backend/legacy/historical_data) for a
 * wider, less hand-picked set of large stocks, including ones that did badly. Runs on GitHub (Yahoo is not reachable
 * from every session); the result is saved by the Record workflow to the `recordings` branch.
 */

import { activeProfile } from '../profile/active.ts';
import { DOW_THEORY_TICKERS, MACRO_REGIME_TICKERS } from '../analysis/macroRegime.ts';

/**
 * The research universe, profile `research.universe` (GENERIC_PLAN P2). Owner: large US stocks across sectors,
 * winners and laggards of 2010-2026, plus the index ETFs.
 */
export const RESEARCH_UNIVERSE: readonly string[] = activeProfile().research.universe;

/**
 * G0 (docs/models/MASTER_PLAN.md section 4): the extra price history James's models need, downloaded with the research
 * set but kept OUT of RESEARCH_UNIVERSE (that list is the stock universe the research and its random bags draw from).
 * BTC-USD is spot bitcoin from 2014-09 (Yahoo has none earlier), saved as `BTC-USD.json`: the cached `BTC.json` is the
 * Grayscale Bitcoin Mini Trust fund from 2024, not spot bitcoin. Crypto bars are dated in UTC: see backtest/data.ts
 * `decisionBarIndex` for the D-1 rule (a decision at the US close of day D uses the BTC bar of D-1).
 */
export const JAMES_EXTRA_TICKERS: readonly string[] = activeProfile().research.extraTickers;

/**
 * Backlog 37 (simulation v2): the macro ETFs the engine's macro reads use (the 9-ETF regime basket, SPY already in the
 * research universe, and Dow Theory's DIA / IYT), from 2007 like the rest. The local archive
 * (legacy/historical_data/macro, from the 2026-10-27 nightly recording) starts 2016-10 only; once downloaded and
 * unpacked, `npm run backtest -- ... --macro-dir <that folder>` covers the 2010-2016 days too. Kept out of
 * RESEARCH_UNIVERSE (not stocks to pick). Market reference data, not a user's list (GENERIC_PLAN P3): taken from the
 * engine's own macro ticker lists (analysis/macroRegime.ts), never typed here.
 */
export const MACRO_EXTRA_TICKERS: readonly string[] = [...DOW_THEORY_TICKERS, ...MACRO_REGIME_TICKERS.filter((t) => t !== 'SPY')];

/** Everything `record prices` downloads: the research universe plus James's extras and the macro ETFs, once each. */
export const RESEARCH_DOWNLOAD: readonly string[] = [...new Set([...RESEARCH_UNIVERSE, ...JAMES_EXTRA_TICKERS, ...MACRO_EXTRA_TICKERS])];

/**
 * The FRED series downloaded with the prices, saved as `<id lower case>.csv`: DGS1 (G0, the 1-year Treasury, for
 * model 4) and, backlog 37, the macro reads' series (M2, the 10y-2y curve, real GDP, the 10-year yield, fed funds).
 */
export const FRED_SERIES: readonly string[] = ['DGS1', 'M2SL', 'T10Y2Y', 'GDPC1', 'DGS10', 'FEDFUNDS'];

export function fredCsvUrl(id: string): string {
  return 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + encodeURIComponent(id);
}

/** One FRED series as its CSV text (the same shape as legacy/historical_data/dgs10.csv); null on any failure. */
export async function fetchFredCsv(id: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(fredCsvUrl(id), { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const text = await res.text();
    const lines = text.trim().split(/\r?\n/);
    return lines.length > 1 && /DATE|date/.test(lines[0] as string) ? lines.join('\n') + '\n' : null;
  } catch {
    return null;
  }
}

export interface RawSeries {
  readonly ticker: string; readonly fetchedAt: string; readonly requestedStart: string;
  readonly dates: string[]; readonly opens: number[]; readonly highs: number[]; readonly lows: number[]; readonly closes: number[]; readonly volumes: number[];
  readonly splits: Array<{ date: number; numerator: number; denominator: number }>;
}

export const LONG_HISTORY_START = '2007-01-01';
const START = LONG_HISTORY_START;

/** One ticker from Yahoo's chart API; null when Yahoo has nothing usable. Bars with a missing price are dropped. */
export async function fetchOne(ticker: string, fetchImpl: typeof fetch, nowMs: number, start: string = START): Promise<RawSeries | null> {
  const p1 = Math.floor(Date.parse(start + 'T00:00:00Z') / 1000), p2 = Math.floor(nowMs / 1000);
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) + '?period1=' + p1 + '&period2=' + p2 + '&interval=1d&events=split&includePrePost=false';
  const res = await fetchImpl(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) return null;
  const r = (await res.json() as any)?.chart?.result?.[0];
  const ts: number[] = r?.timestamp ?? [], q = r?.indicators?.quote?.[0] ?? {};
  const tz: string = r?.meta?.exchangeTimezoneName ?? 'America/New_York';
  const out: RawSeries = { ticker, fetchedAt: new Date(nowMs).toISOString(), requestedStart: start, dates: [], opens: [], highs: [], lows: [], closes: [], volumes: [], splits: [] };
  ts.forEach((t, i) => {
    const c = q.close?.[i];
    if (typeof c !== 'number' || !Number.isFinite(c)) return;
    out.dates.push(new Date(t * 1000).toLocaleDateString('en-CA', { timeZone: tz }));
    out.opens.push(q.open?.[i] ?? c); out.highs.push(q.high?.[i] ?? c); out.lows.push(q.low?.[i] ?? c); out.closes.push(c); out.volumes.push(q.volume?.[i] ?? 0);
  });
  for (const s of Object.values(r?.events?.splits ?? {}) as any[]) out.splits.push({ date: s.date, numerator: s.numerator, denominator: s.denominator });
  return out.dates.length ? out : null;
}

export async function fetchAll(tickers: readonly string[], fetchImpl: typeof fetch, nowMs: number, log: (m: string) => void): Promise<RawSeries[]> {
  const out: RawSeries[] = [];
  for (const t of tickers) {
    const s = await fetchOne(t, fetchImpl, nowMs).catch(() => null);
    log(t + ': ' + (s ? s.dates.length + ' days, ' + s.dates[0] + ' to ' + s.dates[s.dates.length - 1] : 'NOT FETCHED'));
    if (s) out.push(s);
    await new Promise((r) => setTimeout(r, 300));
  }
  return out;
}
