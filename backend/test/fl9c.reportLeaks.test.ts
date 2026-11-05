/**
 * FL-9c: the leak scanner over the changed report builders, fed failing inputs (HTTP 429, URL in error text,
 * stack line, API-key-like string). Plain mode (the default) must be clean; legacy mode must still leak
 * (control: proves the inputs really are leaky and the scanner has teeth).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ReportWorkbook, MemoryWorkbookBackend } from '../src/sheets/reportSheet.ts';
import { HttpStatusError } from '../src/net/http.ts';
import { findReportLeaks, assertNoReportLeaks } from '../src/reports/messages/leakScan.ts';
import { sectionErrorText, notFoundText, statusConsequence } from '../src/reports/messages/reportText.ts';
import { newDataStatus, setStatus } from '../src/analysis/dataStatus.ts';
import { buildDataStatusBanner, buildFailureSheet, ANALYSIS_TAB, DASH_COLS, type RunStatus } from '../src/reports/text/textReports.ts';
import { formatStockSignals, formatOptionsSignals, summaryBackground } from '../src/reports/exit/exitReport.ts';
import { buildBottomLineSummary, bottomLineTabName } from '../src/reports/bottomLine/summarySheet.ts';

// Made-up keys, built from parts so the file holds no secret-shaped text (generic guard R7).
const URL_ = 'https://query1.finance.yahoo.com/v8/finance/chart/PLTR?apikey=' + 'AIza' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q';
const KEY = 'sk-' + 'ant-api03-AbCdEf0123456789AbCdEf0123456789XyZ';
const STACK = "TypeError: Cannot read properties of undefined (reading 'toFixed')\n    at buildDashboard (/Users/dev/backend/src/reports/dashboard/dashboard.ts:320:44)";
const NOW = Date.UTC(2026, 9, 23, 15, 0, 0);
const TIME = { nowMs: NOW, timeZone: 'America/New_York' };

const BAD_ERRORS: unknown[] = [
  new HttpStatusError(429, URL_),
  new Error('HTTP 429 from ' + URL_),
  new Error(STACK),
  new Error('auth failed with key ' + KEY),
];

const STATUS: RunStatus = {
  price: { label: 'Price (OHLCV)', state: 'failed', detail: 'HTTP 429 from ' + URL_, reasonCode: 'RATE_LIMIT' },
  fundamentals: { label: 'Fundamentals', state: 'degraded', detail: KEY },
  series: { label: 'Finnhub series', state: 'skipped', detail: STACK },
};

async function openWb(): Promise<ReportWorkbook> {
  return ReportWorkbook.open(new MemoryWorkbookBackend({} as never), ['*']);
}
const leaksIn = (cells: readonly unknown[]): string[] => cells.flatMap((c) => (typeof c === 'string' ? findReportLeaks(c) : []));

describe('FL-9c -- raw detail stays out of report text', () => {
  test('catalog helpers: section error, status line, not-found pick', () => {
    const e = new TypeError("Cannot read properties of undefined (reading 'toFixed')");
    const logs: string[] = [];
    assert.equal(sectionErrorText('LILO ladder', e, 80, { legacyReportText: true }), "⚠️ LILO ladder error: Cannot read properties of undefined (reading 'toFixed')");
    const plain = sectionErrorText('LILO ladder', e, 80, { onDetail: (l) => logs.push(l) });
    assert.equal(plain, '⚠️ LILO ladder: This section could not be built.');
    assert.deepEqual(findReportLeaks(plain), []);
    assert.ok(logs[0]!.includes('Cannot read properties'), 'the technical text went to the log');
    assert.equal(statusConsequence({ label: 'X', detail: 'HTTP 429 from ' + URL_, reasonCode: 'RATE_LIMIT' }), 'X: The request limit was reached.');
    assert.equal(statusConsequence({ label: 'X', detail: KEY }), 'X');
    assert.equal(notFoundText(undefined, { legacyReportText: true }), 'not found — undefined');
    for (const r of [undefined, 'delta field appears missing from this feed', 'HTTP 429 from ' + URL_, '']) assert.deepEqual(findReportLeaks(notFoundText(r)), [], String(r));
    assert.equal(notFoundText('no chain data returned for NF'), 'not found — no chain data returned for NF');
  });

  test('setStatus stores reasonCode and clears it on the next call', () => {
    const st = newDataStatus();
    setStatus(st, 'price', 'failed', 'raw', 'RATE_LIMIT');
    assert.equal(st.price.reasonCode, 'RATE_LIMIT');
    setStatus(st, 'price', 'ok', '');
    assert.equal('reasonCode' in st.price, false);
  });

  test('banner: plain is clean and says why; legacy leaks (control)', () => {
    const rows = buildDataStatusBanner(STATUS);
    assert.deepEqual(rows.flatMap((r) => leaksIn(r.text)), []);
    assert.equal(rows[1]!.text[0], 'Affected: Price (OHLCV): The request limit was reached.   •   Finnhub series   •   Fundamentals');
    assert.ok(leaksIn(buildDataStatusBanner(STATUS, { legacyReportText: true }).flatMap((r) => r.text)).length > 0);
  });

  test('failure sheet: every failing error is clean in plain mode and its detail reaches the log; legacy leaks', async () => {
    for (const err of BAD_ERRORS) {
      const logs: string[] = [];
      const P = await openWb();
      buildFailureSheet(P, 'PLTR', STATUS, err, TIME, { onDetail: (l) => logs.push(l) });
      const g = P.getSheetByName(ANALYSIS_TAB)!.grid(DASH_COLS);
      assertNoReportLeaks(g);
      assert.ok(String(g[1]![0]).startsWith('Reason: '));
      assert.ok(logs.length === 1 && logs[0]!.length > 0);
    }
    const P429 = await openWb();
    buildFailureSheet(P429, 'PLTR', STATUS, new HttpStatusError(429, URL_), TIME);
    assert.equal(P429.getSheetByName(ANALYSIS_TAB)!.grid(DASH_COLS)[1]![0], 'Reason: The request limit was reached.');
    const L = await openWb();
    buildFailureSheet(L, 'PLTR', STATUS, new Error('HTTP 429 from ' + URL_), TIME, { legacyReportText: true });
    assert.throws(() => assertNoReportLeaks(L.getSheetByName(ANALYSIS_TAB)!.grid(DASH_COLS)));
  });

  test('exit signals: failed reads give a clean ERROR row that still sorts and colours as an error', () => {
    const bad = 'HTTP 429 from ' + URL_;
    const s = formatStockSignals({ error: bad }, true);
    const o = formatOptionsSignals({ error: STACK }, true, 1);
    for (const sig of [s, o]) {
      assert.ok(sig.summary.startsWith('ERROR'));
      assert.deepEqual(findReportLeaks(sig.summary), []);
      assert.equal(summaryBackground(sig.summary), '#eceff1');
    }
    assert.equal(formatStockSignals({ error: bad }, true, { legacyReportText: true }).summary, 'ERROR: ' + bad);
  });

  test('bottom line: failed option picks are clean; legacy leaks', async () => {
    const run = async (extra: { legacyReportText?: boolean }) => {
      const ss = await openWb();
      buildBottomLineSummary(ss, 'T', null, {}, null,
        { found: false, reason: 'HTTP 429 from ' + URL_ }, { found: false }, { clock: { now: () => NOW }, timeZone: 'America/New_York', ...extra });
      return ss.getSheetByName(bottomLineTabName('T', !!extra.legacyReportText))!.grid();
    };
    assertNoReportLeaks(await run({}));
    const legacyGrid = await run({ legacyReportText: true });
    assert.throws(() => assertNoReportLeaks(legacyGrid), /leak/i);
  });
});
