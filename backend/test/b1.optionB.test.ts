/**
 * Fix plan 2026-10-30 B1, owner-approved option B (docs/models/results/targets-test.md).
 *  1. Display only: "Next resistance: $X (+Y%, methods) · R:R to it Z" -- the nearest valid cluster at least 1 ATR above
 *     the entry -- next to T1 in the Bottom Line, the Options Decision exit plan, the LILO page and the AI input (the
 *     Analysis v7 row is covered in fl7e.dashboard.test.ts). T1, its R:R, the conviction and the R:R gate are unchanged.
 *  2. The T2 bug: clusterBeyond read methods the confluence had excluded (TSLA T2 $2,187, AMD T2 $6,701).
 *     ExitTargetOptions.fixedT2 skips them. It stays OFF (LILO was 70-77 points worse in 2010-2019 with it on); the
 *     reports show "T2 (fixed): $X" next to today's T2 instead.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveExitTargets, validExitMethods } from '../src/analysis/techPlan/entryPlan.ts';
import type { ConfluenceMethod, ConfluenceTargets } from '../src/analysis/confluence.ts';
import { nextResistance, NEXT_RESISTANCE_PREFIX, fixedT2Display, FIXED_T2_PREFIX } from '../src/analysis/nextResistance.ts';
import { buildLiloRead, formatLiloPage, formatOptionsDecisionPage, type OptionsDecisionInput } from '../src/analysis/reportPages.ts';
import { buildBottomLineSummary, BOTTOM_LINE_TAB } from '../src/reports/bottomLine/summarySheet.ts';
import { ReportWorkbook, MemoryWorkbookBackend } from '../src/sheets/reportSheet.ts';
import { buildGeminiReport, buildGeminiPrompt, type GeminiReviewInputs } from '../src/fetch/ai/geminiReview.ts';

const m = (name: string, price: number, excluded = false): ConfluenceMethod => ({ name, price, type: 'target', ...(excluded ? { excluded: true, exclusionReason: 'beyond the 2.5x ceiling' } : {}) });

/** Entry 100, ATR 5. The biggest cluster (150-155) is T1; a small valid one sits at 110-112; 104 and 200 are excluded. */
function confluence(extra: ConfluenceMethod[] = []): ConfluenceTargets {
  const all = [m('A', 104, true), m('B', 110), m('C', 112), m('D', 150), m('E', 152), m('F', 155), m('G', 200, true), ...extra];
  return {
    entryLow: 98, entryHigh: 102, entryCenter: 100, entryConfidence: 'x', entryCount: 2, entryMethods: [], allEntryMethods: [],
    exitLow: 150, exitHigh: 155, exitCenter: 152.33333333333334, exitConfidence: 'x', exitCount: 3, exitMethods: all.filter((x) => ['D', 'E', 'F'].includes(x.name)), allExitMethods: all,
  };
}

describe('B1 option B part 2 — T2 skips the methods the confluence excluded (fixedT2)', () => {
  test('today: T2 comes from the excluded method G; fixedT2: no T2 when only excluded methods lie beyond T1', () => {
    assert.deepEqual(deriveExitTargets(confluence(), 5, 100).t2?.basis, ['G']);
    const f = deriveExitTargets(confluence(), 5, 100, { fixedT2: true });
    assert.deepEqual(f.t1.basis, ['D', 'E', 'F'], 'T1 unchanged');
    assert.equal(f.t2, null);
  });

  test('fixedT2: T2 = the next VALID cluster beyond T1', () => {
    const c = confluence([m('H', 180), m('I', 185)]);
    assert.deepEqual(deriveExitTargets(c, 5, 100).t2?.basis, ['H', 'I']);
    const f = deriveExitTargets(confluence([m('H', 210), m('I', 214)]), 5, 100, { fixedT2: true });
    assert.deepEqual(f.t2?.basis, ['H', 'I']);
    assert.equal(f.t2?.price, 212);
    assert.deepEqual(deriveExitTargets(confluence([m('H', 210), m('I', 214)]), 5, 100).t2?.basis, ['G', 'H', 'I'], 'today the excluded 200 anchors T2');
  });

  test('fixedT2 also keeps excluded methods out of a T1 promoted from T2 (the promotion loop uses the same pool)', () => {
    // T1 = {D} at 101, under 1 ATR above the entry 100 -> promoted. Today it promotes the excluded X at 120.
    const all = [m('D', 101), m('X', 120, true), m('Y', 130), m('Z', 160)];
    const c: ConfluenceTargets = { ...confluence(), allExitMethods: all, exitMethods: [all[0]!], exitLow: 101, exitHigh: 101, exitCenter: 101, exitCount: 1 };
    const today = deriveExitTargets(c, 5, 100);
    assert.deepEqual(today.t1.basis, ['X']);
    const f = deriveExitTargets(c, 5, 100, { fixedT2: true });
    assert.deepEqual(f.t1.basis, ['Y']);
    assert.equal(f.t1.promoted, true);
    assert.deepEqual(f.t2?.basis, ['Z']);
  });

  test('validExitMethods drops excluded and price-less methods', () => {
    const c = confluence([{ name: 'N', price: null, type: 'target' }]);
    assert.deepEqual(validExitMethods(c).map((x) => x.name), ['B', 'C', 'D', 'E', 'F']);
  });
});

