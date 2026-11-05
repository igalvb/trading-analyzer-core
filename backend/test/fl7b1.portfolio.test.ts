/**
 * FL-7b1: transactions and the FIFO portfolio summary, decision history, the
 * watchlist stores and scanWatchlist, against the oracle. Legacy and port run
 * on twin ReportWorkbooks (Memory backend); the tests compare the complete
 * recorded call log of every tab, the final cells, Logger lines and the
 * arguments runAnalysis receives.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadOracle, legacyFilesPresent, LEGACY_DIR } from './oracle.ts';
import { withOracleGlobals } from './oracleGlobals.ts';
import { pinnedDateClass } from './pinnedDate.ts';
import { ReportWorkbook, MemoryWorkbookBackend } from '../src/sheets/reportSheet.ts';
import { TZ, NOW, TX_SHEET, SNAPSHOT_TAB, transactionsGrid, snapshotGrid } from './fl7b1Fixtures.ts';
import {
  TRANSACTIONS_SHEET, TRANSACTIONS_HEADERS, getOrCreateTransactionsSheet, readTransactions, computeFifoGroups, summarizeFifoGroup,
  computePortfolioSummary, getHeldPositionsForTicker, type Transaction, type PortfolioSummary, type OptionPosition,
} from '../src/portfolio/transactions.ts';
import { LEVEL_TOLERANCE } from '../src/analysis/indicators/slices.ts';
import { DECISION_HISTORY_SHEET, DECISION_HISTORY_HEADERS, getOrCreateDecisionHistorySheet, getLastDecision, appendDecisionHistory } from '../src/stores/decisionHistory.ts';
import {
  WATCHLIST_SHEET, WATCHLIST_SUMMARY_SHEET, getWatchlistTickers, getOrCreateWatchlistSheet, scanWatchlist,
} from '../src/stores/watchlist.ts';

const ready = legacyFilesPresent();
const LEG_SRC = ready ? fs.readFileSync(path.join(LEGACY_DIR, 'fullStockAnalysisV10_9.gs'), 'utf8') : '';
const LEG = LEG_SRC.split('\n');

async function inZone<T>(tz: string, fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try { return await fn(); } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
}

async function twin(initial: Record<string, unknown[][]> = {}) {
  const mk = async (): Promise<ReportWorkbook> => ReportWorkbook.open(new MemoryWorkbookBackend(initial as never), ['*']);
  return { L: await mk(), P: await mk() };
}

/** Runs a legacy function with a pinned clock and a captured Logger; raw = the sheet-returning functions (not clonable). */
function legacyRun<T>(now: number, name: string, args: unknown[], globals: Record<string, unknown> = {}, raw = false): { value: T; logs: string[] } {
  const logs: string[] = [];
  const o = loadOracle();
  const value = withOracleGlobals({ Date: pinnedDateClass(now), Logger: { log: (m: unknown) => { logs.push(String(m)); } }, ...globals },
    () => (raw ? o.call(name, ...args) : o.callNormalized(name, ...args)));
  return { value: value as T, logs };
}

/** Every tab's call log and cells, and the workbook's calls, identical on both sides. */
function assertSameBooks(L: ReportWorkbook, P: ReportWorkbook, where: string): void {
  const names = (b: ReportWorkbook) => b.getSheets().map((s) => s.getName());
  assert.deepStrictEqual(names(P), names(L), where + ' (tabs)');
  for (const sh of L.getSheets()) {
    const ps = P.getSheetByName(sh.getName())!;
    assert.deepStrictEqual(ps.calls, sh.calls, where + ' calls on ' + sh.getName());
    assert.deepStrictEqual(ps.grid(), sh.grid(), where + ' cells on ' + sh.getName());
  }
  assert.deepStrictEqual(P.calls, L.calls, where + ' (workbook calls)');
}

