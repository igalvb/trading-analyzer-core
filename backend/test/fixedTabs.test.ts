/**
 * Phase 1 of docs/SHEETS_CLEANUP_PLAN.md, section (c): the fixed analysis tabs (src/reports/fixedTabs.ts).
 *   - every run writes the same 30 tabs, whatever the ticker; row 1 of each names the ticker and the run time;
 *   - the reset at the start of a run is a full clear (values, formats, merges -- F-84) plus one title line;
 *   - the PDF prints only the pages the run produced: the same section list as before phase 1;
 *   - legacy-parity keeps the old per-ticker names; `npm run cleanup-report-tabs` removes only those.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixturesPresent } from './fixtures.ts';
import { fixtureBodies, clockAfterFixtures } from './fl7b2Fixtures.ts';
import { chainJson, DAYS_ALL, MULTS } from './cboeFixtures.ts';
import { HttpResponse, type HttpRequest, type HttpTransport } from '../src/net/http.ts';
import { runTickerJob, type TickerJob } from '../src/ticker.ts';
import { reportTabOrder, reportHtml } from '../src/analyzeReport.ts';
import { runMenuCommand } from '../src/app/menuCommands.ts';
import { ReportWorkbook, MemoryWorkbookBackend, callsToFormatOps } from '../src/sheets/reportSheet.ts';
import { formatOpsToRequests } from '../src/sheets/formatOps.ts';
import { ANALYSIS_TAB, MODEL_TABS } from '../src/analysis/runTicker.ts';
import { OptionsTabs } from '../src/reports/options/tabs.ts';
import {
  FIXED_ANALYSIS_TABS, resetFixedAnalysisTabs, producedTabs, finishFixedAnalysisTabs, rowOneNamesRun, notProducedLine, runTimeText,
} from '../src/reports/fixedTabs.ts';
import { buildBottomLineSummary, bottomLineTabName, BOTTOM_LINE_TAB } from '../src/reports/bottomLine/summarySheet.ts';
import { priceChartTabName, PRICE_CHART_TAB } from '../src/ops/priceChart.ts';
import { positionTabName, POSITION_TAB } from '../src/portfolio/positions/analyzePosition.ts';
import { isOldReportTab, runCleanupReportTabs, LEGACY_UNUSED_TABS, type CleanupSheets } from '../src/cleanupReportTabs.ts';
import { createContext } from '../src/core/context.ts';
import { LogLevel } from '../src/core/logger.ts';

const ready = fixturesPresent();
const TZ = 'America/New_York';
const ENV = { SEC_CONTACT_EMAIL: 'contact@example.org', SCRIPT_TIME_ZONE: TZ };

/** Yahoo charts from the fixtures, and a synthetic Cboe chain for TSLA (so the options step produces its tabs). */
class FakeNet implements HttpTransport {
  private readonly bodies: Record<string, string>;
  private readonly nowMs: number;
  constructor(nowMs: number) { this.bodies = fixtureBodies(); this.nowMs = nowMs; }
  async send(req: HttpRequest): Promise<HttpResponse> {
    const cboe = /delayed_quotes\/options\/_?([^/?]+)\.json/.exec(req.url);
    if (cboe && cboe[1] === 'TSLA') {
      return new HttpResponse(200, new TextEncoder().encode(chainJson(7, { root: 'TSLA', spot: 360, nowMs: this.nowMs, days: DAYS_ALL, strikeMults: MULTS, maxOi: 50000 })));
    }
    const m = /\/v8\/finance\/chart\/([^?]+)\?interval=1d&range=2y/.exec(req.url);
    const t = m ? decodeURIComponent(m[1]) : null;
    if (t && this.bodies[t]) return new HttpResponse(200, new TextEncoder().encode(this.bodies[t]));
    return new HttpResponse(404, new TextEncoder().encode('not found'));
  }
}

const quiet = { out: () => {}, err: () => {}, env: ENV };

