/**
 * Live broker bot, phase 1 (docs/live-broker/phases/1-planner-dry-run.md): the planner, the rails, the 💵 Live Log,
 * the fee model and the dry run, with no broker. The Tests section of the phase file, one block each:
 * target weights per account type (2/3/5 slots, idle QQQ); rounding with and without fractions; every rail (refuse
 * cases); stale-signal refusal (late Nightly, holiday, half day); fee filter; log idempotent per day; comparison
 * values on the same basis.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryTabStore } from '../src/storage/tabStore.ts';
import { newPaperState, type PaperState } from '../src/paper/paperTrading.ts';
import { newLabState, labValues, LILO_ID, LEAPS_IDS, ALL_ID, PAPER_OWNER_LIST, type LabPos } from '../src/paper/paperLab.ts';
import { savePaper } from '../src/paper/paperJob.ts';
import { LIVE_DEFAULTS, liveConfigFromEnv, orderFee, IBKR_PRO_FIXED, type LiveConfig } from '../src/live/liveConfig.ts';
import { nyseHolidays, isTradingDay, isHalfDay, lastClosedTradingDay, previousTradingDay } from '../src/live/marketCalendar.ts';
import { targetWeights, supportOf, SUPPORTED_ACCOUNTS, type Target } from '../src/live/target.ts';
import { planTrades, roundShares, orderRef, type PlannedOrder } from '../src/live/planner.ts';
import { checkRails, orderRail, freshnessRail, ALLOW_LIST, type RailInput } from '../src/live/rails.ts';
import { accountingOf, fallAlerts, parseRealAccount, shadowAccount, fileAccountSource, type RealAccount } from '../src/live/account.ts';
import { compareWithPaper, liveLogRows, LIVE_LOG_TAB, LIVE_LOG_HEADER, LIVE_LOG_COLS } from '../src/live/liveLog.ts';
import { buildFeeReport, liveFeeStats, feeReportSection, feeReportText } from '../src/live/feeReport.ts';
import { RESEARCH_FEES } from '../src/live/researchFees.ts';
import { runLiveDryRun, planLiveNight, liveAttention, type LiveNight } from '../src/live/liveJob.ts';
import { liveFeeReportMain } from '../src/live/feeReportCli.ts';
import { sheetFor, isAllowListedName, PROTECTED_TABS, LIVE_REPORT_TABS } from '../src/sheets/tabs.ts';
import { NIGHTLY_ORDER, stepDef } from '../src/jobs/nightly/steps.ts';
import { RESULTS } from '../src/profile/results.ts';
/** Cases that read a results pack (profile `results`): skipped under a profile that names none (the test profile);
 *  a copy with its own pack runs them with its profile (npm test does not). */
const NEEDS_PACK = RESULTS ? false : 'needs a results pack (the profile names none)';

/** Noon UTC on a New York day plus `h` hours of New York winter time (UTC-5). */
const nyAt = (day: string, hh: number, mm = 0): number => Date.parse(day + 'T00:00:00Z') + ((hh + 5) * 60 + mm) * 60_000;
const nyAtSummer = (day: string, hh: number, mm = 0): number => Date.parse(day + 'T00:00:00Z') + ((hh + 4) * 60 + mm) * 60_000;
const near = (a: number, b: number, eps = 1e-6): void => assert.ok(Math.abs(a - b) < eps, a + ' != ' + b);

function stateWith(id: string, acct: { cash: number; pos: Record<string, LabPos>; toBuy?: string[]; toSell?: string[] }, lastDay = '2026-11-02'): PaperState {
  const s = newPaperState(['TSLA']);
  s.lastDay = lastDay;
  s.lab = newLabState('2026-10-28', 100_000);
  s.lab.accounts[id] = { cash: acct.cash, pos: acct.pos, toBuy: acct.toBuy ?? [], toSell: acct.toSell ?? [], taxPaid: 0 };
  return s;
}
const pos = (shares: number, cost: number): LabPos => ({ shares, cost, entryDate: '2026-10-29' });
const cash = (v: number, start = '2026-11-02'): RealAccount => ({ asOf: null, cash: v, settledCash: v, positions: [], realised: [], taxPaidFromBank: 0, feesPaid: 0, start: { day: start, value: v } });
const tgt = (weights: Record<string, number>, slots = 3, day = '2026-11-02'): Target => ({ account: 'lab.turtle', label: 'Turtle', slots, decisionDay: day, weights, why: {}, sells: [], buys: [] });
const cfg = (over: Partial<LiveConfig> = {}): LiveConfig => ({ ...LIVE_DEFAULTS, ...over });

