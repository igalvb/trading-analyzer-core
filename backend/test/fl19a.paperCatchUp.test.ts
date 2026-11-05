/**
 * FL-19a: the paper test catches up missed nights (owner 2026-11-04: no nightly ran 2-4 Nov and Mon 2 Nov was never
 * recorded). Each run handles every trading day since the last one handled, in order, decided at its close and
 * filled at the next open; the result equals running night by night. At most PAPER_CATCH_UP_DAYS per run.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runPaperNight, loadPaper, PAPER_CATCH_UP_DAYS, PAPER_TAB, PAPER_STATE_TAB, type PaperJobDeps } from '../src/paper/paperJob.ts';
import { LOG_TAB, READS_TAB, VALUES_TAB } from '../src/paper/paperLog.ts';
import { PAPER_DECIDE_FROM } from '../src/paper/paperTrading.ts';
import { engineReadOf, type EngineRead } from '../src/backtest/engineRun.ts';
import type { PriceSeries } from '../src/backtest/data.ts';
import { MemoryTabStore } from '../src/storage/tabStore.ts';
import { isTradingDay, nextTradingDay } from '../src/live/marketCalendar.ts';
import type { FetchedChart } from '../src/types/chart.ts';
import type { TickerArtifacts } from '../src/analysis/runTicker.ts';

const TZ = 'America/New_York';
const LAST = '2026-11-30';
const DAYS: string[] = [];
for (let d = '2024-06-03'; d <= LAST; d = nextTradingDay(d)) if (isTradingDay(d)) DAYS.push(d);

const hash = (s: string): number => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h; };
const rnd = (s: string): number => (hash(s) % 100_000) / 100_000;

/** A deterministic random walk per ticker over DAYS. */
const BARS = new Map<string, { opens: number[]; highs: number[]; lows: number[]; closes: number[]; volumes: number[] }>();
function barsOf(t: string): NonNullable<ReturnType<typeof BARS.get>> {
  let b = BARS.get(t);
  if (b) return b;
  b = { opens: [], highs: [], lows: [], closes: [], volumes: [] };
  let px = 50 + (hash(t) % 400);
  for (const d of DAYS) {
    const open = px * (1 + (rnd(t + d + 'o') - 0.5) * 0.02);
    const close = open * (1 + (rnd(t + d + 'c') - 0.48) * 0.05);
    b.opens.push(open); b.closes.push(close); b.highs.push(Math.max(open, close) * 1.01); b.lows.push(Math.min(open, close) * 0.99);
    b.volumes.push(1_000_000 + (hash(t + d) % 500_000));
    px = close;
  }
  BARS.set(t, b);
  return b;
}

function chartUpTo(t: string, day: string): FetchedChart {
  const n = DAYS.filter((d) => d <= day).length, b = barsOf(t);
  return {
    ticker: t, dates: DAYS.slice(0, n).map((d) => new Date(d + 'T20:00:00Z')), opens: b.opens.slice(0, n), highs: b.highs.slice(0, n), lows: b.lows.slice(0, n),
    closes: b.closes.slice(0, n), volumes: b.volumes.slice(0, n), splits: [], ipoDate: null, currentPrice: b.closes[n - 1]!, prevClose: b.closes[n - 2], currency: 'USD',
  };
}

const DIRS = ['bullish', 'mixed', 'cautionary'] as const;
/** What the engine "said" about a ticker on a day: a pure function of (ticker, day), so tonight's and a missed day's reads agree. */
function artOf(t: string, day: string): TickerArtifacts {
  const close = barsOf(t).closes[DAYS.indexOf(day)]!;
  const conv = Math.round(40 + rnd(t + day + 'conv') * 50);
  const dir = (k: string): string => DIRS[hash(t + day + k) % 3]!;
  return {
    result: {
      fundResult: { score: 60 }, decision: { finalConviction: conv, action: conv >= 70 ? 'BUY' : 'WATCH' },
      techPlan: { timing: conv >= 70 ? 'BUY_NOW' : 'WAIT_PULLBACK', regime: 'UPTREND', entryPrice: close, entryHigh: close * 1.01, entryConfidencePct: 60, stop: close * 0.9, t1: { price: close * 1.1 }, t2: { price: close * 1.2 }, rrToT1: 2, t1Time: { baseDays: 20 } },
    },
    reports: { comparison: { verdict: 'MAJORITY', existingDirection: dir('e'), newDirection: dir('n'), schabackerDirection: dir('s'), edwardsMageeDirection: dir('m'), turtleDirection: dir('t') } },
    confluence: { entryLow: close * 0.97, entryHigh: close * 1.01, entryCount: 3 },
    ind: {},
  } as unknown as TickerArtifacts;
}