async function run(argv: string[], initialTabs?: Record<string, unknown[][]>): Promise<TickerJob> {
  const clock = clockAfterFixtures();
  return runTickerJob([...argv, '--memory', '--no-ai'], quiet, { transport: new FakeNet(clock.now()), clock, ...(initialTabs ? { initialTabs } : {}), outDir: os.tmpdir() });
}

/** The PDF's section list: reportHtml prints these tabs, in this order (and nothing else). */
const sections = (job: TickerJob): string[] => reportTabOrder().filter((n) => job.produced.has(n));

/**
 * The section lists the pre-phase-1 rule (`calls.length || created`, per-ticker Bottom Line name) gave on these
 * same fixture runs, recorded before the change. The PUT Table is left out, as before.
 */
// (James's models, phase 1, added its two pages after LILO: '🪜 James — LILO v2', '💰 James — Profit-Taking'; phase 3 added
// '🪤 James — Market Maker Stages' after the Wyckoff page and '🔄 James — Multi-Year Cycle' after Winners & Layering; phase 4 added
// '🎯 James — LEAPS' and '⚖️ James — Option Fair Value' after the Options Decision page; phase 5 added '✅ James — Quality Gate'
// after the Multi-Year Cycle page)
const BEFORE_FULL = [
  BOTTOM_LINE_TAB, '🧮 All Models', ANALYSIS_TAB, '📚 Broker Model', '📜 Schabacker Model', '📖 Edwards & Magee Model', '🐢 Turtle Model',
  '🏛️ Wyckoff Model', '🪤 James — Market Maker Stages', '📈 Trend Model', '🧩 Combo Models', '🪜 LILO Model', '🪜 James — LILO v2', '💰 James — Profit-Taking', '↩️ James — Mean Reversion', '🔁 James — Pair Rotation', '🏆 James — Winners & Layering', '🔄 James — Multi-Year Cycle', '✅ James — Quality Gate', '🔀 Model Comparison', '📞 Options Decision', '🎯 James — LEAPS', '⚖️ James — Option Fair Value',
  '📋 Dashboard', '🏆 Top 10 Conviction', '📞 CALL Table', '📆 Near／Mid／LEAPS', '🧱 Gamma Wall',
];
const BEFORE_STOCK_ONLY = BEFORE_FULL.filter((n) => n !== BOTTOM_LINE_TAB && !(Object.values(OptionsTabs) as string[]).includes(n));

describe('Phase 1 — the fixed tab list and names', () => {
  test('30 distinct fixed tabs: Bottom Line, Price Chart, Analysis v7, the 21 model pages (ten of them James — ...), the 6 options tabs', () => {
    assert.equal(FIXED_ANALYSIS_TABS.length, 30);
    assert.equal(new Set(FIXED_ANALYSIS_TABS).size, 30);
    for (const t of [BOTTOM_LINE_TAB, PRICE_CHART_TAB, ANALYSIS_TAB, ...Object.values(MODEL_TABS),
      OptionsTabs.DASHBOARD, OptionsTabs.TOP10, OptionsTabs.CALLS, OptionsTabs.PUTS, OptionsTabs.GAMMA, OptionsTabs.BUCKETS]) assert.ok(FIXED_ANALYSIS_TABS.includes(t), t);
    assert.equal(BOTTOM_LINE_TAB, '📋 Bottom Line');
    assert.equal(PRICE_CHART_TAB, '📊 Price Chart');
    assert.equal(POSITION_TAB, '📌 Position');
    // every PDF page is a fixed tab; the PUT Table stays out of the PDF
    for (const t of reportTabOrder()) assert.ok(FIXED_ANALYSIS_TABS.includes(t), t);
    assert.ok(!reportTabOrder().includes(OptionsTabs.PUTS));
  });

  test('legacy-parity keeps the old per-ticker names', async () => {
    assert.equal(bottomLineTabName('TSLA'), '📋 Bottom Line');
    assert.equal(bottomLineTabName('TSLA', true), '📋 Bottom Line — TSLA');
    assert.equal(priceChartTabName('TSLA'), '📊 Price Chart');
    assert.equal(priceChartTabName('TSLA', true), '📊 TSLA Chart');
    assert.equal(positionTabName('TSLA'), '📌 Position');
    assert.equal(positionTabName('TSLA', true), '📌 Position — TSLA');
    const deps = { clock: { now: () => Date.UTC(2026, 9, 29, 19) }, timeZone: TZ };
    const wb = await ReportWorkbook.open(new MemoryWorkbookBackend({}));
    buildBottomLineSummary(wb, 'TSLA', null, {}, null, null, null, deps);
    buildBottomLineSummary(wb, 'TSLA', null, {}, null, null, null, { ...deps, legacyReportText: true });
    assert.deepEqual(wb.getSheets().map((s) => s.getName()), ['📋 Bottom Line', '📋 Bottom Line — TSLA']);
    assert.match(String(wb.getSheetByName(BOTTOM_LINE_TAB)!.grid()[0][0]), /^📋 BOTTOM LINE — TSLA {3}\| {3}10\/29\/2026, 3:00:00 PM$/);
  });
});

