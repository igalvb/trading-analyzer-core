/**
 * Three spreadsheets, phase 2: the migration tool (docs/SHEETS_CLEANUP_PLAN.md (e), (g) "migration tool tests",
 * "allow-list exception tests", "protected-name tests"), on a fake Google API holding all three spreadsheets.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../src/core/context.ts';
import { LogLevel } from '../src/core/logger.ts';
import { RateLimiter } from '../src/sheets/limiter.ts';
import { SheetsClient } from '../src/sheets/client.ts';
import {
  REHEARSAL_PREFIX, findReferences, fingerprint, planMove, postSwitchCheck, sameFingerprint, stepAbort, stepCheck, stepCopyBack, stepDelete,
  stepMigrate, stepPlan, stepRehearse, stepRehearseCleanup, targetRefusal, type StepDeps,
} from '../src/sheets/migration.ts';
import { MIGRATED_FLAG, PAUSED_FLAG, SheetsRefusedError, parseMarker, readMarker } from '../src/sheets/threeSheets.ts';
import { MIGRATION_MARKER_TAB, PERSONAL_TABS } from '../src/sheets/tabs.ts';
import { runMigrateDataTabs, githubRunningWriters, WRITER_WAIT_MS } from '../src/migrateDataTabs.ts';
import { composeServices } from '../src/compose.ts';
import { migrationBlockedWindow } from '../src/workflows/schedule.ts';
import { FakeGoogle, type Cell } from './fakeGoogleSheets.ts';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const IDS = { portfolio: 'P', reports: 'R', data: 'D' };
const ENV = { SEC_CONTACT_EMAIL: 'contact@example.org', SCRIPT_TIME_ZONE: 'America/New_York', SPREADSHEET_ID: 'P', REPORTS_SPREADSHEET_ID: 'R', DATA_SPREADSHEET_ID: 'D' };
const quiet = () => createContext({ mode: 'test', minLevel: LogLevel.ERROR, backoffBaseMs: 1, backoffMaxMs: 2, sleep: async () => {} });

const DATA_TABS: Record<string, Cell[][]> = {
  '💾 TSLA': [['META', '{"v":1}'], ['Date', 'Open', 'High', 'Low', 'Close', 'Volume'], [46000, 1, 2, 0.5, 1.5, 1000]],
  '💾 NVDA': [['META', '{"v":1}'], ['Date', 'Open', 'High', 'Low', 'Close', 'Volume'], [46000, 3, 4, 2.5, 3.5, 2000]],
  '💾 Macro SPY': [['Date', 'High', 'Low', 'Close', 'Volume'], [46000, 5, 4, 4.5, 9]],
  '💾 Script Properties': [['Key', 'Value', 'UpdatedAt'], ['k1', 'v1', '2026-11-01T00:00:00.000Z']],
  '💾 RS Ranking': [['SavedAt', '2026-11-01']],
  _OPTIONS_SNAPSHOT: [['snap', 1]],
  '🔬 Log': [['log line']],
  '📝 Paper State': [['{"day":"2026-11-01"}']],
};
const REPORT_TABS: Record<string, Cell[][]> = {
  '🎯 Watchlist Summary': [['ws']], '📈 Decision History': [['dh', 1]], '🛒 Buy Report': [['buy']], '📤 Exit Report': [['exit']],
  'Exit Target History': [['eth']], '🌊 Dark Pool Tracker': [['dp']], '📝 Paper Trading': [['pt']], '📒 Paper Log': [['pl']],
  '🔎 Paper Reads': [['pr']], '📈 Paper Values': [['pv']],
};
const OWNER_TABS: Record<string, Cell[][]> = {
  Portfolio: [['Ticker'], ['TSLA']], '🎯 Watchlist': [['Ticker'], ['NVDA']], DASHBOARD: [['=SUM(1,2)']], 'Personal tab 10': [['o']], 'Personal tab 6': [['c']],
};
const P_TABS: Record<string, Cell[][]> = { '📊 Analysis v7': [['📊 TSLA — report']], '📋 Bottom Line — TSLA': [['bl']] };

function world(): FakeGoogle {
  const g = new FakeGoogle();
  g.addBook('P', 'My Portfolio', { ...OWNER_TABS, ...DATA_TABS, ...REPORT_TABS, ...P_TABS }, { hidden: ['_OPTIONS_SNAPSHOT'] });
  g.addBook('R', 'tickerAnalysisReports', { Sheet1: [] });
  g.addBook('D', 'stocksAndMarketMetadata', { Sheet1: [] });
  return g;
}

function deps(g: FakeGoogle, out: string[] = []): StepDeps {
  const mk = (id: string) => new SheetsClient({ spreadsheetId: id, api: g.api, limiter: RateLimiter.perMinute(1_000_000) });
  return { ctx: quiet(), sheets: { portfolio: mk('P'), reports: mk('R'), data: mk('D') }, ids: IDS, now: () => NOW, out: (l) => out.push(l) };
}

const compose = (g: FakeGoogle, env: Record<string, string | undefined> = ENV) => composeServices({
  storage: 'sheets', env, sheetsApi: g.api, sheetsLimiter: RateLimiter.perMinute(1_000_000), clock: { now: () => NOW + 3600_000 }, sleep: async () => {}, logSink: () => {},
});

const MOVED = [...Object.keys(DATA_TABS), ...Object.keys(REPORT_TABS)];

describe('what moves', () => {
  test('planMove: data, the 10 reports, the P report tabs (deleted, not copied), and the staying tabs', () => {
    const p = planMove(Object.keys({ ...OWNER_TABS, ...DATA_TABS, ...REPORT_TABS, ...P_TABS, 'Owner Scratch': [] }));
    assert.deepEqual(new Set(p.data), new Set(Object.keys(DATA_TABS)));
    assert.deepEqual(new Set(p.reports), new Set(Object.keys(REPORT_TABS)));
    assert.deepEqual(new Set(p.deleteOnly), new Set(Object.keys(P_TABS)));
    assert.deepEqual(new Set(p.staying), new Set([...Object.keys(OWNER_TABS), 'Owner Scratch']), 'an unknown tab stays');
  });
  test('fingerprints: counts, SHA-256 of the values, the hidden flag; trailing blanks do not count', () => {
    const a = fingerprint([['a', 1], ['b', '']], false);
    assert.deepEqual([a.rows, a.columns, a.nonEmpty], [2, 2, 3]);
    assert.ok(sameFingerprint(a, fingerprint([['a', 1, ''], ['b'], []], false)));
    assert.ok(!sameFingerprint(a, fingerprint([['a', 1], ['b']], true)), 'hidden differs');
    assert.ok(!sameFingerprint(a, fingerprint([['a', 2], ['b']], false)), 'a value differs');
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
  });
});

describe('allow-list exceptions and protected names of the migrate tool', () => {
  test('never a personal tab, never the marker (except migrate writing it), only the right sheet per mode', () => {
    for (const n of PERSONAL_TABS) for (const mode of ['migrate', 'rehearsal', 'copy-back', 'delete', 'cleanup'] as const) assert.ok(targetRefusal('portfolio', n, mode), n + ' ' + mode);
    for (const mode of ['rehearsal', 'copy-back', 'delete', 'cleanup'] as const) {
      for (const role of ['portfolio', 'reports', 'data'] as const) assert.match(String(targetRefusal(role, MIGRATION_MARKER_TAB, mode)), /never touches "💾 Migration"/);
    }
    assert.equal(targetRefusal('data', MIGRATION_MARKER_TAB, 'migrate'), null);
    assert.equal(targetRefusal('reports', REHEARSAL_PREFIX + '💾 TSLA', 'rehearsal'), null, 'stand-ins only with the prefix, only in the reports sheet');
    assert.ok(targetRefusal('reports', '💾 TSLA', 'rehearsal'), 'a data name never lands in the reports sheet');
    assert.ok(targetRefusal('data', REHEARSAL_PREFIX + '💾 TSLA', 'rehearsal'));
    assert.ok(targetRefusal('portfolio', '💾 TSLA', 'rehearsal'), 'the rehearsal never writes My Portfolio');
    assert.equal(targetRefusal('portfolio', '💾 TSLA', 'copy-back'), null);
    assert.ok(targetRefusal('portfolio', 'Portfolio', 'copy-back'));
    assert.equal(targetRefusal('portfolio', '📈 Decision History', 'delete'), null, 'a stale copy in My Portfolio after a verified switch');
    assert.ok(targetRefusal('portfolio', 'Portfolio', 'delete') && targetRefusal('portfolio', '🎯 Watchlist', 'delete'));
    assert.ok(targetRefusal('data', '💾 TSLA', 'delete'), '`delete` removes from My Portfolio only');
  });
});

describe('check and plan', () => {
  test('check passes on two empty sheets; fails when a new sheet holds something unknown', async () => {
    const g = world();
    const out: string[] = [];
    assert.equal((await stepCheck(deps(g, out))).ok, true, out.join('\n'));
    g.addTab(g.books.get('D')!, 'Notes', [['owner wrote here']]);
    assert.equal((await stepCheck(deps(g))).ok, false);
  });
  test('check fails when the robot is not Editor', async () => {
    const g = world();
    g.readOnly.add('R');
    const out: string[] = [];
    assert.equal((await stepCheck(deps(g, out))).ok, false);
    assert.ok(out.some((l) => /reports spreadsheet: .*can NOT edit/.test(l)));
  });
  test('plan lists the sets and the reference check, and writes nothing', async () => {
    const g = world();
    const out: string[] = [];
    await stepPlan(deps(g, out));
    assert.ok(out.some((l) => l.startsWith('To copy to the data spreadsheet (8)')));
    assert.ok(out.some((l) => l.startsWith('To copy to the reports spreadsheet (10)')));
    assert.ok(out.some((l) => l.startsWith('To delete without copying, regenerated by the next Analyze (2)')));
    for (const id of ['P', 'R', 'D']) assert.equal(g.writeCount(id), 0);
  });
});

describe('reference check (read-only)', () => {
  test('direct references, INDIRECT/IMPORTRANGE/QUERY, pivots, charts, filter views, named ranges', () => {
    const scan = {
      namedRanges: [{ name: 'prices', range: { sheetId: 7 } }],
      sheets: [{
        properties: { title: 'DASHBOARD', sheetId: 1 },
        data: [{ rowData: [{ values: [
          { userEnteredValue: { formulaValue: "='🛒 Buy Report'!A1" } },
          { userEnteredValue: { formulaValue: '=INDIRECT("\'💾 "&A1&"\'!B2")' } },
          { userEnteredValue: { formulaValue: '=SUM(A1:A3)' } },
          { pivotTable: { source: { sheetId: 7 } } },
        ] }] }],
        charts: [{ chartId: 3, spec: { basicChart: { domains: [{ domain: { sourceRange: { sources: [{ sheetId: 7 }] } } }] } } }],
        filterViews: [{ title: 'mine', range: { sheetId: 1 } }],
      }],
    };
    const hits = findReferences(scan as never, ['🛒 Buy Report', '💾 TSLA'], new Set([7]));
    const kinds = hits.map((h) => h.kind + ' ' + h.where);
    assert.deepEqual(kinds, ['direct prices', 'direct A1', 'review B1', 'direct D1', 'direct chart 3', 'review filter view "mine"']);
  });
  test('migrate refuses while a staying tab reads a moving tab directly, unless the owner accepted it', async () => {
    const g = world();
    g.tab('P', 'DASHBOARD')!.cells = [["='🛒 Buy Report'!A1"], ['=IMPORTRANGE("x","y")']];
    const out: string[] = [];
    await assert.rejects(stepMigrate(deps(g, out)), /direct references/);
    assert.equal(g.books.get('P')!.metadata.has(MIGRATED_FLAG), false);
    assert.ok(out.some((l) => /\[review\] DASHBOARD A2/.test(l)), 'IMPORTRANGE listed for review');
    assert.equal((await stepMigrate(deps(g), { acceptReferences: true })).ok, true);
  });
});

describe('rehearsal in the two empty target sheets', () => {
  test('rehearse: copy, verify, the copy-back replace path on REHEARSAL stand-ins; both sheets empty again; My Portfolio never written', async () => {
    const g = world();
    const out: string[] = [];
    const r = await stepRehearse(deps(g, out));
    assert.equal(r.ok, true, out.join('\n'));
    assert.ok(out.some((l) => /^Copied back 8, mismatches 0\.$/.test(l)), out.join('\n'));
    for (const id of ['R', 'D']) assert.deepEqual(g.titles(id).filter((t) => !/^Sheet\d+$/.test(t)), [], id + ' empty again');
    assert.equal(g.writeCount('P'), 0, 'My Portfolio is only read');
    assert.equal(g.books.get('P')!.metadata.size, 0, 'neither flag nor marker');
    assert.ok(g.calls.filter((c) => c.method === 'copyTo').length >= 8 + 10 + 8 + 8, 'copy, stand-ins and the copy-back path all ran');
  });
  test('rehearse-cleanup is idempotent after a half-done rehearsal', async () => {
    const g = world();
    const d = g.books.get('D')!, r = g.books.get('R')!;
    g.addTab(d, '💾 TSLA', [['partial']]);
    g.addTab(d, 'Copy of 💾 NVDA', [['stray']]);
    g.addTab(r, REHEARSAL_PREFIX + '💾 TSLA', [['stand-in']]);
    g.addTab(r, '🛒 Buy Report', [['partial']]);
    assert.equal((await stepRehearseCleanup(deps(g))).ok, true);
    for (const id of ['R', 'D']) assert.deepEqual(g.titles(id), ['Sheet1'], id);
    assert.equal((await stepRehearseCleanup(deps(g))).ok, true, 'again: nothing to do, still passes');
  });
  test('the rehearsal refuses once the flag is set or a marker exists', async () => {
    const g = world();
    g.books.get('P')!.metadata.set(MIGRATED_FLAG, 'x');
    await assert.rejects(stepRehearse(deps(g)), /already marked as moved/);
    const g2 = world();
    g2.addTab(g2.books.get('D')!, MIGRATION_MARKER_TAB, [['Status', 'VERIFIED']]);
    await assert.rejects(stepRehearseCleanup(deps(g2)), /already holds the migration record/);
    assert.ok(g2.titles('D').includes(MIGRATION_MARKER_TAB), 'the marker is never deleted');
  });
});

describe('migrate', () => {
  test('copies 8 + 10, re-hides _OPTIONS_SNAPSHOT, verifies, sets the flag, then the marker; the next run routes', async () => {
    const g = world();
    const out: string[] = [];
    const r = await stepMigrate(deps(g, out));
    assert.equal(r.ok, true, out.join('\n'));
    assert.deepEqual(new Set(g.titles('D')), new Set([...Object.keys(DATA_TABS), MIGRATION_MARKER_TAB]), 'the blank default tab is gone');
    assert.deepEqual(new Set(g.titles('R')), new Set(Object.keys(REPORT_TABS)));
    assert.equal(g.tab('D', '_OPTIONS_SNAPSHOT')!.hidden, true);
    for (const t of MOVED) assert.deepEqual(g.values(sheetOf(t), t), g.values('P', t), t);
    assert.ok(g.books.get('P')!.metadata.has(MIGRATED_FLAG));
    const m = parseMarker(g.values('D', MIGRATION_MARKER_TAB))!;
    assert.equal(m.status, 'VERIFIED');
    assert.deepEqual([m.portfolioId, m.reportsId, m.dataId], ['P', 'R', 'D']);
    assert.equal(m.tabs.length, 18);
    assert.deepEqual(new Set(m.deleteOnly), new Set(Object.keys(P_TABS)));
    const s = await compose(g);
    assert.equal(s.dataSheets!.spreadsheetId, 'D');
    assert.equal(await s.kv.get('k1'), 'v1');
    await assert.rejects(stepMigrate(deps(g)), /already done/);
  });
  test('idempotent: removes stray copies, skips tabs already present and equal, copies the rest', async () => {
    const g = world();
    g.addTab(g.books.get('D')!, '💾 TSLA', DATA_TABS['💾 TSLA']!.map((r) => [...r]));
    g.addTab(g.books.get('D')!, 'Copy of 💾 NVDA', [['stray']]);
    g.addTab(g.books.get('R')!, '🛒 Buy Report', [['half-written']]);
    const out: string[] = [];
    assert.equal((await stepMigrate(deps(g, out))).ok, true, out.join('\n'));
    assert.ok(out.some((l) => /Removed 1 stray "Copy of" tab/.test(l)));
    assert.ok(out.some((l) => /^Copied 7, already present and equal 1, mismatches 0\.$/.test(l)), out.join('\n'));
    assert.deepEqual(g.values('R', '🛒 Buy Report'), [['buy']], 'a different partial copy is replaced');
    assert.ok(!g.titles('D').some((t) => t.startsWith('Copy of')));
  });
  test('a copy that does not verify: nothing is switched', async () => {
    const g = world();
    g.corruptCopies.add('💾 NVDA');
    const out: string[] = [];
    const r = await stepMigrate(deps(g, out));
    assert.equal(r.ok, false);
    assert.ok(out.some((l) => /verify FAILED for 💾 NVDA/.test(l)), out.join('\n'));
    assert.equal(g.books.get('P')!.metadata.has(MIGRATED_FLAG), false);
    assert.ok(!g.titles('D').includes(MIGRATION_MARKER_TAB));
    const s = await compose(g);
    assert.equal(s.dataSheets, null, 'runs keep using My Portfolio');
  });
  test('a crash between the flag and the marker: every run refuses; abort clears the flag; re-running migrate finishes', async () => {
    const g = world();
    g.failWhen = (id, r) => id === 'D' && !!r.addSheet && r.addSheet.properties?.title === MIGRATION_MARKER_TAB;
    await assert.rejects(stepMigrate(deps(g)));
    assert.ok(g.books.get('P')!.metadata.has(MIGRATED_FLAG), 'the flag was written first');
    assert.ok(!g.titles('D').includes(MIGRATION_MARKER_TAB));
    await assert.rejects(compose(g), SheetsRefusedError);
    await assert.rejects(compose(g, { ...ENV, REPORTS_SPREADSHEET_ID: '', DATA_SPREADSHEET_ID: '' }), SheetsRefusedError);
    g.failWhen = null;
    const out: string[] = [];
    await stepAbort(deps(g, out), true);
    assert.ok(!g.books.get('P')!.metadata.has(MIGRATED_FLAG));
    assert.equal((await compose(g)).dataSheets, null);
    assert.equal((await stepMigrate(deps(g))).ok, true, 'and migrate can be run again');
    assert.equal(parseMarker(g.values('D', MIGRATION_MARKER_TAB))!.status, 'VERIFIED');
  });
});

/** A routed run after the move: writes the data sheet (Script Properties, Paper State, a new ticker). */
async function nightlyAfterSwitch(g: FakeGoogle): Promise<void> {
  const s = await compose(g);
  await s.kv.set('k-new', 'after the switch');
  await s.tabStore.ensure('💾 NEWT');
  await s.tabStore.write('💾 NEWT', 1, [['META', '{}']]);
  await s.tabStore.write('📝 Paper State', 1, [['{"day":"2026-11-02"}']]);
  await s.tabStore.write('📒 Paper Log', 1, [['pl'], ['2026-11-02']]);
  await s.flushStores();
}

