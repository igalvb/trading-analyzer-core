/**
 * GENERIC_PLAN P3: wording comes from the profile `labels.*` and the tax rate; logic finds the yardsticks by key.
 * This file runs in its own process with PROFILE_JSON = the EXAMPLE profile (a made-up user, "your list", tax 20%),
 * so every module below prints the example's words and never an owner's. The owner's words are pinned in
 * test/owner.profile.test.ts and by the goldens (scripts/golden.ts).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLE_PROFILE_INPUT } from '../src/profile/example.ts';

process.env.PROFILE_JSON = JSON.stringify(EXAMPLE_PROFILE_INPUT);
delete process.env.PROFILE_FILE;

const OWNER_WORDING = /your \d+|owner's \d+|Hold your \d+/i;

describe('P3 — labels and key matching (example profile)', async () => {
  const { LABELS } = await import('../src/profile/labels.ts');
  const paper = await import('../src/paper/paperTrading.ts');
  const lab = await import('../src/paper/paperLab.ts');
  const digest = await import('../src/reports/digest/nightlyDigest.ts');
  const live = await import('../src/live/liveLog.ts');
  const fee = await import('../src/live/feeReport.ts');
  const report = await import('../src/paper/paperReport.ts');

  test('the labels are the example\'s words', () => {
    assert.deepEqual(LABELS, {
      list: 'your list', List: 'Your list', holdList: 'Hold your list', holdResearchCore: 'Hold your list equally',
      holdResearchCoreLower: 'hold your list equally', holdCore: 'Hold your list equally', holdCoreShort: 'Hold your list equally',
      research: 'your list', Research: 'Your list', holdResearch: 'Hold your list',
    });
    assert.equal(lab.JAMES_PT_LIST14_LABEL, 'James — Profit-Taking A20 on your list held equally');
  });

  test('the digest finds the yardsticks by key, whatever their label', () => {
    const st = paper.newPaperState(['AAPL']);
    st.marks.push({ day: '2026-10-29', values: { turtle: 107_500, qqq: 101_800, 'lab.list14': 102_400 } });
    const rows = paper.standings(st);
    assert.equal(rows.find((r) => r.key === 'lab.list14')?.name, 'Hold your list equally');
    const p = digest.paperLine(st)!;
    assert.equal(p.qqq, '+1.8%');
    assert.equal(p.list14, '+2.4%');
    const t = digest.digestTable(digest.digestOf({ day: 'd', capture: {}, paper: st, summary: null }));
    assert.match(t, /^Your list \+2\.4%$/m, 'a label as wide as the column keeps a space before the value');
    assert.ok(!OWNER_WORDING.test(t));
    const msg = report.dailyMessage(st);
    assert.ok(msg.includes('📊 Hold your list equally: +2.4%') && msg.includes('📊 Hold QQQ: +1.8%'), msg);
  });

  test('live log and fee report say "your list"', () => {
    assert.ok(live.LIVE_LOG_HEADER.includes('📊 Hold your list after tax') && live.LIVE_LOG_HEADER.includes('Deepest fall: Hold your list'));
    const r = fee.buildFeeReport(null, null, { startValue: 1000, minTrade: 50, fractional: true, fees: { perShare: 0.005, min: 1, maxPct: 0.01 } } as never);
    assert.ok(!OWNER_WORDING.test(r.line), r.line);
    assert.ok(fee.feeReportText(r, null).every((l) => !OWNER_WORDING.test(l)));
  });

  test('tax texts follow tax.rate (example 20%), never a fixed 25%', async () => {
    const tax = await import('../src/portfolio/exitTax.ts');
    const framing = await import('../src/ai/exitFraming.ts');
    const job = await import('../src/paper/paperJob.ts');
    assert.equal(tax.EXIT_TAX_PCT, '20%');
    assert.ok(tax.exitTaxLines(tax.computeExitTax({ quantity: 10, unitCost: 100, unitPrice: 150 })).some((l) => l.includes('(20% of the gain)')));
    assert.ok(framing.EXIT_FORMAT.includes('assumed at 20% of the gain') && !framing.EXIT_FORMAT.includes('25%'));
    const rows = job.paperTabRows({ state: paper.newPaperState(['AAPL']), trades: [] });
    assert.ok(String(rows[1]?.[0]).includes(', 20% tax on gains.'));
    const r = fee.buildFeeReport(null, null, { startValue: 1000, minTrade: 50, fractional: true, fees: { perShare: 0.005, min: 1, maxPct: 0.01 } } as never);
    assert.ok(fee.feeReportSection(r)[0]!.includes('after fees and 20% tax'));
  });

  test('legacy Exit port reads the purchase-date header from the profile; macro ETFs come from the engine lists', async () => {
    const exit = await import('../src/reports/exit/exitReport.ts');
    assert.equal(exit.EXIT_STRATEGY_PURCHASE_DATE_COLUMN, 'Purchase Date', 'the template header (no alias in the example profile)');
    const prices = await import('../src/research/fetchPrices.ts');
    assert.deepEqual(prices.MACRO_EXTRA_TICKERS, ['DIA', 'IYT', 'TLT', 'GLD', 'XLP', 'XLU', 'XLV', 'XLY', 'XLI', 'XLB']);
  });
});
