/**
 * FL-13b: the Analyze report (src/analyzeReport.ts): the tabs a run wrote, as a PDF, sent to Telegram.
 * The PDF step itself (Chrome) is replaced; the HTML it is given is checked instead.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReportWorkbook, MemoryWorkbookBackend } from '../src/sheets/reportSheet.ts';
import { tabHtml, displayValue } from '../src/reports/pdf/workbookHtml.ts';
import { analyzeReportMain, reportTabOrder, reportHtml, telegramSummary } from '../src/analyzeReport.ts';
import { ANALYSIS_TAB } from '../src/analysis/runTicker.ts';
import { OptionsTabs } from '../src/reports/options/tabs.ts';
import { BOTTOM_LINE_TAB } from '../src/reports/bottomLine/summarySheet.ts';
import type { TickerJob } from '../src/ticker.ts';

const TZ = 'America/New_York';
const TOKEN = '123456:ABCdefGhIJKlmnoPQRstuVWxyz_0123456';

async function sampleJob(): Promise<TickerJob> {
  const wb = await ReportWorkbook.open(new MemoryWorkbookBackend({}));
  const a = wb.insertSheet(ANALYSIS_TAB);
  a.getRange(1, 1, 1, 4).merge().setValue('TSLA — Investor Briefing').setBackground('#1a237e').setFontColor('#ffffff').setFontWeight('bold');
  a.getRange(2, 1).setValue('Price');
  a.getRange(2, 2).setValue(402.27).setNumberFormat('$#,##0.00');
  a.getRange(3, 1).setValue('A long line that spills into the empty cells to its right <b>');
  wb.insertSheet(OptionsTabs.PUTS).getRange(1, 1).setValue('puts');
  wb.insertSheet('🔬 Log').getRange(1, 1).setValue('log line');
  const art = {
    ticker: 'TSLA', status: {}, dataQuality: [], reports: {}, texts: {}, chart: { currentPrice: 402.27 },
    result: { decision: { action: '🚫 Skip', finalConviction: 56, timing: 'WAIT_PULLBACK', fundBand: 'weak', headline: 'Weak fundamentals, no entry edge' } },
  };
  return { code: 0, ticker: 'TSLA', workbook: wb, timeZone: TZ, art: art as never, chartHtml: '<html><body>chart</body></html>', lockLines: [], produced: new Set([ANALYSIS_TAB, OptionsTabs.PUTS]) };
}

function fakeTelegram() {
  const calls: Array<{ method: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init: { body: unknown }) => {
    calls.push({ method: url.split('/').pop() as string, body: init.body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('FL-13b — Analyze report', () => {
  test('a tab keeps its colours, merges and number formats; text is escaped; unwrapped text spills right', async () => {
    const job = await sampleJob();
    const html = tabHtml(job.workbook!.getSheetByName(ANALYSIS_TAB)!, TZ)!;
    assert.match(html, /<td colspan="4" style="background:#1a237e;color:#ffffff;font-weight:700">TSLA — Investor Briefing<\/td>/);
    assert.match(html, />\$402\.27</);
    assert.match(html, /<td colspan="4"[^>]*>A long line .*&lt;b&gt;<\/td>/);
    assert.ok(!html.includes('<b>'));
  });

  test('displayValue: the formats the reports use', () => {
    assert.equal(displayValue(1234.5, '$#,##0.00', TZ), '$1,234.50');
    assert.equal(displayValue(-3, '$#,##0.00', TZ), '-$3.00');
    assert.equal(displayValue(7.6, '0', TZ), '8');
    assert.equal(displayValue(0.123456, undefined, TZ), '0.1235');
    assert.equal(displayValue(new Date(Date.UTC(2026, 9, 27, 14)), 'yyyy-mm-dd', TZ), '2026-10-27');
  });

  test('reading order: bottom line first (fixed name, phase 1); no puts, no log', () => {
    const order = reportTabOrder();
    assert.equal(order[0], BOTTOM_LINE_TAB);
    assert.ok(!order.includes(OptionsTabs.PUTS) && !order.includes(OptionsTabs.LOG));
  });

  test('end to end: PDF saved, summary and PDF sent to Telegram; the key never printed', async () => {
    const job = await sampleJob();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl13b-'));
    const { calls, fetchImpl } = fakeTelegram();
    let html = '';
    const out: string[] = [], err: string[] = [];
    const code = await analyzeReportMain(['tsla', '--out', dir], { out: (s) => out.push(s), err: (s) => err.push(s), env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42' } }, {
      run: async (argv) => { assert.deepEqual(argv, ['TSLA', '--opus']); return job; },
      toPdf: async (h, p) => { html = h; fs.writeFileSync(p, '%PDF-1.4 test'); },
      fetchImpl, now: () => Date.UTC(2026, 9, 27, 14),
    });
    assert.equal(code, 0);
    assert.ok(fs.existsSync(path.join(dir, 'v13-report-TSLA-analysis-20261027.pdf')));
    assert.match(html, /TSLA — Full Ticker Analysis/);
    assert.match(html, /56\/100/);
    assert.match(html, /Wait for pullback/);
    assert.ok(!html.includes('puts') && !html.includes('log line'), 'only report tabs');
    assert.deepEqual(calls.map((c) => c.method), ['sendMessage', 'sendDocument']);
    assert.match(telegramSummary(job), /TSLA — 🚫 Skip/);
    assert.ok(!(out.join('') + err.join('')).includes(TOKEN));
  });

  test('phase 1: the PDF prints only the pages the run produced (a written tab outside the produced set is left out)', async () => {
    const job = await sampleJob();
    job.workbook!.insertSheet(OptionsTabs.DASHBOARD).getRange(1, 1).setValue('📊 TSLA — not produced in the run of 10/27/2026, 10:00:00 AM; details in the 🔬 Log');
    const html = reportHtml(job, Date.UTC(2026, 9, 27, 14));
    assert.match(html, /TSLA — Investor Briefing/);
    assert.ok(!html.includes('not produced'));
    const withDash = reportHtml({ ...job, produced: new Set([...job.produced, OptionsTabs.DASHBOARD]) }, Date.UTC(2026, 9, 27, 14));
    assert.ok(withDash.includes('not produced'));
  });

  test('refuses a bad ticker, and Telegram not set up, before running anything', async () => {
    let ran = false;
    const run = async () => { ran = true; return sampleJob(); };
    assert.equal(await analyzeReportMain(['$$$'], { out: () => {}, err: () => {}, env: {} }, { run }), 2);
    assert.equal(await analyzeReportMain(['TSLA'], { out: () => {}, err: () => {}, env: {} }, { run }), 2);
    assert.equal(ran, false);
  });

  test('--memory and --no-ai are passed on to the analysis', async () => {
    let seen: readonly string[] = [];
    const job = await sampleJob();
    await analyzeReportMain(['NVDA', '--memory', '--no-ai', '--no-send', '--out', fs.mkdtempSync(path.join(os.tmpdir(), 'fl13b-'))], { out: () => {}, err: () => {}, env: {} }, {
      run: async (argv) => { seen = argv; return job; }, toPdf: async (_h, p) => fs.writeFileSync(p, 'x'),
    });
    assert.deepEqual(seen, ['NVDA', '--memory', '--no-ai']);
  });

  test('owner 2026-11-01: Opus is asked by default (--opus), not with --no-opus, never with --no-ai', async () => {
    const job = await sampleJob();
    const seen: Array<readonly string[]> = [];
    for (const extra of [[], ['--no-opus'], ['--no-ai']]) {
      await analyzeReportMain(['NVDA', ...extra, '--no-send', '--out', fs.mkdtempSync(path.join(os.tmpdir(), 'fl13b-'))], { out: () => {}, err: () => {}, env: {} }, {
        run: async (argv) => { seen.push(argv); return job; }, toPdf: async (_h, p) => fs.writeFileSync(p, 'x'),
      });
    }
    assert.deepEqual(seen, [['NVDA', '--opus'], ['NVDA'], ['NVDA', '--no-ai']]);
  });
});
