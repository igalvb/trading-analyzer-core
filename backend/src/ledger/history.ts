/**
 * The system's own history, copied from Google to the `data` branch as plain files (docs/LEDGER.md, phase 4 plan):
 * a generic "tab -> file" copier driven by a manifest, so the TabStore / PropertyStore can later be backed by files
 * (FileTabStore / FilePropertyStore below). NOTHING reads these files yet: no run is switched to them.
 *
 *   'rows' tabs  history/<file>.jsonl: one JSON array per sheet row, header row first, values exactly as the Sheets API
 *                returns them unformatted (dates stay Sheets serial numbers): lossless, and a git diff shows new rows.
 *   'kv' tab     history/script-properties.json: { key: { value, updatedAt } } of the 💾 Script Properties store.
 *                Values are copied but NEVER printed; a value shaped like a secret (SECRET_SHAPES: API keys in a
 *                URL, Google / Anthropic / GitHub / Telegram tokens, private-key blocks) is left out and only its KEY is reported.
 *   history/manifest.json  per tab: file, rows, bytes, sha256, copiedAt (no cell values).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { OPTIONS_READ_TABS, OPS_REPORT_TABS, PAPER_INPUT_TABS, Tabs } from '../sheets/tabs.ts';
import { PROPERTY_STORE_HEADER, type PropertyStore } from '../storage/kv.ts';
import type { TabCell, TabStore } from '../storage/tabStore.ts';
import { sheetsSerialToDate } from '../storage/priceHistory.ts';
import { formatJson } from './store.ts';
import { LEDGER_SCHEMA } from './schema.ts';

export const HISTORY_DIR = 'history';

export interface HistoryEntry {
  readonly tab: string;
  /** Relative to the data branch root. */
  readonly file: string;
  readonly format: 'rows' | 'kv';
}

const rows = (tab: string, name: string): HistoryEntry => ({ tab, file: HISTORY_DIR + '/' + name + '.jsonl', format: 'rows' });

/** What is copied (the system's own stores; never the owner's personal tabs, never the Portfolio tab: that is the ledger). */
export const HISTORY_MANIFEST: readonly HistoryEntry[] = [
  rows('📝 Paper State', 'paper-state'),
  rows('📒 Paper Log', 'paper-log'),
  rows('📈 Paper Values', 'paper-values'),
  rows('🔎 Paper Reads', 'paper-reads'),
  ...PAPER_INPUT_TABS.map((t) => rows(t, t === '🤖 Claude Picks' ? 'claude-picks' : t === '🤖 Claude Ideas' ? 'claude-ideas' : slugTab(t))),
  rows(Tabs.DECISION_HISTORY, 'decision-history'),
  rows('Exit Target History', 'exit-target-history'),
  ...OPS_REPORT_TABS.map((t) => rows(t, 'run-health')),
  ...OPTIONS_READ_TABS.map((t) => rows(t, slugTab(t))),
  rows('📦 Option Chain Snapshots', 'option-chain-snapshots'),
  rows('📉 IV History', 'iv-history'),
  { tab: Tabs.SCRIPT_PROPERTIES, file: HISTORY_DIR + '/script-properties.json', format: 'kv' },
];

/** '📈 Options Reads' -> 'options-reads' (letters and digits only). */
export function slugTab(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'tab';
}

export type Cell = string | number | boolean | null;
const cellOf = (v: unknown): Cell => (v == null ? null : typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string' ? v : v instanceof Date ? v.toISOString() : String(v));

/** Rows -> JSONL text (one array per line, trailing empty cells dropped). */
export function rowsToJsonl(grid: readonly (readonly unknown[])[]): string {
  return grid.map((r) => { const a = r.map(cellOf); while (a.length && (a[a.length - 1] === null || a[a.length - 1] === '')) a.pop(); return JSON.stringify(a); }).join('\n') + (grid.length ? '\n' : '');
}
export function jsonlToRows(text: string): Cell[][] {
  return text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Cell[]);
}