describe('delete (after the post-switch check)', () => {
  test('dry run first; --yes removes the moved and the P report tabs; personal and staying tabs remain', async () => {
    const g = world();
    await stepMigrate(deps(g));
    await nightlyAfterSwitch(g);
    const out: string[] = [];
    assert.equal((await stepDelete(deps(g, out), false)).ok, true, out.join('\n'));
    assert.ok(out.some((l) => /^delete: 20 tab\(s\) to remove from My Portfolio; 5 stay\.$/.test(l)), out.join('\n'));
    assert.equal(g.titles('P').length, 25, 'dry run: nothing deleted');
    assert.equal((await stepDelete(deps(g), true)).ok, true);
    assert.deepEqual(new Set(g.titles('P')), new Set(Object.keys(OWNER_TABS)));
    assert.ok(g.titles('D').includes(MIGRATION_MARKER_TAB));
  });
  test('the post-switch check fails if a My Portfolio copy changed after the move (something wrote only there)', async () => {
    const g = world();
    await stepMigrate(deps(g));
    await nightlyAfterSwitch(g);
    g.tab('P', '💾 Script Properties')!.cells.push(['late', 'write', '2026-11-02']);
    const out: string[] = [];
    assert.equal((await stepDelete(deps(g, out), true)).ok, false);
    assert.ok(out.some((l) => /"💾 Script Properties" changed after the move/.test(l)));
    assert.equal(g.titles('P').length, 25);
  });
  test('the post-switch check fails until a run has written the data sheet, and on a tab in the wrong sheet', async () => {
    const g = world();
    await stepMigrate(deps(g));
    const c1 = await postSwitchCheck(deps(g));
    assert.ok(c1.problems.some((p) => /Run the Nightly first/.test(p)));
    await nightlyAfterSwitch(g);
    g.addTab(g.books.get('D')!, '🛒 Buy Report', [['wrong place']]);
    const c2 = await postSwitchCheck(deps(g));
    assert.ok(c2.problems.some((p) => /data spreadsheet that belong elsewhere: 🛒 Buy Report/.test(p)), c2.problems.join('\n'));
  });
});

