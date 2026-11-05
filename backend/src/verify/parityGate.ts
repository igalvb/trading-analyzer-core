/**
 * FL-9b (1): the parity gate. Lists every legacy function (the 379 top-level `function` declarations in
 * legacy/*.gs) with its port status, derived from the code and the tests, and FAILS when a function has
 * no port and no recorded waiver (parityWaivers.ts).
 *
 * Pure: every input is text handed in by the caller (parityLoad.ts reads the files). Nothing here touches
 * the file system, the network or the oracle.
 *
 * How a status is derived (strongest evidence first):
 *   declared  the port declares a symbol with the legacy name, or the name without its version suffix
 *             (srLevelsV7 -> srLevels, turtleSizingV1_ -> turtleSizing), as function/const/let/var/class
 *             in src/ (comments stripped; src/verify/ itself is not scanned, or the gate would find itself)
 *   mapped    no declaration, but the legacy name is a quoted string or a line-start object key in src/
 *             (the mapping tables: MENU_ENTRY_POINTS, OPS_COMMANDS, trigger data). Used for menu handlers,
 *             trigger installers and diagnostics that became CLI commands or workflow cron lines.
 *   comment   the name appears only in comments. That is NOT a port.
 *   none      nothing found.
 *
 *   status    tested    declared AND the legacy name or the port symbol appears in a test file
 *             ported    declared, no test mentions it
 *             mapped    mapped (test mentions are counted in the row but do not change the status)
 *             waived    no port, but a recorded waiver with a reason and a reference
 *             unported  no port, no waiver  -> a failure
 *
 * Other failures: total != 379, per-file counts differ from legacy/README.md, a duplicate legacy name, a
 * waiver with no reason or reference, a waiver for an unknown function, a waiver on a function that now
 * has a port (stale).
 */

export type ParityStatus = 'tested' | 'ported' | 'mapped' | 'waived' | 'unported';
export type Evidence = 'declared' | 'mapped' | 'comment' | 'none';

export interface SourceText { readonly path: string; readonly text: string }

export interface ParityWaiver {
  /** The legacy function name. */
  readonly legacy: string;
  /** Why no port is needed or possible. Plain sentence. */
  readonly reason: string;
  /** A finding id (F-..), a user decision date, or a doc section. */
  readonly ref: string;
  /** YYYY-MM-DD the waiver was recorded. */
  readonly recordedOn: string;
}

/**
 * A reviewed rename: the port has the same logic under a different name (or the legacy function became data such
 * as LEGACY_MENUS). `symbol` must be declared in src/ (function, const, class, interface, type or method), or the
 * gate fails. kind 'port' = real code (status tested/ported); 'mapped' = a mapping table or workflow, not a function.
 */
export interface ParityAlias {
  readonly legacy: string;
  readonly symbol: string;
  readonly kind: 'port' | 'mapped';
  readonly note: string;
}

export interface LegacyFunction { readonly name: string; readonly file: string; readonly line: number }

export interface ParityRow {
  readonly legacy: string;
  readonly file: string;
  readonly line: number;
  readonly status: ParityStatus;
  readonly evidence: Evidence;
  readonly portSymbol: string | null;
  readonly portFile: string | null;
  /** How many test files mention the legacy name or the port symbol. */
  readonly testFiles: number;
  readonly waiver: string | null;
}

export interface ParityReport {
  readonly total: number;
  readonly expectedTotal: number;
  readonly rows: readonly ParityRow[];
  readonly byStatus: Readonly<Record<ParityStatus, number>>;
  readonly byFile: Readonly<Record<string, Readonly<Record<ParityStatus, number>>>>;
  readonly failures: readonly string[];
  readonly warnings: readonly string[];
  readonly pass: boolean;
}

/** The total the oracle expects (test/oracle.ts EXPECTED_FUNCTION_COUNT) and the per-file split of legacy/README.md. */
export const EXPECTED_LEGACY_TOTAL = 379;
export const EXPECTED_PER_FILE: Readonly<Record<string, number>> = {
  'fullStockAnalysisV10_9.gs': 146,
  'dataLayerV1.gs': 61,
  'brokerCourseModelV1.gs': 72,
  'futuresStockAnalysisV3_3_11.gs': 35,
  'turtleModelV1.gs': 14,
  'darkPoolTrackerV1.gs': 17,
  'schabackerModelV1.gs': 10,
  'edwardsMageeModelV1.gs': 11,
  'macro_fetchers_v0_15.gs': 7,
  'myOptionsValueTracker.gs': 6,
};

