/**
 * GENERIC_PLAN P1: the profile schema (src/profile/schema.ts) and loader (src/profile/load.ts). Uses the example
 * profile only (no owner data here; the owner profile's equality test is test/owner.profile.test.ts).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateProfile, PROFILE_KEYS, defaultTickerOf } from '../src/profile/schema.ts';
import { loadProfile, profileInputFromRows, PROFILE_TAB } from '../src/profile/load.ts';
import { EXAMPLE_PROFILE_INPUT } from '../src/profile/example.ts';

const ex = (): Record<string, unknown> => JSON.parse(JSON.stringify(EXAMPLE_PROFILE_INPUT));
const errorsOf = (input: unknown): readonly string[] => { const r = validateProfile(input); return r.ok ? [] : r.errors; };

describe('P1 — profile schema', () => {
  test('the example profile validates, with the new-user defaults', () => {
    const r = validateProfile(EXAMPLE_PROFILE_INPUT);
    assert.ok(r.ok, r.ok ? '' : r.errors.join('; '));
    const p = r.profile;
    assert.deepEqual(p.lists.researchCore, p.lists.core);
    assert.deepEqual(p.lists.pickers.stockMenu, p.lists.core);
    assert.deepEqual(p.lists.watchlistSeed, []);
    assert.deepEqual(p.paper, { start: null, end: null, fixedUniverse: p.lists.core });
    assert.deepEqual(p.models.pairs, []);
    assert.equal(p.benchmarks.index, 'QQQ');
    assert.equal(p.labels.holdCore, 'Hold your list equally');
    assert.deepEqual(p.sheets.protectedTabs, []);
    assert.deepEqual(p.sheets.portfolio.endMarkers, { exact: [], contains: ['CLOSED'] });
    assert.deepEqual(p.features, { paper: true, liveBot: false, myOptions: true, ai: false });
    assert.equal(p.live, null);
    assert.equal(p.results, null);
    assert.equal(defaultTickerOf(p), 'AAPL');
  });

  test('tax.rate is required: no default', () => {
    const i = ex(); delete (i.tax as Record<string, unknown>).rate;
    assert.ok(errorsOf(i).some((e) => e.startsWith('tax.rate is required')));
    const j = ex(); delete j.tax;
    assert.ok(errorsOf(j).some((e) => e.startsWith('tax.rate is required')));
    for (const bad of [-0.1, 0.61, '0.25', NaN]) { const k = ex(); (k.tax as Record<string, unknown>).rate = bad; assert.ok(errorsOf(k).some((e) => e.startsWith('tax.rate')), String(bad)); }
  });

  test('the list: 1-30 tickers, no repeats, real ticker shapes', () => {
    const set = (core: unknown): readonly string[] => { const i = ex(); (i.lists as Record<string, unknown>).core = core; return errorsOf(i); };
    assert.ok(set([]).some((e) => e.includes('at least 1')));
    assert.ok(set(Array.from({ length: 31 }, (_, n) => 'T' + n)).some((e) => e.includes('at most 30')));
    assert.ok(set(['AAPL', 'AAPL']).some((e) => e.includes('twice')));
    assert.ok(set(['aapl']).some((e) => e.includes('not tickers')));
    assert.ok(set('AAPL').some((e) => e.includes('list of tickers')));
    const i = ex(); delete (i.lists as Record<string, unknown>).core;
    assert.ok(errorsOf(i).includes('lists.core is required'));
    assert.deepEqual(set(['BRK.B', 'BTC-USD', '^VIX']), []);
  });

  test('time zone and user id', () => {
    const z = ex(); (z.user as Record<string, unknown>).timeZone = 'Mars/Olympus';
    assert.ok(errorsOf(z).includes('user.timeZone is not a known time zone'));
    const n = ex(); delete (n.user as Record<string, unknown>).timeZone;
    assert.ok(errorsOf(n).includes('user.timeZone is required'));
    const u = ex(); (u.user as Record<string, unknown>).id = 'Bad Id';
    assert.ok(errorsOf(u).includes('user.id is not valid'));
  });

  test('unknown keys are refused (typos never pass silently)', () => {
    const i = ex(); (i.tax as Record<string, unknown>).rat = 0.2;
    assert.ok(errorsOf(i).includes('unknown key tax.rat'));
    const j = ex(); j.live = { startValue: 100, allowShorts: true };
    assert.ok(errorsOf(j).includes('unknown key live.allowShorts'));
  });

  test('paper dates, pairs, the live bot needs its settings', () => {
    const d = ex(); d.paper = { start: '2027-01-02', end: '2027-01-01' };
    assert.ok(errorsOf(d).includes('paper.end must be after paper.start'));
    const p = ex(); p.models = { pairs: [['AAPL', 'AAPL']] };
    assert.ok(errorsOf(p).some((e) => e.startsWith('models.pairs')));
    const l = ex(); l.features = { liveBot: true };
    assert.ok(errorsOf(l).includes('features.liveBot needs the live settings'));
    const ok = ex(); ok.features = { liveBot: true }; ok.live = { startValue: 500 };
    const r = validateProfile(ok);
    assert.ok(r.ok);
    assert.deepEqual(r.profile.live?.allowList, ['AAPL', 'MSFT', 'KO', 'JNJ', 'QQQ']);
  });

  test('R8 at the schema: no key can allow puts, shorts, writing calls or margin', () => {
    for (const k of PROFILE_KEYS) assert.doesNotMatch(k, /short|put|margin|writ|naked|leverage|borrow/i, k);
  });
});

describe('P1 — profile loader', () => {
  test('PROFILE_JSON first, then PROFILE_FILE, then the sheet tab, then the built-in fallback', () => {
    const json = JSON.stringify(EXAMPLE_PROFILE_INPUT);
    const fallback = { ...ex(), user: { id: 'fallback', timeZone: 'UTC' } };
    assert.equal(loadProfile({ PROFILE_JSON: json, PROFILE_FILE: '/x' }, { fallback }).source, 'PROFILE_JSON');
    const f = loadProfile({ PROFILE_FILE: '/p.json' }, { fallback, readFile: () => json });
    assert.equal(f.source, 'PROFILE_FILE'); assert.ok(f.ok);
    const rows = [['Key', 'Value'], ['user.id', 'sheetuser'], ['user.timeZone', 'UTC'], ['lists.core', 'AAPL, KO'], ['tax.rate', 0.3], ['features.ai', 'true'], ['models.pairs', '[["AAPL","KO"]]']];
    const s = loadProfile({}, { sheetRows: rows, fallback });
    assert.equal(s.source, 'sheet');
    assert.ok(s.ok, s.ok ? '' : s.errors.join('; '));
    assert.deepEqual(s.profile.lists.core, ['AAPL', 'KO']);
    assert.equal(s.profile.tax.rate, 0.3);
    assert.equal(s.profile.features.ai, true);
    assert.deepEqual(s.profile.models.pairs, [['AAPL', 'KO']]);
    const b = loadProfile({}, { fallback });
    assert.equal(b.source, 'built-in'); assert.ok(b.ok); assert.equal(b.profile.user.id, 'fallback');
  });

  test('no profile, bad JSON, unreadable file: refused with a plain reason', () => {
    const none = loadProfile({});
    assert.equal(none.ok, false); assert.equal(none.source, 'none');
    assert.ok(!none.ok && none.errors[0].includes(PROFILE_TAB));
    const bad = loadProfile({ PROFILE_JSON: '{' });
    assert.ok(!bad.ok && bad.errors[0] === 'PROFILE_JSON is not valid JSON');
    const nf = loadProfile({ PROFILE_FILE: '/nope' }, { readFile: () => { throw new Error('ENOENT'); } });
    assert.ok(!nf.ok && nf.errors[0] === 'PROFILE_FILE could not be read');
  });

  test('sheet rows: dotted keys nest, blanks and the header are skipped', () => {
    assert.deepEqual(profileInputFromRows([['Key', 'Value'], [], ['', 'x'], ['a.b.c', '1'], ['lists.core', 'X,Y']]), { a: { b: { c: 1 } }, lists: { core: ['X', 'Y'] } });
  });
});
