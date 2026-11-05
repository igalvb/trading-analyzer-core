/**
 * FL-11b: fixes from the first real nightly on GitHub (2026-10-27, run 40475412130).
 *   F-B7-1  the tab-id list is kept for the run, so per-ticker store calls stop doubling the Sheets calls.
 *   F-B7-2  an entry ends once its output is flushed, even when a timed-out step left work running.
 *   F-B7-6  a Date cell is sent with a date format (Decision History showed 46322.27).
 *   F-B7-3..5  Portfolio tab reading: the CLOSED options section, the options 'Purchase Date' column, a ticker with a space.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { sheets_v4 } from 'googleapis';
import { SheetsClient, changesTabs } from '../src/sheets/client.ts';
import { RateLimiter } from '../src/sheets/limiter.ts';
import { createContext } from '../src/core/context.ts';
import { LogLevel } from '../src/core/logger.ts';
import { parsePortfolio, endsOpenOptions, PURCHASE_DATE_COLUMN } from '../src/sheets/readers/portfolio.ts';
import type { SheetRow } from '../src/sheets/coerce.ts';
import { SheetsWorkbookBackend } from '../src/sheets/reportSheet.ts';
import type { PriceSheetsApi } from '../src/storage/priceHistory.ts';

const ctx = () => createContext({ mode: 'test', minLevel: LogLevel.ERROR, backoffBaseMs: 1, backoffMaxMs: 2, sleep: async () => {} });

function fakeApi() {
  const calls: string[] = [];
  let tabs: Array<{ title: string; sheetId: number }> = [{ title: 'Portfolio', sheetId: 1 }];
  const api = {
    spreadsheets: {
      get: async () => { calls.push('get'); return { data: { sheets: tabs.map((t) => ({ properties: { ...t } })) } }; },
      batchUpdate: async (p: { requestBody: { requests: sheets_v4.Schema$Request[] } }) => {
        calls.push('batchUpdate');
        for (const r of p.requestBody.requests) if (r.addSheet) tabs = [...tabs, { title: String(r.addSheet.properties?.title), sheetId: tabs.length + 1 }];
        return { data: {} };
      },
    },
  } as unknown as sheets_v4.Sheets;
  return { api, calls };
}

describe('FL-11b — F-B7-1 tab ids kept for the run', () => {
  test('a second tabIds call makes no API call and returns the same map', async () => {
    const { api, calls } = fakeApi();
    const c = new SheetsClient({ spreadsheetId: 's', api, limiter: RateLimiter.perMinute(100_000) });
    const a = await c.tabIds(ctx());
    const b = await c.tabIds(ctx());
    assert.ok(a.ok && b.ok);
    assert.deepEqual(a.ok && a.value, { Portfolio: 1 });
    assert.deepEqual(b.ok && b.value, { Portfolio: 1 });
    assert.deepEqual(calls, ['get']);
    assert.equal(c.callCount(), 1);
  });

  test('the returned map is a copy: a caller changing it does not change the next answer', async () => {
    const { api } = fakeApi();
    const c = new SheetsClient({ spreadsheetId: 's', api, limiter: RateLimiter.perMinute(100_000) });
    const a = await c.tabIds(ctx());
    if (a.ok) (a.value as Record<string, number>)['Ghost'] = 9;
    const b = await c.tabIds(ctx());
    assert.deepEqual(b.ok && b.value, { Portfolio: 1 });
  });

  test('adding a tab clears the kept list; plain formatting does not', async () => {
    const { api, calls } = fakeApi();
    const c = new SheetsClient({ spreadsheetId: 's', api, limiter: RateLimiter.perMinute(100_000) });
    await c.tabIds(ctx());
    await c.formatBatch(ctx(), [{ repeatCell: { range: { sheetId: 1 }, fields: 'userEnteredFormat' } }]);
    await c.tabIds(ctx());
    assert.deepEqual(calls, ['get', 'batchUpdate'], 'formatting only: no new list call');
    await c.formatBatch(ctx(), [{ addSheet: { properties: { title: '💾 NEW' } } }]);
    const after = await c.tabIds(ctx());
    assert.deepEqual(calls, ['get', 'batchUpdate', 'batchUpdate', 'get']);
    assert.deepEqual(after.ok && after.value, { Portfolio: 1, '💾 NEW': 2 });
  });

  test('which requests count as tab changes', () => {
    assert.ok(changesTabs({ addSheet: {} }));
    assert.ok(changesTabs({ deleteSheet: { sheetId: 1 } }));
    assert.ok(changesTabs({ duplicateSheet: { sourceSheetId: 1 } }));
    assert.ok(changesTabs({ updateSheetProperties: { properties: { sheetId: 1, title: 'x' }, fields: 'title' } }));
    assert.ok(changesTabs({ updateSheetProperties: { properties: { sheetId: 1 }, fields: '*' } }));
    assert.ok(!changesTabs({ updateSheetProperties: { properties: { sheetId: 1, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } }), 'frozen rows do not rename');
    assert.ok(!changesTabs({ updateSheetProperties: { properties: { sheetId: 1 }, fields: 'tabColor' } }));
    assert.ok(!changesTabs({ repeatCell: {} }));
    assert.ok(!changesTabs({ mergeCells: {} }));
  });
});

describe('FL-11b — F-B7-2 an entry ends once its output is flushed', () => {
  test('a left-over timer does not keep the process open; output and exit code arrive', () => {
    const finishUrl = pathToFileURL(path.resolve('src/core/finish.ts')).href;
    const script = `import { finish } from ${JSON.stringify(finishUrl)};
      setInterval(() => {}, 1000);
      process.stdout.write('summary line\\n');
      finish(3);`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.error, undefined, 'the child ended before the 20 s guard');
    assert.equal(r.status, 3);
    assert.equal(r.stdout, 'summary line\n');
  });
});

describe('FL-11b — the Portfolio tab as the owner keeps it (F-B7-3, F-B7-4, F-B7-5)', () => {
  /** The real layout seen on 2026-10-27, numbers made up: open options, blank rows, then a CLOSED section with its own header. */
  const sheet = (): SheetRow[] => [
    ['Ticker', 'type', 'sub-type', 'amount', 'cost avg per stock'],
    ['TSLA', 'stock', '', 10, 250],
    ['BTC stock', 'stock', 'bitcoin etf', 240, 45.67],
    ['BTC', 'crypto', '', 0.1, 60000],
    ['', '', '', '', ''],
    ['Ticker', 'type', 'positions', 'last trade Date', 'strike', 'PUT/CALL', 'avg price - Premium paid', 'cost basis', 'current market value', 'URLS / comments', 'Purchase Date'],
    ['MSTR', 'options', 3, '2027-06-17', 100, 'CALL', 48.52, 14556, '', '', '2026-06-09'],
    ['IBIT', 'options', 1, '2027-12-17', 38, 'CALL', 10.82, 1082, '', '', '2026-06-02'],
    ['', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', ''],
    ['CLOSED positions'],
    ['Ticker', 'type', 'positions', 'last trade Date', 'strike', 'PUT/CALL', 'avg price - Premium paid', 'cost basis', 'Sell Price', 'Sell Date'],
    ['PLTR', 'options', 1, '2027-03-19', 120, 'CALL', 48.1, 4810, 9049, '2026-10-09'],
  ];

  test('F-B7-3: a closed option is not read as held; the label and header rows are not holdings', () => {
    const r = parsePortfolio(sheet());
    assert.deepEqual(r.options.map((o) => o.ticker), ['MSTR', 'IBIT']);
    assert.ok(!r.options.some((o) => ['PLTR', 'TICKER', 'CLOSED POSITIONS'].includes(o.ticker)));
    assert.ok(r.skippedOther.some((s) => s.ticker === 'CLOSED POSITIONS' && /closed positions/.test(s.reason)), 'disclosed by name');
  });

  test('F-B7-3: blank rows inside the open options are still skipped, not a stop', () => {
    const rows = sheet();
    rows.splice(7, 0, ['', '', '', '', '', '', '', '', '', '', '']);
    assert.deepEqual(parsePortfolio(rows).options.map((o) => o.ticker), ['MSTR', 'IBIT']);
  });

  test('F-B7-4: the options "Purchase Date" column is read as the entry date', () => {
    const r = parsePortfolio(sheet());
    for (const o of r.options) assert.ok(o.entryDate instanceof Date && !Number.isNaN(o.entryDate.getTime()), o.ticker);
  });

  test('F-B7-4: "Purchase Data" still works and wins when both columns exist', () => {
    const rows: SheetRow[] = [
      ['Ticker', 'positions', 'last trade Date', 'strike', 'PUT/CALL', PURCHASE_DATE_COLUMN, 'Purchase Date'],
      ['AMD', 2, '2027-01-15', 150, 'call', '2026-01-02', '2025-05-05'],
    ];
    const d = parsePortfolio(rows).options[0]?.entryDate;
    assert.ok(d instanceof Date);
    assert.equal(d.getUTCFullYear(), 2026);
  });

  test('F-B7-5: a stock ticker with a space is disclosed, not analysed; crypto stays skipped', () => {
    const r = parsePortfolio(sheet());
    assert.deepEqual(r.stocks.map((s) => s.ticker), ['TSLA']);
    assert.ok(r.skippedOther.some((s) => s.ticker === 'BTC stock' && /space/.test(s.reason)));
    assert.deepEqual(r.skippedCrypto, ['BTC']);
  });

  test('endsOpenOptions', () => {
    assert.ok(endsOpenOptions('TICKER'));
    assert.ok(endsOpenOptions('CLOSED POSITIONS'));
    assert.ok(!endsOpenOptions('MSTR'));
    assert.ok(!endsOpenOptions('CQZB'), 'a ticker merely containing CL is not a stop');
  });
});