const STATUS_ORDER: readonly ParityStatus[] = ['tested', 'ported', 'mapped', 'waived', 'unported'];

function emptyCounts(): Record<ParityStatus, number> {
  return { tested: 0, ported: 0, mapped: 0, waived: 0, unported: 0 };
}

const baseName = (p: string): string => p.split('/').pop() ?? p;

// ---- legacy side ---------------------------------------------------------------------

/** Top-level `function NAME(` declarations (column 0 only: the 44 indented helpers are nested, not oracle functions). */
export function extractLegacyFunctions(file: string, text: string): LegacyFunction[] {
  const out: LegacyFunction[] = [];
  const re = /^function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gm;
  for (const m of text.matchAll(re)) {
    const line = text.slice(0, m.index).split('\n').length;
    out.push({ name: m[1] as string, file: baseName(file), line });
  }
  return out;
}

// ---- port side -----------------------------------------------------------------------

/** Splits TypeScript text into code (comments blanked) and the removed comment text. A `//` inside a string such as "https://" is kept: it must follow whitespace or start a line. */
export function splitComments(ts: string): { readonly code: string; readonly comments: string } {
  const removed: string[] = [];
  const noBlock = ts.replace(/\/\*[\s\S]*?\*\//g, (m) => { removed.push(m); return m.replace(/[^\n]/g, ' '); });
  const code = noBlock.replace(/(^|\s)\/\/([^\n]*)/g, (_m, pre: string, body: string) => { removed.push(body); return pre; });
  return { code, comments: removed.join('\n') };
}

export function stripComments(ts: string): string {
  return splitComments(ts).code;
}

/** Names a port may use for a legacy function: exact first, then without the version suffix (V7, V1_, a trailing underscore). */
export function candidateSymbols(name: string): string[] {
  const out = [name];
  const stripped = name.replace(/V\d+_?$/, '').replace(/_$/, '');
  if (stripped && stripped !== name) out.push(stripped);
  return out;
}

export interface PortIndex {
  /** symbol -> first src file declaring it */
  readonly declared: ReadonlyMap<string, string>;
  /** names found as a quoted string or a line-start object key -> first src file */
  readonly mapped: ReadonlyMap<string, string>;
  /** declared() plus interfaces, types, enums and class methods; used to check aliases only */
  readonly declaredAny: ReadonlyMap<string, string>;
  /** all comment text, one string (for the 'comment' evidence level) */
  readonly commentText: string;
}

const DECL_RE = /\b(?:function\*?|const|let|var|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
const DECL_ANY_RE = /\b(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
const METHOD_RE = /^[ \t]+(?:(?:public|private|protected|static|readonly|async|override)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>\n]*>)?\(/gm;
const NOT_METHODS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'await', 'typeof', 'new', 'throw', 'super']);
const QUOTED_RE = /['"`]([A-Za-z_$][A-Za-z0-9_$]*)['"`]/g;
const KEY_RE = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:/gm;

export function indexPort(src: readonly SourceText[]): PortIndex {
  const declared = new Map<string, string>();
  const declaredAny = new Map<string, string>();
  const mapped = new Map<string, string>();
  const comments: string[] = [];
  const add = (m: Map<string, string>, k: string, f: string): void => { if (!m.has(k)) m.set(k, f); };
  for (const f of [...src].sort((a, b) => a.path.localeCompare(b.path))) {
    const { code, comments: removed } = splitComments(f.text);
    comments.push(removed);
    for (const m of code.matchAll(DECL_RE)) add(declared, m[1] as string, f.path);
    for (const m of code.matchAll(DECL_ANY_RE)) add(declaredAny, m[1] as string, f.path);
    for (const m of code.matchAll(METHOD_RE)) if (!NOT_METHODS.has(m[1] as string)) add(declaredAny, m[1] as string, f.path);
    for (const m of code.matchAll(QUOTED_RE)) add(mapped, m[1] as string, f.path);
    for (const m of code.matchAll(KEY_RE)) add(mapped, m[1] as string, f.path);
  }
  return { declared, declaredAny, mapped, commentText: comments.join('\n') };
}

function tokensOf(text: string): Set<string> {
  return new Set(text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []);
}

// ---- the gate ------------------------------------------------------------------------

export interface ParityInput {
  readonly legacy: readonly SourceText[];
  readonly src: readonly SourceText[];
  readonly tests: readonly SourceText[];
  readonly waivers: readonly ParityWaiver[];
  readonly aliases?: readonly ParityAlias[];
  readonly expectedTotal?: number;
  readonly expectedPerFile?: Readonly<Record<string, number>>;
}

export function buildParityReport(input: ParityInput): ParityReport {
  const failures: string[] = [];
  const warnings: string[] = [];
  const expectedTotal = input.expectedTotal ?? EXPECTED_LEGACY_TOTAL;
  const expectedPerFile = input.expectedPerFile ?? EXPECTED_PER_FILE;

  const fns: LegacyFunction[] = [];
  for (const f of input.legacy) fns.push(...extractLegacyFunctions(f.path, f.text));
  const seen = new Map<string, LegacyFunction>();
  for (const fn of fns) {
    const prev = seen.get(fn.name);
    if (prev) failures.push('DUPLICATE legacy function ' + fn.name + ' (' + prev.file + ':' + prev.line + ' and ' + fn.file + ':' + fn.line + ')');
    else seen.set(fn.name, fn);
  }
  if (seen.size !== expectedTotal) failures.push('COUNT legacy functions = ' + seen.size + ', expected ' + expectedTotal + ' (the oracle changed?)');
  const perFile: Record<string, number> = {};
  for (const fn of seen.values()) perFile[fn.file] = (perFile[fn.file] ?? 0) + 1;
  for (const [file, want] of Object.entries(expectedPerFile)) {
    if ((perFile[file] ?? 0) !== want) failures.push('COUNT ' + file + ' = ' + (perFile[file] ?? 0) + ', expected ' + want);
  }
  for (const file of Object.keys(perFile)) if (!(file in expectedPerFile)) failures.push('COUNT unexpected legacy file ' + file);

  // Waiver sanity.
  const waiverBy = new Map<string, ParityWaiver>();
  for (const w of input.waivers) {
    if (!w.reason.trim() || !w.ref.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(w.recordedOn)) failures.push('WAIVER ' + w.legacy + ' needs a reason, a ref and a YYYY-MM-DD date');
    if (!seen.has(w.legacy)) failures.push('WAIVER ' + w.legacy + ' is not a legacy function');
    if (waiverBy.has(w.legacy)) failures.push('WAIVER ' + w.legacy + ' is listed twice');
    waiverBy.set(w.legacy, w);
  }

  const aliasBy = new Map<string, ParityAlias>();
  for (const a of input.aliases ?? []) {
    if (!seen.has(a.legacy)) failures.push('ALIAS ' + a.legacy + ' is not a legacy function');
    if (aliasBy.has(a.legacy)) failures.push('ALIAS ' + a.legacy + ' is listed twice');
    if (!a.note.trim()) failures.push('ALIAS ' + a.legacy + ' needs a note');
    aliasBy.set(a.legacy, a);
  }

  const port = indexPort(input.src);
  // Tokenise once: a name is "mentioned" when it is a whole identifier token (so ema never matches emaArray).
  const tokenSets = input.tests.map((t) => tokensOf(t.text));
  const testsMention = (sym: string): number => tokenSets.reduce((n, set) => (set.has(sym) ? n + 1 : n), 0);
  const commentTokens = tokensOf(port.commentText);

  const rows: ParityRow[] = [];
  for (const fn of seen.values()) {
    let evidence: Evidence = 'none';
    let portSymbol: string | null = null;
    let portFile: string | null = null;
    for (const c of candidateSymbols(fn.name)) {
      const f = port.declared.get(c);
      if (f) { evidence = 'declared'; portSymbol = c; portFile = f; break; }
    }
    const alias = aliasBy.get(fn.name);
    if (alias) {
      const f = port.declaredAny.get(alias.symbol);
      if (!f) failures.push('ALIAS ' + fn.name + ' -> ' + alias.symbol + ' is not declared anywhere in src/');
      else if (evidence === 'declared') warnings.push('REDUNDANT ALIAS ' + fn.name + ' is already found by name');
      else { evidence = alias.kind === 'port' ? 'declared' : 'mapped'; portSymbol = alias.symbol; portFile = f }
    }
    if (evidence === 'none') {
      const f = port.mapped.get(fn.name);
      if (f) { evidence = 'mapped'; portSymbol = fn.name; portFile = f; }
      else if (candidateSymbols(fn.name).some((c) => commentTokens.has(c))) evidence = 'comment';
    }
    const testFiles = Math.max(testsMention(fn.name), portSymbol && portSymbol !== fn.name ? testsMention(portSymbol) : 0);
    const waiver = waiverBy.get(fn.name) ?? null;
    let status: ParityStatus;
    if (evidence === 'declared') status = testFiles > 0 ? 'tested' : 'ported';
    else if (evidence === 'mapped') status = 'mapped';
    else if (waiver) status = 'waived';
    else status = 'unported';
    if (status === 'unported') failures.push('UNPORTED ' + fn.name + ' (' + fn.file + ':' + fn.line + ') has no port and no recorded waiver' + (evidence === 'comment' ? ' (named only in comments)' : ''));
    if (waiver && (evidence === 'declared' || evidence === 'mapped')) failures.push('STALE WAIVER ' + fn.name + ' now has a port (' + portFile + '); remove the waiver');
    if (status === 'ported') warnings.push('UNTESTED ' + fn.name + ' is declared in ' + portFile + ' but no test names it');
    rows.push({ legacy: fn.name, file: fn.file, line: fn.line, status, evidence, portSymbol, portFile, testFiles, waiver: waiver ? waiver.reason : null });
  }
  rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  const byStatus = emptyCounts();
  const byFile: Record<string, Record<ParityStatus, number>> = {};
  for (const r of rows) {
    byStatus[r.status]++;
    (byFile[r.file] ??= emptyCounts())[r.status]++;
  }
  return { total: rows.length, expectedTotal, rows, byStatus, byFile, failures, warnings, pass: failures.length === 0 };
}

// ---- rendering -----------------------------------------------------------------------

const cell = (s: string): string => s.replace(/\|/g, '\\|');

export function renderParityTable(report: ParityReport, opts: { readonly full?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push('## Parity gate: ' + (report.pass ? 'PASS' : 'FAIL') + ' (' + report.total + ' of ' + report.expectedTotal + ' legacy functions)');
  lines.push('');
  lines.push('| Status | Count |');
  lines.push('|---|---|');
  for (const s of STATUS_ORDER) lines.push('| ' + s + ' | ' + report.byStatus[s] + ' |');
  lines.push('');
  lines.push('| Legacy file | Total | ' + STATUS_ORDER.join(' | ') + ' |');
  lines.push('|---|---|' + STATUS_ORDER.map(() => '---').join('|') + '|');
  for (const file of Object.keys(report.byFile).sort()) {
    const c = report.byFile[file] as Record<ParityStatus, number>;
    lines.push('| ' + file + ' | ' + STATUS_ORDER.reduce((n, s) => n + c[s], 0) + ' | ' + STATUS_ORDER.map((s) => c[s]).join(' | ') + ' |');
  }
  const shown = opts.full ? report.rows : report.rows.filter((r) => r.status !== 'tested');
  if (shown.length) {
    lines.push('');
    lines.push(opts.full ? '| Legacy function | File:line | Status | Port | Tests |' : '| Not fully tested: legacy function | File:line | Status | Port | Tests |');
    lines.push('|---|---|---|---|---|');
    for (const r of shown) {
      lines.push('| ' + cell(r.legacy) + ' | ' + r.file + ':' + r.line + ' | ' + r.status + ' | ' + (r.portFile ? cell(r.portFile + (r.portSymbol && r.portSymbol !== r.legacy ? ' (' + r.portSymbol + ')' : '')) : (r.waiver ? 'waiver: ' + cell(r.waiver) : '-')) + ' | ' + r.testFiles + ' |');
    }
  }
  if (report.failures.length) {
    lines.push('');
    lines.push('| Failure |');
    lines.push('|---|');
    for (const f of report.failures) lines.push('| ' + cell(f) + ' |');
  }
  return lines.join('\n') + '\n';
}
