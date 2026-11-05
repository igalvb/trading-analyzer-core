/**
 * FL-17a: the research accounts in the paper test (owner 2026-10-28, paper/paperLab.ts): each lab model with its
 * best setup on the owner's list; buys funded from QQQ, spare money in QQQ, the 200-day sell, the list benchmark.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newPaperState, paperDay, standings, PAPER_CASH, type PaperDayInput } from '../src/paper/paperTrading.ts';
import { LAB_SETUPS, PAPER_OWNER_LIST, LILO_ID, ALL_ID } from '../src/paper/paperLab.ts';
import { leapsNight, newLeapsAccount, leapsValue } from '../src/paper/paperLeaps.ts';
import type { EngineRead, ExitReadResult } from '../src/backtest/engineRun.ts';
import type { PriceSeries } from '../src/backtest/data.ts';

const read = (ticker: string, dirs: Record<string, string>, extra: Partial<EngineRead> = {}): EngineRead => ({
  ticker, day: '', ok: true, finalConviction: 50, action: null, timing: 'WAIT_PULLBACK', regime: 'CHOP', entryPrice: 100, entryHigh: 101, entryConfidencePct: 50, stop: 90,
  ownScore: 60, blocked: false, verdict: 'MAJORITY', directions: dirs, close: 100, ...extra,
});
const noExit = (t: string): ExitReadResult => ({ ticker: t, day: '', ok: true, actionClass: 'HOLD' as never, recommendation: 'HOLD', stopBreached: false, thesisInvalidated: false, hitT1: false, hitT2: false, t1: null, t2: null, stopLevel: null, close: null });

/** 250 trading-day dates ending on `last` (weekdays only, holidays ignored). */
function datesTo(last: string, n: number): string[] {
  const out: string[] = []; const d = new Date(last + 'T12:00:00Z');
  while (out.length < n) { if (d.getUTCDay() % 6) out.unshift(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() - 1); }
  return out;
}
function series(t: string, dates: string[], closes: number[]): PriceSeries {
  return { ticker: t, dates, opens: closes, highs: closes, lows: closes, closes, volumes: closes.map(() => 1e6), splits: [] };
}