const RANGES: ReadonlyArray<readonly [string, number, number]> = [
  ['getOrCreateDecisionHistorySheetV7', 346, 366], ['getLastDecisionV7', 370, 380], ['appendDecisionHistoryV7', 383, 386],
  ['getWatchlistTickersV7', 405, 417], ['getOrCreateWatchlistSheetV7', 419, 428],
  ['getOrCreateTransactionsSheetV7', 674, 684], ['readTransactionsV7', 691, 738], ['computeFifoGroupsV7_', 743, 767],
  ['summarizeFifoGroupV7_', 769, 781], ['findOptionsSnapshotContractV7_', 786, 792], ['computePortfolioSummaryV7', 796, 821],
  ['getHeldPositionsForTickerV7', 825, 827], ['computeStockEntryLadderV7', 3362, 3373], ['ladderDisplayPercentsV7_', 3379, 3385],
  ['computeStockExitLadderV7', 3389, 3396], ['computeOptionsEntryLadderV7', 3402, 3402], ['computeOptionsExitLadderV7', 3403, 3403],
  ['optionsLadderTimeDecayNoteV7', 3407, 3409], ['optionsExpiryFlagV7', 3412, 3418], ['doubleTopBottomMarketCapContextV7', 8695, 8703],
  ['shortSqueezeSetupV7', 9172, 9178], ['scanWatchlistV7', 9627, 9659],
];

describe('FL-7b1 — legacy boundaries and constants', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('every ported range starts and ends where the port says, and the constants match', () => {
    for (const [name, a, b] of RANGES) {
      assert.ok(LEG[a - 1].startsWith('function ' + name + '('), name + ' starts at ' + a + ': ' + LEG[a - 1]);
      assert.ok(LEG[b - 1].trimEnd().endsWith('}'), name + ' ends at ' + b + ': ' + LEG[b - 1]);
      if (a !== b) assert.equal(LEG[b - 1], '}', name + ' closes at column 0');
      assert.ok(LEG[b].trim() === '' || LEG[b].startsWith('//') || LEG[b].startsWith('function') || LEG[b].startsWith('const'), name + ' is followed by a boundary at ' + (b + 1) + ': ' + LEG[b]);
    }
    assert.equal(LEG[664], "const TRANSACTIONS_SHEET_V7 = '" + TRANSACTIONS_SHEET + "';");
    assert.equal(LEG[668], 'const TRANSACTIONS_HEADERS_V7 = [' + TRANSACTIONS_HEADERS.map((h) => "'" + h + "'").join(',') + '];');
    assert.equal(LEG[322], "const DECISION_HISTORY_SHEET_V7 = '" + DECISION_HISTORY_SHEET + "';");
    assert.equal(LEG[323], 'const DECISION_HISTORY_HEADERS_V7 = [' + DECISION_HISTORY_HEADERS.map((h) => "'" + h + "'").join(',') + '];');
    assert.equal(LEG[398], "const WATCHLIST_SHEET_V7 = '" + WATCHLIST_SHEET + "';");
    assert.equal(LEG[399], "const WATCHLIST_SUMMARY_SHEET_V7 = '" + WATCHLIST_SUMMARY_SHEET + "';");
    assert.equal(LEG[9162], 'const LEVEL_TOLERANCE_V7 = ' + LEVEL_TOLERANCE + ';');
  });
});

describe('FL-7b1 — the workbook model additions', () => {
  test('appendRow goes after the last row with content; breakApart drops only merges inside its range', async () => {
    const ss = await ReportWorkbook.open(new MemoryWorkbookBackend({ T: [['a'], ['b']] }), ['T']);
    const t = ss.getSheetByName('T')!;
    t.appendRow([1, 'x']);
    t.appendRow(['', 'y']);
    assert.deepStrictEqual(t.grid(), [['a', ''], ['b', ''], [1, 'x'], ['', 'y']]);
    t.getRange(1, 1, 1, 3).merge();
    t.getRange(6, 1, 1, 2).merge();
    t.getRange(1, 1, 1, 2).breakApart();
    assert.equal(t.merges.length, 2, 'a merge reaching outside the range survives');
    t.getRange(1, 1, 5, 3).breakApart();
    assert.deepStrictEqual(t.merges, [{ row: 6, col: 1, numRows: 1, numCols: 2 }]);
    assert.deepStrictEqual(t.calls.filter((c) => c[0] === 'appendRow' || c[0] === 'range:breakApart').map((c) => c[0]), ['appendRow', 'appendRow', 'range:breakApart', 'range:breakApart']);
  });
});