describe('FL-11b — F-B7-6 a Date cell is sent with a date format', () => {
  test('the date cell gets a DATE_TIME format after clearFormats and before the other ops', async () => {
    const sent: { kind: string; payload: unknown }[] = [];
    const api = {
      tabIds: async () => ({ ok: true, value: { '📈 Decision History': 7 } }),
      batchGet: async () => ({ ok: true, value: [[]] }),
      batchClear: async () => ({ ok: true, value: 1 }),
      batchUpdate: async (_c: unknown, u: unknown) => { sent.push({ kind: 'values', payload: u }); return { ok: true, value: 1 }; },
      formatBatch: async (_c: unknown, r: unknown) => { sent.push({ kind: 'format', payload: r }); return { ok: true, value: 1 }; },
    } as unknown as PriceSheetsApi;
    const backend = new SheetsWorkbookBackend(ctx(), api, 'America/New_York');
    await backend.applyTab('📈 Decision History', {
      created: false, cleared: false,
      cells: [{ row: 6, col: 1, value: new Date('2026-10-27T10:26:00Z') }, { row: 6, col: 2, value: 'PLTR' }],
      ops: [{ op: 'clearFormats' }, { op: 'fontWeight', range: { row: 1, col: 1, numRows: 1, numCols: 6 }, value: 'bold' }],
    });
    const values = sent.find((s) => s.kind === 'values')!.payload as Array<{ values: unknown[][] }>;
    assert.equal(typeof values[0]!.values[0]![0], 'number', 'the date still goes as a serial number');
    // D11 (2026-10-30): the clearFormats part (unmerge) is sent BEFORE the values, so the order is read across calls.
    const reqs = sent.filter((s) => s.kind === 'format').flatMap((s) => s.payload as Array<Record<string, any>>);
    assert.ok(sent.findIndex((s) => s.kind === 'format') < sent.findIndex((s) => s.kind === 'values'), 'the unmerge goes before the values');
    const clearAt = reqs.findIndex((r) => r.updateCells);
    const dateAt = reqs.findIndex((r) => r.repeatCell?.cell?.userEnteredFormat?.numberFormat);
    const boldAt = reqs.findIndex((r) => r.repeatCell?.cell?.userEnteredFormat?.textFormat);
    assert.ok(clearAt >= 0 && dateAt > clearAt && boldAt > dateAt, 'clearFormats, then the date format, then the other ops: ' + [clearAt, dateAt, boldAt]);
    assert.deepEqual(reqs[dateAt]!.repeatCell.cell.userEnteredFormat.numberFormat, { type: 'DATE_TIME' });
    assert.deepEqual(reqs[dateAt]!.repeatCell.range, { sheetId: 7, startRowIndex: 5, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: 1 });
  });

  test('no date cell and no ops: no formatting call', async () => {
    let formatCalls = 0;
    const api = {
      tabIds: async () => ({ ok: true, value: { T: 1 } }),
      batchUpdate: async () => ({ ok: true, value: 1 }),
      formatBatch: async () => { formatCalls++; return { ok: true, value: 1 }; },
    } as unknown as PriceSheetsApi;
    await new SheetsWorkbookBackend(ctx(), api, 'UTC').applyTab('T', { created: false, cleared: false, cells: [{ row: 1, col: 1, value: 'x' }], ops: [] });
    assert.equal(formatCalls, 0);
  });
});

describe('FL-11b — F-B7-12 the Sheets limiter stays under 60 calls in any minute', () => {
  test('a burst of 5, then 50 a minute: at most 55 calls in the first 60 seconds', async () => {
    let t = 0;
    const lim = new RateLimiter(5, 50 / 60_000, () => t, async (ms) => { t += ms; });
    let calls = 0;
    while (t < 60_000) { await lim.acquire(); if (t < 60_000) calls++; }
    assert.ok(calls <= 55, 'calls in the first minute: ' + calls);
    assert.ok(calls >= 50, 'and the steady rate is kept: ' + calls);
  });
});
