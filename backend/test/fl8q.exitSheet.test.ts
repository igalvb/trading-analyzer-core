/** FL-8q: the single combined Exit report sheet. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ReportWorkbook, MemoryWorkbookBackend, type TabChange } from '../src/sheets/reportSheet.ts';
import { assertNoReportLeaks } from '../src/reports/messages/leakScan.ts';
import { reasonLine } from '../src/reports/messages/catalog.ts';
import { formatStockSignals, formatOptionsSignals } from '../src/reports/exit/exitReport.ts';
import { buildExitSheet, writeAiSummaries, EXIT_SHEET_TAB, EXIT_SHEET_TAB_COLOR, AI_ANCHOR, AI_PLACEHOLDER } from '../src/reports/exitSheet/exitSheet.ts';
import type { ExitHoldingInput, ExitReportInput, AiSummariesInput } from '../src/reports/exitSheet/types.ts';

const NOW = new Date('2026-10-24T20:00:00Z');

class CountingBackend extends MemoryWorkbookBackend {
  applyCount = 0;
  async applyTab(tab: string, change: TabChange): Promise<void> { this.applyCount++; return super.applyTab(tab, change); }
}

const models = (stance: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'BULLISH') => (['ENGINE', 'SCHABACKER', 'EDWARDS_MAGEE', 'BROKER_COURSE', 'TURTLE'] as const)
  .map((m, i) => ({ model: m, stance: i === 4 ? 'BEARISH' as const : stance, score: 60 + i }));

function stock(ticker: string, o: Partial<ExitHoldingInput> & { stop?: number; price?: number; entry?: string | null; sig?: ReturnType<typeof formatStockSignals>; group?: string } = {}): ExitHoldingInput {
  const entry = o.entry === undefined ? '2025-01-10' : o.entry;
  const sig = o.sig ?? formatStockSignals({ chandelierSinceEntry: o.stop ?? 210, t1: 260, t2: 300, hitT1: false, hitT2: false, entryDateStr: entry ?? undefined }, entry != null);
  return {
    ticker, kind: 'STOCK',
    position: { quantity: 10, avgCost: 200, entryDate: entry, currentPrice: o.price ?? 250 },
    signals: sig,
    levels: { stopLevel: o.stop ?? 210, stopBasis: entry != null ? 'SINCE_ENTRY' : 'GENERIC', stopBreached: false, thesisInvalidated: false, t1: 260, hitT1: false, t2: 300, hitT2: false },
    models: models(),
    comparison: { agreeCount: 4, totalCount: 5, majority: 'BULLISH', dissenters: ['TURTLE'] },
    fundamentals: { ownScore: 7.5, band: 'Good' },
    positioning: { institutionalHolders: 1200, darkPoolPct: 38.2, shortInterestPct: 2.1 },
    correlatedGroup: o.group ?? null,
    dataHealth: [],
    ...o,
  } as ExitHoldingInput;
}

function input(): ExitReportInput {
  const aapl = stock('AAPL', { sig: formatStockSignals({ chandelierSinceEntry: 180, stopBreached: true, t1: 200, t2: 220, entryDateStr: '2025-02-01' }, true), levels: { stopLevel: 180, stopBasis: 'SINCE_ENTRY', stopBreached: true, thesisInvalidated: false, t1: 200, hitT1: false, t2: 220, hitT2: false } });
  const mstr = stock('MSTR', { sig: formatStockSignals({ chandelierSinceEntry: 300, t1: 400, hitT1: true, t2: 500, hitT2: true, entryDateStr: '2025-03-01' }, true), levels: { stopLevel: 300, stopBasis: 'SINCE_ENTRY', stopBreached: false, thesisInvalidated: false, t1: 400, hitT1: true, t2: 500, hitT2: true } });
  const option: ExitHoldingInput = {
    ticker: 'TSLA', kind: 'OPTION',
    position: { quantity: 2, avgCost: 3, entryDate: '2026-06-01', currentPrice: 5 },
    option: { right: 'CALL', strike: 250, expiry: '2026-11-13', daysToExpiry: 20, expiryThreshold: 30, expiryWarning: true, underlyingPrice: 262 },
    signals: formatOptionsSignals({ daysToExpiry: 20, expiryThreshold: 30, expiryWarning: true, technical: { chandelierSinceEntry: 210, t1: 300, t2: 330 } }, true, 2),
    levels: { stopLevel: 210, stopBasis: 'SINCE_ENTRY', stopBreached: false, thesisInvalidated: false, t1: 300, hitT1: false, t2: 330, hitT2: false },
    models: [], dataHealth: [],
  };
  const failed: ExitHoldingInput = { ticker: 'XYZ', kind: 'STOCK', position: { quantity: 5, avgCost: 10, entryDate: null, currentPrice: null }, models: [], dataHealth: [], failed: 'NO_DATA_FOR_TICKER' };
  return {
    runAt: NOW,
    holdings: [
      stock('TSLA'), mstr,
      stock('GBTC', { price: 60, stop: 52, group: 'BITCOIN', entry: '2026-06-01' }),
      stock('IBIT', { price: 40, stop: 35, group: 'BITCOIN', entry: null }),
      aapl, option, failed,
    ],
    skipped: { crypto: ['ETH-USD', 'FBTC'], otherStock: ['TOTAL (row 30, excluded)'], blankTickerRowCount: 2 },
    sharedThesis: { group: 'BITCOIN', members: ['GBTC', 'IBIT'], anchorSeries: 'IBIT', regime: 'Uptrend', trend: 'Up', trendMaturity: 'mid-stage', rsi: 58.2, stochRsi: 71.5, pattern: 'Ascending triangle', momentum: 'Steady', thesis: 'Trend intact above support.' },
    advisory: { distinctStockCount: 6, diversificationFlag: false, phaseRead: 'NEAR_TOP', evaluativeIndexPctStrong: 91.2, dowTheoryVerdict: 'Bull', holdings: [{ ticker: 'TSLA', tier: 'High' }], correlatedCaps: { totalUnits: 4.2, totalFlagged: false, categoryFlags: [{ category: 'Tech', units: 2.1, flagged: false }] } as never },
    dataHealth: [],
  };
}

async function nightly(inp: ExitReportInput = input(), be: CountingBackend = new CountingBackend({ Portfolio: [['x']] })) {
  const ss = await ReportWorkbook.open(be, ['*']);
  const logs: string[] = [];
  const res = buildExitSheet(ss, inp, { log: (m) => logs.push(m) });
  await ss.flush();
  return { be, ss, res, logs };
}
const colA = (be: MemoryWorkbookBackend): string[] => be.grid(EXIT_SHEET_TAB).map((r) => String(r[0] ?? ''));
const allText = (be: MemoryWorkbookBackend): string[] => be.grid(EXIT_SHEET_TAB).flat().map((v) => String(v ?? ''));
const AI: AiSummariesInput = { ranAt: NOW, geminiUsed: true, opusMode: 'REVIEW', effort: 'high', entries: [{ ticker: 'TSLA', gemini: 'Gemini says LONGMARKER hold.\nSee https://x.example/a', opus: 'Opus agrees.' }, { ticker: 'AAPL', gemini: 'Gemini AAPL.', opus: 'Opus AAPL.' }] };

describe('build', () => {
  test('Q-1 exactly one new tab, blue, one applyTab, one setValues', async () => {
    const be = new CountingBackend({ Portfolio: [['x']] });
    const before = (await be.listTabs()).map((t) => t.name);
    const { ss } = await nightly(input(), be);
    const after = (await be.listTabs()).map((t) => t.name);
    assert.deepEqual(after, [...before, EXIT_SHEET_TAB]);
    assert.equal(be.applyCount, 1);
    assert.equal(be.tabs.get(EXIT_SHEET_TAB)!.tabColor, EXIT_SHEET_TAB_COLOR);
    assert.notEqual(be.tabs.get(EXIT_SHEET_TAB)!.tabColor, '#d50000');
    const sh = ss.getSheetByName(EXIT_SHEET_TAB)!;
    assert.equal(sh.calls.filter((c) => c[0] === 'range:setValues').length, 1);
  });
  test('Q-2 every written cell is leak-free; no raw error labels; never "cache"', async () => {
    const { be } = await nightly();
    assertNoReportLeaks(be.grid(EXIT_SHEET_TAB));
    for (const t of allText(be)) { assert.ok(!/cache/i.test(t), t); assert.ok(!/ERROR:?/.test(t), t); assert.ok(!/undefined|NaN/.test(t), t); }
  });
  test('Q-3 action-first order, failed last, and table-of-contents rows point at real sections', async () => {
    const { be, res } = await nightly();
    assert.deepEqual(res.order, ['AAPL', 'TSLA call $250 2026-11-13', 'MSTR', 'TSLA', 'GBTC', 'IBIT', 'XYZ']);
    const col = colA(be);
    const heads = col.filter((t) => t.startsWith('═══ '));
    assert.deepEqual(heads, res.order.map((o) => '═══ ' + o + ' ═══'));
    const grid = be.grid(EXIT_SHEET_TAB);
    const toc = grid.filter((r) => /^Go to row \d+$/.test(String(r[5] ?? '')));
    assert.equal(toc.length, res.order.length);
    toc.forEach((r, i) => {
      const n = Number(String(r[5]).replace('Go to row ', ''));
      assert.equal(col[n - 1], '═══ ' + res.order[i] + ' ═══');
    });
  });
  test('Q-4 conclusion first: summary and action rollup before any holding section', async () => {
    const { be } = await nightly();
    const col = colA(be);
    const firstHolding = col.findIndex((t) => t.startsWith('═══ '));
    assert.ok(col.indexOf('PORTFOLIO SUMMARY') < firstHolding);
    assert.ok(col.findIndex((t) => t.startsWith('⚠ NEEDS ATTENTION')) < firstHolding);
    const rollup = be.grid(EXIT_SHEET_TAB).find((r) => r[0] === 'Action rollup')!;
    assert.match(String(rollup[1]), /2 EXIT/);
    assert.match(String(rollup[1]), /1 TRIM/);
  });
  test('Q-5 Bitcoin: disclosure in each member section, levels stay per ticker', async () => {
    const { be } = await nightly();
    const text = allText(be);
    const disclosures = text.filter((t) => t.startsWith('Technical read shared across Bitcoin-tracking ETFs (GBTC, IBIT)'));
    assert.ok(disclosures.length >= 3);
    const col = colA(be);
    for (const [tk, stop] of [['GBTC', '$52.00'], ['IBIT', '$35.00']] as const) {
      const start = col.indexOf('═══ ' + tk + ' ═══');
      const end = col.findIndex((t, i) => i > start && t.startsWith('═══ '));
      const sec = be.grid(EXIT_SHEET_TAB).slice(start, end === -1 ? undefined : end).flat().map(String);
      assert.ok(sec.some((t) => t.startsWith('Technical read shared')), tk);
      assert.ok(sec.some((t) => t.includes(stop)), tk + ' stop');
    }
  });
  test('Q-6 entry-date honesty: a missing date is prominent (it changes the stop basis)', async () => {
    const { be } = await nightly();
    const text = allText(be);
    assert.ok(text.some((t) => t.startsWith('1 holding(s) have no purchase date on file')));
  });
  test('Q-7 tax: 25% of the gain, stated as an assumption; no holding-period wording (user decision 2026-10-25)', async () => {
    const { be } = await nightly();
    const text = allText(be).join('\n');
    assert.match(text, /assuming 25% tax on the gain/);
    assert.match(text, /not tax advice/);
    assert.doesNotMatch(text, /Holding.period|Days held|long-term treatment|Long-term: held|Long-term status/i);
  });
  test('Q-8 skipped rows disclosed by name, a crypto-typed Bitcoin ETF is flagged', async () => {
    const { be } = await nightly();
    const text = allText(be);
    assert.ok(text.some((t) => t.includes('ETH-USD, FBTC')));
    assert.ok(text.some((t) => t.startsWith('⚠ FBTC is a spot Bitcoin ETF but is typed crypto')));
    assert.ok(text.some((t) => t.includes('TOTAL (row 30, excluded)')));
    assert.ok(text.some((t) => t.includes('Skipped 2 genuinely empty row(s)')));
  });
  test('F-B8-1: no "typed crypto" warning when the same ticker is also held as a stock row (real bitcoin BTC + the BTC Mini Trust ETF)', async () => {
    const inp = input();
    const both: ExitReportInput = { ...inp, holdings: [...inp.holdings, stock('BTC', { price: 35, stop: 30, group: 'BITCOIN', entry: null })], skipped: { ...inp.skipped, crypto: ['BTC', 'FBTC'] } };
    const text = allText((await nightly(both)).be);
    assert.ok(!text.some((t) => t.startsWith('⚠ BTC is a spot Bitcoin ETF')), 'BTC is held as a stock row, so the crypto BTC row is real bitcoin');
    assert.ok(text.some((t) => t.startsWith('⚠ FBTC is a spot Bitcoin ETF but is typed crypto')), 'FBTC is still flagged: no stock row for it');
  });
  test('Q-9 a failed holding shows the catalog sentence and does not touch the others', async () => {
    const { be } = await nightly();
    const col = colA(be);
    const start = col.indexOf('═══ XYZ ═══');
    assert.ok(start > 0);
    assert.equal(be.grid(EXIT_SHEET_TAB)[start + 1]![1], 'No verdict. ' + reasonLine('NO_DATA_FOR_TICKER'));
  });
  test('Q-10 a throwing section degrades only itself; the raw error goes to the log', async () => {
    const inp = input();
    const bad = { ...stock('BADCO'), get models(): never { throw new Error('boom https://leak.example/x?apikey=SECRET123456'); } } as unknown as ExitHoldingInput;
    const { be, res, logs } = await nightly({ ...inp, holdings: [...inp.holdings, bad] });
    assert.deepEqual(res.degraded.map((d) => d.name), ['BADCO']);
    assert.ok(colA(be).includes('═══ BADCO ═══'));
    assert.ok(colA(be).includes('═══ AAPL ═══'));
    assertNoReportLeaks(be.grid(EXIT_SHEET_TAB));
    assert.ok(!allText(be).some((t) => t.includes('boom')));
    assert.ok(logs.some((l) => l.includes('boom')));
  });
  test('Q-11 empty portfolio still builds a readable sheet', async () => {
    const { be } = await nightly({ ...input(), holdings: [], sharedThesis: null, advisory: null });
    assert.ok(allText(be).includes('No open positions were found on the Portfolio sheet.'));
    assertNoReportLeaks(be.grid(EXIT_SHEET_TAB));
  });
});

describe('AI section', () => {
  test('Q-12 nightly writes the placeholder; the AI anchor exists exactly once', async () => {
    const { be, res } = await nightly();
    assert.equal(colA(be).filter((t) => t === AI_ANCHOR).length, 1);
    assert.equal(colA(be)[res.anchors['AI']! ], AI_PLACEHOLDER);
  });
  test('Q-13 AI run replaces in place: no new tab, one section, same result when run twice', async () => {
    const { be } = await nightly();
    const tabs = (await be.listTabs()).map((t) => t.name);
    const run = async (a: AiSummariesInput) => { const w = await ReportWorkbook.open(be, ['*']); const r = writeAiSummaries(w, a); await w.flush(); return r; };
    const r1 = await run(AI);
    assert.equal(r1.written, true);
    const g1 = JSON.stringify(be.grid(EXIT_SHEET_TAB));
    const r2 = await run(AI);
    assert.equal(r2.written, true);
    assert.equal(JSON.stringify(be.grid(EXIT_SHEET_TAB)), g1);
    assert.deepEqual((await be.listTabs()).map((t) => t.name), tabs);
    assert.equal(colA(be).filter((t) => t === AI_ANCHOR).length, 1);
    assert.ok(!colA(be).includes(AI_PLACEHOLDER));
    assertNoReportLeaks(be.grid(EXIT_SHEET_TAB));
  });
  test('Q-14 mandatory Opus mode line comes first, Gemini lines with technical detail are dropped', async () => {
    const { be } = await nightly();
    const w = await ReportWorkbook.open(be, ['*']);
    const r = writeAiSummaries(w, { ...AI, opusMode: 'STANDALONE', standaloneWhy: 'AI_REVIEW_UNAVAILABLE', entries: [{ ticker: 'TSLA', gemini: AI.entries[0]!.gemini, opus: 'Opus alone.' }] });
    await w.flush();
    assert.equal(r.droppedLines, 1);
    const col = colA(be);
    const i = col.indexOf('Opus review');
    assert.ok(i > 0);
    assert.match(col[i + 1]!, /^Mode: Opus STANDALONE — Opus wrote this without a Gemini narrative to check because the AI review was not available\.$/);
    assert.equal(col[i + 2], 'Opus alone.');
    assert.ok(!allText(be).some((t) => t.includes('https://')));
  });
  test('Q-15 a shorter second AI run leaves no stale rows from the first', async () => {
    const { be } = await nightly();
    const run = async (a: AiSummariesInput) => { const w = await ReportWorkbook.open(be, ['*']); writeAiSummaries(w, a); await w.flush(); };
    await run(AI);
    assert.ok(allText(be).some((t) => t.includes('LONGMARKER')));
    await run({ ...AI, entries: [{ ticker: 'MSTR', gemini: 'Short.', opus: 'Short too.' }] });
    assert.ok(!allText(be).some((t) => t.includes('LONGMARKER') || t.includes('▸ AAPL')));
    assert.equal(colA(be).filter((t) => t === AI_ANCHOR).length, 1);
  });
  test('Q-16 the next nightly run clears the AI section back to the placeholder', async () => {
    const { be } = await nightly();
    const w = await ReportWorkbook.open(be, ['*']);
    writeAiSummaries(w, AI);
    await w.flush();
    assert.ok(allText(be).some((t) => t.includes('LONGMARKER')));
    const w2 = await ReportWorkbook.open(be, ['*']);
    const res = buildExitSheet(w2, input());
    await w2.flush();
    assert.ok(!allText(be).some((t) => t.includes('LONGMARKER')));
    assert.equal(colA(be)[res.anchors['AI']!], AI_PLACEHOLDER);
  });
  test('Q-17 AI run never creates a tab: missing tab and missing anchor write nothing', async () => {
    const be = new CountingBackend({ Portfolio: [['x']] });
    const w = await ReportWorkbook.open(be, ['*']);
    const r = writeAiSummaries(w, AI);
    await w.flush();
    assert.equal(r.written, false);
    assert.equal(be.applyCount, 0);
    assert.deepEqual((await be.listTabs()).map((t) => t.name), ['Portfolio']);
    const be2 = new CountingBackend({ [EXIT_SHEET_TAB]: [['just some text']] });
    const w2 = await ReportWorkbook.open(be2, ['*']);
    const r2 = writeAiSummaries(w2, AI);
    await w2.flush();
    assert.equal(r2.written, false);
    assert.equal(be2.applyCount, 0);
    assertNoReportLeaks([[r.message], [r2.message]]);
  });
});

describe('options sentiment part B: the market line in the banner (display only)', () => {
  test('shown when set, nothing else changes; absent = the same report', async () => {
    const line = 'Market options (2026-10-30, display only, feeds no score): SPY P/C 1.40, skew 6.1 pts, term normal, IV 30d 15% vs RV20 11% (hedging normal).';
    const a = await nightly(input()), b = await nightly({ ...input(), marketOptionsLine: line });
    assert.ok(allText(b.be).includes(line));
    const noRows = (t: string): string => t.replace(/\brow \d+/g, 'row N');
    assert.deepEqual(allText(b.be).filter((t) => t !== '' && t !== line).map(noRows), allText(a.be).filter((t) => t !== '').map(noRows), 'nothing else changed (row numbers shift)');
    const c = await nightly({ ...input(), marketOptionsLine: null });
    assert.deepEqual(allText(c.be), allText(a.be));
  });
});
