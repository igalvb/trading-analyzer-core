/**
 * docs/LONG_HISTORY_PLAN.md: the long price history store, its merge in front of the 2-year cache, the backfill /
 * append command, and the flag (OFF by default: the composed fetchChart is the cache alone).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DirLongHistoryStore, LONG_HISTORY_DEFAULT_DIR, LONG_HISTORY_META, longHistoryFromEnv, mergeLongHistory, seriesFromCsv, seriesFromJson,
  seriesToCsv, withLongHistory, type LongSeries,
} from '../src/storage/longHistory.ts';
import { appendRecent, longHistoryMain, longHistoryTickers } from '../src/longHistory.ts';
import { composeServices } from '../src/compose.ts';
import { BACKTEST_ENV } from '../src/backtest/engineRun.ts';
import { PointInTimeTransport, TWO_YEAR_BARS, type PriceSeries } from '../src/backtest/data.ts';
import { LogLevel } from '../src/core/logger.ts';
import type { FetchedChart } from '../src/types/chart.ts';

/** Weekdays from 2015-01-05, n of them, close = 100 + i (times `scale` from bar `from` on). */
function days(n: number): string[] {
  const out: string[] = [];
  for (let t = Date.UTC(2015, 0, 5); out.length < n; t += 864e5) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
function longOf(ticker: string, ds: readonly string[], scale = 1): LongSeries {
  const c = ds.map((_, i) => (100 + i) * scale);
  return { ticker, dates: ds, opens: c, highs: c.map((x) => x + 1), lows: c.map((x) => x - 1), closes: c, volumes: ds.map(() => 1000), splits: [] };
}
function chartOf(ticker: string, ds: readonly string[], offset: number): FetchedChart {
  const c = ds.map((_, i) => 100 + offset + i);
  return {
    ticker, dates: ds.map((d) => new Date(d + 'T14:30:00Z')), opens: c, highs: c.map((x) => x + 1), lows: c.map((x) => x - 1), closes: c,
    volumes: ds.map(() => 500), splits: [], ipoDate: null, currentPrice: c[c.length - 1]!, prevClose: c[c.length - 2], currency: 'USD',
  };
}

describe('LONG_HISTORY flag', () => {
  test('off unless LONG_HISTORY=on; the folder defaults next to backend/', () => {
    assert.deepEqual(longHistoryFromEnv({}), { on: false, dir: LONG_HISTORY_DEFAULT_DIR });
    assert.equal(longHistoryFromEnv({ LONG_HISTORY: 'yes' }).on, false);
    assert.deepEqual(longHistoryFromEnv({ LONG_HISTORY: ' ON ', LONG_HISTORY_DIR: '/x' }), { on: true, dir: '/x' });
  });

  test('composeServices: off = the 2-year cache alone; on = the long file in front, cache bars unchanged', async () => {
    const ds = days(1500);
    const s: PriceSeries = { ...longOf('XYZ', ds), splits: [] };
    const series = new Map<string, PriceSeries>([['XYZ', s]]);
    const day = ds[ds.length - 1]!;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-'));
    fs.writeFileSync(path.join(dir, 'XYZ.csv'), seriesToCsv(longOf('XYZ', ds.slice(0, 1200))));
    const run = async (extra: Record<string, string>) => {
      const sv = await composeServices({
        storage: 'memory', env: { ...BACKTEST_ENV, ...extra }, transport: new PointInTimeTransport(series, day), clock: { now: () => Date.parse(day + 'T23:00:00Z') },
        noAi: true, logSink: () => {}, logLevel: LogLevel.ERROR, sleep: async () => {}, mode: 'ticker',
      });
      return sv.fetchChart('XYZ');
    };
    const off = await run({ LONG_HISTORY_DIR: dir });
    assert.equal(off!.closes.length, TWO_YEAR_BARS);
    const on = await run({ LONG_HISTORY: 'on', LONG_HISTORY_DIR: dir });
    assert.equal(on!.closes.length, 1500);
    assert.deepEqual(on!.closes.slice(-TWO_YEAR_BARS), off!.closes);
    assert.deepEqual(on!.closes.slice(0, 3), [100, 101, 102]);
    assert.equal(on!.currentPrice, off!.currentPrice);
    // a ticker without a file: the cache alone
    const missing = await run({ LONG_HISTORY: 'on', LONG_HISTORY_DIR: path.join(dir, 'none') });
    assert.equal(missing!.closes.length, TWO_YEAR_BARS);
  });
});

describe('mergeLongHistory', () => {
  const ds = days(800);
  const chart = chartOf('ABC', ds.slice(300), 300);

  test('the older bars go in front; the cache is kept exactly', () => {
    const r = mergeLongHistory(longOf('ABC', ds.slice(0, 600)), chart);
    assert.equal(r.added, 300);
    assert.equal(r.factor, 1);
    assert.equal(r.chart.closes.length, 800);
    assert.deepEqual(r.chart.closes.slice(300), chart.closes);
    assert.deepEqual(r.chart.dates.slice(300), chart.dates);
    assert.deepEqual(r.chart.volumes.slice(0, 2), [1000, 1000]);
    assert.equal(r.chart.dates[299]!.toISOString().slice(0, 10), ds[299]);
    assert.equal(r.chart.currentPrice, chart.currentPrice);
    assert.equal(chart.closes.length, 500, 'the cache object is not changed');
  });

  test('a split after the file was written: one steady factor on the overlap is applied to the older bars', () => {
    const r = mergeLongHistory(longOf('ABC', ds.slice(0, 600), 4), chart); // file 4x the adjusted prices (a 4:1 split since)
    assert.equal(r.factor, 0.25);
    assert.equal(r.chart.closes[0], 100);
    assert.equal(r.chart.volumes[0], 4000);
  });

  test('no merge: no file, no overlap, a disagreeing overlap, a file starting after the cache', () => {
    assert.equal(mergeLongHistory(null, chart).chart, chart);
    assert.match(mergeLongHistory(longOf('ABC', ds.slice(0, 300)), chart).skipped ?? '', /overlap on 0 days/);
    const bad = longOf('ABC', ds.slice(0, 600));
    const noisy = { ...bad, closes: bad.closes.map((c, i) => (i % 2 ? c * 1.2 : c)) };
    assert.match(mergeLongHistory(noisy, chart).skipped ?? '', /disagree/);
    assert.match(mergeLongHistory(longOf('ABC', ds.slice(400)), chart).skipped ?? '', /starts after/);
  });

  test('withLongHistory: null passes through, the reason is logged once per ticker', async () => {
    const logs: string[] = [];
    const store = { read: async () => longOf('ABC', ds.slice(0, 600)) };
    const f = withLongHistory(async (t) => (t === 'ABC' ? chart : null), store, (m) => logs.push(m));
    assert.equal((await f('ABC'))!.closes.length, 800);
    await f('ABC');
    assert.equal(await f('NONE'), null);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /300 older bars/);
  });
});

