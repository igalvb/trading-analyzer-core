/**
 * FL-12a (backlog 9): the backtest on REAL price history, a short window. Proves the point-in-time data layer
 * (no bar after the simulated day reaches the engine), determinism, and that the walk runs end to end with the
 * real engine and the real exit read.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fixturesPresent } from './fixtures.ts';
import { PointInTimeTransport, lastIndexOnOrBefore, TWO_YEAR_BARS, type PriceSeries } from '../src/backtest/data.ts';
import { runEngineDay, exitReadFor } from '../src/backtest/engineRun.ts';
import { runBacktest } from '../src/backtest/runner.ts';
import { loadAll, CachedEngineSource, TEST_A, tradeLogCsv } from '../src/backtest/run.ts';
import { backtestMain } from '../src/backtestCli.ts';

const ready = fixturesPresent();

function cutAt(s: PriceSeries, day: string): PriceSeries {
  const n = lastIndexOnOrBefore(s, day) + 1;
  return { ...s, dates: s.dates.slice(0, n), opens: s.opens.slice(0, n), highs: s.highs.slice(0, n), lows: s.lows.slice(0, n), closes: s.closes.slice(0, n), volumes: s.volumes.slice(0, n) };
}

describe('FL-12a — backtest smoke on real history', { skip: ready ? false : 'price fixtures missing' }, () => {
  const series = ready ? loadAll(['NVDA', 'AQZA', 'IBIT', ...TEST_A.universe]) : new Map();

  test('the fake network serves only bars dated on or before the day (2y window), and 404 for everything else', async () => {
    const day = '2024-06-14';
    const net = new PointInTimeTransport(series, day);
    const body = JSON.parse(net.bodyFor('NVDA') as string);
    const ts: number[] = body.chart.result[0].timestamp;
    assert.equal(ts.length, TWO_YEAR_BARS);
    assert.equal(new Date((ts.at(-1) as number) * 1000).toISOString().slice(0, 10), day);
    assert.ok(Object.values(body.chart.result[0].events.splits).every((s: any) => s.date * 1000 <= Date.parse(day + 'T23:59:59Z')), 'NVDA 10:1 split (2024-06-10) listed, nothing later');
    const ibit = JSON.parse(new PointInTimeTransport(series, '2024-01-12').bodyFor('IBIT') as string);
    assert.equal(ibit.chart.result[0].timestamp.length, 2, 'IBIT: only the 2 bars since its listing');
    assert.equal(new PointInTimeTransport(series, '2024-01-05').bodyFor('IBIT'), null, 'IBIT before its listing: no data');
    const r = await net.send({ url: 'https://financialmodelingprep.com/api/v3/profile/NVDA?apikey=x' });
    assert.equal(r.status, 404);
  });

  test('the real engine as of a day gives exactly the same reads when every bar after that day is deleted (no lookahead), and is deterministic', async () => {
    const day = '2024-06-14';
    const full = await runEngineDay(series, day, ['NVDA', 'AQZA']);
    const cut = new Map([...series].map(([k, v]) => [k, cutAt(v, day)]));
    assert.deepEqual(await runEngineDay(cut, day, ['NVDA', 'AQZA']), full);
    assert.deepEqual(await runEngineDay(series, day, ['NVDA', 'AQZA']), full);
    for (const r of full) {
      assert.equal(r.ok, true);
      assert.equal(typeof r.finalConviction, 'number');
      assert.ok(['ALL_AGREE', 'MAJORITY', 'SPLIT', 'NO_CONSENSUS'].includes(r.verdict as string));
      assert.equal(r.ownScore, null, 'fundamentals are excluded (4a)');
    }
    const ibit = (await runEngineDay(series, '2024-01-12', ['IBIT']))[0]!;
    assert.equal(ibit.ok, false, 'a ticker with fewer than 60 bars gets no decision');
  });

  test('the exit read works for an entry older than the 2y window, and does not see later bars', () => {
    const a = exitReadFor(series.get('NVDA'), '2026-07-31', '2024-01-03', 47.5);
    assert.equal(a.ok, true, String(a.error));
    assert.ok(['EXIT', 'TRIM', 'HOLD'].includes(a.actionClass as string));
    const day = '2025-03-03';
    assert.deepEqual(exitReadFor(cutAt(series.get('NVDA'), day), day, '2024-02-01', 60), exitReadFor(series.get('NVDA'), day, '2024-02-01', 60));
  });

  test('a short Test A walk runs end to end with the real engine: fills on trading days, cash never negative, CSV log', async () => {
    const src = new CachedEngineSource(series);
    const r = await runBacktest(series, src, { name: 'smoke', universe: TEST_A.universe, start: '2024-04-01', end: '2024-04-19', cash: 100_000, policy: { maxPositions: 6 }, taxRate: 0.25, calendar: 'SPY' });
    assert.equal(r.days, 15);
    assert.equal(r.engineCalls + r.exitReads > 0, true);
    for (const t of r.trades) {
      assert.ok(series.get(t.ticker)!.dates.includes(t.day));
      assert.ok(t.cashAfter >= -1e-6);
      assert.ok(t.day > '2024-04-01');
    }
    assert.ok(r.maxOpenPositions <= 6);
    const csv = tradeLogCsv(r);
    assert.equal(csv.split('\n')[0], 'day,side,ticker,shares,price,value,cost_basis,realized_gain,tax,cash_after,reason,trip_return_pct,qqq_same_days_pct');
    assert.equal(csv.trim().split('\n').length, r.trades.length + 1);
  });

  test('the CLI refuses bad arguments', async () => {
    const err: string[] = [];
    assert.equal(await backtestMain(['C'], { out: () => {}, err: (s) => { err.push(s); } }), 2);
    assert.equal(await backtestMain(['A', '--cache'], { out: () => {}, err: (s) => { err.push(s); } }), 2);
    assert.match(err.join(''), /Usage: npm run backtest/);
  });
});
