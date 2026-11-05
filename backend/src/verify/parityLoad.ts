/**
 * FL-9b: file-system side of the verification tools. Reads text and returns it; no parsing here.
 * Everything pure lives in parityGate.ts / parallelRun.ts / triggerChecklist.ts.
 *
 * PRIVACY: the real-sheet export is private. The parallel-run loader takes a LOCAL directory as an argument and
 * refuses any path inside the repository (assertPrivatePath), so an export can never end up beside committed code.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceText } from './parityGate.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
/** backend/ */
export const BACKEND_DIR = path.resolve(here, '..', '..');
/** The git root (backend/ is a subfolder of it). */
export const REPO_DIR = path.resolve(BACKEND_DIR, '..');
export const LEGACY_DIR = path.join(BACKEND_DIR, 'legacy');

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && p.endsWith('.ts')) out.push(p);
  }
}

function readAll(files: readonly string[], base: string): SourceText[] {
  return [...files].sort().map((f) => ({ path: path.relative(base, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') }));
}

export function loadLegacySources(dir: string = LEGACY_DIR): SourceText[] {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.gs')).map((f) => path.join(dir, f));
  return readAll(files, dir);
}

/** src/**.ts without src/verify/ (the gate must not find itself or its waiver list). */
export function loadPortSources(): SourceText[] {
  const files: string[] = [];
  walk(path.join(BACKEND_DIR, 'src'), files);
  return readAll(files.filter((f) => !f.includes(path.sep + 'verify' + path.sep)), BACKEND_DIR);
}

/** test/**.ts without the FL-9b test files (they name legacy functions as data, which is not coverage). */
export function loadTestSources(): SourceText[] {
  const files: string[] = [];
  walk(path.join(BACKEND_DIR, 'test'), files);
  return readAll(files.filter((f) => !path.basename(f).startsWith('fl9b.')), BACKEND_DIR);
}

/**
 * The npm scripts that can really run: a script whose command names a file under src/ (or scripts/) counts only when
 * that file exists. A script pointing at a missing file is listed in `missing` instead.
 */
export function loadPackageScripts(backendDir: string = BACKEND_DIR): { readonly available: string[]; readonly missing: string[] } {
  const pkg = JSON.parse(fs.readFileSync(path.join(backendDir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  const available: string[] = [];
  const missing: string[] = [];
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    const target = /\b((?:src|scripts)\/[\w./-]+\.ts)\b/.exec(cmd)?.[1];
    if (target && !fs.existsSync(path.join(backendDir, target))) missing.push(name + ' (' + target + ')');
    else available.push(name);
  }
  return { available, missing };
}

/** Throws when `p` is inside the repository. Real-sheet exports must live outside it. */
export function assertPrivatePath(p: string, repoDir: string = REPO_DIR): string {
  const abs = path.resolve(p);
  const rel = path.relative(repoDir, abs);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error('Refusing to read a sheet export from inside the repository. Keep it in a private local folder outside the repo.');
  }
  return abs;
}

/** File names (not paths) in the repository's .github/workflows folder; empty when the folder is missing. */
export function loadWorkflowFiles(repoDir: string = REPO_DIR): string[] {
  const dir = path.join(repoDir, '.github', 'workflows');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.yml')).sort() : [];
}

// ---- parallel-run snapshots (private, local) -----------------------------------------------------
// One JSON file per night in each directory: <dir>/<YYYY-MM-DD>.json, shaped { "tabs": { "<tab>": [[...]] }, "decisions"?: { "<TICKER>": {...} } }.

export function listSnapshotDates(dir: string): string[] {
  return fs.readdirSync(dir).map((f) => /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f)?.[1]).filter((d): d is string => !!d).sort();
}

export function readSnapshot(dir: string, date: string): { readonly date: string; readonly tabs: Record<string, unknown[][]>; readonly decisions?: Record<string, Record<string, unknown>> } | null {
  const f = path.join(dir, date + '.json');
  if (!fs.existsSync(f)) return null;
  const j = JSON.parse(fs.readFileSync(f, 'utf8')) as { tabs?: Record<string, unknown[][]>; decisions?: Record<string, Record<string, unknown>> };
  if (!j.tabs || typeof j.tabs !== 'object') throw new Error('Snapshot ' + date + ' has no "tabs" object.');
  return { date, tabs: j.tabs, ...(j.decisions ? { decisions: j.decisions } : {}) };
}

/**
 * The sub-commands listed in the USAGE text of src/cli.ts (lines such as "  analyze TICKER ..."). Empty when the file
 * or the USAGE export is missing. Add commands there and they count as available here.
 */
export function loadCliSubcommands(backendDir: string = BACKEND_DIR): string[] {
  const f = path.join(backendDir, 'src', 'cli.ts');
  if (!fs.existsSync(f)) return [];
  const text = fs.readFileSync(f, 'utf8');
  const start = text.indexOf('export const USAGE');
  if (start < 0) return [];
  const end = text.indexOf('].join', start);
  const block = text.slice(start, end < 0 ? start + 2000 : end);
  const out: string[] = [];
  for (const m of block.matchAll(/'\s{2}([a-z][a-z0-9-]*)(?:\s|')/g)) if (!out.includes(m[1] as string)) out.push(m[1] as string);
  return out;
}
