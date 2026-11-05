/**
 * FL-9b (2): the parallel-run comparison for Phase 8 (plan sections 6 and 7, item 53: at least 2 weeks of nights,
 * covering a weekend and an earnings event). Compares, per night, what the legacy Apps Script wrote with what the
 * Node backend wrote, cell by cell, and judges the whole run against the Phase 8 criteria.
 *
 * PURE. Every function takes injected snapshots (plain objects) and returns plain data. Nothing here reads a sheet,
 * a file or the network; src/verify/cli.ts loads private local exports and hands them in.
 *
 * COMPARISON RULES (the same text is printed in every report, COMPARISON_RULES):
 *   - Exact equality is the default. Default tolerance is 0 (plan 3.3: no blanket tolerance).
 *   - A blank cell is null, undefined, "" or only whitespace. Two blanks are not counted.
 *   - Text: compared exactly after trimming trailing whitespace, CRLF -> LF and Unicode NFC.
 *   - Numbers are compared as numbers; a number against a text that looks like a number is a DIFF (that is a real
 *     coercion difference). NaN equals NaN.
 *   - Dates are compared as instants (ISO string); a date against a number is a DIFF.
 *   - A tolerance, an ignore or an approved difference exists ONLY as a rule in the config, each with a reason, and
 *     each tolerance/approval with a finding id. Rules that matched nothing are reported (dead rules).
 *   - Every night's counts show how many cells were ignored/tolerated/approved, so a rule can never hide silently.
 */

export type CellValue = string | number | boolean | Date | null | undefined;
export type Grid = ReadonlyArray<ReadonlyArray<CellValue>>;

export const DECISION_FIELDS = ['finalConviction', 'action', 'fundBand', 'timing', 'regime'] as const;
export type DecisionField = (typeof DECISION_FIELDS)[number];
export type DecisionTuple = Partial<Record<DecisionField, unknown>>;

export interface NightSnapshot {
  /** The date label of the night, YYYY-MM-DD (the UTC day the nightly cron fired). */
  readonly date: string;
  /** tab name -> used range values, row 1 first. */
  readonly tabs: Readonly<Record<string, Grid>>;
  /** ticker -> the five headline fields (plan 3.4). Optional: absent means "not supplied", not "all match". */
  readonly decisions?: Readonly<Record<string, DecisionTuple>>;
}

export interface NightPair {
  readonly date: string;
  readonly legacy: NightSnapshot | null;
  readonly backend: NightSnapshot | null;
}

/** 1-based inclusive ranges, as in Sheets. A missing bound means open-ended. */
export interface Area {
  readonly rowFrom?: number;
  readonly rowTo?: number;
  readonly colFrom?: number;
  readonly colTo?: number;
}

export interface IgnoreRule extends Area {
  /** Legacy tab name the rule applies to ('*' = every tab). */
  readonly tab: string;
  /** Only cells whose text (either side) matches this regular expression source. */
  readonly textMatches?: string;
  readonly reason: string;
}
export interface ToleranceRule extends Area {
  readonly tab: string;
  /** Absolute difference allowed. */
  readonly abs?: number;
  /** Relative difference allowed, as a fraction of the larger magnitude. */
  readonly rel?: number;
  readonly reason: string;
  /** The finding that explains and justifies this tolerance. Required. */
  readonly finding: string;
}
export interface ApprovedDiff extends Area {
  readonly tab: string;
  readonly finding: string;
  readonly reason: string;
}
export interface ApprovedDecision {
  readonly ticker: string;
  readonly field: DecisionField;
  readonly finding: string;
  readonly reason: string;
}

export interface CompareConfig {
  /** legacy tab name -> backend tab name, for renamed tabs. Unlisted tabs keep their name. */
  readonly tabMap?: Readonly<Record<string, string>>;
  /** Tabs that exist only in legacy on purpose (retired by the Buy/Exit pivot). Not an error. */
  readonly retiredTabs?: readonly string[];
  /** Tabs that exist only in the backend on purpose. Not an error. */
  readonly backendOnlyTabs?: readonly string[];
  /** legacy tab name -> 1-based column holding a unique row key; rows are then matched by key, not position. */
  readonly keyColumns?: Readonly<Record<string, number>>;
  readonly ignore?: readonly IgnoreRule[];
  readonly tolerances?: readonly ToleranceRule[];
  readonly approved?: readonly ApprovedDiff[];
  readonly approvedDecisions?: readonly ApprovedDecision[];
}

