/**
 * V13 row 38: "real lint" as tests (CI stays manual-only, so the rules live in the test suite). Three ratchets over
 * backend/src, each against test/lintRatchet.baseline.json: no count may go UP, per file and in total, and a new file
 * with a hit fails too.
 *
 *   L1 raw try/catch outside src/core   catch clauses (`try {} catch`); `.catch(` on a promise and try/finally are not counted.
 *                                       src/core is the one place allowed to own catch-and-classify (runStep, fetchStep, ...).
 *   L2 import cycles in src/            runtime import edges only: `import type` / `export type` are erased; a lazy
 *                                       `await import()` is the allowed way to break a cycle and is not an edge. Every edge
 *                                       that sits inside a strongly connected component must already be in the baseline.
 *   L3 the `any` count in src/          the `any` keyword in code (comments and strings masked out).
 *
 * TypeScript 7 ships no JS parser API, so this uses a small lexer: comments, string and template text are masked to
 * spaces (offsets kept), then the rules are plain regexes over the masked code.
 *
 * After fixing hits, lower the baseline (it refuses to raise any count or add a cycle edge):
 *   LINT_RATCHET_WRITE=1 node --test test/lintRatchet.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(import.meta.dirname, '..', 'src');
const BASELINE_PATH = path.join(import.meta.dirname, 'lintRatchet.baseline.json');

/** Comments, string and template text -> spaces (newlines kept, so offsets and line numbers hold). Quotes stay. */
export function maskCode(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number): void => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  const n = text.length;
  /** Template nesting: each entry is the brace depth at which the current `${` opened. */
  const tpl: number[] = [];
  let depth = 0;
  let prev = ''; // last significant code char, for the regex-vs-division call
  let prevWord = '';
  const regexAllowed = (): boolean => prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || /^(return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new)$/.test(prevWord);
  const scanTemplate = (): void => { // at the char after ` or after the } closing a ${
    const start = i;
    while (i < n) {
      const c = text[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { blank(start, i); i++; prev = 'x'; prevWord = ''; return; }
      if (c === '$' && text[i + 1] === '{') { blank(start, i); tpl.push(depth); depth++; i += 2; prev = '{'; prevWord = ''; return; }
      i++;
    }
    blank(start, n);
  };
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); const end = e < 0 ? n : e; blank(i, end); i = end; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; blank(i, end); i = end; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      blank(i + 1, j); i = j + 1; prev = 'x'; prevWord = ''; continue;
    }
    if (c === '`') { i++; scanTemplate(); continue; }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let cls = false;
      while (j < n && text[j] !== '\n') {
        const d = text[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break;
        j++;
      }
      blank(i + 1, j); i = j + 1;
      while (i < n && /[a-z]/.test(text[i])) i++;
      prev = 'x'; prevWord = ''; continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      if (tpl.length && tpl[tpl.length - 1] === depth - 1) { depth--; tpl.pop(); i++; scanTemplate(); continue; }
      depth--;
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j++;
      prevWord = text.slice(i, j); prev = 'x'; i = j; continue;
    }
    if (!/\s/.test(c)) { prev = c; prevWord = ''; }
    i++;
  }
  return out.join('');
}

function srcFiles(): string[] {
  const list: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else if (e.isFile() && /\.(ts|mts)$/.test(e.name) && !e.name.endsWith('.d.ts')) list.push(p);
    }
  };
  walk(SRC);
  return list.sort();
}
const rel = (p: string): string => path.relative(path.dirname(SRC), p).split(path.sep).join('/');
const lineOf = (text: string, at: number): number => text.slice(0, at).split('\n').length;

const CATCH = /(?<![.\w$])catch\s*[({]/g;
const ANY = /(?<![.\w$])any(?![\w$])/g;
/** A static import / re-export with a `from`, or a bare side-effect import; `type`-only ones are dropped by the caller. */
const IMPORT = /(?:^|[;}\n])\s*(import|export)(\s+type\b)?(?:[^;'"`]*?\bfrom\s*)?(['"])/g;

interface FileScan { readonly file: string; readonly catches: number[]; readonly anys: number[]; readonly imports: string[] }

function scanFile(abs: string): FileScan {
  const text = fs.readFileSync(abs, 'utf8');
  const masked = maskCode(text);
  const catches = [...masked.matchAll(CATCH)].map((m) => lineOf(text, m.index));
  const anys = [...masked.matchAll(ANY)].map((m) => lineOf(text, m.index));
  const imports: string[] = [];
  for (const m of masked.matchAll(IMPORT)) {
    if (m[2]) continue; // import type / export type
    const q = m.index + m[0].length - 1; // the opening quote
    const close = text.indexOf(m[3], q + 1);
    const spec = text.slice(q + 1, close);
    if (m[1] === 'export' && !/\bfrom\s*['"]$/.test(m[0])) continue; // `export const x = '...'` and the like
    if (!spec.startsWith('.')) continue;
    const target = path.resolve(path.dirname(abs), spec);
    if (target.startsWith(SRC + path.sep) && fs.existsSync(target)) imports.push(rel(target));
  }
  return { file: rel(abs), catches, anys, imports: [...new Set(imports)].sort() };
}

/** Tarjan's SCCs over the runtime import graph; returns the components of 2+ files (or a file that imports itself). */
export function cycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  let index = 0;
  const idx = new Map<string, number>(), low = new Map<string, number>(), on = new Set<string>(), stack: string[] = [], out: string[][] = [];
  const visit = (v: string): void => {
    idx.set(v, index); low.set(v, index); index++; stack.push(v); on.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v) as number, low.get(w) as number)); } else if (on.has(w)) low.set(v, Math.min(low.get(v) as number, idx.get(w) as number));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do { w = stack.pop() as string; on.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1 || (graph.get(v) ?? []).includes(v)) out.push(comp.sort());
    }
  };
  for (const v of [...graph.keys()].sort()) if (!idx.has(v)) visit(v);
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

