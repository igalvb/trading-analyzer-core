/**
 * FL-7h: the narrative, the data-status banner and run summary, the plain-text report writer, the verdict-row
 * tint, padRow and the failure sheet (fullStockAnalysisV10_9.gs :3338, :5022-5288), against the oracle. The sheet
 * writers run on twin ReportWorkbooks (Memory backend); the tests compare every tab's recorded call log AND its
 * cells. Coverage guards fail the test if a branch is never reached.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadOracle, legacyFilesPresent, LEGACY_DIR } from './oracle.ts';
import { withOracleGlobals } from './oracleGlobals.ts';
import { pinnedDateClass } from './pinnedDate.ts';
import { ReportWorkbook, MemoryWorkbookBackend, type ReportSheet } from '../src/sheets/reportSheet.ts';
import { DATA_STATUS_KEYS } from '../src/analysis/dataStatus.ts';
import { buildNarrative } from '../src/reports/text/narrative.ts';
import {
  padRow, colorVerdictRow9, buildDataStatusBanner, logDataStatusSummary, writeTextReportToSheet, buildFailureSheet,
  STATUS_DISPLAY_ORDER, DASH_COLS, ANALYSIS_TAB, type TextReportSheet, type RunStatus,
} from '../src/reports/text/textReports.ts';
import { TZ, NOW, NARRATIVE_SCENARIOS, NARRATIVE_THROWS, narrativeArgs, bannerStatuses, failureStatuses } from './fl7hFixtures.ts';

const ready = legacyFilesPresent();
const LEG = ready ? fs.readFileSync(path.join(LEGACY_DIR, 'fullStockAnalysisV10_9.gs'), 'utf8').split('\n') : [];
const TIME = { nowMs: NOW, timeZone: TZ };

async function inZone<T>(tz: string, fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try { return await fn(); } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
}

async function twin(initial: Record<string, unknown[][]> = {}, preload: string[] = ['*']) {
  const mk = async (): Promise<ReportWorkbook> => ReportWorkbook.open(new MemoryWorkbookBackend(initial as never), preload);
  return { L: await mk(), P: await mk() };
}

/** Runs a legacy function with the clock pinned; raw = the sheet-writing functions (their arguments are not cloned). */
function legacy<T>(name: string, args: unknown[], raw = false): T {
  const o = loadOracle();
  return withOracleGlobals({ Date: pinnedDateClass(NOW) }, () => (raw ? o.call(name, ...args) : o.callNormalized(name, ...args))) as T;
}

function assertSameBooks(L: ReportWorkbook, P: ReportWorkbook, where: string): void {
  assert.deepStrictEqual(P.getSheets().map((s) => s.getName()), L.getSheets().map((s) => s.getName()), where + ' (tabs)');
  for (const sh of L.getSheets()) {
    const ps = P.getSheetByName(sh.getName())!;
    assert.deepStrictEqual(ps.calls, sh.calls, where + ' calls on ' + sh.getName());
    assert.deepStrictEqual(ps.grid(), sh.grid(), where + ' cells on ' + sh.getName());
  }
  assert.deepStrictEqual(P.calls, L.calls, where + ' (workbook calls)');
}

/** ReportSheet has no row grid: add one (getMaxRows / insertRowsAfter, the latter recorded) to the legacy and the port sheet alike. */
function withRowGrid(sh: ReportSheet, maxRows: number): TextReportSheet {
  let max = maxRows;
  return Object.assign(sh, {
    getMaxRows: () => max,
    insertRowsAfter: (after: number, n: number) => { sh.calls.push(['insertRowsAfter', after, n]); max += n; return sh; },
  });
}

const RANGES: ReadonlyArray<readonly [string, number, number]> = [
  ['padRowV7', 3338, 3342], ['colorVerdictRow9V7_', 5022, 5028], ['buildNarrativeV7_', 5030, 5121], ['buildDataStatusBannerV7', 5130, 5159],
  ['logDataStatusSummaryV7', 5170, 5192], ['writeTextReportToSheetV7', 5207, 5229], ['buildFailureSheetV7', 5231, 5288],
];

