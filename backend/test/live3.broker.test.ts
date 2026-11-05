/**
 * Live broker bot, phase 3 (docs/live-broker/phases/3-broker-connector.md), all against FakeBroker (no IBKR, no
 * server, no network). The Tests section of the phase file, one block each: duplicate-send impossible on
 * retry/reconnect; sell-then-buy sequencing; settled-cash limit; approval hash/expiry; kill switch cancels everything;
 * reconciliation alerts; every rail refuses its case. Plus R0 (another account is impossible), the signed control
 * calls, the 💵 Live Log rows and the fake broker itself.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MemoryTabStore } from '../src/storage/tabStore.ts';
import { IBKR_PRO_FIXED, orderFee } from '../src/live/liveConfig.ts';
import { orderRef, type Plan, type PlannedOrder } from '../src/live/planner.ts';
import { nyMoment, nextTradingDay } from '../src/live/marketCalendar.ts';
import { LIVE_LOG_TAB, LIVE_LOG_COLS, LIVE_LOG_HEADER, appendLiveRows, liveEventRow } from '../src/live/liveLog.ts';
import { appendNight } from '../src/paper/paperLog.ts';
import { FakeBroker } from '../src/live/broker/fakeBroker.ts';
import { guardBroker, longOnlyRefusal, AccountRefusedError, type LongOnlyInput } from '../src/live/broker/guard.ts';
import { BROKER_DEFAULTS, brokerConfigFromEnv, limitPrice, type BrokerConfig } from '../src/live/broker/brokerConfig.ts';
import { MemoryBotStateStore, emptyBotState, updateState, FileBotStateStore, type BotState } from '../src/live/broker/botState.ts';
import { planHash, decide, mayExecute, shortHash } from '../src/live/broker/approval.ts';
import { reconcile, applyFills, splitName, ledgerFromBroker, acceptCredit, AUTO_ACCEPT_CREDIT_USD } from '../src/live/broker/reconcile.ts';
import { morningTick, runMorning, type ExecutorDeps } from '../src/live/broker/executor.ts';
import { createControlHandler, signRequest, checkSignature, parsePlan, nodeListener, MIN_SECRET_LENGTH, type ControlRequest } from '../src/live/broker/control.ts';
import { IbkrBrokerNotConfigured, ibkrBroker, IBKR_NOT_CONFIGURED } from '../src/live/broker/ibkrBroker.ts';
import type { Broker } from '../src/live/broker/broker.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BOT = 'DU1234567', OWNER = 'U7654321', FOLLOW = 'lab.turtle';
const DAY = '2026-11-02', EXEC = '2026-11-03';
const EVENING = nyMoment(DAY, 22 * 60);
const OPEN = nyMoment(EXEC, 9 * 60 + 30), START = OPEN + 5 * 60_000, END = START + 30 * 60_000;
const SECRET = 'x'.repeat(40);

const order = (ticker: string, side: 'BUY' | 'SELL', qty: number, price: number, fullExit = false, kind: PlannedOrder['kind'] = 'share'): PlannedOrder =>
  ({ ticker, side, kind, qty, price, value: qty * price, fee: orderFee(qty, price), why: 'the twin ' + side.toLowerCase() + 's it', ref: orderRef(DAY, FOLLOW, ticker, side), fullExit });
const planOf = (orders: PlannedOrder[], over: Partial<Plan> = {}): Plan => ({ day: DAY, account: FOLLOW, slots: 3, accountValue: 820, orders, skipped: [], drift: [], driftPct: 0, ...over });
/** Sell the 2 NVDA held, buy 2 MQZC and half a QQQ. */
const PLAN = (): Plan => planOf([order('NVDA', 'SELL', 2, 160, true), order('MQZC', 'BUY', 2, 100), order('QQQ', 'BUY', 0.5, 500)]);

interface World {
  fake: FakeBroker; state: MemoryBotStateStore; store: MemoryTabStore; cfg: BrokerConfig; deps: ExecutorDeps; alerts: string[];
  at(t: number): void; now(): number; quotes(): void;
  call(method: string, p: string, body?: unknown): ReturnType<ReturnType<typeof createControlHandler>>;
  postAndApprove(plan?: Plan): Promise<string>;
  tick(): ReturnType<typeof morningTick>;
  log(): string[][];
}

function world(o: { botCash?: number; cfg?: Partial<BrokerConfig>; ledger?: BotState['ledger'] | 'none'; type?: 'cash' | 'margin' } = {}): World {
  let t = EVENING;
  const now = (): number => t;
  const fake = new FakeBroker({ now });
  fake.addAccount(BOT, o.botCash ?? 500, { NVDA: { qty: 2, avgCost: 150 } }, o.type ?? 'cash');
  fake.addAccount(OWNER, 50_000, { NVDA: { qty: 100, avgCost: 90 }, TSLA: { qty: 30, avgCost: 200 } });
  const st: BotState = { ...emptyBotState(), ledger: o.ledger === 'none' ? null : o.ledger ?? { positions: { NVDA: 2 }, cash: o.botCash ?? 500, confirmedAt: 0 } };
  const state = new MemoryBotStateStore(st);
  const store = new MemoryTabStore();
  const cfg: BrokerConfig = { botAccount: BOT, ...BROKER_DEFAULTS, ...o.cfg };
  const alerts: string[] = [];
  const alert = (m: string): void => { alerts.push(m); };
  const deps: ExecutorDeps = { broker: fake, cfg, live: { fractional: true, minTrade: 50, fees: IBKR_PRO_FIXED, capSlack: 0.1 }, state, store, now, alert };
  const handler = createControlHandler({ secret: SECRET, broker: fake, cfg, state, store, now, alert });
  const w: World = {
    fake, state, store, cfg, deps, alerts,
    at: (x) => { t = x; }, now,
    quotes: () => { fake.setQuote('NVDA', 160, t); fake.setQuote('MQZC', 100, t); fake.setQuote('QQQ', 500, t); fake.setQuote('AMD', 200, t); },
    call: (method, p, body) => { const b = body == null ? '' : JSON.stringify(body); return handler({ method, path: p, body: b, headers: signRequest(SECRET, method, p, b, t) }); },
    postAndApprove: async (plan = PLAN()) => {
      const r = await w.call('POST', '/plan', { plan });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const a = await w.call('POST', '/approve', { day: plan.day, hash: r.body.short, decision: 'approve', by: 'owner' });
      assert.equal(a.status, 200, JSON.stringify(a.body));
      return String(r.body.hash);
    },
    tick: () => morningTick(deps),
    log: () => (store.snapshot(LIVE_LOG_TAB, LIVE_LOG_COLS) ?? []).slice(1).map((r) => r.map(String)),
  };
  return w;
}
const reqsFor = (w: World, ticker: string): number => w.fake.requests.filter((r) => r.ticker === ticker).length;
const whens = (w: World): Set<string> => new Set(w.log().map((r) => r[1]!));