export const COMPARISON_RULES: ReadonlyArray<readonly [string, string]> = [
  ['Default', 'Exact equality. Default numeric tolerance is 0.'],
  ['Blank', 'null, undefined, empty or whitespace-only. Two blanks are not counted.'],
  ['Text', 'Exact after trimming trailing spaces, CRLF to LF, Unicode NFC.'],
  ['Number vs text', 'A number against numeric-looking text is a difference (a real coercion difference).'],
  ['Dates', 'Compared as instants. A date against a number is a difference.'],
  ['Tolerance', 'Only from a config rule, with a reason and a finding id. Used cells are counted every night.'],
  ['Ignore', 'Only from a config rule, with a reason (for example a run timestamp). Ignored cells are counted every night.'],
  ['Approved', 'Only from a config rule naming the finding that explains the difference (for example a deliberate fix).'],
  ['Headline', 'finalConviction, action, fundBand, timing and regime must match exactly for every ticker.'],
];

// ---- cells ----------------------------------------------------------------------------

export function colLetter(col: number): string {
  let n = col;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const isDate = (v: unknown): v is Date => Object.prototype.toString.call(v) === '[object Date]';

type Norm = { readonly k: 'blank' } | { readonly k: 'num'; readonly v: number } | { readonly k: 'str'; readonly v: string } | { readonly k: 'bool'; readonly v: boolean } | { readonly k: 'date'; readonly v: string };

export function normalizeCell(v: CellValue): Norm {
  if (v === null || v === undefined) return { k: 'blank' };
  if (isDate(v)) return Number.isNaN(v.getTime()) ? { k: 'blank' } : { k: 'date', v: v.toISOString() };
  if (typeof v === 'number') return { k: 'num', v };
  if (typeof v === 'boolean') return { k: 'bool', v };
  const s = String(v).replace(/\r\n?/g, '\n').normalize('NFC').replace(/\s+$/, '');
  return s.trim() === '' ? { k: 'blank' } : { k: 'str', v: s };
}

const text = (n: Norm): string => (n.k === 'blank' ? '' : String(n.v));

function sameNorm(a: Norm, b: Norm): boolean {
  if (a.k !== b.k) return false;
  if (a.k === 'blank') return true;
  if (a.k === 'num' && b.k === 'num') return a.v === b.v || (Number.isNaN(a.v) && Number.isNaN(b.v));
  return (a as { v: unknown }).v === (b as { v: unknown }).v;
}

function inArea(a: Area, row: number, col: number): boolean {
  return (a.rowFrom === undefined || row >= a.rowFrom) && (a.rowTo === undefined || row <= a.rowTo)
    && (a.colFrom === undefined || col >= a.colFrom) && (a.colTo === undefined || col <= a.colTo);
}
const tabMatches = (ruleTab: string, tab: string): boolean => ruleTab === '*' || ruleTab === tab;

export function validateConfig(cfg: CompareConfig): string[] {
  const problems: string[] = [];
  (cfg.ignore ?? []).forEach((r, i) => { if (!r.reason.trim()) problems.push('ignore rule ' + (i + 1) + ' has no reason'); if (r.textMatches) { try { new RegExp(r.textMatches); } catch { problems.push('ignore rule ' + (i + 1) + ' has an invalid pattern'); } } });
  (cfg.tolerances ?? []).forEach((r, i) => {
    if (!r.reason.trim() || !r.finding.trim()) problems.push('tolerance rule ' + (i + 1) + ' needs a reason and a finding id');
    if ((r.abs === undefined || r.abs <= 0) && (r.rel === undefined || r.rel <= 0)) problems.push('tolerance rule ' + (i + 1) + ' allows nothing (abs and rel are empty)');
    if (r.tab === '*') problems.push('tolerance rule ' + (i + 1) + ' is a blanket tolerance (tab "*"), which the plan forbids');
  });
  (cfg.approved ?? []).forEach((r, i) => { if (!r.reason.trim() || !r.finding.trim()) problems.push('approved rule ' + (i + 1) + ' needs a reason and a finding id'); });
  (cfg.approvedDecisions ?? []).forEach((r, i) => { if (!r.reason.trim() || !r.finding.trim()) problems.push('approved decision ' + (i + 1) + ' needs a reason and a finding id'); });
  return problems;
}

// ---- cell classification ----------------------------------------------------------------

export type CellKind = 'same' | 'tolerated' | 'ignored' | 'approved' | 'only_legacy' | 'only_backend' | 'diff';

export interface CellDiff {
  readonly tab: string;
  /** For example "B12", or "key=AAPL C3" when rows are matched by key. */
  readonly address: string;
  readonly kind: Exclude<CellKind, 'same'>;
  readonly legacy: CellValue;
  readonly backend: CellValue;
  /** Finding id for tolerated/approved cells. */
  readonly finding?: string;
}

export interface Counts {
  same: number; tolerated: number; ignored: number; approved: number; only_legacy: number; only_backend: number; diff: number;
}
const zero = (): Counts => ({ same: 0, tolerated: 0, ignored: 0, approved: 0, only_legacy: 0, only_backend: 0, diff: 0 });
const total = (c: Counts): number => c.same + c.tolerated + c.ignored + c.approved + c.only_legacy + c.only_backend + c.diff;

/** Rule usage, so dead rules (matched nothing all run) can be reported. */
export interface RuleUse { readonly ignore: number[]; readonly tolerances: number[]; readonly approved: number[] }

function classify(cfg: CompareConfig, use: RuleUse, tab: string, row: number, col: number, lv: CellValue, bv: CellValue): { kind: CellKind | 'skip'; finding?: string } {
  const a = normalizeCell(lv);
  const b = normalizeCell(bv);
  if (a.k === 'blank' && b.k === 'blank') return { kind: 'skip' };
  const ig = cfg.ignore ?? [];
  for (let i = 0; i < ig.length; i++) {
    const r = ig[i] as IgnoreRule;
    if (!tabMatches(r.tab, tab) || !inArea(r, row, col)) continue;
    if (r.textMatches) { const re = new RegExp(r.textMatches); if (!re.test(text(a)) && !re.test(text(b))) continue; }
    use.ignore[i] = (use.ignore[i] ?? 0) + 1;
    return { kind: 'ignored' };
  }
  if (sameNorm(a, b)) return { kind: 'same' };
  if (a.k === 'num' && b.k === 'num') {
    const tl = cfg.tolerances ?? [];
    for (let i = 0; i < tl.length; i++) {
      const r = tl[i] as ToleranceRule;
      if (!tabMatches(r.tab, tab) || !inArea(r, row, col)) continue;
      const d = Math.abs(a.v - b.v);
      const mag = Math.max(Math.abs(a.v), Math.abs(b.v));
      if ((r.abs !== undefined && d <= r.abs) || (r.rel !== undefined && d <= r.rel * mag)) {
        use.tolerances[i] = (use.tolerances[i] ?? 0) + 1;
        return { kind: 'tolerated', finding: r.finding };
      }
    }
  }
  const ap = cfg.approved ?? [];
  for (let i = 0; i < ap.length; i++) {
    const r = ap[i] as ApprovedDiff;
    if (!tabMatches(r.tab, tab) || !inArea(r, row, col)) continue;
    use.approved[i] = (use.approved[i] ?? 0) + 1;
    return { kind: 'approved', finding: r.finding };
  }
  if (b.k === 'blank') return { kind: 'only_legacy' };
  if (a.k === 'blank') return { kind: 'only_backend' };
  return { kind: 'diff' };
}

// ---- one tab ----------------------------------------------------------------------------

export interface TabResult {
  readonly tab: string;
  readonly backendTab: string;
  readonly counts: Counts;
  readonly diffs: readonly CellDiff[];
  /** Rows matched by key: keys present on one side only. */
  readonly keyNotes: readonly string[];
}

function keyedRows(grid: Grid, keyCol: number): { map: Map<string, number>; dups: string[] } {
  const map = new Map<string, number>();
  const dups: string[] = [];
  for (let r = 0; r < grid.length; r++) {
    const k = text(normalizeCell((grid[r] ?? [])[keyCol - 1]));
    if (!k) continue;
    if (map.has(k)) { dups.push(k); continue; }
    map.set(k, r);
  }
  return { map, dups };
}

export function compareGrids(tab: string, backendTab: string, legacy: Grid, backend: Grid, cfg: CompareConfig, use: RuleUse): TabResult {
  const counts = zero();
  const diffs: CellDiff[] = [];
  const keyNotes: string[] = [];
  const emit = (row: number, col: number, label: string, lv: CellValue, bv: CellValue): void => {
    const c = classify(cfg, use, tab, row, col, lv, bv);
    if (c.kind === 'skip') return;
    counts[c.kind]++;
    if (c.kind !== 'same') diffs.push({ tab, address: label, kind: c.kind, legacy: lv, backend: bv, ...(c.finding ? { finding: c.finding } : {}) });
  };
  const width = (g: Grid): number => g.reduce((m, r) => Math.max(m, r.length), 0);
  const cols = Math.max(width(legacy), width(backend));
  const keyCol = cfg.keyColumns?.[tab];

  if (keyCol === undefined) {
    const rows = Math.max(legacy.length, backend.length);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) emit(r + 1, c + 1, colLetter(c + 1) + (r + 1), (legacy[r] ?? [])[c], (backend[r] ?? [])[c]);
    }
  } else {
    const L = keyedRows(legacy, keyCol);
    const B = keyedRows(backend, keyCol);
    for (const k of L.dups) keyNotes.push('duplicate key on the legacy side: ' + k + ' (first row used)');
    for (const k of B.dups) keyNotes.push('duplicate key on the backend side: ' + k + ' (first row used)');
    // Rows without a usable key (headers, blanks, repeated keys) are compared by position. A keyed row on one side
    // against a keyless row on the other is reported as present on one side only.
    const rows = Math.max(legacy.length, backend.length);
    for (let r = 0; r < rows; r++) {
      const lKeyed = L.map.get(text(normalizeCell((legacy[r] ?? [])[keyCol - 1]))) === r;
      const bKeyed = B.map.get(text(normalizeCell((backend[r] ?? [])[keyCol - 1]))) === r;
      if (lKeyed && bKeyed) continue;
      for (let c = 0; c < cols; c++) {
        const lv = lKeyed ? undefined : (legacy[r] ?? [])[c];
        const bv = bKeyed ? undefined : (backend[r] ?? [])[c];
        emit(r + 1, c + 1, colLetter(c + 1) + (r + 1), lv, bv);
      }
    }
    for (const [k, lr] of L.map) {
      const br = B.map.get(k);
      if (br === undefined) {
        keyNotes.push('key only in legacy: ' + k);
        for (let c = 0; c < cols; c++) emit(lr + 1, c + 1, 'key=' + k + ' ' + colLetter(c + 1), (legacy[lr] ?? [])[c], undefined);
      } else {
        for (let c = 0; c < cols; c++) emit(lr + 1, c + 1, 'key=' + k + ' ' + colLetter(c + 1), (legacy[lr] ?? [])[c], (backend[br] ?? [])[c]);
      }
    }
    for (const [k, br] of B.map) {
      if (L.map.has(k)) continue;
      keyNotes.push('key only in backend: ' + k);
      for (let c = 0; c < cols; c++) emit(br + 1, c + 1, 'key=' + k + ' ' + colLetter(c + 1), undefined, (backend[br] ?? [])[c]);
    }
  }
  return { tab, backendTab, counts, diffs, keyNotes };
}