describe('B1 option B part 1 — the next resistance (display only)', () => {
  const nr = (over: Record<string, unknown> = {}) => nextResistance({ confluence: confluence(), atr: 5, entryPrice: 100, stop: 92.5, currentPrice: 105, t1Price: 152.33, ...over });

  test('the nearest valid cluster at least 1 ATR above the entry, its % from today\'s price, its methods and the R:R to it', () => {
    const r = nr()!;
    assert.equal(r.price, 111);
    assert.deepEqual(r.methods, ['B', 'C']);
    assert.equal(r.rr!.toFixed(4), (11 / 7.5).toFixed(4));
    assert.equal(r.text, 'Next resistance: $111.00 (+6%, B, C) · R:R to it 1.47');
    assert.ok(r.text.startsWith(NEXT_RESISTANCE_PREFIX));
  });

  test('the same level as T1 -> null (nothing to add); no stop -> R:R "—"; nothing above the floor or no entry -> null', () => {
    assert.equal(nr({ t1Price: 111 }), null);
    assert.match(nr({ stop: null })!.text, /R:R to it —$/);
    assert.equal(nr({ entryPrice: 200 }), null, 'no valid method 1 ATR above an entry of 200');
    assert.equal(nr({ entryPrice: null }), null);
    assert.equal(nr({ confluence: null }), null);
  });

  test('T1 (the biggest cluster) is untouched: the next resistance is computed beside it, never instead of it', () => {
    const c = confluence();
    const before = deriveExitTargets(c, 5, 100);
    nr({ confluence: c });
    assert.deepEqual(deriveExitTargets(c, 5, 100), before);
    assert.deepEqual(before.t1.basis, ['D', 'E', 'F']);
  });
});

