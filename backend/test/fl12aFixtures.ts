/** FL-12a test helpers: mock engine reads, mock exit reads and synthetic price series. */
import type { EngineRead, ExitReadResult } from '../src/backtest/engineRun.ts';
import type { PriceSeries } from '../src/backtest/data.ts';

export function read(over: Partial<EngineRead> = {}): EngineRead {
  return {
    ticker: 'AAA', day: '2024-03-01', ok: true, finalConviction: 60, action: 'x', timing: 'BUY_NOW', regime: 'TREND_UP',
    entryPrice: 100, entryHigh: 101, entryConfidencePct: 50, stop: 95, ownScore: null, blocked: false,
    verdict: 'MAJORITY', directions: {}, close: 100, ...over,
  };
}

export function exitRead(over: Partial<ExitReadResult> = {}): ExitReadResult {
  return {
    ticker: 'AAA', day: '2024-04-01', ok: true, actionClass: 'HOLD', recommendation: 'HOLD', stopBreached: false, thesisInvalidated: false,
    hitT1: false, hitT2: false, t1: 120, t2: 140, stopLevel: 90, close: 110, ...over,
  };
}

/** Weekdays from `start` ('YYYY-MM-DD'), `n` of them. */
export function weekdays(start: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(start + 'T00:00:00Z');
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** A series whose open on day i is opens(i) and close closes(i) (highs/lows bracket both). */
export function synthSeries(ticker: string, dates: readonly string[], opens: (i: number) => number, closes: (i: number) => number = opens): PriceSeries {
  const o = dates.map((_, i) => opens(i)), c = dates.map((_, i) => closes(i));
  return {
    ticker, dates, opens: o, closes: c,
    highs: dates.map((_, i) => Math.max(o[i] as number, c[i] as number) + 1),
    lows: dates.map((_, i) => Math.min(o[i] as number, c[i] as number) - 1),
    volumes: dates.map(() => 1_000_000), splits: [],
  };
}
