import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildParityReport, candidateSymbols, extractLegacyFunctions, renderParityTable, splitComments, EXPECTED_PER_FILE } from '../src/verify/parityGate.ts';
import type { ParityInput } from '../src/verify/parityGate.ts';
import { PARITY_ALIASES, PARITY_WAIVERS } from '../src/verify/parityWaivers.ts';
import { assertPrivatePath, LEGACY_DIR, loadCliSubcommands, loadLegacySources, loadPackageScripts, loadPortSources, loadTestSources } from '../src/verify/parityLoad.ts';
import {
  PHASE8_CRITERIA, colLetter, compareDecisions, compareGrids, compareNight, deadRules, emptyRuleUse, evaluateRun, normalizeCell, renderRunReport, validateConfig,
} from '../src/verify/parallelRun.ts';
import type { CompareConfig, DecisionTuple, NightResult, NightSnapshot, RunFacts } from '../src/verify/parallelRun.ts';
import { LEGACY_TRIGGERS, decideRemoval, parseEntry, renderChecklist, resolveMenus } from '../src/verify/triggerChecklist.ts';
import type { ChecklistInputs } from '../src/verify/triggerChecklist.ts';
import { NIGHTLY_ORDER, SEPARATE_JOBS } from '../src/jobs/nightly/steps.ts';
import { LEGACY_MENUS, MENU_ENTRY_POINTS } from '../src/reports/options/ui.ts';
import { DAILY_TRIGGER_HANDLER } from '../src/jobs/automation/schedule.ts';
import { EXIT_STRATEGY_LEGACY_TRIGGER } from '../src/reports/exit/schedule.ts';
import { WORKFLOWS } from '../src/workflows/schedule.ts';
import { main, parallelCommand, runParallel } from '../src/verify/cli.ts';

// ---- 1. parity gate -------------------------------------------------------------------------

const legacy = (body: string): ParityInput['legacy'] => [{ path: 'legacy/a.gs', text: body }];
function gate(over: Partial<ParityInput> & { legacyText: string }) {
  const { legacyText, ...rest } = over;
  return buildParityReport({ legacy: legacy(legacyText), src: [], tests: [], waivers: [], expectedTotal: 3, expectedPerFile: { 'a.gs': 3 }, ...rest });
}
const THREE = 'function alpha() {}\nfunction betaV7(x) {}\nfunction install_gammaTrigger() {\n  function nested() {}\n}\n';
const row = (r: ReturnType<typeof gate>, n: string) => r.rows.find((x) => x.legacy === n)!;