describe('FL-7h -- legacy boundaries and constants', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('every ported range starts and ends where the port says; the constants and the three source lists match', () => {
    for (const [name, a, b] of RANGES) {
      assert.ok(LEG[a - 1].startsWith('function ' + name + '('), name + ' starts at ' + a + ': ' + LEG[a - 1]);
      assert.equal(LEG[b - 1], '}', name + ' closes at ' + b);
    }
    assert.equal(LEG[3336 - 1], 'const V7_DASH_COLS = ' + DASH_COLS + ';');
    assert.equal(DASH_COLS, 10);
    assert.equal(LEG[18 - 1], "  tab:     '" + ANALYSIS_TAB + "',");
    // the order list appears in the banner, the run summary and the failure sheet; all three are the list the port uses
    const lists = RANGES.filter(([n]) => ['buildDataStatusBannerV7', 'logDataStatusSummaryV7', 'buildFailureSheetV7'].includes(n)).map(([, a, b]) => {
      const line = LEG.slice(a - 1, b).find((l) => /^\s*const order = \[/.test(l))!;
      return [...line.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    });
    assert.equal(lists.length, 3);
    for (const l of lists) assert.deepStrictEqual(l, [...STATUS_DISPLAY_ORDER]);
    assert.deepStrictEqual([...STATUS_DISPLAY_ORDER].sort(), [...DATA_STATUS_KEYS].sort(), 'the display order covers exactly the tracked sources');
    assert.equal(STATUS_DISPLAY_ORDER.length, 21);
  });
});

describe('FL-7h -- padRow and the verdict-row tint', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('padRow: shorter, exact, longer, falsy values', () => {
    const cases: unknown[][] = [[], ['a'], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], Array.from({ length: 25 }, (_, i) => i), [undefined, null, 0, false, NaN], [['x'], { a: 1 }]];
    const lens = new Set<number>();
    for (const c of cases) {
      const lg = legacy<unknown[]>('padRowV7', [c]);
      const pt = padRow(c);
      assert.deepStrictEqual(pt, lg);
      assert.equal(pt.length, DASH_COLS);
      lens.add(c.length);
    }
    assert.ok([...lens].some((n) => n < DASH_COLS) && lens.has(DASH_COLS) && [...lens].some((n) => n > DASH_COLS), 'guard: short, exact and long inputs');
  });

  test('colorVerdictRow9: green, amber, red, and a missing conviction is red; call logs and cells equal', async () => {
    const bgs = new Set<unknown>();
    for (const conv of [100, 65, 64.99, 50, 49.99, 0, -5, null, undefined, NaN, '70' as unknown as number]) {
      const { L, P } = await twin({ T: [['x']] });
      legacy('colorVerdictRow9V7_', [L.getSheetByName('T'), 3, conv], true);
      colorVerdictRow9(P.getSheetByName('T')!, 3, conv);
      assertSameBooks(L, P, 'conviction ' + String(conv));
      const calls = P.getSheetByName('T')!.calls;
      bgs.add(calls.find((c) => c[0] === 'range:setBackground')![5]);
      assert.equal(calls.length, 6, 'one background, then three font writes on H and two on I: ' + String(conv));
    }
    assert.deepStrictEqual([...bgs].sort(), ['#c8e6c9', '#ffcdd2', '#fff9c4'], 'guard: all three tints reached');
  });
});

