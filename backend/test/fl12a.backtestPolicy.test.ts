/** FL-12a (backlog 9): the backtest decision policy, on mock engine and exit reads only. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buyCheck, rankReads, planBuys, planSell, HOLD_OFF_VERDICTS, type HeldPosition } from '../src/backtest/policy.ts';
import { computePositionSize, ACCOUNT } from '../src/analysis/decision.ts';
import { BUY_TIER1_MIN_CONVICTION } from '../src/jobs/buy/buyPipeline.ts';
import { read, exitRead } from './fl12aFixtures.ts';

describe('FL-12a — buy rule (Buy report tier 1 + comparison verdict)', () => {
  test('tier 1 = BUY_NOW or conviction >= the Buy report cut-off; the verdict must not be SPLIT / NO_CONSENSUS / missing', () => {
    assert.equal(BUY_TIER1_MIN_CONVICTION, 70);
    assert.deepEqual(HOLD_OFF_VERDICTS, ['SPLIT', 'NO_CONSENSUS']);
    assert.equal(buyCheck(read({ timing: 'BUY_NOW', finalConviction: 40 })).eligible, true);
    assert.equal(buyCheck(read({ timing: 'WAIT_PULLBACK', finalConviction: 70, verdict: 'ALL_AGREE' })).eligible, true);
    const t2 = buyCheck(read({ timing: 'WAIT_PULLBACK', finalConviction: 69 }));
    assert.equal(t2.eligible, false); assert.equal(t2.tier, 2); assert.match(t2.reason, /not tier 1/);
    for (const v of ['SPLIT', 'NO_CONSENSUS']) {
      const c = buyCheck(read({ verdict: v }));
      assert.equal(c.eligible, false); assert.equal(c.tier, 1); assert.equal(c.reason, 'comparison verdict ' + v);
    }
    assert.equal(buyCheck(read({ verdict: null })).reason, 'no comparison verdict');
    assert.equal(buyCheck(read({ verdict: 'MAJORITY' })).eligible, true);
  });

  test('no decision, or blocked by the fundamentals floor, is never a buy (a block beats BUY_NOW)', () => {
    assert.match(buyCheck(read({ ok: false, finalConviction: null, aborted: 'no price data' })).reason, /no decision \(no price data\)/);
    const b = buyCheck(read({ blocked: true, ownScore: 10, finalConviction: 0 }));
    assert.equal(b.eligible, false); assert.equal(b.tier, 3); assert.match(b.reason, /blocked/);
  });

  test('candidates are ranked like the Buy report: BUY_NOW first, conviction, entry confidence, ticker', () => {
    const r = rankReads([
      read({ ticker: 'D', timing: 'WAIT_PULLBACK', finalConviction: 90 }),
      read({ ticker: 'C', timing: 'BUY_NOW', finalConviction: 50, entryConfidencePct: 10 }),
      read({ ticker: 'B', timing: 'BUY_NOW', finalConviction: 50, entryConfidencePct: 60 }),
      read({ ticker: 'A', timing: 'BUY_NOW', finalConviction: 50, entryConfidencePct: 60 }),
      read({ ticker: 'E', timing: 'BUY_NOW', finalConviction: 80 }),
    ]);
    assert.deepEqual(r.map((x) => x.ticker), ['E', 'A', 'B', 'C', 'D']);
  });
});

describe('FL-12a — sizing and the position cap', () => {
  test('size = computePositionSize(entry, stop, conviction, {equity, ACCOUNT.riskPct}) exactly', () => {
    assert.equal(ACCOUNT.riskPct, 1);
    const { orders } = planBuys({ equity: 100_000, held: new Set(), openAfterExits: 0 }, [read({ entryPrice: 100, stop: 95, finalConviction: 60 })], { maxPositions: 6 });
    assert.equal(orders.length, 1);
    // 1% of 100k x (0.5 + 0.5 x 0.6) = $800 risk / $5 per share = 160 shares.
    assert.equal(orders[0]!.plannedShares, 160);
    assert.deepEqual(orders[0]!.sizing, computePositionSize(100, 95, 60, { size: 100_000, riskPct: 1 }));
  });

  test('held tickers are skipped; the max-positions rule counts open positions after full exits; Test B has no cap', () => {
    const reads = ['A', 'B', 'C', 'D'].map((t) => read({ ticker: t }));
    const p = planBuys({ equity: 100_000, held: new Set(['A']), openAfterExits: 4 }, reads, { maxPositions: 6 });
    assert.deepEqual(p.orders.map((o) => o.ticker), ['B', 'C']);
    assert.deepEqual(p.skipped.map((s) => [s.ticker, s.reason]), [['D', 'max 6 positions']]);
    assert.equal(planBuys({ equity: 100_000, held: new Set(), openAfterExits: 40 }, reads, { maxPositions: null }).orders.length, 4);
  });

  test('a stop at or above the entry gives no size and no order; ineligible reads never become orders', () => {
    const p = planBuys({ equity: 100_000, held: new Set(), openAfterExits: 0 }, [read({ ticker: 'X', stop: 100 }), read({ ticker: 'Y', verdict: 'SPLIT' })], { maxPositions: 6 });
    assert.equal(p.orders.length, 0);
    assert.deepEqual(p.skipped.map((s) => s.ticker), ['X']);
  });
});

describe('FL-12a — sell rule (the engine exit read + the F-X2 thirds rule)', () => {
  const pos = (shares: number, stage: HeldPosition['stage'] = null): HeldPosition => ({ ticker: 'AAA', shares, entryDate: '2024-03-04', entryPrice: 100, stage });

  test('EXIT (stop breached or thesis turned AVOID) sells everything; HOLD and a failed read sell nothing', () => {
    const o = planSell(pos(9), exitRead({ actionClass: 'EXIT', recommendation: 'STOP HIT — EXIT', stopBreached: true }));
    assert.ok(o); assert.equal(o.shares, 9); assert.equal(o.full, true); assert.equal(o.reason, 'STOP HIT — EXIT');
    assert.equal(planSell(pos(9), exitRead({ actionClass: 'EXIT', recommendation: 'THESIS INVALIDATED — CONSIDER EXIT', thesisInvalidated: true }))!.shares, 9);
    assert.equal(planSell(pos(9), exitRead()), null);
    assert.equal(planSell(pos(9), exitRead({ ok: false, actionClass: null })), null);
  });

  test('a third at T1, a third at T2, the runner kept; the plan is remembered and never re-split', () => {
    const t1 = exitRead({ actionClass: 'TRIM', hitT1: true });
    const s1 = planSell(pos(9), t1);
    assert.ok(s1); assert.equal(s1.shares, 3); assert.equal(s1.full, false);
    assert.deepEqual(s1.stageAfter, { originalQuantity: 9, plannedAtT1: 3, plannedAtT2: 3, since: '2024-03-04', rule: 'THIRDS_RUNNER' });
    const s2 = planSell(pos(6, s1.stageAfter), exitRead({ actionClass: 'TRIM', hitT1: true }));
    assert.ok(s2); assert.equal(s2.shares, 3); assert.deepEqual(s2.stageAfter, s1.stageAfter);
    assert.equal(planSell(pos(3, s1.stageAfter), exitRead({ actionClass: 'TRIM', hitT1: true, hitT2: true })), null, 'runner only: held for the trailing stop');
    const exitRunner = planSell(pos(3, s1.stageAfter), exitRead({ actionClass: 'EXIT', recommendation: 'STOP HIT — EXIT' }));
    assert.equal(exitRunner!.shares, 3);
  });

  test('T1 and T2 both reached at once sells both thirds; 5 shares round down (1 / 1 / keep 3); 1 share sells whole', () => {
    assert.equal(planSell(pos(9), exitRead({ actionClass: 'TRIM', hitT1: true, hitT2: true }))!.shares, 6);
    const five = planSell(pos(5), exitRead({ actionClass: 'TRIM', hitT1: true }));
    assert.equal(five!.shares, 1); assert.equal(five!.stageAfter!.plannedAtT2, 1);
    const one = planSell(pos(1), exitRead({ actionClass: 'TRIM', hitT1: true }));
    assert.equal(one!.shares, 1); assert.equal(one!.full, true);
  });
});