test('real repo: all 379 legacy functions are accounted for; no unported function without a waiver', () => {
  const report = buildParityReport({ legacy: loadLegacySources(), src: loadPortSources(), tests: loadTestSources(), waivers: PARITY_WAIVERS, aliases: PARITY_ALIASES });
  assert.deepEqual([...report.failures], []);
  assert.equal(report.total, 379);
  assert.equal(report.byStatus.unported, 0);
  assert.equal(report.byStatus.tested + report.byStatus.ported + report.byStatus.mapped + report.byStatus.waived, 379);
  for (const [file, n] of Object.entries(EXPECTED_PER_FILE)) {
    const c = report.byFile[file]!;
    assert.equal(c.tested + c.ported + c.mapped + c.waived + c.unported, n, file);
  }
  assert.ok(report.byStatus.tested > 300, 'most functions are named by a test');
  assert.match(renderParityTable(report), /Parity gate: PASS \(379 of 379/);
  assert.equal(extractLegacyFunctions('x.gs', fs.readFileSync(path.join(LEGACY_DIR, 'turtleModelV1.gs'), 'utf8')).length, 14);
});

test('gate fails on a function with no port and no waiver; a waiver turns it into waived', () => {
  const r = gate({ legacyText: THREE, src: [{ path: 'src/a.ts', text: 'export function alpha() {}\nexport const beta = 1;\n' }] });
  assert.equal(row(r, 'alpha').status, 'ported');
  assert.equal(row(r, 'betaV7').evidence, 'declared', 'const beta counts: the version suffix V7 is stripped');
  assert.equal(row(r, 'install_gammaTrigger').status, 'unported');
  assert.equal(r.pass, false);
  assert.match(r.failures.join('\n'), /UNPORTED install_gammaTrigger/);

  const w = gate({ legacyText: THREE, src: [{ path: 'src/a.ts', text: 'export function alpha() {}\nexport function beta() {}\n' }],
    waivers: [{ legacy: 'install_gammaTrigger', reason: 'replaced by a cron line', ref: 'F-W4', recordedOn: '2026-10-24' }] });
  assert.equal(row(w, 'betaV7').status, 'ported', 'betaV7 is found as beta (version suffix stripped)');
  assert.equal(row(w, 'install_gammaTrigger').status, 'waived');
  assert.deepEqual([...w.failures], []);
  assert.equal(w.pass, true);
});

test('waiver rules: needs reason, ref, date; unknown function fails; stale waiver fails', () => {
  const src = [{ path: 'src/a.ts', text: 'export function alpha() {}\nexport function beta() {}\nexport function install_gammaTrigger() {}\n' }];
  const stale = gate({ legacyText: THREE, src, waivers: [{ legacy: 'alpha', reason: 'x', ref: 'F-1', recordedOn: '2026-10-24' }] });
  assert.match(stale.failures.join('\n'), /STALE WAIVER alpha/);
  const unknown = gate({ legacyText: THREE, src, waivers: [{ legacy: 'nope', reason: 'x', ref: 'F-1', recordedOn: '2026-10-24' }] });
  assert.match(unknown.failures.join('\n'), /WAIVER nope is not a legacy function/);
  const bad = gate({ legacyText: THREE, src, waivers: [{ legacy: 'alpha', reason: '', ref: '', recordedOn: 'tomorrow' }] });
  assert.match(bad.failures.join('\n'), /needs a reason, a ref and a YYYY-MM-DD date/);
});

test('evidence levels: a comment is not a port; a quoted mapping is "mapped"; version suffixes are stripped', () => {
  const r = gate({ legacyText: THREE, src: [{ path: 'src/a.ts', text: [
    '// alpha is described here only',
    '/* betaV7 too */',
    "export const TABLE = { 'install_gammaTrigger': 'workflow' };",
  ].join('\n') }] });
  assert.equal(row(r, 'alpha').evidence, 'comment');
  assert.equal(row(r, 'alpha').status, 'unported');
  assert.equal(row(r, 'betaV7').status, 'unported');
  assert.equal(row(r, 'install_gammaTrigger').status, 'mapped');
  assert.deepEqual(candidateSymbols('srLevelsV7'), ['srLevelsV7', 'srLevels']);
  assert.deepEqual(candidateSymbols('turtleSizingV1_'), ['turtleSizingV1_', 'turtleSizing']);
  assert.deepEqual(candidateSymbols('ema'), ['ema']);
  const cs = splitComments('const u = "https://x.test/a"; // tail\n/* block */ const v = 1;');
  assert.ok(cs.code.includes('https://x.test/a'), 'a URL string survives');
  assert.ok(!cs.code.includes('tail') && !cs.code.includes('block'));
});

test('tested needs a test file that names the legacy function or its port symbol; whole identifiers only', () => {
  const src = [{ path: 'src/a.ts', text: 'export function alpha() {}\nexport function beta() {}\nexport function install_gammaTrigger() {}\n' }];
  const tests = [{ path: 'test/a.test.ts', text: "oracle.call('alpha'); import { beta } from '../src/a.ts'; alphabet(); " }];
  const r = gate({ legacyText: THREE, src, tests });
  assert.equal(row(r, 'alpha').status, 'tested');
  assert.equal(row(r, 'betaV7').status, 'tested', 'the port symbol beta appears in a test');
  assert.equal(row(r, 'install_gammaTrigger').status, 'ported');
  assert.match(r.warnings.join('\n'), /UNTESTED install_gammaTrigger/);
});

test('aliases must point at a real declaration; duplicates and a changed total are failures', () => {
  const src = [{ path: 'src/a.ts', text: 'export function alpha() {}\nexport interface Store { read(): void }\nclass K {\n  async fetchAll() {}\n}\n' }];
  const ok = gate({ legacyText: THREE, src, aliases: [
    { legacy: 'betaV7', symbol: 'Store', kind: 'port', note: 'interface' },
    { legacy: 'install_gammaTrigger', symbol: 'fetchAll', kind: 'mapped', note: 'method' },
  ] });
  assert.equal(row(ok, 'betaV7').status, 'ported');
  assert.equal(row(ok, 'install_gammaTrigger').status, 'mapped');
  assert.deepEqual([...ok.failures], []);
  const dead = gate({ legacyText: THREE, src, aliases: [{ legacy: 'betaV7', symbol: 'missing', kind: 'port', note: 'x' }] });
  assert.match(dead.failures.join('\n'), /ALIAS betaV7 -> missing is not declared/);
  const dup = gate({ legacyText: 'function alpha() {}\nfunction alpha() {}\n', src });
  assert.match(dup.failures.join('\n'), /DUPLICATE legacy function alpha/);
  assert.match(dup.failures.join('\n'), /COUNT legacy functions = 1, expected 3/);
});

// ---- 2. parallel run -------------------------------------------------------------------------

const snap = (date: string, tabs: Record<string, unknown[][]>, decisions?: Record<string, DecisionTuple>): NightSnapshot => ({ date, tabs: tabs as unknown as NightSnapshot['tabs'], ...(decisions ? { decisions } : {}) });
const night = (date: string, l: Record<string, unknown[][]>, b: Record<string, unknown[][]>, cfg: CompareConfig = {}, ld?: Record<string, DecisionTuple>, bd?: Record<string, DecisionTuple>) =>
  compareNight({ date, legacy: snap(date, l, ld), backend: snap(date, b, bd) }, cfg);

test('cells: identical grids match; blanks are equal; text, numbers, dates, NaN follow the stated rules', () => {
  const same = night('2026-11-02', { 'Exit': [['A', 1, null], ['b ', 2.5, '']] }, { 'Exit': [['A', 1, undefined], ['b', 2.5, '   ']] });
  assert.equal(same.verdict, 'MATCH');
  assert.equal(same.counts.same, 4, 'only the 4 non-blank pairs are counted');
  assert.deepEqual(normalizeCell('x\r\ny  '), { k: 'str', v: 'x\ny' });
  assert.equal(colLetter(1), 'A');
  assert.equal(colLetter(27), 'AA');

  const d = night('2026-11-03', { T: [['x', 1, 2, new Date('2026-01-01T00:00:00Z'), NaN, true]] }, { T: [['y', '1', 2.0000001, new Date('2026-01-02T00:00:00Z'), NaN, true]] });
  assert.equal(d.verdict, 'DIFF');
  assert.equal(d.counts.diff, 4, 'text, number-vs-text, 2 vs 2.0000001 (no default tolerance), date');
  assert.equal(d.counts.same, 2, 'NaN equals NaN, true equals true');
  assert.deepEqual(d.tabs[0]!.diffs.map((x) => x.address), ['A1', 'B1', 'C1', 'D1']);
});

test('one side only: only_legacy and only_backend, and a missing row counts cell by cell', () => {
  const r = night('2026-11-04', { T: [['a', 'b'], ['c', 'd']] }, { T: [['a', 'b']] });
  assert.equal(r.counts.only_legacy, 2);
  assert.equal(r.verdict, 'DIFF');
  const r2 = night('2026-11-04', { T: [['a']] }, { T: [['a', 'extra']] });
  assert.equal(r2.counts.only_backend, 1);
});

test('tolerance: only with a finding; blanket tolerance refused; used cells are counted; default is exact', () => {
  const l = { T: [[100, 5]] };
  const b = { T: [[100.04, 5.2]] };
  assert.equal(night('2026-11-05', l, b).counts.diff, 2);
  const cfg: CompareConfig = { tolerances: [{ tab: 'T', colFrom: 1, colTo: 1, abs: 0.05, reason: 'rounding in the sheet format', finding: 'F-47' }] };
  const r = night('2026-11-05', l, b, cfg);
  assert.equal(r.counts.tolerated, 1);
  assert.equal(r.counts.diff, 1);
  assert.equal(r.tabs[0]!.diffs.find((d) => d.kind === 'tolerated')!.finding, 'F-47');
  assert.equal(validateConfig({ tolerances: [{ tab: '*', abs: 1, reason: 'x', finding: 'F-1' }] }).length, 1);
  assert.equal(validateConfig({ tolerances: [{ tab: 'T', abs: 1, reason: '', finding: '' }] }).length, 1);
  assert.equal(validateConfig({ tolerances: [{ tab: 'T', reason: 'x', finding: 'F-1' }] }).length, 1);
  assert.throws(() => night('2026-11-05', l, b, { tolerances: [{ tab: '*', abs: 1, reason: 'x', finding: 'F-1' }] }), /blanket tolerance/);
  const rel = night('2026-11-05', { T: [[1000]] }, { T: [[1001]] }, { tolerances: [{ tab: 'T', rel: 0.002, reason: 'r', finding: 'F-1' }] });
  assert.equal(rel.counts.tolerated, 1);
});

test('ignore and approved rules: counted every night, verdict MATCH_WITH_APPROVED, dead rules reported', () => {
  const cfg: CompareConfig = {
    ignore: [{ tab: 'T', textMatches: '^Generated ', reason: 'run timestamp' }, { tab: 'Nope', reason: 'never matches' }],
    approved: [{ tab: 'T', rowFrom: 2, rowTo: 2, finding: 'F-30', reason: 'fixed freshness rule' }],
  };
  const use = emptyRuleUse();
  const r = compareNight({ date: '2026-11-06', legacy: snap('2026-11-06', { T: [['Generated 03:00', 'x'], ['AAPL', 'HOLD']] }), backend: snap('2026-11-06', { T: [['Generated 03:07', 'x'], ['AAPL', 'BUY']] }) }, cfg, use);
  assert.equal(r.counts.ignored, 1);
  assert.equal(r.counts.approved, 1);
  assert.equal(r.counts.diff, 0);
  assert.equal(r.verdict, 'MATCH_WITH_APPROVED');
  assert.deepEqual(deadRules(cfg, use), ['ignore rule 2 (Nope: never matches) matched no cell']);
});

test('tabs: renamed, retired and backend-only tabs are declared; anything else is a DIFF', () => {
  const l = { 'Old name': [['a']], 'Retired tab': [['z']], Same: [['q']] };
  const b = { 'New name': [['a']], Same: [['q']], 'Extra': [['e']] };
  const bad = night('2026-11-07', l, b, { tabMap: { 'Old name': 'New name' } });
  assert.equal(bad.verdict, 'DIFF');
  assert.equal(bad.tabIssues.length, 2);
  const ok = night('2026-11-07', l, b, { tabMap: { 'Old name': 'New name' }, retiredTabs: ['Retired tab'], backendOnlyTabs: ['Extra'] });
  assert.equal(ok.verdict, 'MATCH');
  assert.deepEqual(ok.retiredSeen, ['Retired tab']);
  assert.equal(ok.tabsCompared, 2);
});

test('rows matched by key survive reordering; keys on one side only are reported', () => {
  const cfg: CompareConfig = { keyColumns: { T: 1 } };
  const l = { T: [['Ticker', 'Score'], ['AAPL', 1], ['MSFT', 2], ['ONLYL', 3]] };
  const b = { T: [['Ticker', 'Score'], ['MSFT', 2], ['AAPL', 1], ['ONLYB', 4]] };
  const r = night('2026-11-08', l, b, cfg);
  assert.equal(r.counts.same, 6, 'header 2 + AAPL 2 + MSFT 2');
  assert.equal(r.counts.only_legacy, 2);
  assert.equal(r.counts.only_backend, 2);
  assert.deepEqual([...r.tabs[0]!.keyNotes].sort(), ['key only in backend: ONLYB', 'key only in legacy: ONLYL']);
  const t = compareGrids('T', 'T', [['K', 'v'], ['A', 1], ['A', 2]], [['K', 'v'], ['A', 1]], cfg, emptyRuleUse());
  assert.match(t.keyNotes.join(), /duplicate key on the legacy side: A/);
});

test('headline decisions: "N of M tickers match exactly"; a mismatch is a DIFF unless approved by finding', () => {
  const mk = (n: number): Record<string, DecisionTuple> => Object.fromEntries(Array.from({ length: n }, (_, i) => ['T' + i, { finalConviction: 50 + i, action: 'HOLD', fundBand: 'B', timing: 'WAIT', regime: 'UP' }]));
  const L = mk(33);
  const same = compareDecisions(L, mk(33));
  assert.deepEqual([same.matched, same.total, same.mismatches.length], [33, 33, 0]);
  const B = mk(33);
  B['T5'] = { ...B['T5'], action: 'BUY' };
  delete B['T7'];
  const diff = compareDecisions(L, B);
  assert.deepEqual([diff.matched, diff.total], [31, 33]);
  assert.deepEqual(diff.mismatches.map((m) => m.ticker + ':' + m.field), ['T5:action', 'T7:presence']);
  const ap = compareDecisions(L, B, [{ ticker: 'T5', field: 'action', finding: 'F-31', reason: 'split refetch fix' }]);
  assert.equal(ap.matched, 32);
  const n = night('2026-11-09', { T: [['a']] }, { T: [['a']] }, {}, L, B);
  assert.equal(n.verdict, 'DIFF');
  const n2 = night('2026-11-09', { T: [['a']] }, { T: [['a']] }, { approvedDecisions: [{ ticker: 'T5', field: 'action', finding: 'F-31', reason: 'x' }] }, L, { ...L, T5: { ...L['T5'], action: 'BUY' } });
  assert.equal(n2.verdict, 'MATCH_WITH_APPROVED');
  assert.equal(night('2026-11-09', { T: [['a']] }, { T: [['a']] }).decisions, null);
});

function nightsFrom(start: string, count: number, verdict: NightResult['verdict'] = 'MATCH'): NightResult[] {
  const t0 = Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10));
  return Array.from({ length: count }, (_, i) => ({
    date: new Date(t0 + i * 86_400_000).toISOString().slice(0, 10), verdict, tabs: [], tabsCompared: 0, tabIssues: [], retiredSeen: [], decisions: null, note: '',
    counts: { same: 1, tolerated: 0, ignored: 0, approved: 0, only_legacy: 0, only_backend: 0, diff: 0 },
  }));
}
const FACTS: RunFacts = { earningsDates: ['2026-11-12'], rollbackTestedOn: '2026-11-09', reviewedWithUserOn: '2026-11-20' };

