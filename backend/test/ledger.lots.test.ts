/**
 * Dated purchase lots (src/ledger/lots.ts; schema.ts LedgerStock.lots, additive 2026-11-07): the implied undated rest,
 * the checks, boughtOf, the dashboard page's copy, the net worth screen's checks, and toPortfolio unchanged.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lotsOf, boughtOf, lotChecks, IMPLIED_MAX_RATIO } from '../src/ledger/lots.ts';
import { toPortfolio } from '../src/ledger/toPortfolio.ts';
import { buildNetWorth } from '../src/ledger/networth.ts';
import type { LedgerHoldings, LedgerStock } from '../src/ledger/schema.ts';

const TODAY = '2026-11-07';
const stock = (o: Partial<LedgerStock>): LedgerStock => ({ id: 's1', ticker: 'AAA', kind: 'stock', qty: 100, avgCost: 50, currency: 'USD', bought: null, ...o });

describe('lotsOf', () => {
  test('no lots: no rows, no problem', () => {
    assert.deepEqual(lotsOf(stock({}), 60, TODAY), { rows: [], problem: null });
    assert.deepEqual(lotsOf(stock({ lots: [] }), 60, TODAY), { rows: [], problem: null });
  });
  test('the rest is one implied undated lot that keeps the total cost = qty x avgCost', () => {
    const v = lotsOf(stock({ lots: [{ date: '2025-11-07', qty: 40, price: 40 }, { date: '2024-11-07', qty: 20, price: 30 }] }), 60, TODAY);
    assert.equal(v.problem, null);
    assert.deepEqual(v.rows.map((r) => [r.date, r.qty, r.price, r.implied, r.index]), [['2024-11-07', 20, 30, false, 1], ['2025-11-07', 40, 40, false, 0], [null, 40, 70, true, null]]);
    const total = v.rows.reduce((a, r) => a + (r.cost as number), 0);
    assert.equal(total, 100 * 50);
    const first = v.rows[0]!;
    assert.equal(first.gain, 600);
    assert.equal(first.gainPct, 100);
    assert.equal(first.heldDays, 730);
    assert.equal(v.rows[2]!.heldDays, null);
  });
  test('dated lots that hold all of qty: no rest; a cost that does not match is a check', () => {
    assert.equal(lotsOf(stock({ lots: [{ date: '2025-01-02', qty: 100, price: 50 }] }), null, TODAY).problem, null);
    const v = lotsOf(stock({ lots: [{ date: '2025-01-02', qty: 100, price: 45 }] }), null, TODAY);
    assert.equal(v.rows.length, 1);
    assert.match(v.problem!, /cost 4500, not 5000/);
    assert.equal(v.rows[0]!.gain, null, 'no price now: no gain');
  });
  test('more in the lots than held, a negative or absurd implied price: flagged, no price shown', () => {
    assert.match(lotsOf(stock({ lots: [{ date: '2025-01-02', qty: 120, price: 50 }] }), 60, TODAY).problem!, /more than the 100 you hold/);
    const neg = lotsOf(stock({ lots: [{ date: '2025-01-02', qty: 90, price: 60 }] }), 60, TODAY);
    assert.match(neg.problem!, /would have cost -40 each/);
    assert.equal(neg.rows[1]!.price, null);
    assert.equal(neg.rows[1]!.gain, null);
    const absurd = lotsOf(stock({ lots: [{ date: '2025-01-02', qty: 99.9, price: 1 }] }), 60, TODAY);
    assert.ok(absurd.rows[1]!.price === null && /check the lots/.test(absurd.problem!), 'over ' + IMPLIED_MAX_RATIO + 'x avgCost');
    assert.match(lotsOf(stock({ avgCost: null, lots: [{ date: '2025-01-02', qty: 10, price: 1 }] }), 60, TODAY).problem!, /No average cost/);
  });
  test('bad lot entries are skipped; an explicit undated lot sorts last', () => {
    const v = lotsOf(stock({ lots: [{ date: null, qty: 10, price: 50 }, { date: '2025-01-02', qty: -1, price: 1 }, { date: '2025-01-03', qty: 90, price: 50 }] as never }), 50, TODAY);
    assert.deepEqual(v.rows.map((r) => [r.date, r.index]), [['2025-01-03', 2], [null, 0]]);
    assert.equal(v.problem, null);
  });
});

describe('boughtOf / lotChecks', () => {
  test('bought wins; else the earliest dated lot; else null', () => {
    assert.equal(boughtOf(stock({ bought: '2023-05-01', lots: [{ date: '2022-01-01', qty: 1, price: 1 }] })), '2023-05-01');
    assert.equal(boughtOf(stock({ lots: [{ date: '2024-04-26', qty: 1, price: 1 }, { date: null, qty: 1, price: 1 }, { date: '2024-03-20', qty: 1, price: 1 }] })), '2024-03-20');
    assert.equal(boughtOf(stock({})), null);
  });
  test('only holdings whose lots do not add up', () => {
    assert.deepEqual(lotChecks([stock({}), stock({ ticker: 'BBB', lots: [{ date: '2025-01-02', qty: 200, price: 1 }] })], TODAY), ['BBB: The dated lots hold 200, more than the 100 you hold: remove or fix a lot.']);
  });
});

describe('the runs and the net worth screen', () => {
  const H = (stocks: LedgerStock[]): LedgerHoldings => ({ schema: 1, updated: '2026-11-07', stocks, options: [], closed: [] });
  test('toPortfolio keeps reading qty / avgCost / bought only (no behaviour change)', () => {
    const plain = toPortfolio(H([stock({})]));
    const withLots = toPortfolio(H([stock({ lots: [{ date: '2024-03-20', qty: 10, price: 30 }] })]));
    assert.deepEqual(withLots, plain);
  });
  test('the net worth screen lists the lot checks (absent when all add up)', () => {
    const nw = (s: LedgerStock[]) => buildNetWorth({ ledger: { holdings: H(s) }, live: [], nowMs: Date.UTC(2026, 10, 7, 17) } as never)!;
    assert.equal(nw([stock({ lots: [{ date: '2025-01-02', qty: 10, price: 50 }] })]).checks, undefined);
    assert.deepEqual(nw([stock({ lots: [{ date: '2025-01-02', qty: 101, price: 50 }] })]).checks, ['AAA: The dated lots hold 101, more than the 100 you hold: remove or fix a lot.']);
  });
});

describe('the dashboard page carries the same lot math', () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'dashboard', 'index.html'), 'utf8');
  const m = /\/\* lots-math:start[^*]*\*\/([\s\S]*?)\/\* lots-math:end \*\//.exec(html);
  test('lotsOf and boughtOf give the same answers', () => {
    assert.ok(m, 'the lots-math markers are in the page');
    const page = new Function(m![1] + '\nreturn { lotsOf, boughtOf };')() as { lotsOf: typeof lotsOf; boughtOf: typeof boughtOf };
    const cases: LedgerStock[] = [
      stock({}),
      stock({ lots: [{ date: '2025-11-07', qty: 40, price: 40 }, { date: '2024-11-07', qty: 20, price: 30, note: 'n' }] }),
      stock({ lots: [{ date: '2025-01-02', qty: 100, price: 45 }] }),
      stock({ lots: [{ date: '2025-01-02', qty: 120, price: 50 }] }),
      stock({ lots: [{ date: '2025-01-02', qty: 90, price: 60 }] }),
      stock({ lots: [{ date: '2025-01-02', qty: 99.9, price: 1 }] }),
      stock({ avgCost: null, lots: [{ date: null, qty: 10, price: 1 }] }),
      stock({ bought: '2023-01-01', qty: 2113.5, avgCost: 40.06, lots: [{ date: '2024-03-20', qty: 116, price: 36.26 }, { date: '2024-04-02', qty: 49, price: 37.1 }] }),
    ];
    for (const c of cases) {
      for (const p of [null, 0, 61.25]) assert.deepEqual(page.lotsOf(c, p, TODAY), lotsOf(c, p, TODAY), JSON.stringify(c) + ' @ ' + p);
      assert.equal(page.boughtOf(c), boughtOf(c));
    }
  });
});
