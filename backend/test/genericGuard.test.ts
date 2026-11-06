/**
 * GENERIC_PLAN §6 (P1): the guard. Counts owner data, owner wording and secret shapes in the core, per rule and per
 * file. Ratchet mode (P1-P8): no count may go UP from test/genericGuard.baseline.json (a new file with a violation
 * fails too). P9: the baseline must be all zero.
 *
 * It never lists owner data in clear: owner lists and owner names are kept as SHA-256 hashes only, and a failure names
 * the rule and file:line, never the text found.
 *
 * After fixing violations, lower the baseline (it refuses to raise any count):
 *   GENERIC_GUARD_WRITE=1 node --test test/genericGuard.test.ts
 *
 * Scopes (only core paths, core-manifest.json: a private overlay is never scanned for owner data; "core src" =
 * backend/src minus src/owner/):
 *   R1 sheet IDs, R2 owner identity    core src, core tests, workflows, relay
 *   R3 owner lists (hashes)            core src, relay
 *   R4 ticker lists of 8+              core src, minus market reference data (dark pool groups, macro tickers)
 *   R5 owner wording, R6 Hebrew        core src (R6 minus the course terms in analysis/indicators/slices.ts)
 *   R7 secret shapes, R9 keys in repo  every file git would track (tracked + untracked not ignored); binaries skipped
 *   R8 long-only                       the profile schema's keys
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PROFILE_KEYS } from '../src/profile/schema.ts';
import { isCorePath } from '../scripts/coreManifest.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const BASELINE_PATH = path.join(import.meta.dirname, 'genericGuard.baseline.json');
const sha = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** SHA-256 of the owner lists (sorted, unique, comma-joined, OTHER left out): C1, C1's 14 (C4), C2, C5, C9 (3 dialogs, 2 distinct), C11, the research universe and extra tickers (P2). */
export const OWNER_LIST_HASHES: ReadonlySet<string> = new Set([
  'c83c01d5e17fe8c3cbe6552e8971e42bfcfd3f1ec0f6c78a7d6d39f37a95a341',
  '390ea8bbb0aa12c20e0badb0fced5642f15ee945e382a8fe952118d947514062',
  'f2e988cf46cd675cb8d9b700e053bd0f8a16fd119f70cd6b4d81b0618a3ce9ae',
  '44c79b6c6c469e62e61d0c82d0af746287ad9a78be07945749bbe02982ffa23a',
  '07ebee5a754fb7aa0a063e4bc2d2dbda48bab08fecd78aa0e774399a6b806d0b',
  '14651c2b9c7383d54bf9a62bea7dda906606bec2d48df4a9eb90ab9753007370',
  '952b0be0c0b69eb9ce548d86b480de5eab263f28e488f0340db73a3cde08e874',
  '023510b778f7731c37d96b355ac09862d1983ecd58dc7396772dcebf8bb72c8a',
  'd5b302eab745020004e22ce6d9b49550706b9acc692e2f817c86feed09324418',
]);
/** SHA-256 of the owner's name tokens (lower case): the GitHub login and the first name. */
export const OWNER_WORD_HASHES: ReadonlySet<string> = new Set([
  '36be5ced3419cd5c1c4684b30ff129a25589fb8acb3d5c4ef94e2b5af3082032',
  '816f69f0b475910b375e209d0166aa3bd2d6848eb7cc1f9c004ed7eb389239df',
]);

