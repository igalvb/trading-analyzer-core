/**
 * Three spreadsheets, phase 2 (docs/SHEETS_CLEANUP_PLAN.md (d), (g) "startupGuard.test", "lockSheets test"):
 * every row of the guard table, through the real composeServices on a fake Google API:
 *   - the two new secrets unset ('' too): exactly today's single-sheet behaviour;
 *   - flag unset: today's behaviour whatever the secrets and marker say (ROLLED_BACK only warns);
 *   - flag set: routing only with both secrets, three different reachable IDs, a VERIFIED marker with matching IDs
 *     and the required tabs; anything else refuses (exit 2), nothing written;
 *   - sheetsPaused unexpired: a clean exit (0) with the Telegram notice; expired: ignored;
 *   - lock-sheets never refuses and locks every reachable spreadsheet.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { composeServices, type Services } from '../src/compose.ts';
import { RateLimiter } from '../src/sheets/limiter.ts';
import { MIGRATED_FLAG, PAUSED_FLAG, SheetsPausedError, SheetsRefusedError, markerRows, sheetIdsFromEnv, type Marker } from '../src/sheets/threeSheets.ts';
import { MIGRATION_MARKER_TAB } from '../src/sheets/tabs.ts';
import { guardStopCode } from '../src/app/sheetGuardExit.ts';
import { withSheetWrites, isUnlockFailure } from '../src/app/sheetWrites.ts';
import { runLockSheets } from '../src/lockSheets.ts';
import { SheetsClient } from '../src/sheets/client.ts';
import { LOCK_COLOR } from '../src/sheets/masterLock.ts';
import { cacheSet } from '../src/storage/kv.ts';
import { FakeGoogle, type Cell } from './fakeGoogleSheets.ts';
import { createContext } from '../src/core/context.ts';
import { LogLevel } from '../src/core/logger.ts';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const BASE_ENV = { SEC_CONTACT_EMAIL: 'contact@example.org', SCRIPT_TIME_ZONE: 'America/New_York', SPREADSHEET_ID: 'P' };
const IDS = { ...BASE_ENV, REPORTS_SPREADSHEET_ID: 'R', DATA_SPREADSHEET_ID: 'D' };
const SP: Cell[][] = [['Key', 'Value', 'UpdatedAt'], ['k1', 'v1', '2026-11-01T00:00:00.000Z']];

const goodMarker = (over: Partial<Marker> = {}): Marker => ({
  status: 'VERIFIED', portfolioId: 'P', reportsId: 'R', dataId: 'D', verifiedAt: '2026-11-01T10:00:00.000Z',
  tabs: [{ tab: '💾 TSLA', sheet: 'data', rows: 1, columns: 1, nonEmpty: 1, hidden: false, sha256: 'x' }], portfolioTabsAtMigrate: ['Portfolio'], deleteOnly: [], ...over,
});

interface WorldOpts {
  flag?: boolean;
  marker?: Marker | null;
  pausedUntil?: string;
  portfolioHasScriptProperties?: boolean;
  dropData?: string[];
  dropReports?: string[];
}

function world(o: WorldOpts = {}): FakeGoogle {
  const g = new FakeGoogle();
  const p = g.addBook('P', 'My Portfolio', {
    Portfolio: [['Ticker', 'type'], ['TSLA', 'stock']], '🎯 Watchlist': [['Ticker'], ['TSLA']], DASHBOARD: [['owner']],
    ...(o.portfolioHasScriptProperties === false ? {} : { '💾 Script Properties': SP }),
    '🛒 Buy Report': [['old buy report']], '💾 TSLA': [['META', '{}']],
  });
  if (o.flag) p.metadata.set(MIGRATED_FLAG, '2026-11-01T10:00:00.000Z');
  if (o.pausedUntil) p.metadata.set(PAUSED_FLAG, o.pausedUntil);
  const reports: Record<string, Cell[][]> = { '📈 Decision History': [['h']], 'Exit Target History': [['h']], '📒 Paper Log': [['h']], '📈 Paper Values': [['h']], '🛒 Buy Report': [['buy report']] };
  for (const t of o.dropReports ?? []) delete reports[t];
  g.addBook('R', 'tickerAnalysisReports', reports);
  const data: Record<string, Cell[][]> = { '💾 Script Properties': [['Key', 'Value', 'UpdatedAt'], ['k1', 'from data', '2026-11-01T00:00:00.000Z']], '📝 Paper State': [['s']], '💾 TSLA': [['META', '{}']] };
  for (const t of o.dropData ?? []) delete data[t];
  if (o.marker) data[MIGRATION_MARKER_TAB] = markerRows(o.marker) as Cell[][];
  g.addBook('D', 'stocksAndMarketMetadata', data);
  return g;
}

async function compose(g: FakeGoogle, env: Record<string, string | undefined>, logs: string[] = []): Promise<Services> {
  return composeServices({
    storage: 'sheets', env, sheetsApi: g.api, sheetsLimiter: RateLimiter.perMinute(1_000_000), clock: { now: () => NOW }, sleep: async () => {},
    logSink: (l) => logs.push(l.level + ' ' + l.message),
  });
}

const callsTo = (g: FakeGoogle, id: string): number => g.calls.filter((c) => c.id === id).length;

describe('the two new secrets unset: exactly today (one spreadsheet)', () => {
  for (const [label, env] of [
    ['absent', BASE_ENV],
    ["'' (GitHub's value for a missing secret)", { ...BASE_ENV, REPORTS_SPREADSHEET_ID: '', DATA_SPREADSHEET_ID: '' }],
    ['blank', { ...BASE_ENV, REPORTS_SPREADSHEET_ID: '  ', DATA_SPREADSHEET_ID: ' ' }],
  ] as const) {
    test(label + ': every store and workbook on SPREADSHEET_ID; no call to any other spreadsheet', async () => {
      assert.deepEqual(sheetIdsFromEnv(env), { portfolio: 'P', reports: null, data: null });
      const g = world();
      const s = await compose(g, env);
      assert.equal(s.reportsSheets, null);
      assert.equal(s.dataSheets, null);
      assert.equal(s.sheets!.spreadsheetId, 'P');
      assert.equal(await s.kv.get('k1'), 'v1', 'the property store is My Portfolio\'s');
      await cacheSet(s.kv, 'k2', 1, 1, NOW);
      const wb = await s.openWorkbook(['🛒 Buy Report']);
      wb.getSheetByName('🛒 Buy Report')!.getRange(1, 1).setValue('new buy report');
      wb.insertSheet('📊 Analysis v7').getRange(1, 1).setValue('📊 TSLA — x');
      await wb.flush();
      await s.flushStores();
      await s.tabStore.ensure('💾 Macro Snapshot');
      assert.deepEqual(g.values('P', '🛒 Buy Report'), [['new buy report']]);
      assert.ok(g.titles('P').includes('📊 Analysis v7') && g.titles('P').includes('💾 Macro Snapshot'));
      assert.ok(g.values('P', '💾 Script Properties').some((r) => r[0] === 'k2'));
      assert.equal(callsTo(g, 'R') + callsTo(g, 'D'), 0);
      assert.equal(g.writeCount('R') + g.writeCount('D'), 0);
    });
  }
});

describe('the two new secrets unset: failures as today', () => {
  test('an unreachable My Portfolio is the same plain failure as before (exit 1), not a guard refusal', async () => {
    const g = world();
    g.unreachable.add('P');
    await assert.rejects(compose(g, BASE_ENV), (e: unknown) => !(e instanceof SheetsRefusedError) && /could not load the property store tab/.test((e as Error).message));
  });
});

describe('flag unset: today\'s behaviour whatever the secrets say', () => {
  test('secrets set, no flag: My Portfolio only; the new sheets are never written', async () => {
    const g = world({ marker: goodMarker() });
    const s = await compose(g, IDS);
    assert.equal(s.reportsSheets, null);
    assert.equal(await s.kv.get('k1'), 'v1');
    const wb = await s.openWorkbook(['🛒 Buy Report']);
    wb.getSheetByName('🛒 Buy Report')!.getRange(1, 1).setValue('x');
    await wb.flush();
    assert.deepEqual(g.values('P', '🛒 Buy Report'), [['x']]);
    assert.equal(g.writeCount('R') + g.writeCount('D'), 0);
    assert.equal(callsTo(g, 'R'), 0);
  });
  test('a ROLLED_BACK marker only warns (remove the secrets when convenient)', async () => {
    const g = world({ marker: goodMarker({ status: 'ROLLED_BACK' }) });
    const logs: string[] = [];
    const s = await compose(g, IDS, logs);
    assert.equal(s.reportsSheets, null);
    assert.ok(logs.some((l) => /rolled back/.test(l) && /Remove the REPORTS_SPREADSHEET_ID/.test(l)), logs.join('\n'));
  });
  test('an unreachable data sheet does not matter while the flag is unset', async () => {
    const g = world();
    g.unreachable.add('D');
    const s = await compose(g, IDS);
    assert.equal(s.dataSheets, null);
  });
  test('My Portfolio without 💾 Script Properties: refuse, never start an empty store', async () => {
    const g = world({ portfolioHasScriptProperties: false });
    await assert.rejects(compose(g, BASE_ENV), (e: unknown) => e instanceof SheetsRefusedError && /Script Properties/.test(e.message));
    assert.ok(!g.titles('P').includes('💾 Script Properties'), 'nothing was created');
  });
});

describe('flag set: routing only when every check passes', () => {
  test('all checks pass: data to D, reports to R, the owner\'s tabs stay on P; the stale copies in P are not touched', async () => {
    const g = world({ flag: true, marker: goodMarker() });
    const s = await compose(g, IDS);
    assert.equal(s.reportsSheets!.spreadsheetId, 'R');
    assert.equal(s.dataSheets!.spreadsheetId, 'D');
    assert.equal(await s.kv.get('k1'), 'from data');
    await cacheSet(s.kv, 'k2', 1, 1, NOW);
    const wb = await s.openWorkbook(['🛒 Buy Report', 'Portfolio']);
    assert.deepEqual(wb.getSheetByName('🛒 Buy Report')!.grid(), [['buy report']], 'read from the reports sheet');
    wb.getSheetByName('🛒 Buy Report')!.getRange(1, 1).setValue('new');
    wb.insertSheet('📊 Analysis v7').getRange(1, 1).setValue('📊 TSLA — x');
    wb.getSheetByName('Portfolio')!.getRange(2, 3).setValue(12.5);
    await wb.flush();
    await s.tabStore.ensure('💾 Macro Snapshot');
    await s.tabStore.ensure('🌊 Dark Pool Tracker');
    await s.flushStores();
    assert.deepEqual(g.values('R', '🛒 Buy Report'), [['new']]);
    assert.deepEqual(g.values('P', '🛒 Buy Report'), [['old buy report']]);
    assert.ok(g.titles('R').includes('📊 Analysis v7') && !g.titles('P').includes('📊 Analysis v7'));
    assert.ok(g.titles('D').includes('💾 Macro Snapshot') && g.titles('R').includes('🌊 Dark Pool Tracker'));
    assert.ok(g.values('D', '💾 Script Properties').some((r) => r[0] === 'k2'));
    assert.ok(!g.values('P', '💾 Script Properties').some((r) => r[0] === 'k2'));
    assert.equal(g.values('P', 'Portfolio')[1]![2], 12.5, 'My Options still writes Portfolio on My Portfolio');
    // The Master Lock covers all three.
    await withSheetWrites(s, async () => {});
    for (const id of ['P', 'R', 'D']) assert.ok(g.books.get(id)!.tabs.every((t) => t.color === LOCK_COLOR), id + ' locked');
  });

  const refusals: Array<[string, WorldOpts, Record<string, string | undefined>, RegExp]> = [
    ['REPORTS_SPREADSHEET_ID unset', { flag: true, marker: goodMarker() }, { ...IDS, REPORTS_SPREADSHEET_ID: undefined }, /not set/],
    ["DATA_SPREADSHEET_ID '' (unset)", { flag: true, marker: goodMarker() }, { ...IDS, DATA_SPREADSHEET_ID: '' }, /not set/],
    ['both secrets unset', { flag: true, marker: goodMarker() }, BASE_ENV, /not set/],
    ['two IDs the same', { flag: true, marker: goodMarker() }, { ...IDS, DATA_SPREADSHEET_ID: 'R' }, /same/],
    ['IDs swapped', { flag: true, marker: goodMarker() }, { ...IDS, REPORTS_SPREADSHEET_ID: 'D', DATA_SPREADSHEET_ID: 'R' }, /missing|do not match|no "/],
    ['marker missing (deleted by hand or a tool)', { flag: true, marker: null }, IDS, /missing/],
    ['marker not VERIFIED', { flag: true, marker: goodMarker({ status: 'ROLLED_BACK' }) }, IDS, /not VERIFIED/],
    ['marker IDs mismatched (mistyped secret)', { flag: true, marker: goodMarker({ reportsId: 'R-old' }) }, IDS, /do not match/],
    ['data sheet without 💾 Script Properties', { flag: true, marker: goodMarker(), dropData: ['💾 Script Properties'] }, IDS, /Script Properties/],
    ['data sheet without 📝 Paper State', { flag: true, marker: goodMarker(), dropData: ['📝 Paper State'] }, IDS, /Paper State/],
    ['reports sheet without 📈 Decision History', { flag: true, marker: goodMarker(), dropReports: ['📈 Decision History'] }, IDS, /Decision History/],
    ['reports sheet without Exit Target History', { flag: true, marker: goodMarker(), dropReports: ['Exit Target History'] }, IDS, /Exit Target History/],
    ['reports sheet without 📒 Paper Log', { flag: true, marker: goodMarker(), dropReports: ['📒 Paper Log'] }, IDS, /Paper Log/],
    ['reports sheet without 📈 Paper Values', { flag: true, marker: goodMarker(), dropReports: ['📈 Paper Values'] }, IDS, /Paper Values/],
  ];
  for (const [label, w, env, re] of refusals) {
    test('refuse: ' + label + ' (exit 2, nothing written)', async () => {
      const g = world(w);
      await assert.rejects(compose(g, env), (e: unknown) => e instanceof SheetsRefusedError && re.test(e.message));
      for (const id of ['P', 'R', 'D']) assert.equal(g.writeCount(id), 0, id);
    });
  }
  test('refuse: a new sheet unreachable', async () => {
    for (const id of ['R', 'D']) {
      const g = world({ flag: true, marker: goodMarker() });
      g.unreachable.add(id);
      await assert.rejects(compose(g, IDS), (e: unknown) => e instanceof SheetsRefusedError && /could not be reached/.test(e.message));
    }
  });
  test('flag set before the marker (a crash between them): every run refuses, which fails safe', async () => {
    const g = world({ flag: true, marker: null });
    await assert.rejects(compose(g, IDS), SheetsRefusedError);
    await assert.rejects(compose(g, BASE_ENV), SheetsRefusedError, 'and a run without the secrets too');
  });
});

describe('the maintenance pause', () => {
  test('unexpired: no write, SheetsPausedError with the time (flag set or not)', async () => {
    for (const flag of [false, true]) {
      const g = world({ flag, marker: goodMarker(), pausedUntil: '2026-11-02T13:30:00.000Z' });
      await assert.rejects(compose(g, IDS), (e: unknown) => e instanceof SheetsPausedError && /until about 13:30 UTC; please send it again after that\./.test(e.message));
      for (const id of ['P', 'R', 'D']) assert.equal(g.writeCount(id), 0);
    }
  });
  test('expired: ignored (a crashed migration never pauses longer than 2 hours)', async () => {
    const g = world({ pausedUntil: '2026-11-02T11:59:00.000Z' });
    const s = await compose(g, BASE_ENV);
    assert.equal(s.sheets!.spreadsheetId, 'P');
  });
  test('the entry ends cleanly (exit 0) and a Telegram-started run replies; refusals end with exit 2', async () => {
    const sent: string[] = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body).text);
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const out: string[] = [];
    const io = { out: (x: string) => { out.push(x); }, err: () => {}, env: { TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '1' } };
    const paused = new SheetsPausedError(new Date('2026-11-02T13:30:00Z'));
    assert.equal(await guardStopCode(paused, io, { notify: true, fetchImpl }), 0);
    assert.deepEqual(sent, ['⏸️ Paused for maintenance until about 13:30 UTC; please send it again after that.']);
    assert.match(out.join(''), /Paused for maintenance until about 13:30 UTC/);
    assert.equal(await guardStopCode(paused, io, { notify: false, fetchImpl }), 0);
    assert.equal(sent.length, 1, 'scheduled runs and --no-send do not message');
    assert.equal(await guardStopCode(new SheetsRefusedError('The spreadsheets are marked as moved, but x.'), io, { notify: true, fetchImpl }), 2);
    assert.equal(sent.length, 1);
    assert.equal(await guardStopCode(new Error('other'), io, { notify: true, fetchImpl }), null);
  });
});

describe('Master Lock over three spreadsheets', () => {
  const quiet = () => createContext({ mode: 'test', minLevel: LogLevel.ERROR, sleep: async () => {} });
  test('a failed unlock on any sheet stops the run before writing; the sheets already unlocked are locked again', async () => {
    const g = world({ flag: true, marker: goodMarker() });
    const s = await compose(g, IDS);
    for (const id of ['P', 'R', 'D']) for (const t of g.books.get(id)!.tabs) t.color = LOCK_COLOR;
    g.readOnly.add('D');
    let ran = false;
    await assert.rejects(withSheetWrites(s, async () => { ran = true; }), (e: unknown) => isUnlockFailure(e));
    assert.equal(ran, false);
    for (const id of ['P', 'R']) assert.ok(g.books.get(id)!.tabs.every((t) => t.color === LOCK_COLOR), id + ' locked again');
  });
  test('lock-sheets never refuses: locks My Portfolio and every reachable new sheet; an unreachable one is a warning', async () => {
    for (const w of [{ flag: true, marker: null }, { flag: true, marker: goodMarker({ status: 'ROLLED_BACK' }) }, {}] as WorldOpts[]) {
      const g = world(w);
      g.unreachable.add('D');
      const out: string[] = [], errs: string[] = [];
      const mk = (id: string) => new SheetsClient({ spreadsheetId: id, api: g.api, limiter: RateLimiter.perMinute(1_000_000) });
      const code = await runLockSheets({ env: { GOOGLE_SERVICE_ACCOUNT_JSON: 'x', ...IDS }, argv: [], out: (l) => out.push(l), errOut: (l) => errs.push(l), makeSheets: () => mk('P'), makeSheetsFor: (_e, id) => mk(id), ctx: quiet() });
      assert.equal(code, 0);
      assert.deepEqual(errs, []);
      for (const id of ['P', 'R']) assert.ok(g.books.get(id)!.tabs.every((t) => t.color === LOCK_COLOR), id);
      assert.ok(out.some((l) => /warning: the data spreadsheet/.test(l)), out.join('\n'));
      assert.equal(g.values('P', 'Portfolio').length, 2, 'no data written');
    }
  });
  test('lock-sheets with the new secrets unset or empty: My Portfolio only, as today', async () => {
    const g = world();
    const out: string[] = [];
    const mk = (id: string) => new SheetsClient({ spreadsheetId: id, api: g.api, limiter: RateLimiter.perMinute(1_000_000) });
    const code = await runLockSheets({ env: { GOOGLE_SERVICE_ACCOUNT_JSON: 'x', ...BASE_ENV, REPORTS_SPREADSHEET_ID: '', DATA_SPREADSHEET_ID: '' }, argv: [], out: (l) => out.push(l), errOut: () => {}, makeSheets: () => mk('P'), makeSheetsFor: (_e, id) => mk(id), ctx: quiet() });
    assert.equal(code, 0);
    assert.equal(out.length, 1);
    assert.equal(callsTo(g, 'R') + callsTo(g, 'D'), 0);
  });
});
