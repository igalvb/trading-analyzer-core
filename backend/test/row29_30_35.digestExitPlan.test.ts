/**
 * BACKLOG rows 29, 30, 35 (2026-10-31):
 *   29  the nightly digest to Telegram (the Buy and Exit PDFs only, the bottom line as the caption, the summary table
 *       on the first PDF's cover; clean policy 2026-11-05), never breaking the nightly;
 *   30  the exit plan page for a held ticker in the Analyze PDF;
 *   35  Exit audit leftovers: #7 jump links, #4 AI status in the banner, #30 Bitcoin momentum, #37 model scores,
 *       #44 AI facts (trailing stop, Bitcoin flag).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReportWorkbook, MemoryWorkbookBackend, callsToFormatOps } from '../src/sheets/reportSheet.ts';
import { formatOpsToRequests } from '../src/sheets/formatOps.ts';
import { formatStockSignals } from '../src/reports/exit/exitReport.ts';
import { buildExitSheet, writeAiSummaries, exitActionOf, EXIT_SHEET_TAB } from '../src/reports/exitSheet/exitSheet.ts';
import { T } from '../src/reports/exitSheet/text.ts';
import type { ExitHoldingInput, ExitReportInput, ModelRead } from '../src/reports/exitSheet/types.ts';
import { momentumText, withModelScores } from '../src/jobs/exit/exitReportAdapter.ts';
import { modelSignalsOf } from '../src/app/analysisCache.ts';
import { digestOf, digestTable, sendNightlyDigest, problemsOf, paperLine, nightlyCaption, type DigestCapture } from '../src/reports/digest/nightlyDigest.ts';
import { bottomLine, alertLine, CAPTION_MAX_CHARS } from '../src/notify/policy.ts';
import { newPaperState } from '../src/paper/paperTrading.ts';
import { runNightlyDigest } from '../src/nightly.ts';
import { sendTable, escapeHtml } from '../src/notify/telegram.ts';
import { exitFactsFor } from '../src/ai.ts';
import { stockTrailingStop } from '../src/jobs/exit/exitPipeline.ts';
import { heldRows, heldExitPlan } from '../src/reports/exitPlan.ts';
import { analyzeReportMain } from '../src/analyzeReport.ts';
import { ANALYSIS_TAB } from '../src/analysis/runTicker.ts';
import { createContext } from '../src/core/context.ts';
import { Logger } from '../src/core/logger.ts';
import { Tabs } from '../src/sheets/tabs.ts';
import type { RunSummary } from '../src/jobs/nightly/summary.ts';
import type { TickerJob } from '../src/ticker.ts';
import type { Chart } from '../src/types/chart.ts';

const NOW = new Date('2026-10-30T20:00:00Z');
const TOKEN = '123456:ABCdefGhIJKlmnoPQRstuVWxyz_0123456';

function stock(ticker: string, o: { stopBreached?: boolean; hitT1?: boolean } = {}): ExitHoldingInput {
  const sig = formatStockSignals({ chandelierSinceEntry: 210, stopBreached: !!o.stopBreached, t1: 260, t2: 300, hitT1: !!o.hitT1, hitT2: false, entryDateStr: '2025-01-10' }, true);
  return {
    ticker, kind: 'STOCK',
    position: { quantity: 10, avgCost: 200, entryDate: '2025-01-10', currentPrice: 250 },
    signals: sig,
    levels: { stopLevel: 210, stopBasis: 'SINCE_ENTRY', stopBreached: !!o.stopBreached, thesisInvalidated: false, t1: 260, hitT1: !!o.hitT1, t2: 300, hitT2: false },
    models: [
      { model: 'ENGINE', stance: 'BULLISH', score: null, conviction: 62 },
      { model: 'SCHABACKER', stance: 'BULLISH', score: null, signals: { pro: 3, con: 1 } },
      { model: 'TURTLE', stance: 'BEARISH', score: null },
    ],
    comparison: null, fundamentals: null, positioning: null, dataHealth: [],
  };
}

function exitInput(): ExitReportInput {
  return {
    runAt: NOW, holdings: [stock('TSLA'), stock('AAPL', { stopBreached: true }), stock('NVDA')],
    skipped: { crypto: [], otherStock: [], blankTickerRowCount: 0 },
    advisory: { distinctStockCount: 3, diversificationFlag: false, phaseRead: null, evaluativeIndexPctStrong: 61.6, dowTheoryVerdict: null, holdings: [] },
    dataHealth: [],
  };
}

function fakeTelegram(fail: Set<string> = new Set()) {
  const calls: Array<{ method: string; body: any }> = [];
  const fetchImpl = (async (url: string, init: { body: any }) => {
    const method = url.split('/').pop() as string;
    const b = init.body;
    calls.push({ method, body: typeof b === 'string' ? JSON.parse(b) : b instanceof FormData ? { name: (b.get('document') as File).name, caption: b.get('caption') } : b });
    if (fail.has(method)) return new Response(JSON.stringify({ ok: false, description: 'Bad Request' }), { status: 400 });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function summary(): RunSummary {
  return {
    runId: 'r', startedAtMs: 0, finishedAtMs: 1, durationMs: 1, overall: 'partial',
    steps: [{ id: 'buy.report', label: 'Buy report', state: 'ok', attempts: 1, durationMs: 1 }, { id: 'macro.refresh', label: 'Market-wide data refresh', state: 'failed', attempts: 3, durationMs: 1 }],
    tickers: [{ ticker: 'AAPL', sets: ['watchlist'], state: 'ok', attempts: 1, durationMs: 1 }, { ticker: 'BADX', sets: ['watchlist'], state: 'failed', attempts: 2, durationMs: 1 }],
    stepCounts: { ok: 1, degraded: 0, failed: 1, skipped: 0 }, tickerCounts: { ok: 1, degraded: 0, failed: 1, skipped: 0 },
  };
}

async function capture(): Promise<DigestCapture> {
  const wb = await ReportWorkbook.open(new MemoryWorkbookBackend({}), ['*']);
  const input = exitInput();
  buildExitSheet(wb, input);
  const buyWb = await ReportWorkbook.open(new MemoryWorkbookBackend({}), ['*']);
  const b = buyWb.insertSheet('🛒 Buy Report');
  b.getRange(1, 1).setValue('BUY REPORT');
  return {
    buy: { input: { runAt: NOW, candidates: [] }, result: { written: true, tab: '🛒 Buy Report', rowCount: 1, anchors: {}, order: [], tiers: { 1: ['NVDA', 'AVGO'], 2: [], 3: [] }, degraded: [] }, sheet: b },
    exit: { input, sheet: wb.getSheetByName(EXIT_SHEET_TAB) },
  };
}

const mkCtx = () => createContext({ mode: 'test', runId: 'r', logger: new Logger({ sink: () => {}, scope: 't', now: () => new Date(0) }), clock: { now: () => NOW.getTime() }, sleep: async () => {}, random: () => 0 });

function rising(ticker: string, n = 420): Chart {
  const dates: Date[] = [], o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [], v: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = 100 + i * 0.4 + Math.sin(i / 7) * 3;
    dates.push(new Date(Date.UTC(2025, 0, 2) + i * 86_400_000)); o.push(p - 0.5); h.push(p + 1.5); l.push(p - 1.5); c.push(p); v.push(1_000_000);
  }
  return { ticker, dates, opens: o, highs: h, lows: l, closes: c, volumes: v, splits: [], ipoDate: null, currentPrice: c[n - 1]!, prevClose: c[n - 2]!, currency: 'USD' } as Chart;
}

// ───────────────────────── row 29: the nightly digest ─────────────────────────

describe('row 29 — nightly digest', () => {
  test('the table: market, Buy Tier 1, Exit actions, paper, data problems; short lines only', async () => {
    const cap = await capture();
    const d = digestOf({ day: '30 Oct 2026', regime: 'RISK_ON', capture: cap, paper: null, summary: summary() });
    assert.deepEqual(d.buyTier1, ['NVDA', 'AVGO']);
    assert.deepEqual(d.exitActions, [['EXIT', 1], ['HOLD', 2]]);
    const t = digestTable(d);
    assert.match(t, /^Market {3}Risk on · EI 62%$/m);
    assert.match(t, /^Buy T1 {3}NVDA, AVGO$/m);
    assert.match(t, /^Exit {5}1 EXIT · 2 HOLD$/m);
    assert.match(t, /^Paper {4}no data$/m);
    assert.match(t, /^Data {5}failed: BADX$/m);
    assert.match(t, /^ {9}Market-wide data refresh\n {9}failed$/m, 'long items wrap under the value column');
    for (const line of t.split('\n')) assert.ok(line.length <= 40, 'phone width: ' + line);
  });

  test('paper: the top 3 accounts (benchmarks left out), QQQ and your 14', () => {
    const st = newPaperState(['AAPL']);
    st.marks.push({ day: '2026-10-29', values: { current: 104_000, turtle: 107_500, engine: 99_000, schabacker: 101_000, qqq: 101_800, basket: 120_000, 'lab.list14': 102_400 } });
    const p = paperLine(st)!;
    assert.deepEqual(p.leaders.map((l) => l.name + ' ' + l.ret), ['Turtle +7.5%', 'Engine + models (current rules) +4.0%', 'Schabacker +1.0%']);
    assert.equal(p.qqq, '+1.8%');
    assert.equal(p.list14, '+2.4%');
    const t = digestTable(digestOf({ day: 'd', capture: {}, paper: st, summary: null }));
    assert.match(t, /^Paper {4}\+7\.5% Turtle$/m);
    assert.match(t, /^QQQ {6}\+1\.8%$/m);
    assert.match(t, /^Your 14 {2}\+2\.4%$/m);
    assert.equal(paperLine(newPaperState(['AAPL'])), null, 'no closes yet');
  });

  test('not built / clean: says so in one word', () => {
    const clean: RunSummary = { ...summary(), steps: [], tickers: [], overall: 'ok' };
    const t = digestTable(digestOf({ day: 'd', regime: null, capture: {}, paper: null, summary: clean }));
    assert.match(t, /^Buy T1 {3}not built$/m);
    assert.match(t, /^Exit {5}not built$/m);
    assert.match(t, /^Data {5}OK$/m);
    assert.deepEqual(problemsOf(null), ['run did not finish']);
  });

  test('a normal nightly sends exactly its two PDFs, the bottom line as the first caption, and NO text message', async () => {
    const cap = await capture();
    const { calls, fetchImpl } = fakeTelegram();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r29-'));
    const htmls: string[] = [];
    const st = newPaperState(['AAPL']);
    st.marks.push({ day: '2026-10-29', values: { current: 104_000, turtle: 107_500, engine: 99_000, schabacker: 101_000, qqq: 101_800, basket: 120_000, 'lab.list14': 102_400 } });
    const data = digestOf({ day: '30 Oct 2026', regime: 'NEUTRAL', capture: cap, paper: st, summary: { ...summary(), steps: [], tickers: [], overall: 'ok' } });
    const sent = await sendNightlyDigest({
      telegram: { deps: { token: TOKEN, fetchImpl }, chatId: '42' }, toPdf: async (h, p) => { htmls.push(h); fs.writeFileSync(p, '%PDF'); },
      log: () => {}, timeZone: 'America/New_York', now: NOW.getTime(), outDir: dir, footer: ['GitHub minutes this month: ~412 of 2,000 (est.)'],
    }, data, cap);
    assert.equal(sent.message, false, 'no text message');
    assert.deepEqual(sent.pdfs, ['v13-nightly-buy-20261030.pdf', 'v13-nightly-exit-20261030.pdf']);
    assert.deepEqual(calls.map((c) => c.method), ['sendDocument', 'sendDocument'], 'PDFs only');
    assert.equal(calls[0]!.body.caption, 'Nightly 30 Oct: 2 BUY · 1 EXIT, 2 HOLD · paper +7.5% (QQQ +1.8%)');
    assert.equal(calls[0]!.body.caption, nightlyCaption(data));
    assert.equal(calls[1]!.body.caption, null, 'one bottom line on the first PDF is enough');
    assert.ok(htmls[0]!.includes('BUY REPORT') && htmls[1]!.includes('EXIT REPORT'));
    // What used to be the Telegram table is on the first PDF's cover, with the minutes line.
    assert.match(htmls[0]!, /Market {3}Neutral/);
    assert.match(htmls[0]!, /Buy T1 {3}NVDA, AVGO/);
    assert.match(htmls[0]!, /GitHub minutes this month: ~412 of 2,000/);
    assert.ok(!htmls[1]!.includes('Buy T1'), 'the summary is on the first PDF only');
  });

  test('the caption: at most 2 lines and about 200 characters; data problems on line 2', async () => {
    const cap = await capture();
    const c = nightlyCaption(digestOf({ day: '30 Oct 2026', regime: 'NEUTRAL', capture: cap, paper: null, summary: summary() }));
    assert.match(c, /^Nightly 30 Oct: 2 BUY · 1 EXIT, 2 HOLD\n⚠️ 2 data problem\(s\): failed: BADX; Market-wide data refresh failed$/);
    const long = bottomLine('Head', ['x'.repeat(500)], 'y'.repeat(500));
    assert.ok(long.length <= CAPTION_MAX_CHARS && long.split('\n').length === 2, long);
    assert.equal(bottomLine('A', ['b\nc', null, '', 'd']), 'A: b · c · d');
    assert.equal(alertLine('one\ntwo'), 'one · two');
    assert.equal(nightlyCaption(digestOf({ day: 'd', capture: {}, paper: null, summary: { ...summary(), steps: [], tickers: [], overall: 'ok' } })), 'Nightly d: Buy not built · Exit not built');
  });

  test('never throws: Telegram down, the PDF maker failing, no browser (then ONE plain line)', async () => {
    const cap = await capture();
    const logs: string[] = [];
    const down = fakeTelegram(new Set(['sendMessage', 'sendDocument']));
    const r1 = await sendNightlyDigest({ telegram: { deps: { token: TOKEN, fetchImpl: down.fetchImpl }, chatId: '42' }, toPdf: async () => { throw new Error('chrome crashed'); }, log: (m) => logs.push(m), timeZone: 'UTC', now: 0 },
      digestOf({ day: 'd', capture: cap, paper: null, summary: null }), cap);
    assert.deepEqual(r1, { message: false, pdfs: [] });
    assert.ok(logs.some((l) => l.includes('PDF not made')) && logs.some((l) => l.includes('alert line could not be sent')), logs.join('\n'));
    assert.ok(!logs.join('\n').includes(TOKEN), 'the bot key is never logged');
    const ok = fakeTelegram();
    const r2 = await sendNightlyDigest({ telegram: { deps: { token: TOKEN, fetchImpl: ok.fetchImpl }, chatId: '42' }, toPdf: null, log: () => {}, timeZone: 'UTC', now: 0 },
      digestOf({ day: 'd', capture: cap, paper: null, summary: null }), cap);
    assert.equal(r2.message, true);
    assert.equal(r2.pdfs.length, 0);
    assert.equal(ok.calls.length, 1);
    assert.ok(!ok.calls[0]!.body.text.includes('\n'), 'one line');
    assert.match(ok.calls[0]!.body.text, /^Nightly d: 2 BUY · 1 EXIT, 2 HOLD · .*⚠️ PDFs not made \(no browser\)$/);
  });

  test('runNightlyDigest: a failing regime read and an unreadable paper state are logged, the PDFs still go', async () => {
    const cap = await capture();
    const { calls, fetchImpl } = fakeTelegram();
    const logs: string[] = [];
    const htmls: string[] = [];
    const store = { read: async () => { throw new Error('tab gone'); } } as never;
    const r = await runNightlyDigest({
      app: { digest: cap }, summary: summary(), store, timeZone: 'America/New_York', now: NOW.getTime(), log: (m) => logs.push(m),
      regime: async () => { throw new Error('macro down'); }, telegram: { deps: { token: TOKEN, fetchImpl }, chatId: '42' },
      toPdf: async (h, p) => { htmls.push(h); fs.writeFileSync(p, '%PDF'); }, outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'r29b-')),
    });
    assert.equal(r.pdfs.length, 2);
    assert.deepEqual(calls.map((c) => c.method), ['sendDocument', 'sendDocument']);
    assert.match(htmls[0]!, /Market {3}not read · EI 62%/);
    assert.ok(logs.some((l) => l.includes('market regime not read')) && logs.some((l) => l.includes('paper test not read')));
  });

  test('row 38: the GitHub minutes line ends the summary on the first PDF; a failing reader gives "could not read"', async () => {
    const cap = await capture();
    const cases: Array<[() => Promise<string>, string]> = [
      [async () => 'GitHub minutes this month: ~412 of 2,000 (est.)', 'GitHub minutes this month: ~412 of 2,000 (est.)'],
      [async () => { throw new Error('boom'); }, 'GitHub minutes: could not read'],
    ];
    for (const [reader, want] of cases) {
      const { calls, fetchImpl } = fakeTelegram();
      const htmls: string[] = [];
      await runNightlyDigest({
        app: { digest: cap }, summary: summary(), store: { read: async () => [] } as never, timeZone: 'America/New_York', now: NOW.getTime(), log: () => {},
        regime: async () => 'RISK_ON', telegram: { deps: { token: TOKEN, fetchImpl }, chatId: '42' },
        toPdf: async (h, p) => { htmls.push(h); fs.writeFileSync(p, '%PDF'); }, outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'r29c-')), minutesLine: reader,
      });
      assert.ok(calls.length === 2 && calls.every((c) => c.method === 'sendDocument'), 'no text message');
      assert.ok(htmls[0]!.includes(want), want);
    }
  });

  test('sendTable escapes report text (it can never break the markup)', async () => {
    const { calls, fetchImpl } = fakeTelegram();
    await sendTable({ token: TOKEN, fetchImpl }, '1', 'A & B', 'x <b> y');
    assert.equal(calls[0]!.body.text, '<b>A &amp; B</b>\n<pre>x &lt;b&gt; y</pre>');
    assert.equal(escapeHtml('"<&>"'), '&quot;&lt;&amp;&gt;&quot;');
  });
});

// ───────────────────────── row 35: exit audit leftovers ─────────────────────────

describe('row 35 — Exit report leftovers', () => {
  test('#7 the table of contents and the AI pointers are clickable jump links to the right rows', async () => {
    const wb = await ReportWorkbook.open(new MemoryWorkbookBackend({}), ['*']);
    const res = buildExitSheet(wb, exitInput());
    const sh = wb.getSheetByName(EXIT_SHEET_TAB)!;
    const links = callsToFormatOps(sh.calls).filter((o) => o.op === 'rowLink') as Array<{ range: { row: number; col: number }; value: number }>;
    const grid = sh.grid();
    const toc = links.filter((l) => l.range.col === 6);
    assert.equal(toc.length, 3);
    for (const l of toc) assert.equal(String(grid[l.range.row - 1]![5]), 'Go to row ' + l.value);
    assert.ok(links.filter((l) => l.value === res.anchors['AI']).length >= 4, 'banner + one per holding');
    const req = formatOpsToRequests(77, [{ op: 'rowLink', range: { row: 5, col: 6, numRows: 1, numCols: 1 }, value: 40 }]);
    assert.deepEqual(req[0]!.repeatCell!.cell!.userEnteredFormat!.textFormat!.link, { uri: '#gid=77&range=A40' });
  });

  test('#4 the banner states the AI status: pending after the nightly, written after the AI run', async () => {
    const be = new MemoryWorkbookBackend({});
    const wb = await ReportWorkbook.open(be, ['*']);
    const res = buildExitSheet(wb, exitInput());
    await wb.flush();
    assert.equal(String(be.grid(EXIT_SHEET_TAB)[2]![0]), T.aiStatusPending(res.anchors['AI']!));
    const w2 = await ReportWorkbook.open(be, ['*']);
    writeAiSummaries(w2, { ranAt: NOW, geminiUsed: true, opusMode: 'REVIEW', effort: 'high', entries: [{ ticker: 'TSLA', gemini: 'Hold.', opus: 'Agree.' }] });
    await w2.flush();
    const banner = String(be.grid(EXIT_SHEET_TAB)[2]![0]);
    assert.match(banner, /^AI review: written .* · Gemini used · Opus REVIEW\. See the AI SUMMARIES section at row \d+\.$/);
  });

  test('#37 the Score column: engine conviction, a book model\'s signal count', async () => {
    const wb = await ReportWorkbook.open(new MemoryWorkbookBackend({}), ['*']);
    buildExitSheet(wb, exitInput());
    const rows = wb.getSheetByName(EXIT_SHEET_TAB)!.grid().map((r) => r.map(String));
    assert.ok(rows.some((r) => r[0] === 'Engine' || r[2] === '62/100 conviction'), 'engine row');
    assert.ok(rows.some((r) => r[2] === '62/100 conviction'));
    assert.ok(rows.some((r) => r[2] === '3 for · 1 against'));
    const reads = withModelScores({ models: [{ model: 'ENGINE', stance: 'BULLISH', score: null }, { model: 'TURTLE', stance: 'BEARISH', score: null }, { model: 'SCHABACKER', stance: 'UNAVAILABLE', score: null }] as ModelRead[], comparison: null },
      { decision: { finalConviction: 55 }, modelSignals: { TURTLE: { pro: 1, con: 4 }, SCHABACKER: { pro: 2, con: 2 } } });
    assert.deepEqual(reads.models.map((m) => [m.model, m.stance, m.conviction ?? null, m.signals ?? null]), [['ENGINE', 'BULLISH', 55, null], ['TURTLE', 'BEARISH', null, { pro: 1, con: 4 }], ['SCHABACKER', 'UNAVAILABLE', null, null]], 'stances unchanged');
    assert.deepEqual(modelSignalsOf({ reports: { turtle: { synthesis: { bullish: ['a'], cautionary: ['b', 'c'] } }, broker: null } } as never), { TURTLE: { pro: 1, con: 2 } });
  });

  test('#30 the Bitcoin momentum row comes from the weekly RSI', () => {
    assert.equal(momentumText(58), 'Weekly RSI 58.0: healthy, rising.');
    assert.equal(momentumText(25.04), 'Weekly RSI 25.0: oversold, sellers in control.');
    assert.equal(momentumText(null), null);
  });

  test('#44 the Exit AI facts carry the trailing stop and the Bitcoin flag', () => {
    const h = { ticker: 'IBIT', shares: 10, avgCost: 40, entryDate: null, rowNumber: 3 };
    const f = exitFactsFor(h, 50, 44.5, ['IBIT', 'GBTC', 'TSLA']);
    assert.equal(f.trailingStop, 44.5);
    assert.equal(f.bitcoinEtfSharedThesis, true);
    assert.equal(f.unrealizedPct, 25);
    assert.equal(exitFactsFor({ ...h, ticker: 'TSLA' }, 50, null, ['IBIT', 'GBTC', 'TSLA']).bitcoinEtfSharedThesis, false);
    assert.equal(exitFactsFor(h, 50, null, ['IBIT', 'TSLA']).bitcoinEtfSharedThesis, false, 'one Bitcoin ETF shares no thesis');
    const stop = stockTrailingStop('TEST', 120, null, rising('TEST'));
    assert.ok(typeof stop === 'number' && stop > 0 && stop < rising('TEST').currentPrice);
  });

  test('exitActionOf: the sheet\'s own one-word action', () => {
    assert.equal(exitActionOf(stock('A')), 'HOLD');
    assert.equal(exitActionOf(stock('B', { stopBreached: true })), 'EXIT');
  });
});

// ───────────────────────── row 30: exit plan in Analyze ─────────────────────────

describe('row 30 — exit plan for a held ticker in Analyze', () => {
  const PORTFOLIO = [
    ['Ticker', 'type', 'sub-type', 'amount', 'cost avg per stock'],
    ['TEST', 'stock', '', 10, 120],
    ['OTHER', 'stock', '', 5, 50],
  ];
  const services = (grid: unknown[][]) => ({
    ctx: mkCtx(), sheets: null, clock: { now: () => NOW.getTime() }, timeZone: 'America/New_York',
    openWorkbook: async () => ReportWorkbook.open(new MemoryWorkbookBackend({ [Tabs.PORTFOLIO]: grid as never }), ['*']),
    fetchChart: async (t: string) => rising(t),
  }) as never;

  test('heldRows: only that ticker; null when not held', () => {
    const p = { stocks: [{ ticker: 'TEST', shares: 1, avgCost: 1, entryDate: null, rowNumber: 2 }], options: [], skippedCrypto: ['BTC'], skippedOther: [], blankRowCount: 3 };
    assert.equal(heldRows(p, 'test')!.stocks.length, 1);
    assert.equal(heldRows(p, 'NOPE'), null);
  });

  test('a held ticker gets its Exit page (scratch workbook, the real tabs untouched); not held = null', async () => {
    const plan = await heldExitPlan(services(PORTFOLIO), 'TEST', null);
    assert.ok(plan);
    assert.equal(plan.actions.length, 1);
    const text = plan.sheet.grid().flat().map(String).join('\n');
    assert.ok(text.includes('═══ TEST ═══') && !text.includes('OTHER'));
    assert.equal(await heldExitPlan(services(PORTFOLIO), 'NVDA', null), null);
    assert.equal(await heldExitPlan({ ...(services(PORTFOLIO) as object), openWorkbook: async () => { throw new Error('sheet down'); } } as never, 'TEST', null), null, 'a failure costs only the page');
  });

  test('Analyze: the plan is the first page after the cover and the caption says the action', async () => {
    const wb = await ReportWorkbook.open(new MemoryWorkbookBackend({}));
    wb.insertSheet(ANALYSIS_TAB).getRange(1, 1).setValue('ANALYSIS PAGE');
    const job: TickerJob = { code: 0, ticker: 'TEST', workbook: wb, timeZone: 'America/New_York', art: { result: { decision: { action: 'Hold' } }, dataQuality: [], chart: { currentPrice: 10 } } as never, chartHtml: null, lockLines: [], produced: new Set([ANALYSIS_TAB]) };
    const plan = await heldExitPlan(services(PORTFOLIO), 'TEST', null);
    const { calls, fetchImpl } = fakeTelegram();
    let html = '';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r30-'));
    const code = await analyzeReportMain(['TEST', '--out', dir], { out: () => {}, err: () => {}, env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42' } }, {
      run: async () => job, exitPlan: async () => plan, toPdf: async (h, p) => { html = h; fs.writeFileSync(p, '%PDF'); }, fetchImpl, now: () => NOW.getTime(),
    });
    assert.equal(code, 0);
    assert.ok(html.indexOf('═══ TEST ═══') > 0 && html.indexOf('═══ TEST ═══') < html.indexOf('ANALYSIS PAGE'));
    assert.deepEqual(calls.map((c) => c.method), ['sendDocument'], 'the PDF only');
    assert.match(String(calls[0]!.body.caption), /^TEST — Hold: \$10\.00 · held: (HOLD|EXIT|REVIEW|TRIM|TARGET HIT|NO VERDICT)/);
    const failing = fakeTelegram();
    const code2 = await analyzeReportMain(['TEST', '--out', dir], { out: () => {}, err: () => {}, env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42' } }, {
      run: async () => job, exitPlan: async () => { throw new Error('boom'); }, toPdf: async (_h, p) => { fs.writeFileSync(p, '%PDF'); }, fetchImpl: failing.fetchImpl, now: () => NOW.getTime(),
    });
    assert.equal(code2, 0, 'the report still goes without the plan');
    assert.ok(!String(failing.calls[0]!.body.caption).includes('held'));
  });
});