interface Baseline {
  readonly note: string;
  readonly tryCatchOutsideCore: { readonly total: number; readonly files: Record<string, number> };
  readonly any: { readonly total: number; readonly files: Record<string, number> };
  readonly cycles: { readonly components: string[][]; readonly edges: string[] };
}

describe('V13 row 38 lint ratchets (counts only go down)', () => {
  const scans = srcFiles().map(scanFile);
  const per = (pick: (s: FileScan) => number[], keep: (f: string) => boolean): Record<string, number> =>
    Object.fromEntries(scans.filter((s) => keep(s.file) && pick(s).length > 0).map((s) => [s.file, pick(s).length]));
  const sum = (r: Record<string, number>): number => Object.values(r).reduce((a, b) => a + b, 0);
  const tryNow = per((s) => s.catches, (f) => !f.startsWith('src/core/'));
  const anyNow = per((s) => s.anys, () => true);
  const graph = new Map(scans.map((s) => [s.file, s.imports]));
  const comps = cycles(graph);
  const inComp = new Map<string, number>();
  comps.forEach((c, k) => c.forEach((f) => inComp.set(f, k)));
  const cycleEdges = scans.flatMap((s) => s.imports.filter((t) => inComp.has(s.file) && inComp.get(s.file) === inComp.get(t)).map((t) => s.file + ' -> ' + t)).sort();
  const base: Baseline | null = fs.existsSync(BASELINE_PATH) ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as Baseline : null;

  const over = (now: Record<string, number>, was: Record<string, number> | undefined, lines: (f: string) => number[]): string[] =>
    Object.entries(now).filter(([f, k]) => k > (was?.[f] ?? 0)).map(([f, k]) => f + ': ' + (was?.[f] ?? 0) + ' -> ' + k + ' (lines ' + lines(f).join(', ') + ')');
  const linesOf = (pick: (s: FileScan) => number[]) => (f: string): number[] => pick(scans.find((s) => s.file === f) as FileScan);
  const tryOver = over(tryNow, base?.tryCatchOutsideCore.files, linesOf((s) => s.catches));
  const anyOver = over(anyNow, base?.any.files, linesOf((s) => s.anys));
  const newEdges = cycleEdges.filter((e) => !(base?.cycles.edges ?? []).includes(e));

  test('the baseline exists (or is being written, never raised)', () => {
    if (process.env.LINT_RATCHET_WRITE === '1') {
      assert.ok(!base || (tryOver.length === 0 && anyOver.length === 0 && newEdges.length === 0), 'refusing to raise the baseline:\n' + [...tryOver, ...anyOver, ...newEdges].join('\n'));
      const b: Baseline = {
        note: 'V13 row 38 lint ratchet (test/lintRatchet.test.ts). Counts and cycle edges may only go down. Target: all zero / empty.',
        tryCatchOutsideCore: { total: sum(tryNow), files: tryNow },
        any: { total: sum(anyNow), files: anyNow },
        cycles: { components: comps, edges: cycleEdges },
      };
      fs.writeFileSync(BASELINE_PATH, JSON.stringify(b, null, 2) + '\n');
    }
    assert.ok(fs.existsSync(BASELINE_PATH), 'test/lintRatchet.baseline.json exists');
  });

  test('L1: no new raw try/catch outside src/core (use runStep / fetchStep / the core helpers)', { skip: base ? false : 'no baseline' }, () => {
    assert.deepEqual(tryOver, [], 'new try/catch outside src/core');
    assert.ok(sum(tryNow) <= (base as Baseline).tryCatchOutsideCore.total);
  });

  test('L2: no new import cycle in src/ (break one with a lazy `await import()`)', { skip: base ? false : 'no baseline' }, () => {
    assert.deepEqual(newEdges, [], 'a new runtime import edge inside a cycle');
  });

  test('L3: the `any` count in src/ does not go up', { skip: base ? false : 'no baseline' }, () => {
    assert.deepEqual(anyOver, [], 'new `any` in src/');
    assert.ok(sum(anyNow) <= (base as Baseline).any.total);
  });

  test('the scanner sees what it should (self-check on made-up text)', () => {
    const src = "const a: any = 'any catch (x) {'; // any\nconst r = /catch {/g; const t = `x ${b as any} any`; try { f(); } catch { p.catch(() => 1); }\n";
    const m = maskCode(src);
    assert.equal(m.length, src.length, 'offsets kept');
    assert.equal([...m.matchAll(ANY)].length, 2);
    assert.equal([...m.matchAll(CATCH)].length, 1);
    assert.deepEqual(cycles(new Map([['a', ['b']], ['b', ['a']], ['c', ['a']]])), [['a', 'b']]);
    const imp = [...maskCode("import type { X } from './x.ts';\nimport { y } from './y.ts';\nexport { z } from './z.ts';\nexport type { W } from './w.ts';\nconst k = await import('./lazy.ts');\n").matchAll(IMPORT)].filter((x) => !x[2]).length;
    assert.equal(imp, 2);
  });
});