describe('copy-back (the rollback)', () => {
  test('round trip: every data tab (new ticker included, marker excluded) and the 10 reports back, verified; flag cleared; marker ROLLED_BACK; runs use My Portfolio', async () => {
    const g = world();
    await stepMigrate(deps(g));
    await nightlyAfterSwitch(g);
    await stepDelete(deps(g), true);
    const out: string[] = [];
    assert.equal((await stepCopyBack(deps(g, out))).ok, true, out.join('\n'));
    for (const t of [...MOVED, '💾 NEWT']) assert.deepEqual(g.values('P', t), g.values(sheetOf(t), t), t);
    assert.deepEqual(g.values('P', '📝 Paper State'), [['{"day":"2026-11-02"}']], 'the paper state and log stay in step');
    assert.deepEqual(g.values('P', '📒 Paper Log'), [['pl'], ['2026-11-02']]);
    assert.ok(g.values('P', '💾 Script Properties').some((r) => r[0] === 'k-new'));
    assert.equal(g.tab('P', '_OPTIONS_SNAPSHOT')!.hidden, true, 're-hidden');
    assert.ok(!g.titles('P').includes(MIGRATION_MARKER_TAB));
    assert.ok(!g.books.get('P')!.metadata.has(MIGRATED_FLAG));
    assert.equal(parseMarker(g.values('D', MIGRATION_MARKER_TAB))!.status, 'ROLLED_BACK');
    const s = await compose(g);
    assert.equal(s.dataSheets, null);
    assert.equal(await s.kv.get('k-new'), 'after the switch');
  });
  test('before delete: the stale copies are replaced', async () => {
    const g = world();
    await stepMigrate(deps(g));
    await nightlyAfterSwitch(g);
    assert.equal((await stepCopyBack(deps(g))).ok, true);
    assert.deepEqual(g.values('P', '📝 Paper State'), [['{"day":"2026-11-02"}']]);
    assert.equal(g.titles('P').filter((t) => t === '📝 Paper State').length, 1);
    assert.ok(!g.titles('P').some((t) => t.startsWith('Copy of')));
  });
  test('without a marker it refuses (abort is the tool for a flag without a marker)', async () => {
    await assert.rejects(stepCopyBack(deps(world())), /no migration record/);
  });
});

