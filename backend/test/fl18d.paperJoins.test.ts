/**
 * FL-18d (James's models, phase 0, G8): "📊 QQQ since this account joined" — every account stores QQQ's close of its
 * join night, so an account that joins mid-test is judged against QQQ from that night (testing rule T8); and the
 * paper-state size check: a state holding every planned James account for a full year saves, loads and stays in
 * chunks a Sheets cell can hold.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newPaperState, paperDay, standings, qqqSinceJoined, recordJoins, accountIds, PAPER_CASH, STRATEGIES, type PaperDayInput, type PaperState, type PaperTrade } from '../src/paper/paperTrading.ts';
import { PAPER_OWNER_LIST, LILO_ID, ALL_ID, LEAPS_IDS, type LabAccount } from '../src/paper/paperLab.ts';
import { newLeapsAccount } from '../src/paper/paperLeaps.ts';
import { loadPaper, savePaper, paperTabRows, PAPER_STATE_TAB, PAPER_STATE_CHUNK } from '../src/paper/paperJob.ts';
import { MemoryTabStore } from '../src/storage/tabStore.ts';
import type { ExitReadResult } from '../src/backtest/engineRun.ts';
import type { PriceSeries } from '../src/backtest/data.ts';

const noExit = (t: string): ExitReadResult => ({ ticker: t, day: '', ok: true, actionClass: 'HOLD' as never, recommendation: 'HOLD', stopBreached: false, thesisInvalidated: false, hitT1: false, hitT2: false, t1: null, t2: null, stopLevel: null, close: null });
const DAYS = ['2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03'];
const QQQ = [500, 505, 510, 520, 530];
const qqqSeries: PriceSeries = { ticker: 'QQQ', dates: DAYS, opens: QQQ, highs: QQQ, lows: QQQ, closes: QQQ, volumes: QQQ.map(() => 1), splits: [] };
const input = (k: number, withLab = true): PaperDayInput => ({
  day: DAYS[k]!, reads: [], exitRead: noExit,
  bars: Object.fromEntries([...PAPER_OWNER_LIST, 'TSLA', 'QQQ'].map((t) => [t, { open: t === 'QQQ' ? QQQ[k]! : 100, close: t === 'QQQ' ? QQQ[k]! : 100 }])),
  ...(withLab ? { lab: { reads: [], series: new Map([['QQQ', qqqSeries]]) } } : {}),
});

/** The James accounts the plans add (docs/models/plans/01-10, section 8), for the size check. */
const JAMES_IDS = [
  'james.liloV2', 'james.pt.combo', 'james.pt.list14', 'james.meanRev', 'james.meanRevTrim', 'james.pair.mstrTsla', 'james.pair.mstrTslaSleeve', 'james.pair.best',
  'james.cycle', 'james.cycleBtc', 'james.marketMaker', 'james.winners', 'james.winners.btc', 'james.compound', 'james.trend200.q6', 'james.calls.engine', 'james.calls.guard',
];
const JAMES_LEAPS_IDS = [
  'james.leaps.fire.d60', 'james.leaps.fire.d75', 'james.leaps.fire.d85', 'james.leaps.fire.d75.cap', 'james.leaps.fire.d75.fair', 'james.leaps.fire.d75.roll',
  'james.leaps.fire.d75.trim', 'james.leaps.twin.best', 'james.leaps.winners', 'james.leaps.cycle',
];

