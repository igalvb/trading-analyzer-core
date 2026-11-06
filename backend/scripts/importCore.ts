/**
 * Core-first workflow (CORE_README.md): bring a release of the shared core into this repo by plain copying.
 *
 *   npm run import-core -- <path to a core checkout>             copy it in
 *   npm run import-core -- <path to a core checkout> --dry-run   only print what would change
 *
 * Reads the checkout's VERSION and core-manifest.json. Every file of the checkout must be core under that manifest.
 * Then, in this repo:
 *   - writes every checkout file that is new or different (a path this repo's manifest calls OVERLAY is never
 *     overwritten: the import stops before writing anything);
 *   - deletes the files this repo's manifest calls core that the checkout no longer has;
 *   - never touches any other file (the overlay).
 * Prints the version change and a summary (added / changed / deleted / unchanged, with the paths). It does not commit:
 * run the full test suite (and a private overlay's own checks) first, then commit.
 */

import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, coreMatcher, readManifest, treeFiles } from './coreManifest.ts';

export interface ImportPlan {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly added: string[];
  readonly changed: string[];
  readonly deleted: string[];
  readonly unchanged: number;
  /** Paths that would break the rules (the import refuses when any): checkout files the checkout's own manifest does
   *  not call core, and checkout files that would overwrite one of this repo's overlay files. */
  readonly refused: string[];
}

const versionOf = (dir: string): string => (fs.existsSync(path.join(dir, 'VERSION')) ? fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim() : '');

/** What importing the core checkout `from` into the repo `to` would do (reads only). */
export function planImport(from: string, to: string = REPO_ROOT): ImportPlan {
  if (!versionOf(from)) throw new Error('no VERSION file in ' + from + ': not a core checkout');
  const isCoreThere = coreMatcher(readManifest(from));
  const isCoreHere = coreMatcher(readManifest(to));
  const incoming = treeFiles(from);
  const here = treeFiles(to);
  const hereSet = new Set(here);
  const incomingSet = new Set(incoming);
  const added: string[] = [], changed: string[] = [], refused: string[] = [];
  let unchanged = 0;
  for (const f of incoming) {
    if (!isCoreThere(f)) { refused.push(f + ' (not core in the checkout\'s own manifest)'); continue; }
    const dest = path.join(to, f);
    const exists = fs.existsSync(dest);
    if (exists && !isCoreHere(f)) { refused.push(f + ' (an overlay file here)'); continue; }
    if (!exists) added.push(f);
    else if (fs.readFileSync(dest).equals(fs.readFileSync(path.join(from, f)))) unchanged++;
    else changed.push(f);
  }
  const deleted = here.filter((f) => isCoreHere(f) && !incomingSet.has(f) && hereSet.has(f));
  return { fromVersion: versionOf(to) || '(none)', toVersion: versionOf(from), added, changed, deleted, unchanged, refused };
}

/** Applies a plan (refuses when `plan.refused` is not empty). */
export function applyImport(plan: ImportPlan, from: string, to: string = REPO_ROOT): void {
  if (plan.refused.length) throw new Error('import refused, nothing written: ' + plan.refused.slice(0, 10).join('; '));
  for (const f of [...plan.added, ...plan.changed]) {
    fs.mkdirSync(path.dirname(path.join(to, f)), { recursive: true });
    fs.copyFileSync(path.join(from, f), path.join(to, f));
  }
  for (const f of plan.deleted) fs.rmSync(path.join(to, f));
}

export function summary(p: ImportPlan): string[] {
  const list = (label: string, xs: readonly string[]): string[] => (xs.length ? [label + ' ' + xs.length + ':', ...xs.slice(0, 50).map((x) => '  ' + x), ...(xs.length > 50 ? ['  …'] : [])] : []);
  return [
    'core ' + p.fromVersion + ' -> ' + p.toVersion,
    'files: ' + p.added.length + ' added, ' + p.changed.length + ' changed, ' + p.deleted.length + ' deleted, ' + p.unchanged + ' unchanged',
    ...list('refused', p.refused), ...list('added', p.added), ...list('changed', p.changed), ...list('deleted', p.deleted),
  ];
}

if (import.meta.main) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const dry = process.argv.includes('--dry-run');
  if (args.length !== 1) { console.log('Usage: npm run import-core -- <path to a core checkout> [--dry-run]'); process.exit(2); }
  const from = path.resolve(args[0] as string);
  if (from === REPO_ROOT) { console.log('import-core: the core checkout must be another folder'); process.exit(2); }
  const plan = planImport(from);
  for (const l of summary(plan)) console.log(l);
  if (plan.refused.length) { console.log('import refused: nothing was written'); process.exit(1); }
  if (dry) { console.log('dry run: nothing was written'); process.exit(0); }
  applyImport(plan, from);
  console.log('written. Next: cd backend && npm run typecheck && npm test (and the overlay checks), then commit.');
}
