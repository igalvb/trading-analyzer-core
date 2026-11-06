/**
 * Core-first workflow (CORE_README.md "Core and overlay"): core-manifest.json, npm run export-core (a plain copy, no
 * patch), npm run import-core (a plain copy back; the overlay never touched). Runs the same in the core repo and in a
 * copy with an overlay.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT, coreMatcher, globToRegExp, manifestProblems, readManifest, treeFiles, isCorePath } from '../scripts/coreManifest.ts';
import { exportCore, loadMarkers, scanTree } from '../scripts/exportCore.ts';
import { applyImport, planImport } from '../scripts/importCore.ts';
import { OVERLAY_PROFILE_FILE } from '../src/overlay.ts';
import { PROFILE_STEP_IF } from '../src/workflows/schedule.ts';

const tmp = (tag: string): string => fs.mkdtempSync(path.join(os.tmpdir(), 'core-sync-' + tag + '-'));
const write = (root: string, rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const read = (root: string, rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

describe('core-manifest.json', () => {
  test('globs: ** any folders, * one name, {a,b} either', () => {
    assert.ok(globToRegExp('backend/**').test('backend/src/a/b.ts'));
    assert.ok(globToRegExp('backend/src/owner/**').test('backend/src/owner/profile.ts'));
    assert.ok(!globToRegExp('.github/workflows/*.yml').test('.github/workflows/x/y.yml'));
    assert.ok(globToRegExp('docs/{A,B}.md').test('docs/B.md'));
    assert.ok(!globToRegExp('docs/{A,B}.md').test('docs/C.md'));
    assert.ok(globToRegExp('backend/**/x.ts').test('backend/x.ts'));
  });
  test('valid; the last matching rule decides; unmatched = overlay', () => {
    const m = readManifest();
    assert.deepEqual(manifestProblems(m), []);
    const isCore = coreMatcher({ note: '', rules: ['+ a/**', '- a/private/**', '+ a/private/shared.txt'] });
    assert.equal(isCore('a/x.ts'), true);
    assert.equal(isCore('a/private/y.ts'), false);
    assert.equal(isCore('a/private/shared.txt'), true);
    assert.equal(isCore('b/z.ts'), false);
  });
  test('the core holds its own sync files; the overlay places are overlay (made-up names)', () => {
    for (const f of ['core-manifest.json', 'VERSION', 'CHANGELOG.md', 'CORE_README.md', '.gitignore', 'backend/package.json', 'backend/src/overlay.ts', 'backend/scripts/exportCore.ts', 'backend/scripts/importCore.ts', 'backend/scripts/coreManifest.ts', 'backend/test/testProfileEnv.ts', 'relay/telegram-relay.worker.mjs', 'backend/legacy/historical_data/SPY.json']) assert.equal(isCorePath(f), true, f);
    for (const f of ['README.md', 'backend/README.md', 'backend/src/owner/x.ts', 'backend/test/overlay/x.test.ts', 'backend/test/recordings/x.json.gz', 'relay/owner/x.mjs', 'docs/NOTES.md', 'backend/legacy/historical_data/ZZZZ.json']) assert.equal(isCorePath(f), false, f);
  });
  test('VERSION is MAJOR.MINOR.PATCH and CHANGELOG.md has its entry', () => {
    const v = read(REPO_ROOT, 'VERSION').trim();
    assert.match(v, /^\d+\.\d+\.\d+$/);
    assert.match(read(REPO_ROOT, 'CHANGELOG.md'), new RegExp('^## v' + v.replace(/\./g, '\\.') + ' \\(\\d{4}-\\d{2}-\\d{2}\\)$', 'm'));
  });
  test('the workflows test the overlay profile file src/overlay.ts loads', () => {
    assert.equal(path.relative(REPO_ROOT, OVERLAY_PROFILE_FILE).split(path.sep).join('/'), 'backend/src/owner/profile.ts');
    assert.ok(PROFILE_STEP_IF.includes("hashFiles('backend/src/owner/profile.ts')"));
  });
});

