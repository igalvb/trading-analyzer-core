/**
 * FL-8l: the Apps Script Master Lock shim (apps-script-shim/masterLock.gs)
 * is checked against the frozen legacy file. Both are run in vm sandboxes
 * with identical recording fake spreadsheets; the call logs and final tab
 * colours must be equal. The shim's three lock functions must also be a
 * character-for-character copy of the legacy text.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { loadOracle, legacyFilesPresent, LEGACY_DIR } from './oracle.ts';
import { withOracleGlobals } from './oracleGlobals.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHIM_PATH = path.join(here, '..', 'apps-script-shim', 'masterLock.gs');
const LEGACY_PATH = path.join(LEGACY_DIR, 'futuresStockAnalysisV3_3_11.gs');
const MASTER_MENU = '🔒 Master Lock';
const HAVE = legacyFilesPresent() && fs.existsSync(SHIM_PATH);
const opts = { skip: HAVE ? false : 'legacy/ or apps-script-shim/masterLock.gs missing' };

type Color = string | null;

function makeEnv(colors: Color[]) {
  const log: string[] = [];
  const sheets = colors.map((c, i) => {
    const s: any = {
      color: c,
      name: 'Tab' + i,
      getName: () => 'Tab' + i,
      getTabColor: () => s.color,
      setTabColor: (x: Color) => {
        log.push(`Tab${i}.setTabColor(${JSON.stringify(x)})`);
        s.color = x;
        return s;
      },
    };
    return s;
  });
  const ss = { getSheets: () => sheets.slice(), toast: (...a: unknown[]) => log.push('toast:' + JSON.stringify(a)) };
  const ui = {
    createMenu: (name: string) => {
      log.push(`menu:${name}:create`);
      const b: any = {
        addItem: (l: string, f: string) => { log.push(`menu:${name}:addItem:${JSON.stringify([l, f])}`); return b; },
        addSeparator: () => { log.push(`menu:${name}:addSeparator`); return b; },
        addToUi: () => { log.push(`menu:${name}:addToUi`); },
      };
      return b;
    },
  };
  const app = { getActiveSpreadsheet: () => ss, getUi: () => ui, flush: () => {} };
  return { log, sheets, app };
}

function shimSandbox(app: unknown): Record<string, any> {
  const sb: Record<string, any> = { SpreadsheetApp: app, console };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(SHIM_PATH, 'utf8'), sb, { filename: 'apps-script-shim/masterLock.gs' });
  return sb;
}

function runShim(name: string, env: ReturnType<typeof makeEnv>, ...args: unknown[]): void {
  const sb = shimSandbox(env.app);
  sb[name](...args);
}

function runLegacy(name: string, env: ReturnType<typeof makeEnv>, ...args: unknown[]): void {
  const oracle = loadOracle();
  withOracleGlobals({ SpreadsheetApp: env.app }, () => oracle.call(name, ...args));
}

const START: Color[][] = [
  [null, null, null],
  ['#4a148c', '#01579b', null],
  ['#d50000', '#d50000', '#6a1b9a'],
  [],
];

function same(name: string, run: (env: ReturnType<typeof makeEnv>) => void, runL: (env: ReturnType<typeof makeEnv>) => void, start: Color[]): void {
  const a = makeEnv(start);
  const b = makeEnv(start);
  runL(a);
  run(b);
  assert.deepEqual(b.log, a.log, name + ': call log');
  assert.deepEqual(b.sheets.map((s: any) => s.color), a.sheets.map((s: any) => s.color), name + ': final colours');
}

describe('FL-8l Master Lock shim vs legacy', opts, () => {
  test('shim declares only onOpen + the three lock functions', () => {
    const src = fs.readFileSync(SHIM_PATH, 'utf8');
    const names = [...src.matchAll(/^function\s+(\w+)/gm)].map((m) => m[1]).sort();
    assert.deepEqual(names, ['lockAllSheets', 'onOpen', 'sheetGuardian', 'unlockAllSheets']);
  });

  test('lockAllSheets/unlockAllSheets/sheetGuardian text is VERBATIM from legacy', () => {
    const legacy = fs.readFileSync(LEGACY_PATH, 'utf8');
    const shim = fs.readFileSync(SHIM_PATH, 'utf8');
    const from = legacy.indexOf('function lockAllSheets()');
    const g = legacy.indexOf('function sheetGuardian(');
    assert.ok(from > 0 && g > from, 'legacy markers found');
    const end = legacy.indexOf('\n}\n', g) + 3;
    const block = legacy.slice(from, end);
    assert.ok(block.includes('"#d50000"'));
    assert.ok(shim.includes(block), 'shim contains the legacy block unchanged');
  });

  for (const start of START) {
    const label = JSON.stringify(start);
    test('lockAllSheets parity ' + label, () => {
      same('lock', (e) => runShim('lockAllSheets', e), (e) => runLegacy('lockAllSheets', e), start);
    });
    test('unlockAllSheets parity ' + label, () => {
      same('unlock', (e) => runShim('unlockAllSheets', e), (e) => runLegacy('unlockAllSheets', e), start);
    });
    test('onOpen parity (Master Lock menu + lock; other legacy menus filtered out) ' + label, () => {
      const keep = (l: string) => !l.startsWith('menu:') || l.startsWith('menu:' + MASTER_MENU + ':');
      const a = makeEnv(start);
      const b = makeEnv(start);
      runLegacy('onOpen', a);
      runShim('onOpen', b);
      const legacyLog = a.log.filter(keep);
      assert.ok(legacyLog.some((l) => l.includes('addItem')), 'legacy Master Lock menu was captured');
      assert.deepEqual(b.log, legacyLog);
      assert.deepEqual(b.sheets.map((s: any) => s.color), a.sheets.map((s: any) => s.color));
    });
  }

  // sheetGuardian: same edit event on identical sheets, both implementations.
  const CASES: { name: string; color: Color; hasOld: boolean; old?: unknown; noEvent?: 'undef' | 'norange' }[] = [
    { name: 'red, oldValue undefined -> clearContent', color: '#d50000', hasOld: false },
    { name: 'red, oldValue string -> setValue', color: '#d50000', hasOld: true, old: 'abc' },
    { name: 'red, oldValue 0 (falsy) -> setValue(0)', color: '#d50000', hasOld: true, old: 0 },
    { name: 'red, oldValue empty string -> setValue("")', color: '#d50000', hasOld: true, old: '' },
    { name: 'upper-case #D50000 is NOT red (=== is case-sensitive)', color: '#D50000', hasOld: true, old: 'x' },
    { name: 'other colour -> no-op', color: '#4a148c', hasOld: true, old: 'x' },
    { name: 'no colour -> no-op', color: null, hasOld: false },
    { name: 'e undefined -> no-op', color: '#d50000', hasOld: false, noEvent: 'undef' },
    { name: 'e without range -> no-op', color: '#d50000', hasOld: false, noEvent: 'norange' },
  ];

  for (const c of CASES) {
    test('sheetGuardian parity: ' + c.name, () => {
      const build = (env: ReturnType<typeof makeEnv>): unknown => {
        if (c.noEvent === 'undef') return undefined;
        if (c.noEvent === 'norange') return {};
        const sheet = env.sheets[0];
        const range = {
          getSheet: () => sheet,
          clearContent: () => { env.log.push('range.clearContent()'); },
          setValue: (v: unknown) => { env.log.push('range.setValue(' + JSON.stringify(v) + ')'); },
        };
        return c.hasOld ? { range, oldValue: c.old } : { range };
      };
      const a = makeEnv([c.color, null]);
      const b = makeEnv([c.color, null]);
      runLegacy('sheetGuardian', a, build(a));
      runShim('sheetGuardian', b, build(b));
      assert.deepEqual(b.log, a.log);
      // the expectation itself, so an empty==empty comparison cannot pass vacuously
      const red = c.color === '#d50000' && !c.noEvent;
      assert.equal(a.log.length > 0, red, 'legacy acted iff tab is exactly #d50000');
    });
  }
});