// ---- decisions (the headline: "N of M tickers match exactly") ---------------------------------

export interface DecisionMismatch {
  readonly ticker: string;
  readonly field: DecisionField | 'presence';
  readonly legacy: unknown;
  readonly backend: unknown;
  readonly approvedBy?: string;
}
export interface DecisionResult {
  readonly total: number;
  /** Tickers whose five fields all match (or whose only differences are approved). */
  readonly matched: number;
  readonly mismatches: readonly DecisionMismatch[];
}

const sameValue = (a: unknown, b: unknown): boolean => a === b || (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b));

export function compareDecisions(legacy: Readonly<Record<string, DecisionTuple>>, backend: Readonly<Record<string, DecisionTuple>>, approved: readonly ApprovedDecision[] = []): DecisionResult {
  const tickers = [...new Set([...Object.keys(legacy), ...Object.keys(backend)])].sort();
  const mismatches: DecisionMismatch[] = [];
  let matched = 0;
  for (const t of tickers) {
    const l = legacy[t];
    const b = backend[t];
    if (!l || !b) { mismatches.push({ ticker: t, field: 'presence', legacy: l ? 'present' : 'missing', backend: b ? 'present' : 'missing' }); continue; }
    let bad = 0;
    for (const f of DECISION_FIELDS) {
      if (sameValue(l[f], b[f])) continue;
      const ap = approved.find((a) => a.ticker === t && a.field === f);
      mismatches.push({ ticker: t, field: f, legacy: l[f], backend: b[f], ...(ap ? { approvedBy: ap.finding } : {}) });
      if (!ap) bad++;
    }
    if (bad === 0) matched++;
  }
  return { total: tickers.length, matched, mismatches };
}