describe('R0: only the bot\'s own account', () => {
  test('an order for another account number is impossible: refused before it reaches the broker', async () => {
    const fake = new FakeBroker().addAccount(BOT, 500).addAccount(OWNER, 50_000, { NVDA: { qty: 100, avgCost: 90 } });
    const g = guardBroker(fake, BOT);
    const before = fake.peek(OWNER);
    await assert.rejects(g.placeLimitOrder({ account: OWNER, orderRef: 'LB-x', ticker: 'NVDA', kind: 'share', side: 'SELL', qty: 100, limit: 100, tif: 'DAY' }), AccountRefusedError);
    await assert.rejects(g.positions(OWNER), AccountRefusedError);
    await assert.rejects(g.cash(OWNER), AccountRefusedError);
    await assert.rejects(g.settledCash(OWNER), AccountRefusedError);
    await assert.rejects(g.openOrders(OWNER), AccountRefusedError);
    await assert.rejects(g.todaysFills(OWNER), AccountRefusedError);
    await assert.rejects(g.cancelOrder(OWNER, 'O1'), AccountRefusedError);
    assert.equal(fake.requests.length, 0);
    assert.deepEqual(fake.peek(OWNER), before);
    assert.deepEqual(await g.accounts(), [BOT]);
  });

  test('a full morning never sends, reads or cancels anything of the owner\'s account', async () => {
    const w = world();
    w.fake.setRule('NVDA', { mode: 'full' }); w.fake.setRule('MQZC', { mode: 'full' }); w.fake.setRule('QQQ', { mode: 'none' });
    const owner = w.fake.peek(OWNER);
    await w.postAndApprove();
    w.at(START); w.quotes();
    await w.tick(); await w.tick();
    w.at(END); await w.tick();
    assert.ok(w.fake.requests.length >= 2);
    assert.ok(w.fake.requests.every((r) => r.account === BOT));
    assert.deepEqual(w.fake.peek(OWNER), owner);
    assert.deepEqual(w.fake.violations, []);
  });

  test('a broker that answers with another account\'s rows is refused; a login without the bot account is refused', async () => {
    const fake = new FakeBroker().addAccount(BOT, 500).addAccount(OWNER, 1, { NVDA: { qty: 1, avgCost: 1 } });
    const leaky: Broker = { ...fake, name: 'leaky', connectionState: () => 'connected', accounts: () => fake.accounts(), positions: () => fake.positions(OWNER) } as unknown as Broker;
    await assert.rejects(guardBroker(leaky, BOT).positions(BOT), /data of account U7654321/);
    const other = new FakeBroker().addAccount(OWNER, 1);
    await assert.rejects(guardBroker(other, BOT).accounts(), /cannot see the bot account/);
    assert.throws(() => guardBroker(fake, 'not an account'), AccountRefusedError);
    assert.throws(() => brokerConfigFromEnv({}), /LIVE_IBKR_ACCOUNT/);
    assert.equal(brokerConfigFromEnv({ LIVE_IBKR_ACCOUNT: 'du1234567' }).botAccount, BOT);
  });

  test('the executor with a login that cannot see the bot account sends nothing and skips the plan', async () => {
    const w = world();
    await w.postAndApprove();
    const lonely = new FakeBroker({ now: w.now }).addAccount(OWNER, 1);
    w.at(START);
    const r = await morningTick({ ...w.deps, broker: lonely });
    assert.equal(r.phase, 'skipped');
    assert.equal(lonely.requests.length, 0);
    assert.ok(w.alerts.some((a) => a.includes('cannot see the bot account')));
  });
});