describe('FL-7h -- narrative', { skip: ready ? false : 'legacy/ not populated' }, () => {
  const MARKERS: ReadonlyArray<readonly [string, RegExp]> = [
    ['top', /sits near the top of/], ['bottom', /sits near the bottom of/], ['middle', /sits in the middle of/],
    ['uptrend', /in a long-term uptrend/], ['downtrend', /in a long-term downtrend/], ['above 50', /and is above the 50-day average/], ['below 50', /and is below the 50-day average/],
    ['constructive', /backdrop is constructive\./], ['cautious', /backdrop is cautious\./], ['golden', /A recent golden cross/], ['death', /A recent death cross/],
    ['no cross', /(constructive|cautious)\. Daily volatility/], ['day change zero', /\(\+0\.0% on the day\)/], ['day change', /\(\+2\.0% on the day\)/],
    ['mom +', /mixed-to-positive/], ['mom -', /mixed-to-negative/], ['mom 0', /mixed-to-neutral/],
    ['rsi oversold', /RSI\(14\) is \d+ \(oversold\)/], ['rsi overbought', /RSI\(14\) is \d+ \(overbought\)/], ['rsi weak', /RSI\(14\) is \d+ \(slightly weak\)/],
    ['rsi firm', /RSI\(14\) is \d+ \(slightly firm\)/], ['rsi neutral', /RSI\(14\) is \d+ \(neutral\)/],
    ['macd up', /MACD is above its signal line/], ['macd down', /MACD is below its signal line/],
    ['squeeze', /The bands are squeezing/], ['upper band', /riding the upper band/], ['lower band', /pinned to the lower band/], ['no band', /(oversold|overbought|mid-range)\. The latest session/],
    ['stoch oversold', /fast oscillators are oversold/], ['stoch overbought', /fast oscillators are overbought/], ['stoch mid', /fast oscillators are mid-range/],
    ['heavy', /traded on notably heavy volume/], ['light', /traded on light volume/], ['average', /traded on average volume/],
    ['adx strong', /indicating a very strong trend/], ['adx defined', /indicating a defined trend/], ['adx weak', /indicating a weak\/sideways trend/],
    ['bulls', /favouring the bulls/], ['bears', /favouring the bears/],
    ['weekly oversold', /Weekly RSI is \d+ \(oversold\)/], ['weekly overbought', /Weekly RSI is \d+ \(overbought\)/], ['weekly neutral', /Weekly RSI is \d+ \(neutral\)/],
    ['gann supportive', /structural read supportive\/bullish/], ['gann neutral', /structural read neutral/], ['gann unsupportive', /structural read unsupportive\/bearish/],
    ['master known', /1×1 line at \$\d/], ['master N/A', /1×1 line at N\/A/], ['master below', /which is below price and acting as support/], ['master above', /which is far above price and acting as resistance/],
    ['pe rich', /a P\/E of 50 \(rich\)/], ['pe cheap', /a P\/E of 10 \(cheap\)/], ['pe fair', /a P\/E of 20 \(fair\)/], ['peg attractive', /\(attractive vs growth\)/], ['peg expensive', /\(expensive vs growth\)/],
    ['peg plain', /a PEG of 1\.50,/], ['revenue', /revenue growth of \+12\.0%/], ['margin', /a net margin of 20\.0%/], ['roe', /ROE of 25%/], ['limited', /shows limited fundamental data/],
    ['rating', /, rating buy\)/], ['no rating', /\(\+20\.0% from here\)\./], ['tailwind', /valuation are a tailwind/], ['headwind', /valuation are a headwind/], ['roughly neutral', /valuation are roughly neutral/],
    ['no fundamentals', /No fundamental data was available/],
    ['wait', /That implies waiting for a pullback/], ['close', /That is close to the current price/],
    ['no options', /No options snapshot was loaded/], ['confirms', /CONFIRMS the chart/], ['conflicts', /CONFLICTS with the chart/], ['options neutral', /is roughly neutral — Put\/Call/],
    ['pcr', /Put\/Call OI 0\.85/], ['pcr N/A', /Put\/Call OI N\/A/], ['net +', /net \$ \+12%/], ['net -', /net \$ -5%/], ['net 0', /net \$ 0%/], ['net N/A', /net \$ N\/A/],
    ['iv', /IV 40th %ile/], ['iv N/A', /IV N\/A/], ['iv 0', /IV 0th %ile/], ['long float', /net \$ \+12\.3456789%/],
    ['own N/A', /pure OWN score \(business only\) is N\/A/], ['own score', /pure OWN score \(business only\) is 62\/100/],
  ];

  test('buildNarrative equals buildNarrativeV7_ in every scenario; every branch text is reached', () => {
    const all: string[] = [];
    for (const [name, over] of NARRATIVE_SCENARIOS) {
      const lg = legacy<Array<{ heading: string; body: string }>>('buildNarrativeV7_', narrativeArgs(over));
      const pt = buildNarrative(...(narrativeArgs(over) as Parameters<typeof buildNarrative>));
      assert.deepStrictEqual(structuredClone(pt), lg, name);
      assert.equal(pt.length, 7, name);
      assert.deepStrictEqual(pt.map((p) => p.heading.slice(0, 2)), ['1.', '2.', '3.', '4.', '5.', '6.', '7.']);
      all.push(...lg.map((p) => p.body));
    }
    const text = all.join('\n');
    const missed = MARKERS.filter(([, re]) => !re.test(text)).map(([n]) => n);
    assert.deepStrictEqual(missed, [], 'guard: a branch text was never produced by the legacy oracle');
    assert.ok(MARKERS.length >= 80);
  });

  test('a missing number legacy calls a method on throws in both', () => {
    for (const [name, over] of NARRATIVE_THROWS) {
      let lm = '', pm = '';
      try { legacy('buildNarrativeV7_', narrativeArgs(over)); } catch (e) { lm = (e as Error).message; }
      try { buildNarrative(...(narrativeArgs(over) as Parameters<typeof buildNarrative>)); } catch (e) { pm = (e as Error).message; }
      assert.ok(lm, 'legacy throws: ' + name);
      assert.equal(pm, lm, name);
    }
  });
});