// ---- one night ----------------------------------------------------------------------------

export type NightVerdict = 'MATCH' | 'MATCH_WITH_APPROVED' | 'DIFF' | 'MISSING_SNAPSHOT';

export interface NightResult {
  readonly date: string;
  readonly verdict: NightVerdict;
  readonly tabs: readonly TabResult[];
  readonly counts: Counts;
  readonly tabsCompared: number;
  /** Tabs missing on one side that are not declared retired / backend-only. */
  readonly tabIssues: readonly string[];
  readonly retiredSeen: readonly string[];
  readonly decisions: DecisionResult | null;
  readonly note: string;
}

export function emptyRuleUse(): RuleUse { return { ignore: [], tolerances: [], approved: [] }; }

export function compareNight(pair: NightPair, cfg: CompareConfig = {}, use: RuleUse = emptyRuleUse()): NightResult {
  const problems = validateConfig(cfg);
  if (problems.length) throw new Error('Invalid comparison config: ' + problems.join('; '));
  if (!pair.legacy || !pair.backend) {
    return { date: pair.date, verdict: 'MISSING_SNAPSHOT', tabs: [], counts: zero(), tabsCompared: 0, tabIssues: [], retiredSeen: [], decisions: null, note: (pair.legacy ? '' : 'legacy snapshot missing. ') + (pair.backend ? '' : 'backend snapshot missing.') };
  }
  const tabMap = cfg.tabMap ?? {};
  const retired = new Set(cfg.retiredTabs ?? []);
  const backendOnly = new Set(cfg.backendOnlyTabs ?? []);
  const tabResults: TabResult[] = [];
  const tabIssues: string[] = [];
  const retiredSeen: string[] = [];
  const usedBackend = new Set<string>();

  for (const tab of Object.keys(pair.legacy.tabs).sort()) {
    const bt = tabMap[tab] ?? tab;
    const bg = pair.backend.tabs[bt];
    if (!bg) {
      if (retired.has(tab)) retiredSeen.push(tab);
      else tabIssues.push('tab "' + tab + '" exists in legacy but not in the backend output' + (bt !== tab ? ' (looked for "' + bt + '")' : ''));
      continue;
    }
    usedBackend.add(bt);
    tabResults.push(compareGrids(tab, bt, pair.legacy.tabs[tab] as Grid, bg, cfg, use));
  }
  for (const bt of Object.keys(pair.backend.tabs).sort()) {
    if (usedBackend.has(bt) || backendOnly.has(bt)) continue;
    tabIssues.push('tab "' + bt + '" exists in the backend output but not in legacy');
  }

  const counts = zero();
  for (const t of tabResults) for (const k of Object.keys(counts) as Array<keyof Counts>) counts[k] += t.counts[k];

  let decisions: DecisionResult | null = null;
  if (pair.legacy.decisions && pair.backend.decisions) decisions = compareDecisions(pair.legacy.decisions, pair.backend.decisions, cfg.approvedDecisions ?? []);

  const decisionBad = decisions ? decisions.mismatches.some((m) => !m.approvedBy) : false;
  const decisionApproved = decisions ? decisions.mismatches.some((m) => m.approvedBy) : false;
  const bad = counts.diff + counts.only_legacy + counts.only_backend;
  let verdict: NightVerdict;
  if (bad > 0 || tabIssues.length > 0 || decisionBad) verdict = 'DIFF';
  else if (counts.approved > 0 || decisionApproved) verdict = 'MATCH_WITH_APPROVED';
  else verdict = 'MATCH';
  const note = (pair.legacy.decisions && pair.backend.decisions) ? '' : 'headline decisions not supplied for this night';
  return { date: pair.date, verdict, tabs: tabResults, counts, tabsCompared: tabResults.length, tabIssues, retiredSeen, decisions, note };
}

