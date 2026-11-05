/**
 * FL-18c (James's models, phase 0): G0 more price history and the BTC D-1 bar timing, G0b the dated 10-year fetch,
 * and G5's report columns (best-days check 30 / 12 / 8, doubling time, $100,000 in 5 / 10 / 20 years, the gain
 * needed to recover from the deepest fall). All on fixtures: no network.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RESEARCH_UNIVERSE, RESEARCH_DOWNLOAD, JAMES_EXTRA_TICKERS, FRED_SERIES, fetchOne, fetchFredCsv, fredCsvUrl } from '../src/research/fetchPrices.ts';
import { priceFiles } from '../src/research/unpackPrices.ts';
import { priceFileName, decisionBarIndex, isCryptoTicker, lastIndexBefore, type PriceSeries } from '../src/backtest/data.ts';
import { seriesFromChart, runPaperNight, LONG_BAR_TICKERS } from '../src/paper/paperJob.ts';
import { yahooLongRangeBarsUrl, fetchYahooChartLongRangeBars } from '../src/fetch/yahoo.ts';
import { PAPER_OWNER_LIST } from '../src/paper/paperLab.ts';
import { MemoryTabStore } from '../src/storage/tabStore.ts';
import {
  bestDaysCount, bestDays, bestDaysCheck, cagr, doublingYears, futureValue, recoveryNeededPct, growthCell, fallCell, bestDaysCell, reportRow, reportTable, benchmarksFor,
} from '../src/research/benchmarks.ts';
import { PERIODS } from '../src/research/lab.ts';
import { runPortfolio } from '../src/research/portfolioLab.ts';

const ser = (t: string, dates: string[], px: number[]): PriceSeries => ({ ticker: t, dates, opens: px, highs: px, lows: px, closes: px, volumes: px.map(() => 1), splits: [] });
const yahooBody = (tz: string, ts: number[], close: number[]) => JSON.stringify({ chart: { result: [{ meta: { exchangeTimezoneName: tz, regularMarketPrice: close.at(-1), currency: 'USD' }, timestamp: ts,
  indicators: { quote: [{ open: close, high: close, low: close, close, volume: close.map(() => 1) }] } }] } });

describe('FL-18c — G0 price history and BTC bar timing', () => {
  test('the download adds BTC-USD, ETH-USD, SOL-USD, IBIT, SQZA, AQZC and DGS1, but the research universe stays stocks only', () => {
    assert.deepEqual([...JAMES_EXTRA_TICKERS], ['BTC-USD', 'ETH-USD', 'SOL-USD', 'IBIT', 'SQZA', 'AQZC']);
    for (const t of [...RESEARCH_UNIVERSE, ...JAMES_EXTRA_TICKERS]) assert.ok(RESEARCH_DOWNLOAD.includes(t), t);
    assert.equal(new Set(RESEARCH_DOWNLOAD).size, RESEARCH_DOWNLOAD.length, 'each once');
    assert.ok(!RESEARCH_UNIVERSE.some(isCryptoTicker), 'no crypto in the stock universe');
    assert.deepEqual([...FRED_SERIES], ['DGS1', 'M2SL', 'T10Y2Y', 'GDPC1', 'DGS10', 'FEDFUNDS']);
    assert.equal(fredCsvUrl('DGS1'), 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS1');
  });

  test('spot bitcoin is saved as BTC-USD.json (never BTC.json, the Grayscale fund); FRED as dgs1.csv', async () => {
    assert.equal(priceFileName('BTC-USD'), 'BTC-USD.json');
    // Yahoo dates crypto in UTC: a bar stamped 2026-10-28 00:00 UTC is the 28th, not the 27th (New York)
    const f = (async () => new Response(yahooBody('UTC', [Date.UTC(2026, 9, 27) / 1000, Date.UTC(2026, 9, 28) / 1000], [100, 101]))) as unknown as typeof fetch;
    const btc = (await fetchOne('BTC-USD', f, Date.UTC(2026, 9, 29)))!;
    assert.deepEqual(btc.dates, ['2026-10-27', '2026-10-28']);
    const files = priceFiles({ name: 'prices', series: [btc], fred: { DGS1: 'observation_date,DGS1\n2026-10-27,3.61\n' } });
    assert.deepEqual([...files.keys()], ['BTC-USD.json', 'dgs1.csv']);
    assert.equal(JSON.parse(files.get('BTC-USD.json')!).ticker, 'BTC-USD');
    assert.equal(JSON.parse(files.get('BTC-USD.json')!).barCount, 2);
  });

  test('fetchFredCsv: the CSV text, or null for an error or a page that is not the CSV', async () => {
    const ok = (async () => new Response('observation_date,DGS1\n2026-10-27,3.61\n2026-10-28,3.60\n')) as unknown as typeof fetch;
    assert.equal(await fetchFredCsv('DGS1', ok), 'observation_date,DGS1\n2026-10-27,3.61\n2026-10-28,3.60\n');
    assert.equal(await fetchFredCsv('DGS1', (async () => new Response('', { status: 500 })) as unknown as typeof fetch), null);
    assert.equal(await fetchFredCsv('DGS1', (async () => new Response('<html>')) as unknown as typeof fetch), null);
    assert.equal(await fetchFredCsv('DGS1', (async () => { throw new Error('down'); }) as unknown as typeof fetch), null);
  });

  test('D-1 rule: a decision at the US close of day D uses the BTC bar of D-1; a stock uses its bar of D', () => {
    const dates = ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28'];
    const btc = ser('BTC-USD', dates, [1, 2, 3, 4, 5]), stock = ser('NVDA', ['2026-10-26', '2026-10-27', '2026-10-28'], [1, 2, 3]);
    assert.equal(btc.dates[decisionBarIndex(btc, '2026-10-28')], '2026-10-27');
    assert.equal(btc.dates[decisionBarIndex(btc, '2026-10-26')], '2026-10-25', 'a Monday uses Sunday\'s bar');
    assert.equal(stock.dates[decisionBarIndex(stock, '2026-10-28')], '2026-10-28');
    assert.equal(decisionBarIndex(btc, '2026-10-24'), -1, 'no earlier bar');
    assert.equal(lastIndexBefore(stock, '2026-10-30'), 2);
    assert.ok(isCryptoTicker('ETH-USD') && isCryptoTicker('SOL-USD') && !isCryptoTicker('IBIT') && !isCryptoTicker('BTC'));
  });

  test('the nightly dates crypto bars in UTC and stocks in New York time', () => {
    const at = new Date('2026-10-28T00:00:00Z');
    const c = { dates: [at], opens: [1], highs: [1], lows: [1], closes: [1], volumes: [1], splits: [] } as never;
    assert.deepEqual(seriesFromChart('BTC-USD', c, 'America/New_York').dates, ['2026-10-28']);
    assert.deepEqual(seriesFromChart('NVDA', c, 'America/New_York').dates, ['2026-10-27']);
  });
});

describe('FL-18c — G0b dated 10-year bars', () => {
  test('the URL asks for 10 years with splits; the body is parsed with its dates and OHLC; a failure is null', async () => {
    assert.match(yahooLongRangeBarsUrl('BTC-USD'), /chart\/BTC-USD\?interval=1d&range=10y&includePrePost=false&events=div,splits$/);
    const ts = Array.from({ length: 800 }, (_, i) => Date.UTC(2016, 0, 1) / 1000 + i * 86400);
    const seen: string[] = [];
    const http = { fetch: async (req: { url: string }) => { seen.push(req.url); return { status: 200, text: () => yahooBody('America/New_York', ts, ts.map((_, i) => 10 + i)) }; } };
    const c = (await fetchYahooChartLongRangeBars(http as never, 'NVDA'))!;
    assert.equal(c.closes.length, 800);
    assert.equal(c.dates[0]!.getTime(), ts[0]! * 1000);
    assert.equal(c.highs.length, 800);
    assert.equal(seen[0], yahooLongRangeBarsUrl('NVDA'));
    assert.equal(await fetchYahooChartLongRangeBars({ fetch: async () => ({ status: 404, text: () => '' }) } as never, 'X'), null);
    assert.equal(await fetchYahooChartLongRangeBars({ fetch: async () => { throw new Error('down'); } } as never, 'X'), null);
  });

  test('the paper night fetches the 10-year bars of the list and BTC-USD; a failed ticker is only logged', async () => {
    const days = (() => { const out: string[] = []; const d = new Date('2025-09-01T12:00:00Z'); while (out.length < 330) { if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); } return out; })();
    const chart = (t: string) => { const ds = days.filter((d) => d <= '2026-10-28'); const px = ds.map((_, i) => (t === 'QQQ' ? 500 : 50 + i * 0.3)); return { dates: ds.map((d) => new Date(d + 'T20:00:00Z')), opens: px, highs: px, lows: px, closes: px, volumes: px.map(() => 1e6), splits: [] } as never; };
    const asked: string[] = [], logs: string[] = [];
    await runPaperNight({
      store: new MemoryTabStore(), timeZone: 'America/New_York', watchlist: [], log: (m) => logs.push(m), now: () => Date.parse('2026-10-28T23:00:00Z'), fetchChart: async (t) => chart(t),
      analysis: async (t) => ({ ticker: t, result: undefined, status: {}, dataQuality: [], reports: {}, texts: {} }) as never,
      fetchLongBars: async (t) => { asked.push(t); return t === 'SQZA' ? null : chart(t); },
    });
    assert.deepEqual(asked, [...LONG_BAR_TICKERS]);
    assert.ok(LONG_BAR_TICKERS.includes('BTC-USD') && PAPER_OWNER_LIST.every((t) => LONG_BAR_TICKERS.includes(t)));
    assert.ok(logs.includes('paper test: 10-year bars for ' + (LONG_BAR_TICKERS.length - 1) + ' of ' + LONG_BAR_TICKERS.length + ' tickers'), logs.join('\n'));
  });
});

describe('FL-18c — G5 report columns', () => {
  test('best days per period: 3 a year, so 30 / 12 / 8', () => {
    assert.deepEqual(PERIODS.map((p) => bestDaysCount(p.start, p.end)), [30, 12, 8]);
  });

  test('the best days are QQQ\'s largest close-to-close gains inside the period; the check counts the days spent mostly in cash', () => {
    const dates = ['2010-01-04', '2010-01-05', '2010-01-06', '2010-01-07', '2010-01-08'];
    const q = ser('QQQ', dates, [100, 110, 99, 109, 110]);
    assert.deepEqual(bestDays(q, '2010-01-01', '2010-12-31', 2), ['2010-01-05', '2010-01-07']);
    assert.deepEqual(bestDays(q, '2010-01-05', '2010-12-31', 1), ['2010-01-07'], 'the first day has no close before it inside the period');
    const cash = new Map([['2010-01-05', 1], ['2010-01-07', 0.2]]);
    assert.deepEqual(bestDaysCheck(['2010-01-05', '2010-01-07'], cash), { n: 2, missed: 1, cashSharePct: 60 });
    assert.equal(bestDaysCheck(['2010-01-05'], undefined), null);
    assert.equal(bestDaysCell({ n: 2, missed: 1, cashSharePct: 60 }, 30), '1 of 30 mostly in cash (60% cash on average)');
  });

  test('Rule #131: growth a year, doubling time, $100,000 in 5 / 10 / 20 years, and the gain needed to recover a fall', () => {
    assert.ok(Math.abs(cagr(200_000, 100_000, '2010-01-01', '2020-01-01')! - (2 ** (1 / 10) - 1)) < 1e-4);
    assert.ok(Math.abs(doublingYears(0.1)! - 7.2725) < 1e-4);
    assert.equal(doublingYears(0), null);
    assert.equal(doublingYears(-0.05), null);
    assert.ok(Math.abs(futureValue(0.1, 10) - 259_374.25) < 0.01);
    assert.equal(recoveryNeededPct(50), 100);
    assert.equal(recoveryNeededPct(80), 400);
    assert.equal(recoveryNeededPct(100), Infinity);
    assert.equal(fallCell(55), '-55% (needs +122% to get back)');
    assert.equal(growthCell({ finalTaxed: 259_374.25, maxDrawdownPct: 0 }, 100_000, '2010-01-01', '2020-01-01').replace(/\s+/g, ' '), '+10.0%/yr, doubles in 7.3 yrs, $100,000 → $161k / $259k / $673k');
    assert.match(growthCell({ finalTaxed: 80_000, maxDrawdownPct: 0 }, 100_000, '2010-01-01', '2020-01-01'), /^-2\.2%\/yr, never doubles/);
  });

  test('a results table: the two yardsticks, then each model with its cash share on the best days (runPortfolio reports it)', () => {
    const dates: string[] = [];
    const d = new Date('2009-12-01T12:00:00Z');
    while (d.toISOString() < '2026-10-28') { if (d.getUTCDay() % 6) dates.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
    const q = ser('QQQ', dates, dates.map((_, i) => 100 * 1.0004 ** i * (1 + 0.02 * Math.sin(i / 3))));
    const a = ser('AAA', dates, dates.map((_, i) => 50 * 1.0005 ** i));
    const inp = { series: new Map([['AAA', a]]), reads: new Map(), qqq: q };
    const inQqq = runPortfolio('trend', ['AAA'], inp, PERIODS[0]!.start, PERIODS[0]!.end, { slots: 1, cash: 100_000, idle: 'qqq' });
    const inCash = runPortfolio('turtle', ['AAA'], inp, PERIODS[0]!.start, PERIODS[0]!.end, { slots: 1, cash: 100_000, idle: 'cash' });
    assert.ok([...inCash.cashShareByDay.values()].every((x) => x === 1), 'no reads: the cash account never invests');
    assert.ok([...inQqq.cashShareByDay.values()].slice(5).every((x) => x < 0.05), 'money in QQQ or the stock is invested');
    const outcomes = PERIODS.map((p) => runPortfolio('turtle', ['AAA'], inp, p.start, p.end, { slots: 1, cash: 100_000, idle: 'cash' }));
    const row = reportRow('Turtle, all cash', outcomes, q, 100_000);
    assert.ok(row.includes('30 of 30 mostly in cash (100% cash on average)') && row.includes('12 of 12') && row.includes('8 of 8'), row);
    const table = reportTable(benchmarksFor(['AAA'], inp, 100_000), [{ name: 'Turtle, all cash', outcomes }], q, 100_000);
    const hold = table.find((l) => l.startsWith('| **Hold QQQ**'))!;
    assert.ok(hold.includes('0 of 30 mostly in cash (0% cash on average)'), hold);
    assert.ok(table.some((l) => l.includes('2010-2019: its 30 best QQQ days')));
    assert.equal(table.filter((l) => l.startsWith('| ')).length, 1 + 4, 'header, three yardsticks (the list also joining when listed, G5e), one row');
  });
});