describe('FL-7h -- data status banner and run summary', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('banner: every status shape, equal to the oracle (guards: no rows, ok row, partial rows, ordering and filtering)', () => {
    const shapes = new Set<number>();
    let mixedSummary = '', mixedAffected = '';
    for (const [name, st] of bannerStatuses()) {
      const lg = legacy<any[]>('buildDataStatusBannerV7', [st]);
      const pt = buildDataStatusBanner(st, { legacyReportText: true });
      assert.deepStrictEqual(structuredClone(pt), lg, name);
      shapes.add(pt.length);
      if (name === 'mixed') { mixedSummary = pt[0].text[0]; mixedAffected = pt[1].text[0]; }
    }
    assert.deepStrictEqual([...shapes].sort(), [0, 1, 2], 'guard: [] / green row / red+affected rows');
    assert.equal(mixedSummary, '⚠ PARTIAL DATA — this report relies on incomplete inputs. 2 failed, 2 skipped, 3 degraded.');
    // failed first, then skipped, then degraded; an entry with neither detail nor label is dropped; pending/ok/unknown/untracked are ignored
    assert.equal(mixedAffected, 'Affected: HTTP 429 from https://query1.finance.yahoo.com/v8/finance/chart/PLTR   •   Peer comparison   •   Finnhub series   •   no snapshot   •   no PEG ratio   •   one model missing');
  });

  test('run summary: every status shape and every kind of log argument, equal to the oracle', () => {
    const seen = new Set<string>();
    const logsOf = (fn: (log: (m: string) => void) => void): string[] => { const out: string[] = []; fn((m) => { out.push(m); }); return out; };
    for (const [name, st] of bannerStatuses()) {
      const lg = logsOf((log) => legacy('logDataStatusSummaryV7', [st, log]));
      const pt = logsOf((log) => logDataStatusSummary(st, log));
      assert.deepStrictEqual(pt, lg, name);
      for (const l of pt) seen.add(l.startsWith('✅ Run Summary: all data sources OK.') ? 'ok line' : l.startsWith('🔍 Run Summary: ') ? 'problem line' : 'other');
    }
    assert.deepStrictEqual([...seen].sort(), ['ok line', 'problem line'], 'guard: the all-OK line and the problem line');
    for (const bad of [undefined, null, 'log', 42, {}]) {
      const st = bannerStatuses()[12][1] as RunStatus;
      assert.equal(legacy('logDataStatusSummaryV7', [st, bad]), undefined);
      assert.equal(logDataStatusSummary(st, bad as never), undefined);
    }
    // the summary keeps the technical detail (a log line): 'label (detail)'
    const lines = logsOf((log) => logDataStatusSummary(bannerStatuses()[12][1], log));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^🔍 Run Summary: 2 failed, 2 skipped, 3 degraded — Price \(OHLCV\) \(HTTP 429 from /);
  });
});

