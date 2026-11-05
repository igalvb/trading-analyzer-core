/**
 * FL-7f: the Exit Strategy report group against the oracle: the formatters, the bull-phase advisory, the trigger
 * data and the menu mapping. The writer of the old '📤 Exit Strategy' tab (buildExitStrategyReportV7) and its
 * twin-workbook parity tests were removed with the port (owner 2026-11-04, backlog row 39); the Exit Report tab
 * (reports/exitSheet) uses the pieces tested here.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadOracle, legacyFilesPresent, LEGACY_DIR } from './oracle.ts';
import { withOracleGlobals } from './oracleGlobals.ts';
import { fixturesPresent } from './fixtures.ts';
import { MENU_ENTRY_POINTS, LEGACY_MENUS } from '../src/reports/options/ui.ts';
import { computePortfolioBullPhaseAdvisory, formatTargets, formatStockSignals, formatOptionsSignals, EXIT_STRATEGY_TAB, EXIT_STRATEGY_PURCHASE_DATE_COLUMN } from '../src/reports/exit/exitReport.ts';
import { EXIT_STRATEGY_LEGACY_TRIGGER, planExitStrategyTriggerInstall, EXIT_REPORT_ENTRY_POINTS } from '../src/reports/exit/schedule.ts';
import { charts } from './fl7fFixtures.ts';

const ready = legacyFilesPresent() && fixturesPresent();
const LEG = ready ? fs.readFileSync(path.join(LEGACY_DIR, 'fullStockAnalysisV10_9.gs'), 'utf8').split('\n') : [];
const o = () => loadOracle();
const run = (f: () => unknown) => { try { return { ok: f() }; } catch (e) { return { threw: (e as Error).message }; } };
interface Env { macro?: unknown; noMacro?: boolean; macroThrows?: boolean; rs?: Record<string, unknown>; noRs?: boolean }
const DEFAULT_ENV: Env = { macro: { evaluativeIndex: { pctStrong: 5.5 }, dowTheory: { verdict: 'CONFIRMED BULL' } }, rs: { AQZA: { categories: ['semis', 'tech'] }, AVD: { categories: ['semis'] }, DECK: { categories: ['consumer'] } } };
describe('FL-7f -- Exit Strategy report', { skip: ready ? false : 'legacy/ or fixtures not populated' }, () => {
  test('legacy ranges, constants and the trigger line', () => {
    const rng: Array<[string, number, number]> = [['computePortfolioBullPhaseAdvisoryV1_', 859, 906], ['formatTargetsV1_', 10157, 10161], ['formatStockSignalsV1_', 10163, 10182], ['formatOptionsSignalsV1_', 10197, 10223], ['buildExitStrategyReportV7', 10242, 10500], ['buildExitStrategyReportV7Menu', 10502, 10504], ['installExitStrategyTriggerV1', 10516, 10524]];
    for (const [n, a, b] of rng) { assert.ok(LEG[a - 1].startsWith('function ' + n + '('), n); assert.equal(LEG[b - 1], '}', n + ' end'); }
    assert.equal(LEG.length, 10525, 'file ends at 10524 plus the trailing newline');
    assert.equal(LEG[10137], "const EXIT_STRATEGY_PURCHASE_DATE_COLUMN_V1 = '" + EXIT_STRATEGY_PURCHASE_DATE_COLUMN + "';");
    assert.equal(LEG[10514], "const EXIT_STRATEGY_TRIGGER_HANDLER_V1 = '" + EXIT_STRATEGY_LEGACY_TRIGGER.handler + "';");
    assert.ok(LEG[10521].includes('.everyDays(' + EXIT_STRATEGY_LEGACY_TRIGGER.everyDays + ').atHour(' + EXIT_STRATEGY_LEGACY_TRIGGER.atHour + ')'));
    assert.ok(LEG.slice(10241, 10500).some((l) => l.includes("getOrCreate(ss, '" + EXIT_STRATEGY_TAB + "')")));
  });

  test('formatTargets, formatStockSignals: every combination equals legacy (thrown messages too), every summary reached', () => {
    const vals = [null, undefined, 0, 1.005, 123.456], hits = [true, false, undefined];
    for (const a of vals) for (const b of vals) for (const h1 of hits) for (const h2 of hits) assert.deepStrictEqual(run(() => formatTargets(a, h1, b, h2)), run(() => o().callNormalized('formatTargetsV1_', a, h1, b, h2)));
    const seen = new Set<string>(); let n = 0;
    const B = [false, true];
    const reads: any[] = [{ error: 'boom' }, { error: null, thesisInvalidated: false, stopBreached: false }];
    for (const th of B) for (const st of B) for (const h1 of B) for (const h2 of B) for (const [t1, t2] of [[null, null], [100.456, 200]]) for (const ch of [{ chandelierSinceEntry: 90.126, chandelierGeneric: 80 }, { chandelierSinceEntry: null, chandelierGeneric: 80.5 }, { chandelierSinceEntry: null, chandelierGeneric: null }]) for (const ed of ['', '2020-01-02']) for (const lb of [undefined, 0, 50]) reads.push({ error: null, thesisInvalidated: th, stopBreached: st, hitT1: h1, hitT2: h2, t1, t2, ...ch, entryDateStr: ed, lookbackTradingDays: lb });
    for (const r of reads) for (const real of B) {
      const l = run(() => o().callNormalized('formatStockSignalsV1_', r, real));
      assert.deepStrictEqual(run(() => formatStockSignals(r, real, { legacyReportText: true })), l); n++;
      if ('ok' in l) seen.add(String((l.ok as any).summary).slice(0, 22));
      else assert.match(l.threw!, /toFixed/, 'guard: the only throw is the missing stop level');
    }
    for (const s of ['ERROR: boom', 'EXIT — thesis broken', 'EXIT — stop hit (high', 'REVIEW — possible stop', 'CONSIDER TRIMMING/PAR', 'HOLD']) assert.ok([...seen].some((x) => x.startsWith(s.slice(0, 20))), 'guard: ' + s);
    assert.ok(n > 800);
  });

  test('formatOptionsSignals: every combination equals legacy, every summary reached (incl. a failed underlying read showing HOLD, F-F1)', () => {
    const B = [false, true]; const seen = new Set<string>(); let holdWithTechError = false;
    const techs: any[] = [undefined, null, { error: 'x' }];
    for (const th of B) for (const st of B) for (const h1 of B) for (const h2 of B) for (const ch of [{ chandelierSinceEntry: 12.5 }, { chandelierSinceEntry: null, chandelierGeneric: 10 }, {}]) techs.push({ error: null, thesisInvalidated: th, stopBreached: st, hitT1: h1, hitT2: h2, t1: 5, t2: 9, ...ch });
    for (const technical of techs) for (const daysToExpiry of [-3, 0, 1, 45, 400]) for (const expiryWarning of B) for (const expiryThreshold of [30, 60]) for (const real of B) for (const contracts of [undefined, null, 0, 1, 1.9, 2, 5]) {
      const r = { error: null, technical, daysToExpiry, expiryWarning, expiryThreshold };
      const l = run(() => o().callNormalized('formatOptionsSignalsV1_', r, real, contracts));
      assert.deepStrictEqual(run(() => formatOptionsSignals(r, real, contracts, { legacyReportText: true })), l);
      if ('ok' in l) { const s = (l.ok as any).summary as string; seen.add(s.replace(/\(\d+d\)/, '(Nd)')); if (technical && (technical as any).error && s === 'HOLD') holdWithTechError = true; }
    }
    for (const e of [{ error: 'bad' }, { error: null, technical: {}, daysToExpiry: 3 }]) assert.deepStrictEqual(run(() => formatOptionsSignals(e as any, true, 1, { legacyReportText: true })), run(() => o().callNormalized('formatOptionsSignalsV1_', e, true, 1)));
    for (const s of ['EXPIRED — check Portfolio sheet', 'EXIT — thesis broken (underlying, high confidence)', 'EXIT — stop hit (underlying, high confidence, since real entry)', 'REVIEW — possible stop hit (underlying), LOW CONFIDENCE (generic lookback)', 'EXIT — expiry approaching (Nd)', 'CONSIDER TRIMMING/PARTIAL — T2 reached', 'CONSIDER TRIMMING/PARTIAL — T1 reached', 'T2 reached — HOLD or EXIT (only 1 contract, no partial exit possible)', 'T1 reached — HOLD or EXIT (only 1 contract, no partial exit possible)', 'HOLD']) assert.ok(seen.has(s), 'guard: ' + s);
    assert.ok(holdWithTechError, 'guard: F-F1 reached');
  });

  const ADV: Array<[string, { holdings: Array<[string, number | null]>; env: Env; boom?: string }]> = [
    ['over the ceiling, near bottom, caps flagged', { holdings: ['AQZA', 'AVD', 'DECK', 'HQZA', 'IBIT', 'AKX', 'AKH', 'AKT', 'ALT', 'AKO', 'AKF'].map((t) => [t, 200000] as [string, number]), env: DEFAULT_ENV }],
    ['near top, short chart, missing chart, throwing chart, null and zero shares, duplicates', { holdings: [['AQZA', 5], ['SHORT', 5], ['NONE', 5], ['BOOM', 5], ['IBIT', null], ['HQZA', 0], ['AQZA', 7]], env: { macro: { evaluativeIndex: { pctStrong: 95 }, dowTheory: { verdict: '' } }, rs: DEFAULT_ENV.rs }, boom: 'BOOM' }],
    ['no readers at all', { holdings: [['AQZA', 100]], env: { noMacro: true, noRs: true } }],
    ['empty holdings', { holdings: [], env: DEFAULT_ENV }],
    ['edge 9', { holdings: [['AQZA', 100]], env: { macro: { evaluativeIndex: { pctStrong: 9 } } } }],
    ['edge 9.01', { holdings: [['AQZA', 100]], env: { macro: { evaluativeIndex: { pctStrong: 9.01 } } } }],
    ['edge 90', { holdings: [['AQZA', 100]], env: { macro: { evaluativeIndex: { pctStrong: 90 } } } }],
    ['edge 89.99, no verdict', { holdings: [['AQZA', 100]], env: { macro: { evaluativeIndex: { pctStrong: 89.99 }, dowTheory: {} } } }],
    ['pctStrong null, dow only', { holdings: [['AQZA', 100]], env: { macro: { evaluativeIndex: { pctStrong: null }, dowTheory: { verdict: 'X' } } } }],
    ['macro has neither', { holdings: [['AQZA', 100]], env: { macro: {} } }],
    ['macro read throws', { holdings: [['AQZA', 100]], env: { macroThrows: true } }],
    ['relative-strength read throws after the tier was recorded (F-F5)', { holdings: [['AQZA', 100], ['IBIT', 100]], env: { rs: undefined }, boom: 'RS:IBIT' }],
  ];
  const advSeen = { notes: new Set<string>(), phases: new Set<unknown>(), flags: new Set<boolean>(), absentCaps: false, dupTicker: false, flaggedCat: false, totalFlag: false };
  for (const [label, c] of ADV) {
    test('advisory: ' + label, async () => {
      const holdings = c.holdings.map(([ticker, shares]) => ({ ticker, shares }));
      const get = (t: string) => { if (t === c.boom) throw new Error('chart boom'); return (charts() as Record<string, unknown>)[t] ?? null; };
      const rsFn = (t: string) => { if (c.boom === 'RS:' + t) throw new Error('rs boom'); return c.env.rs?.[t] ?? null; };
      const l = withOracleGlobals({
        Logger: { log: () => {} },
        getCachedMacroRegime_: c.env.noMacro ? undefined : () => { if (c.env.macroThrows) throw new Error('macro boom'); return c.env.macro ?? null; },
        getCachedRelativeStrengthRankingV1_: c.env.noRs ? undefined : rsFn,
      }, () => o().callNormalized<any>('computePortfolioBullPhaseAdvisoryV1_', holdings, get));
      const p = await computePortfolioBullPhaseAdvisory(holdings, get as never, {
        getMacroRegime: c.env.noMacro ? undefined : async () => { if (c.env.macroThrows) throw new Error('macro boom'); return (c.env.macro ?? null) as never; },
        getRelativeStrength: c.env.noRs ? undefined : (async (t: string) => rsFn(t)) as never,
      });
      assert.deepStrictEqual(structuredClone(p), l);
      l.holdings.forEach((h: any) => { if (h.note) advSeen.notes.add(h.note); });
      advSeen.phases.add(l.phaseRead); advSeen.flags.add(l.diversificationFlag);
      if (!('correlatedCaps' in l)) advSeen.absentCaps = true;
      if (new Set(l.holdings.map((h: any) => h.ticker)).size < l.holdings.length) advSeen.dupTicker = true;
      if (l.correlatedCaps?.categoryFlags.some((f: any) => f.flagged)) advSeen.flaggedCat = true;
      if (l.correlatedCaps?.totalFlagged) advSeen.totalFlag = true;
    });
  }
  test('advisory coverage guards', () => {
    assert.deepStrictEqual([...advSeen.notes].sort(), ['fetch/compute error', 'insufficient real price history']);
    assert.deepStrictEqual(new Set(advSeen.phases), new Set([null, 'NEAR_BOTTOM', 'NEAR_TOP']));
    assert.deepStrictEqual(advSeen.flags, new Set([true, false]));
    assert.ok(advSeen.absentCaps && advSeen.dupTicker && advSeen.flaggedCat && advSeen.totalFlag, JSON.stringify({ ...advSeen, notes: [...advSeen.notes], phases: [...advSeen.phases], flags: [...advSeen.flags] }));
  });

  test('menu wrapper, trigger installer as data, menu mapping', () => {
    let calls = 0, args: unknown[] = [];
    withOracleGlobals({ buildExitStrategyReportV7: (...a: unknown[]) => { calls++; args = a; } }, () => o().call('buildExitStrategyReportV7Menu'));
    assert.deepEqual([calls, args], [1, []]);
    for (const existing of [[], ['other'], ['buildExitStrategyReportV7'], ['buildExitStrategyReportV7', 'x', 'buildExitStrategyReportV7']]) {
      const chain: string[] = [], logs: string[] = [];
      const chainObj: any = { timeBased: () => (chain.push('timeBased'), chainObj), everyDays: (n: number) => (chain.push('everyDays:' + n), chainObj), atHour: (n: number) => (chain.push('atHour:' + n), chainObj), create: () => { chain.push('create'); } };
      withOracleGlobals({ Logger: { log: (m: unknown) => { logs.push(String(m)); } }, ScriptApp: { getProjectTriggers: () => existing.map((h) => ({ getHandlerFunction: () => h })), newTrigger: (h: string) => { chain.push('newTrigger:' + h); return chainObj; } } }, () => o().call('installExitStrategyTriggerV1'));
      const plan = planExitStrategyTriggerInstall(existing);
      assert.deepStrictEqual([plan.chain, [plan.log]], [chain, logs], existing.join(','));
    }
    assert.equal(EXIT_REPORT_ENTRY_POINTS.buildExitStrategyReportV7Menu.entry, MENU_ENTRY_POINTS.buildExitStrategyReportV7Menu.entry);
    const handlers = LEGACY_MENUS.flatMap((m) => m.items.filter(Boolean).map((i) => i![1]));
    for (const k of ['buildExitStrategyReportV7Menu', 'installExitStrategyTriggerV1']) assert.ok(handlers.includes(k) && k in EXIT_REPORT_ENTRY_POINTS);
  });
});