describe('the files', () => {
  test('CSV round trip, research JSON, and the folder store (CSV with _meta.json splits, JSON, missing)', async () => {
    const s = longOf('^VIX', days(10));
    const back = seriesFromCsv('^VIX', seriesToCsv(s));
    assert.deepEqual(back, s);
    assert.equal(seriesFromCsv('X', 'Date,Close\n2020-01-01,1\n'), null);
    assert.equal(seriesFromJson('X', { dates: ['2020-01-02', '2020-01-01'], closes: [1, 2] }), null);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-'));
    fs.writeFileSync(path.join(dir, '_VIX.csv'), seriesToCsv(s));
    fs.writeFileSync(path.join(dir, LONG_HISTORY_META), JSON.stringify({ '^VIX': { fetchedAt: 'x', splits: [{ date: 1, numerator: 2, denominator: 1 }] } }));
    fs.writeFileSync(path.join(dir, 'R.json'), JSON.stringify({ dates: ['2020-01-01'], closes: [5] }));
    const st = new DirLongHistoryStore(dir);
    assert.equal((await st.read('^VIX'))!.splits.length, 1);
    assert.deepEqual((await st.read('R'))!.volumes, [0]);
    assert.equal(await st.read('NONE'), null);
  });
});

/** A Yahoo chart body for `fetchOne` (research/fetchPrices.ts): bars from the period1 in the URL on. */
function fakeYahoo(all: LongSeries, scale = 1): typeof fetch {
  return (async (url: string) => {
    const p1 = Number(/period1=(\d+)/.exec(String(url))![1]);
    const idx = all.dates.map((d, i) => [d, i] as const).filter(([d]) => Date.parse(d + 'T00:00:00Z') / 1000 >= p1).map(([, i]) => i);
    const body = { chart: { result: [{ meta: { exchangeTimezoneName: 'UTC' }, timestamp: idx.map((i) => Date.parse(all.dates[i] + 'T12:00:00Z') / 1000),
      indicators: { quote: [{ open: idx.map((i) => all.opens[i]! * scale), high: idx.map((i) => all.highs[i]! * scale), low: idx.map((i) => all.lows[i]! * scale), close: idx.map((i) => all.closes[i]! * scale), volume: idx.map((i) => all.volumes[i]) }] } }] } };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('npm run long-history', () => {
  const ds = days(300);
  const io = (f: typeof fetch, log: string[] = []) => ({ fetchImpl: f, now: () => Date.parse('2016-03-01T00:00:00Z'), log: (m: string) => { log.push(m); } });

  test('usage, backfill, append (new bars only), append after a split (full again), check', async () => {
    assert.equal(await longHistoryMain(['nope'], io(fakeYahoo(longOf('A', ds)))), 2);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-'));
    const log: string[] = [];
    assert.equal(await longHistoryMain(['backfill', dir, 'a'], io(fakeYahoo(longOf('A', ds.slice(0, 250))), log)), 0);
    assert.equal(seriesFromCsv('A', fs.readFileSync(path.join(dir, 'A.csv'), 'utf8'))!.dates.length, 250);
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir, LONG_HISTORY_META), 'utf8')).A);
    assert.equal(await longHistoryMain(['append', dir, 'A'], io(fakeYahoo(longOf('A', ds)), log)), 0);
    const after = seriesFromCsv('A', fs.readFileSync(path.join(dir, 'A.csv'), 'utf8'))!;
    assert.equal(after.dates.length, 300);
    assert.match(log.find((l) => l.startsWith('A: +'))!, /A: \+50, 300 days/);
    assert.equal(await longHistoryMain(['append', dir, 'A'], io(fakeYahoo(longOf('A', ds), 0.5), log)), 0);
    assert.match(log[log.length - 2]!, /full \(the recent bars disagree/);
    assert.equal(seriesFromCsv('A', fs.readFileSync(path.join(dir, 'A.csv'), 'utf8'))!.closes[0], 50);
    const chk: string[] = [];
    assert.equal(await longHistoryMain(['check', dir], io(fakeYahoo(longOf('A', ds)), chk)), 0);
    assert.match(chk.join('\n'), /A: 300 days/);
  });

  test('appendRecent needs an agreeing overlap', () => {
    const f = longOf('A', ds.slice(0, 200));
    assert.equal(appendRecent(f, longOf('A', ds.slice(250))), 'refetch');
    const r = appendRecent(f, longOf('A', ds.slice(0, 220)));
    assert.ok(r !== 'refetch' && r.added === 20 && r.series.dates.length === 220);
  });

  test('the default set holds the context charts once each', () => {
    const t = longHistoryTickers();
    for (const x of ['SPY', 'QQQ', '^VIX']) assert.ok(t.includes(x));
    assert.equal(new Set(t).size, t.length);
  });
});