test('run verdict: 14 nights incl. Saturday and Sunday, an earnings event, no DIFF, rollback, review -> GO', () => {
  const nights = nightsFrom('2026-11-02', 14); // Mon 2 Nov .. Sun 15 Nov
  const e = evaluateRun(nights, FACTS);
  assert.equal(e.verdict, 'GO', JSON.stringify(e.checks.filter((c) => !c.pass)));
  assert.equal(e.completeNights, 14);
  assert.equal(PHASE8_CRITERIA.minNights, 14);
});

test('run verdict: each criterion can fail on its own', () => {
  const failing = (nights: NightResult[], facts: RunFacts = FACTS): string[] => evaluateRun(nights, facts).checks.filter((c) => !c.pass).map((c) => c.id);
  assert.ok(failing(nightsFrom('2026-11-02', 13)).includes('length'));
  assert.ok(failing(nightsFrom('2026-11-02', 5)).includes('weekend'));
  const gap = nightsFrom('2026-11-02', 14).filter((n) => n.date !== '2026-11-08');
  assert.ok(failing(gap).includes('gaps'));
  assert.ok(failing(nightsFrom('2026-11-02', 14), { ...FACTS, earningsDates: [] }).includes('earnings'));
  assert.ok(failing(nightsFrom('2026-11-02', 14), { ...FACTS, earningsDates: ['2026-12-30'] }).includes('earnings'));
  assert.deepEqual(failing(nightsFrom('2026-11-02', 14), { ...FACTS, earningsDates: ['2026-11-15'] }), [], 'the next night after the date counts');
  assert.ok(failing(nightsFrom('2026-11-02', 14), { ...FACTS, rollbackTestedOn: null }).includes('rollback'));
  assert.ok(failing(nightsFrom('2026-11-02', 14), { ...FACTS, rollbackTestedOn: '2026-10-01' }).includes('rollback'), 'a rehearsal before the window does not count');
  assert.ok(failing(nightsFrom('2026-11-02', 14), { ...FACTS, reviewedWithUserOn: '2026-11-10' }).includes('review'), 'reviewed before the last night');
  const withDiff = nightsFrom('2026-11-02', 14);
  withDiff[3] = { ...withDiff[3]!, verdict: 'DIFF' };
  assert.ok(failing(withDiff).includes('diffs'));
  const missing = nightsFrom('2026-11-02', 14);
  missing[3] = { ...missing[3]!, verdict: 'MISSING_SNAPSHOT' };
  assert.ok(failing(missing).includes('gaps'));
  assert.equal(evaluateRun([], FACTS).verdict, 'NO-GO');
});