/** The shapes of test/genericGuard.test.ts R7, plus a key in a URL query. */
export const SECRET_SHAPES: readonly RegExp[] = [
  /[?&](api_?key|apikey|token|access_token|key)=[^&\s"]{6,}/i, /AIza[0-9A-Za-z_-]{35}/, /(?<!\d)\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/,
  /sk-ant-[A-Za-z0-9_-]{10,}/, /github_pat_[A-Za-z0-9_]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /"private_key"\s*:/,
];
/** A secret-shaped value (an API key, a token, a private key): never copied. */
export function looksSecret(value: string): boolean {
  return SECRET_SHAPES.some((re) => re.test(value));
}

export interface KvCopy { readonly entries: Record<string, { readonly value: string; readonly updatedAt: string }>; readonly withheld: readonly string[] }
/** The Script Properties grid (Key | Value | UpdatedAt) -> the kv file's entries, secret-shaped values withheld. */
export function kvFromGrid(grid: readonly (readonly unknown[])[]): KvCopy {
  const entries: Record<string, { value: string; updatedAt: string }> = {};
  const withheld: string[] = [];
  for (const r of grid.slice(String(grid[0]?.[0] ?? '') === PROPERTY_STORE_HEADER[0] ? 1 : 0)) {
    const key = r[0] == null ? '' : String(r[0]);
    if (!key) continue;
    const value = r[1] == null ? '' : String(r[1]);
    if (looksSecret(value)) { withheld.push(key); continue; }
    entries[key] = { value, updatedAt: r[2] == null ? '' : String(r[2]) };
  }
  return { entries, withheld };
}

export interface CopiedTab { readonly tab: string; readonly file: string; readonly rows: number; readonly bytes: number; readonly sha256: string | null; readonly missing: boolean; readonly withheld?: readonly string[] }

/** Copies every manifest tab through `read` (null = no such tab) into `root`; writes history/manifest.json. */
export async function copyHistory(read: (tab: string) => Promise<unknown[][] | null>, root: string, nowIso: string, manifest: readonly HistoryEntry[] = HISTORY_MANIFEST): Promise<CopiedTab[]> {
  const out: CopiedTab[] = [];
  for (const e of manifest) {
    const grid = await read(e.tab);
    if (!grid) { out.push({ tab: e.tab, file: e.file, rows: 0, bytes: 0, sha256: null, missing: true }); continue; }
    let text: string, withheld: readonly string[] | undefined, n: number;
    if (e.format === 'kv') {
      const kv = kvFromGrid(grid);
      text = formatJson({ schema: LEDGER_SCHEMA, tab: e.tab, copiedAt: nowIso, entries: kv.entries });
      withheld = kv.withheld; n = Object.keys(kv.entries).length;
    } else { text = rowsToJsonl(grid); n = grid.length; }
    const file = path.join(root, e.file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    out.push({ tab: e.tab, file: e.file, rows: n, bytes: Buffer.byteLength(text), sha256: crypto.createHash('sha256').update(text).digest('hex'), missing: false, ...(withheld ? { withheld } : {}) });
  }
  fs.mkdirSync(path.join(root, HISTORY_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, HISTORY_DIR, 'manifest.json'), formatJson({ schema: LEDGER_SCHEMA, copiedAt: nowIso, tabs: out.map((t) => ({ ...t, withheld: t.withheld?.length ?? 0 })) }));
  return out;
}

/**
 * A TabStore on the copied files (not used by any run yet): read / ensure / clear / write like the Sheet store, one
 * JSONL file per manifest tab. Date columns: a number there comes back as a Date (Sheets serial in `timeZone`).
 */
export class FileTabStore implements TabStore {
  private readonly root: string;
  private readonly timeZone: string;
  private readonly manifest: readonly HistoryEntry[];
  constructor(root: string, timeZone: string, manifest: readonly HistoryEntry[] = HISTORY_MANIFEST) {
    this.root = root; this.timeZone = timeZone; this.manifest = manifest;
  }
  private fileOf(tab: string): string {
    const e = this.manifest.find((m) => m.tab === tab && m.format === 'rows');
    return path.join(this.root, e ? e.file : HISTORY_DIR + '/' + slugTab(tab) + '.jsonl');
  }
  async read(tab: string, nCols: number, dateColumns: readonly number[] = []): Promise<TabCell[][] | null> {
    const f = this.fileOf(tab);
    if (!fs.existsSync(f)) return null;
    return jsonlToRows(fs.readFileSync(f, 'utf8')).map((r) => Array.from({ length: nCols }, (_, c) => {
      const v = r[c];
      if (v == null) return '';
      return typeof v === 'number' && dateColumns.includes(c) ? sheetsSerialToDate(v, this.timeZone) : v;
    }));
  }
  async ensure(tab: string): Promise<boolean> {
    const f = this.fileOf(tab);
    if (fs.existsSync(f)) return false;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '');
    return true;
  }
  async clear(tab: string): Promise<void> { fs.writeFileSync(this.fileOf(tab), ''); }
  async write(tab: string, row: number, block: readonly (readonly TabCell[])[]): Promise<void> {
    const f = this.fileOf(tab);
    if (!fs.existsSync(f)) throw new Error('FileTabStore: no tab ' + tab);
    const grid: Cell[][] = jsonlToRows(fs.readFileSync(f, 'utf8'));
    block.forEach((r, i) => {
      while (grid.length < row - 1 + i) grid.push([]);
      const cur = grid[row - 1 + i] ?? [];
      r.forEach((v, c) => { while (cur.length < c) cur.push(null); cur[c] = cellOf(v); });
      grid[row - 1 + i] = cur;
    });
    fs.writeFileSync(f, rowsToJsonl(grid));
  }
}

/** A PropertyStore on history/script-properties.json (not used by any run yet). `flush` writes the file. */
export class FilePropertyStore implements PropertyStore {
  private readonly entries: Record<string, { value: string; updatedAt: string }>;
  private readonly file: string;
  private readonly now: () => number;
  constructor(file: string, now: () => number = Date.now) {
    this.file = file; this.now = now;
    this.entries = fs.existsSync(file) ? { ...(JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: Record<string, { value: string; updatedAt: string }> }).entries } : {};
  }
  async get(key: string): Promise<string | null> { return this.entries[key]?.value ?? null; }
  async set(key: string, value: string): Promise<void> { this.entries[key] = { value, updatedAt: new Date(this.now()).toISOString() }; }
  async delete(key: string): Promise<void> { delete this.entries[key]; }
  flush(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, formatJson({ schema: LEDGER_SCHEMA, tab: Tabs.SCRIPT_PROPERTIES, copiedAt: new Date(this.now()).toISOString(), entries: this.entries }));
  }
}