describe('1.1 target weights from the paper twin', () => {
  test('2 slots (Broker Course): a kept stock at its own weight tonight, a new buy at 1/2, the rest in QQQ; equal mode = 1/2 each', () => {
    const s = stateWith('lab.broker', { cash: 1_000, pos: { NVDA: pos(100, 10_000), QQQ: pos(100, 50_000) }, toBuy: ['MQZC'] });
    const close = (t: string): number | null => ({ NVDA: 150, QQQ: 500, MQZC: 100 } as Record<string, number>)[t] ?? null;
    const m = targetWeights(s, 'lab.broker', close);
    assert.ok(m.ok);
    const eq = 15_000 + 50_000 + 1_000;
    near(m.target.weights.NVDA!, 15_000 / eq);
    near(m.target.weights.MQZC!, 0.5);
    near(m.target.weights.QQQ!, 1 - 15_000 / eq - 0.5);
    assert.equal(m.target.slots, 2);
    assert.deepEqual(m.target.buys, ['MQZC']);
    const e = targetWeights(s, 'lab.broker', close, 'equal');
    assert.ok(e.ok);
    assert.deepEqual(e.target.weights, { NVDA: 0.5, MQZC: 0.5, QQQ: 0 });
  });

  test('3 slots (Turtle): a stock the twin sells goes to 0, two new buys at 1/3, QQQ the last third', () => {
    const s = stateWith('lab.turtle', { cash: 0, pos: { AVGO: pos(10, 3_000), QQQ: pos(100, 50_000) }, toSell: ['AVGO'], toBuy: ['MQZC', 'AMD'] });
    const r = targetWeights(s, 'lab.turtle', (t) => ({ AVGO: 300, QQQ: 500, MQZC: 100, AMD: 200 } as Record<string, number>)[t] ?? null);
    assert.ok(r.ok);
    assert.equal(r.target.weights.AVGO, 0);
    near(r.target.weights.MQZC!, 1 / 3); near(r.target.weights.AMD!, 1 / 3); near(r.target.weights.QQQ!, 1 / 3);
    assert.deepEqual(r.target.sells, ['AVGO']);
    assert.match(r.target.why.AVGO!, /200-day trend broke/);
  });

  test('5 slots (Engine + models): a new buy gets only the room the kept stocks leave; never below 0 in QQQ', () => {
    const p = { TSLA: pos(1, 1), AVGO: pos(1, 1), GOOGL: pos(1, 1), MSTR: pos(1, 1) };
    const s = stateWith('lab.current', { cash: 0, pos: p, toBuy: ['MQZC'] });
    // four stocks that grew to 22% each leave 12% for the fifth
    const r = targetWeights(s, 'lab.current', (t) => (t === 'MQZC' ? 50 : 22));
    assert.ok(r.ok);
    near(r.target.weights.MQZC!, 0); // 4 x 22 / 88 = 100%: nothing left
    const s2 = stateWith('lab.current', { cash: 12, pos: p, toBuy: ['MQZC'] });
    const r2 = targetWeights(s2, 'lab.current', (t) => (t === 'MQZC' ? 50 : 22));
    assert.ok(r2.ok);
    near(r2.target.weights.MQZC!, 0.12); near(r2.target.weights.QQQ!, 0);
    near(Object.values(r2.target.weights).reduce((a, b) => a + b, 0), 1);
  });

  test('idle money: an account in cash only targets 100% QQQ', () => {
    const r = targetWeights(stateWith('lab.trend200', { cash: 100_000, pos: {} }), 'lab.trend200', () => 500);
    assert.ok(r.ok);
    assert.deepEqual(r.target.weights, { QQQ: 1 });
  });

  test('supported: the 10 research accounts; the originals, LILO, LEAPS and Everything together are refused with a reason', () => {
    assert.equal(SUPPORTED_ACCOUNTS.length, 10);
    for (const s of SUPPORTED_ACCOUNTS) assert.ok(supportOf(s.id).ok, s.id);
    for (const id of ['current', 'turtle', LILO_ID, LEAPS_IDS[0]!, ALL_ID, 'all.shares']) {
      const s = supportOf(id);
      assert.ok(!s.ok, id);
      assert.ok(s.why.length > 20, id);
    }
    assert.match((supportOf('nope') as { why: string }).why, /not an account/);
    const r = targetWeights(stateWith('lab.broker', { cash: 1, pos: {} }), LILO_ID, () => 1);
    assert.ok(!r.ok && /ladders/.test(r.why));
  });

  test('an ended test and a missing account give a plain reason', () => {
    const s = stateWith('lab.broker', { cash: 1, pos: {} }, '2027-10-29');
    const r = targetWeights(s, 'lab.broker', () => 1);
    assert.ok(!r.ok && /ended/.test(r.why));
    const s2 = stateWith('lab.broker', { cash: 1, pos: {} });
    delete s2.lab!.accounts['lab.turtle'];
    const r2 = targetWeights(s2, 'lab.turtle', () => 1);
    assert.ok(!r2.ok && /no saved state/.test(r2.why));
  });
});

