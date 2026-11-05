/**
 * FL-7i: the Bottom Line tab and the pedagogical-report helpers (pm, fundDriverContext,
 * techIndicatorRows, bottomLine, renderAiReview, scoreBar), against the oracle.
 * Return values (or thrown messages), recorded sheet calls and cells are compared;
 * coverage guards make a never-reached branch fail the test.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadOracle, legacyFilesPresent, LEGACY_DIR, ORACLE_FILES } from './oracle.ts';
import { withOracleGlobals } from './oracleGlobals.ts';
import { pinnedDateClass } from './pinnedDate.ts';
import { ReportWorkbook, MemoryWorkbookBackend } from '../src/sheets/reportSheet.ts';
import { pm, fundDriverContext, techIndicatorRows, bottomLine, renderAiReview, scoreBar } from '../src/reports/bottomLine/helpers.ts';
import { buildBottomLineSummary, BOTTOM_LINE_TAB_PREFIX, BOTTOM_LINE_TAB, bottomLineTabName } from '../src/reports/bottomLine/summarySheet.ts';

const ready = legacyFilesPresent();
const TZ = 'America/New_York';
const NOW = Date.parse('2026-10-23T15:00:00Z');
const LEG = ready ? fs.readFileSync(path.join(LEGACY_DIR, 'fullStockAnalysisV10_9.gs'), 'utf8').split('\n') : [];
const oracle = () => loadOracle();

async function inZone<T>(tz: string, fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try { return await fn(); } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
}

type Outcome = { value: unknown } | { threw: string };
const outcome = (fn: () => unknown): Outcome => {
  try { return { value: fn() }; } catch (e) { return { threw: (e as Error).message }; }
};

/** Port and legacy on the same arguments: same value, or the same thrown message. Returns the legacy outcome. */
function same(name: string, port: (...a: any[]) => unknown, args: unknown[]): Outcome {
  const exp = outcome(() => oracle().callNormalized(name, ...args));
  const got = outcome(() => port(...args));
  assert.deepStrictEqual(got, exp, name + ' ' + JSON.stringify(args));
  return exp;
}
const val = (o: Outcome): any => { assert.ok('value' in o, 'expected a value, got ' + JSON.stringify(o)); return (o as { value: unknown }).value; };

describe('FL-7i -- legacy boundaries', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('every ported range starts and ends where the port says', () => {
    const ranges: Array<[string, number, number, string]> = [
      ['buildBottomLineSummaryV7', 5326, 5438, 'function '], ['pmV7_', 8827, 8832, 'function '], ['fundDriverContextV7_', 8835, 8845, 'function '],
      ['techIndicatorRowsV7_', 8848, 8858, 'function '], ['bottomLineV7_', 8861, 8874, 'function '], ['renderAiReviewV7_', 8878, 8895, 'function '],
      ['scoreBar', 8988, 8988, 'function '],
    ];
    for (const [name, a, b, pre] of ranges) {
      assert.ok(LEG[a - 1].startsWith(pre + name + '('), name + ' starts at ' + a + ': ' + LEG[a - 1]);
      assert.ok(LEG[b - 1].trimEnd().endsWith('}'), name + ' ends at ' + b);
      if (a !== b) assert.equal(LEG[b - 1], '}', name + ' closes at column 0');
      assert.ok(LEG[b].trim() === '' || LEG[b].startsWith('//') || LEG[b].startsWith('function') || LEG[b].startsWith('const'), name + ' is followed by a boundary at ' + (b + 1) + ': ' + LEG[b]);
    }
  });

  test('F-I1: pm, fundDriverContext, techIndicatorRows and bottomLine have no caller anywhere in the legacy code', () => {
    const all = ORACLE_FILES.map((f) => fs.readFileSync(path.join(LEGACY_DIR, f), 'utf8')).join('\n');
    for (const n of ['pmV7_', 'fundDriverContextV7_', 'techIndicatorRowsV7_', 'bottomLineV7_']) {
      assert.equal((all.match(new RegExp('\\b' + n + '\\(', 'g')) ?? []).length, 1, n + ' occurs only as its definition');
    }
    assert.equal((all.match(/\brenderAiReviewV7_\(/g) ?? []).length, 2, 'renderAiReviewV7_: its definition and one caller');
  });
});