describe('Phase 1 — the reset', () => {
  test('a full clear (values, formats and merges) and one title line; on Analysis v7 the line keeps the "📊 TICKER —" prefix', async () => {
    const backend = new MemoryWorkbookBackend({ [ANALYSIS_TAB]: [['📊 TSLA — Investor Briefing', 'x'], ['old', 'rows']], '🔬 Log': [['keep me']] });
    const wb = await ReportWorkbook.open(backend, ['*']);
    const a = wb.getSheetByName(ANALYSIS_TAB)!;
    a.getRange(1, 1, 1, 4).merge().setBackground('#1a237e'); // a stale merge and colour (in the real Sheet they come from the last run)
    const nowMs = Date.UTC(2026, 9, 29, 19);
    const reset = resetFixedAnalysisTabs(wb, 'NVDA', nowMs, TZ);
    assert.equal(a.merges.length, 0);
    const ops = callsToFormatOps(a.calls);
    assert.deepEqual(ops.slice(ops.map((o) => o.op).lastIndexOf('clearFormats')), [{ op: 'clearFormats' }], 'nothing formatted after the clear');
    // in the real Sheet the clear also unmerges (F-84)
    assert.deepEqual(formatOpsToRequests(9, [{ op: 'clearFormats' }])[0], { unmergeCells: { range: { sheetId: 9 } } });
    assert.deepEqual(a.grid(), [[notProducedLine('NVDA', runTimeText(nowMs, TZ))]]);
    assert.match(String(a.grid()[0][0]), /^📊 NVDA — not produced in the run of 10\/29\/2026, 3:00:00 PM; details in the 🔬 Log$/);
    assert.equal(String(a.grid()[0][0]).match(/📊\s+([A-Z.]+)\s+—/)?.[1], 'NVDA', 'priceChart.ts reads the ticker from it');
    // every fixed tab exists, each with only the title line; other tabs are untouched
    for (const t of FIXED_ANALYSIS_TABS) {
      const sh = wb.getSheetByName(t)!;
      assert.equal(sh.grid().length, 1, t);
      assert.ok(rowOneNamesRun(sh, 'NVDA'), t);
    }
    assert.equal(wb.getSheetByName('🔬 Log')!.calls.length, 0);
    assert.deepEqual(producedTabs(wb, reset), new Set());
    // a page written after the reset is produced, and its row 1 gets the run time when it lacks one
    const b = wb.getSheetByName(MODEL_TABS.broker)!;
    b.clearContents(); b.clearFormats(); b.getRange(1, 1).setValue('── NVDA — Broker Course Model v1 ──');
    const c = wb.getSheetByName(PRICE_CHART_TAB)!;
    c.clearContents(); c.getRange(1, 1, 1, 3).setValues([['Date', 'Close', 'High']]);
    const produced = finishFixedAnalysisTabs(wb, reset);
    assert.deepEqual([...produced], [MODEL_TABS.broker, PRICE_CHART_TAB]);
    assert.equal(b.grid()[0][0], '── NVDA — Broker Course Model v1 ──   |   10/29/2026, 3:00:00 PM');
    assert.deepEqual(c.grid()[0], ['Date', 'Close', 'High', '', 'NVDA — 📊 Price Chart   |   10/29/2026, 3:00:00 PM']);
    await wb.flush();
    // what reaches the backend: the stale merge, then the clear, then nothing (the clear wins)
    const sent = backend.formats.get(ANALYSIS_TAB)!.map((o) => o.op);
    assert.ok(sent.lastIndexOf('clearFormats') > sent.indexOf('merge'));
    assert.equal(sent.lastIndexOf('clearFormats'), sent.length - 1);
    assert.equal(backend.grid(ANALYSIS_TAB).length, 1);
  });
});