const tonight = (day: string): number => Date.parse(day + 'T23:30:00Z');

function deps(store: MemoryTabStore, night: string, missedDays: string[] = []): PaperJobDeps {
  return {
    store, timeZone: TZ, watchlist: [], log: () => {}, now: () => tonight(night),
    fetchChart: async (t) => chartUpTo(t, night),
    analysis: async (t) => artOf(t, night),
    readsAt: async (series: ReadonlyMap<string, PriceSeries>, day: string, tickers: readonly string[]): Promise<EngineRead[]> => {
      missedDays.push(day);
      for (const s of series.values()) assert.ok((s.dates[s.dates.length - 1] as string) <= day, 'a missed day never sees a later bar');
      return tickers.map((t) => engineReadOf(artOf(t, day), t, day, series.get(t)?.closes[series.get(t)!.dates.lastIndexOf(day)] ?? null));
    },
  };
}

async function tabs(store: MemoryTabStore): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const t of [LOG_TAB, READS_TAB, VALUES_TAB, PAPER_TAB]) out[t] = await store.read(t, 40);
  out.state = await loadPaper(store);
  return out;
}

const nights = (from: string, to: string): string[] => DAYS.filter((d) => d >= from && d <= to);

describe('FL-19a — paper test catch-up', () => {
  test('missed nights are filled in order and the result equals running night by night', async () => {
    const a = new MemoryTabStore();
    for (const n of nights(PAPER_DECIDE_FROM, '2026-11-05')) await runPaperNight(deps(a, n));

    const b = new MemoryTabStore();
    for (const n of nights(PAPER_DECIDE_FROM, '2026-10-30')) await runPaperNight(deps(b, n));
    const missed: string[] = [];
    const out = await runPaperNight(deps(b, '2026-11-05', missed));
    assert.deepEqual(missed, ['2026-11-02', '2026-11-03', '2026-11-04'], 'the missed days, oldest first, tonight from the live analysis');
    assert.match(out, /caught up 3 missed day\(s\): 2026-11-02, 2026-11-03, 2026-11-04/);
    const values = ((await b.read(VALUES_TAB, 1)) ?? []).slice(1).map((r) => String(r[0]));
    assert.deepEqual([...new Set(values)], ['2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']);
    const sa = await tabs(a), sb = await tabs(b);
    assert.ok(((sa.state as { trades: unknown[] }).trades).length > 0, 'the fixture trades');
    assert.deepEqual(sb, sa);
    assert.match(await runPaperNight(deps(b, '2026-11-05')), /no new trading day/);
  });

  test('a long gap is handled at most PAPER_CATCH_UP_DAYS a run, in order, and still ends equal to night by night', async () => {
    const a = new MemoryTabStore();
    for (const n of nights(PAPER_DECIDE_FROM, '2026-11-25')) await runPaperNight(deps(a, n));

    const b = new MemoryTabStore();
    await runPaperNight(deps(b, PAPER_DECIDE_FROM));
    const missed: string[] = [];
    await runPaperNight(deps(b, '2026-11-25', missed));
    const gap = nights('2026-10-29', '2026-11-25');
    assert.ok(gap.length > PAPER_CATCH_UP_DAYS);
    assert.deepEqual(missed, gap.slice(0, PAPER_CATCH_UP_DAYS));
    assert.equal((await loadPaper(b))!.state.lastDay, gap[PAPER_CATCH_UP_DAYS - 1]);
    await runPaperNight(deps(b, '2026-11-25', missed));
    assert.deepEqual(missed, gap.slice(0, -1), 'the rest on the next run; tonight from the live analysis');
    assert.deepEqual(await tabs(b), await tabs(a));
    assert.ok((await b.read(PAPER_STATE_TAB, 1))!.length > 0);
  });
});
