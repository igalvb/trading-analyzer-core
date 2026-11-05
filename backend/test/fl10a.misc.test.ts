/**
 * FL-10a: direct legacy-vs-port tests for three functions that were only
 * covered through parents:
 *   writeDarkPoolTrackerSheetV1_  (darkPoolTrackerV1.gs)   -> writeDarkPoolTrackerSheet
 *   findStalePriceCacheSheetsV1_  (fullStockAnalysisV10_9.gs) -> findStalePriceCacheSheets
 *   findOptionsSnapshotContractV7_ (fullStockAnalysisV10_9.gs) -> findOptionsSnapshotContract
 *
 * The dark pool port writes through a TabStore and a TabFormatter, not a sheet
 * call log, so the legacy side is run on a ReportWorkbook and its final cells and
 * its recorded formatting (callsToFormatOps) are compared with the port's stored
 * cells and applied format ops.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { withOracleGlobals } from './oracleGlobals.ts';
import { pinnedDateClass } from './pinnedDate.ts';
import { NOW, DAY, openBook, fakeSpreadsheet, staleTabs, priceTab, type Rows } from './fl7c1Fixtures.ts';
import { callsToFormatOps } from '../src/sheets/reportSheet.ts';
import { MemoryTabStore } from '../src/storage/tabStore.ts';
import { MemoryTabFormatter } from '../src/sheets/formatOps.ts';
import { writeDarkPoolTrackerSheet, DARK_POOL_TRACKER_TAB } from '../src/sheets/writers/darkPoolTracker.ts';
import { findStalePriceCacheSheets } from '../src/ops/priceCaches.ts';
import { findOptionsSnapshotContract } from '../src/portfolio/transactions.ts';
import { OPTIONS_SNAPSHOT_SHEET } from '../src/reports/options/tabs.ts';
import type { DarkPoolReport } from '../src/analysis/darkPool.ts';

const ready = legacyFilesPresent();
const skip = ready ? false : 'legacy/ not populated';
const TZ = 'America/New_York';

async function inZone<T>(fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env.TZ;
  process.env.TZ = TZ;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
}

// ── writeDarkPoolTrackerSheetV1_ ──────────────────────────────────────

const row = (ticker: string, atsShareVolume: number | null, price: number | null, darkPoolSharePct: number | null, elevated: boolean) =>
  ({ ticker, atsShareVolume, price, darkPoolSharePct, elevated });

const REPORTS: Array<[string, DarkPoolReport]> = [
  ['full', {
    generatedAt: new Date('2026-10-23T13:45:00Z'), t1Week: '2026-10-12', t2Week: '2026-10-05',
    categories: [
      { category: 'Mega caps', rows: [row('AAPL', 12345678, 231.5, 0.4321, true), row('MSFT', 2000000, 410.25, 0.1999, false), row('NVDA', null, null, null, false)] },
      { category: 'ETFs', rows: [row('SPY', 99999999, 580, 0.2, false), row('QQQ', 5, 0.5, 0.20000001, true)] },
    ],
  } as never],
  ['no weeks, one empty category', { generatedAt: new Date('2026-01-02T05:00:00Z'), t1Week: null, t2Week: null, categories: [{ category: 'Empty', rows: [] }] } as never],
  ['no categories', { generatedAt: new Date('2026-07-04T23:59:59Z'), t1Week: '2026-06-29', t2Week: null, categories: [] } as never],
  ['zero values', { generatedAt: new Date('2026-03-08T07:00:00Z'), t1Week: '2026-03-02', t2Week: '2026-02-23', categories: [{ category: 'Z', rows: [row('ZZ', 0, 0, 0, false)] }] } as never],
];

describe('FL-10a misc: dark pool tracker sheet writer', { skip }, () => {
  test('writeDarkPoolTrackerSheet matches writeDarkPoolTrackerSheetV1_: cells and formatting, new tab and existing tab', async () => {
    await inZone(async () => {
      const oracle = loadOracle();
      for (const [label, report] of REPORTS) {
        for (const existing of [false, true]) {
          const initial: Rows = existing ? { [DARK_POOL_TRACKER_TAB]: [['old content', 'x', 'y', 'z'], ['more', 1, 2, 3]] } : {};
          const book = await openBook(initial);
          withOracleGlobals({ Date: pinnedDateClass(NOW) }, () => oracle.call('writeDarkPoolTrackerSheetV1_', book, report));
          const sh = book.getSheetByName(DARK_POOL_TRACKER_TAB)!;

          const store = new MemoryTabStore();
          if (existing) await store.ensure(DARK_POOL_TRACKER_TAB);
          if (existing) await store.write(DARK_POOL_TRACKER_TAB, 1, [['old content', 'x', 'y', 'z'], ['more', 1, 2, 3]] as never);
          const formatter = new MemoryTabFormatter();
          await writeDarkPoolTrackerSheet({ store, formatter, timeZone: TZ }, report);

          const where = `${label} existing=${existing}`;
          assert.deepStrictEqual(store.snapshot(DARK_POOL_TRACKER_TAB, 4), sh.grid(4), where + ' (cells)');
          assert.deepStrictEqual(formatter.applied.get(DARK_POOL_TRACKER_TAB), callsToFormatOps(sh.calls), where + ' (formatting)');
        }
      }
    });
  });

  test('writeDarkPoolTrackerSheet without a formatter writes the same cells', async () => {
    await inZone(async () => {
      const oracle = loadOracle();
      const [, report] = REPORTS[0]!;
      const book = await openBook({});
      withOracleGlobals({ Date: pinnedDateClass(NOW) }, () => oracle.call('writeDarkPoolTrackerSheetV1_', book, report));
      const store = new MemoryTabStore();
      await writeDarkPoolTrackerSheet({ store, timeZone: TZ }, report);
      assert.deepStrictEqual(store.snapshot(DARK_POOL_TRACKER_TAB, 4), book.getSheetByName(DARK_POOL_TRACKER_TAB)!.grid(4));
    });
  });
});

// ── findStalePriceCacheSheetsV1_ ──────────────────────────────────────

describe('FL-10a misc: stale price-cache scan', { skip }, () => {
  const TABSETS: Array<[string, () => Rows]> = [
    ['the shared stale/fresh/edge set', staleTabs],
    ['empty workbook', () => ({})],
    ['only non-cache tabs', () => ({ Other: priceTab(new Date(0)), '📒 Transactions': priceTab(new Date(0)) })],
    ['exactly three rows vs two rows', () => ({ '💾 THREE': priceTab(new Date(NOW - 200 * DAY)), '💾 TWO': [['Date', 'Close'], [new Date(NOW - 200 * DAY), 1]] })],
    ['text, NaN and number last cells', () => ({ '💾 TXT': priceTab('2020-01-01'), '💾 NAN': priceTab(new Date(NaN)), '💾 NUM': priceTab(5000), '💾 EMPTY': priceTab('') })],
    ['several equally old tabs keep sheet order', () => ({ '💾 A': priceTab(new Date(NOW - 120 * DAY)), '💾 B': priceTab(new Date(NOW - 120 * DAY)), '💾 C': priceTab(new Date(NOW - 121 * DAY)) })],
  ];

  test('findStalePriceCacheSheets matches findStalePriceCacheSheetsV1_ at several clock times', async () => {
    const oracle = loadOracle();
    let nonEmpty = 0;
    for (const [label, make] of TABSETS) {
      for (const at of [NOW, NOW + 60 * DAY, NOW - 300 * DAY, NOW + 1]) {
        const lss = fakeSpreadsheet(make());
        const expected = structuredClone(withOracleGlobals({
          SpreadsheetApp: { getActiveSpreadsheet: () => lss }, Date: pinnedDateClass(at),
        }, () => oracle.call('findStalePriceCacheSheetsV1_')));
        const got = findStalePriceCacheSheets((await openBook(make())) as never, at);
        assert.deepStrictEqual(got, expected, `${label} at ${at - NOW}`);
        if (got.length) nonEmpty++;
      }
    }
    assert.ok(nonEmpty >= 4, `only ${nonEmpty} non-empty candidate lists, test would be weak`);
  });
});

// ── findOptionsSnapshotContractV7_ ────────────────────────────────────

describe('FL-10a misc: snapshot contract lookup', { skip }, () => {
  const HEAD = ['side', 'strike', 'expiryStr', 'daysToExpiry', 'oi', 'vol', 'iv', 'dollarsCommitted', 'dollarScore', 'holdingScore', 'urgencyScore', 'timeScore', 'ivScore', 'oiPersistenceScore', 'conviction', 'bucket'];
  const meta = (ticker: string): string => JSON.stringify({ ticker, priceAtRun: 400, timestamp: '2026-10-20T15:00:00.000Z', count: 4, context: { termNote: 'x' } });
  const contract = (side: string, strike: number, expiry: unknown, conviction: number) =>
    [side, strike, expiry, 84, 500, 10, 0.5, 2e8, 50, 50, 50, 50, 50, 50, conviction, 'Near (0–3m)'];

  // Expiry cells are Dates or a plain token, never a "Mon D, YYYY" label: the port's reader
  // rewrites such labels by default (F-68), legacy does not.
  const snapshotGrid = (): unknown[][] => [
    ['META', meta('TSLA')], HEAD,
    contract('call', 400, new Date(2027, 0, 15), 70),
    contract('call', 400.005, new Date(2027, 0, 15), 90),
    contract('put', 350, new Date(2027, 1, 19), 60),
    contract('call', 410, 'WKLY', 55),
    contract('call', 0, new Date(2027, 2, 19), 10),
  ];

  test('findOptionsSnapshotContract matches findOptionsSnapshotContractV7_ for hits, near-hits and misses', async () => {
    await inZone(async () => {
      const oracle = loadOracle();
      const book = await openBook({ [OPTIONS_SNAPSHOT_SHEET]: snapshotGrid() });
      const deps = { timeZone: TZ, nowMs: NOW };
      const jan = "Jan 15 '27";
      const queries: Array<[unknown, unknown, unknown]> = [
        ['TSLA', 400, jan], ['tsla', 400, jan], ['TSLA', 400.005, jan], ['TSLA', 400.0099, jan], ['TSLA', 400.01, jan],
        ['TSLA', 350, "Feb 19 '27"], ['TSLA', 350, jan], ['TSLA', 410, 'WKLY'], ['TSLA', 410, 'wkly'],
        ['TSLA', 0, "Mar 19 '27"], ['TSLA', null, "Mar 19 '27"], ['TSLA', 400, null], ['TSLA', 400, ''], ['TSLA', 400, undefined],
        ['NVDA', 400, jan], [null, 400, jan], [undefined, 400, jan], ['', 400, jan],
      ];
      let hits = 0;
      for (const [t, strike, expiry] of queries) {
        const expected = structuredClone(withOracleGlobals({ Date: pinnedDateClass(NOW) },
          () => oracle.call('findOptionsSnapshotContractV7_', book, t, strike, expiry)));
        const got = findOptionsSnapshotContract(book, t as never, strike as never, expiry as never, deps);
        assert.deepStrictEqual(got, expected, JSON.stringify([t, strike, expiry]));
        if (got) hits++;
      }
      assert.ok(hits >= 5, `only ${hits} hits, test would be weak`);
    });
  });

  test('findOptionsSnapshotContract matches on missing, corrupt and foreign snapshots, and a later clock', async () => {
    await inZone(async () => {
      const oracle = loadOracle();
      const cases: Array<[string, Rows]> = [
        ['no snapshot tab', {}],
        ['bad META json', { [OPTIONS_SNAPSHOT_SHEET]: [['META', '{bad'], HEAD, contract('call', 400, new Date(2027, 0, 15), 1)] }],
        ['META null', { [OPTIONS_SNAPSHOT_SHEET]: [['META', 'null'], HEAD, contract('call', 400, new Date(2027, 0, 15), 1)] }],
        ['not META', { [OPTIONS_SNAPSHOT_SHEET]: [['NOPE', meta('TSLA')], HEAD, contract('call', 400, new Date(2027, 0, 15), 1)] }],
        ['too few rows', { [OPTIONS_SNAPSHOT_SHEET]: [['META', meta('TSLA')], HEAD] }],
        ['other ticker snapshot', { [OPTIONS_SNAPSHOT_SHEET]: [['META', meta('NVDA')], HEAD, contract('call', 400, new Date(2027, 0, 15), 1)] }],
        ['no timestamp in meta', { [OPTIONS_SNAPSHOT_SHEET]: [['META', JSON.stringify({ ticker: 'TSLA', priceAtRun: 1 })], HEAD, contract('call', 400, new Date(2027, 0, 15), 1)] }],
      ];
      for (const [label, initial] of cases) {
        const book = await openBook(initial);
        const expected = structuredClone(withOracleGlobals({ Date: pinnedDateClass(NOW) },
          () => oracle.call('findOptionsSnapshotContractV7_', book, 'TSLA', 400, "Jan 15 '27")));
        assert.deepStrictEqual(findOptionsSnapshotContract(book, 'TSLA', 400, "Jan 15 '27", { timeZone: TZ, nowMs: NOW }), expected, label);
      }
      // The age is measured from the clock: a later "now" changes ageDays on both sides.
      const book = await openBook({ [OPTIONS_SNAPSHOT_SHEET]: snapshotGrid() });
      for (const at of [NOW, NOW + 5 * DAY, NOW - DAY]) {
        const expected = structuredClone(withOracleGlobals({ Date: pinnedDateClass(at) },
          () => oracle.call('findOptionsSnapshotContractV7_', book, 'TSLA', 400, "Jan 15 '27")));
        assert.deepStrictEqual(findOptionsSnapshotContract(book, 'TSLA', 400, "Jan 15 '27", { timeZone: TZ, nowMs: at }), expected, `clock ${at - NOW}`);
      }
    });
  });
});