const TICKER_ARRAY = /\[\s*((?:(['"])[A-Z^][A-Z0-9.\-=^]{0,11}\2\s*,\s*)+(['"])[A-Z^][A-Z0-9.\-=^]{0,11}\3\s*,?\s*)\]/g;
const SHEET_ID = /(?<![A-Za-z0-9_-])1[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const WORDING = /your \d+|owner's \d+|Hold your \d+/i;
const HEBREW = /[֐-׿]/;
const SECRETS: readonly RegExp[] = [/AIza[0-9A-Za-z_-]{35}/, /(?<!\d)\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/, /sk-ant-[A-Za-z0-9_-]{10,}/, /github_pat_[A-Za-z0-9_]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
const BINARY = /\.(gz|zip|pdf|png|jpe?g|gif|webp|ico|xlsx?|docx?|pptx?|woff2?|ttf|mp4|mov)$/i;
/** Market reference data, not a user's list: dark-pool sector groups, macro tickers, the SPDR sector ETFs. */
const R4_ALLOW = [/^backend\/src\/analysis\/darkPool\.ts$/, /^backend\/src\/analysis\/macroRegime\.ts$/, /^backend\/src\/fetch\/macro\//, /^backend\/src\/fetch\/etf\/holdings\.ts$/, /^backend\/src\/analysis\/models\/brokerCourse\/risk\.ts$/];

/** Every file git would track (tracked + untracked not ignored), repo-relative; a walk when git is missing. */
function repoFiles(): string[] {
  let list: string[];
  try {
    list = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: REPO, maxBuffer: 64 << 20 }).toString('utf8').split('\0').filter(Boolean);
  } catch {
    list = [];
    const walk = (rel: string): void => {
      for (const e of fs.readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
        if (['.git', 'node_modules', '.claude'].includes(e.name)) continue;
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) walk(r); else if (e.isFile()) list.push(r);
      }
    };
    walk('');
  }
  return [...new Set(list)].filter((f) => !f.split('/').includes('node_modules') && !f.startsWith('.claude/')).filter((f) => {
    try { return fs.lstatSync(path.join(REPO, f)).isFile(); } catch { return false; }
  }).sort();
}

const isCoreSrc = (f: string): boolean => f.startsWith('backend/src/') && !f.startsWith('backend/src/owner/') && /\.(ts|mjs|js)$/.test(f) && isCorePath(f);
const isCoreTest = (f: string): boolean => f.startsWith('backend/test/') && /\.(ts|mjs|js)$/.test(f) && isCorePath(f);
const isWorkflow = (f: string): boolean => f.startsWith('.github/workflows/') && isCorePath(f);
const isRelay = (f: string): boolean => f.startsWith('relay/') && isCorePath(f);

export type Counts = Record<string, Record<string, number>>;
export interface Hit { readonly rule: string; readonly file: string; readonly line: number }

/** The hash R3 compares: sorted unique tickers, OTHER (the dialogs' free-text entry) left out. */
export const listHash = (tickers: readonly string[]): string => sha([...new Set(tickers.filter((t) => t !== 'OTHER'))].sort().join(','));

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const file of repoFiles()) {
    if (BINARY.test(file)) continue;
    const text = fs.readFileSync(path.join(REPO, file), 'utf8');
    const lines = text.split('\n');
    const hit = (rule: string, line: number): void => { hits.push({ rule, file, line }); };
    const core = isCoreSrc(file), idScope = core || isCoreTest(file) || isWorkflow(file) || isRelay(file);
    lines.forEach((l, i) => {
      if (idScope && SHEET_ID.test(l)) hit('R1', i + 1);
      if (idScope) {
        const words = l.match(/[A-Za-z]+/g) ?? [];
        const emails = (l.match(EMAIL) ?? []).filter((e) => !/@(example\.(org|com)|users\.noreply\.github\.com)$/i.test(e));
        if (emails.length || words.some((w) => OWNER_WORD_HASHES.has(sha(w.toLowerCase())))) hit('R2', i + 1);
      }
      if (core && WORDING.test(l)) hit('R5', i + 1);
      if (core && HEBREW.test(l) && file !== 'backend/src/analysis/indicators/slices.ts') hit('R6', i + 1);
      if (SECRETS.some((re) => re.test(l))) hit('R7', i + 1);
    });
    if (core || isRelay(file)) {
      for (const m of text.matchAll(TICKER_ARRAY)) {
        const tickers = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
        const line = text.slice(0, m.index).split('\n').length;
        if (OWNER_LIST_HASHES.has(listHash(tickers))) hit('R3', line);
        if (core && tickers.length >= 8 && !R4_ALLOW.some((re) => re.test(file))) hit('R4', line);
      }
    }
    if (path.basename(file) === '.env' || (file.endsWith('.json') && /"private_key"\s*:/.test(text))) hit('R9', 1);
  }
  for (const k of PROFILE_KEYS) if (/short|put|margin|writ|naked|leverage|borrow/i.test(k)) hits.push({ rule: 'R8', file: 'backend/src/profile/schema.ts', line: 0 });
  return hits;
}

export function countsOf(hits: readonly Hit[]): Counts {
  const c: Counts = {};
  for (const h of hits) { const r = (c[h.rule] ??= {}); r[h.file] = (r[h.file] ?? 0) + 1; }
  const sorted: Counts = {};
  for (const rule of Object.keys(c).sort()) sorted[rule] = Object.fromEntries(Object.entries(c[rule]).sort(([a], [b]) => (a < b ? -1 : 1)));
  return sorted;
}
const total = (c: Counts): number => Object.values(c).reduce((n, r) => n + Object.values(r).reduce((a, b) => a + b, 0), 0);

interface Baseline { readonly note: string; readonly total: number; readonly rules: Counts }

describe('GENERIC_PLAN guard (ratchet: counts only go down)', () => {
  const hits = scan();
  const now = countsOf(hits);
  const base: Baseline | null = fs.existsSync(BASELINE_PATH) ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as Baseline : null;

  test('no rule and no file has more violations than the baseline', () => {
    const over: string[] = [];
    for (const [rule, files] of Object.entries(now)) {
      for (const [file, n] of Object.entries(files)) {
        const was = base?.rules[rule]?.[file] ?? 0;
        if (n > was) over.push(rule + ' ' + file + ': ' + was + ' -> ' + n + ' at line(s) ' + hits.filter((h) => h.rule === rule && h.file === file).map((h) => h.line).join(', '));
      }
    }
    if (process.env.GENERIC_GUARD_WRITE === '1') {
      assert.ok(!base || over.length === 0, 'refusing to raise the baseline:\n' + over.join('\n'));
      const b: Baseline = { note: 'GENERIC_PLAN §6 guard baseline: violations per rule and file (counts only, no text). May only go down. P9: all zero.', total: total(now), rules: now };
      fs.writeFileSync(BASELINE_PATH, JSON.stringify(b, null, 2) + '\n');
      return;
    }
    assert.ok(base, 'test/genericGuard.baseline.json exists');
    assert.deepEqual(over, [], 'new owner data, owner wording or secret shapes in the core');
    assert.ok(total(now) <= base.total);
  });

  test('strict mode (P9 core: GENERIC_GUARD_STRICT=1, or a baseline of total 0): no violation at all', { skip: process.env.GENERIC_GUARD_STRICT !== '1' && base?.total !== 0 && 'ratchet mode (overlay)' }, () => {
    assert.deepEqual(hits.map((h) => h.rule + ' ' + h.file + ':' + h.line), [], 'strict: every count must be 0');
  });

  test('R7 secret shapes and R9 key files: zero outside backend/test/ (the tests\' made-up keys are counted, not allowed to grow)', () => {
    const outside = hits.filter((h) => (h.rule === 'R7' || h.rule === 'R9') && !h.file.startsWith('backend/test/')).map((h) => h.rule + ' ' + h.file + ':' + h.line);
    assert.deepEqual(outside, [], 'a secret-shaped text or a key file');
  });

  test('R8: the profile schema has no key that could allow puts, shorts, writing calls or margin', () => {
    assert.equal(now.R8, undefined);
  });

  test('the stored owner-list hashes are the owner profile\'s lists (while the overlay is in this repo)', async () => {
    // A path in a variable: the exported core (no src/owner/) still typechecks.
    const ownerModule = '../src/owner/profile.ts';
    let owner: { OWNER_PROFILE: import('../src/profile/schema.ts').Profile } | null = null;
    try { owner = await import(ownerModule); } catch { owner = null; }
    if (!owner) return; // P9: the overlay has moved out; the hashes stay
    const p = owner.OWNER_PROFILE;
    const lists = [p.lists.core, p.lists.researchCore, p.paper.fixedUniverse, p.research.testAUniverse, p.lists.pickers.stockMenu, p.lists.pickers.runDialog, p.lists.pickers.callDialog, p.lists.watchlistSeed, p.research.universe, p.research.extraTickers];
    assert.deepEqual(new Set(lists.map(listHash)), OWNER_LIST_HASHES);
  });

  test('the guard sees what it should (self-check on made-up text)', () => {
    assert.ok(SHEET_ID.test('x 1' + 'A'.repeat(43) + ' y'));
    assert.ok(WORDING.test('Hold your 9 equally'));
    assert.ok(HEBREW.test('א'));
    assert.ok(SECRETS[0].test('AIza' + 'b'.repeat(35)));
    assert.equal([...("['AAA', 'BBB',\n 'CCC']").matchAll(TICKER_ARRAY)].length, 1);
  });
});