describe('B1 option B part 1 — where it is shown', () => {
  const TZ = 'America/New_York';
  const NOW = Date.UTC(2026, 9, 30, 15);
  const PLAN = { timing: 'WAIT_PULLBACK', regime: 'CHOP', entryLow: 98, entryHigh: 102, entryPrice: 100, stop: 92.5, t1: { price: 152.33 }, t2: { price: 200 }, rrToT1: 7.0, rrToT1AtSpot: 6.2 };
  const decision = { action: '⏳ GREAT COMPANY — SET A BUY LIMIT', finalConviction: 68 };
  const NR = nextResistance({ confluence: confluence(), atr: 5, entryPrice: 100, stop: 92.5, currentPrice: 105, t1Price: 152.33 })!;

  test('Bottom Line: one 🧱 line after the R:R lines; the R:R lines still read T1; legacy text has none', async () => {
    const grid = async (legacyReportText: boolean, text: string | null = NR.text): Promise<unknown[][]> => {
      const ss = await ReportWorkbook.open(new MemoryWorkbookBackend({}), ['*']);
      buildBottomLineSummary(ss, 'TSLA', { score: 72, verdict: 'Strong' }, PLAN, decision, null, null,
        { clock: { now: () => NOW }, timeZone: TZ, nextResistance: text, legacyReportText });
      return ss.getSheetByName(legacyReportText ? '📋 Bottom Line — TSLA' : BOTTOM_LINE_TAB)!.grid();
    };
    const g = await grid(false);
    const i = g.findIndex((r) => r[0] === '🧱 Next resistance');
    assert.ok(i > 0);
    assert.equal(g[i]![1], '$111.00 (+6%, B, C) · R:R to it 1.47  (T1 stays the plan\'s target)');
    assert.equal(g[i - 1]![0], '📍 R:R at today\'s price');
    assert.match(String(g[i - 1]![1]), /^T1 R:R 6\.20 \(vs 7\.00 at the \$100\.00 ladder entry\)$/);
    assert.ok(!(await grid(false, null)).some((r) => r[0] === '🧱 Next resistance'));
    assert.ok(!(await grid(true)).some((r) => r[0] === '🧱 Next resistance'));
  });

  test('Options Decision: one line under each exit plan; the plan still sells at T1 / T2', () => {
    const exp = Math.floor(NOW / 1000) + 400 * 86400;
    const leaps = { found: true, contract: { strike: 100, expUnix: exp, delta: 0.75, bid: 20, ask: 21, iv: 0.6 } };
    const inp = (n: typeof NR | null): OptionsDecisionInput => ({
      ticker: 'TSLA', leapsCall: leaps, shortTermCall: { found: false, reason: 'no chain data' }, decision, techPlan: PLAN, fund: { score: 72 },
      confluence: { entryLow: 98, entryHigh: 102, entryCount: 2 }, flow: { available: true }, nowMs: NOW, timeZone: TZ, nextResistance: n,
    });
    const page = formatOptionsDecisionPage(inp(NR));
    const lines = page.split('\n');
    const plan = lines.indexOf('  Exit plan:');
    assert.match(lines[plan + 1]!, /Sell about a third at T1 \(stock at \$152\.33\), a third at T2 \(stock at \$200\.00\)/);
    assert.equal(lines[plan + 3], '  - ' + NR.text + ' (shown only; the plan above stays at T1 / T2).');
    assert.ok(!formatOptionsDecisionPage(inp(null)).includes('Next resistance'));
  });

  test('LILO page: one line under the sell rungs, which stay at T1 / T2', () => {
    const lilo = buildLiloRead({ entryLow: 98, entryHigh: 102, entryCount: 2 }, PLAN, decision);
    const lines = formatLiloPage('TSLA', lilo, { optionsRun: false, nextResistance: NR }).split('\n');
    const s = lines.indexOf('4. SELL RUNGS (limit sells)');
    assert.match(lines[s + 1]!, /^ {2}T1: sell \d+% of the position at \$152\.33$/);
    assert.match(lines[s + 2]!, /^ {2}T2: sell \d+% of the position at \$200\.00$/);
    assert.equal(lines[s + 3], '  ' + NR.text + ' (shown only; the sell rungs stay at T1 / T2)');
    assert.ok(!formatLiloPage('TSLA', lilo, { optionsRun: false }).includes('Next resistance'));
  });

  test('AI input: report.technical.nextResistance and the KEY NUMBERS rule; exitT1 / rrToT1 unchanged; absent without it', async () => {
    const base = {
      ticker: 'TSLA', fundResult: { score: 72 }, techPlan: PLAN, decision, ind: {}, fund: null, chart: { currentPrice: 105 }, optAnalysis: null,
    } as unknown as GeminiReviewInputs;
    const noMacro = () => null;
    const r = await buildGeminiReport({ ...base, nextResistance: NR.text }, noMacro);
    assert.equal(r.technical.nextResistance, NR.text);
    assert.equal(r.technical.exitT1, 152.33);
    assert.equal(r.technical.rrToT1, 7);
    const prompt = buildGeminiPrompt('TSLA', r);
    assert.ok(prompt.includes('In KEY NUMBERS add, right after Target 1, the line "' + NR.text + '" exactly as given.'));
    const without = await buildGeminiReport(base, noMacro);
    assert.equal('nextResistance' in without.technical, false);
    assert.ok(!buildGeminiPrompt('TSLA', without).includes('NEXT RESISTANCE'));
  });
});