describe('FL-7b1 — transactions and the portfolio summary', { skip: ready ? false : 'legacy/ not populated' }, () => {
  // Parity runs use the literal legacy label handling; the default (true) is tested port-only below.
  const rdeps = { timeZone: TZ, sheetsParsedLabels: false };
  const sdeps = { timeZone: TZ, sheetsParsedLabels: false, nowMs: NOW };

  test('getOrCreateTransactionsSheet: new tab, existing tab (a no-op), an existing tab is never touched', async () => {
    const a = await twin({});
    legacyRun(NOW, 'getOrCreateTransactionsSheetV7', [a.L], {}, true);
    getOrCreateTransactionsSheet(a.P);
    assertSameBooks(a.L, a.P, 'new');
    assert.ok(a.P.getSheetByName(TX_SHEET)!.calls.length >= 6, 'guard: the new tab was formatted');
    assert.deepStrictEqual(a.P.getSheetByName(TX_SHEET)!.grid(), [[...TRANSACTIONS_HEADERS]]);
    const before = a.P.getSheetByName(TX_SHEET)!.calls.length;
    legacyRun(NOW, 'getOrCreateTransactionsSheetV7', [a.L], {}, true);
    getOrCreateTransactionsSheet(a.P);
    assertSameBooks(a.L, a.P, 'again');
    assert.equal(a.P.getSheetByName(TX_SHEET)!.calls.length, before, 'guard: the second call recorded nothing');
    const b = await twin({ [TX_SHEET]: [['custom header'], [1]] });
    legacyRun(NOW, 'getOrCreateTransactionsSheetV7', [b.L], {}, true);
    getOrCreateTransactionsSheet(b.P);
    assertSameBooks(b.L, b.P, 'existing');
    assert.equal(b.P.getSheetByName(TX_SHEET)!.calls.length, 0);
  });

  test('readTransactions: every row class, equal to readTransactionsV7 (guards: each problem message and every accepted shape is reached)', async () => {
    await inZone(TZ, async () => {
      const { L, P } = await twin({ [TX_SHEET]: transactionsGrid() });
      const lg = legacyRun<any>(NOW, 'readTransactionsV7', [L]).value;
      assert.deepStrictEqual(structuredClone(readTransactions(P, rdeps)), lg);
      const msgs = lg.parseWarnings.join('\n');
      for (const re of [/Date is not a valid date \(got "abc"\)/, /Ticker is empty/, /Row \d+ \(\?\)/, /Asset Type must be STOCK or OPTION \(got "BOND"\)/, /Action must be BUY or SELL \(got "HOLD"\)/,
        /Shares\/Contracts must be a positive number \(got "0"\)/, /\(got "x"\)/, /Price must be a non-negative number \(got "-1"\)/, /Price must be a non-negative number \(got ""\)/,
        /OPTION rows need a numeric Strike/, /OPTION rows need an Expiry/, /; Ticker is empty; Asset Type must be.*; Action must be/]) assert.match(msgs, re);
      const tx = lg.transactions;
      assert.ok(tx.some((t: any) => t.assetType === 'OPTION' && t.expiry === "Jan 15 '27") && tx.some((t: any) => t.expiry === 'Jan 15, 2027'), 'guard: Date and text expiries canonicalise; a label stays a label in legacy');
      assert.ok(tx.some((t: any) => t.ticker === 'NVDA' && t.dateStr === '1970-01-01'), 'guard: a numeric date cell reads as ms since 1970 in legacy (F-B1)');
      assert.ok(tx.some((t: any) => t.ticker === 'AMD' && Number.isNaN(t.strike)), 'guard: a stock row keeps a NaN strike');
      assert.ok(tx.some((t: any) => t.notes === ''), 'guard: a 0 note becomes an empty string');
      assert.equal(lg.parseWarnings.length, 13);
    });
  });

  test('readTransactions: no tab gives the empty result', async () => {
    const { L, P } = await twin({});
    assert.deepStrictEqual(structuredClone(readTransactions(P, rdeps)), legacyRun(NOW, 'readTransactionsV7', [L]).value);
    assert.deepStrictEqual(readTransactions(P, rdeps), { transactions: [], parseWarnings: [] });
  });

  test('computeFifoGroups and summarizeFifoGroup: equal to the legacy walk on the same transactions, both keyings', async () => {
    await inZone(TZ, async () => {
      const { P } = await twin({ [TX_SHEET]: transactionsGrid() });
      const txs = readTransactions(P, rdeps).transactions;
      const seen = { stockWarn: 0, optWarn: 0, closed: 0, open: 0, partialLot: 0 };
      for (const [assetType, keyFn] of [['STOCK', (tx: Transaction) => tx.ticker], ['OPTION', (tx: Transaction) => tx.ticker + '|' + tx.strike + '|' + tx.expiry]] as const) {
        const sub = txs.filter((t) => t.assetType === assetType);
        const lg = legacyRun<any>(NOW, 'computeFifoGroupsV7_', [structuredClone(sub), keyFn]).value;
        const pg = structuredClone(computeFifoGroups(structuredClone(sub), keyFn));
        assert.deepStrictEqual(pg, lg);
        for (const k of Object.keys(lg)) {
          const lsum = legacyRun<any>(NOW, 'summarizeFifoGroupV7_', [structuredClone(lg[k])]).value;
          assert.deepStrictEqual(summarizeFifoGroup(structuredClone(pg[k])), lsum);
          if (lsum === null) seen.closed++; else seen.open++;
          if (lg[k].warnings.length) (assetType === 'STOCK' ? seen.stockWarn++ : seen.optWarn++);
          if (lg[k].lots.length && lg[k].lots[0].shares === 25) seen.partialLot++;
        }
      }
      assert.ok(seen.stockWarn >= 2 && seen.optWarn >= 1 && seen.closed >= 2 && seen.open >= 3 && seen.partialLot === 1, 'guard: ' + JSON.stringify(seen));
    });
  });

  const variants: ReadonlyArray<readonly [string, () => Record<string, unknown[][]>]> = [
    ['full', () => ({ [TX_SHEET]: transactionsGrid(), [SNAPSHOT_TAB]: snapshotGrid() })],
    ['no snapshot tab', () => ({ [TX_SHEET]: transactionsGrid() })],
    ['snapshot of another ticker (mismatch)', () => ({ [TX_SHEET]: transactionsGrid(), [SNAPSHOT_TAB]: snapshotGrid('TSLA') })],
    ['snapshot META is not JSON', () => ({ [TX_SHEET]: transactionsGrid(), [SNAPSHOT_TAB]: [['META', 'not json'], ['h'], ['x']] })],
    ['no transactions tab', () => ({})],
    ['header only', () => ({ [TX_SHEET]: [[...TRANSACTIONS_HEADERS]] })],
  ];
  for (const [label, mk] of variants) {
    test('computePortfolioSummary + getHeldPositionsForTicker: ' + label, async () => {
      await inZone(TZ, async () => {
        const { L, P } = await twin(mk());
        const lg = legacyRun<any>(NOW, 'computePortfolioSummaryV7', [L]).value;
        const pt = structuredClone(computePortfolioSummary(P, sdeps));
        assert.deepStrictEqual(pt, lg);
        for (const t of ['pltr', 'PLTR', 'nvda', 'AMD', 'MSFT', 'ZZZ']) {
          assert.deepStrictEqual(structuredClone(getHeldPositionsForTicker(pt as never, t)), legacyRun(NOW, 'getHeldPositionsForTickerV7', [lg, t]).value, t);
        }
        assert.deepStrictEqual(getHeldPositionsForTicker({}, 'x'), legacyRun(NOW, 'getHeldPositionsForTickerV7', [{}, 'x']).value);
        if (label === 'full') {
          const opts = lg.positions.filter((p: any) => p.assetType === 'OPTION');
          assert.ok(opts.some((p: any) => p.snapshot && p.snapshot.contract.conviction === 72 && p.snapshot.ageDays === 2), 'guard: a Date-expiry contract matched');
          assert.ok(opts.some((p: any) => p.snapshot && p.snapshot.contract.conviction === 66 && p.snapshot.contract.strike === 40.004 && p.snapshot.contract.oi === 1200), 'guard: 40 matched the 40.004 contract, not the 40.02 decoy');
          assert.ok(opts.some((p: any) => p.strike === 999 && p.snapshot === null) && opts.some((p: any) => p.ticker === 'MSFT' && p.snapshot === null), 'guard: no-match and mismatch give null');
          assert.ok(lg.positions.some((p: any) => p.ticker === 'PLTR' && p.assetType === 'STOCK' && p.shares === 35 && p.earliestLotDate === '2026-02-10'), 'guard: FIFO left 25 of lot 2 plus the April buy');
          assert.ok(!lg.positions.some((p: any) => p.ticker === 'TSLA' || p.ticker === 'MSFT' && p.assetType === 'STOCK' || p.strike === 200), 'guard: closed and dust positions drop off');
          assert.ok(lg.warnings.filter((w: string) => /exceeds the/.test(w)).length >= 4);
        } else if (label === 'no snapshot tab' || label.startsWith('snapshot')) {
          assert.ok(lg.positions.filter((p: any) => p.assetType === 'OPTION').every((p: any) => p.snapshot === null), 'guard: ' + label + ' leaves every snapshot null');
        } else {
          assert.deepStrictEqual(lg.positions, [], 'guard: ' + label + ' has no positions');
        }
      });
    });
  }

  test('port-only: the Sheets-label default merges the SELL typed "Jan 15, 2027" (F-B2); fromSerial decodes numeric date and expiry cells (F-B1)', async () => {
    await inZone(TZ, async () => {
      const { P } = await twin({ [TX_SHEET]: transactionsGrid(), [SNAPSHOT_TAB]: snapshotGrid() });
      const literal = computePortfolioSummary(P, sdeps);
      const labelled = computePortfolioSummary(P, { timeZone: TZ, nowMs: NOW });
      const pick = (r: PortfolioSummary) => r.positions.find((p) => p.assetType === 'OPTION' && p.strike === 150) as OptionPosition;
      assert.equal(pick(literal).contracts, 3);
      assert.equal(pick(labelled).contracts, 2);
      assert.equal(labelled.warnings.filter((w) => /exceeds the/.test(w)).length, literal.warnings.filter((w) => /exceeds the/.test(w)).length - 1);
      const serial = (n: number): Date => new Date(Date.UTC(1899, 11, 30) + n * 86400000 + 12 * 3600000);
      const g = await twin({ [TX_SHEET]: [[...TRANSACTIONS_HEADERS], [46000, 'X', 'STOCK', 'BUY', 1, 1, '', '', ''], [46001, 'X', 'OPTION', 'BUY', 1, 1, 10, 46395, '']] });
      const plain = readTransactions(g.P, { timeZone: TZ });
      assert.equal(plain.transactions[0].dateStr, '1970-01-01');
      assert.equal(plain.transactions[1].expiry, '46395');
      const decoded = readTransactions(g.P, { timeZone: TZ, fromSerial: serial });
      assert.equal(decoded.transactions[0].dateStr, '2025-12-09');
      assert.equal(decoded.transactions[1].expiry, "Jan 8 '27");
    });
  });
});

