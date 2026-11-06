/**
 * Core-first workflow (CORE_README.md, core-manifest.json): copy the shared core out of this repo, byte for byte.
 * Nothing here creates a repo, pushes, or changes this repo: it only writes the target folder.
 *
 *   npm run export-core                         -> <system temp>/trading-analyzer-core
 *   npm run export-core -- --out DIR [--force]  -> DIR (--force empties a non-empty DIR first)
 *   npm run export-core -- --check-only DIR     -> only the scan of an existing tree
 *
 * What it does:
 *   1. copies every tracked file that core-manifest.json marks core (and nothing else). No file is changed on the way:
 *      the export then checks that every copied file is byte-identical to this repo's (0 patched), so updates can flow
 *      back by plain copying (npm run import-core);
 *   2. scans the result: secret shapes, key files, sheet-ID shapes, emails, Hebrew outside the course terms, and, when
 *      this copy has a private overlay with scan markers (src/owner/scanMarkers.ts), its owner's data as SHA-256
 *      hashes (sheet IDs, login, name, robot, emails, list hashes, tab names). Exit 1 on any hit. Prints counts and
 *      file:line only, never the text found.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, coreMatcher, readManifest, treeFiles } from './coreManifest.ts';

const sha = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// ---- 1. The copy -------------------------------------------------------------------------------------------------

export interface Plan { readonly core: string[]; readonly overlay: string[] }

/** Splits a list of repo-relative files by the manifest. */
export function planFiles(files: readonly string[], isCore: (rel: string) => boolean = coreMatcher(readManifest())): Plan {
  const core: string[] = [], overlay: string[] = [];
  for (const f of files) (isCore(f) ? core : overlay).push(f);
  return { core, overlay };
}

export interface ExportResult { readonly copied: number; readonly overlay: number; readonly patched: string[]; readonly plan: Plan }

/** Copies the core files of `from` (its tracked files, its manifest) into the empty folder `out`; then compares every
 *  copied file with its source (`patched` lists any that differ: always empty unless the disk changed under it). */
export function exportCore(from: string, out: string): ExportResult {
  const plan = planFiles(treeFiles(from), coreMatcher(readManifest(from)));
  for (const f of plan.core) {
    fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true });
    fs.copyFileSync(path.join(from, f), path.join(out, f));
  }
  const patched = plan.core.filter((f) => !fs.readFileSync(path.join(out, f)).equals(fs.readFileSync(path.join(from, f))));
  return { copied: plan.core.length, overlay: plan.overlay.length, patched, plan };
}

// ---- 2. The scan -------------------------------------------------------------------------------------------------

export interface ScanResult { readonly counts: Record<string, number>; readonly where: Record<string, string[]> }

