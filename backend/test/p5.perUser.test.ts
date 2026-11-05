/**
 * GENERIC_PLAN P5: a run for another user reads that user's `⚙️ Profile` tab (npm run profile-fetch) and never the
 * owner's built-in profile; the owner's runs are unchanged (no tab read, no check). Example data only.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { profileFetch, normalizeCell, PROFILE_RANGE, type Rows } from '../src/profileFetch.ts';
import { isOwnerRun, runProfileProblem, runUserOf, runUserProblem } from '../src/profile/runUser.ts';
import { validateProfile, type Profile } from '../src/profile/schema.ts';
import { EXAMPLE_PROFILE_INPUT } from '../src/profile/example.ts';
import { PROFILE_TAB } from '../src/profile/load.ts';

const BACKEND = path.resolve(import.meta.dirname, '..');
const U2_ROWS: Rows = [
  ['Key', 'Value'],
  ['version', '1'],
  ['user.id', 'u2'],
  ['user.timeZone', 'Europe/London'],
  ['lists.core', 'AAPL, MSFT, KO'],
  ['tax.rate', '20%'],
  ['labels.listName', 'your list'],
  ['features.paper', 'TRUE'],
];
const profileOf = (input: unknown): Profile => {
  const r = validateProfile(input);
  assert.ok(r.ok, JSON.stringify(r));
  return r.profile;
};

describe('P5 who the run is for (profile/runUser.ts)', () => {
  test('RUN_USER unset, empty or owner (any case) = the owner', () => {
    for (const v of [undefined, '', '  ', 'owner', 'OWNER']) assert.equal(isOwnerRun({ RUN_USER: v }), true, String(v));
    assert.equal(runUserOf({ RUN_USER: 'U2' }), 'u2');
    assert.equal(runUserProblem('u2'), null);
    for (const bad of ['2u', 'u-2', 'u 2', 'a'.repeat(21), '']) assert.ok(runUserProblem(bad), bad);
  });
  test('the owner run passes with the built-in profile (today); another user never gets the built-in one', () => {
    const example = profileOf(EXAMPLE_PROFILE_INPUT);
    assert.equal(runProfileProblem({}, example, 'built-in'), null);
    assert.equal(runProfileProblem({ RUN_USER: 'owner', PROFILE_SOURCE: '' }, example, 'built-in'), null);
    assert.match(String(runProfileProblem({ RUN_USER: 'u2', PROFILE_SOURCE: 'sheet' }, example, 'built-in')), /no profile of theirs/);
    assert.match(String(runProfileProblem({ RUN_USER: 'u2' }, example, 'built-in')), /no profile of theirs/, 'even without PROFILE_SOURCE');
    assert.match(String(runProfileProblem({ RUN_USER: 'u2', PROFILE_SOURCE: 'sheet' }, example, 'PROFILE_FILE')), /profile is for user example/);
    const u2 = profileOf({ ...EXAMPLE_PROFILE_INPUT, user: { id: 'u2', timeZone: 'Europe/London' } });
    assert.equal(runProfileProblem({ RUN_USER: 'u2', PROFILE_SOURCE: 'sheet' }, u2, 'PROFILE_FILE'), null);
  });
  test('the process refuses at the first profile read: u2 without its file; u2 with its file runs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-'));
    const file = path.join(dir, 'u2.json');
    fs.writeFileSync(file, JSON.stringify({ ...EXAMPLE_PROFILE_INPUT, user: { id: 'u2', timeZone: 'Europe/London' } }));
    const code = "import { activeProfile } from './src/profile/active.ts'; console.log(activeProfile().user.id);";
    const run = (env: Record<string, string>) => spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: BACKEND, env: { PATH: process.env.PATH ?? '', TZ: 'America/New_York', ...env }, encoding: 'utf8' });
    const owner = run({ RUN_USER: 'owner', PROFILE_SOURCE: '' });
    assert.notEqual(owner.status, 0, 'no built-in profile');
    assert.match(owner.stderr, /No profile: fill the/);
    const missing = run({ RUN_USER: 'u2', PROFILE_SOURCE: 'sheet' });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /No profile: fill the/);
    const ok = run({ RUN_USER: 'u2', PROFILE_SOURCE: 'sheet', PROFILE_FILE: file });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), 'u2');
  });
});

describe('P5 npm run profile-fetch (the Profile tab -> PROFILE_FILE)', () => {
  const env = { RUN_USER: 'u2', PROFILE_SOURCE: 'sheet', GOOGLE_SERVICE_ACCOUNT_JSON: '{}', SPREADSHEET_ID: 'sheet-u2' };
  const go = async (o: { env?: Record<string, string>; rows?: Rows | null; argv?: string[]; fail?: boolean }) => {
    const lines: string[] = [], files: Record<string, string> = {}, tg: any[] = [];
    let read = 0;
    const code = await profileFetch({
      env: o.env ?? env, argv: o.argv ?? ['--out', '/x/profile.json'], out: (l) => lines.push(l),
      readRows: async () => { read++; if (o.fail) throw new Error('the sheet could not be read (403)'); return o.rows === undefined ? U2_ROWS : o.rows; },
      writeFile: (f, t) => { files[f] = t; },
      fetchImpl: (async (_u: string, init: any) => { tg.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ok: true, result: {} })); }) as unknown as typeof fetch,
    });
    return { code, lines, files, tg, read };
  };

  test('a good tab is written; the file loads as the same profile', async () => {
    const r = await go({});
    assert.equal(r.code, 0, r.lines.join('\n'));
    const written = JSON.parse(r.files['/x/profile.json'] as string);
    const p = profileOf(written);
    assert.equal(p.user.id, 'u2');
    assert.deepEqual(p.lists.core, ['AAPL', 'MSFT', 'KO']);
    assert.equal(p.tax.rate, 0.2);
    assert.equal(p.features.paper, true);
    assert.match(r.lines.join('\n'), /user u2, 3 ticker\(s\)/);
    assert.equal(PROFILE_RANGE, "'" + PROFILE_TAB + "'!A1:B300");
  });
  test('missing tab, a bad value, another user id or a read failure refuse the run with one line (and Telegram when given)', async () => {
    const tgEnv = { ...env, TELEGRAM_BOT_TOKEN: '1:a', TELEGRAM_CHAT_ID: '42' };
    const missing = await go({ env: tgEnv, rows: null });
    assert.equal(missing.code, 1);
    assert.match(missing.lines[0] as string, /Run refused for user u2: the ⚙️ Profile tab is missing or empty/);
    assert.equal(missing.tg.length, 1);
    assert.equal(missing.tg[0].chat_id, '42');
    assert.deepEqual(missing.files, {});
    const bad = await go({ rows: U2_ROWS.map((r) => (r[0] === 'tax.rate' ? ['tax.rate', '90%'] : r)) });
    assert.equal(bad.code, 1);
    assert.match(bad.lines[0] as string, /tax\.rate must be a number/);
    const other = await go({ rows: U2_ROWS.map((r) => (r[0] === 'user.id' ? ['user.id', 'u3'] : r)) });
    assert.equal(other.code, 1);
    assert.match(other.lines[0] as string, /is for user u3, not u2/);
    const fail = await go({ fail: true });
    assert.equal(fail.code, 1);
    assert.match(fail.lines[0] as string, /could not be read \(403\)/);
    assert.equal(fail.tg.length, 0, 'no Telegram without the bot secrets');
  });
  test('configuration problems: exit 2 and nothing read; secret values never printed', async () => {
    const noOut = await go({ argv: [] });
    assert.equal(noOut.code, 2);
    assert.equal(noOut.read, 0);
    const noSheet = await go({ env: { RUN_USER: 'u2', GOOGLE_SERVICE_ACCOUNT_JSON: '{"private_key":"x"}' } });
    assert.equal(noSheet.code, 2);
    assert.match(noSheet.lines[0] as string, /missing for user u2: SPREADSHEET_ID \(the secrets named U2_<NAME>\)/);
    assert.ok(!noSheet.lines.join('').includes('private_key'));
    const badId = await go({ env: { ...env, RUN_USER: 'u-2' } });
    assert.equal(badId.code, 2);
    assert.equal(badId.read, 0);
  });
  test('cells as shown in the sheet: TRUE / FALSE and percents', () => {
    assert.equal(normalizeCell('TRUE'), true);
    assert.equal(normalizeCell('false'), false);
    assert.equal(normalizeCell('25%'), 0.25);
    assert.equal(normalizeCell('AAPL, KO'), 'AAPL, KO');
    assert.equal(normalizeCell(3), 3);
  });
  test('the command runs before any profile exists (no tab registry import): u2 without its file reaches the config check', () => {
    const r = spawnSync(process.execPath, ['src/profileFetch.ts', '--out', path.join(os.tmpdir(), 'p5-never.json')], { cwd: BACKEND, env: { PATH: process.env.PATH ?? '', RUN_USER: 'u2', PROFILE_SOURCE: 'sheet' }, encoding: 'utf8' });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stdout, /missing for user u2/);
  });
});
