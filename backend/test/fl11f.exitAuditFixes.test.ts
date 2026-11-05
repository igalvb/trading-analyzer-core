/**
 * FL-11f: fixes from the 2026-10-27 audit of the Exit report against the agreed items.
 *   #21  option rows get today's price per share from the Portfolio "current market value" cell
 *        (My Options writes mid x 100 x contracts there), so gain and tax can be shown.
 *   #20  no holding-period wording in the no-purchase-date line (owner decision 2026-10-25).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parsePortfolio } from '../src/sheets/readers/portfolio.ts';
import { optionPricePerShare } from '../src/app/nightlyApp.ts';
import { T } from '../src/reports/exitSheet/text.ts';
import type { SheetRow } from '../src/sheets/coerce.ts';

const HEADER = ['Ticker', 'type', 'positions', 'last trade Date', 'strike', 'PUT/CALL', 'avg price - Premium paid', 'cost basis', 'current market value', 'URLS / comments', 'Purchase Date'];

describe('FL-11f — Exit audit fixes', () => {
  test('#21 the option row keeps its current market value; "N/A — ..." reads as missing', () => {
    const rows: SheetRow[] = [
      ['Ticker', 'type', 'sub-type', 'amount', 'cost avg per stock'],
      HEADER,
      ['MSTR', 'options', 3, '2027-06-17', 100, 'CALL', 48.52, 14556, 16230, '', '2026-06-09'],
      ['IBIT', 'options', 1, '2027-12-17', 38, 'CALL', 10.82, 1082, 'N/A — no quote', '', '2026-06-02'],
    ];
    const o = parsePortfolio(rows).options;
    assert.equal(o[0]!.currentValue, 16230);
    assert.equal(o[1]!.currentValue, null);
  });

  test('#21 price per share = market value / (100 x contracts), same unit as the premium paid', () => {
    assert.equal(optionPricePerShare({ currentValue: 16230, contracts: 3 }), 54.1);
    assert.equal(optionPricePerShare({ currentValue: 1332.5, contracts: 1 }), 13.325);
    assert.equal(optionPricePerShare({ currentValue: null, contracts: 3 }), null);
    assert.equal(optionPricePerShare({ currentValue: 100, contracts: 0 }), null);
    assert.equal(optionPricePerShare({ contracts: 2 }), null);
  });

  test('#20 the no-purchase-date line has no holding-period wording', () => {
    assert.doesNotMatch(T.noEntryDates(2, 'MSTR, IBIT'), /holding.period/i);
  });
});

import { compactList } from '../src/reports/exitSheet/exitSheet.ts';

describe('FL-11f — Exit display', () => {
  test('a repeated chart pattern is shown once with its count', () => {
    assert.equal(compactList('DOUBLE_TOP, DOUBLE_TOP, DOUBLE_TOP, INVERSE_HEAD_AND_SHOULDERS'), 'DOUBLE_TOP (x3), INVERSE_HEAD_AND_SHOULDERS');
    assert.equal(compactList('FLAG'), 'FLAG');
  });
});

import { groupSkipped } from '../src/jobs/exit/exitReportAdapter.ts';

describe('FL-11f — #32 why rows were left out', () => {
  test('rows are grouped under a fixed plain reason; cell text inside the reason is never shown', () => {
    const out = groupSkipped([
      { rowNumber: 52, ticker: 'TOTAL', reason: '"*"/TOTAL marker, not a real position' },
      { rowNumber: 53, ticker: 'XYZ', reason: 'type="watch apikey=SECRET" — not a stock or crypto row' },
      { rowNumber: 54, ticker: 'ABC', reason: 'type="cash" — not a stock or crypto row' },
    ]);
    assert.deepEqual(out, ['total or note rows: row 52 (TOTAL)', 'not typed stock or crypto: row 53 (XYZ), row 54 (ABC)']);
    assert.ok(!out.join(' ').includes('SECRET'));
  });
});

import { buildSellPlan } from '../src/portfolio/sellPlan.ts';

describe('FL-11f — #49 one money format', () => {
  test('sell-plan prices use thousands separators like the rest of the Exit report', () => {
    const p = buildSellPlan({ kind: 'STOCK', quantity: 10, t1: 1234.5, t2: 2345.678, stop: 1100 } as never);
    const text = p.lines.join(' ');
    assert.match(text, /\$1,234\.50/);
    assert.match(text, /\$1,100\.00/);
    assert.doesNotMatch(text, /\$\d{4,}/);
  });
});

import { verdictBackground } from '../src/reports/exitSheet/exitSheet.ts';

describe('FL-11f — #8 colours', () => {
  test('a target-reached verdict is yellow; exit red; hold green', () => {
    assert.equal(verdictBackground('T1 reached — sell the first part'), '#fff9c4');
    assert.equal(verdictBackground('CONSIDER TRIMMING — T1 reached'), '#fff9c4');
    assert.equal(verdictBackground('EXIT — stop breached'), '#ffcdd2');
    assert.equal(verdictBackground('HOLD — all good'), '#c8e6c9');
  });
});