describe('FL-7h -- writeTextReportToSheet', { skip: ready ? false : 'legacy/ not populated' }, () => {
  const REPORT = '=== PLTR REPORT ===\n1. STOCK ID CARD\nplain line\n\n12. Another section\n1.x not a header\n 2. leading space is not a header\n=== second title';
  const CASES: ReadonlyArray<readonly [string, string, unknown, string | undefined | null, number]> = [
    ['accent colour', 'R', REPORT, '#123456', 1000],
    ['default colour and the grid grows', 'R', REPORT, undefined, 3],
    ['empty accent falls back too, grid one row short', 'R', REPORT, '', 7],
    ['empty text', 'R', '', '#123456', 1],
    ['null text', 'R', null, null, 1],
    ['undefined text', 'R', undefined, undefined, 5],
    ['zero is no text', 'R', 0, undefined, 5],
    ['a number is text', 'R', 12345, undefined, 5],
    ['carriage returns stay in the text', 'R', '=== A ===\r\n1. B\r\ntext', undefined, 100],
    ['a sheet that was never read (the unmerge is skipped)', 'U', 'a\nb', undefined, 0],
  ];

  test('every case: call log and cells equal to the oracle; guards on each branch', async () => {
    const seen = { bold13: false, bold11: false, insert: 0, noBreakApart: 0, breakApart: 0, defaultColor: false, accent: false };
    for (const [name, tab, text, accent, maxRows] of CASES) {
      const { L, P } = await twin({ R: [['old', 'x'], ['y']], U: [['z']] }, ['R']);
      // a stale merge on the readable tab, set up identically on both sides
      if (tab === 'R') { L.getSheetByName('R')!.getRange(1, 1, 1, 2).merge(); P.getSheetByName('R')!.getRange(1, 1, 1, 2).merge(); }
      legacy('writeTextReportToSheetV7', [withRowGrid(L.getSheetByName(tab)!, maxRows), text, accent], true);
      writeTextReportToSheet(withRowGrid(P.getSheetByName(tab)!, maxRows), text, accent);
      assertSameBooks(L, P, name);
      const calls = P.getSheetByName(tab)!.calls;
      if (calls.some((c) => c[0] === 'range:setFontSize' && c[5] === 13)) seen.bold13 = true;
      if (calls.some((c) => c[0] === 'range:setFontSize' && c[5] === 11)) seen.bold11 = true;
      seen.insert += calls.filter((c) => c[0] === 'insertRowsAfter').length;
      if (calls.some((c) => c[0] === 'range:breakApart')) seen.breakApart++; else seen.noBreakApart++;
      if (calls.some((c) => c[0] === 'setTabColor' && c[1] === '#455a64')) seen.defaultColor = true;
      if (calls.some((c) => c[0] === 'setTabColor' && c[1] === '#123456')) seen.accent = true;
      assert.ok(calls.some((c) => c[0] === 'setFrozenRows' && c[1] === 1) && calls.some((c) => c[0] === 'setColumnWidth' && c[1] === 1 && c[2] === 900), name);
    }
    assert.deepStrictEqual(seen, { bold13: true, bold11: true, insert: 3, noBreakApart: 1, breakApart: 9, defaultColor: true, accent: true });
    // header detection is exact: '12. ' is a section line, '1.x' and ' 2. ' are not, '===' only at column 0
    const { P } = await twin({ R: [['']] }, ['R']);
    writeTextReportToSheet(withRowGrid(P.getSheetByName('R')!, 100), REPORT, '#123456');
    const rows = P.getSheetByName('R')!.calls.filter((c) => c[0] === 'range:setFontWeight').map((c) => c[1]);
    assert.deepStrictEqual(rows, [1, 2, 5, 8]);
  });
});