describe('1.2 trades: rounding, fee filter, drift', () => {
  const px = (t: string): number | null => ({ NVDA: 180, QQQ: 600, MQZC: 95, AMD: 250 } as Record<string, number>)[t] ?? null;

  test('rounding with fractions (4 decimals) and without (whole shares, rounded down)', () => {
    assert.equal(roundShares(2.99999, false), 2);
    assert.equal(roundShares(1.851851, true), 1.8518);
    assert.equal(roundShares(-1, true), 0);
    const t = tgt({ NVDA: 1 / 3, QQQ: 2 / 3 });
    const whole = planTrades(t, cash(1_000), px, cfg({ fractional: false }));
    assert.deepEqual(whole.orders.map((o) => [o.ticker, o.side, o.qty]), [['NVDA', 'BUY', 1], ['QQQ', 'BUY', 1]]);
    const frac = planTrades(t, cash(1_000), px, cfg({ fractional: true }));
    const nv = frac.orders.find((o) => o.ticker === 'NVDA')!, q = frac.orders.find((o) => o.ticker === 'QQQ')!;
    assert.equal(nv.qty, 1.8518);
    assert.ok(q.qty > 1.08 && q.qty < 1.11, String(q.qty));
    assert.ok(frac.orders.reduce((s, o) => s + o.value + o.fee, 0) <= 1_000 + 1e-9, 'never more than the cash');
    assert.ok(frac.driftPct < whole.driftPct, 'fractions follow the twin more closely');
    assert.equal(nv.ref, orderRef('2026-11-02', 'lab.turtle', 'NVDA', 'BUY'));
  });

  test('sells come first and fund the buys; a stock the twin sells is sold whole', () => {
    const acct: RealAccount = { ...cash(100), positions: [{ ticker: 'AMD', shares: 2.5, cost: 500 }, { ticker: 'QQQ', shares: 0.5, cost: 280 }] };
    const p = planTrades(tgt({ AMD: 0, MQZC: 1 / 3, QQQ: 2 / 3 }), acct, px, cfg());
    assert.deepEqual(p.orders.map((o) => o.side + ' ' + o.ticker), ['SELL AMD', 'BUY MQZC', 'BUY QQQ']);
    assert.equal(p.orders[0]!.qty, 2.5);
    assert.ok(p.orders[0]!.fullExit);
  });

  test('fee filter: a trade under $50 is skipped (a small QQQ top-up), but a full exit is never skipped', () => {
    const acct: RealAccount = { ...cash(30), positions: [{ ticker: 'QQQ', shares: 1.5, cost: 900 }, { ticker: 'MQZC', shares: 0.2, cost: 19 }] };
    const p = planTrades(tgt({ MQZC: 0, QQQ: 1 }), acct, px, cfg());
    assert.deepEqual(p.orders.map((o) => o.side + ' ' + o.ticker), ['SELL MQZC']);
    assert.equal(p.orders[0]!.value, 0.2 * 95);
    assert.equal(p.skipped.length, 1);
    assert.equal(p.skipped[0]!.ticker, 'QQQ');
    assert.match(p.skipped[0]!.why, /under \$50/);
    const big = planTrades(tgt({ MQZC: 0, QQQ: 1 }), acct, px, cfg({ minTrade: 10 }));
    assert.deepEqual(big.orders.map((o) => o.side + ' ' + o.ticker), ['SELL MQZC', 'BUY QQQ']);
  });

  test('drift: per ticker and in total, in points of the account', () => {
    const p = planTrades(tgt({ NVDA: 0.5, QQQ: 0.5 }), cash(1_000), px, cfg({ fractional: false }));
    const nv = p.drift.find((d) => d.ticker === 'NVDA')!;
    assert.equal(nv.targetPct, 50);
    assert.equal(nv.nowPct, 0);
    near(nv.afterPct, 36, 1e-9); // 2 shares x $180
    assert.ok(p.driftPct > 10);
  });

  test('IBKR Pro fee estimate: $0.005 a share, at least $1, at most 1% of the order', () => {
    assert.equal(orderFee(1, 100), 1);
    assert.equal(orderFee(1_000, 10), 5);
    assert.equal(orderFee(0.5, 100), 0.5);
    assert.equal(orderFee(300, 1), 1.5);
    assert.equal(orderFee(0, 100), 0);
    assert.equal(orderFee(1, 100, { ...IBKR_PRO_FIXED, perOrderMin: 2 }), 1);
  });

  test('settings from the environment, with plain defaults', () => {
    const c = liveConfigFromEnv({ LIVE_FOLLOW_ACCOUNT: 'lab.turtle', LIVE_FRACTIONAL: '0', LIVE_MIN_TRADE: '25', LIVE_HALTED: 'yes', LIVE_TARGET_MODE: 'equal', LIVE_FEE_MIN: '0.35' });
    assert.equal(c.follow, 'lab.turtle'); assert.equal(c.fractional, false); assert.equal(c.minTrade, 25); assert.equal(c.halted, true); assert.equal(c.targetMode, 'equal'); assert.equal(c.fees.perOrderMin, 0.35);
    const d = liveConfigFromEnv({});
    assert.equal(d.follow, 'auto'); assert.equal(d.startValue, 1_000); assert.equal(d.maxOrders, 10); assert.equal(d.halted, false); assert.equal(d.targetMode, 'mirror'); assert.deepEqual(d.alertFalls, [0.2, 0.35]);
  });
});

