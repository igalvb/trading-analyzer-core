import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { sheets_v4 } from 'googleapis';
import { createContext } from '../src/core/context.ts';
import { Logger } from '../src/core/logger.ts';
import type { LogLine } from '../src/core/logger.ts';
import { err, ok, logDetail } from '../src/core/result.ts';
import type { StepResult } from '../src/core/result.ts';
import { SheetsClient, lockFailureSentence } from '../src/sheets/client.ts';
import type { LockPhase, TabColorChange, TabColorInfo } from '../src/sheets/client.ts';
import { LOCK_COLOR, SheetLockError, isLockRed, lockAllTabs, unlockAllTabs, withUnlockedSheets } from '../src/sheets/masterLock.ts';
import type { MasterLockSheets } from '../src/sheets/masterLock.ts';
import { runLockSheets } from '../src/lockSheets.ts';
import { labelledReason } from '../src/reports/messages/catalog.ts';
import { findReportLeaks } from '../src/reports/messages/leakScan.ts';
import { MENU_ENTRY_POINTS } from '../src/reports/options/ui.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, '..');
const RELOCK_LINE = labelledReason('Sheet lock', 'SHEET_LOCK_FAILED');

function mkCtx() {
  const lines: LogLine[] = [];
  const log = new Logger({ sink: (l) => lines.push(l), scope: 'lock', now: () => new Date(0) });
  const ctx = createContext({ mode: 'test', runId: 'r1', logger: log, sleep: async () => {}, backoffBaseMs: 1, backoffMaxMs: 2, random: () => 0 });
  return { ctx, lines };
}

const failure = (phase: LockPhase): StepResult<never> =>
  err({ kind: 'transient', detail: logDetail('boom'), disclosure: lockFailureSentence(phase), attempts: 1 });

class FakeSheets implements MasterLockSheets {
  tabs: Array<{ sheetId: number; title: string; color: string | null; themed: boolean }>;
  events: string[] = [];
  failWrites: LockPhase | 'both' | null = null;
  throwOnLockRead = false;
  constructor(colors: Array<string | null | 'theme'>) {
    this.tabs = colors.map((c, i) => ({ sheetId: i + 1, title: 'Tab' + (i + 1), color: c === 'theme' ? null : c, themed: c === 'theme' }));
  }
  async tabColors(_ctx: unknown, phase: LockPhase): Promise<StepResult<TabColorInfo[]>> {
    this.events.push('read:' + phase);
    if (phase === 'lock' && this.throwOnLockRead) throw new Error('read exploded');
    return ok(this.tabs.map((t) => ({ ...t })));
  }
  async setTabColors(_ctx: unknown, phase: LockPhase, changes: readonly TabColorChange[]): Promise<StepResult<number>> {
    this.events.push(`write:${phase}:${changes.length}`);
    if (this.failWrites === phase || this.failWrites === 'both') return failure(phase);
    for (const c of changes) {
      const t = this.tabs.find((x) => x.sheetId === c.sheetId)!;
      t.color = c.color;
      t.themed = false;
    }
    return ok(changes.length);
  }
  colors(): Array<string | null> { return this.tabs.map((t) => t.color); }
}

