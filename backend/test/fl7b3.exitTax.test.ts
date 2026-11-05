/** The one Exit tax rule (user, 2026-10-25): 25% of the gain, 0 on a loss; replaces fl8o.tax and fl8q.tax. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeExitTax, exitTaxLines, EXIT_TAX_RATE, EXIT_TAX_ASSUMPTION } from '../src/portfolio/exitTax.ts';
import { findReportLeaks } from '../src/reports/messages/leakScan.ts';

test('a gain: tax is 25% of the gain; after-tax value is market value minus tax', () => {
  const t = computeExitTax({ quantity: 10, unitCost: 100, unitPrice: 150 });
  assert.equal(EXIT_TAX_RATE, 0.25);
  assert.deepStrictEqual(t, { rate: 0.25, costBasisUsd: 1000, marketValueUsd: 1500, unrealizedUsd: 500, unrealizedPct: 50, taxOwedUsd: 125, afterTaxValueUsd: 1375, afterTaxGainUsd: 375 });
  assert.deepStrictEqual(exitTaxLines(t), ['Unrealized gain: $500 (+50.0%).', 'If sold today, about $125 would go to tax (25% of the gain), leaving about $1,375.', EXIT_TAX_ASSUMPTION]);
});

test('a loss owes nothing; options use x100; a worthless option is a full loss', () => {
  const loss = computeExitTax({ quantity: 10, unitCost: 100, unitPrice: 80 });
  assert.equal(loss.taxOwedUsd, 0); assert.equal(loss.afterTaxValueUsd, 800); assert.equal(loss.afterTaxGainUsd, -200);
  assert.ok(exitTaxLines(loss).some((l) => /not in profit/.test(l)));
  const opt = computeExitTax({ quantity: 2, unitCost: 3, unitPrice: 5, multiplier: 100 });
  assert.equal(opt.unrealizedUsd, 400); assert.equal(opt.taxOwedUsd, 100);
  const worthless = computeExitTax({ quantity: 1, unitCost: 2, unitPrice: 0, multiplier: 100 });
  assert.equal(worthless.unrealizedUsd, -200); assert.equal(worthless.taxOwedUsd, 0);
});

test('missing or zero inputs give no figures, never a guess; no holding-period wording anywhere', () => {
  for (const i of [{ quantity: null, unitCost: 1, unitPrice: 2 }, { quantity: 0, unitCost: 1, unitPrice: 2 }, { quantity: 1, unitCost: 0, unitPrice: 2 }, { quantity: 1, unitCost: 1, unitPrice: null }]) {
    const t = computeExitTax(i);
    assert.equal(t.taxOwedUsd, null); assert.equal(t.afterTaxValueUsd, null);
    assert.deepStrictEqual(exitTaxLines(t), []);
  }
  const lines = exitTaxLines(computeExitTax({ quantity: 3, unitCost: 10, unitPrice: 12 })).join('\n');
  assert.doesNotMatch(lines, /long-term|short-term|held|days/i);
  assert.deepStrictEqual(findReportLeaks(lines), []);
});