describe('FL-7h -- buildFailureSheet', { skip: ready ? false : 'legacy/ not populated' }, () => {
  const FULL = failureStatuses()[3][1];
  const LONG = new Error('x'.repeat(400));
  const CASES: ReadonlyArray<readonly [string, Record<string, unknown[][]>, string[], string | null | undefined, RunStatus | null | undefined, unknown]> = [
    ['new tab, an error with a technical message', {}, ['*'], 'PLTR', FULL, new Error('Could not fetch data: HTTP 429 from https://query1.finance.yahoo.com/v8/finance/chart/PLTR')],
    ['existing tab with stale cells and a merge, no ticker, no status, no error', { [ANALYSIS_TAB]: [['stale', 'x', 'y'], [1, 2, 3]] }, ['*'], '', null, undefined],
    ['existing tab that was never read', { [ANALYSIS_TAB]: [['stale']] }, [], null, {}, 'plain string failure'],
    ['an error object with an empty message', {}, ['*'], 'X', FULL, { message: '' }],
    ['a 400-character message is cut to 300', {}, ['*'], 'X', failureStatuses()[2][1], LONG],
    ['a falsy error', {}, ['*'], 'X', failureStatuses()[1][1], 0],
    ['an Error with a short message', {}, ['*'], 'X', failureStatuses()[1][1], new Error('boom')],
  ];

  test('every case: call log and cells equal to the oracle (guards: every status icon, fallbacks, truncation, the clock)', async () => {
    await inZone(TZ, async () => {
      const col = new Set<string>();
      let a2 = '';
      for (const [name, initial, preload, ticker, status, error] of CASES) {
        const { L, P } = await twin(initial, preload);
        legacy('buildFailureSheetV7', [L, ticker, status, error], true);
        buildFailureSheet(P, ticker, status, error, TIME, { legacyReportText: true });
        assertSameBooks(L, P, name);
        const g = P.getSheetByName(ANALYSIS_TAB)!.grid(DASH_COLS);
        for (const r of g) { col.add(String(r[0])); col.add(String(r[1])); }
        if (name.startsWith('a 400')) a2 = String(g[1][0]);
        if (name.startsWith('new tab')) assert.equal(g[0][0], '⚠ ANALYSIS INCOMPLETE — PLTR   ·   10/23/2026, 11:00:00 AM', 'the clock is the script zone, en-US');
        if (name.startsWith('existing tab with')) assert.ok(String(g[0][0]).includes('(no ticker)'));
        assert.equal(g[0].length, DASH_COLS);
      }
      for (const want of ['✅ ok', '⚠️ degraded', '❌ failed', '⏳ not reached', 'skipped', 'weird', 'gann', 'Reason: Unknown error', 'Reason: [object Object]', 'Reason: boom', 'Data source']) {
        assert.ok([...col].some((c) => c === want || c.startsWith(want)), 'guard: ' + want);
      }
      assert.equal(a2, 'Reason: ' + 'x'.repeat(300));
    });
  });

  test('a non-string message makes legacy throw part-way; the port throws at the same call with the same calls recorded', async () => {
    await inZone(TZ, async () => {
      const { L, P } = await twin({}, ['*']);
      const bad = { message: 5 };
      assert.throws(() => legacy('buildFailureSheetV7', [L, 'X', null, bad], true));
      assert.throws(() => buildFailureSheet(P, 'X', null, bad, TIME, { legacyReportText: true }));
      assertSameBooks(L, P, 'throw');
    });
  });
});

describe('FL-7h -- documented legacy report text (ported exactly; see findings F-H1..F-H5)', () => {
  test('the failure sheet and the banner print raw detail; skipped has no icon; pending is invisible to the banner', async () => {
    await inZone(TZ, async () => {
      const { P } = await twin({}, ['*']);
      const st: RunStatus = { price: { label: 'Price (OHLCV)', state: 'failed', detail: 'HTTP 429 at https://example.test/q' }, spyRS: { label: 'SPY', state: 'skipped', detail: '' } };
      buildFailureSheet(P, 'X', st, new Error('HTTP 500 from https://example.test'), TIME, { legacyReportText: true });
      const g = P.getSheetByName(ANALYSIS_TAB)!.grid();
      assert.equal(g[1][0], 'Reason: HTTP 500 from https://example.test');
      assert.deepStrictEqual(g[4].slice(0, 3), ['Price (OHLCV)', '❌ failed', 'HTTP 429 at https://example.test/q']);
      assert.deepStrictEqual(g[5].slice(0, 2), ['SPY', 'skipped']);
      assert.match(buildDataStatusBanner(st, { legacyReportText: true })[1].text[0], /HTTP 429 at https:\/\/example\.test\/q/);
      const pending = { price: { label: 'Price (OHLCV)', state: 'pending', detail: '' } };
      assert.equal(buildDataStatusBanner(pending, { legacyReportText: true })[0].text[0], '✅ All data sources OK — full-confidence report.');
    });
  });
});
