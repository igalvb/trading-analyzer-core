/**
 * FL-37a (backlog 37, simulation v2): the point-in-time macro builder. The macro archive (Nasdaq ETF history, FRED
 * CSVs) is served as of the simulated day, and the nightly's own refresh fills the caches from it. Proves there is no
 * look-ahead: no ETF bar after the day, no FRED observation before it was published, and the same macro read (and
 * engine read) whether or not the archive holds anything after the day.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  firstUsableDay, fredRowsAsOf, fredCsvAsOf, parseFredCsv, nasdaqHistoricalBodyAsOf, macroBodyAsOf, loadMacroArchive, MACRO_DIR, MACRO_ETFS, MACRO_FRED_SERIES,
  FRED_RELEASE_RULES, macroResponder, type MacroArchive, type FredRow,
} from '../src/backtest/macroData.ts';
import { PointInTimeTransport, lastIndexOnOrBefore, type PriceSeries } from '../src/backtest/data.ts';
import { BACKTEST_ENV, seedMacroCaches, runEngineDay } from '../src/backtest/engineRun.ts';
import { loadAll, maxDrawdownPct, OWNER_14_SPECS } from '../src/backtest/run.ts';
import { backtestMain } from '../src/backtestCli.ts';
import { composeServices } from '../src/compose.ts';
import { LogLevel } from '../src/core/logger.ts';
import { readMacroSnapshot } from '../src/storage/macroCaches.ts';
import { parseNasdaqHistorical, nasdaqHistoricalUrl } from '../src/fetch/macro/nasdaq.ts';
import { FRED_CSV_URL } from '../src/fetch/macro/fred.ts';
import { fixturesPresent } from './fixtures.ts';

/** Weekdays from `from`, `n` of them. */
function weekdays(from: string, n: number): string[] {
  const out: string[] = [];
  for (let t = Date.parse(from + 'T00:00:00Z'); out.length < n; t += 86_400_000) {
    const d = new Date(t).getUTCDay();
    if (d >= 1 && d <= 5) out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

function synthSeries(t: string, dates: readonly string[], k: number): PriceSeries {
  const closes = dates.map((_, i) => 100 + k * 3 + Math.sin(i / (5 + k)) * 8 + i * (k % 3 === 0 ? 0.05 : -0.02));
  return { ticker: t, dates, opens: closes, highs: closes.map((c) => c + 1), lows: closes.map((c) => c - 1), closes, volumes: closes.map(() => 1000), splits: [] };
}

function monthly(from: number, to: number, months: number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]): string[] {
  const out: string[] = [];
  for (let y = from; y <= to; y++) for (const m of months) out.push(y + '-' + String(m + 1).padStart(2, '0') + '-01');
  return out;
}

/** A synthetic archive: every ETF over 2022-2025 weekdays, every FRED series with plausible rows. */
function synthArchive(): MacroArchive {
  const dates = weekdays('2022-01-03', 1000);
  const etfs = new Map(MACRO_ETFS.map((t, k) => [t, synthSeries(t, dates, k)] as const));
  const fred = new Map<string, FredRow[]>([
    ['M2SL', monthly(2020, 2025).map((d, i) => ({ date: d, raw: String(20000 + i * 25) }))],
    ['GDPC1', monthly(2019, 2025, [0, 3, 6, 9]).map((d, i) => ({ date: d, raw: String(20000 + i * 90) }))],
    ['FEDFUNDS', monthly(2020, 2025).map((d, i) => ({ date: d, raw: (i / 20).toFixed(2) }))],
    ['T10Y2Y', dates.map((d, i) => ({ date: d, raw: i % 50 === 7 ? '' : (Math.cos(i / 30) / 2).toFixed(2) }))],
    ['DGS10', dates.map((d, i) => ({ date: d, raw: (3 + Math.sin(i / 40)).toFixed(2) }))],
  ]);
  return { etfs, fred };
}

/** The archive with everything after `day` deleted (ETF bars dated after it; FRED rows observed after it). */
function cutArchive(a: MacroArchive, day: string): MacroArchive {
  const etfs = new Map([...a.etfs].map(([t, s]) => {
    const n = lastIndexOnOrBefore(s, day) + 1;
    return [t, { ...s, dates: s.dates.slice(0, n), opens: s.opens.slice(0, n), highs: s.highs.slice(0, n), lows: s.lows.slice(0, n), closes: s.closes.slice(0, n), volumes: s.volumes.slice(0, n) }] as const;
  }));
  const fred = new Map([...a.fred].map(([id, rows]) => [id, rows.filter((r) => r.date <= day)] as const));
  return { etfs, fred };
}

/** The archive with every not-yet-published value (and every later bar) replaced by nonsense. */
function poisonArchive(a: MacroArchive, day: string): MacroArchive {
  const etfs = new Map([...a.etfs].map(([t, s]) => [t, { ...s, closes: s.closes.map((c, i) => ((s.dates[i] as string) > day ? c * 7 : c)) }] as const));
  const fred = new Map([...a.fred].map(([id, rows]) => {
    const pub = new Set(fredRowsAsOf(id, rows, day).map((r) => r.date));
    return [id, rows.map((r) => (pub.has(r.date) ? r : { date: r.date, raw: '-999' }))] as const;
  }));
  return { etfs, fred };
}

/** The day's macro read after the production refresh, as JSON. */
async function macroReadAsOf(archive: MacroArchive, day: string, prices: ReadonlyMap<string, PriceSeries> = new Map()): Promise<string> {
  const nowMs = Date.parse(day + 'T23:00:00Z');
  const s = await composeServices({ storage: 'memory', env: BACKTEST_ENV, transport: new PointInTimeTransport(prices, day, macroResponder(archive)), clock: { now: () => nowMs }, noAi: true, logSink: () => {}, logLevel: LogLevel.ERROR, sleep: async () => {}, mode: 'ticker' });
  await seedMacroCaches(s);
  const m = await s.getMacro();
  const snap = await readMacroSnapshot(s.tabStore, nowMs);
  return JSON.stringify({ m, snap: snap ? { dgs10: snap.dgs10, fedfunds: snap.fedfunds, gdp: snap.gdpSeries } : null });
}

describe('FL-37a — point-in-time macro reads (simulation v2)', () => {
  test('FRED release lags: a value is never usable before it was published', () => {
    assert.equal(firstUsableDay('2024-05-31', 'nextDay'), '2024-06-01');
    assert.equal(firstUsableDay('2024-12-31', 'nextDay'), '2025-01-01');
    assert.equal(firstUsableDay('2024-04-01', 'monthPlus2'), '2024-06-01', 'April M2 (H.6, late May) from June 1st');
    assert.equal(firstUsableDay('2024-11-01', 'monthPlus2'), '2025-01-01');
    assert.equal(firstUsableDay('2024-01-01', 'monthPlus4'), '2024-05-01', 'Q1 GDP (advance estimate late April) from May 1st');
    assert.equal(firstUsableDay('2024-10-01', 'monthPlus4'), '2025-02-01');
    assert.equal(firstUsableDay('2024-12-01', 'monthPlus1Day8'), '2025-01-08');
    assert.deepEqual({ ...FRED_RELEASE_RULES }, { T10Y2Y: 'nextDay', DGS10: 'nextDay', FEDFUNDS: 'monthPlus1Day8', M2SL: 'monthPlus2', GDPC1: 'monthPlus4' });
    const rows: FredRow[] = [{ date: '2024-03-01', raw: '1' }, { date: '2024-04-01', raw: '2' }, { date: '2024-05-01', raw: '3' }];
    assert.deepEqual(fredRowsAsOf('M2SL', rows, '2024-05-31').map((r) => r.date), ['2024-03-01']);
    assert.deepEqual(fredRowsAsOf('M2SL', rows, '2024-06-01').map((r) => r.date), ['2024-03-01', '2024-04-01']);
    assert.deepEqual(fredRowsAsOf('UNKNOWN', rows, '2024-07-31').map((r) => r.date), ['2024-03-01'], 'an unknown series gets the strictest lag');
    assert.equal(fredCsvAsOf('M2SL', rows, '2024-04-30'), null, 'nothing public yet: no body (404)');
    assert.equal(fredCsvAsOf('M2SL', rows, '2024-06-01'), 'observation_date,M2SL\n2024-03-01,1\n2024-04-01,2\n');
    assert.deepEqual(parseFredCsv('observation_date,X\n2024-01-01,1.5\n2024-01-02,\n'), [{ date: '2024-01-01', raw: '1.5' }, { date: '2024-01-02', raw: '' }]);
  });

  test('the Nasdaq body holds the bars dated on or before the day, newest first, and parses back through the production parser', () => {
    const s = synthSeries('DIA', weekdays('2024-01-01', 30), 1);
    const day = s.dates[19] as string;
    const body = nasdaqHistoricalBodyAsOf(s, day) as string;
    const rows = JSON.parse(body).data.tradesTable.rows;
    assert.equal(rows.length, 20);
    assert.equal(rows[0].date, day.slice(5, 7) + '/' + day.slice(8, 10) + '/' + day.slice(0, 4), 'newest first');
    const parsed = parseNasdaqHistorical('DIA', 200, body, () => {}) as NonNullable<ReturnType<typeof parseNasdaqHistorical>>;
    assert.equal(parsed.dates.length, 20);
    assert.equal(parsed.dates.at(-1)!.toISOString().slice(0, 10), day);
    assert.ok(Math.abs((parsed.closes.at(-1) as number) - (s.closes[19] as number)) < 1e-3);
    assert.equal(nasdaqHistoricalBodyAsOf(s, '2023-12-29'), null, 'before the first bar: nothing');
  });

  test('requests are routed: the Nasdaq historical URL and the FRED CSV URL, everything else 404', async () => {
    const a = synthArchive();
    const day = '2024-06-14';
    assert.ok(macroBodyAsOf(a, nasdaqHistoricalUrl('IYT'), day));
    assert.equal(macroBodyAsOf(a, nasdaqHistoricalUrl('QQQ'), day), null, 'not in the archive');
    assert.match(macroBodyAsOf(a, FRED_CSV_URL + 'GDPC1', day) as string, /^observation_date,GDPC1\n/);
    assert.equal(macroBodyAsOf(a, FRED_CSV_URL + 'DGS1', day), null);
    const net = new PointInTimeTransport(new Map(), day, macroResponder(a));
    assert.equal((await net.send({ url: FRED_CSV_URL + 'M2SL' })).status, 200);
    assert.equal((await net.send({ url: 'https://financialmodelingprep.com/stable/profile?symbol=X' })).status, 404);
    assert.equal((await new PointInTimeTransport(new Map(), day).send({ url: FRED_CSV_URL + 'M2SL' })).status, 404, 'no archive: v1, macro is a 404');
  });

  test('the refreshed macro read is identical with the archive cut at the day, and with every unpublished value poisoned (no look-ahead)', async () => {
    const a = synthArchive();
    for (const day of ['2023-03-15', '2024-06-03', '2025-02-03']) {
      const full = await macroReadAsOf(a, day);
      assert.equal(await macroReadAsOf(cutArchive(a, day), day), full, day + ': cut');
      assert.equal(await macroReadAsOf(poisonArchive(a, day), day), full, day + ': poisoned');
      const m = JSON.parse(full).m;
      assert.equal(m.available, true, day + ': regime available');
      assert.ok(['RISK_ON', 'RISK_OFF', 'NEUTRAL'].includes(m.regime));
      assert.ok(m.supplemental.m2AsOfDate && firstUsableDay(m.supplemental.m2AsOfDate, 'monthPlus2') <= day, 'M2 as of a published month');
      assert.ok(m.supplemental.yieldCurveAsOfDate < day, 'yield curve from before the day');
      assert.ok(m.dowTheory.verdict, 'Dow Theory read');
      assert.ok(String(m.dowTheory.asOfDate).slice(0, 10) <= day);
    }
    // and a later value DOES change it (the read is live, not frozen)
    assert.notEqual(await macroReadAsOf(a, '2024-06-03'), await macroReadAsOf(a, '2024-09-03'));
  });

  test('a missing series reads as unavailable (stated, neutral), the others still read', async () => {
    const a = synthArchive();
    const noTlt: MacroArchive = { etfs: new Map([...a.etfs].filter(([t]) => t !== 'TLT')), fred: new Map([...a.fred].filter(([id]) => id !== 'M2SL')) };
    const m = JSON.parse(await macroReadAsOf(noTlt, '2024-06-03')).m;
    assert.equal(m.available, false, 'regime unavailable without TLT (adds 0 to the conviction)');
    assert.equal(m.supplemental.m2YoyGrowthPct, null, 'no M2');
    assert.ok(m.supplemental.yieldCurveSpread != null, 'yield curve still read');
    assert.ok(m.dowTheory.verdict, 'Dow Theory still read');
    const before = JSON.parse(await macroReadAsOf(a, '2022-01-10')).m;
    assert.equal(before.available, false, 'fewer than 21 bars: regime unavailable');
    assert.equal(before.dowTheory.verdict, null, 'less than a year: no Dow Theory');
  });

  test('house rule helpers: the deepest fall over the marks; owner14 specs; the CLI refuses owner14 without a price folder', async () => {
    assert.equal(maxDrawdownPct([{ equity: 100 }, { equity: 120 }, { equity: 90 }, { equity: 130 }, { equity: 117 }]), 25);
    assert.equal(maxDrawdownPct([]), 0);
    assert.deepEqual(OWNER_14_SPECS.map((s) => [s.name, s.start, s.end, s.universe.length, s.maxPositions]), [
      ['owner14 2010-2019', '2010-01-01', '2019-12-31', 14, 6], ['owner14 2020-2023', '2020-01-01', '2023-12-31', 14, 6], ['owner14 2024-2026', '2024-01-01', '2026-10-27', 14, 6]]);
    const err: string[] = [];
    assert.equal(await backtestMain(['owner14'], { out: () => {}, err: (s) => err.push(s) }), 2);
    assert.match(err.join(''), /--no-macro/);
  });

  const realOk = fixturesPresent() && MACRO_ETFS.every((t) => fs.existsSync(path.join(MACRO_DIR, t + '.json')))
    && MACRO_FRED_SERIES.every((id) => fs.existsSync(path.join(MACRO_DIR, id.toLowerCase() + '.csv')));
  test('real archive: the engine read with macro equals the one with the archive cut at the day, and the macro is used', { skip: realOk ? false : 'macro archive missing' }, async () => {
    const a = loadMacroArchive();
    const series = loadAll(['NVDA']);
    const day = '2025-04-08';
    const [full] = await runEngineDay(series, day, ['NVDA'], { macro: a });
    const [cut] = await runEngineDay(series, day, ['NVDA'], { macro: cutArchive(a, day) });
    const [poisoned] = await runEngineDay(series, day, ['NVDA'], { macro: poisonArchive(a, day) });
    assert.deepEqual(cut, full);
    assert.deepEqual(poisoned, full);
    const m = JSON.parse(await macroReadAsOf(a, day)).m;
    assert.equal(m.regime, 'RISK_OFF', 'April 2025 sell-off: risk off');
    assert.equal(m.dowTheory.verdict, 'BEAR_CONFIRMED');
    assert.equal(m.supplemental.m2AsOfDate, '2025-02-01', 'February M2 (published late March), not March (late April)');
    assert.equal(m.supplemental.yieldCurveAsOfDate, '2025-04-07');
  });
});