describe('1.3 safety rails: each one refuses with a plain reason', () => {
  const order = (o: Partial<PlannedOrder>): PlannedOrder => ({ ticker: 'NVDA', side: 'BUY', kind: 'share', qty: 1, price: 100, value: 100, fee: 1, why: '', ref: 'r-' + (o.ticker ?? 'NVDA') + (o.side ?? 'BUY') + (o.qty ?? 1), fullExit: false, ...o });
  const base = (over: Partial<RailInput> = {}): RailInput => ({
    orders: [], held: new Map([['NVDA', 2]]), heldCalls: new Map([['NVDA', 1]]), slots: 2, accountValue: 1_000, settledCash: 1_000, maxOrders: 10, capSlack: 0.1,
    halted: false, decisionDay: '2026-11-02', lastTradingDay: '2026-11-02', priceDays: new Map([['NVDA', '2026-11-02'], ['QQQ', '2026-11-02']]), ...over,
  });

  test('a clean plan passes every rail', () => {
    const r = checkRails(base({ orders: [order({}), order({ ticker: 'QQQ', value: 500, price: 500 })] }));
    assert.ok(r.ok); assert.equal(r.passed.length, 2); assert.match(r.checks, /^OK: long-only/);
  });

  test('long-only: selling more than held (a short), a put, writing a call are refused; buying a call is allowed', () => {
    assert.match(orderRail(order({ side: 'SELL', qty: 3 }), base())!, /short sale/);
    assert.equal(orderRail(order({ side: 'SELL', qty: 2 }), base()), null);
    assert.match(orderRail(order({ kind: 'put' }), base())!, /puts are not allowed/);
    assert.match(orderRail(order({ kind: 'call', side: 'SELL', qty: 2 }), base())!, /write options/);
    assert.equal(orderRail(order({ kind: 'call', side: 'SELL', qty: 1 }), base()), null);
    assert.equal(orderRail(order({ kind: 'call', side: 'BUY', qty: 1, value: 450 }), base()), null, 'a long call that fits the cap');
    assert.match(orderRail(order({ qty: 0 }), base())!, /not a positive/);
  });

  test('allow-list: the owner\'s list plus QQQ only', () => {
    assert.ok(ALLOW_LIST.has('QQQ'));
    for (const t of PAPER_OWNER_LIST) assert.ok(ALLOW_LIST.has(t), t);
    assert.equal(ALLOW_LIST.size, PAPER_OWNER_LIST.length + 1);
    assert.match(orderRail(order({ ticker: 'AAPL' }), base())!, /not on the owner's list or QQQ/);
  });

  test('cap: a buy is at most the slot + 10% (2 stocks: 60%); QQQ up to the whole account; sells are not capped', () => {
    assert.match(orderRail(order({ value: 610 }), base())!, /above the cap of \$600\.00/);
    assert.equal(orderRail(order({ value: 590 }), base()), null);
    assert.match(orderRail(order({ value: 440 }), base({ slots: 3 }))!, /1\/3 of the account \+ 10%/);
    assert.equal(orderRail(order({ ticker: 'QQQ', value: 1_000 }), base()), null);
    assert.match(orderRail(order({ ticker: 'QQQ', value: 1_001 }), base())!, /whole account/);
    assert.equal(orderRail(order({ side: 'SELL', qty: 2, value: 900 }), base()), null);
  });

  test('an order refused by a rail is dropped; the rest of the plan goes on', () => {
    const r = checkRails(base({ orders: [order({ ticker: 'AAPL' }), order({})] }));
    assert.ok(!r.ok);
    assert.equal(r.planRefusals.length, 0);
    assert.deepEqual(r.passed.map((o) => o.ticker), ['NVDA']);
    assert.equal(r.orderRefusals[0]!.ticker, 'AAPL');
  });

  test('count: more than 10 orders a day refuses the plan', () => {
    const orders = Array.from({ length: 11 }, (_, i) => order({ qty: 1 + i * 0.001, value: 10 }));
    const r = checkRails(base({ orders }));
    assert.ok(!r.ok); assert.equal(r.passed.length, 0);
    assert.match(r.planRefusals[0]!, /11 orders is more than the 10 a day/);
    assert.ok(checkRails(base({ orders: orders.slice(0, 10) })).ok);
  });

  test('cash: the buys must fit in the settled cash plus the same plan\'s sells', () => {
    const r = checkRails(base({ settledCash: 50, orders: [order({ value: 100 })] }));
    assert.match(r.planRefusals[0]!, /more than the settled cash \$50\.00 plus the sells \$0\.00/);
    assert.ok(checkRails(base({ settledCash: 0, orders: [order({ side: 'SELL', qty: 1, value: 100 }), order({ value: 99, fee: 1 })] })).planRefusals.length === 1, 'fees count too');
    assert.ok(checkRails(base({ settledCash: 0, orders: [order({ side: 'SELL', qty: 1, value: 100 }), order({ value: 98, fee: 1 })] })).ok);
  });

  test('halt: the kill switch blocks any plan', () => {
    const r = checkRails(base({ halted: true, orders: [order({})] }));
    assert.ok(!r.ok); assert.equal(r.passed.length, 0); assert.match(r.checks, /halted \(kill switch\)/);
  });

  test('freshness: a price that is not from the decision day refuses the plan', () => {
    const r = checkRails(base({ orders: [order({})], priceDays: new Map([['NVDA', '2026-10-30'], ['QQQ', null]]) }));
    assert.match(r.planRefusals[0]!, /prices not from 2026-11-02: NVDA \(2026-10-30\), QQQ \(none\)/);
  });

  test('alerts at -20% and -35% from the start, never a stop', () => {
    assert.deepEqual(fallAlerts(810, 1_000, [0.2, 0.35]), []);
    assert.match(fallAlerts(800, 1_000, [0.2, 0.35])[0]!, /20\.0% below its start.*-20% alert.*No automatic stop/);
    assert.match(fallAlerts(640, 1_000, [0.2, 0.35])[0]!, /-35% alert/);
  });
});

describe('the market calendar and the stale-signal refusal (late Nightly, holiday, half day)', () => {
  test('NYSE holidays 2026 and 2027 (weekend moves, Good Friday, Juneteenth); a Saturday New Year is not moved', () => {
    assert.deepEqual([...nyseHolidays(2026).keys()].sort(), ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25']);
    assert.deepEqual([...nyseHolidays(2027).keys()].sort(), ['2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24']);
    assert.ok(!nyseHolidays(2028).has('2027-12-31'));
    assert.ok(isTradingDay('2026-11-02')); assert.ok(!isTradingDay('2026-11-01')); assert.ok(!isTradingDay('2026-11-26'));
  });

  test('half days: the day after Thanksgiving, Christmas Eve and July 3 when they trade', () => {
    assert.ok(isHalfDay('2026-11-27')); assert.ok(isHalfDay('2026-12-24')); assert.ok(isHalfDay('2025-07-03'));
    assert.ok(!isHalfDay('2026-07-03'), 'a holiday that year'); assert.ok(!isHalfDay('2027-12-24')); assert.ok(!isHalfDay('2026-11-25'));
  });

  test('the last closed trading day, in New York time, 30 minutes after the close', () => {
    assert.equal(lastClosedTradingDay(nyAt('2026-11-02', 16, 29)), '2026-10-30');
    assert.equal(lastClosedTradingDay(nyAt('2026-11-02', 16, 30)), '2026-11-02');
    assert.equal(lastClosedTradingDay(nyAtSummer('2026-07-06', 20)), '2026-07-06');
    assert.equal(lastClosedTradingDay(nyAt('2026-11-01', 12)), '2026-10-30', 'a Sunday');
    assert.equal(previousTradingDay('2026-11-27'), '2026-11-25');
  });

  test('late Nightly: the twin decided on Monday but Tuesday has closed -> refused', () => {
    const why = freshnessRail({ decisionDay: '2026-11-02', lastTradingDay: lastClosedTradingDay(nyAt('2026-11-03', 20)), priceDays: new Map() });
    assert.match(why!, /last decided on 2026-11-02 but the last trading day is 2026-11-03 \(a late or missing Nightly\)/);
  });

  test('holiday: on Thanksgiving night the Wednesday decision is fresh; a decision dated the holiday is refused', () => {
    const last = lastClosedTradingDay(nyAt('2026-11-26', 20));
    assert.equal(last, '2026-11-25');
    assert.equal(freshnessRail({ decisionDay: '2026-11-25', lastTradingDay: last, priceDays: new Map([['QQQ', '2026-11-25']]) }), null);
    assert.match(freshnessRail({ decisionDay: '2026-11-26', lastTradingDay: last, priceDays: new Map() })!, /market was closed \(Thanksgiving\)/);
    assert.match(freshnessRail({ decisionDay: '2026-11-24', lastTradingDay: last, priceDays: new Map() })!, /stale/);
  });

  test('half day: the 1 pm close counts from 13:30; before it the day before Thanksgiving is still the last', () => {
    const early = lastClosedTradingDay(nyAt('2026-11-27', 13, 10)), late = lastClosedTradingDay(nyAt('2026-11-27', 13, 45));
    assert.equal(early, '2026-11-25'); assert.equal(late, '2026-11-27');
    assert.equal(freshnessRail({ decisionDay: '2026-11-25', lastTradingDay: early, priceDays: new Map() }), null);
    assert.match(freshnessRail({ decisionDay: '2026-11-25', lastTradingDay: late, priceDays: new Map() })!, /stale/);
    assert.match(freshnessRail({ decisionDay: '2026-11-27', lastTradingDay: early, priceDays: new Map() })!, /has not closed yet/);
  });
});

describe('section 5: tax and the comparison on the same basis', () => {
  test('value, tax owed this year (realised gains net of losses since 1 January), value after tax, money added for tax', () => {
    const a: RealAccount = {
      ...cash(100), taxPaidFromBank: 20,
      positions: [{ ticker: 'NVDA', shares: 2, cost: 300 }, { ticker: 'MQZC', shares: 1, cost: 120 }],
      realised: [{ day: '2025-12-30', ticker: 'AMD', gain: 400 }, { day: '2026-03-01', ticker: 'AMD', gain: 100 }, { day: '2026-05-01', ticker: 'TSLA', gain: -40 }],
    };
    const x = accountingOf(a, (t) => ({ NVDA: 200, MQZC: 100 } as Record<string, number>)[t] ?? null, '2026');
    assert.equal(x.value, 100 + 400 + 100);
    assert.equal(x.taxOwed, 15); // 25% of (100 - 40); last year's gain is not this year's tax
    assert.equal(x.unrealisedTax, 25); // NVDA +100 -> 25; MQZC's loss does not offset it (the paper test's basis)
    assert.equal(x.moneyAddedForTax, 20);
    assert.equal(x.valueAfterTax, 600 - 15 - 25 - 20);
    assert.equal(accountingOf({ ...a, realised: [{ day: '2026-01-02', ticker: 'X', gain: -50 }] }, () => null, '2026').taxOwed, 0, 'a net loss owes nothing');
  });

  test('the same holdings are worth the same after tax live and in the paper test', () => {
    const s = stateWith('lab.turtle', { cash: 100, pos: { NVDA: pos(2, 300), MQZC: pos(1, 120), QQQ: pos(1, 450) } });
    const close = (t: string): number | null => ({ NVDA: 200, MQZC: 100, QQQ: 500 } as Record<string, number>)[t] ?? null;
    const paper = labValues(s.lab!, close)['lab.turtle']!;
    const live = accountingOf({ ...cash(100), positions: [{ ticker: 'NVDA', shares: 2, cost: 300 }, { ticker: 'MQZC', shares: 1, cost: 120 }, { ticker: 'QQQ', shares: 1, cost: 450 }] }, close, '2026');
    near(live.valueAfterTax, paper);
  });

  test('the twin and the yardsticks are scaled to the live start money from the live start day, with their deepest falls', () => {
    const s = stateWith('lab.turtle', { cash: 0, pos: {} });
    s.marks = [
      { day: '2026-10-29', values: { 'lab.turtle': 100_000, qqq: 100_000, 'lab.list14': 100_000 } },
      { day: '2026-10-30', values: { 'lab.turtle': 110_000, qqq: 101_000, 'lab.list14': 99_000 } },
      { day: '2026-11-02', values: { 'lab.turtle': 99_000, qqq: 102_010, 'lab.list14': 108_900 } },
    ];
    const c = compareWithPaper(s, 'lab.turtle', { day: '2026-10-30', value: 1_000 });
    near(c.twin!, 900); near(c.qqq!, 1_010); near(c.list14!, 1_100);
    near(c.twinFall, 10); near(c.qqqFall, 0); near(c.list14Fall, 0);
    const before = compareWithPaper(s, 'lab.turtle', { day: '2026-10-28', value: 1_000 });
    near(before.twin!, 990); near(before.twinFall, 10);
  });
});

describe('the real-account fakes', () => {
  test('the account file: parsed with plain errors', async () => {
    const json = { asOf: '2026-11-02', cash: 10, positions: [{ ticker: 'qqq', shares: 1, cost: 500 }], start: { day: '2026-11-02', value: 1000 }, halted: true };
    const a = await fileAccountSource('x.json', () => JSON.stringify(json)).read();
    assert.equal(a.positions[0]!.ticker, 'QQQ'); assert.equal(a.settledCash, 10); assert.equal(a.halted, true);
    assert.throws(() => parseRealAccount({ cash: 'x', start: { day: 'd', value: 1 } }), /cash is not a number/);
    assert.throws(() => parseRealAccount({ cash: 1 }), /no start/);
    assert.throws(() => parseRealAccount({ cash: 1, start: { day: 'd', value: 1 }, positions: [{ ticker: 'X', shares: 1, cost: 1, kind: 'future' }] }), /unknown kind/);
  });

  test('the dry run\'s own record: planned orders filled at their evening price, fees paid, gains realised', () => {
    const rows = [
      ['2026-11-02', 'planned (dry run)', 'NVDA', 'BUY', 2, 100, '', 1],
      ['2026-11-02', 'skipped (dry run)', 'QQQ', 'BUY', '', '', '', ''],
      ['2026-11-02', 'refused (dry run)', 'MQZC', 'BUY', 1, 90, '', 1],
      ['2026-11-03', 'planned (dry run)', 'NVDA', 'SELL', 1, 150, '', 1],
    ];
    const a = shadowAccount(rows, { day: '2026-11-02', value: 1_000 });
    near(a.cash, 1_000 - 201 + 149);
    assert.deepEqual(a.positions.map((p) => [p.ticker, p.shares]), [['NVDA', 1]]);
    near(a.positions[0]!.cost, 100.5);
    near(a.realised[0]!.gain, 149 - 100.5);
    assert.equal(a.feesPaid, 2);
    assert.equal(a.asOf, '2026-11-03');
  });
});

describe('the fee report (decides D1)', () => {
  test('research: only accounts that beat Hold QQQ and Hold your 14 after fees in every period are offered; the best leads', { skip: NEEDS_PACK }, () => {
    const r = buildFeeReport(null, RESEARCH_FEES, LIVE_DEFAULTS);
    assert.equal(r.rows.length, 10);
    for (const id of r.offered) {
      const x = r.rows.find((row) => row.id === id)!.research!;
      for (const p of x.periods) assert.ok(p.afterFeesPct > p.qqqPct && p.afterFeesPct > p.list14Pct, id + ' ' + p.period);
    }
    for (const row of r.rows) if (!row.beatsBoth) assert.match(row.verdict, /trails/);
    assert.ok(r.best && r.offered.includes(r.best));
    for (const row of r.rows) for (const p of row.research!.periods) assert.ok(p.afterFeesPct <= p.afterTaxPct, 'fees never help');
    assert.ok(feeReportSection(r).some((l) => l.startsWith('📊 Hold QQQ')));
    assert.ok(feeReportText(r, RESEARCH_FEES).some((l) => l.includes('orders a year')));
  });

  test('no evidence and nothing beating both: nothing is offered, in plain words', () => {
    const r = buildFeeReport(null, null, LIVE_DEFAULTS);
    assert.deepEqual(r.offered, []); assert.equal(r.best, null);
    assert.match(r.line, /No paper account beats both/);
  });

  test('live paper: trades scaled to $1,000, those under the fee filter skipped, fees and drag per year', () => {
    const s = stateWith('lab.turtle', { cash: 0, pos: {} });
    s.marks = Array.from({ length: 21 }, (_, i) => ({ day: '2026-11-' + String(i + 1).padStart(2, '0'), values: { 'lab.turtle': 120_000, qqq: 105_000, 'lab.list14': 110_000 } }));
    const trades = [
      { day: '2026-11-02', strategy: 'lab.turtle', side: 'BUY' as const, ticker: 'NVDA', shares: 185, price: 180, value: 33_300, tax: 0, why: '' },
      { day: '2026-11-02', strategy: 'lab.turtle', side: 'SELL' as const, ticker: 'QQQ', shares: 4, price: 600, value: 2_400, tax: 0, why: '' }, // $24 at $1,000: skipped
      { day: '2026-11-05', strategy: 'lab.turtle', side: 'SELL' as const, ticker: 'NVDA', shares: 185, price: 10, value: 1_850, tax: 0, why: '' }, // $18.50 full exit: kept
      { day: '2026-11-02', strategy: 'lab.engine', side: 'BUY' as const, ticker: 'MQZC', shares: 1, price: 100, value: 100_000, tax: 0, why: '' },
    ];
    const l = liveFeeStats({ state: s, trades }, 'lab.turtle', LIVE_DEFAULTS);
    assert.equal(l.orders, 2); assert.equal(l.skipped, 1);
    near(l.fees, 1 + 0.19, 1e-9); // $1 minimum; the small exit pays 1% of $18.50
    assert.ok(l.enough); assert.equal(l.tradingDays, 21);
    near(l.ordersPerYear!, 2 / (21 / 252));
    near(l.afterFees!, 1_200 - 1.19);
    const r = buildFeeReport({ state: s, trades }, null, LIVE_DEFAULTS);
    assert.ok(r.offered.includes('lab.turtle'));
    assert.equal(r.best, 'lab.turtle');
  });

  test('the CLI prints the report from a saved paper state and the stored research run', { skip: NEEDS_PACK }, async () => {
    const out: string[] = [];
    const code = await liveFeeReportMain(['--no-sheet'], { out: (x) => out.push(x), err: () => {}, env: {} }, { loadPaper: async () => null });
    assert.equal(code, 0);
    assert.match(out.join(''), /💵 Live bot fee report/);
    assert.match(out.join(''), /Hold your 14/);
    const json: string[] = [];
    await liveFeeReportMain(['--json'], { out: (x) => json.push(x), err: () => {}, env: {} });
    assert.equal(JSON.parse(json.join('')).rows.length, 10);
  });
});

describe('1.4 and 1.6: the 💵 Live Log and the nightly dry run', () => {
  const DAY = '2026-11-02';
  const NIGHT = nyAt(DAY, 20);
  const PRICES: Record<string, number> = { NVDA: 180, MQZC: 95, QQQ: 600, AMD: 250 };
  const chart = (t: string, upTo = DAY) => {
    const ds = ['2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03'].filter((d) => d <= upTo);
    const px = ds.map(() => PRICES[t] ?? 100);
    return { dates: ds.map((d) => new Date(d + 'T20:00:00Z')), opens: px, highs: px, lows: px, closes: px, volumes: px.map(() => 1e6), splits: [] } as never;
  };
  async function setup(over: { lastDay?: string; follow?: string } = {}) {
    const store = new MemoryTabStore();
    const s = stateWith('lab.trend200', { cash: 500, pos: { NVDA: pos(100, 15_000), QQQ: pos(80, 46_000) }, toBuy: ['MQZC'] }, over.lastDay ?? DAY);
    s.marks = [{ day: '2026-10-30', values: { 'lab.trend200': 100_000, qqq: 100_000, 'lab.list14': 100_000 } }, { day: DAY, values: { 'lab.trend200': 101_000, qqq: 100_500, 'lab.list14': 100_800 } }];
    await savePaper(store, { state: s, trades: [] });
    const sent: string[] = [];
    const fetchImpl = (async (_u: string, init: { body: any }) => { sent.push(JSON.parse(init.body).text); return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }); }) as unknown as typeof fetch;
    const deps = {
      store, timeZone: 'America/New_York', log: () => {}, now: () => NIGHT, fetchChart: async (t: string) => chart(t),
      config: cfg({ follow: over.follow ?? 'lab.trend200' }), telegram: { deps: { token: 'x', fetchImpl }, chatId: '1' },
    };
    return { store, deps, sent };
  }

  test('a night: planned (dry run) rows with the twin\'s reasons and the rail checks, a daily values row; the full text in the log, NOTHING on Telegram (all fine)', async () => {
    const { store, deps, sent } = await setup();
    const out = await runLiveDryRun(deps);
    assert.match(out, /order\(s\) planned, rails OK/);
    const log = (await store.read(LIVE_LOG_TAB, LIVE_LOG_COLS))!;
    assert.deepEqual(log[0], [...LIVE_LOG_HEADER]);
    const planned = log.filter((r) => r[1] === 'planned (dry run)');
    assert.deepEqual(planned.map((r) => r[2] + ' ' + r[3]).sort(), ['MQZC BUY', 'NVDA BUY', 'QQQ BUY']);
    for (const r of planned) { assert.ok(String(r[8]).length > 5, 'a reason'); assert.match(String(r[9]), /^OK:/); assert.match(String(r[10]), /^LB-2026-11-02-lab\.trend200-/); assert.equal(r[11], 'lab.trend200'); }
    const v = log.find((r) => r[1] === 'daily values')!;
    assert.equal(v[12], 1_000); assert.equal(v[13], 0); assert.equal(v[15], 1_000);
    assert.equal(v[16], 1_000, 'the live start is tonight: the twin and the yardsticks start at $1,000 too'); assert.equal(v[17], 1_000); assert.equal(v[18], 1_000);
    assert.equal(sent.length, 0, 'a normal night needs nothing from the owner: silent (notify/policy.ts)');
    const logged: string[] = [];
    const fresh = await setup();
    await runLiveDryRun({ ...fresh.deps, log: (m: string) => logged.push(m) });
    // Fix 2026-11-06: the text is logged one line at a time (each line gets its own level).
    assert.ok(logged.every((l) => !l.includes('\n')), 'one log line per text line');
    const text = logged.slice(logged.findIndex((l) => l.startsWith('💵 Live bot'))).join('\n');
    assert.match(text, /^💵 Live bot \(dry run, \$1,000\) — 2026-11-02, following Trend 200/);
    assert.match(text, /would BUY [0-9.]+ MQZC \(\$333\.33\), [0-9.]+ NVDA .*, [0-9.]+ QQQ .* — rails OK; drift after the plan/);
    assert.match(text, /Twin \$1,000\.00 · 📊 Hold QQQ \$1,000\.00 · 📊 Hold your 14 \$1,000\.00/);
    assert.match(text, /Fee report/);
    assert.match(text, /no broker is connected/);
    assert.equal(fresh.sent.length, 0);
    // Fix 2026-11-07: with logReport the report text goes there (INFO in the Nightly), none of it to the leveled log.
    const reported: string[] = [], leveled: string[] = [];
    const third = await setup();
    await runLiveDryRun({ ...third.deps, log: (m: string) => leveled.push(m), logReport: (m: string) => reported.push(m) });
    assert.ok(reported.some((l) => l.startsWith('💵 Live bot')) && reported.some((l) => /Fee report/.test(l)), 'the report lines');
    assert.equal(leveled.filter((l) => l.startsWith('💵 Live bot') || /Fee report/.test(l)).length, 0, 'no report line on the leveled log');
  });

  test('the log is idempotent per day: a re-run writes nothing and sends nothing; the next night starts from the planned positions', async () => {
    const { store, deps, sent } = await setup();
    await runLiveDryRun(deps);
    const n1 = (await store.read(LIVE_LOG_TAB, LIVE_LOG_COLS))!.length;
    const again = await planLiveNight(deps);
    assert.equal(again.logged, 0); assert.equal(again.message, null);
    assert.match(again.outcome, /already planned/);
    assert.equal((await store.read(LIVE_LOG_TAB, LIVE_LOG_COLS))!.length, n1);
    assert.equal(sent.length, 0);
    // next night: the twin is unchanged, so the account (the planned orders, as if filled) already matches
    const s = (await import('../src/paper/paperJob.ts'));
    const p = (await s.loadPaper(store))!;
    p.state.lastDay = '2026-11-03';
    // what the twin did at the open: MQZC bought with 1/3 of its $66,500, funded from QQQ
    const twin = p.state.lab!.accounts['lab.trend200']!;
    twin.toBuy = []; twin.pos.MQZC = pos(233, 233 * 95); twin.pos.QQQ = pos(43, 43 * 575); twin.cash = 500 + 37 * 600 - 233 * 95;
    p.state.marks.push({ day: '2026-11-03', values: { 'lab.trend200': 102_000, qqq: 100_500, 'lab.list14': 101_808 } });
    await s.savePaper(store, p);
    const next = await planLiveNight({ ...deps, now: () => nyAt('2026-11-03', 20), fetchChart: async (t: string) => chart(t, '2026-11-03') });
    assert.ok(next.plan);
    assert.ok(next.plan!.orders.length <= 1, 'at most a small top-up: ' + next.plan!.orders.map((o) => o.side + o.ticker + o.value).join());
    assert.ok(next.logged > 0);
    const v = (await store.read(LIVE_LOG_TAB, LIVE_LOG_COLS))!.filter((r) => r[1] === 'daily values');
    assert.equal(v.length, 2);
    near(Number(v[1]![16]), 1_000 * 102_000 / 101_000, 0.01);
    near(Number(v[1]![18]), 1_010, 0.01);
  });

  test('a stale signal (the paper test missed a night) is refused, reported, and not logged', async () => {
    const { store, deps, sent } = await setup();
    const n = await planLiveNight({ ...deps, now: () => nyAt('2026-11-03', 20) });
    assert.ok(n.rails && !n.rails.ok);
    assert.match(n.rails!.planRefusals.join(), /late or missing Nightly/);
    assert.equal(n.logged, 0);
    assert.equal(await store.read(LIVE_LOG_TAB, LIVE_LOG_COLS), null);
    assert.match(n.message!, /REFUSED: the paper twin last decided on 2026-11-02/);
    await runLiveDryRun({ ...deps, now: () => nyAt('2026-11-03', 20) });
    assert.equal(sent.length, 1);
  });

  test('halted: the plan is refused and logged as refused', async () => {
    const { store, deps } = await setup();
    await runLiveDryRun({ ...deps, config: cfg({ follow: 'lab.trend200', halted: true }) });
    const log = (await store.read(LIVE_LOG_TAB, LIVE_LOG_COLS))!;
    assert.ok(!log.some((r) => r[1] === 'planned (dry run)'));
    assert.ok(log.some((r) => r[1] === 'refused (dry run)' && /halted/.test(String(r[9]))));
  });

  test('which account: "auto" takes the fee report\'s best; "none" and an unsupported account say so plainly', async () => {
    const a = await setup({ follow: 'auto' });
    const n = await planLiveNight(a.deps);
    assert.equal(n.account, buildFeeReport(null, RESEARCH_FEES, LIVE_DEFAULTS).best);
    const b = await setup({ follow: 'none' });
    const m = await planLiveNight(b.deps);
    assert.equal(m.account, null); assert.match(m.message!, /no account is followed/);
    const c = await setup({ follow: LILO_ID });
    const k = await planLiveNight(c.deps);
    assert.equal(k.account, null); assert.match(k.message!, /cannot be followed: LILO trades limit-order ladders/);
    const d = await setup({ follow: 'auto' });
    const z = await planLiveNight({ ...d.deps, research: null });
    assert.equal(z.account, null); assert.match(z.message!, /No paper account beats both/);
  });

  test('log rows: refused and skipped trades are logged but never counted as planned', () => {
    const plan = planTrades(tgt({ NVDA: 0.5, QQQ: 0.5 }), cash(1_000), (t) => PRICES[t] ?? null, cfg());
    const rails = checkRails({ orders: plan.orders, held: new Map(), heldCalls: new Map(), slots: 3, accountValue: 1_000, settledCash: 1_000, maxOrders: 10, capSlack: 0.1, halted: false, decisionDay: DAY, lastTradingDay: DAY, priceDays: new Map([['NVDA', DAY]]) });
    const acc = accountingOf(cash(1_000), () => null, '2026');
    const rows = liveLogRows(DAY, plan, rails, acc, { twin: null, qqq: null, list14: null, twinFall: 0, qqqFall: 0, list14Fall: 0 }, 0, 'lab.turtle');
    assert.ok(rows.some((r) => r[1] === 'refused (dry run)' && r[2] === 'NVDA' && /above the cap/.test(String(r[9]))));
    assert.ok(rows.every((r) => r.length === LIVE_LOG_COLS));
    assert.equal(shadowAccount(rows, { day: DAY, value: 1_000 }).positions.some((p) => p.ticker === 'NVDA'), false);
  });
});