describe('FL-9e withUnlockedSheets: order, try/finally', () => {
  test('unlock, then write, then lock: in that order, every tab ends #d50000', async () => {
    const fake = new FakeSheets([LOCK_COLOR, LOCK_COLOR, null]);
    const { ctx } = mkCtx();
    const run = await withUnlockedSheets(ctx, fake, async () => {
      assert.deepEqual(fake.colors(), [null, null, null], 'unlocked while writing');
      fake.events.push('fn');
      return 42;
    });
    assert.equal(run.value, 42);
    assert.equal(run.relocked, true);
    assert.deepEqual(run.reportLines, []);
    assert.deepEqual(fake.events, ['read:unlock', 'write:unlock:2', 'fn', 'read:lock', 'write:lock:3']);
    assert.deepEqual(fake.colors(), [LOCK_COLOR, LOCK_COLOR, LOCK_COLOR]);
  });

  test('re-locks when fn throws, and fn\'s own error is the one that propagates', async () => {
    const fake = new FakeSheets([LOCK_COLOR, LOCK_COLOR]);
    const { ctx } = mkCtx();
    const boom = new Error('write crashed half way');
    await assert.rejects(() => withUnlockedSheets(ctx, fake, async () => { throw boom; }), (e) => e === boom);
    assert.deepEqual(fake.colors(), [LOCK_COLOR, LOCK_COLOR]);
    assert.equal(fake.events.at(-1), 'write:lock:2');
  });

  test('a failed re-lock is logged and surfaced as a plain report line, and the value is still returned', async () => {
    const fake = new FakeSheets([LOCK_COLOR, null]);
    fake.failWrites = 'lock';
    const { ctx, lines } = mkCtx();
    const run = await withUnlockedSheets(ctx, fake, async () => 'done');
    assert.equal(run.value, 'done');
    assert.equal(run.relocked, false);
    assert.deepEqual(run.reportLines, [RELOCK_LINE]);
    assert.deepEqual(findReportLeaks(run.reportLines[0] as string), []);
    assert.ok(!/cache/i.test(run.reportLines[0] as string));
    const st = ctx.status.get('sheets.lockTabs');
    assert.equal(st?.state, 'failed');
    assert.equal(String(st?.disclosure), RELOCK_LINE);
    assert.ok(lines.some((l) => /re-lock FAILED/.test(JSON.stringify(l))), 'the technical story is in the log');
  });

  test('a failed re-lock never swallows fn\'s own error', async () => {
    const fake = new FakeSheets([LOCK_COLOR]);
    fake.failWrites = 'lock';
    const { ctx } = mkCtx();
    const boom = new Error('fn failed');
    await assert.rejects(() => withUnlockedSheets(ctx, fake, async () => { throw boom; }), (e) => e === boom);
    assert.equal(ctx.status.get('sheets.lockTabs')?.state, 'failed');
  });

  test('a re-lock that throws (not just fails) is also contained', async () => {
    const fake = new FakeSheets([LOCK_COLOR]);
    fake.throwOnLockRead = true;
    const { ctx } = mkCtx();
    const run = await withUnlockedSheets(ctx, fake, async () => 1);
    assert.equal(run.relocked, false);
    assert.deepEqual(run.reportLines, [RELOCK_LINE]);
  });

  test('unlock failure: fn does not run, the lock is still attempted, SheetLockError is thrown', async () => {
    const fake = new FakeSheets([LOCK_COLOR, LOCK_COLOR]);
    fake.failWrites = 'unlock';
    const { ctx } = mkCtx();
    let ran = false;
    await assert.rejects(() => withUnlockedSheets(ctx, fake, async () => { ran = true; }), (e) => e instanceof SheetLockError && e.phase === 'unlock');
    assert.equal(ran, false);
    assert.deepEqual(fake.colors(), [LOCK_COLOR, LOCK_COLOR]);
    assert.equal(String(ctx.status.get('sheets.unlockTabs')?.disclosure), labelledReason('Sheet lock', 'SHEET_UNLOCK_FAILED'));
  });
});

describe('FL-9e lock and unlock primitives', () => {
  test('lock is idempotent: the second call writes nothing', async () => {
    const fake = new FakeSheets([null, '#4a148c', 'theme']);
    const { ctx } = mkCtx();
    const a = await lockAllTabs(ctx, fake);
    assert.ok(a.ok && a.value.changed === 3 && a.value.total === 3);
    assert.deepEqual(fake.colors(), [LOCK_COLOR, LOCK_COLOR, LOCK_COLOR]);
    const b = await lockAllTabs(ctx, fake);
    assert.ok(b.ok && b.value.changed === 0 && b.value.total === 3);
    assert.deepEqual(fake.colors(), [LOCK_COLOR, LOCK_COLOR, LOCK_COLOR]);
    assert.equal(fake.events.at(-1), 'write:lock:0');
  });

  test('unlock is idempotent', async () => {
    const fake = new FakeSheets([LOCK_COLOR, null]);
    const { ctx } = mkCtx();
    const a = await unlockAllTabs(ctx, fake);
    assert.ok(a.ok && a.value.changed === 1);
    const b = await unlockAllTabs(ctx, fake);
    assert.ok(b.ok && b.value.changed === 0);
    assert.deepEqual(fake.colors(), [null, null]);
  });

  test('accent colours survive an unlock by default (F-L3), and are cleared with keepAccentsOnUnlock false', async () => {
    const a = new FakeSheets([LOCK_COLOR, '#1a73e8', 'theme', null]);
    const { ctx } = mkCtx();
    const r = await unlockAllTabs(ctx, a);
    assert.ok(r.ok && r.value.changed === 1 && r.value.keptAccents === 2);
    assert.deepEqual(a.colors(), [null, '#1a73e8', null, null]);
    assert.equal(a.tabs[2]!.themed, true);
    const b = new FakeSheets([LOCK_COLOR, '#1a73e8', 'theme', null]);
    const r2 = await unlockAllTabs(ctx, b, { keepAccentsOnUnlock: false });
    assert.ok(r2.ok && r2.value.changed === 3 && r2.value.keptAccents === 0);
    assert.deepEqual(b.colors(), [null, null, null, null]);
  });

  test('upper-case #D50000 is not treated as locked (matches the shim\'s === compare)', () => {
    assert.equal(isLockRed({ sheetId: 1, title: 't', color: '#d50000', themed: false }), true);
    assert.equal(isLockRed({ sheetId: 1, title: 't', color: null, themed: true }), false);
  });
});