/** Rules that matched no cell in the whole run: dead or mistyped. */
export function deadRules(cfg: CompareConfig, use: RuleUse): string[] {
  const out: string[] = [];
  (cfg.ignore ?? []).forEach((r, i) => { if (!use.ignore[i]) out.push('ignore rule ' + (i + 1) + ' (' + r.tab + ': ' + r.reason + ') matched no cell'); });
  (cfg.tolerances ?? []).forEach((r, i) => { if (!use.tolerances[i]) out.push('tolerance rule ' + (i + 1) + ' (' + r.tab + ', ' + r.finding + ') matched no cell'); });
  (cfg.approved ?? []).forEach((r, i) => { if (!use.approved[i]) out.push('approved rule ' + (i + 1) + ' (' + r.tab + ', ' + r.finding + ') matched no cell'); });
  return out;
}

// ---- the whole run ---------------------------------------------------------------------------

export interface RunFacts {
  /** US earnings dates (YYYY-MM-DD) for held and watchlist tickers during the window. */
  readonly earningsDates: readonly string[];
  /** The date a rollback to the Apps Script triggers was rehearsed, or null. */
  readonly rollbackTestedOn: string | null;
  /** The date the run was reviewed with the user, or null. */
  readonly reviewedWithUserOn: string | null;
}