describe('wiring', () => {
  test('💵 Live Log is a reports tab, allow-listed and protected like 📒 Paper Log', () => {
    assert.deepEqual([...LIVE_REPORT_TABS], [LIVE_LOG_TAB]);
    assert.equal(sheetFor(LIVE_LOG_TAB), 'reports');
    assert.ok(isAllowListedName(LIVE_LOG_TAB));
    assert.ok(PROTECTED_TABS.includes(LIVE_LOG_TAB));
  });

  test('the dry run is a nightly step right after paper.trade', () => {
    assert.equal(NIGHTLY_ORDER[NIGHTLY_ORDER.length - 1], 'live.dryRun');
    assert.equal(NIGHTLY_ORDER.indexOf('live.dryRun'), NIGHTLY_ORDER.indexOf('paper.trade') + 1);
    assert.deepEqual(stepDef('live.dryRun').dependsOn, ['paper.trade']);
  });
});

describe('live bot: Telegram only when the owner is needed (notify/policy.ts)', () => {
  const night = (o: Partial<LiveNight>): LiveNight => ({ day: '2026-11-02', account: 'lab.trend200', plan: null, rails: null, logged: 3, message: 'full text', outcome: 'Live bot (dry run) 2026-11-02, lab.trend200: 2 order(s) planned, rails OK', ...o });
  test('a normal night: null (nothing sent)', () => {
    assert.equal(liveAttention(night({})), null);
    assert.equal(liveAttention(night({ day: null })), null);
  });
  test('a fall alert, a stale signal, a refused plan: ONE line each', () => {
    assert.match(liveAttention(night({}), ['⚠️ The live account is 21.0% below its start ($1,000), past the -20% alert. No automatic stop (D5): the owner decides.'])!, /^💵 Live bot 2026-11-02: ⚠️ The live account is 21\.0% below/);
    assert.match(liveAttention(night({ outcome: 'Live bot (dry run) 2026-11-02, x: refused (stale signal), not logged' }))!, /signal is stale/);
    assert.match(liveAttention(night({ rails: { planRefusals: ['halted'], orderRefusals: [] } as never }))!, /rails REFUSED the plan: halted/);
  });
});