describe('FL-17a — research accounts in the paper test', () => {
  const D = datesTo('2026-11-03', 260);
  const days = D.slice(-5); // 10-28 .. 11-03
  const rising = D.map((_, i) => 50 + i * 0.2);
  const all = (closeOf: (t: string) => number): Record<string, { open: number; close: number }> =>
    Object.fromEntries([...PAPER_OWNER_LIST, 'QQQ'].map((t) => [t, { open: closeOf(t), close: closeOf(t) }]));
  const input = (k: number, dirs: Record<string, Record<string, string>>, ser: Map<string, PriceSeries>, closeOf: (t: string) => number): PaperDayInput => {
    const reads = PAPER_OWNER_LIST.map((t) => read(t, dirs[t] ?? {}));
    return { day: days[k] as string, bars: all(closeOf), reads: [], exitRead: noExit, lab: { reads, series: ser } };
  };

  test('joins on the decide day; at the first open Turtle buys a third, the rest goes into QQQ; the list benchmark is bought', () => {
    const s = newPaperState(['TSLA']);
    const ser = new Map(PAPER_OWNER_LIST.map((t) => [t, series(t, D, rising)]));
    const px = (t: string): number => (t === 'QQQ' ? 500 : 100);
    assert.deepEqual(paperDay(s, input(0, { NVDA: { turtle: 'bullish' } }, ser, px)), []);
    assert.equal(s.lab!.joined, '2026-10-28');
    assert.deepEqual(s.lab!.accounts['lab.turtle']!.toBuy, ['NVDA']);
    const t = paperDay(s, input(1, {}, ser, px)).filter((x) => x.strategy === 'lab.turtle');
    assert.deepEqual(t.map((x) => [x.side, x.ticker, x.shares]), [['BUY', 'NVDA', 333], ['BUY', 'QQQ', 133]]);
    assert.ok(s.lab!.listBench, 'list benchmark bought at the first open');
    assert.equal(s.marks.at(-1)!.values['lab.list'], PAPER_CASH);
    assert.equal(s.marks.at(-1)!.values['lab.list14'], PAPER_CASH, 'holding the 14 researched stocks too');
    const st = standings(s);
    assert.deepEqual(st.filter((r) => r.bench).map((r) => r.name).sort(), ['Hold QQQ', 'Hold all 1 equally (4 + watchlist)', 'Hold your 14 equally', 'Hold your 17 equally (14 + SQZB, IBIT, SQZA)']);
    assert.ok(st.every((r) => r.maxDrawdownPct === 0));
    assert.ok(standings(s).some((r) => r.name.startsWith('Turtle (list')));
    assert.equal(Object.keys(s.lab!.accounts).length, LAB_SETUPS.length + 1, 'plus the shares half of Everything together');
  });

  test('a 200-day break sells at the next open with 25% tax; the money goes back into QQQ', () => {
    const s = newPaperState(['TSLA']);
    const ser = new Map(PAPER_OWNER_LIST.map((t) => [t, series(t, D, rising)]));
    let nv = 100;
    const px = (t: string): number => (t === 'QQQ' ? 500 : t === 'NVDA' ? nv : 100);
    paperDay(s, input(0, { NVDA: { turtle: 'bullish' } }, ser, px));
    paperDay(s, input(1, {}, ser, px));
    // NVDA falls far under its 200-day average on day 2
    const crash = rising.slice(); crash[crash.length - 3] = 40; ser.set('NVDA', series('NVDA', D, crash));
    nv = 40;
    paperDay(s, input(2, {}, ser, px));
    assert.deepEqual(s.lab!.accounts['lab.turtle']!.toSell, ['NVDA']);
    nv = 120;
    const t = paperDay(s, input(3, {}, ser, px)).filter((x) => x.strategy === 'lab.turtle');
    const sell = t.find((x) => x.side === 'SELL' && x.ticker === 'NVDA')!;
    assert.equal(sell.tax, 333 * 20 * 0.25);
    assert.ok(t.some((x) => x.side === 'BUY' && x.ticker === 'QQQ'));
    assert.equal(s.lab!.accounts['lab.turtle']!.pos.NVDA, undefined);
  });

  test('the engine accounts rank by conviction; "current" holds off when the models disagree', () => {
    const s = newPaperState(['TSLA']);
    const ser = new Map(PAPER_OWNER_LIST.map((t) => [t, series(t, D, rising)]));
    const reads = PAPER_OWNER_LIST.map((t) => read(t, {}, t === 'AMD' ? { timing: 'BUY_NOW', finalConviction: 72, verdict: 'NO_CONSENSUS' } : t === 'MQZC' ? { finalConviction: 80 } : {}));
    paperDay(s, { day: days[0] as string, bars: all(() => 100), reads: [], exitRead: noExit, lab: { reads, series: ser } });
    assert.deepEqual(s.lab!.accounts['lab.engine']!.toBuy, ['AMD', 'MQZC']);
    assert.deepEqual(s.lab!.accounts['lab.current']!.toBuy, ['MQZC']);
  });

  test('LILO: a tier-1 read with a ladder sets a fifth aside; the next day the rung the low reaches fills, the rest goes into QQQ', () => {
    const s = newPaperState(['TSLA']);
    const ser = new Map(PAPER_OWNER_LIST.map((t) => [t, series(t, D, rising)]));
    const px = (t: string): number => (t === 'QQQ' ? 500 : 100);
    const reads = PAPER_OWNER_LIST.map((t) => read(t, {}, t === 'NVDA' ? { finalConviction: 75, stop: 80, lilo: { entryLow: 95, entryHigh: 100, entryCount: 2, t1: 120, t2: 140 } } : {}));
    paperDay(s, { day: days[0] as string, bars: all(px), reads: [], exitRead: noExit, lab: { reads, series: ser } });
    assert.equal(s.lab!.lilo!.lines.NVDA!.reserved, 20_000);
    const nv = rising.slice(); nv[nv.length - 4] = 98; ser.set('NVDA', series('NVDA', D, nv));
    const t = paperDay(s, { day: days[1] as string, bars: all(px), reads: [], exitRead: noExit, lab: { reads: [], series: ser } }).filter((x) => x.strategy === LILO_ID);
    assert.deepEqual(t.map((x) => [x.side, x.ticker, x.shares, x.price]), [['BUY', 'QQQ', 160, 500], ['BUY', 'NVDA', 100, 98]]);
    assert.equal(s.lab!.lilo!.lines.NVDA!.buyRungs.length, 1, 'the $95 rung still waits');
  });

  test('LEAPS: the twin\'s buy becomes an order for the pick; it fills the next night at the ask; 60 days to expiry sells at the bid', () => {
    const a = newLeapsAccount(100_000);
    const exp = Math.floor(Date.UTC(2028, 0, 21) / 1000), now = Math.floor(Date.UTC(2026, 9, 28) / 1000);
    const pick = { symbol: 'NVDA280121C00100000', strike: 100, expUnix: exp, bid: 49, ask: 50 };
    const night = (o: Partial<Parameters<typeof leapsNight>[1]>): Parameters<typeof leapsNight>[1] => ({
      qqq: { open: 500, close: 500 }, quote: () => ({ bid: 51, ask: 52 }), pick: () => pick, nowUnix: now, want: new Set(['NVDA']), slots: 3, fill: true, decide: true, ...o });
    assert.deepEqual(leapsNight(a, night({ fill: false })), []);
    assert.equal(a.orders[0]!.contracts, 6, '$33,333 / $5,000 a contract');
    const t = leapsNight(a, night({}));
    assert.deepEqual(t.map((x) => [x.side, x.shares, x.price]), [['BUY', 134, 500], ['BUY', 6, 52]], 'spare money into QQQ at the open (10% kept over the ask); 6 contracts at the ask');
    assert.equal(a.held[0]!.cost, 31_200);
    leapsNight(a, night({ nowUnix: exp - 59 * 86_400 }));
    assert.equal(a.orders[0]!.side, 'SELL');
    const sold = leapsNight(a, night({ nowUnix: exp - 58 * 86_400, quote: () => ({ bid: 70, ask: 71 }), want: new Set() }));
    const sell = sold.find((x) => x.side === 'SELL' && x.ticker !== 'QQQ')!;
    assert.equal(sell.tax, (6 * 70 * 100 - 31_200) * 0.25);
    assert.equal(a.held.length, 0);
    assert.ok(leapsValue(a, 500) > 100_000);
  });

  test('SQZB and IBIT are on the list; a stock too young for a 200-day average is sold on the model\'s own sell', () => {
    assert.ok(PAPER_OWNER_LIST.includes('SQZB') && PAPER_OWNER_LIST.includes('IBIT'));
    const s = newPaperState(['TSLA']);
    const ser = new Map(PAPER_OWNER_LIST.map((t) => [t, t === 'SQZB' ? series(t, D.slice(-95), rising.slice(-95)) : series(t, D, rising)]));
    const px = (t: string): number => (t === 'QQQ' ? 500 : 100);
    paperDay(s, input(0, { SQZB: { turtle: 'bullish' } }, ser, px));
    paperDay(s, input(1, {}, ser, px));
    assert.ok(s.lab!.accounts['lab.turtle']!.pos.SQZB);
    paperDay(s, input(2, { SQZB: { turtle: 'cautionary' } }, ser, px));
    assert.deepEqual(s.lab!.accounts['lab.turtle']!.toSell, ['SQZB']);
  });

  test('Everything together: buys on the engine OR 2 of Turtle / Schabacker / E&M; half the money in shares, half in LEAPS on the same stocks', () => {
    const s = newPaperState(['TSLA']);
    const ser = new Map(PAPER_OWNER_LIST.map((t) => [t, series(t, D, rising)]));
    const px = (t: string): number => (t === 'QQQ' ? 500 : 100);
    const reads = PAPER_OWNER_LIST.map((t) => read(t, t === 'NVDA' ? { turtle: 'bullish', schabacker: 'bullish' } : t === 'MQZC' ? { turtle: 'bullish' } : {}, t === 'AMD' ? { finalConviction: 75 } : {}));
    const exp = Math.floor(Date.UTC(2028, 0, 21) / 1000);
    const options = { quote: () => ({ bid: 9, ask: 10 }), pick: (t: string) => ({ symbol: t + '280121C', strike: 100, expUnix: exp, bid: 9, ask: 10 }), nowUnix: Math.floor(Date.UTC(2026, 9, 27) / 1000) };
    paperDay(s, { day: days[0] as string, bars: all(px), reads: [], exitRead: noExit, lab: { reads, series: ser, options } });
    assert.deepEqual(s.lab!.accounts['all.shares']!.toBuy, ['AMD', 'NVDA'], 'the engine\'s pick first; MQZC has only 1 of 3');
    assert.deepEqual(s.lab!.leaps!['all.leaps']!.orders.map((x) => [x.ticker, x.contracts]), [['AMD', 16], ['NVDA', 16]], '$50,000 / 3 per position, $1,000 a contract');
    const t = paperDay(s, { day: days[1] as string, bars: all(px), reads: [], exitRead: noExit, lab: { reads: [], series: ser, options } });
    assert.deepEqual(t.filter((x) => x.strategy === 'all.shares' && x.ticker !== 'QQQ').map((x) => [x.ticker, x.shares]), [['AMD', 166], ['NVDA', 166]]);
    assert.equal(t.filter((x) => x.strategy === 'all.leaps' && x.ticker !== 'QQQ').length, 2);
    assert.ok(Math.abs(s.marks.at(-1)!.values[ALL_ID]! - PAPER_CASH) < 4_000, 'about $100,000 after the buys (the LEAPS are marked at the middle of bid and ask)');
    assert.ok(standings(s).some((r) => r.name.startsWith('Everything together')));
  });
});