describe('FL-7b1 — decision history', { skip: ready ? false : 'legacy/ not populated' }, () => {
  const fund = { score: 7.5 }, tech = { techScore: 62 }, dec = { finalConviction: 71, action: 'BUY' };
  test('getOrCreate (new, headed, wrong row 1), append x4, getLastDecision', async () => {
    const heads = [...DECISION_HISTORY_HEADERS];
    const cases: ReadonlyArray<readonly [string, Record<string, unknown[][]>, boolean]> = [
      ['new tab', {}, true], ['headed tab', { [DECISION_HISTORY_SHEET]: [heads, [new Date(0), 'OLD', 1, 2, 3, 'HOLD']] }, false],
      ['cleared tab with a wrong row 1', { [DECISION_HISTORY_SHEET]: [['stale']] }, true], ['empty existing tab', { [DECISION_HISTORY_SHEET]: [] }, true],
    ];
    for (const [label, initial, formats] of cases) {
      const { L, P } = await twin(initial);
      legacyRun(NOW, 'getOrCreateDecisionHistorySheetV7', [L], {}, true);
      getOrCreateDecisionHistorySheet(P);
      assertSameBooks(L, P, label);
      assert.equal(P.getSheetByName(DECISION_HISTORY_SHEET)!.calls.length > 0, formats, 'guard: ' + label);
    }
    const { L, P } = await twin({});
    const steps: Array<[string, number]> = [['PLTR', NOW], ['TSLA', NOW + 60000], ['pltr', NOW + 120000], ['PLTR', NOW + 180000]];
    for (const [t, ms] of steps) {
      legacyRun(ms, 'appendDecisionHistoryV7', [L, t, fund, tech, { ...dec, finalConviction: ms % 100 }], {}, true);
      appendDecisionHistory(P, t, fund, tech, { ...dec, finalConviction: ms % 100 }, ms);
      assertSameBooks(L, P, 'append ' + ms);
    }
    assert.equal(P.getSheetByName(DECISION_HISTORY_SHEET)!.grid().length, 5, 'guard: header + 4 rows');
    for (const t of ['pltr', 'PLTR', 'tsla', 'NVDA', 'ticker', 'Ticker']) {
      const lg = legacyRun(NOW, 'getLastDecisionV7', [L, t]).value;
      assert.deepStrictEqual(structuredClone(getLastDecision(P, t)), lg, t);
    }
    assert.equal((getLastDecision(P, 'pltr') as any).date.getTime(), NOW + 180000, 'guard: the LAST pltr row wins');
    assert.equal(getLastDecision(P, 'NVDA'), null);
    assert.equal(getLastDecision(P, 'Ticker'), null, 'guard: the header row is never matched');
    const none = await twin({});
    assert.equal(legacyRun(NOW, 'getLastDecisionV7', [none.L, 'X']).value, null);
    assert.equal(getLastDecision(none.P, 'X'), null);
  });
});