export interface RunCriteria {
  readonly minNights: number;
  readonly requireSaturdayAndSunday: boolean;
  readonly requireEarningsEvent: boolean;
  readonly requireRollbackTest: boolean;
  readonly requireUserReview: boolean;
}
export const PHASE8_CRITERIA: RunCriteria = { minNights: 14, requireSaturdayAndSunday: true, requireEarningsEvent: true, requireRollbackTest: true, requireUserReview: true };

export interface RunCheck { readonly id: string; readonly label: string; readonly pass: boolean; readonly detail: string }
export interface RunEvaluation {
  readonly verdict: 'GO' | 'NO-GO';
  readonly checks: readonly RunCheck[];
  readonly nights: number;
  readonly completeNights: number;
  readonly firstDate: string | null;
  readonly lastDate: string | null;
}

const DAY = 86_400_000;
const dayNumber = (d: string): number => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / DAY;
const weekday = (d: string): number => new Date(dayNumber(d) * DAY).getUTCDay();
const dateOf = (n: number): string => new Date(n * DAY).toISOString().slice(0, 10);
const isIsoDate = (d: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(d);

export function evaluateRun(nights: readonly NightResult[], facts: RunFacts, criteria: RunCriteria = PHASE8_CRITERIA): RunEvaluation {
  const bad = nights.filter((n) => !isIsoDate(n.date));
  const dates = [...new Set(nights.map((n) => n.date))].filter(isIsoDate).sort();
  const complete = nights.filter((n) => n.verdict !== 'MISSING_SNAPSHOT');
  const completeDates = new Set(complete.map((n) => n.date));
  const first = dates[0] ?? null;
  const last = dates[dates.length - 1] ?? null;
  const checks: RunCheck[] = [];

  checks.push({ id: 'dates', label: 'Every night has a valid date', pass: bad.length === 0, detail: bad.length ? bad.length + ' night(s) with an invalid date' : 'ok' });
  checks.push({ id: 'length', label: 'At least ' + criteria.minNights + ' nights with both outputs', pass: completeDates.size >= criteria.minNights, detail: completeDates.size + ' complete night(s)' });

  const gaps: string[] = [];
  if (first && last) for (let d = dayNumber(first); d <= dayNumber(last); d++) if (!completeDates.has(dateOf(d))) gaps.push(dateOf(d));
  checks.push({ id: 'gaps', label: 'No missing night between the first and the last', pass: gaps.length === 0, detail: gaps.length ? 'missing: ' + gaps.slice(0, 10).join(', ') + (gaps.length > 10 ? ' (+' + (gaps.length - 10) + ')' : '') : 'none' });

  const sat = [...completeDates].some((d) => weekday(d) === 6);
  const sun = [...completeDates].some((d) => weekday(d) === 0);
  checks.push({ id: 'weekend', label: 'A Saturday run and a Sunday run are included', pass: !criteria.requireSaturdayAndSunday || (sat && sun), detail: 'Saturday ' + (sat ? 'yes' : 'no') + ', Sunday ' + (sun ? 'yes' : 'no') });

  const earn = facts.earningsDates.filter(isIsoDate);
  const earningsHit = earn.filter((e) => completeDates.has(e) || completeDates.has(dateOf(dayNumber(e) + 1)));
  checks.push({ id: 'earnings', label: 'An earnings event is covered (the night of the date or the next one)', pass: !criteria.requireEarningsEvent || earningsHit.length > 0, detail: earn.length === 0 ? 'no earnings dates supplied' : earningsHit.length + ' of ' + earn.length + ' earnings date(s) covered' });

  const diffNights = complete.filter((n) => n.verdict === 'DIFF');
  checks.push({ id: 'diffs', label: 'Every complete night is MATCH or MATCH_WITH_APPROVED', pass: diffNights.length === 0 && complete.length > 0, detail: diffNights.length ? 'DIFF on ' + diffNights.map((n) => n.date).join(', ') : (complete.length ? 'none' : 'no complete night') });

  const inWindow = (d: string | null): boolean => !!d && isIsoDate(d) && !!first && !!last && d >= first && d <= last;
  checks.push({ id: 'rollback', label: 'A rollback was rehearsed during the run', pass: !criteria.requireRollbackTest || inWindow(facts.rollbackTestedOn), detail: facts.rollbackTestedOn ?? 'not recorded' });
  checks.push({ id: 'review', label: 'The run was reviewed with the user after the last night', pass: !criteria.requireUserReview || (!!facts.reviewedWithUserOn && !!last && facts.reviewedWithUserOn >= last), detail: facts.reviewedWithUserOn ?? 'not recorded' });

  return { verdict: checks.every((c) => c.pass) ? 'GO' : 'NO-GO', checks, nights: dates.length, completeNights: completeDates.size, firstDate: first, lastDate: last };
}

// ---- rendering -------------------------------------------------------------------------------

const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function show(v: CellValue): string {
  if (v === null || v === undefined) return '(blank)';
  if (isDate(v)) return v.toISOString();
  return String(v).slice(0, 60);
}

export interface RenderOptions {
  /** Print the cell values of differences. Default false: addresses and kinds only, so a report never copies sheet content. */
  readonly showValues?: boolean;
  /** At most this many difference rows per night. */
  readonly maxDiffRows?: number;
}

export function renderNightTable(nights: readonly NightResult[]): string {
  const lines = ['| Date | Tabs | Cells | Same | Tolerated | Ignored | Approved | Only legacy | Only backend | Diff | Tickers matching | Verdict |', '|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const n of [...nights].sort((a, b) => a.date.localeCompare(b.date))) {
    const c = n.counts;
    const d = n.decisions ? n.decisions.matched + ' of ' + n.decisions.total : 'n/a';
    lines.push('| ' + [n.date, n.tabsCompared, total(c), c.same, c.tolerated, c.ignored, c.approved, c.only_legacy, c.only_backend, c.diff, d, n.verdict].join(' | ') + ' |');
  }
  return lines.join('\n');
}

export function renderRunReport(nights: readonly NightResult[], evaluation: RunEvaluation, cfg: CompareConfig, use: RuleUse, opts: RenderOptions = {}): string {
  const out: string[] = [];
  out.push('## Parallel run: ' + evaluation.verdict + ' (' + evaluation.completeNights + ' complete night(s), ' + (evaluation.firstDate ?? '-') + ' to ' + (evaluation.lastDate ?? '-') + ')');
  out.push('', '| Check | Result | Detail |', '|---|---|---|');
  for (const c of evaluation.checks) out.push('| ' + esc(c.label) + ' | ' + (c.pass ? 'pass' : 'FAIL') + ' | ' + esc(c.detail) + ' |');
  out.push('', '### Per night', '', renderNightTable(nights));
  out.push('', '### Rules in force', '', '| Rule | Meaning |', '|---|---|');
  for (const [k, v] of COMPARISON_RULES) out.push('| ' + k + ' | ' + esc(v) + ' |');
  for (const r of cfg.tolerances ?? []) out.push('| Tolerance (' + esc(r.tab) + ', ' + esc(r.finding) + ') | abs ' + (r.abs ?? '-') + ', rel ' + (r.rel ?? '-') + ': ' + esc(r.reason) + ' |');
  for (const r of cfg.ignore ?? []) out.push('| Ignore (' + esc(r.tab) + ') | ' + esc(r.reason) + ' |');
  for (const r of cfg.approved ?? []) out.push('| Approved (' + esc(r.tab) + ', ' + esc(r.finding) + ') | ' + esc(r.reason) + ' |');
  for (const d of deadRules(cfg, use)) out.push('| Dead rule | ' + esc(d) + ' |');

  const max = opts.maxDiffRows ?? 25;
  for (const n of [...nights].sort((a, b) => a.date.localeCompare(b.date))) {
    const rows = n.tabs.flatMap((t) => t.diffs);
    const issues = n.tabIssues.length + (n.decisions ? n.decisions.mismatches.length : 0) + rows.length + (n.verdict === 'MISSING_SNAPSHOT' ? 1 : 0);
    if (issues === 0) continue;
    out.push('', '### ' + n.date + ' (' + n.verdict + ')', '', '| Where | Kind | Detail |', '|---|---|---|');
    if (n.verdict === 'MISSING_SNAPSHOT') out.push('| night | MISSING_SNAPSHOT | ' + esc(n.note) + ' |');
    for (const t of n.tabIssues) out.push('| tab | TAB | ' + esc(t) + ' |');
    for (const m of n.decisions?.mismatches ?? []) out.push('| ' + esc(m.ticker) + ' ' + m.field + ' | DECISION' + (m.approvedBy ? ' (approved ' + esc(m.approvedBy) + ')' : '') + ' | ' + (opts.showValues ? 'legacy ' + esc(String(m.legacy)) + ', backend ' + esc(String(m.backend)) : 'differs') + ' |');
    rows.slice(0, max).forEach((d) => out.push('| ' + esc(d.tab) + '!' + esc(d.address) + ' | ' + d.kind.toUpperCase() + (d.finding ? ' (' + esc(d.finding) + ')' : '') + ' | ' + (opts.showValues ? 'legacy ' + esc(show(d.legacy)) + ', backend ' + esc(show(d.backend)) : 'differs') + ' |'));
    if (rows.length > max) out.push('| ... | | ' + (rows.length - max) + ' more difference(s) not listed |');
    for (const t of n.tabs) for (const k of t.keyNotes) out.push('| ' + esc(t.tab) + ' | KEY | ' + esc(k) + ' |');
  }
  return out.join('\n') + '\n';
}
