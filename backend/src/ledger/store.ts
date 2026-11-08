/**
 * The ledger files on a checked-out `data` branch folder (docs/LEDGER.md): DATA_BRANCH_DIR, default ../data-branch
 * (relative to backend/, i.e. the folder the workflow checks the branch out into at the repository root).
 *
 *   JSON files (holdings, assets, watchlist)  pretty-printed (2 spaces, a final newline), written whole
 *   JSONL files (flows, snapshots, edits, journal)  one object per line, APPEND-ONLY (a line is never rewritten)
 *
 * Every file and every line carries `schema`; a reader refuses a NEWER schema (this code would misread it) and a
 * file that is not valid JSON, with one plain line naming the file. A missing file reads as null / [].
 */

import fs from 'node:fs';
import path from 'node:path';
import { orElse } from '../core/guard.ts';
import { LEDGER_FILES, LEDGER_SCHEMA, type LedgerAssets, type LedgerEdit, type LedgerFlow, type LedgerJournalEntry, type LedgerHoldings, type LedgerSnapshot, type LedgerPrices, type LedgerTargets, type LedgerWatchlist } from './schema.ts';

type Env = Readonly<Record<string, string | undefined>>;

/** The data branch's folder: DATA_BRANCH_DIR, else ../data-branch from the current folder (backend/). */
export function dataBranchDir(env: Env = process.env, cwd: string = process.cwd()): string {
  const d = (env.DATA_BRANCH_DIR ?? '').trim();
  return path.resolve(cwd, d || '../data-branch');
}

export interface JsonFiles { readonly holdings: LedgerHoldings; readonly assets: LedgerAssets; readonly watchlist: LedgerWatchlist; readonly targets: LedgerTargets; readonly prices: LedgerPrices }
export interface JsonlFiles { readonly flows: LedgerFlow; readonly snapshots: LedgerSnapshot; readonly edits: LedgerEdit; readonly journal: LedgerJournalEntry }

export class LedgerFormatError extends Error {
  constructor(message: string) { super(message); this.name = 'LedgerFormatError'; }
}

/** Refuses a value without a numeric `schema`, or with one newer than this code reads. */
export function checkSchema(v: unknown, file: string): void {
  const s = (v as { schema?: unknown } | null)?.schema;
  if (typeof s !== 'number' || !Number.isInteger(s) || s < 1) throw new LedgerFormatError(file + ': no ledger schema number; not a ledger file');
  if (s > LEDGER_SCHEMA) throw new LedgerFormatError(file + ': written in ledger format ' + s + ', newer than this code reads (' + LEDGER_SCHEMA + '); update the code first');
}

const NOT_JSON = Symbol('not json');
function parse(text: string, file: string): unknown {
  const v = orElse<unknown>(null, 'ledger parse', () => JSON.parse(text), NOT_JSON);
  if (v === NOT_JSON) throw new LedgerFormatError(file + ': not valid JSON');
  return v;
}

export function ledgerPath(root: string, key: keyof JsonFiles | keyof JsonlFiles): string {
  return path.join(root, LEDGER_FILES[key]);
}

/** A JSON file, schema-checked; null when the file does not exist. */
export function readLedgerJson<K extends keyof JsonFiles>(root: string, key: K): JsonFiles[K] | null {
  const file = ledgerPath(root, key);
  if (!fs.existsSync(file)) return null;
  const v = parse(fs.readFileSync(file, 'utf8'), LEDGER_FILES[key]);
  checkSchema(v, LEDGER_FILES[key]);
  return v as JsonFiles[K];
}

export function formatJson(v: unknown): string {
  return JSON.stringify(v, null, 2) + '\n';
}

/** Writes a JSON file whole (pretty), creating the ledger folder. Refuses a value with a bad schema. */
export function writeLedgerJson<K extends keyof JsonFiles>(root: string, key: K, value: JsonFiles[K]): string {
  checkSchema(value, LEDGER_FILES[key]);
  const file = ledgerPath(root, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, formatJson(value));
  return file;
}

/** Every line of a JSONL file (blank lines skipped), each schema-checked; [] when the file does not exist. */
export function readLedgerJsonl<K extends keyof JsonlFiles>(root: string, key: K): JsonlFiles[K][] {
  const file = ledgerPath(root, key);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map((l, i) => [l.trim(), i] as const).filter(([l]) => l !== '').map(([l, i]) => {
    const v = parse(l, LEDGER_FILES[key] + ' line ' + (i + 1));
    checkSchema(v, LEDGER_FILES[key] + ' line ' + (i + 1));
    return v as JsonlFiles[K];
  });
}

/** Appends lines to a JSONL file (never rewrites one). Refuses a line with a bad schema. */
export function appendLedgerJsonl<K extends keyof JsonlFiles>(root: string, key: K, rows: readonly JsonlFiles[K][]): number {
  if (!rows.length) return 0;
  rows.forEach((r) => checkSchema(r, LEDGER_FILES[key]));
  const file = ledgerPath(root, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const sep = prev !== '' && !prev.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, sep + rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return rows.length;
}

/** Appends one day's snapshot unless that date already has a line (append-only: the first line of a day stays). */
export function appendSnapshot(root: string, snap: LedgerSnapshot): 'added' | 'exists' {
  return appendSnapshots(root, [snap]).added === 1 ? 'added' : 'exists';
}

/** Appends the snapshots whose date has no line yet (in date order); never rewrites or overwrites a day. */
export function appendSnapshots(root: string, snaps: readonly LedgerSnapshot[]): { readonly added: number; readonly kept: number } {
  const have = new Set(readLedgerJsonl(root, 'snapshots').map((s) => s.date));
  const fresh: LedgerSnapshot[] = [];
  for (const s of [...snaps].sort((a, b) => a.date.localeCompare(b.date))) if (!have.has(s.date)) { have.add(s.date); fresh.push(s); }
  appendLedgerJsonl(root, 'snapshots', fresh);
  return { added: fresh.length, kept: snaps.length - fresh.length };
}
