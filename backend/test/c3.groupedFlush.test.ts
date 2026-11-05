/**
 * C3 (fix plan 2026-10-30): a report workbook flush is grouped per spreadsheet -- one addSheet batch (ids from the
 * reply, the tab-id cache kept), one clear (or the unmerge + clear batch, BEFORE the values: D11), one values
 * batchUpdate, one formatting batch -- instead of 3-4 calls per tab. The cell output, merges and formatting must
 * be the same as the per-tab path's, on a real Analyze run (fixtures) written twice (new tabs, then rewritten tabs).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FakeGoogle, type FakeTab } from './fakeGoogleSheets.ts';
import { fixturesPresent } from './fixtures.ts';
import { fixtureBodies, clockAfterFixtures } from './fl7b2Fixtures.ts';
import { HttpResponse, type HttpRequest, type HttpTransport } from '../src/net/http.ts';
import { compose } from '../src/compose.ts';
import { SheetsClient } from '../src/sheets/client.ts';
import { RateLimiter } from '../src/sheets/limiter.ts';
import { ReportWorkbook, SheetsWorkbookBackend, MemoryWorkbookBackend, type TabChange } from '../src/sheets/reportSheet.ts';
import { RoutingWorkbookBackend } from '../src/sheets/routing.ts';
import { BUY_SHEET_TAB } from '../src/reports/buySheet/text.ts';
import { createContext } from '../src/core/context.ts';
import { LogLevel } from '../src/core/logger.ts';
import type { TabCell } from '../src/storage/tabStore.ts';
import { dateToSheetsSerial } from '../src/storage/priceHistory.ts';

const TZ = 'America/New_York';
const ENV = { SEC_CONTACT_EMAIL: 'contact@example.org', SCRIPT_TIME_ZONE: TZ };
const ctx = () => createContext({ mode: 'test', minLevel: LogLevel.ERROR, backoffBaseMs: 1, backoffMaxMs: 2, sleep: async () => {} });

class FakeNet implements HttpTransport {
  private readonly bodies: Record<string, string>;
  constructor(bodies: Record<string, string>) { this.bodies = bodies; }
  async send(req: HttpRequest): Promise<HttpResponse> {
    const m = /\/v8\/finance\/chart\/([^?]+)\?interval=1d&range=2y/.exec(req.url);
    const t = m ? decodeURIComponent(m[1]!) : null;
    if (t && this.bodies[t]) return new HttpResponse(200, new TextEncoder().encode(this.bodies[t]));
    return new HttpResponse(404, new TextEncoder().encode('not found'));
  }
}

/** Two Analyze runs of TSLA in memory: the first creates every tab, the second rewrites them in place. */
async function analyzeTwice(): Promise<{ first: Array<[string, TabChange]>; second: Array<[string, TabChange]>; grids: Map<string, TabCell[][]> }> {
  const c1 = await compose({ storage: 'memory', env: ENV, transport: new FakeNet(fixtureBodies()), clock: clockAfterFixtures(), logSink: () => {}, sleep: async () => {} });
  await c1.analyze('TSLA');
  const first = c1.workbook.changes();
  const initialTabs: Record<string, TabCell[][]> = {};
  for (const [tab] of first) initialTabs[tab] = c1.workbook.getSheetByName(tab)!.grid();
  const c2 = await compose({ storage: 'memory', env: ENV, transport: new FakeNet(fixtureBodies()), clock: clockAfterFixtures(), logSink: () => {}, sleep: async () => {}, initialTabs });
  await c2.analyze('TSLA');
  const second = c2.workbook.changes();
  const grids = new Map<string, TabCell[][]>();
  for (const [tab] of second) grids.set(tab, c2.workbook.getSheetByName(tab)!.grid());
  return { first, second, grids };
}

function sheetsBackend(g: FakeGoogle): { client: SheetsClient; backend: SheetsWorkbookBackend } {
  g.emulateFormats = true;
  g.addBook('S', 'reports', { Portfolio: [['keep']] });
  const client = new SheetsClient({ spreadsheetId: 'S', api: g.api, limiter: RateLimiter.perMinute(1_000_000) });
  return { client, backend: new SheetsWorkbookBackend(ctx(), client, TZ) };
}