describe('the command line: time windows, the pause, waiting for running writers', () => {
  const run = async (g: FakeGoogle, argv: string[], o: { now?: number; running?: () => Promise<string[]>; env?: Record<string, string> } = {}) => {
    const out: string[] = [], err: string[] = [];
    let t = o.now ?? NOW;
    const pauses: string[] = [];
    const mk = (id: string) => new SheetsClient({ spreadsheetId: id, api: g.api, limiter: RateLimiter.perMinute(1_000_000) });
    const code = await runMigrateDataTabs({
      env: o.env ?? { SPREADSHEET_ID: 'P', REPORTS_SPREADSHEET_ID: 'R', DATA_SPREADSHEET_ID: 'D' }, argv, out: (l) => out.push(l), errOut: (l) => err.push(l),
      makeSheets: mk, now: () => t, sleep: async (ms) => { t += ms; pauses.push(String(g.books.get('P')!.metadata.get(PAUSED_FLAG))); },
      listRunningWriters: o.running ?? (async () => []), ctx: quiet(),
    });
    return { code, out, err, pauses };
  };
  test('the blocked windows: 20:30-23:00 and 03:00-05:30 UTC', () => {
    for (const [hhmm, blocked] of [['20:29', false], ['20:30', true], ['22:59', true], ['23:00', false], ['02:59', false], ['03:00', true], ['05:29', true], ['05:30', false], ['12:00', false]] as const) {
      assert.equal(!!migrationBlockedWindow(new Date('2026-11-02T' + hhmm + ':00Z')), blocked, hhmm);
    }
  });
  test('a writing step inside a window is refused before anything is written; check and plan are not', async () => {
    const g = world();
    const r = await run(g, ['migrate'], { now: Date.parse('2026-11-02T21:10:00Z') });
    assert.equal(r.code, 2);
    assert.match(r.err.join(''), /refused between 20:30 and 23:00 UTC/);
    assert.equal(g.writeCount('P') + g.writeCount('R') + g.writeCount('D'), 0);
    assert.equal((await run(g, ['plan'], { now: Date.parse('2026-11-02T21:10:00Z') })).code, 0);
  });
  test('the pause is set first (2 hours), held while waiting for running writers, cleared at the end', async () => {
    const g = world();
    let calls = 0;
    const r = await run(g, ['rehearse-cleanup'], { running: async () => (++calls <= 2 ? ['Analyze #1'] : []) });
    assert.equal(r.code, 0, r.out.join('\n'));
    assert.deepEqual(r.pauses, ['2026-11-02T14:00:00.000Z', '2026-11-02T14:00:00.000Z']);
    assert.ok(!g.books.get('P')!.metadata.has(PAUSED_FLAG), 'cleared');
    assert.ok(r.out.some((l) => /Waiting for: Analyze #1/.test(l)));
  });
  test('a writer still running after 30 minutes: the pause is cleared and nothing is done', async () => {
    const g = world();
    const r = await run(g, ['migrate'], { running: async () => ['Nightly #9'] });
    assert.equal(r.code, 1);
    assert.ok(r.out.some((l) => /Still running after 30 minutes: Nightly #9\. Nothing was done\./.test(l)));
    assert.ok(r.pauses.length >= WRITER_WAIT_MS / 30_000 - 1);
    assert.ok(!g.books.get('P')!.metadata.has(PAUSED_FLAG));
    assert.ok(!g.books.get('P')!.metadata.has(MIGRATED_FLAG));
    assert.equal(g.titles('D').length, 1);
  });
  test('the pause is cleared even when the step crashes; unpause is a no-op without a pause', async () => {
    const g = world();
    g.failWhen = (id, rq) => id === 'D' && !!rq.addSheet && rq.addSheet.properties?.title === MIGRATION_MARKER_TAB;
    const r = await run(g, ['migrate']);
    assert.equal(r.code, 1, r.out.join('\n'));
    assert.ok(!g.books.get('P')!.metadata.has(PAUSED_FLAG), 'pause cleared');
    assert.ok(g.books.get('P')!.metadata.has(MIGRATED_FLAG), 'flag without marker: every run refuses until abort or a re-run');
    g.failWhen = null;
    assert.equal((await run(g, ['copy-back'])).code, 2, 'copy-back refuses without a marker');
    assert.equal((await run(g, ['abort'])).code, 0);
    assert.ok(!g.books.get('P')!.metadata.has(MIGRATED_FLAG));
    const u = await run(g, ['unpause']);
    assert.equal(u.code, 0);
    assert.match(u.out.join(''), /no pause was set/);
  });
  test('configuration: IDs missing or equal, unknown step', async () => {
    const g = world();
    assert.equal((await run(g, ['check'], { env: { SPREADSHEET_ID: 'P', REPORTS_SPREADSHEET_ID: '', DATA_SPREADSHEET_ID: 'D' } })).code, 2);
    assert.equal((await run(g, ['check'], { env: { SPREADSHEET_ID: 'P', REPORTS_SPREADSHEET_ID: 'D', DATA_SPREADSHEET_ID: 'D' } })).code, 2);
    assert.equal((await run(g, ['frobnicate'])).code, 2);
  });
  test('end to end through the command line: rehearse, migrate, delete --yes, copy-back', async () => {
    const g = world();
    assert.equal((await run(g, ['check'])).code, 0);
    assert.equal((await run(g, ['rehearse'])).code, 0);
    assert.equal((await run(g, ['migrate'])).code, 0);
    await nightlyAfterSwitch(g);
    assert.equal((await run(g, ['delete'])).code, 0);
    assert.equal(g.titles('P').length, 25);
    assert.equal((await run(g, ['delete', '--yes'])).code, 0);
    assert.equal(g.titles('P').length, 5);
    assert.equal((await run(g, ['copy-back'])).code, 0);
    assert.ok(!g.books.get('P')!.metadata.has(MIGRATED_FLAG) && !g.books.get('P')!.metadata.has(PAUSED_FLAG));
    const st = await deps(g).sheets.data.spreadsheetState(quiet());
    assert.ok(st.ok);
    const m = await readMarker(quiet(), deps(g).sheets.data, st.value);
    assert.equal(m!.status, 'ROLLED_BACK');
  });
  test('the GitHub pre-check lists in-progress runs of the six writer workflows only', async () => {
    const fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => {
      assert.match(url, /repos\/o\/r\/actions\/runs\?status=in_progress/);
      assert.equal(init.headers.Authorization, 'Bearer t');
      return new Response(JSON.stringify({ workflow_runs: [
        { path: '.github/workflows/analyze.yml', name: 'Analyze', id: 1 },
        { path: '.github/workflows/ci.yml', name: 'CI', id: 2 },
        { path: '.github/workflows/migrate-data-tabs.yml', name: 'Migrate data tabs', id: 3 },
        { path: '.github/workflows/my-options.yml', name: 'My Options', id: 4 },
      ] }), { status: 200 });
    }) as unknown as typeof fetch;
    assert.deepEqual(await githubRunningWriters({ GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' }, fetchImpl), ['Analyze #1', 'My Options #4']);
    await assert.rejects(githubRunningWriters({}, fetchImpl), /GITHUB_TOKEN/);
  });
});

function sheetOf(t: string): string {
  return t.startsWith('💾 ') || ['_OPTIONS_SNAPSHOT', '🔬 Log', '📝 Paper State'].includes(t) ? 'D' : 'R';
}
