/**
 * The split between the shared core and a private overlay: `core-manifest.json` at the repo root (a core file itself).
 *
 * `rules` is a list of `+ <glob>` (core) and `- <glob>` (overlay) lines, gitignore style: the LAST rule that matches a
 * path decides; a path no rule matches is overlay. Globs are repo-relative with `/`: `**` = any number of folders,
 * `*` = any text inside one name, `?` = one character, `{a,b}` = either.
 *
 * Every core file is the same, byte for byte, in the core repo and in every copy that keeps an overlay next to it, so
 * updates flow both ways by plain copying (scripts/exportCore.ts, scripts/importCore.ts). docs: CORE_README.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** The repo root (backend/ is a folder of it). */
export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
export const MANIFEST_NAME = 'core-manifest.json';

export interface Manifest { readonly note: string; readonly rules: readonly string[] }

/** A glob as a whole-path regular expression. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) throw new Error('core-manifest: unclosed { in ' + glob);
      re += '(?:' + glob.slice(i + 1, end).split(',').map((x) => x.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')';
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

/** Checks the shape; returns the problems (empty = good). */
export function manifestProblems(v: unknown): string[] {
  if (!v || typeof v !== 'object') return ['not an object'];
  const m = v as Record<string, unknown>;
  const out: string[] = [];
  if (typeof m.note !== 'string') out.push('note must be text');
  if (!Array.isArray(m.rules) || m.rules.length === 0) out.push('rules must be a non-empty list');
  else for (const r of m.rules) if (typeof r !== 'string' || !/^[+-] \S/.test(r)) out.push('bad rule: ' + String(r).slice(0, 80));
  return out;
}

export function readManifest(root: string = REPO_ROOT): Manifest {
  const file = path.join(root, MANIFEST_NAME);
  if (!fs.existsSync(file)) throw new Error('no ' + MANIFEST_NAME + ' in ' + root);
  const v = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  const bad = manifestProblems(v);
  if (bad.length) throw new Error(MANIFEST_NAME + ' in ' + root + ' is not valid: ' + bad.join('; '));
  return v as Manifest;
}

/** A path test: true = core, false = overlay. */
export function coreMatcher(m: Manifest): (rel: string) => boolean {
  const rules = m.rules.map((r) => ({ core: r[0] === '+', re: globToRegExp(r.slice(2).trim()) }));
  return (rel: string): boolean => {
    let core = false;
    for (const r of rules) if (r.re.test(rel)) core = r.core;
    return core;
  };
}

let cached: ((rel: string) => boolean) | null = null;
/** True when `rel` (repo-relative, `/`) is a core path in THIS repo's manifest. */
export function isCorePath(rel: string): boolean {
  cached ??= coreMatcher(readManifest());
  return cached(rel);
}

/** Files of a tree, repo-relative and sorted: git's tracked files when `dir` is a git checkout, else every file
 *  (without .git/ and node_modules/). */
export function treeFiles(dir: string): string[] {
  if (fs.existsSync(path.join(dir, '.git'))) {
    return execFileSync('git', ['ls-files', '-z'], { cwd: dir, maxBuffer: 64 << 20 }).toString('utf8').split('\0').filter(Boolean)
      .filter((f) => fs.existsSync(path.join(dir, f)) && fs.lstatSync(path.join(dir, f)).isFile()).sort();
  }
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(r); else if (e.isFile()) out.push(r);
    }
  };
  walk('');
  return out.sort();
}

/** The core files of a tree under its own manifest. */
export function coreFilesOf(dir: string, m: Manifest = readManifest(dir)): string[] {
  const isCore = coreMatcher(m);
  return treeFiles(dir).filter(isCore);
}