describe('FL-9e `if: always()` step after a mid-write crash', () => {
  test('the process dies after unlock (no finally runs); npm run lock-sheets leaves every tab #d50000', async () => {
    const fake = new FakeSheets([LOCK_COLOR, LOCK_COLOR, '#1a73e8']);
    const { ctx } = mkCtx();
    await unlockAllTabs(ctx, fake); // a killed process: unlock happened, the finally never did
    assert.ok(fake.colors().every((c) => c !== LOCK_COLOR), 'the sheet is open');
    const out: string[] = []; const errs: string[] = [];
    const code = await runLockSheets({
      env: { GOOGLE_SERVICE_ACCOUNT_JSON: 'x', SPREADSHEET_ID: 's' }, argv: [], out: (l) => out.push(l), errOut: (l) => errs.push(l),
      makeSheets: () => fake, ctx: mkCtx().ctx,
    });
    assert.equal(code, 0);
    assert.deepEqual(fake.colors(), [LOCK_COLOR, LOCK_COLOR, LOCK_COLOR]);
    assert.deepEqual(errs, []);
    assert.match(out[0] as string, /3 of 3 tab\(s\) locked/);
  });
});

describe('FL-9e CLI', () => {
  test('missing variables: exit 2, names only', async () => {
    const errs: string[] = [];
    const code = await runLockSheets({ env: { SPREADSHEET_ID: '' }, argv: [], out: () => {}, errOut: (l) => errs.push(l) });
    assert.equal(code, 2);
    assert.match(errs.join(' '), /GOOGLE_SERVICE_ACCOUNT_JSON, SPREADSHEET_ID/);
  });
  test('unusable credentials: exit 2 and the secret is never printed', async () => {
    const out: string[] = []; const errs: string[] = [];
    const code = await runLockSheets({
      env: { GOOGLE_SERVICE_ACCOUNT_JSON: '{not json PRIVATEKEYMARKER', SPREADSHEET_ID: 'sheet-id-marker' }, argv: [], out: (l) => out.push(l), errOut: (l) => errs.push(l),
    });
    assert.equal(code, 2);
    assert.ok(!(out.join(' ') + errs.join(' ')).includes('PRIVATEKEYMARKER'));
  });
  test('a failed lock exits non-zero', async () => {
    const fake = new FakeSheets([null]);
    fake.failWrites = 'lock';
    const errs: string[] = [];
    const code = await runLockSheets({ env: { GOOGLE_SERVICE_ACCOUNT_JSON: 'x', SPREADSHEET_ID: 's' }, argv: [], out: () => {}, errOut: (l) => errs.push(l), makeSheets: () => fake, ctx: mkCtx().ctx });
    assert.equal(code, 1);
    assert.equal(errs.length, 1);
  });
  test('--unlock clears the lock; --clear-all also clears accents', async () => {
    const fake = new FakeSheets([LOCK_COLOR, '#1a73e8']);
    const env = { GOOGLE_SERVICE_ACCOUNT_JSON: 'x', SPREADSHEET_ID: 's' };
    assert.equal(await runLockSheets({ env, argv: ['--unlock'], out: () => {}, errOut: () => {}, makeSheets: () => fake, ctx: mkCtx().ctx }), 0);
    assert.deepEqual(fake.colors(), [null, '#1a73e8']);
    assert.equal(await runLockSheets({ env, argv: ['--unlock', '--clear-all'], out: () => {}, errOut: () => {}, makeSheets: () => fake, ctx: mkCtx().ctx }), 0);
    assert.deepEqual(fake.colors(), [null, null]);
  });
});