describe('Phase 1 — runs on one workbook', { skip: ready ? false : 'fixtures missing' }, () => {
  test('TSLA (full) then NVDA (--stock-only): the same 30 tabs; row 1 names the current ticker; unproduced pages show the reset line and stay out of the PDF', async () => {
    const tsla = await run(['TSLA']);
    assert.equal(tsla.code, 0);
    const wb1 = tsla.workbook!;
    // the full run produces all 30, and row 1 of every one names TSLA and the run time
    assert.deepEqual([...tsla.produced].sort(), [...FIXED_ANALYSIS_TABS].sort());
    for (const t of FIXED_ANALYSIS_TABS) assert.ok(rowOneNamesRun(wb1.getSheetByName(t)!, 'TSLA'), t + ': ' + JSON.stringify(wb1.getSheetByName(t)!.grid()[0]));
    assert.ok(!wb1.getSheets().some((s) => isOldReportTab(s.getName())), 'no per-ticker tab');

    // NVDA starts from the workbook TSLA left
    const seed: Record<string, unknown[][]> = {};
    for (const s of wb1.getSheets()) seed[s.getName()] = s.grid();
    const nvda = await run(['NVDA', '--stock-only'], seed);
    assert.equal(nvda.code, 0);
    const wb2 = nvda.workbook!;
    const fixedIn = (wb: ReportWorkbook): string[] => wb.getSheets().map((s) => s.getName()).filter((n) => FIXED_ANALYSIS_TABS.includes(n)).sort();
    assert.deepEqual(fixedIn(wb2), fixedIn(wb1), 'same tab-name set');
    assert.equal(fixedIn(wb2).length, 30);
    assert.deepEqual(wb2.getSheets().map((s) => s.getName()).sort(), wb1.getSheets().map((s) => s.getName()).sort(), 'no new tab for a new ticker');
    for (const t of FIXED_ANALYSIS_TABS) {
      const sh = wb2.getSheetByName(t)!;
      assert.ok(rowOneNamesRun(sh, 'NVDA'), t + ': ' + JSON.stringify(sh.grid()[0]));
      assert.ok(!sh.grid().flat().some((v) => String(v).includes('TSLA')), t + ' still shows TSLA');
    }
    const notProduced = FIXED_ANALYSIS_TABS.filter((t) => !nvda.produced.has(t));
    assert.deepEqual(notProduced.sort(), [BOTTOM_LINE_TAB, PRICE_CHART_TAB, ...Object.values(OptionsTabs).filter((t) => t !== OptionsTabs.LOG)].sort());
    for (const t of notProduced) assert.match(String(wb2.getSheetByName(t)!.grid()[0][0]), /^📊 NVDA — not produced in the run of .*; details in the 🔬 Log$/, t);
    const html = reportHtml(nvda, Date.UTC(2026, 9, 29, 19));
    assert.ok(!html.includes('not produced'), 'an unproduced page is not in the PDF');
    assert.ok(!html.includes('Options Dashboard'));
  });

  test('the PDF section list is the same as before phase 1, for a full and a --stock-only run', async () => {
    const full = await run(['TSLA']);
    assert.deepEqual(sections(full), BEFORE_FULL);
    const html = reportHtml(full, Date.UTC(2026, 9, 29, 19));
    assert.ok(!html.includes('not produced') && html.includes('TSLA Options Dashboard'));
    assert.ok(!html.includes('All PUT options'), 'the PUT Table stays out of the PDF');
    const stockOnly = await run(['TSLA', '--stock-only']);
    assert.deepEqual(sections(stockOnly), BEFORE_STOCK_ONLY);
    assert.ok(!reportHtml(stockOnly, Date.UTC(2026, 9, 29, 19)).includes('not produced'));
  });

  test('cli chart without a ticker still works after a reset (the ticker comes from the Analysis v7 reset line)', async () => {
    const clock = clockAfterFixtures();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-tabs-chart-'));
    const out: string[] = [];
    const code = await runMenuCommand('chart', ['--memory'], { out: (s) => out.push(s), err: () => {}, env: ENV }, {
      transport: new FakeNet(clock.now()), clock, outDir: dir,
      initialTabs: { [ANALYSIS_TAB]: [[notProducedLine('NVDA', runTimeText(clock.now(), TZ))]] },
    });
    assert.equal(code, 0, out.join(''));
    assert.match(out.join(''), /Price chart for NVDA written to .*NVDA-chart\.html \(its data is on the 📊 Price Chart tab\)/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Phase 1 — npm run cleanup-report-tabs', () => {
  test('only the two exact per-ticker patterns', () => {
    for (const n of ['📋 Bottom Line — TSLA', '📋 Bottom Line — BRK.B', '📋 Bottom Line — BTC-USD', '📊 TSLA Chart', '📊 ^VIX Chart']) assert.ok(isOldReportTab(n), n);
    for (const n of ['📋 Bottom Line', '📊 Price Chart', '📊 Analysis v7', '📌 Position — TSLA', '📋 Bottom Line — tsla', '📋 Bottom Line —TSLA',
      ' 📊 TSLA Chart', '📊 TSLA Chart ', '📊 TSLA chart', '📊 TSLA  Chart', '📋 Bottom Line — TSLA x', 'Personal tab 2', 'DASHBOARD', '💾 TSLA', '📊 TOOLONGTICKER1 Chart']) assert.ok(!isOldReportTab(n), n);
  });

  const env = { GOOGLE_SERVICE_ACCOUNT_JSON: '{}', SPREADSHEET_ID: 'x' };
  const ctx = createContext({ mode: 'test', minLevel: LogLevel.ERROR });
  function fake() {
    const sent: unknown[] = [];
    const sheets = {
      tabIds: async () => ({ ok: true, value: { 'Portfolio': 1, '📋 Bottom Line — TSLA': 2, '📊 TSLA Chart': 3, '📋 Bottom Line': 4, '📊 Price Chart': 5, '📌 Position — TSLA': 6, 'Personal tab 2': 7 } }),
      formatBatch: async (_c: unknown, reqs: unknown[]) => { sent.push(...reqs); return { ok: true, value: reqs.length }; },
    } as unknown as CleanupSheets;
    return { sheets, sent };
  }

  test('dry run by default: lists the matches, deletes nothing', async () => {
    const { sheets, sent } = fake();
    const out: string[] = [];
    assert.equal(await runCleanupReportTabs({ env, argv: [], out: (l) => out.push(l), errOut: () => {}, makeSheets: () => sheets, ctx }), 0);
    assert.deepEqual(sent, []);
    assert.match(out.join('\n'), /2 old per-ticker report tab\(s\) found/);
    assert.match(out.join('\n'), /Dry run/);
  });

  test('--yes deletes exactly the matches, in one batch; missing configuration exits 2', async () => {
    const { sheets, sent } = fake();
    assert.equal(await runCleanupReportTabs({ env, argv: ['--yes'], out: () => {}, errOut: () => {}, makeSheets: () => sheets, ctx }), 0);
    assert.deepEqual(sent, [{ deleteSheet: { sheetId: 3 } }, { deleteSheet: { sheetId: 2 } }]);
    const err: string[] = [];
    assert.equal(await runCleanupReportTabs({ env: {}, argv: ['--yes'], out: () => {}, errOut: (l) => err.push(l), makeSheets: () => sheets, ctx }), 2);
    assert.match(err.join(''), /SPREADSHEET_ID/);
  });

  test('--legacy-tabs (owner 2026-11-04): opt-in only; deletes the two unused legacy tabs in My Portfolio and the reports sheet', async () => {
    assert.deepEqual([...LEGACY_UNUSED_TABS], ['🎯 Watchlist Summary', '📤 Exit Strategy']);
    for (const n of LEGACY_UNUSED_TABS) assert.ok(!isOldReportTab(n), n);
    const sheetFor = (tabs: Record<string, number>) => {
      const sent: unknown[] = [];
      const sheets = {
        tabIds: async () => ({ ok: true, value: tabs }),
        formatBatch: async (_c: unknown, reqs: unknown[]) => { sent.push(...reqs); return { ok: true, value: reqs.length }; },
      } as unknown as CleanupSheets;
      return { sheets, sent };
    };
    const mk = () => {
      const port = sheetFor({ 'Portfolio': 1, '📋 Bottom Line — TSLA': 2, '🎯 Watchlist Summary': 8, '📤 Exit Report': 9 });
      const rep = sheetFor({ '📤 Exit Strategy': 21, '🎯 Watchlist Summary': 22, '📤 Exit Report': 23, '🛒 Buy Report': 24 });
      const asked: string[] = [];
      const makeSheets = (_e: unknown, id: string) => { asked.push(id); return id === 'r' ? rep.sheets : port.sheets; };
      return { port, rep, asked, makeSheets };
    };
    const env2 = { ...env, REPORTS_SPREADSHEET_ID: 'r' };
    // without the flag: the legacy tabs are never touched and the reports sheet is never opened
    let m = mk();
    assert.equal(await runCleanupReportTabs({ env: env2, argv: ['--yes'], out: () => {}, errOut: () => {}, makeSheets: m.makeSheets, ctx }), 0);
    assert.deepEqual(m.port.sent, [{ deleteSheet: { sheetId: 2 } }]);
    assert.deepEqual([m.rep.sent, m.asked], [[], ['x']]);
    // the flag without --yes: a dry run that lists them
    m = mk();
    const out: string[] = [];
    assert.equal(await runCleanupReportTabs({ env: env2, argv: ['--legacy-tabs'], out: (l) => out.push(l), errOut: () => {}, makeSheets: m.makeSheets, ctx }), 0);
    assert.deepEqual([m.port.sent, m.rep.sent], [[], []]);
    assert.match(out.join('\n'), /1 unused legacy tab\(s\) found in My Portfolio[\s\S]*2 unused legacy tab\(s\) found in the reports sheet[\s\S]*Dry run/);
    // the flag with --yes: exact names only, the new Exit Report tab stays
    m = mk();
    assert.equal(await runCleanupReportTabs({ env: env2, argv: ['--legacy-tabs', '--yes'], out: () => {}, errOut: () => {}, makeSheets: m.makeSheets, ctx }), 0);
    assert.deepEqual(m.port.sent, [{ deleteSheet: { sheetId: 2 } }, { deleteSheet: { sheetId: 8 } }]);
    assert.deepEqual(m.rep.sent, [{ deleteSheet: { sheetId: 22 } }, { deleteSheet: { sheetId: 21 } }]);
    // no REPORTS_SPREADSHEET_ID: My Portfolio only
    m = mk();
    assert.equal(await runCleanupReportTabs({ env, argv: ['--legacy-tabs', '--yes'], out: () => {}, errOut: () => {}, makeSheets: m.makeSheets, ctx }), 0);
    assert.deepEqual([m.asked, m.rep.sent], [['x'], []]);
  });

  test('registered as an npm script', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.scripts['cleanup-report-tabs'], 'node --env-file-if-exists=.env src/cleanupReportTabs.ts');
  });
});