const SHEET_ID = /(?<![A-Za-z0-9_-])1[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const SECRETS: readonly RegExp[] = [/AIza[0-9A-Za-z_-]{35}/, /(?<!\d)\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/, /sk-ant-[A-Za-z0-9_-]{10,}/, /github_pat_[A-Za-z0-9_]{20,}/, /gh[pousr]_[A-Za-z0-9]{36}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /xox[baprs]-[A-Za-z0-9-]{10,}/, /AKIA[0-9A-Z]{16}/];
const TICKER_ARRAY = /\[\s*((?:(['"])[A-Z^][A-Z0-9.\-=^]{0,11}\2\s*,\s*)+(['"])[A-Z^][A-Z0-9.\-=^]{0,11}\3\s*,?\s*)\]/g;
const BINARY = /\.(gz|zip|pdf|png|jpe?g|gif|webp|ico|xlsx?|docx?|pptx?|woff2?|ttf|mp4|mov)$/i;

export interface OwnerMarkers {
  /** SHA-256 of the 3 sheet IDs. */ readonly sheetIdHashes: ReadonlySet<string>;
  /** SHA-256 of lower-case words: login, first name, robot project id. */ readonly wordHashes: ReadonlySet<string>;
  /** SHA-256 of lower-case emails. */ readonly emailHashes: ReadonlySet<string>;
  /** SHA-256 of the owner lists (sorted, unique, comma-joined). */ readonly listHashes: ReadonlySet<string>;
  /** SHA-256 of the owner's personal tab names (the 15 protected tabs). */ readonly tabHashes: ReadonlySet<string>;
  /** The owner's personal lists, in memory only (never written): for the "a whole list within 15 lines" check. */ readonly lists: readonly (readonly string[])[];
}


/** Hebrew allowed: the course terms (engine + their parity test) and the guard's own character class. */
const HEBREW_OK = new Set(['backend/src/analysis/indicators/slices.ts', 'backend/test/indicators.slices.parity.test.ts', 'backend/test/genericGuard.test.ts']);

const listHash = (t: readonly string[]): string => sha([...new Set(t.filter((x) => x !== 'OTHER'))].sort().join(','));

function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r)); else if (e.isFile()) out.push(r);
  }
  return out.sort();
}

export function scanTree(dir: string, m: OwnerMarkers): ScanResult {
  const counts: Record<string, number> = { sheetIdShapes: 0, ownerSheetIds: 0, ownerWords: 0, ownerEmails: 0, otherEmails: 0, ownerListHashes: 0, ownerTabNames: 0, ownerListNearby: 0, secretShapes: 0, keyFiles: 0, hebrewOutsideOracle: 0 };
  const where: Record<string, string[]> = {};
  const hit = (k: string, f: string, line: number): void => { counts[k]++; (where[k] ??= []).push(f + ':' + line); };
  for (const f of walk(dir)) {
    if (path.basename(f) === '.env' || /service-account.*\.json$/.test(f)) hit('keyFiles', f, 0);
    if (BINARY.test(f)) continue;
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    if (f.endsWith('.json') && /"private_key"\s*:/.test(text)) hit('keyFiles', f, 0);
    const lines = text.split('\n');
    lines.forEach((l, i) => {
      for (const id of l.match(SHEET_ID) ?? []) { hit('sheetIdShapes', f, i + 1); if (m.sheetIdHashes.has(sha(id))) hit('ownerSheetIds', f, i + 1); }
      const words = new Set([...(l.match(/[A-Za-z]+/g) ?? []), ...(l.match(/[A-Za-z0-9-]+/g) ?? [])].map((x) => x.toLowerCase()));
      if ([...words].some((w) => m.wordHashes.has(sha(w)))) hit('ownerWords', f, i + 1);
      for (const e of l.match(EMAIL) ?? []) {
        if (m.emailHashes.has(sha(e.toLowerCase()))) hit('ownerEmails', f, i + 1);
        else if (!/@(example\.(org|com)|users\.noreply\.github\.com|[a-z0-9-]+\.iam\.gserviceaccount\.com)$/i.test(e)) hit('otherEmails', f, i + 1);
      }
      if (SECRETS.some((re) => re.test(l))) hit('secretShapes', f, i + 1);
      // An owner list written out in a line of text ("TSLA, AVGO, ...") or a comma list.
      const tokens = l.match(/(?<![A-Za-z0-9_])[A-Z][A-Z0-9.]{0,9}(?![A-Za-z0-9_])/g) ?? [];
      if (tokens.length >= 3 && m.listHashes.has(listHash(tokens))) hit('ownerListHashes', f, i + 1);
      for (const q of l.matchAll(/(['"`])([^'"`]{2,60})\1/g)) if (m.tabHashes.has(sha(q[2]))) hit('ownerTabNames', f, i + 1);
      if (/[\u0590-\u05FF]/.test(l) && !HEBREW_OK.has(f) && !f.startsWith('backend/legacy/')) hit('hebrewOutsideOracle', f, i + 1);
    });
    // A whole owner list (6+ tickers) named within 15 lines, in any form (HTML options, object keys, prose).
    const lineTokens = lines.map((l) => new Set(l.match(/(?<![A-Za-z0-9_])[A-Z][A-Z0-9.]{0,9}(?![A-Za-z0-9_])/g) ?? []));
    for (const list of m.lists.filter((x) => new Set(x).size >= 6)) {
      for (let i = 0; i < lines.length; i++) {
        if (!lineTokens[i].has(list[0])) continue;
        const near = new Set<string>();
        for (let j = Math.max(0, i - 14); j < Math.min(lines.length, i + 15); j++) for (const t of lineTokens[j]) near.add(t);
        if (list.every((t) => near.has(t))) { hit('ownerListNearby', f, i + 1); break; }
      }
    }
    for (const a of text.matchAll(TICKER_ARRAY)) {
      const t = [...a[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
      if (m.listHashes.has(listHash(t))) hit('ownerListHashes', f, text.slice(0, a.index).split('\n').length);
    }
  }
  return { counts, where };
}

// ---- Run ---------------------------------------------------------------------------------------------------------

/** No owner data to look for: the generic checks only (secret shapes, key files, sheet-ID shapes, emails, Hebrew). */
export const NO_MARKERS: OwnerMarkers = { sheetIdHashes: new Set(), wordHashes: new Set(), emailHashes: new Set(), listHashes: new Set(), tabHashes: new Set(), lists: [] };

/** The private overlay's scan markers (src/owner/scanMarkers.ts), or none in a copy without them. */
export async function loadMarkers(root: string = REPO_ROOT): Promise<{ readonly markers: OwnerMarkers; readonly owner: boolean }> {
  const file = path.join(root, 'backend', 'src', 'owner', 'scanMarkers.ts');
  if (!fs.existsSync(file)) return { markers: NO_MARKERS, owner: false };
  const m = await import(pathToFileURL(file).href) as { scanMarkers: () => OwnerMarkers };
  return { markers: m.scanMarkers(), owner: true };
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

export function report(r: ScanResult, log: (line: string) => void = console.log): number {
  const bad = ['ownerSheetIds', 'ownerWords', 'ownerEmails', 'otherEmails', 'ownerListHashes', 'ownerTabNames', 'ownerListNearby', 'secretShapes', 'keyFiles', 'sheetIdShapes', 'hebrewOutsideOracle'].filter((k) => r.counts[k] > 0);
  log('scan: ' + Object.entries(r.counts).map(([k, v]) => k + ' ' + v).join(', '));
  for (const k of bad) log('  ' + k + ': ' + r.where[k].slice(0, 20).join(', ') + (r.where[k].length > 20 ? ' …' : ''));
  return bad.length;
}

async function main(): Promise<void> {
  const { markers, owner } = await loadMarkers();
  const checkOnly = arg('--check-only');
  if (checkOnly) { process.exit(report(scanTree(path.resolve(checkOnly), markers)) ? 1 : 0); }

  const outDir = path.resolve(arg('--out') ?? path.join(os.tmpdir(), 'trading-analyzer-core'));
  if (outDir === REPO_ROOT || outDir.startsWith(REPO_ROOT + path.sep)) throw new Error('the export folder must be outside this repo');
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) {
    if (!process.argv.includes('--force')) throw new Error(outDir + ' is not empty (add --force to replace it)');
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  const r = exportCore(REPO_ROOT, outDir);
  const version = fs.existsSync(path.join(REPO_ROOT, 'VERSION')) ? fs.readFileSync(path.join(REPO_ROOT, 'VERSION'), 'utf8').trim() : '?';
  console.log('export: ' + outDir + ' (core ' + version + ')');
  console.log('files: ' + r.copied + ' core copied, ' + r.overlay + ' overlay left out, ' + r.patched.length + ' patched' + (r.patched.length ? ': ' + r.patched.slice(0, 10).join(', ') : ''));
  console.log('scan markers: ' + (owner ? 'the private overlay\'s (src/owner/scanMarkers.ts)' : 'none (generic checks only)'));
  const hits = report(scanTree(outDir, markers));
  process.exit(hits || r.patched.length ? 1 : 0);
}

if (import.meta.main) await main();