describe('FL-7b1 — watchlist stores and scanWatchlist', { skip: ready ? false : 'legacy/ not populated' }, () => {
  const DAILY = /dailyTickers:\s*\[([^\]]*)\]/.exec(LEG_SRC)![1].split(',').map((s) => s.trim().replace(/'/g, ''));

  test('getOrCreateWatchlistSheet and getWatchlistTickers (dedupe, case, blanks, fallback)', async () => {
    assert.equal(DAILY.length, 21);
    for (const initial of [{}, { [WATCHLIST_SHEET]: [['Ticker'], ['x']] }] as Array<Record<string, unknown[][]>>) {
      const { L, P } = await twin(initial);
      legacyRun(NOW, 'getOrCreateWatchlistSheetV7', [L], {}, true);
      getOrCreateWatchlistSheet(P);
      assertSameBooks(L, P, 'getOrCreate');
    }
    const grids: Array<[string, Record<string, unknown[][]>]> = [
      ['no tab', {}], ['header only', { [WATCHLIST_SHEET]: [['Ticker']] }], ['empty tab', { [WATCHLIST_SHEET]: [] }],
      ['mixed', { [WATCHLIST_SHEET]: [['Ticker'], [' tsla '], ['TSLA'], [''], ['nvda'], [123], ['Nvda'], [null as never], ['  ']] }],
    ];
    const seen = new Set<string>();
    for (const [label, initial] of grids) {
      const { L, P } = await twin(initial);
      const lg = legacyRun<string[]>(NOW, 'getWatchlistTickersV7', [L]).value;
      assert.deepStrictEqual([...getWatchlistTickers(P, DAILY)], lg, label);
      seen.add(lg.length === 21 ? 'fallback' : lg.join(','));
    }
    assert.ok(seen.has('fallback') && seen.has('TSLA,NVDA,123'), 'guard: ' + [...seen].join(' | '));
  });

  test('scanWatchlist: BUY_NOW first then conviction, errors, nulls, ties, the log, and the arguments runAnalysis receives', async () => {
    const analyses: Record<string, any> = {
      AAA: { decision: { fundBand: 'STRONG', finalConviction: 60, action: 'BUY' }, techPlan: { timing: 'BUY_NOW' } },
      BBB: { decision: { fundBand: 'OK', finalConviction: 80, action: 'WAIT' }, techPlan: { timing: 'WAIT_PULLBACK' } },
      CCC: { decision: { fundBand: 'OK', finalConviction: 75, action: 'BUY' }, techPlan: { timing: 'BUY_NOW' } },
      DDD: { decision: null, techPlan: { timing: 'BUY_NOW' } },
      EEE: { techPlan: null, decision: { fundBand: 'X', finalConviction: 0, action: 'AVOID' } },
      FFF: null,
      GGG: { decision: { fundBand: 'Z', finalConviction: 75, action: 'BUY' }, techPlan: { timing: 'BUY_NOW' } },
      HHH: { __throw: 'boom' },
      III: { __raw: 'plain string' },
      JJJ: { decision: {}, techPlan: {} },
    };
    const mkStub = (calls: unknown[][]) => (t: string, a: boolean, b: boolean): any => {
      calls.push([t, a, b]);
      const v = analyses[t];
      if (v && v.__throw) throw new Error(v.__throw);
      if (v && v.__raw) throw v.__raw;
      return v;
    };
    const wl = [['Ticker'], ...Object.keys(analyses).map((t) => [t.toLowerCase()])];
    const { L, P } = await twin({ [WATCHLIST_SHEET]: wl });
    const lcalls: unknown[][] = [], pcalls: unknown[][] = [];
    const lg = legacyRun<any[]>(NOW, 'scanWatchlistV7', [], { SpreadsheetApp: { getActiveSpreadsheet: () => L }, runAnalysisV7: mkStub(lcalls) });
    const plogs: string[] = [];
    const stubP = mkStub(pcalls);
    const rows = await scanWatchlist({ workbook: P, getTickers: (ss) => getWatchlistTickers(ss, DAILY), runAnalysis: async (t, a, b) => stubP(t, a, b), log: (m) => plogs.push(m) });
    assert.deepStrictEqual(structuredClone(rows), lg.value);
    assert.deepStrictEqual(plogs, lg.logs);
    assert.deepStrictEqual(pcalls, lcalls);
    assert.deepStrictEqual(pcalls.map((c) => c.slice(1)).filter((c) => c[0] !== false || c[1] !== false), [], 'guard: always (false, false)');
    const r = lg.value;
    assert.deepStrictEqual(r.slice(0, 3).map((x: any) => x.ticker), ['CCC', 'GGG', 'AAA'], 'guard: BUY_NOW first, ties stable');
    assert.ok(r.some((x: any) => x.ownBand === 'ERR' && x.action === 'Error: boom') && r.some((x: any) => x.action === 'plain string') && r.some((x: any) => x.ownBand === 'n/a' && x.timing === 'n/a'), 'guard: error, raw throw, null result');
    assert.ok(r.some((x: any) => x.buyNow && x.conviction === null) && r.some((x: any) => x.conviction === 0) && r.some((x: any) => x.ownBand === undefined), 'guard: null, zero and missing fields');
    assert.equal(lg.logs[0], 'Watchlist scan (10 tickers):');
    // the header-only watchlist falls back to the 21 CONFIG tickers
    const e = await twin({ [WATCHLIST_SHEET]: [['Ticker']] });
    const ecalls: unknown[][] = [], fcalls: unknown[][] = [];
    const le = legacyRun<any[]>(NOW, 'scanWatchlistV7', [], { SpreadsheetApp: { getActiveSpreadsheet: () => e.L }, runAnalysisV7: mkStub(ecalls) });
    const stubE = mkStub(fcalls);
    const elogs: string[] = [];
    const er = await scanWatchlist({ workbook: e.P, getTickers: (ss) => getWatchlistTickers(ss, DAILY), runAnalysis: async (t, a, b) => stubE(t, a, b), log: (m) => elogs.push(m) });
    assert.deepStrictEqual(structuredClone(er), le.value);
    assert.deepStrictEqual(elogs, le.logs);
    assert.equal(er.length, 21, 'guard: the fallback list ran');
    // a ticker source that returns nothing
    const nl: string[] = [];
    assert.deepStrictEqual(await scanWatchlist({ workbook: e.P, getTickers: () => null, runAnalysis: async () => null, log: (m) => nl.push(m) }), []);
    assert.deepStrictEqual(nl, ['Watchlist scan (0 tickers):']);
  });
});