describe('FL-7i -- pure helpers against the oracle', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('pm: every branch, coercions included', () => {
    const marks = new Set<string>(), tags = new Set<string>();
    for (const p of [null, undefined, NaN, 'abc', '5', '-5', '', 0, -0, 0.001, -0.001, 0.0011, -0.0011, 1.234, -2.5, 1e-9, true, false, Infinity, -Infinity, [], {}]) {
      const v = val(same('pmV7_', pm, [p]));
      marks.add(v.mark); tags.add(v.s);
    }
    assert.deepStrictEqual([...marks].sort(), ['•', '⚠', '✓'].sort());
    assert.ok(tags.has('n/a') && tags.has('0.00') && tags.has('+1.23') && tags.has('−2.50'), [...tags].join());
  });

  test('fundDriverContext: all 8 branches x 3 signs, label precedence, odd labels', () => {
    const labels = ['Revenue growth', 'Operating margin', 'Rule of 40', 'Profitability', 'Quality score', 'Valuation vs peers', 'Peer multiple', 'Analyst targets', 'P/E ratio', 'PEG', 'Something else',
      'Growth margin', 'Quality margin', 'Rule of 40 growth', 'Peer P/E', 'Analyst P/E', 'PEG valuation', 'GROWTH', '', null, undefined, 0];
    const sentences = new Set<string>();
    for (const l of labels) for (const p of [2, -2, 0, 0.001, -0.001, undefined, null, NaN, '1']) {
      const s = val(same('fundDriverContextV7_', fundDriverContext, [l, p])) as string;
      if (l !== null && l !== undefined && l !== 0 && l !== '' && [2, -2, 0].includes(p as number)) sentences.add(s);
    }
    assert.equal(sentences.size, 24, 'each of the 8 context lines in its 3 sign variants');
  });

  test('techIndicatorRows: every threshold edge, every note, the optional relative-strength row, and bad input', () => {
    const base = { rsi14: 50, histogram: 0.5, adx14: 22, atr14: 3.14159, stochK: 50, mfi14: 50, rs: { rs63: 2 } };
    const notes = new Set<string>(), counts = new Set<number>();
    const sweep: Record<string, unknown[]> = {
      rsi14: [0, 10, 29.99, 30, 44.99, 45, 50, 55, 55.01, 70, 70.01, 100],
      histogram: [1, -1, 0, 0.004, -0.004],
      adx14: [10, 19.99, 20, 22, 25, 25.01, 40],
      atr14: [0, 0.005, 3.14159, 100],
      stochK: [0, 19.99, 20, 50, 80, 80.01, 100],
      mfi14: [0, 19.99, 20, 50, 80, 80.01, 100],
      rs: [null, undefined, { rs63: 5.55 }, { rs63: -3.25 }, { rs63: 0 }, { rs63: -0.04 }],
    };
    for (const [k, values] of Object.entries(sweep)) for (const v of values) {
      const rows = val(same('techIndicatorRowsV7_', techIndicatorRows, [{ ...base, [k]: v }])) as Array<{ note: string }>;
      counts.add(rows.length);
      rows.forEach((r) => notes.add(r.note));
    }
    assert.equal(notes.size, 5 + 2 + 3 + 1 + 3 + 3 + 2, 'every distinct note was produced');
    assert.deepStrictEqual([...counts].sort(), [6, 7]);
    for (const bad of [{}, { ...base, rsi14: '50' }, { ...base, rs: {} }, { ...base, rs: { rs63: 'x' } }, { ...base, histogram: undefined }, { ...base, atr14: null }]) {
      assert.ok('threw' in same('techIndicatorRowsV7_', techIndicatorRows, [bad]), 'bad input throws in both: ' + JSON.stringify(bad));
    }
  });

  test('bottomLine: conviction x score, every pricey path, regime x timing x options, bad input', () => {
    const conv = new Set<string>(), text = new Set<string>();
    const run = (fund: unknown, tech: unknown, dec: unknown, opts: unknown): any => val(same('bottomLineV7_', bottomLine as never, ['ACME', fund, tech, dec, opts]));
    const tech0 = { regime: 'TREND_UP', timing: 'BUY_NOW' };
    for (const fc of [100, 90, 67, 66.99, 60, 50, 49.99, 40, 33, 32.99, 10, 0, -5, undefined, null, '67', '50', 'x']) {
      for (const sc of [null, undefined, 100, 80, 57, 56.99, 50, 43, 42.99, 12.5, 0]) {
        const r = run({ score: sc, drivers: [] }, tech0, { action: 'BUY', finalConviction: fc }, undefined);
        conv.add(r.convWord); text.add(r.text.match(/is (an unrated|a solid|a mixed-quality|a weak) business/)![1]);
      }
    }
    assert.deepStrictEqual([...conv].sort(), ['High', 'Low', 'Moderate', 'Very Low']);
    assert.equal(text.size, 4);
    // valuation: pricedForPerfection, each driver regex only when negative, and the non-pricey cases
    const rich = (d: unknown, pfp?: unknown): boolean => run({ score: 60, drivers: d, pricedForPerfection: pfp }, tech0, { action: 'BUY', finalConviction: 70 }, null).text.includes('at a rich (expensive) price');
    assert.equal(rich([], true), true);
    assert.equal(rich([{ label: 'P/E ratio', points: -1 }]), true);
    assert.equal(rich([{ label: 'PEG', points: -0.1 }]), true);
    assert.equal(rich([{ label: 'Valuation vs peers', points: -2 }]), true);
    assert.equal(rich([{ label: 'valuation', points: 0 }]), false);
    assert.equal(rich([{ label: 'p/e', points: 1 }]), false);
    assert.equal(rich([{ label: 'Margin', points: -3 }]), false);
    assert.equal(rich([{ label: 'Peer valuation', points: undefined }]), false);
    assert.equal(rich([{ points: -1 }]), false);
    assert.equal(rich(undefined), false);
    assert.equal(rich(null), false);
    // regime x timing x options
    const frag = new Set<string>();
    for (const regime of ['TREND_UP', 'TREND_DOWN', 'CHOP', 'HIGH_VOL', undefined]) for (const timing of ['BUY_NOW', 'WAIT_PULLBACK', 'AVOID', undefined]) {
      for (const opts of [undefined, null, { available: false }, { available: true, confirm: 'confirm' }, { available: true, confirm: 'conflict' }, { available: true, confirm: 'neutral' }, { available: true }]) {
        const t: string = run({ score: 50 }, { regime, timing }, { action: 'HOLD', finalConviction: 40 }, opts).text;
        for (const f of ['trending up', 'trending down', 'moving sideways', 'a good time to buy', 'better to wait for a dip', 'a poor time to buy', 'No options data was loaded', 'lean the SAME way', 'lean the OTHER way', 'roughly neutral']) if (t.includes(f)) frag.add(f);
      }
    }
    assert.equal(frag.size, 10, [...frag].join());
    assert.ok('threw' in same('bottomLineV7_', bottomLine as never, ['X', null, {}, {}, null]), 'null fundResult throws');
    assert.ok('threw' in same('bottomLineV7_', bottomLine as never, ['X', {}, {}, null, null]), 'null decision throws');
    assert.ok('threw' in same('bottomLineV7_', bottomLine as never, ['X', {}, null, {}, null]), 'null techPlan throws');
    // F-I4
    assert.match(run({ score: 50 }, {}, { action: 'HOLD' }, null).text, /confidence undefined\/100 \(Very Low\)\.$/);
  });

  test('renderAiReview: markdown, headers, bullets, CRLF, long text, fallback row, non-string input', () => {
    const longText = Array.from({ length: 400 }, (_, i) => (i % 40 === 0 ? 'SECTION ' + i + ':' : i % 7 === 0 ? '- point number ' + i + ' with some **bold** and `code`' : 'A plain sentence number ' + i + ' that goes on a little while.')).join('\n');
    const texts: unknown[] = [
      '## Verdict\n**BUY**: ok\n- a point\n* star\n• dot\nplain text here\nA\nAB',
      'KEY TAKEAWAYS\r\nRisks:\r\n  - x  \r\n1. Foo:\r\nQ&A:\r\nWhat\'s next?\r\nrisks:\r\n2024 OUTLOOK\r\n',
      '# Title\n### Sub: heading\n*italic* start\n**BOLD HEADER**\n`CODE`\n- \n-no space\n•  spaced bullet',
      'a'.repeat(60) + ':', 'A'.repeat(52), 'A'.repeat(51) + ':', 'B' + 'x'.repeat(50) + ':', 'B' + 'x'.repeat(51) + ':',
      'Header with-dash:', 'Header_underscore:', 'AAPL', 'NVDA: strong', 'TOTAL RETURN (1Y):', longText,
      '', '   ', '\n\n', ' \r\n \t ', undefined, null, 123, 0, true, ['a', 'b'], {}, '\u00a0nbsp line',
    ];
    const kinds = new Set<string>();
    for (const t of texts) {
      const rows = val(same('renderAiReviewV7_', renderAiReview, [t])) as Array<{ text: string[]; meta: { bold?: boolean; wrap?: boolean } }>;
      for (const r of rows) kinds.add(r.meta.bold ? 'header' : r.text[0].startsWith('   • ') ? 'bullet' : 'plain');
    }
    assert.deepStrictEqual([...kinds].sort(), ['bullet', 'header', 'plain']);
    // the fallback row (no line survives): one wrapped row holding the cleaned text
    const fb = val(same('renderAiReviewV7_', renderAiReview, ['  \n \n'])) as Array<{ text: string[] }>;
    assert.equal(fb.length, 1);
    assert.equal(fb[0].text[0], '  \n \n');
    // F-I3
    assert.equal(val(same('renderAiReviewV7_', renderAiReview, [undefined]))[0].text[0], 'undefined');
    assert.equal(val(same('renderAiReviewV7_', renderAiReview, [null]))[0].text[0], 'null');
    // markdown is stripped and long text keeps one row per non-empty line
    const long = val(same('renderAiReviewV7_', renderAiReview, [longText])) as unknown[];
    assert.equal(long.length, 400);
  });

  test('scoreBar: rounding, clamping, and the NaN-like inputs that give an empty bar (F-I2)', () => {
    const lengths = new Set<number>(), empties: unknown[] = [];
    for (const s of [NaN, undefined, null, '55', '', 'abc', ' 7 ', -5, 0, 4.49, 4.5, 5, 5.5, 14.9, 15, 49.99, 50, 94.99, 95, 99.9, 100, 150, Infinity, -Infinity, true, false, [], [5], {}]) {
      const v = val(same('scoreBar', scoreBar, [s])) as string;
      lengths.add(v.length);
      if (v === '') empties.push(s);
    }
    assert.deepStrictEqual([...lengths].sort((a, b) => a - b), [0, 10]);
    assert.ok(empties.length >= 4, 'NaN-like inputs give an empty bar (NaN, undefined, "abc", {})');
    const filled = new Set<number>();
    for (let s = 0; s <= 100; s += 0.5) filled.add([...(val(same('scoreBar', scoreBar, [s])) as string)].filter((c) => c === '█').length);
    assert.deepStrictEqual([...filled].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

// ---- the Bottom Line tab ----

const base = {
  techScore: 61, timing: 'BUY_NOW', regime: 'TREND_UP', atr14: 2.5, stop: 90, entryPrice: 100, entryCount: 3, entryLow: 90, entryHigh: 99,
  t1: { price: 120 }, t2: { price: 130 }, rrToT1: 1.2, rrToT1AtSpot: 1.8, secular: { verdict: 'BUY', why: 'long runway' },
};
const pickOk = { found: true, contract: { strike: 150.5, expUnix: 1800000000, delta: 0.512, iv: 0.4567 } };
const pickNoIv = { found: true, contract: { strike: 140, expUnix: 1790000000, delta: 0.3, iv: 0 } };

interface Scenario { name: string; ticker: string; fund: any; tech: any; decision: any; leaps: any; short: any; existing?: boolean; throws?: boolean }
const SCENARIOS: Scenario[] = [
  { name: 'full-no-conflict', ticker: 'ACME', fund: { score: 72, verdict: 'STRONG' }, tech: base, decision: { action: 'BUY', finalConviction: 74 }, leaps: pickOk, short: pickOk },
  { name: 'full-on-existing-tab', ticker: 'ACME', fund: { score: 72, verdict: 'STRONG' }, tech: base, decision: { action: 'BUY', finalConviction: 74 }, leaps: pickOk, short: pickOk, existing: true },
  { name: 'wait-conflict-marginal-rr', ticker: 'BRK.B', fund: { score: 55, verdict: 'FAIR' }, tech: { ...base, timing: 'WAIT_PULLBACK', rrToT1: 0.8, rrToT1AtSpot: 0.5 }, decision: { action: 'WAIT', finalConviction: 41 }, leaps: pickNoIv, short: pickNoIv },
  { name: 'avoid-conflict-zero-scores', ticker: 'ZERO', fund: { score: 0 }, tech: { ...base, timing: 'AVOID', techScore: 0, rrToT1: 1.49, rrToT1AtSpot: 0.99 }, decision: { action: 'HOLD', finalConviction: 0 }, leaps: pickOk, short: pickOk },
  { name: 'all-unavailable', ticker: 'NONE', fund: null, tech: {}, decision: null, leaps: null, short: undefined },
  { name: 'exit-only-ladder', ticker: 'EXIT', fund: { score: 60, verdict: 'OK' }, tech: { ...base, entryCount: 0, t2: undefined, rrToT1: null, rrToT1AtSpot: null }, decision: { action: 'BUY', finalConviction: 60 }, leaps: null, short: null },
  { name: 'entry-only-ladder-no-entry-price', ticker: 'ENTRY', fund: { score: 60 }, tech: { ...base, entryCount: 1, t1: undefined, t2: undefined, entryPrice: null, rrToT1: 2.5, rrToT1AtSpot: 3 }, decision: { action: 'BUY', finalConviction: 60 }, leaps: null, short: null },
  { name: 'no-rungs', ticker: 'NORUNG', fund: { score: 60 }, tech: { ...base, entryCount: undefined, t1: undefined, t2: undefined, rrToT1: undefined, rrToT1AtSpot: undefined, stop: null }, decision: { action: 'BUY', finalConviction: 60 }, leaps: null, short: null },
  { name: 'ladder-error-swallowed', ticker: 'LILO', fund: { score: 60 }, tech: { ...base, t1: { price: 'x' } }, decision: { action: 'BUY', finalConviction: 60 }, leaps: null, short: null },
  { name: 'picks-not-found', ticker: 'NF', fund: { score: 60 }, tech: base, decision: { action: 'BUY', finalConviction: 60 }, leaps: { found: false, reason: 'no chain data returned for NF' }, short: { found: false } },
  { name: 'strong-rr-no-gate', ticker: 'RR', fund: { score: 60 }, tech: { ...base, rrToT1: 2, rrToT1AtSpot: 3 }, decision: { action: 'BUY', finalConviction: 60 }, leaps: null, short: null },
  { name: 'F-I5-null-rrToT1-throws', ticker: 'BUG', fund: { score: 60 }, tech: { ...base, rrToT1: null, rrToT1AtSpot: 1.1 }, decision: { action: 'BUY', finalConviction: 60 }, leaps: null, short: null, throws: true },
  { name: 'null-techPlan-throws', ticker: 'NOPLAN', fund: { score: 60 }, tech: null, decision: { action: 'BUY', finalConviction: 60 }, leaps: null, short: null, throws: true },
  { name: 'null-techPlan-throws-existing', ticker: 'NOPLAN', fund: null, tech: null, decision: null, leaps: null, short: null, throws: true, existing: true },
];

describe('FL-7i -- buildBottomLineSummary against the oracle', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('every scenario: thrown message, call log, cells and tab list are identical', async () => {
    const deps = { clock: { now: () => NOW }, timeZone: TZ, legacyReportText: true };
    const seen: string[] = [];
    const threw: string[] = [];
    await inZone(TZ, async () => {
      for (const s of SCENARIOS) {
        const tab = BOTTOM_LINE_TAB_PREFIX + s.ticker;
        const initial = s.existing
          ? { [tab]: [['old header', 'x', 'y'], [1, 2, 3], [4, 5, 6]], Other: [['k']] }
          : { Other: [['k']] };
        const L = await ReportWorkbook.open(new MemoryWorkbookBackend(initial as never), ['*']);
        const P = await ReportWorkbook.open(new MemoryWorkbookBackend(initial as never), ['*']);
        let lerr: string | null = null, perr: string | null = null;
        try {
          withOracleGlobals({ Date: pinnedDateClass(NOW) }, () => oracle().call('buildBottomLineSummaryV7', L, s.ticker, s.fund, s.tech, s.decision, s.leaps, s.short));
        } catch (e) { lerr = (e as Error).message; }
        try { buildBottomLineSummary(P, s.ticker, s.fund, s.tech, s.decision, s.leaps, s.short, deps); } catch (e) { perr = (e as Error).message; }
        assert.equal(perr, lerr, s.name + ' (thrown message)');
        assert.equal(lerr !== null, !!s.throws, s.name + ' (expected to throw: ' + !!s.throws + ')');
        if (lerr) threw.push(lerr);
        assert.deepStrictEqual(P.getSheets().map((x) => x.getName()), L.getSheets().map((x) => x.getName()), s.name + ' (tabs)');
        const lsh = L.getSheetByName(tab)!, psh = P.getSheetByName(tab)!;
        assert.deepStrictEqual(psh.calls, lsh.calls, s.name + ' calls');
        assert.deepStrictEqual(psh.grid(), lsh.grid(), s.name + ' cells');
        assert.deepStrictEqual(psh.merges, lsh.merges, s.name + ' merges');
        assert.equal(psh.created, lsh.created, s.name + ' created');
        assert.equal(psh.cleared, lsh.cleared, s.name + ' cleared');
        assert.equal(psh.getTabColor(), '#4a148c');
        assert.deepStrictEqual(P.calls, L.calls, s.name + ' (workbook calls)');
        assert.deepStrictEqual(P.getSheetByName('Other')!.grid(), [['k']]);
        // a finished tab ends with the widths and the activate; a throwing run never gets there
        const last = lsh.calls[lsh.calls.length - 1];
        assert.equal(last[0] === 'activate', !s.throws, s.name + ' (ends with activate)');
        assert.equal(lsh.created, !s.existing);
        assert.equal(lsh.cleared, !!s.existing);
        assert.equal(lsh.calls.some((c) => c[0] === 'clearFormats'), !!s.existing);
        for (const row of lsh.grid()) for (const c of row) if (typeof c === 'string') seen.push(c);
      }
    });
    // coverage guards: every line variant of the tab was produced by some scenario
    const all = seen.join('\n');
    for (const f of [
      '📋 BOTTOM LINE — ACME   |   10/23/2026, 11:00:00 AM', 'Strategy', '🏆 Overall Action', 'BUY  (Final Conviction: 74/100)', 'N/A  (Final Conviction: N/A/100)', '(Final Conviction: 0/100)',
      '💰 Fundamentals (OWN)', '72/100 — STRONG', '0/100 — ', 'N/A this run',
      '📊 Stock Timing (short-term)', '61/100 — BUY_NOW  (regime: TREND_UP)', '0/100 — AVOID', 'N/A — N/A  (regime: N/A)',
      '📈 Stock Secular (5-10yr hold)', 'BUY — long runway', '📏 ATR / Risk', 'Risk $10.00/share', '$2.50 ATR  ·  Stop $90.00\n', 
      '🪜 LILO Ladder', '3 buy rungs ($90.00–$99.00)  ·  2 sell rungs ($120.00, $130.00)', 'buy rungs (none)', 'sell rungs (none)', 'no rungs this run (insufficient confluence alignment)',
      '📞 Options — LEAPS (>1yr)', '📞 Options — Short-term (<1yr)', 'not available this run (run via 🚀 Full Ticker Analysis for options data)',
      'not found — no chain data returned for NF', 'not found — undefined', '$150.5 call, exp ', 'delta 0.51  ·  IV 45.7%', 'IV N/A',
      '⚠ Equity signal says WAIT_PULLBACK — buying this now runs ahead of that plan', '⚠ Equity signal says AVOID — buying this now runs ahead of that plan',
      '⚠ R:R Gate', 'T1 R:R 0.80 — marginal structure', 'T1 R:R 1.49 — thin, size accordingly', '📍 R:R at today\'s price', 'T1 R:R 1.80 (vs 1.20 at the $100.00 ladder entry)', 'T1 R:R 3.00',
    ]) assert.ok(all.includes(f), 'no scenario produced: ' + f);
    // the LEAPS pick is never cross-checked against the timing; only the short-term pick is
    assert.equal((all.match(/Equity signal says/g) ?? []).length, 2);
    // F-I8: the swallowed ladder error shows as a plain N/A line
    assert.ok(all.includes('N/A this run'));
    // F-I5 and the null techPlan: both TypeErrors
    assert.deepStrictEqual(threw, [
      "Cannot read properties of null (reading 'toFixed')", "Cannot read properties of null (reading 'techScore')", "Cannot read properties of null (reading 'techScore')",
    ]);
  });

  test('F-I8: an error inside the ladder block: legacy shows the N/A line; plain mode (default) the catalog line, detail to the log', async () => {
    const run = async (extra: { legacyReportText?: boolean; onReportDetail?: (l: string) => void }): Promise<unknown[][]> => {
      const ss = await ReportWorkbook.open(new MemoryWorkbookBackend({}), ['*']);
      buildBottomLineSummary(ss, 'T', { score: 1 }, { ...base, t1: { price: 'x' as unknown as number } }, { action: 'BUY', finalConviction: 1 }, null, null, { clock: { now: () => NOW }, timeZone: TZ, ...extra });
      return ss.getSheetByName(bottomLineTabName('T', !!extra.legacyReportText))!.grid();
    };
    assert.ok((await run({ legacyReportText: true })).some((r) => r[0] === '🪜 LILO Ladder' && r[1] === 'N/A this run'));
    const logs: string[] = [];
    assert.ok((await run({ onReportDetail: (l: string) => logs.push(l) })).some((r) => r[0] === '🪜 LILO Ladder' && r[1] === 'This section could not be built.'));
    assert.equal(logs.length, 1);
  });

  test('the header uses the injected clock and zone, not the machine clock', async () => {
    const ss = await ReportWorkbook.open(new MemoryWorkbookBackend({}), ['*']);
    buildBottomLineSummary(ss, 'T', null, {}, null, null, null, { clock: { now: () => NOW }, timeZone: 'UTC' });
    assert.equal(ss.getSheetByName(BOTTOM_LINE_TAB)!.grid()[0][0], '📋 BOTTOM LINE — T   |   10/23/2026, 3:00:00 PM');
  });
});