/** Everything a viewer sees of a tab: values, merges, formatting, colour, hidden (ids replaced by titles). */
function view(g: FakeGoogle): unknown {
  const tabs = g.books.get('S')!.tabs;
  const strip = (t: FakeTab): unknown => JSON.parse(JSON.stringify({ merges: t.merges ?? [], formats: t.formats ?? [] }).replaceAll('"sheetId":' + t.sheetId, '"sheetId":"' + t.title + '"'));
  return tabs.map((t) => ({ title: t.title, values: g.values('S', t.title), color: t.color, hidden: t.hidden, ...(strip(t) as object) }));
}

const methods = (g: FakeGoogle, from: number): string[] => g.calls.slice(from).map((c) => c.method);

describe('C3 — the report workbook flush is grouped per spreadsheet', { skip: fixturesPresent() ? false : 'fixtures missing' }, () => {
  test('an Analyze run: about 4 calls per flush instead of 3-4 per tab; the same cells, merges and formats as the per-tab path', async () => {
    const { first, second, grids } = await analyzeTwice();
    assert.ok(first.length >= 10, 'the Analyze run touches many tabs: ' + first.length);
    assert.ok(second.some(([, c]) => !c.created && c.ops.some((o) => o.op === 'clearFormats')), 'the second run rewrites tabs in place');

    // The per-tab path (what flush did before C3): one applyTab per tab.
    const gOld = new FakeGoogle();
    const old = sheetsBackend(gOld);
    await old.client.tabIds(ctx());
    const o0 = gOld.calls.length;
    for (const [tab, change] of first) await old.backend.applyTab(tab, change);
    const oldFirst = methods(gOld, o0);
    const o1 = gOld.calls.length;
    for (const [tab, change] of second) await old.backend.applyTab(tab, change);
    const oldSecond = methods(gOld, o1);

    // The grouped path.
    const gNew = new FakeGoogle();
    const neu = sheetsBackend(gNew);
    await neu.client.tabIds(ctx()); // ReportWorkbook.open lists the tabs (fills the tab-id cache)
    const n0 = gNew.calls.length;
    await neu.backend.applyTabs(first);
    const newFirst = methods(gNew, n0);
    const n1 = gNew.calls.length;
    await neu.backend.applyTabs(second);
    const newSecond = methods(gNew, n1);

    // New tabs: add (ids from the reply, no tab-id read), values, formats.
    assert.deepEqual(newFirst, ['batchUpdate', 'values.batchUpdate', 'batchUpdate']);
    // Rewritten tabs: the unmerge + value clear BEFORE the values, then the formats; no tab-id read (cache kept).
    assert.deepEqual(newSecond, ['batchUpdate', 'values.batchUpdate', 'batchUpdate']);
    assert.ok(oldFirst.length >= 2 * first.length, 'per-tab path, new tabs: ' + oldFirst.length + ' calls for ' + first.length + ' tabs');
    assert.ok(oldSecond.length >= 2 * second.length, 'per-tab path, rewritten tabs: ' + oldSecond.length + ' calls for ' + second.length + ' tabs');

    // Identical output, and the cells are the in-memory workbook's (no value lost under an old merge: D11).
    assert.deepStrictEqual(view(gNew), view(gOld));
    for (const [tab, grid] of grids) {
      const want = grid.map((r) => {
        const x = r.map((v) => (v instanceof Date ? dateToSheetsSerial(v, TZ) : v));
        while (x.length && (x[x.length - 1] === '' || x[x.length - 1] == null)) x.pop();
        return x;
      });
      while (want.length && !want[want.length - 1]!.length) want.pop();
      assert.deepStrictEqual(gNew.values('S', tab), want, tab);
    }
  });

  test('order inside a flush: add tabs, then unmerge/clear, then values, then formats; a plain clear is ONE batchClear', async () => {
    const g = new FakeGoogle();
    const { client, backend } = sheetsBackend(g);
    const ss = await ReportWorkbook.open(backend, ['Portfolio']);
    const n0 = g.calls.length;
    ss.insertSheet('A').getRange(1, 1, 1, 3).merge().setValue('a');
    ss.insertSheet('B').getRange(2, 2).setValue(2);
    await ss.flush();
    assert.deepEqual(methods(g, n0), ['batchUpdate', 'values.batchUpdate', 'batchUpdate'], 'two new tabs: 3 calls, no tab-id read');
    assert.equal(client.callCount(), n0 + 3);

    const s2 = await ReportWorkbook.open(backend, ['A', 'B']);
    const n1 = g.calls.length;
    s2.getSheetByName('A')!.clearContents();
    s2.getSheetByName('B')!.clearContents();
    s2.getSheetByName('A')!.getRange(1, 1).setValue('a2');
    s2.getSheetByName('B')!.getRange(1, 1).setValue('b2');
    await s2.flush();
    assert.deepEqual(methods(g, n1), ['values.batchClear', 'values.batchUpdate'], 'no format op: one batchClear for both tabs, one values call');

    const s3 = await ReportWorkbook.open(backend, ['A', 'B']);
    const n2 = g.calls.length;
    const a = s3.getSheetByName('A')!; a.clearContents(); a.clearFormats(); a.getRange(1, 1, 1, 3).setValues([['x', 'y', 'z']]);
    s3.getSheetByName('B')!.clearContents(); s3.getSheetByName('B')!.getRange(1, 2).setValue('kept format');
    await s3.flush();
    assert.deepEqual(methods(g, n2), ['batchUpdate', 'values.batchUpdate'], 'unmerge + both clears in ONE batch before the values');
    assert.deepEqual(g.values('S', 'A'), [['x', 'y', 'z']], 'the old merge over A1:C1 no longer swallows B1 and C1');
    assert.deepEqual(g.values('S', 'B'), [['', 'kept format']]);
  });

  test('RoutingWorkbookBackend groups by sheetFor: one grouped write per spreadsheet; refusals still skipped', async () => {
    const seen: Array<[string, string[]]> = [];
    const spy = (role: string) => {
      const m = new MemoryWorkbookBackend({});
      return Object.assign(m, { applyTabs: async (list: ReadonlyArray<readonly [string, TabChange]>) => { seen.push([role, list.map(([t]) => t)]); for (const [t, c] of list) await m.applyTab(t, c); } });
    };
    const b = { portfolio: spy('portfolio'), reports: spy('reports'), data: spy('data') };
    const logged: string[] = [];
    const wb = await ReportWorkbook.open(new RoutingWorkbookBackend(b, { onRefuse: (m) => logged.push(m) }), ['*']);
    wb.insertSheet(BUY_SHEET_TAB).getRange(1, 1).setValue('buy');
    wb.insertSheet('💾 TSLA').getRange(1, 1).setValue('meta');
    wb.insertSheet('Owner Notes').getRange(1, 1).setValue('x');
    wb.insertSheet('💾 NVDA').getRange(1, 1).setValue('meta2');
    await wb.flush();
    assert.deepEqual(seen, [['reports', [BUY_SHEET_TAB]], ['data', ['💾 TSLA', '💾 NVDA']]]);
    assert.equal(logged.length, 1);
    assert.deepEqual(b.data.grid('💾 NVDA'), [['meta2']]);
  });

  test('tabColors (Master Lock) fills the tab-id cache: no separate tab-id read afterwards', async () => {
    const g = new FakeGoogle();
    g.addBook('S', 'x', { A: [], B: [] });
    const client = new SheetsClient({ spreadsheetId: 'S', api: g.api, limiter: RateLimiter.perMinute(1_000_000) });
    const colours = await client.tabColors(ctx(), 'lock');
    assert.ok(colours.ok);
    const n = g.calls.length;
    const ids = await client.tabIds(ctx());
    assert.ok(ids.ok);
    assert.deepEqual(ids.value, { A: 100, B: 101 });
    assert.equal(g.calls.length, n, 'served from the cache');
    const added = await client.addTabs(ctx(), ['C']);
    assert.ok(added.ok);
    assert.deepEqual(added.value, { C: 102 });
    const ids2 = await client.tabIds(ctx());
    assert.deepEqual(ids2.ok && ids2.value, { A: 100, B: 101, C: 102 }, 'the new id joins the cache');
    assert.equal(g.calls.length, n + 1, 'only the add call');
  });
});
