/**
 * E1 option A (fix plan 2026-10-30, label only): the price is inside or below the buy zone, above the stop, and the
 * timing is still WAIT_PULLBACK (in CHOP BUY_NOW is not reachable). The reports say "✅ AT YOUR BUY LIMIT" instead
 * of "wait for a pullback": the Bottom Line overall line, the Options Decision "Why" line, the LILO page and the AI
 * input (the Analysis v7 entry row is covered in fl7e.dashboard.test.ts). Timing and every score are unchanged.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { atBuyLimit, AT_BUY_LIMIT_PREFIX } from '../src/analysis/atBuyLimit.ts';
import { buildLiloRead, formatLiloPage, formatOptionsDecisionPage, type OptionsDecisionInput } from '../src/analysis/reportPages.ts';
import { buildBottomLineSummary, BOTTOM_LINE_TAB } from '../src/reports/bottomLine/summarySheet.ts';
import { ReportWorkbook, MemoryWorkbookBackend } from '../src/sheets/reportSheet.ts';
import { buildGeminiReport, buildGeminiPrompt, type GeminiReviewInputs } from '../src/fetch/ai/geminiReview.ts';

const TZ = 'America/New_York';
const NOW = Date.UTC(2026, 9, 30, 15);
// AQZB on 2026-10-30: zone $267–$272, price $262 (below), stop $250.
const PLAN = { timing: 'WAIT_PULLBACK', regime: 'CHOP', entryLow: 267, entryHigh: 272, entryPrice: 269.5, stop: 250, t1: { price: 300 }, t2: { price: 320 } };
const at = (price: number, over: Partial<typeof PLAN> = {}) => atBuyLimit({ ...PLAN, ...over, currentPrice: price });

describe('E1 — the at-the-buy-limit rule and label', () => {
  test('below the zone (AQZB): label with the stop and the risk at today\'s price', () => {
    const r = at(262)!;
    assert.equal(r.where, 'below');
    assert.equal(r.text, AT_BUY_LIMIT_PREFIX + 'price $262.00 is below the buy zone ($267.00–$272.00); a limit order at $269.50 would have filled. Stop $250.00, risk $12.00/share (4.6%) at today\'s price.');
  });

  test('inside the zone: at or under the entry names the entry; above it names the top of the zone', () => {
    assert.equal(at(268)!.where, 'inside');
    assert.match(at(268)!.text, /a limit order at \$269\.50 would have filled/);
    assert.match(at(271)!.text, /price \$271\.00 is inside the buy zone .*a limit order at the top of the zone \(\$272\.00\) would have filled/);
    assert.equal(at(272)!.where, 'inside', 'the top of the zone counts');
    assert.equal(at(267)!.where, 'inside', 'the bottom of the zone counts');
  });

  test('no label: above the zone, at/below the stop, other timings, missing values', () => {
    assert.equal(at(272.01), null, 'above the zone');
    assert.equal(at(280), null);
    assert.equal(at(250), null, 'at the stop');
    assert.equal(at(240), null, 'below the stop');
    assert.equal(at(262, { timing: 'BUY_NOW' }), null);
    assert.equal(at(262, { timing: 'AVOID' }), null);
    assert.equal(atBuyLimit({ ...PLAN, stop: null, currentPrice: 262 }), null);
    assert.equal(atBuyLimit({ ...PLAN, currentPrice: NaN }), null);
  });
});

describe('E1 — every report that said "wait for a pullback"', () => {
  const decision = { action: '⏳ GREAT COMPANY — SET A BUY LIMIT', finalConviction: 68 };

  test('Bottom Line: the overall line leads with the label and keeps the action and the conviction; legacy unchanged', async () => {
    const overall = async (atBuyLimitText: string | null, legacyReportText = false): Promise<string> => {
      const ss = await ReportWorkbook.open(new MemoryWorkbookBackend({}), ['*']);
      buildBottomLineSummary(ss, 'AQZB', { score: 72, verdict: 'Strong' }, PLAN, decision, null, null,
        { clock: { now: () => NOW }, timeZone: TZ, atBuyLimit: atBuyLimitText, legacyReportText });
      const tab = legacyReportText ? '📋 Bottom Line — AQZB' : BOTTOM_LINE_TAB;
      return String(ss.getSheetByName(tab)!.grid().find((r) => r[0] === '🏆 Overall Action')![1]);
    };
    const label = at(262)!.text;
    assert.equal(await overall(label), label + '  ·  Engine: ⏳ GREAT COMPANY — SET A BUY LIMIT  (Final Conviction: 68/100)');
    assert.equal(await overall(null), '⏳ GREAT COMPANY — SET A BUY LIMIT  (Final Conviction: 68/100)');
    assert.equal(await overall(label, true), '⏳ GREAT COMPANY — SET A BUY LIMIT  (Final Conviction: 68/100)', 'legacy text ignores it');
  });

  test('Options Decision: still DON\'T BUY by rule; the Why line says the stock is at the buy limit', () => {
    const exp = Math.floor(NOW / 1000) + 400 * 86400;
    const leaps = { found: true, contract: { strike: 260, expUnix: exp, delta: 0.75, bid: 60, ask: 62, iv: 0.6 } };
    const inp = (atLimit: ReturnType<typeof at>): OptionsDecisionInput => ({
      ticker: 'AQZB', leapsCall: leaps, shortTermCall: { found: false, reason: 'no chain data' }, decision, techPlan: PLAN, fund: { score: 72 },
      confluence: { entryLow: 267, entryHigh: 272, entryCount: 3 }, flow: { available: true }, nowMs: NOW, timeZone: TZ, atBuyLimit: atLimit,
    });
    const page = formatOptionsDecisionPage(inp(at(262)));
    assert.match(page, /1\. LEAPS .*: DON'T BUY/);
    assert.ok(page.includes("  Why: No new entries: the stock has no clear trend. The stock itself is ✅ AT YOUR BUY LIMIT — price $262.00 is below the buy zone"), page);
    const plain = formatOptionsDecisionPage(inp(null));
    assert.ok(!plain.includes('AT YOUR BUY LIMIT'));
    assert.ok(plain.includes('  Why: No new entries: the stock has no clear trend.\n'));
  });

  test('LILO page: the label under the buy zone', () => {
    const lilo = buildLiloRead({ entryLow: 267, entryHigh: 272, entryCount: 3 }, PLAN, decision);
    const page = formatLiloPage('AQZB', lilo, { optionsRun: false, atBuyLimit: at(262) });
    const lines = page.split('\n');
    const z = lines.indexOf('2. BUY ZONE');
    assert.ok(z > 0);
    assert.equal(lines[z + 2], '  ' + at(262)!.text);
    assert.ok(!formatLiloPage('AQZB', lilo, { optionsRun: false }).includes('AT YOUR BUY LIMIT'));
  });

  test('AI input: the label and "do not say wait for a pullback" in report.technical; absent without it (legacy JSON unchanged)', async () => {
    const base = {
      ticker: 'AQZB', fundResult: { score: 72 }, techPlan: PLAN, decision, ind: {}, fund: null, chart: { currentPrice: 262 }, optAnalysis: null,
    } as unknown as GeminiReviewInputs;
    const noMacro = () => null;
    const withLabel = await buildGeminiReport({ ...base, atBuyLimit: at(262)!.text }, noMacro);
    assert.ok(String(withLabel.technical.atBuyLimit).startsWith(at(262)!.text));
    assert.match(String(withLabel.technical.atBuyLimit), /do NOT tell the reader to wait for a pullback/);
    assert.ok(buildGeminiPrompt('AQZB', withLabel).includes('AT YOUR BUY LIMIT'));
    const without = await buildGeminiReport(base, noMacro);
    assert.equal('atBuyLimit' in without.technical, false);
    assert.equal(withLabel.technical.timing, 'WAIT_PULLBACK', 'timing is unchanged');
  });
});