describe('FL-18d — G8 "QQQ since this account joined"', () => {
  test('every account notes its join night and QQQ\'s close then; one that joins later gets its own, and only it shows the column', () => {
    const s = newPaperState(['TSLA']);
    paperDay(s, input(0));
    assert.equal(s.joins!.engine!.day, '2026-10-28');
    assert.equal(s.joins!.engine!.qqqClose, 500);
    for (const id of accountIds(s)) assert.deepEqual(s.joins![id], { day: '2026-10-28', qqqClose: 500 }, id);
    assert.ok(accountIds(s).includes(LILO_ID) && accountIds(s).includes(ALL_ID) && STRATEGIES.every((id) => accountIds(s).includes(id)));
    paperDay(s, input(1));
    // a James account joins on 10-30 (as phases 1-4 will add them)
    s.lab!.accounts['james.test'] = { cash: PAPER_CASH, pos: {}, toSell: [], toBuy: [], taxPaid: 0 } as LabAccount;
    paperDay(s, input(2));
    assert.deepEqual(s.joins!['james.test'], { day: '2026-10-30', qqqClose: 510 });
    paperDay(s, input(3));
    assert.equal(s.marks.at(-1)!.qqqClose, 520);
    const v = qqqSinceJoined(s.joins!['james.test'], 520)!;
    assert.ok(Math.abs(v - (PAPER_CASH + PAPER_CASH * (520 / 510 - 1) * 0.75)) < 1e-6, 'after the 25% tax on the gain');
    assert.equal(qqqSinceJoined(undefined, 520), null);
  });

  test('the Paper Trading tab shows the column for a late joiner only (its row comes from standings)', () => {
    const s = newPaperState(['TSLA']);
    for (let k = 0; k < 3; k++) paperDay(s, input(k));
    s.joins!['lab.turtle'] = { day: '2026-10-29', qqqClose: 505 };
    paperDay(s, input(3));
    const st = standings(s);
    const turtle = st.find((r) => r.name.startsWith('Turtle (list'))!;
    assert.ok(Math.abs(turtle.qqqSinceJoined! - (PAPER_CASH + PAPER_CASH * (520 / 505 - 1) * 0.75)) < 1e-6);
    assert.ok(st.filter((r) => r !== turtle).every((r) => r.qqqSinceJoined == null), 'the others joined at the start: Hold QQQ is their yardstick');
    const rows = paperTabRows({ state: s, trades: [] });
    assert.ok(String(rows[3]![5]).startsWith('📊 QQQ since this account joined'));
    assert.equal(rows.find((r) => String(r[0]).startsWith('Turtle (list'))![5], '+2.2%');
  });

  test('a state saved before G8: the accounts already there are back-filled with their join night; one that joins tonight is not', () => {
    const s = newPaperState(['TSLA']);
    paperDay(s, input(0)); paperDay(s, input(1));
    delete (s as { joins?: unknown }).joins;
    // tonight a new account appears (created before paperDay, as a phase would add it)
    const before = new Set(accountIds(s));
    s.lab!.accounts['james.new'] = { cash: PAPER_CASH, pos: {}, toSell: [], toBuy: [], taxPaid: 0 } as LabAccount;
    recordJoins(s, '2026-10-30', 510, qqqSeries, before);
    assert.deepEqual(s.joins!.engine, { day: '2026-10-28', qqqClose: 500, backfilled: true });
    assert.deepEqual(s.joins!['lab.turtle'], { day: '2026-10-28', qqqClose: 500, backfilled: true });
    assert.deepEqual(s.joins!['james.new'], { day: '2026-10-30', qqqClose: 510 });
    // and through paperDay
    const t = newPaperState(['TSLA']);
    paperDay(t, input(0)); paperDay(t, input(1));
    delete (t as { joins?: unknown }).joins;
    paperDay(t, input(2));
    assert.deepEqual(t.joins!['lab.wyckoff'], { day: '2026-10-28', qqqClose: 500, backfilled: true });
  });
});

describe('FL-18d — G8 paper-state size', () => {
  test('a year with every planned James account (~27 more, shares and LEAPS) saves and loads intact, in chunks a Sheets cell holds', async () => {
    const s: PaperState = newPaperState(['TSLA', 'AVGO', 'GOOGL', 'MSTR', 'SQZB', 'IBIT']);
    paperDay(s, input(0));
    const lab = s.lab!;
    for (const id of JAMES_IDS) lab.accounts[id] = { cash: 12_345.67, pos: Object.fromEntries(PAPER_OWNER_LIST.slice(0, 6).map((t) => [t, { shares: 123, cost: 12_345.678, entryDate: '2026-11-02' }])), toSell: ['NVDA'], toBuy: ['AMD', 'MQZC'], taxPaid: 1234.5 };
    lab.leaps ??= {};
    for (const id of [...LEAPS_IDS, ...JAMES_LEAPS_IDS]) {
      const a = newLeapsAccount(PAPER_CASH);
      a.held = PAPER_OWNER_LIST.slice(0, 5).map((t) => ({ ticker: t, symbol: t + '280121C00150000', strike: 150, expUnix: 1_832_198_400, contracts: 3, cost: 21_345.5, mid: 75.25 }));
      lab.leaps[id] = a;
    }
    recordJoins(s, '2026-11-02', 520);
    const ids = [...accountIds(s), 'qqq', 'basket', 'lab.list', 'lab.list14'];
    assert.ok(ids.length >= 60, 'every account: ' + ids.length);
    // a trading year of marks and about 20 trades a night
    const trades: PaperTrade[] = [];
    for (let k = 0; k < 252; k++) {
      const day = new Date(Date.UTC(2026, 9, 29) + k * 86_400_000 * 1.45).toISOString().slice(0, 10);
      s.marks.push({ day, values: Object.fromEntries(ids.map((id, i) => [id, 100_000 + i * 123.456 + k * 7.89])), qqqClose: 500 + k });
      for (let j = 0; j < 20; j++) trades.push({ day, strategy: ids[j % ids.length]!, side: j % 2 ? 'SELL' : 'BUY', ticker: 'NVDA $150 call 2028-01-21', shares: 12, price: 123.45, value: 1481.4, tax: 12.34, why: 'James — a reason of ordinary length for the trade' });
    }
    const store = new MemoryTabStore();
    await savePaper(store, { state: s, trades });
    const rows = (await store.read(PAPER_STATE_TAB, 1))!;
    const text = rows.map((r) => String(r[0])).join('');
    assert.ok(rows.every((r) => String(r[0]).length <= PAPER_STATE_CHUNK && PAPER_STATE_CHUNK < 50_000), 'every chunk fits a cell');
    assert.ok(text.length < 10_000_000, 'well under a Sheets request: ' + text.length + ' characters in ' + rows.length + ' rows');
    const back = (await loadPaper(store))!;
    assert.deepEqual(back.state, JSON.parse(JSON.stringify(s)));
    assert.equal(back.trades.length, trades.length);
    if (process.env.SHOW_SIZE) console.log('paper state: ' + text.length + ' characters, ' + rows.length + ' rows');
  });
});