describe('export-core: a plain copy of the core files', () => {
  const out = tmp('export');
  const r = exportCore(REPO_ROOT, out);
  test('patches nothing: every core file is byte-identical to this repo\'s', () => {
    assert.deepEqual(r.patched, []);
    assert.ok(r.copied > 500, 'the core is all there: ' + r.copied);
    for (const f of r.plan.core) assert.ok(fs.readFileSync(path.join(out, f)).equals(fs.readFileSync(path.join(REPO_ROOT, f))), f);
  });
  test('holds exactly the core files (no overlay file)', () => {
    assert.deepEqual(treeFiles(out), [...r.plan.core].sort());
    assert.ok(r.plan.core.every(isCorePath) && r.plan.overlay.every((f) => !isCorePath(f)));
  });
  test('the scan finds nothing (keys, private data; the overlay\'s owner markers when present)', async () => {
    const { markers } = await loadMarkers();
    const s = scanTree(out, markers);
    assert.deepEqual(Object.entries(s.counts).filter(([, n]) => n > 0), []);
  });
  test('round trip: importing the export back changes nothing', () => {
    const p = planImport(out, REPO_ROOT);
    assert.deepEqual({ added: p.added, changed: p.changed, deleted: p.deleted, refused: p.refused }, { added: [], changed: [], deleted: [], refused: [] });
    assert.equal(p.unchanged, r.copied);
    assert.equal(p.toVersion, p.fromVersion);
  });
});

describe('import-core: a plain copy back; the overlay is never touched', () => {
  const MANIFEST = JSON.stringify({ note: 'test', rules: ['+ VERSION', '+ core-manifest.json', '+ app/**', '- app/private/**'] });
  const repo = (): string => {
    const d = tmp('repo');
    write(d, 'VERSION', '1.0.0\n'); write(d, 'core-manifest.json', MANIFEST);
    write(d, 'app/a.ts', 'a1'); write(d, 'app/b.ts', 'b1'); write(d, 'app/gone.ts', 'old');
    write(d, 'app/private/mine.ts', 'mine'); write(d, 'notes.md', 'overlay notes');
    return d;
  };
  const release = (): string => {
    const d = tmp('core');
    write(d, 'VERSION', '1.1.0\n'); write(d, 'core-manifest.json', MANIFEST);
    write(d, 'app/a.ts', 'a1'); write(d, 'app/b.ts', 'b2'); write(d, 'app/new.ts', 'n');
    return d;
  };
  test('adds, changes and deletes core files; overlay files stay byte for byte; the version moves', () => {
    const to = repo(), from = release();
    const p = planImport(from, to);
    assert.equal(p.fromVersion, '1.0.0');
    assert.equal(p.toVersion, '1.1.0');
    assert.deepEqual([p.added, p.changed, p.deleted, p.refused], [['app/new.ts'], ['VERSION', 'app/b.ts'], ['app/gone.ts'], []]);
    applyImport(p, from, to);
    assert.equal(read(to, 'app/b.ts'), 'b2');
    assert.equal(read(to, 'app/new.ts'), 'n');
    assert.ok(!fs.existsSync(path.join(to, 'app/gone.ts')));
    assert.equal(read(to, 'app/private/mine.ts'), 'mine');
    assert.equal(read(to, 'notes.md'), 'overlay notes');
    const again = planImport(from, to);
    assert.deepEqual([again.added, again.changed, again.deleted], [[], [], []], 'a second import changes nothing');
  });
  test('refuses, writing nothing, when the release would overwrite an overlay file or carries a non-core file', () => {
    const to = repo(), from = release();
    write(from, 'app/private/mine.ts', 'from the core');
    write(from, 'stray.txt', 'not core');
    const p = planImport(from, to);
    assert.deepEqual(p.refused.map((x) => x.split(' ')[0]), ['app/private/mine.ts', 'stray.txt']);
    assert.throws(() => applyImport(p, from, to), /import refused, nothing written/);
    assert.equal(read(to, 'app/private/mine.ts'), 'mine');
    assert.equal(read(to, 'app/b.ts'), 'b1');
  });
  test('a folder without VERSION is not a core checkout', () => {
    const to = repo(), from = tmp('nover');
    write(from, 'core-manifest.json', MANIFEST);
    assert.throws(() => planImport(from, to), /no VERSION file/);
  });
});