describe('every rail refuses its case (long-only, cash-only, limit-only, allow-list, cap)', () => {
  const base: LongOnlyInput = { side: 'BUY', kind: 'share', ticker: 'NVDA', qty: 1, limit: 100, held: 0, accountType: 'cash', allowCalls: true };
  test('longOnlyRefusal', () => {
    assert.equal(longOnlyRefusal(base), null);
    assert.match(longOnlyRefusal({ ...base, kind: 'put' })!, /puts are not allowed/);
    assert.match(longOnlyRefusal({ ...base, side: 'SELL', qty: 3, held: 2 })!, /short sale/);
    assert.match(longOnlyRefusal({ ...base, side: 'SELL', kind: 'call', qty: 1, held: 0 })!, /write options/);
    assert.match(longOnlyRefusal({ ...base, accountType: 'margin' })!, /no margin/);
    assert.match(longOnlyRefusal({ ...base, limit: 0 })!, /never sends a market order/);
    assert.match(longOnlyRefusal({ ...base, kind: 'call', allowCalls: false })!, /switched off/);
    assert.match(longOnlyRefusal({ ...base, qty: -1 })!, /not a positive number/);
    assert.equal(longOnlyRefusal({ ...base, kind: 'call' }), null, 'a long call is allowed (D4)');
    assert.equal(longOnlyRefusal({ ...base, side: 'SELL', kind: 'call', qty: 1, held: 1 }), null, 'selling a call held is allowed');
  });

  test('a plan with a put, a bad ref or a duplicate ref is refused by /plan', () => {
    assert.match((parsePlan(planOf([{ ...order('NVDA', 'BUY', 1, 100), kind: 'put' }])) as { why: string }).why, /puts are not allowed/);
    assert.match((parsePlan(planOf([{ ...order('NVDA', 'BUY', 1, 100), ref: 'LB-other' }])) as { why: string }).why, /fixed day-account-ticker-side ref/);
    assert.match((parsePlan(planOf([order('NVDA', 'BUY', 1, 100), order('NVDA', 'BUY', 1, 100)])) as { why: string }).why, /same ref/);
    assert.match((parsePlan(planOf([order('NVDA', 'BUY', 0, 100)])) as { why: string }).why, /positive/);
    assert.ok(parsePlan(PLAN()).ok);
  });

  test('a short sale in a plan is refused by /plan against the real holdings', async () => {
    const w = world();
    const r = await w.call('POST', '/plan', { plan: planOf([order('NVDA', 'SELL', 5, 160)]) });
    assert.equal(r.status, 422);
    assert.match(String(r.body.why), /short sale/);
    assert.equal((await w.state.load()).pending, null);
  });

  test('a margin account: nothing is sent, the plan is skipped with why', async () => {
    const w = world({ type: 'margin' });
    // /plan already refuses (longOnly checks the account type)
    const r = await w.call('POST', '/plan', { plan: PLAN() });
    assert.equal(r.status, 422);
    assert.match(String(r.body.why), /margin/);
    // and the executor refuses even with a stored approved plan
    await updateState(w.state, (s) => { s.pending = { plan: PLAN(), hash: planHash(PLAN()), execDay: EXEC, receivedAt: EVENING, status: 'approved', approval: { at: EVENING, hash: planHash(PLAN()), by: 'o' }, held: [], skipped: {}, notes: [], sendStarted: false, summarySent: false }; });
    w.at(START); w.quotes();
    const t = await w.tick();
    assert.equal(t.phase, 'skipped');
    assert.equal(w.fake.requests.length, 0);
    assert.ok(w.log().some((x) => x[1] === 'skipped' && /margin/.test(x[8]!)));
  });

  test('at send time: a ticker off the owner\'s list and a buy over the cap are refused, the rest goes', async () => {
    const w = world({ botCash: 900 });
    w.fake.setRule('NVDA', { mode: 'full' });
    const plan = planOf([order('NVDA', 'SELL', 2, 160, true), order('COIN', 'BUY', 1, 100), order('MQZC', 'BUY', 6, 100)], { accountValue: 1000 });
    await w.postAndApprove(plan);
    w.at(START); w.quotes(); w.fake.setQuote('COIN', 100, START);
    await w.tick(); await w.tick();
    assert.equal(reqsFor(w, 'COIN'), 0);
    assert.equal(reqsFor(w, 'MQZC'), 0, '6 × $100.5 is above 1/3 + 10% of $1,000');
    const sk = w.log().filter((x) => x[1] === 'skipped').map((x) => x[2] + ': ' + x[8]);
    assert.ok(sk.some((x) => /^COIN: refused: COIN is not on the owner's list/.test(x)), sk.join('\n'));
    assert.ok(sk.some((x) => /^MQZC: refused: buying .* above the cap/.test(x)), sk.join('\n'));
  });

  test('limit = last ± band, rounded toward the last price; config bounds the band', () => {
    assert.equal(limitPrice(100, 'BUY', 0.005), 100.5);
    assert.equal(limitPrice(100, 'SELL', 0.005), 99.5);
    assert.equal(limitPrice(123.456, 'BUY', 0.005), 124.07);
    assert.equal(limitPrice(123.456, 'SELL', 0.005), 122.84);
    assert.equal(limitPrice(0.5, 'BUY', 0.01), 0.505);
    const c = brokerConfigFromEnv({ LIVE_IBKR_ACCOUNT: BOT, LIVE_LIMIT_BAND: '0.2', LIVE_SEND_AFTER_OPEN_MIN: '10', LIVE_SEND_WINDOW_MIN: '20', LIVE_APPROVE: '0' });
    assert.equal(c.limitBand, 0.005, 'a band above 5% is refused (close to a market order)');
    assert.equal(c.sendAfterOpenMin, 10); assert.equal(c.windowMin, 20); assert.equal(c.approveMode, false);
  });
});

describe('sell-then-buy sequencing and the send window', () => {
  test('nothing before open + 5 min; sells first; buys wait for the sells to fill; limits are last ± 0.5%', async () => {
    const w = world();
    w.fake.setRule('MQZC', { mode: 'full' }); w.fake.setRule('QQQ', { mode: 'full' });
    await w.postAndApprove();
    w.at(OPEN + 60_000); w.quotes();
    assert.equal((await w.tick()).phase, 'waiting');
    assert.equal(w.fake.requests.length, 0);
    w.at(START); w.quotes();
    const t1 = await w.tick();
    assert.equal(t1.phase, 'selling');
    assert.deepEqual(w.fake.requests.map((r) => r.side + ' ' + r.ticker + ' ' + r.qty + ' @ ' + r.limit), ['SELL NVDA 2 @ 159.2']);
    assert.equal((await w.tick()).phase, 'selling', 'the sell is still open: no buy');
    assert.equal(w.fake.requests.length, 1);
    w.fake.fill(w.fake.allOrders()[0]!.orderId);
    const t3 = await w.tick();
    assert.equal(t3.phase, 'buying');
    assert.deepEqual(w.fake.requests.map((r) => r.side + ' ' + r.ticker + ' ' + r.qty + ' @ ' + r.limit), ['SELL NVDA 2 @ 159.2', 'BUY MQZC 2 @ 100.5', 'BUY QQQ 0.5 @ 502.5']);
    assert.ok(w.fake.requests.every((r) => r.tif === 'DAY' && r.limit > 0));
    assert.deepEqual(w.fake.violations, []);
  });

  test('a sell that is rejected or has nothing to sell counts as finished; buys then go', async () => {
    const w = world();
    w.fake.setRule('NVDA', { mode: 'reject', reason: 'no trading permission' }); w.fake.setRule('MQZC', { mode: 'full' });
    await w.postAndApprove(planOf([order('NVDA', 'SELL', 2, 160, true), order('MQZC', 'BUY', 2, 100)]));
    w.at(START); w.quotes();
    await w.tick();
    assert.equal(reqsFor(w, 'MQZC'), 1);
    assert.ok(w.log().some((x) => x[1] === 'skipped' && x[2] === 'NVDA' && /rejected by the broker: no trading permission/.test(x[8]!)));
  });

  test('at the window\'s end every open order is cancelled, partial fills are kept, the unsent are skipped', async () => {
    const w = world();
    w.fake.setRule('NVDA', { mode: 'full' }); w.fake.setRule('MQZC', { mode: 'partial', share: 0.5 }); w.fake.setRule('QQQ', { mode: 'none' });
    await w.postAndApprove(planOf([order('NVDA', 'SELL', 2, 160, true), order('MQZC', 'BUY', 2, 100), order('QQQ', 'BUY', 0.5, 500), order('AMD', 'BUY', 0.5, 200)]));
    w.at(START); w.quotes(); w.fake.setQuote('AMD', 200, START - 3600_000); // AMD's last trade is an hour old: never sent (R4)
    await w.tick(); await w.tick();
    assert.equal(reqsFor(w, 'AMD'), 0);
    w.at(END);
    const r = await w.tick();
    assert.equal(r.phase, 'done');
    assert.deepEqual(r.cancelled.sort(), [orderRef(DAY, FOLLOW, 'MQZC', 'BUY'), orderRef(DAY, FOLLOW, 'QQQ', 'BUY')].sort());
    assert.equal(w.fake.peek(BOT).positions.MQZC, 1, 'the partial fill is kept');
    const log = w.log();
    assert.ok(log.some((x) => x[1] === 'cancelled' && x[2] === 'MQZC' && /1 of 2 filled, kept/.test(x[8]!)));
    assert.ok(log.some((x) => x[1] === 'skipped' && x[2] === 'AMD' && /send window ended/.test(x[8]!)));
    assert.ok(w.alerts.some((a) => a.startsWith('💵 Live bot — plan of ' + DAY)));
    const n = log.length;
    await w.tick(); await w.tick();
    assert.equal(w.log().length, n, 'nothing logged twice');
    assert.equal(w.alerts.filter((a) => a.startsWith('💵 Live bot — plan')).length, 1, 'the summary goes once');
  });

  test('runMorning loops until the window ends', async () => {
    const w = world();
    w.fake.setRule('NVDA', { mode: 'full' }); w.fake.setRule('MQZC', { mode: 'full' }); w.fake.setRule('QQQ', { mode: 'full' });
    await w.postAndApprove();
    w.at(START - 60_000); w.quotes();
    const ticks = await runMorning(w.deps, { pollMs: 60_000, sleep: async (ms) => { w.at(w.now() + ms); w.quotes(); } });
    assert.equal(ticks[0]!.phase, 'waiting');
    assert.equal(ticks[ticks.length - 1]!.phase, 'done');
    assert.equal(w.fake.requests.length, 3);
    assert.deepEqual(w.fake.peek(BOT).positions, { MQZC: 2, QQQ: 0.5 });
  });
});

describe('settled cash only (no good-faith violation)', () => {
  test('sale money does not pay for buys the same day: the buy shrinks to the settled cash', async () => {
    const w = world({ botCash: 120 });
    w.fake.setRule('NVDA', { mode: 'full' }); w.fake.setRule('MQZC', { mode: 'full' });
    await w.postAndApprove(planOf([order('NVDA', 'SELL', 2, 160, true), order('MQZC', 'BUY', 2, 100)], { accountValue: 440 }));
    w.at(START); w.quotes();
    await w.tick();
    const mu = w.fake.requests.find((r) => r.ticker === 'MQZC')!;
    assert.ok(mu.qty * mu.limit + orderFee(mu.qty, mu.limit) <= 120 + 1e-9, 'within the $120 settled, not the $438 after the sale');
    assert.ok(mu.qty < 2 && mu.qty > 1);
    assert.deepEqual(w.fake.violations, []);
  });

  test('too little settled cash: the buy is skipped (it comes back in the next plan); open buys reserve their cash', async () => {
    const w = world({ botCash: 30 });
    w.fake.setRule('NVDA', { mode: 'full' });
    await w.postAndApprove(planOf([order('NVDA', 'SELL', 2, 160, true), order('MQZC', 'BUY', 2, 100)], { accountValue: 350 }));
    w.at(START); w.quotes();
    await w.tick();
    assert.equal(reqsFor(w, 'MQZC'), 0);
    assert.ok(w.log().some((x) => x[1] === 'skipped' && x[2] === 'MQZC' && /not enough settled cash/.test(x[8]!)), JSON.stringify(w.log()));

    const v = world({ botCash: 400 });
    v.fake.setRule('NVDA', { mode: 'full' }); v.fake.setRule('MQZC', { mode: 'none' }); v.fake.setRule('AMD', { mode: 'none' });
    await v.postAndApprove(planOf([order('NVDA', 'SELL', 2, 160, true), order('MQZC', 'BUY', 3, 100), order('AMD', 'BUY', 1, 200)], { accountValue: 720 }));
    v.at(START); v.quotes();
    await v.tick();
    const amd = v.fake.requests.find((r) => r.ticker === 'AMD');
    assert.ok(amd, 'AMD is bought with what is left');
    assert.ok(amd!.qty * amd!.limit <= 400 - 3 * 100.5 - 1 + 1e-9, 'the open MQZC buy reserves its cash');
    assert.deepEqual(v.fake.violations, []);
  });
});

describe('duplicate send impossible (R5)', () => {
  test('ticks repeated many times send each ref once', async () => {
    const w = world();
    w.fake.setRule('NVDA', { mode: 'full' });
    await w.postAndApprove();
    w.at(START); w.quotes();
    for (let i = 0; i < 6; i++) await w.tick();
    assert.deepEqual(w.fake.requests.map((r) => r.ticker).sort(), ['MQZC', 'NVDA', 'QQQ']);
  });

  test('a send whose answer is lost: nothing is sent while the state is unknown; after reconnect the order is found by its ref, not sent again', async () => {
    const w = world();
    await w.postAndApprove();
    w.at(START); w.quotes();
    w.fake.loseNextReply();
    const t1 = await w.tick();
    assert.equal(t1.phase, 'unknown');
    assert.equal(w.fake.requests.length, 1, 'the broker did receive it');
    assert.equal(w.fake.connectionState(), 'unknown');
    assert.equal((await w.tick()).phase, 'unknown');
    w.fake.disconnect();
    assert.equal((await w.tick()).phase, 'unknown');
    assert.equal(w.fake.requests.length, 1);
    w.fake.reconnect();
    await w.tick(); await w.tick();
    assert.equal(reqsFor(w, 'NVDA'), 1);
    assert.ok(w.log().some((x) => x[1] === 'sent' && x[2] === 'NVDA'), 'the sent row is written from the broker\'s view after the reconnect');
  });

  test('a restarted executor (new process, same state) finds today\'s orders and fills by ref', async () => {
    const w = world();
    w.fake.setRule('NVDA', { mode: 'full' }); w.fake.setRule('MQZC', { mode: 'full' });
    await w.postAndApprove();
    w.at(START); w.quotes();
    await w.tick();
    const n = w.fake.requests.length;
    const again: ExecutorDeps = { ...w.deps, state: new MemoryBotStateStore(await w.state.load()), store: w.store };
    await morningTick(again); await morningTick(again);
    assert.equal(w.fake.requests.length, n);
  });

  test('a rejected order is not retried the same day (one ref = one order a day)', async () => {
    const w = world();
    w.fake.setRule('NVDA', { mode: 'full' }); w.fake.setRule('MQZC', { mode: 'reject', reason: 'price check' });
    await w.postAndApprove();
    w.at(START); w.quotes();
    for (let i = 0; i < 4; i++) await w.tick();
    assert.equal(reqsFor(w, 'MQZC'), 1);
  });

  test('a stale or missing last price waits (R4), then sends once it is fresh', async () => {
    const w = world();
    await w.postAndApprove();
    w.at(START);
    w.fake.setQuote('NVDA', 160, START - 10 * 60_000);
    const t = await w.tick();
    assert.equal(w.fake.requests.length, 0);
    assert.ok(t.notes.some((x) => /stale/.test(x)));
    w.fake.setQuote('NVDA', 160, START);
    await w.tick();
    assert.equal(reqsFor(w, 'NVDA'), 1);
  });
});

describe('approve mode: hash and expiry', () => {
  test('the approval names the plan by its hash; a changed or old plan cannot be approved; it expires at the open', async () => {
    const w = world();
    const r = await w.call('POST', '/plan', { plan: PLAN() });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'awaiting-approval');
    assert.equal(r.body.execDay, EXEC);
    assert.equal(r.body.hash, planHash(PLAN()));
    assert.equal((r.body.buttons as { approve: string }).approve, 'lb:ok:' + DAY + ':' + shortHash(planHash(PLAN())));
    assert.ok(Buffer.byteLength((r.body.buttons as { approve: string }).approve) <= 64, 'fits Telegram callback data');
    const other = planHash(planOf([order('MQZC', 'BUY', 1, 100)]));
    assert.match(String((await w.call('POST', '/approve', { day: DAY, hash: shortHash(other), decision: 'approve' })).body.why), /plan changed/);
    assert.match(String((await w.call('POST', '/approve', { day: '2026-10-30', hash: r.body.short, decision: 'approve' })).body.why), /old plan/);
    assert.match(String((await w.call('POST', '/approve', { day: DAY, hash: 'abc', decision: 'approve' })).body.why), /plan changed/);
    w.at(OPEN);
    const late = await w.call('POST', '/approve', { day: DAY, hash: r.body.short, decision: 'approve' });
    assert.equal(late.status, 409);
    assert.match(String(late.body.why), /expired at the open/);
  });

  test('no answer = skip: nothing is sent, every order logged as skipped', async () => {
    const w = world();
    await w.call('POST', '/plan', { plan: PLAN() });
    w.at(START); w.quotes();
    const t = await w.tick();
    assert.equal(t.phase, 'skipped');
    assert.equal(w.fake.requests.length, 0);
    const sk = w.log().filter((x) => x[1] === 'skipped');
    assert.equal(sk.length, 3);
    assert.ok(sk.every((x) => /no approval before the open/.test(x[8]!) && x[0] === DAY));
  });

  test('a plan re-posted with changes voids the earlier approval', async () => {
    const w = world();
    await w.postAndApprove();
    const changed = planOf([order('NVDA', 'SELL', 2, 160, true), order('MQZC', 'BUY', 3, 100)]);
    const r = await w.call('POST', '/plan', { plan: changed });
    assert.equal(r.body.status, 'awaiting-approval');
    const same = await w.call('POST', '/plan', { plan: changed });
    assert.equal(same.body.unchanged, true, 'the same plan again is idempotent');
    w.at(START); w.quotes();
    assert.equal((await w.tick()).phase, 'skipped');
    assert.equal(w.fake.requests.length, 0);
  });

  test('❌ Skip, approval while halted, and the gate rules', async () => {
    const w = world();
    const r = await w.call('POST', '/plan', { plan: PLAN() });
    const sk = await w.call('POST', '/approve', { day: DAY, hash: r.body.short, decision: 'skip' });
    assert.equal(sk.body.status, 'skipped');
    assert.equal(w.log().filter((x) => x[1] === 'skipped' && /skipped by the owner/.test(x[8]!)).length, 3);
    assert.equal((await w.call('POST', '/approve', { day: DAY, hash: r.body.short, decision: 'maybe' })).status, 400);

    const s: BotState = emptyBotState();
    const plan = PLAN(), hash = planHash(plan);
    s.pending = { plan, hash, execDay: EXEC, receivedAt: EVENING, status: 'awaiting-approval', approval: null, held: [], skipped: {}, notes: [], sendStarted: false, summarySent: false };
    s.halted = true;
    assert.match((decide(s, { day: DAY, hash, decision: 'approve', by: 'o' }, EVENING) as { why: string }).why, /halted/);
    s.halted = false;
    assert.ok(decide(s, { day: DAY, hash, decision: 'approve', by: 'o' }, EVENING).ok);
    assert.deepEqual(mayExecute(s, true, OPEN - 1), { ok: false, why: 'the market is not open yet' });
    assert.deepEqual(mayExecute(s, true, START), { ok: true });
    s.pending.approval = { ...s.pending.approval!, at: OPEN + 1 };
    assert.match((mayExecute(s, true, START) as { why: string }).why, /after the open/);
    s.pending.approval = { ...s.pending.approval!, at: EVENING };
    (s.pending.plan.orders as PlannedOrder[])[1] = order('MQZC', 'BUY', 9, 100);
    assert.match((mayExecute(s, true, START) as { why: string }).why, /does not match its hash/);
  });

  test('auto mode (approve off) sends without approval; a stale plan is refused', async () => {
    const w = world({ cfg: { approveMode: false } });
    w.fake.setRule('NVDA', { mode: 'full' });
    const r = await w.call('POST', '/plan', { plan: PLAN() });
    assert.equal(r.body.status, 'ready');
    w.at(START); w.quotes();
    await w.tick();
    assert.ok(w.fake.requests.length >= 1);
    const v = world();
    v.at(nyMoment('2026-11-04', 20 * 60));
    const stale = await v.call('POST', '/plan', { plan: PLAN() });
    assert.equal(stale.status, 422);
    assert.match(String(stale.body.why), /stale plan/);
  });
});

describe('kill switch', () => {
  test('/halt cancels every open order, nothing more is sent, /startbot does not revive the morning\'s plan', async () => {
    const w = world();
    w.fake.setRule('NVDA', { mode: 'partial', share: 0.5 });
    await w.postAndApprove();
    w.at(START); w.quotes();
    await w.tick();
    assert.equal(w.fake.allOrders().filter((o) => o.status === 'partial').length, 1);
    const h = await w.call('POST', '/halt', { halted: true, why: 'owner /stopbot' });
    assert.equal(h.status, 200);
    assert.equal((h.body.cancelled as unknown[]).length, 1);
    assert.match(String(h.body.message), /halted/);
    assert.equal(w.fake.allOrders().filter((o) => o.status === 'submitted' || o.status === 'partial').length, 0);
    assert.ok(w.log().some((x) => x[1] === 'cancelled' && /kill switch/.test(x[8]!)));
    const n = w.fake.requests.length;
    assert.equal((await w.tick()).phase, 'halted');
    assert.equal(w.fake.requests.length, n);
    assert.equal((await w.call('POST', '/plan', { plan: PLAN() })).status, 409, 'no plan is stored while halted');
    const st = await w.call('GET', '/status');
    assert.equal(st.body.halted, true);
    const go = await w.call('POST', '/halt', { halted: false });
    assert.equal(go.body.halted, false);
    w.quotes();
    assert.equal((await w.tick()).phase, 'skipped');
    assert.equal(w.fake.requests.length, n);
  });

  test('a halted executor cancels an order that appeared after the halt (e.g. sent by hand)', async () => {
    const w = world();
    await updateState(w.state, (s) => { s.halted = true; });
    const g = guardBroker(w.fake, BOT);
    await g.placeLimitOrder({ account: BOT, orderRef: 'manual', ticker: 'NVDA', kind: 'share', side: 'SELL', qty: 1, limit: 999, tif: 'DAY' });
    const r = await w.tick();
    assert.equal(r.phase, 'halted');
    assert.deepEqual(r.cancelled, ['manual']);
  });

  test('cancels that fail are reported with the IBKR app step', async () => {
    const w = world();
    await w.postAndApprove();
    w.at(START); w.quotes();
    await w.tick();
    w.fake.disconnect();
    const h = await w.call('POST', '/halt', { halted: true });
    assert.equal(h.body.ok, false);
    assert.match(String(h.body.message), /IBKR app/);
    assert.equal((await w.state.load()).halted, true, 'halted is set even when the cancels fail');
  });
});

describe('reconciliation: ledger vs broker', () => {
  const pos = (ticker: string, qty: number) => ({ account: BOT, ticker, kind: 'share' as const, qty, avgCost: 1 });
  const L = (positions: Record<string, number>, cash = 100) => ({ positions, cash, confirmedAt: 0 });
  test('split, reverse split, dividend, cash out, rename, manual trade, first run', () => {
    assert.ok(reconcile(L({ NVDA: 2 }), [pos('NVDA', 2)], 100).ok);
    const sp = reconcile(L({ NVDA: 2 }), [pos('NVDA', 20)], 100);
    assert.deepEqual(sp.mismatches.map((m) => m.kind), ['split']);
    assert.match(sp.mismatches[0]!.detail, /10-for-1 split/);
    assert.match(reconcile(L({ NVDA: 20 }), [pos('NVDA', 2)], 100).mismatches[0]!.detail, /reverse split 1-for-10/);
    assert.match(reconcile(L({ NVDA: 2 }), [pos('NVDA', 3)], 100).mismatches[0]!.detail, /3-for-2 split/);
    assert.deepEqual(reconcile(L({ NVDA: 2 }), [pos('NVDA', 2)], 101.2, { autoAcceptCreditUsd: 0 }).mismatches.map((m) => m.kind), ['dividend']);
    assert.deepEqual(reconcile(L({ NVDA: 2 }), [pos('NVDA', 2)], 106).mismatches.map((m) => m.kind), ['dividend'], '$6 is over the $5 auto-accept limit');
    assert.deepEqual(reconcile(L({ NVDA: 2 }), [pos('NVDA', 2)], 90).mismatches.map((m) => m.kind), ['cash']);
    assert.ok(reconcile(L({ NVDA: 2 }), [pos('NVDA', 2)], 100.04).ok, 'cents of rounding are not a mismatch');
    const rn = reconcile(L({ FB: 3 }), [pos('META', 3)], 100);
    assert.deepEqual(rn.mismatches.map((m) => m.kind), ['rename']);
    assert.match(rn.mismatches[0]!.detail, /FB is now META/);
    const man = reconcile(L({ NVDA: 2 }), [pos('NVDA', 2.7), pos('TSLA', 1)], 40);
    assert.deepEqual(man.mismatches.map((m) => m.kind).sort(), ['cash', 'manual', 'manual']);
    assert.match(man.alert!, /held/);
    assert.match(man.alert!, /IBKR app/);
    assert.deepEqual(reconcile(null, [], 1000).mismatches.map((m) => m.kind), ['new']);
    assert.equal(splitName(1.37), null);
  });

  test('owner 2026-10-30: a cash credit under $5 with no position change is accepted (dividend or interest); anything else holds', () => {
    assert.equal(AUTO_ACCEPT_CREDIT_USD, 5);
    assert.equal(BROKER_DEFAULTS.autoAcceptCreditUsd, 5);
    const small = reconcile(L({ NVDA: 2 }), [pos('NVDA', 2)], 101.2);
    assert.ok(small.ok);
    assert.deepEqual(small.mismatches, []);
    assert.equal(small.alert, null);
    assert.equal(small.credit!.amount, 1.2);
    assert.match(small.credit!.detail, /cash \+\$1\.20 with no position change \(a dividend or interest\), under the \$5\.00 auto-accept limit; cash now \$101\.20/);
    const l = L({ NVDA: 2 });
    assert.ok(acceptCredit(l, small));
    assert.equal(l.cash, 101.2);
    assert.ok(reconcile(l, [pos('NVDA', 2)], 101.2).ok && reconcile(l, [pos('NVDA', 2)], 101.2).credit == null, 'accepted once, then the record matches');
    // $5.00 exactly is not under the limit; a credit with a position change is not a plain dividend; cash down always holds
    assert.deepEqual(reconcile(L({ NVDA: 2 }), [pos('NVDA', 2)], 105).mismatches.map((m) => m.kind), ['dividend']);
    const withTrade = reconcile(L({ NVDA: 2 }), [pos('NVDA', 2), pos('AMD', 0.01)], 101);
    assert.deepEqual(withTrade.mismatches.map((m) => m.kind).sort(), ['dividend', 'manual']);
    assert.equal(withTrade.credit, null);
    assert.deepEqual(reconcile(L({ NVDA: 2 }), [pos('NVDA', 2)], 98).mismatches.map((m) => m.kind), ['cash']);
    assert.equal(acceptCredit(L({ NVDA: 2 }), withTrade), false);
    // configurable: LIVE_AUTO_ACCEPT_CREDIT_USD
    assert.equal(brokerConfigFromEnv({ LIVE_IBKR_ACCOUNT: BOT }).autoAcceptCreditUsd, 5);
    assert.equal(brokerConfigFromEnv({ LIVE_IBKR_ACCOUNT: BOT, LIVE_AUTO_ACCEPT_CREDIT_USD: '2' }).autoAcceptCreditUsd, 2);
    assert.equal(brokerConfigFromEnv({ LIVE_IBKR_ACCOUNT: BOT, LIVE_AUTO_ACCEPT_CREDIT_USD: '0' }).autoAcceptCreditUsd, 0);
    assert.equal(brokerConfigFromEnv({ LIVE_IBKR_ACCOUNT: BOT, LIVE_AUTO_ACCEPT_CREDIT_USD: 'x' }).autoAcceptCreditUsd, 5);
    assert.ok(!reconcile(L({ NVDA: 2 }), [pos('NVDA', 2)], 101.2, { autoAcceptCreditUsd: 0 }).ok, '0 turns it off');
    assert.ok(reconcile(L({ NVDA: 2 }), [pos('NVDA', 2)], 109, { autoAcceptCreditUsd: 10 }).ok);
  });

  test('a $1 dividend between the plan and the open: accepted, logged \'credit accepted\', the morning sends', async () => {
    const w = world();
    await w.postAndApprove();
    w.fake.dividend('NVDA', 0.5); // 2 shares -> $1.00
    w.at(START); w.quotes();
    const t = await w.tick();
    assert.notEqual(t.phase, 'skipped', JSON.stringify(t));
    assert.ok(w.fake.requests.length > 0, 'orders sent');
    assert.equal((await w.state.load()).ledger!.cash, 501);
    const row = w.log().find((x) => x[1] === 'credit accepted')!;
    assert.ok(row, JSON.stringify(w.log()));
    assert.equal(row[0], DAY);
    assert.equal(row[6], '1');
    assert.match(row[8]!, /cash \+\$1\.00 with no position change/);
    assert.ok(!w.alerts.some((a) => /does not match/.test(a)));
    await w.tick();
    assert.equal(w.log().filter((x) => x[1] === 'credit accepted').length, 1, 'logged once');
  });

  test('a small credit before the plan: /plan accepts it, logs it, and the plan waits for approval as usual', async () => {
    const w = world();
    w.fake.dividend('NVDA', 1.1); // $2.20
    const r = await w.call('POST', '/plan', { plan: PLAN() });
    assert.equal(r.body.status, 'awaiting-approval', JSON.stringify(r.body));
    assert.equal((await w.state.load()).ledger!.cash, 502.2);
    assert.ok(w.log().some((x) => x[1] === 'credit accepted' && /\+\$2\.20/.test(x[8]!)));
    assert.equal(w.alerts.length, 0);
  });

  test('a $6 credit, or a small credit with LIVE_AUTO_ACCEPT_CREDIT_USD=0, still holds the plan', async () => {
    const w = world();
    w.fake.dividend('NVDA', 3); // $6
    const r = await w.call('POST', '/plan', { plan: PLAN() });
    assert.equal(r.body.status, 'held');
    assert.match(String(r.body.alert), /cash is \$6\.00 more/);
    assert.ok(!w.log().some((x) => x[1] === 'credit accepted'));
    const off = world({ cfg: { autoAcceptCreditUsd: 0 } });
    off.fake.dividend('NVDA', 0.5);
    assert.equal((await off.call('POST', '/plan', { plan: PLAN() })).body.status, 'held');
  });

  test('the bot\'s own fills update the ledger once each', () => {
    const l = L({ NVDA: 2 }, 500), applied: string[] = [];
    const f = { execId: 'E1', orderId: 'O1', orderRef: 'LB-x', account: BOT, ticker: 'NVDA', kind: 'share' as const, side: 'SELL' as const, qty: 2, price: 160, fee: 1, at: 0 };
    assert.equal(applyFills(l, [f, f], applied), 1);
    assert.equal(applyFills(l, [f], applied), 0);
    assert.deepEqual(l.positions, {});
    assert.equal(l.cash, 819);
  });

  test('after a full morning the ledger equals the broker (no false alarm the next night)', async () => {
    const w = world();
    w.fake.setRule('NVDA', { mode: 'full' }); w.fake.setRule('MQZC', { mode: 'full' }); w.fake.setRule('QQQ', { mode: 'partial', share: 0.5 });
    await w.postAndApprove();
    w.at(START); w.quotes();
    await w.tick(); await w.tick();
    w.at(END); await w.tick();
    const s = await w.state.load();
    const snapPos = await w.fake.positions(BOT);
    assert.ok(reconcile(s.ledger, snapPos, await w.fake.cash(BOT)).ok, JSON.stringify({ ledger: s.ledger, broker: w.fake.peek(BOT) }));
  });

  test('a split overnight: /plan holds the plan and alerts; the morning sends nothing; /confirm adopts the broker and asks for approval again', async () => {
    const w = world();
    w.fake.split('NVDA', 4);
    w.fake.split('TSLA', 3); // the owner's account changes too, and is never looked at
    const plan = planOf([order('NVDA', 'SELL', 8, 40, true)]);
    const r = await w.call('POST', '/plan', { plan });
    assert.equal(r.body.status, 'held');
    assert.match(String(r.body.alert), /4-for-1 split/);
    assert.ok(w.alerts.some((a) => /4-for-1 split/.test(a)));
    const a = await w.call('POST', '/approve', { day: DAY, hash: r.body.short, decision: 'approve' });
    assert.equal(a.status, 409);
    assert.match(String(a.body.why), /held/);
    const c = await w.call('POST', '/confirm', {});
    assert.equal(c.status, 200);
    assert.match(String(c.body.message), /needs approval again/);
    assert.deepEqual((await w.state.load()).ledger!.positions, { NVDA: 8 });
    assert.equal((await w.call('POST', '/approve', { day: DAY, hash: r.body.short, decision: 'approve' })).status, 200);
  });

  test('a dividend or a manual trade between the plan and the open holds the morning: nothing is sent', async () => {
    const w = world();
    await w.postAndApprove();
    w.fake.dividend('NVDA', 0.5);
    w.fake.manualTrade(BOT, 'AMD', 0.1, 200);
    w.at(START); w.quotes();
    const t = await w.tick();
    assert.equal(t.phase, 'skipped');
    assert.equal(w.fake.requests.length, 0);
    assert.ok(w.alerts.some((x) => /AMD: 0.1 held that the bot never bought/.test(x)));
    assert.equal((await w.state.load()).pending!.status, 'held');
    assert.ok(w.log().some((x) => x[1] === 'skipped' && /reconciliation/.test(x[8]!)));
  });

  test('the first run has no ledger: held until the owner confirms the starting account', async () => {
    const w = world({ ledger: 'none' });
    const r = await w.call('POST', '/plan', { plan: PLAN() });
    assert.equal(r.body.status, 'held');
    assert.match(String(r.body.alert), /never confirmed/);
    await w.call('POST', '/confirm', {});
    assert.deepEqual((await w.state.load()).ledger, ledgerFromBroker(await w.fake.positions(BOT), 500, EVENING));
  });

  test('a broker that cannot be read at plan time holds the plan', async () => {
    const w = world();
    w.fake.disconnect();
    const r = await w.call('POST', '/plan', { plan: PLAN() });
    assert.equal(r.body.status, 'held');
    assert.match(String(r.body.alert), /could not be read/);
  });
});

describe('signed control calls (HMAC + timestamp, replay refused)', () => {
  const req = (method: string, p: string, body: string, headers: Record<string, string>): ControlRequest => ({ method, path: p, body, headers });
  test('valid; wrong signature; another path or body; old or future timestamp; malformed', () => {
    const now = EVENING, body = '{"a":1}';
    const h = signRequest(SECRET, 'POST', '/plan', body, now);
    assert.ok(checkSignature(req('POST', '/plan', body, h), SECRET, now, 300).ok);
    assert.equal((checkSignature(req('POST', '/plan', body, h), 'y'.repeat(40), now, 300) as { why: string }).why, 'wrong signature');
    assert.equal((checkSignature(req('POST', '/halt', body, h), SECRET, now, 300) as { why: string }).why, 'wrong signature');
    assert.equal((checkSignature(req('POST', '/plan', '{"a":2}', h), SECRET, now, 300) as { why: string }).why, 'wrong signature');
    assert.match((checkSignature(req('POST', '/plan', body, h), SECRET, now + 301_000, 300) as { why: string }).why, /too old/);
    assert.match((checkSignature(req('POST', '/plan', body, h), SECRET, now - 301_000, 300) as { why: string }).why, /too old/);
    assert.match((checkSignature(req('POST', '/plan', body, { ...h, 'x-lb-nonce': 'short' }), SECRET, now, 300) as { why: string }).why, /malformed/);
    assert.match((checkSignature(req('POST', '/plan', body, {}), SECRET, now, 300) as { why: string }).why, /unsigned/);
  });

  test('the handler refuses a replay, an unsigned call and an unknown path, and needs a long secret', async () => {
    const w = world();
    const handler = createControlHandler({ secret: SECRET, broker: w.fake, cfg: w.cfg, state: w.state, store: w.store, now: w.now });
    const h = signRequest(SECRET, 'POST', '/halt', '{"halted":true}', EVENING, 'nonce-0123456789abcdef');
    assert.equal((await handler(req('POST', '/halt', '{"halted":true}', h))).status, 200);
    const again = await handler(req('POST', '/halt', '{"halted":true}', h));
    assert.equal(again.status, 401);
    assert.equal(again.body.why, 'replayed call');
    assert.equal((await handler(req('GET', '/status', '', {}))).status, 401);
    assert.equal((await w.call('GET', '/nothing')).status, 404);
    assert.equal((await w.call('POST', '/plan', 'not json' as unknown)).status, 422);
    assert.throws(() => createControlHandler({ secret: 'short', broker: w.fake, cfg: w.cfg, state: w.state, store: w.store, now: w.now }), new RegExp('at least ' + MIN_SECRET_LENGTH));
    // old nonces are forgotten once their timestamp is too old to pass anyway
    w.at(EVENING + 3600_000);
    await w.call('GET', '/status');
    assert.ok(!('nonce-0123456789abcdef' in (await w.state.load()).nonces));
  });

  test('/status shows the bot account only', async () => {
    const w = world();
    const s = await w.call('GET', '/status');
    assert.equal(s.status, 200);
    assert.equal(s.body.account, BOT);
    assert.deepEqual(s.body.positions, [{ ticker: 'NVDA', kind: 'share', qty: 2 }]);
    assert.ok(!JSON.stringify(s.body).includes(OWNER));
    assert.ok(!JSON.stringify(s.body).includes('TSLA'));
  });

  test('nodeListener adapts node:http without starting a server', async () => {
    const w = world();
    const handler = createControlHandler({ secret: SECRET, broker: w.fake, cfg: w.cfg, state: w.state, store: w.store, now: w.now });
    const listen = nodeListener(handler);
    const call = (headers: Record<string, string>): Promise<{ status: number; body: string }> => new Promise((resolve) => {
      const rq = Object.assign(new EventEmitter(), { method: 'GET', url: '/status?x=1', headers, destroy: () => undefined });
      const rs = { status: 0, writeHead(s: number) { this.status = s; return this; }, end(b: string) { resolve({ status: this.status, body: b }); } };
      listen(rq as never, rs as never);
      rq.emit('end');
    });
    assert.equal((await call(signRequest(SECRET, 'GET', '/status', '', EVENING))).status, 200);
    assert.equal((await call({})).status, 401);
  });
});

describe('💵 Live Log rows: approved, sent, filled, cancelled, skipped', () => {
  test('a morning writes each kind under the plan\'s day; the next night still logs its own day', async () => {
    const w = world();
    w.fake.setRule('NVDA', { mode: 'full' }); w.fake.setRule('MQZC', { mode: 'partial', share: 0.5 });
    await w.postAndApprove(planOf([order('NVDA', 'SELL', 2, 160, true), order('MQZC', 'BUY', 2, 100), order('QQQ', 'BUY', 0.5, 500)]));
    w.at(START); w.quotes(); w.fake.setQuote('QQQ', 500, START - 3600_000);
    await w.tick(); await w.tick();
    w.at(END); await w.tick();
    assert.deepEqual([...whens(w)].sort(), ['approved', 'cancelled', 'filled', 'sent', 'skipped']);
    const log = w.log();
    assert.ok(log.every((x) => x[0] === DAY && x[11] === FOLLOW));
    const fill = log.find((x) => x[1] === 'filled' && x[2] === 'NVDA')!;
    assert.deepEqual([fill[3], fill[4], fill[6], fill[10]], ['SELL', '2', '159.2', orderRef(DAY, FOLLOW, 'NVDA', 'SELL')]);
    assert.equal(log.filter((x) => x[1] === 'sent').length, 2);
    // the next night's dry-run block for EXEC is not blocked by these rows
    assert.equal(await appendNight(w.store, LIVE_LOG_TAB, LIVE_LOG_HEADER, EXEC, [liveEventRow({ day: EXEC, when: 'skipped', why: 'x', account: FOLLOW })]), 1);
  });

  test('appendLiveRows writes a header on a new tab and never the same row twice', async () => {
    const store = new MemoryTabStore();
    const rows = [liveEventRow({ day: DAY, when: 'sent', ticker: 'MQZC', side: 'BUY', qty: 1, limit: 100.5, why: 'limit DAY order O1', ref: 'LB-1', account: FOLLOW })];
    assert.equal(await appendLiveRows(store, rows), 1);
    assert.equal(await appendLiveRows(store, [...rows, ...rows]), 0);
    const all = store.snapshot(LIVE_LOG_TAB, LIVE_LOG_COLS)!;
    assert.equal(all[0]![0], 'Day');
    assert.equal(all.length, 2);
    assert.equal(all[1]!.length, LIVE_LOG_COLS);
  });
});

describe('the fake broker', () => {
  test('fills, partial fills, rejects, cash account rules, settlement, corporate actions, new day', async () => {
    let t = 1_000;
    const f = new FakeBroker({ now: () => t }).addAccount(BOT, 1000, { NVDA: { qty: 2, avgCost: 150 } }).addAccount(OWNER, 10, { NVDA: { qty: 5, avgCost: 1 } });
    f.setRule('NVDA', { mode: 'full' });
    const s = await f.placeLimitOrder({ account: BOT, orderRef: 'a', ticker: 'NVDA', kind: 'share', side: 'SELL', qty: 2, limit: 160, tif: 'DAY' });
    assert.equal(s.status, 'filled');
    assert.equal(await f.cash(BOT), 1319);
    assert.equal(await f.settledCash(BOT), 1000, 'sale money settles T+1');
    f.settle();
    assert.equal(await f.settledCash(BOT), 1319);
    f.setRule('MQZC', { mode: 'partial', share: 0.25 });
    const p = await f.placeLimitOrder({ account: BOT, orderRef: 'b', ticker: 'MQZC', kind: 'share', side: 'BUY', qty: 4, limit: 100, tif: 'DAY' });
    assert.equal(p.status, 'partial'); assert.equal(p.filledQty, 1);
    t = 2_000; f.trade('MQZC', 99);
    assert.equal((await f.todaysOrders(BOT)).find((o) => o.orderRef === 'b')!.status, 'filled');
    assert.equal((await f.todaysFills(BOT)).length, 3);
    f.setRule('AMD', { mode: 'reject', reason: 'halted stock' });
    assert.equal((await f.placeLimitOrder({ account: BOT, orderRef: 'c', ticker: 'AMD', kind: 'share', side: 'BUY', qty: 1, limit: 10, tif: 'DAY' })).reason, 'halted stock');
    assert.equal((await f.placeLimitOrder({ account: BOT, orderRef: 'd', ticker: 'TSLA', kind: 'share', side: 'SELL', qty: 1, limit: 10, tif: 'DAY' })).status, 'rejected');
    assert.equal((await f.placeLimitOrder({ account: BOT, orderRef: 'e', ticker: 'TSLA', kind: 'share', side: 'BUY', qty: 100, limit: 100, tif: 'DAY' })).status, 'rejected');
    assert.equal(f.violations.length, 2, 'the short sale and the unsettled buy are recorded as violations');
    f.split('MQZC', 2);
    assert.equal(f.peek(BOT).positions.MQZC, 8);
    f.dividend('MQZC', 0.1);
    f.rename('MQZC', 'MUX');
    assert.equal(f.peek(BOT).positions.MUX, 8);
    assert.equal(f.peek(OWNER).positions.NVDA, 5, 'the second account is untouched by the bot account\'s trades');
    f.setRule('MUX', { mode: 'none' });
    await f.placeLimitOrder({ account: BOT, orderRef: 'f', ticker: 'MUX', kind: 'share', side: 'SELL', qty: 1, limit: 500, tif: 'DAY' });
    assert.equal((await f.openOrders(BOT)).length, 1);
    f.newDay();
    assert.equal((await f.openOrders(BOT)).length, 0);
    assert.equal((await f.todaysFills(BOT)).length, 0);
    f.disconnect();
    await assert.rejects(f.positions(BOT), /not connected/);
    assert.equal(f.connectionState(), 'disconnected');
  });
});

describe('the IBKR adapter is a placeholder', () => {
  test('every call throws "not configured"; it is never connected', async () => {
    const b = new IbkrBrokerNotConfigured();
    assert.equal(b.connectionState(), 'disconnected');
    await assert.rejects(b.accounts(), new RegExp(IBKR_NOT_CONFIGURED.slice(0, 30)));
    await assert.rejects(b.placeLimitOrder({ account: BOT, orderRef: 'x', ticker: 'NVDA', kind: 'share', side: 'BUY', qty: 1, limit: 1, tif: 'DAY' }), /not configured/);
    assert.throws(() => ibkrBroker(), /not configured/);
  });
});

describe('bot state and calendar helpers', () => {
  test('the state file is written whole and read back; updates are serialised', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-'));
    const store = new FileBotStateStore(path.join(dir, 'state.json'));
    assert.deepEqual(await store.load(), emptyBotState());
    await Promise.all(Array.from({ length: 20 }, (_, i) => updateState(store, (s) => { s.appliedFills.push('E' + i); })));
    assert.equal((await store.load()).appliedFills.length, 20);
    assert.equal(fs.statSync(path.join(dir, 'state.json')).mode & 0o777, 0o600);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the plan runs on the next trading day; the open is 9:30 New York in winter and summer', () => {
    assert.equal(nextTradingDay('2026-11-02'), '2026-11-03');
    assert.equal(nextTradingDay('2026-11-25'), '2026-11-27', 'Thanksgiving skipped');
    assert.equal(nextTradingDay('2026-11-06'), '2026-11-09');
    assert.equal(new Date(nyMoment('2026-11-03', 570)).toISOString(), '2026-11-03T14:30:00.000Z');
    assert.equal(new Date(nyMoment('2026-07-06', 570)).toISOString(), '2026-07-06T13:30:00.000Z');
  });
});