describe('B1 option B part 2 — kept display only: "T2 (fixed)" next to today\'s T2 (LILO was worse with it on, targets-test.md)', () => {
  const TZ = 'America/New_York';
  const NOW = Date.UTC(2026, 9, 30, 15);
  const decision = { action: '⏳ GREAT COMPANY — SET A BUY LIMIT', finalConviction: 68 };

  test('production default is today\'s T2: deriveExitTargets without options still reads the excluded method', () => {
    assert.equal(deriveExitTargets(confluence(), 5, 100).t2?.price, 200);
  });

  test('fixedT2Display: the valid T2 when it differs, "none" when only excluded methods were beyond T1, null when the same', () => {
    const none = fixedT2Display({ confluence: confluence(), atr: 5, entryPrice: 100, t2Price: 200 })!;
    assert.equal(none.price, null);
    assert.equal(none.text, FIXED_T2_PREFIX + 'none (the T2 shown comes only from methods the zones excluded)');
    const c = confluence([m('H', 210), m('I', 214)]);
    const today = deriveExitTargets(c, 5, 100).t2!.price;
    const f = fixedT2Display({ confluence: c, atr: 5, entryPrice: 100, t2Price: today })!;
    assert.equal(f.text, 'T2 (fixed): $212.00 (excluded methods skipped; from H, I)');
    const same = confluence([m('H', 180), m('I', 185)]);
    assert.equal(fixedT2Display({ confluence: same, atr: 5, entryPrice: 100, t2Price: deriveExitTargets(same, 5, 100).t2!.price }), null);
    assert.equal(fixedT2Display({ confluence: null, atr: 5, entryPrice: 100, t2Price: 200 }), null);
  });

  const PLAN = { timing: 'WAIT_PULLBACK', regime: 'CHOP', entryLow: 98, entryHigh: 102, entryPrice: 100, stop: 92.5, t1: { price: 152.33 }, t2: { price: 204.67 }, rrToT1: 7.0, rrToT2: 14.6 };
  const FX = fixedT2Display({ confluence: confluence([m('H', 210), m('I', 214)]), atr: 5, entryPrice: 100, t2Price: 204.67 })!;

  test('LILO page: under the T2 rung, which stays at today\'s T2', () => {
    const lilo = buildLiloRead({ entryLow: 98, entryHigh: 102, entryCount: 2 }, PLAN, decision);
    const lines = formatLiloPage('AMD', lilo, { optionsRun: false, fixedT2: FX }).split('\n');
    const s = lines.indexOf('4. SELL RUNGS (limit sells)');
    assert.match(lines[s + 2]!, /^ {2}T2: sell \d+% of the position at \$204\.67$/);
    assert.equal(lines[s + 3], '  ' + FX.text + ' (shown only; the T2 rung stays as above)');
  });

  test('Options Decision: under the LEAPS exit plan, which still sells at today\'s T2', () => {
    const exp = Math.floor(NOW / 1000) + 400 * 86400;
    const page = formatOptionsDecisionPage({
      ticker: 'AMD', leapsCall: { found: true, contract: { strike: 100, expUnix: exp, delta: 0.75, bid: 20, ask: 21, iv: 0.6 } }, shortTermCall: { found: false, reason: 'no chain data' },
      decision, techPlan: PLAN, fund: { score: 72 }, confluence: { entryLow: 98, entryHigh: 102, entryCount: 2 }, flow: { available: true }, nowMs: NOW, timeZone: TZ, fixedT2: FX,
    });
    const lines = page.split('\n');
    const plan = lines.indexOf('  Exit plan:');
    assert.match(lines[plan + 1]!, /a third at T2 \(stock at \$204\.67\)/);
    assert.equal(lines[plan + 3], '  - ' + FX.text + ' (shown only; the plan above sells at T2).');
  });

  test('AI input: technical.exitT2Fixed and the KEY NUMBERS rule; exitT2 unchanged; absent without it', async () => {
    const base = { ticker: 'AMD', fundResult: { score: 72 }, techPlan: PLAN, decision, ind: {}, fund: null, chart: { currentPrice: 105 }, optAnalysis: null } as unknown as GeminiReviewInputs;
    const r = await buildGeminiReport({ ...base, fixedT2: FX.text }, () => null);
    assert.equal(r.technical.exitT2, 204.67);
    assert.equal(r.technical.exitT2Fixed, FX.text);
    assert.ok(buildGeminiPrompt('AMD', r).includes('In KEY NUMBERS add, right after Target 2, the line "' + FX.text + '" exactly as given.'));
    assert.equal('exitT2Fixed' in (await buildGeminiReport(base, () => null)).technical, false);
  });
});