test('report: table first; values are hidden unless asked; dead rules and rules in force are listed', () => {
  const cfg: CompareConfig = { ignore: [{ tab: 'Nope', reason: 'never matches' }] };
  const use = emptyRuleUse();
  const r = compareNight({ date: '2026-11-02', legacy: snap('2026-11-02', { T: [['SECRET-LEGACY-VALUE']] }), backend: snap('2026-11-02', { T: [['SECRET-BACKEND-VALUE']] }) }, cfg, use);
  const e = evaluateRun([r], FACTS);
  const plain = renderRunReport([r], e, cfg, use);
  assert.match(plain, /^## Parallel run: NO-GO/);
  assert.match(plain, /\| Date \| Tabs \| Cells \|/);
  assert.match(plain, /\| T!A1 \| DIFF \| differs \|/);
  assert.doesNotMatch(plain, /SECRET/);
  assert.match(plain, /Dead rule/);
  assert.match(plain, /Exact equality/);
  const shown = renderRunReport([r], e, cfg, use, { showValues: true });
  assert.match(shown, /SECRET-LEGACY-VALUE/);
});

// ---- 3. trigger checklist ----------------------------------------------------------------------

function allCommands(): string[] {
  const out = new Set<string>();
  for (const e of Object.values(MENU_ENTRY_POINTS)) for (const c of parseEntry(e.entry).commands) out.add(c);
  return [...out];
}
const GOOD_RUN = evaluateRun(nightsFrom('2026-11-02', 14), FACTS);
function good(over: Partial<ChecklistInputs> = {}): ChecklistInputs {
  return {
    workflowFiles: ['nightly.yml', 'my-options.yml', 'ai-dispatch.yml', 'ci.yml'], availableCommands: allCommands(), run: GOOD_RUN,
    rollbackTestedOn: '2026-11-09', userApprovedRemovalOn: '2026-11-21', openBlockingFindings: [], liveTriggerCountAfterRemoval: null, ...over,
  };
}

test('the 7 legacy triggers: installers sit at the stated lines; handlers match the ported data; steps are in the nightly order', () => {
  assert.equal(LEGACY_TRIGGERS.length, 7);
  for (const t of LEGACY_TRIGGERS) {
    const [file, line] = t.installerAt.split(':') as [string, string];
    const lines = fs.readFileSync(path.join(LEGACY_DIR, file), 'utf8').split('\n');
    assert.match(lines[Number(line) - 1]!, new RegExp('^function ' + t.installer + '\\('), t.id);
    assert.ok(lines.join('\n').includes("'" + t.handler + "'"), t.id + ' handler is a quoted name in its legacy file');
    for (const s of t.steps) assert.ok(NIGHTLY_ORDER.includes(s), s);
    assert.ok(WORKFLOWS.some((w) => w.file === t.workflow && (w.crons.length > 0 || (w.relayCrons ?? []).length > 0)), t.workflow);
  }
  assert.equal(new Set(LEGACY_TRIGGERS.map((t) => t.installer)).size, 7);
  assert.equal(LEGACY_TRIGGERS.find((t) => t.id === 'T5')!.handler, DAILY_TRIGGER_HANDLER);
  assert.equal(LEGACY_TRIGGERS.find((t) => t.id === 'T6')!.handler, EXIT_STRATEGY_LEGACY_TRIGGER.handler);
  assert.equal(LEGACY_TRIGGERS.find((t) => t.id === 'T7')!.handler, SEPARATE_JOBS[0].handler);
  const covered = new Set(LEGACY_TRIGGERS.flatMap((t) => t.steps));
  // buy.report is the Buy report that replaces the retired Watchlist Summary (a new capability, not a legacy trigger)
  const NEW_IN_V13 = new Set(['buy.report', 'paper.trade', 'live.dryRun', 'options.chains', 'options.reads', 'fundamentals.history']);
  for (const s of NIGHTLY_ORDER) assert.ok(covered.has(s) || NEW_IN_V13.has(s), 'nightly step ' + s + ' replaces a legacy trigger');
});

test('entry parsing and menu rows: every legacy menu handler is mapped; a missing command names the similar one', () => {
  assert.deepEqual(parseEntry('cli: options [TICKER] (default TSLA)'), { commands: ['options'], workflow: false });
  assert.deepEqual(parseEntry('workflow: nightly / cli: nightly'), { commands: ['nightly'], workflow: true });
  assert.deepEqual(parseEntry('workflow: nightly cron (schedule set by the workflow generator)'), { commands: [], workflow: true });
  assert.deepEqual(parseEntry('workflow: nightly step + cli: exit-report'), { commands: ['exit-report'], workflow: true });
  const rows = resolveMenus(good());
  const items = LEGACY_MENUS.flatMap((m) => m.items).filter((i) => i !== null);
  assert.equal(rows.length, items.length);
  assert.ok(rows.every((r) => r.status === 'READY'));
  const lacking = resolveMenus(good({ availableCommands: allCommands().filter((c) => c !== 'lock-sheets').concat(['lock-tabs']) }));
  const lock = lacking.find((r) => r.handler === 'lockAllSheets')!;
  assert.equal(lock.status, 'COMMAND_MISSING');
  assert.match(lock.detail, /lock-sheets \(similar existing command: lock-tabs\)/);
  const unmapped = resolveMenus(good({ entries: {} }));
  assert.ok(unmapped.every((r) => r.status === 'UNMAPPED'));
  const noWf = resolveMenus(good({ workflowFiles: [] }));
  assert.ok(noWf.some((r) => r.status === 'WORKFLOW_MISSING'));
});

test('go / no-go: all six gates must pass; each gate fails on its own; the user approval is never assumed', () => {
  const ok = decideRemoval(good());
  assert.equal(ok.removal, 'GO');
  assert.equal(ok.cutover, 'PENDING');
  assert.deepEqual(ok.gates.map((g) => g.id), ['G1', 'G2', 'G3', 'G4', 'G5', 'G6']);
  const failed = (over: Partial<ChecklistInputs>): string[] => decideRemoval(good(over)).gates.filter((g) => !g.pass).map((g) => g.id);
  assert.ok(failed({ workflowFiles: ['ci.yml'] }).includes('G1'));
  assert.deepEqual(failed({ availableCommands: [] }), ['G2']);
  assert.deepEqual(failed({ run: null }), ['G3']);
  assert.deepEqual(failed({ run: evaluateRun(nightsFrom('2026-11-02', 5), FACTS) }), ['G3']);
  assert.deepEqual(failed({ rollbackTestedOn: null }), ['G4']);
  assert.deepEqual(failed({ openBlockingFindings: ['F-L1'] }), ['G5']);
  assert.deepEqual(failed({ userApprovedRemovalOn: null }), ['G6']);
  assert.deepEqual(failed({ userApprovedRemovalOn: 'yes' }), ['G6']);
  assert.equal(decideRemoval(good({ userApprovedRemovalOn: null })).removal, 'NO-GO');
  assert.equal(decideRemoval(good({ userApprovedRemovalOn: null })).cutover, 'NOT-STARTED');
  const six = decideRemoval(good({ triggers: LEGACY_TRIGGERS.slice(0, 6) }));
  assert.equal(six.gates[0]!.pass, false, 'the plan has 7 triggers');
});

test('cutover is DONE only when the live trigger count equals the expected remaining count (default 0)', () => {
  assert.equal(decideRemoval(good({ liveTriggerCountAfterRemoval: 0 })).cutover, 'DONE');
  assert.equal(decideRemoval(good({ liveTriggerCountAfterRemoval: 2 })).cutover, 'FAILED');
  assert.equal(decideRemoval(good({ liveTriggerCountAfterRemoval: 1 })).cutover, 'FAILED', 'one remaining needs a recorded decision');
  assert.equal(decideRemoval(good({ liveTriggerCountAfterRemoval: 1, expectedRemainingTriggers: 1 })).cutover, 'DONE');
  assert.equal(decideRemoval(good({ liveTriggerCountAfterRemoval: 0, userApprovedRemovalOn: null })).cutover, 'NOT-STARTED', 'a zero count means nothing before GO');
});

test('checklist text: 7 delete steps, the count check, rollback steps, the menu table, the shim note', () => {
  const inp = good();
  const text = renderChecklist(decideRemoval(inp), inp);
  assert.match(text, /^## Trigger removal: GO \(cutover PENDING\)/);
  assert.equal((text.match(/delete the trigger for/g) ?? []).length, 7);
  assert.match(text, /Expected: 0\./);
  assert.match(text, /### Rollback/);
  assert.match(text, /### Menu items \(\d+\)/);
  assert.match(text, /F-L1/);
  assert.match(text, /nightly\.yml step darkPool\.tracker \(cron 23 3 \* \* \* UTC, started by the relay\)/);
  const no = renderChecklist(decideRemoval(good({ run: null })), good({ run: null }));
  assert.match(no, /^## Trigger removal: NO-GO/);
  assert.match(no, /G3[^\n]*FAIL[^\n]*no parallel run supplied/);
});

// ---- 4. privacy and the command line -------------------------------------------------------------

test('private exports: a path inside the repository is refused; one outside is accepted', () => {
  assert.throws(() => assertPrivatePath(path.join(LEGACY_DIR, '..', 'src')), /inside the repository/);
  assert.throws(() => assertPrivatePath(LEGACY_DIR), /inside the repository/);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fl9b-'));
  assert.equal(assertPrivatePath(outside), path.resolve(outside));
  fs.rmSync(outside, { recursive: true, force: true });
});

test('command line: parity passes on the real repo; parallel reads private dirs and is NO-GO below 14 nights', () => {
  assert.equal(main(['parity', '--out', path.join(os.tmpdir(), 'fl9b-parity-' + process.pid + '.md')]), 0);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fl9b-run-'));
  const L = path.join(root, 'legacy');
  const B = path.join(root, 'backend');
  fs.mkdirSync(L);
  fs.mkdirSync(B);
  for (const d of ['2026-11-07', '2026-11-08']) {
    fs.writeFileSync(path.join(L, d + '.json'), JSON.stringify({ tabs: { T: [['a', 1]] } }));
    fs.writeFileSync(path.join(B, d + '.json'), JSON.stringify({ tabs: { T: [['a', 1]] } }));
  }
  fs.writeFileSync(path.join(L, '2026-11-09.json'), JSON.stringify({ tabs: { T: [['a', 1]] } }));
  const out = runParallel({ 'legacy-dir': L, 'backend-dir': B, earnings: '2026-11-07', 'rollback-date': '2026-11-08' });
  assert.deepEqual(out.nights.map((n) => n.verdict), ['MATCH', 'MATCH', 'MISSING_SNAPSHOT']);
  assert.equal(out.evaluation.verdict, 'NO-GO');
  const cmd = parallelCommand({ 'legacy-dir': L, 'backend-dir': B });
  assert.equal(cmd.exitCode, 1);
  assert.match(cmd.text, /MISSING_SNAPSHOT/);
  assert.throws(() => runParallel({ 'legacy-dir': LEGACY_DIR, 'backend-dir': B }), /inside the repository/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('package scripts: a script whose target file is missing is not "available"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl9b-pkg-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'here.ts'), '');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { here: 'node --env-file-if-exists=.env src/here.ts', gone: 'node src/gone.ts', test: 'node --test' } }));
  const r = loadPackageScripts(dir);
  assert.deepEqual(r.available.sort(), ['here', 'test']);
  assert.deepEqual(r.missing, ['gone (src/gone.ts)']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cli subcommands are read from the USAGE text of src/cli.ts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl9b-cli-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'cli.ts'), "export const USAGE = [\n  'usage: cli <command> [args]',\n  '  analyze TICKER [--sheet]   full analysis',\n  '  chart TICKER',\n].join('\\n');\nconst other = ['  nope'];\n");
  assert.deepEqual(loadCliSubcommands(dir), ['analyze', 'chart']);
  assert.deepEqual(loadCliSubcommands(path.join(dir, 'missing')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