describe('FL-9e the real SheetsClient against a fake API', () => {
  function fakeApi(opts: { failBatch?: boolean } = {}) {
    const batches: Array<Array<Record<string, any>>> = [];
    const api = {
      spreadsheets: {
        get: async () => ({
          data: {
            sheets: [
              { properties: { sheetId: 1, title: 'A', tabColorStyle: { rgbColor: { red: 213 / 255 } } } },
              { properties: { sheetId: 2, title: 'B' } },
              { properties: { sheetId: 3, title: 'C', tabColorStyle: { themeColor: 'ACCENT1' } } },
              { properties: { sheetId: 4, title: 'D', tabColor: { red: 0.1, green: 0.45, blue: 0.91 } } },
            ],
          },
        }),
        batchUpdate: async (p: { requestBody: { requests: Array<Record<string, any>> } }) => {
          if (opts.failBatch) throw new Error('boom');
          batches.push(p.requestBody.requests);
          return { data: {} };
        },
      },
    } as unknown as sheets_v4.Sheets;
    return { api, batches };
  }

  test('reads colours as hex (rgb, legacy tabColor, theme) and locks only the tabs that are not red', async () => {
    const { api, batches } = fakeApi();
    const client = new SheetsClient({ spreadsheetId: 's', api });
    const { ctx } = mkCtx();
    const read = await client.tabColors(ctx, 'lock');
    assert.ok(read.ok);
    assert.deepEqual((read as any).value.map((t: TabColorInfo) => [t.color, t.themed]), [['#d50000', false], [null, false], [null, true], ['#1a73e8', false]]);
    const r = await lockAllTabs(ctx, client);
    assert.ok(r.ok && r.value.changed === 3);
    assert.equal(batches.length, 1, 'one batchUpdate call');
    assert.deepEqual(batches[0]!.map((q) => q.updateSheetProperties.properties.sheetId), [2, 3, 4]);
    for (const q of batches[0]!) {
      assert.equal(q.updateSheetProperties.fields, 'tabColorStyle');
      assert.equal(Math.round(q.updateSheetProperties.properties.tabColorStyle.rgbColor.red * 255), 213);
      assert.equal(q.updateSheetProperties.properties.tabColorStyle.rgbColor.green, 0);
    }
  });

  test('unlock sends a clearing request (both tab colour fields) for the red tab only', async () => {
    const { api, batches } = fakeApi();
    const { ctx } = mkCtx();
    const r = await unlockAllTabs(ctx, new SheetsClient({ spreadsheetId: 's', api }));
    assert.ok(r.ok && r.value.changed === 1 && r.value.keptAccents === 2);
    assert.deepEqual(batches[0], [{ updateSheetProperties: { properties: { sheetId: 1 }, fields: 'tabColor,tabColorStyle' } }]);
  });

  test('a real write failure on re-lock reaches the report as one plain line', async () => {
    const { api } = fakeApi({ failBatch: true });
    const { ctx } = mkCtx();
    const run = await withUnlockedSheets(ctx, new SheetsClient({ spreadsheetId: 's', api }), async () => 'x', { keepAccentsOnUnlock: true }).catch((e) => e);
    // unlock also needs a batchUpdate (tab A is red), so with every write failing the unlock fails first
    assert.ok(run instanceof SheetLockError);
    assert.equal(String(ctx.status.get('sheets.unlockTabs')?.disclosure), labelledReason('Sheet lock', 'SHEET_UNLOCK_FAILED'));
    assert.equal(ctx.status.get('sheets.lockTabs')?.state, 'failed', 'the lock was still attempted and its failure recorded');
  });
});

describe('FL-9e one canonical command name set', () => {
  test('package.json, the menu map and the workflows agree on lock-sheets / unlock-sheets', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(BACKEND, 'package.json'), 'utf8'));
    assert.match(pkg.scripts['lock-sheets'], /src\/lockSheets\.ts$/);
    assert.match(pkg.scripts['unlock-sheets'], /src\/lockSheets\.ts --unlock$/);
    assert.equal(MENU_ENTRY_POINTS['lockAllSheets']!.entry, 'cli: lock-sheets');
    assert.equal(MENU_ENTRY_POINTS['unlockAllSheets']!.entry, 'cli: unlock-sheets');
    for (const f of ['nightly.yml', 'my-options.yml', 'ai-dispatch.yml']) {
      const t = fs.readFileSync(path.join(BACKEND, '..', '.github', 'workflows', f), 'utf8');
      assert.ok(t.includes('npm run lock-sheets'), f);
      assert.ok(!/lock-tabs|unlock-/.test(t), f + ': no old names and no unlock in YAML');
    }
    const shimReadme = fs.readFileSync(path.join(BACKEND, 'apps-script-shim', 'README.md'), 'utf8');
    assert.ok(!/lock-tabs/.test(shimReadme));
  });
  test('the lock colour stays the shim colour', () => {
    const gs = fs.readFileSync(path.join(BACKEND, 'apps-script-shim', 'masterLock.gs'), 'utf8');
    assert.ok(gs.includes('"' + LOCK_COLOR + '"'));
  });
});
