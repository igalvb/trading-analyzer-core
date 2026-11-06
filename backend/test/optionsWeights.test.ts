/**
 * Options go-live (docs/OPTIONS_SENTIMENT_PLAN.md P2) with the weights of docs/OPTIONS_WEIGHTS_DUE_DILIGENCE_2026-11-06.md
 * (owner yes 2026-11-06): every cap, the 60-night gate, the new measures, the profile flag, Decision History's appended
 * columns, C-1's gate, the AI seed from the stored reads and the paper twin "Engine, options off".
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { CboeChainJson } from '../src/fetch/cboe.ts';
import { occ, chainJson, cboeUrlOf, DAYS_ALL, MULTS } from './cboeFixtures.ts';
import {
  measuresOf, scoreMeasures, quantile, realisedVol1y, capConviction, capEntryConfidence,
  OPTIONS_MEASURES_MIN_NIGHTS, CONVICTION_CAP_DOWN, CONVICTION_CAP_UP, ENTRY_CONFIDENCE_CAP, type OptionsMeasures,
} from '../src/analysis/options/measures.ts';
import { synthesizeDecision, type DecisionTechPlan } from '../src/analysis/decision.ts';
import { analyzeOptionsForScoring } from '../src/analysis/options/scoring.ts';
import { gateOptionsSnapshot, decisionOptionsCols, readOfChain, OPTIONS_READ_APPLIED } from '../src/analysis/options/nightlyRead.ts';
import { validateProfile } from '../src/profile/schema.ts';
import { EXAMPLE_PROFILE_INPUT } from '../src/profile/example.ts';
import { activeProfile } from '../src/profile/active.ts';
import { MemoryWorkbookBackend, ReportWorkbook } from '../src/sheets/reportSheet.ts';
import { appendDecisionHistory, getLastDecision, DECISION_HISTORY_SHEET, DECISION_HISTORY_OPTIONS_HEADERS } from '../src/stores/decisionHistory.ts';
import { MemoryTabStore } from '../src/storage/tabStore.ts';
import { MemoryPropertyStore } from '../src/storage/kv.ts';
import { recordOptionsReads, readOptionsMeasures, recordOptionsMeasures, optionsMeasuresRow, OPTIONS_MEASURES_TAB } from '../src/storage/optionsReadsTab.ts';
import { storedOptionsGates, storedGateOf, runOptionsChains, measuresOfNight } from '../src/jobs/options/optionsNight.ts';
import { optionsSeedFor } from '../src/app/nightlyApp.ts';
import { OPTIONS_SNAPSHOT_SHEET } from '../src/reports/options/tabs.ts';
import { newPaperState, paperDay, standings, type PaperDayInput } from '../src/paper/paperTrading.ts';
import { PAPER_OWNER_LIST, OPTIONS_OFF_ID } from '../src/paper/paperLab.ts';
import type { EngineRead, ExitReadResult } from '../src/backtest/engineRun.ts';
import type { PriceSeries } from '../src/backtest/data.ts';
import { sheetFor, PROTECTED_TABS } from '../src/sheets/tabs.ts';
import { HttpClient, HttpResponse, type HttpRequest, type HttpTransport } from '../src/net/http.ts';
import { optionsReviewDates, firesTooOften, OPTIONS_KILL_RULES } from '../src/research/optionsKillRules.ts';

const TZ = 'America/New_York';
const NOW = Date.UTC(2026, 9, 30, 3, 23); // Thu 2026-10-29 23:23 New York
const DAY = 86_400_000;

// ───────── a hand-built chain: spot 100, a 30-day and a 400-day expiry ─────────
function chain(o: { putOtmIv?: number; atmCallIv?: number; atmPutIv?: number; vol?: number } = {}): CboeChainJson {
  const e30 = Date.UTC(2026, 10, 28), e400 = Date.UTC(2027, 11, 3);
  const opt = (sym: string, iv: number, oi = 1000, volume = o.vol ?? 0) => ({ option: sym, iv, open_interest: oi, volume, delta: 0.5, bid: 1, ask: 1.2 });
  return {
    data: {
      current_price: 100,
      options: [
        opt(occ('T', e30, 'C', 100), o.atmCallIv ?? 0.40), opt(occ('T', e30, 'P', 100), o.atmPutIv ?? 0.42),
        opt(occ('T', e30, 'P', 95), o.putOtmIv ?? 0.48), opt(occ('T', e30, 'C', 105), 0.38), opt(occ('T', e30, 'P', 105), 0.41),
        opt(occ('T', e400, 'C', 100), 0.45, 500),
      ],
    },
  } as unknown as CboeChainJson;
}

const m = (day: string, over: Partial<OptionsMeasures> = {}): OptionsMeasures => ({
  day, ticker: 'T', spot: 100, expDays: 30, smirk: 8, atmCallIv: 40, atmPutIv: 42, ivSpread: -2, optVolume: 1000, stockVolume: 1e6, osRatio: 0.001,
  callOi: 1000, putOi: 1000, pcOi: 1, leapsIv: 45, rv1y: 40, ...over,
});
/** n prior nights, values spread so the fifths are well defined (value i % 10). */
const hist = (n: number, f: (i: number) => Partial<OptionsMeasures>): OptionsMeasures[] =>
  Array.from({ length: n }, (_, i) => m('2026-' + String(1 + Math.floor(i / 28)).padStart(2, '0') + '-' + String(1 + (i % 28)).padStart(2, '0'), f(i)));

describe('measures from a chain', () => {
  test('smirk, ATM IVs, IV spread, O/S, OI, LEAPS IV (vol points)', () => {
    const x = measuresOf(chain({ vol: 50 }), 't', '2026-10-29', NOW, 1e6, []);
    assert.equal(x.ticker, 'T');
    assert.equal(x.expDays, 29);
    assert.equal(x.atmCallIv, 40);
    assert.equal(x.atmPutIv, 42);
    assert.equal(x.smirk, 8, 'OTM put 48 − ATM call 40');
    assert.equal(x.ivSpread, -2.5, 'mean of (40−42) and (38−41)');
    assert.equal(x.optVolume, 300);
    assert.equal(x.osRatio, 0.0003);
    assert.equal(x.pcOi, 1.2, 'put OI 3000 ÷ call OI 2500');
    assert.equal(x.leapsIv, 45);
    assert.equal(x.rv1y, null, 'no closes');
  });
  test('realised vol and quantiles', () => {
    assert.equal(realisedVol1y([1, 2, 3]), null);
    const flat = Array.from({ length: 100 }, () => 10);
    assert.equal(realisedVol1y(flat), 0);
    assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
    assert.equal(quantile([], 0.5), null);
  });
});

describe('the 60-night gate: every new measure scores 0 until the stock has 60 stored nights', () => {
  test(`${OPTIONS_MEASURES_MIN_NIGHTS - 1} nights: steep smirk, put-IV jump, rich puts, high O/S all score 0 (shown as would-be)`, () => {
    const h = hist(OPTIONS_MEASURES_MIN_NIGHTS - 1, (i) => ({ smirk: i % 10, ivSpread: i % 10, osRatio: (i % 10) / 1000, atmPutIv: 40, atmCallIv: 40 }));
    const s = scoreMeasures(m('2026-10-29', { smirk: 50, ivSpread: -50, osRatio: 1, atmPutIv: 80 }), h, [m('x', { smirk: 1 }), m('y', { smirk: 2 })]);
    assert.equal(s.nights, OPTIONS_MEASURES_MIN_NIGHTS - 1);
    assert.equal(s.smirk.pts, 0); assert.equal(s.smirk.wouldBe, -2); assert.equal(s.smirk.state, 'not enough history');
    assert.equal(s.ivSpread.pts, 0); assert.equal(s.ivSpread.wouldBe, -3);
    assert.equal(s.os.pts, 0);
    assert.equal(s.convictionPts, 0); assert.equal(s.entryConfidencePts, 0);
    assert.match(s.notes[0]!, /not enough history \(59 of 60 nights\)/);
  });
  test('60 nights: the same readings score', () => {
    const h = hist(OPTIONS_MEASURES_MIN_NIGHTS, (i) => ({ smirk: i % 10, ivSpread: i % 10, osRatio: (i % 10) / 1000 }));
    const s = scoreMeasures(m('2026-10-29', { smirk: 50, ivSpread: -50, osRatio: 1 }), h, [m('x', { smirk: 1 }), m('y', { smirk: 2 })]);
    assert.equal(s.smirk.pts, -2); assert.equal(s.smirk.state, 'steep');
    assert.equal(s.ivSpread.pts, -3);
    assert.equal(s.os.pts, -2);
    assert.equal(s.entryConfidencePts, -5);
  });
});

describe('each rule and every cap', () => {
  const H = hist(80, (i) => ({ smirk: i % 10, ivSpread: i % 10, osRatio: (i % 10) / 1000 }));
  test('smirk steep needs the universe median too; flat (+1) needs the bottom fifth of both', () => {
    const notAboveUniverse = scoreMeasures(m('d', { smirk: 50 }), H, [m('a', { smirk: 60 }), m('b', { smirk: 70 })]);
    assert.equal(notAboveUniverse.smirk.pts, 0);
    const flat = scoreMeasures(m('d', { smirk: -5 }), H, [m('a', { smirk: 10 }), m('b', { smirk: 20 }), m('c', { smirk: 30 }), m('e', { smirk: 40 }), m('f', { smirk: 50 })]);
    assert.equal(flat.smirk.pts, 1); assert.equal(flat.convictionPts, 1);
  });
  test('IV change: put IV jump → -1, call IV jump → +1, both → 0', () => {
    const base = hist(80, (i) => ({ atmPutIv: 40 + ((i * 37) % 11) * 0.1, atmCallIv: 40 + ((i * 53) % 13) * 0.1 }));
    assert.equal(scoreMeasures(m('d', { atmPutIv: 60, atmCallIv: 40 }), base, []).ivChange.pts, -1);
    assert.equal(scoreMeasures(m('d', { atmPutIv: 40, atmCallIv: 60 }), base, []).ivChange.pts, 1);
    assert.equal(scoreMeasures(m('d', { atmPutIv: 60, atmCallIv: 60 }), base, []).ivChange.pts, 0);
  });
  test('conviction hard cap +2 / -3 (smirk -2 and put-IV -1 = -3; +1 +1 = +2; never beyond)', () => {
    const base = hist(80, (i) => ({ smirk: i % 10, atmPutIv: 40 + ((i * 37) % 11) * 0.1, atmCallIv: 40 + ((i * 53) % 13) * 0.1 }));
    const bear = scoreMeasures(m('d', { smirk: 50, atmPutIv: 60, atmCallIv: 40 }), base, [m('a', { smirk: 1 })]);
    assert.equal(bear.convictionPts, -3);
    assert.equal(capConviction(-7), CONVICTION_CAP_DOWN); assert.equal(capConviction(9), CONVICTION_CAP_UP); assert.equal(capConviction(1), 1);
  });
  test('entry confidence: never positive, at most -5', () => {
    assert.equal(capEntryConfidence(-9), ENTRY_CONFIDENCE_CAP); assert.equal(capEntryConfidence(3), 0);
  });
  test('O/S is shadow while the chain shows no volume (P0: 0 at the nightly hour)', () => {
    const noVol = hist(80, (i) => ({ osRatio: (i % 10) / 1000, optVolume: 0 }));
    const s = scoreMeasures(m('d', { osRatio: 1, optVolume: 0 }), noVol, []);
    assert.equal(s.os.state, 'shadow: no volume'); assert.equal(s.os.pts, 0); assert.equal(s.os.wouldBe, -2);
  });
  test('ΔOI P/C is a shadow flag (0 points); the BUY_NOW delay is shadow only', () => {
    const h = hist(80, (i) => ({ pcOi: 1 + (i % 5) * 0.01, ivSpread: i % 10, osRatio: (i % 10) / 1000 }));
    const s = scoreMeasures(m('d', { pcOi: 3, ivSpread: -50, osRatio: 1 }), h, []);
    assert.equal(s.oiBuild, true);
    assert.equal(s.delayShadow, true);
    assert.equal(s.entryConfidencePts, -5, 'the delay itself changes nothing beyond the capped entry confidence');
  });
  test('LEAPS cost note (0 points)', () => {
    const s = scoreMeasures(m('d', { leapsIv: 60, rv1y: 40 }), hist(10, () => ({})), []);
    assert.match(s.leapsCostNote!, /^LEAPS IV 60% vs 1-year realised vol 40%: history building \(10 of 60 nights\)$/);
  });
});

describe('decision: the legacy options terms score 0; only the capped points are added', () => {
  const plan = (over: Partial<DecisionTechPlan> = {}): DecisionTechPlan => ({
    timing: 'BUY_NOW', techScore: 70, entryPrice: 100, entryLow: 98, entryHigh: 102, entryConfidencePct: 65, timeToEntry: { humanText: '3 days' },
    t1: { price: 110, methods: ['x'], count: 1 }, t1Time: { humanText: '2 weeks' }, t2: { price: 120, methods: ['x'], count: 1 }, t2Time: { humanText: '6 weeks' },
    stop: 95, rrToT1: 2, rrToT2: 4, stopAtSpot: 95, rrToT1AtSpot: 2, rrToT2AtSpot: 4, ...over,
  } as unknown as DecisionTechPlan);
  const opt = { available: true, confirm: 'confirm', leapsLean: 0.9, notes: ['n'] } as never;
  const fund = { score: 60 };
  test('CONFIRM +8 and LEAPS +5 apply without weights, not with them', () => {
    const legacy = synthesizeDecision(fund, plan(), opt, null);
    const zero = synthesizeDecision(fund, plan(), opt, null, undefined, undefined, { points: 0, notes: [] });
    assert.equal(legacy.finalConviction - zero.finalConviction, 13);
    assert.ok(zero.lines.some((l) => l.startsWith('Options (shown, not scored): CONFIRM')));
  });
  test('points are capped again inside the decision (+2 / -3)', () => {
    const zero = synthesizeDecision(fund, plan(), opt, null, undefined, undefined, { points: 0, notes: [] }).finalConviction;
    assert.equal(synthesizeDecision(fund, plan(), opt, null, undefined, undefined, { points: 10, notes: [] }).finalConviction, zero + 2);
    assert.equal(synthesizeDecision(fund, plan(), opt, null, undefined, undefined, { points: -10, notes: [] }).finalConviction, zero - 3);
  });
  test('the blocked path skips them; timing is never changed by the points', () => {
    const b = synthesizeDecision({ score: 10 }, plan(), opt, null, undefined, undefined, { points: 2, notes: [] });
    assert.equal(b.finalConviction, 0);
    const avoid = synthesizeDecision(fund, plan({ timing: 'AVOID' }), opt, null, undefined, undefined, { points: 2, notes: [] });
    assert.equal(avoid.timing, 'AVOID');
  });
  test('the "institutions accumulating" wording is gone from production labels (parity keeps legacy\'s)', () => {
    const snap = { contracts: [{ side: 'call', daysToExpiry: 500, conviction: 90, dollarsCommitted: 1e6 }, { side: 'put', daysToExpiry: 500, conviction: 10, dollarsCommitted: 1e6 }], context: {} } as never;
    assert.ok(analyzeOptionsForScoring(snap, null, { plainLabels: true }).notes.includes('LEAPS call/put balance call-heavy (not a tested signal)'));
    assert.ok(analyzeOptionsForScoring(snap, null).notes.some((n) => n.includes('institutions accumulating')));
  });
});

describe('profile flag options.applied', () => {
  test('schema default false; accepts true; the owner profile has it on (owner yes 2026-11-06)', () => {
    const off = validateProfile(EXAMPLE_PROFILE_INPUT);
    assert.ok(off.ok); if (off.ok) assert.equal(off.profile.options.applied, false);
    const on = validateProfile({ ...EXAMPLE_PROFILE_INPUT, options: { applied: true } });
    assert.ok(on.ok); if (on.ok) assert.equal(on.profile.options.applied, true);
    assert.equal(activeProfile().options.applied, true);
    assert.equal(OPTIONS_READ_APPLIED, true);
  });
  test('the measures tab routes to the data sheet and is protected', () => {
    assert.equal(sheetFor(OPTIONS_MEASURES_TAB), 'data');
    assert.ok(PROTECTED_TABS.includes(OPTIONS_MEASURES_TAB));
  });
});

describe('Decision History: options columns appended at the end; old and new rows both read', () => {
  test('getLastDecision works across old (6 cells) and new (10 cells) rows', async () => {
    const wb = await ReportWorkbook.open(new MemoryWorkbookBackend({}), ['*']);
    appendDecisionHistory(wb, 'AAA', { score: 50 }, { techScore: 60 }, { finalConviction: 55, action: 'old' }, NOW - DAY);
    assert.equal(getLastDecision(wb, 'AAA')!.action, 'old');
    const cols = decisionOptionsCols({ available: true, confirm: 'conflict', dirSig: -0.41234 } as never, '2026-10-29', 57, { techScore: 60, finalConviction: 55, timing: 'BUY_NOW', action: 'x' });
    assert.deepEqual(cols, { readDay: '2026-10-29', state: 'CONFLICT', dirSig: -0.412, pts: 2 });
    appendDecisionHistory(wb, 'AAA', { score: 50 }, { techScore: 60 }, { finalConviction: 57, action: 'new' }, NOW, cols);
    const grid = wb.getSheetByName(DECISION_HISTORY_SHEET)!.getDataRange().getValues();
    assert.deepEqual(grid[0]!.slice(6), [...DECISION_HISTORY_OPTIONS_HEADERS]);
    assert.deepEqual(grid[2]!.slice(6), ['2026-10-29', 'CONFLICT', -0.412, 2]);
    const last = getLastDecision(wb, 'AAA')!;
    assert.equal(last.action, 'new'); assert.equal(last.finalConviction, 57);
    assert.deepEqual(decisionOptionsCols({ available: false } as never, null, 50, null), { readDay: '', state: 'none', dirSig: null, pts: 0 });
  });
});

describe('C-1: any snapshot older than 2 trading days is not applied; younger is re-aged', () => {
  const snap = (ts: number) => ({ ticker: 'T', timestamp: new Date(ts).toISOString(), contracts: [{ side: 'call', daysToExpiry: 30 }], context: {} });
  test('Mon read used Wed (2 trading days) is kept and re-aged by the calendar days', () => {
    const mon = Date.UTC(2026, 10, 2, 20), wed = Date.UTC(2026, 10, 4, 20);
    const g = gateOptionsSnapshot(snap(mon) as never, wed, TZ);
    assert.equal(g.ageTradingDays, 2);
    assert.equal(g.snap!.contracts![0]!.daysToExpiry, 28);
  });
  test('Mon read used Thu (3) is not applied, with the plain note', () => {
    const g = gateOptionsSnapshot(snap(Date.UTC(2026, 10, 2, 20)) as never, Date.UTC(2026, 10, 5, 20), TZ);
    assert.equal(g.snap, null);
    assert.equal(g.note, 'Options read is 3 trading days old');
  });
});

/** A fake Cboe serving the given bodies. */
function fakeCboe(bodies: Record<string, string>): HttpClient {
  const transport: HttpTransport = {
    async send(req: HttpRequest) {
      const t = Object.keys(bodies).find((k) => req.url === cboeUrlOf(k));
      return new HttpResponse(t ? 200 : 404, new TextEncoder().encode(t ? bodies[t]! : 'not found'));
    },
  };
  return new HttpClient({ transport });
}

describe('nightly: measures stored per ticker and read back; the AI seed from the stored reads', () => {
  const spec = (root: string) => ({ root, spot: 400, nowMs: NOW, days: DAYS_ALL, strikeMults: MULTS, maxOi: 60000 });
  test('runOptionsChains measures each stock; the 📐 row round-trips', async () => {
    const store = new MemoryTabStore();
    const night = await runOptionsChains({ cboe: { http: fakeCboe({ AAA: chainJson(1, spec('AAA')) }), memo: new Map(), stats: new Map() }, store, kv: new MemoryPropertyStore(), timeZone: TZ, now: () => NOW, log: () => {}, fetchChart: async () => null }, ['AAA'], []);
    const s = measuresOfNight(night, 'aaa')!;
    assert.equal(s.nights, 0); assert.equal(s.convictionPts, 0); assert.equal(s.entryConfidencePts, 0);
    const x = night.measures!.get('AAA')!;
    await recordOptionsMeasures(store, night.day, [optionsMeasuresRow(x.m, x.score)]);
    const back = (await readOptionsMeasures(store)).get('AAA')!;
    assert.equal(back.length, 1);
    assert.equal(back[0]!.smirk, x.m.smirk);
    assert.equal(back[0]!.pcOi, x.m.pcOi);
  });
  test('storedOptionsGates: latest read per ticker, gated at 2 trading days; optionsSeedFor seeds it or an empty snapshot', async () => {
    const store = new MemoryTabStore();
    const r = await readOfChain(JSON.parse(chainJson(1, spec('AAA'))), 'AAA', '2026-10-29', NOW, TZ);
    await recordOptionsReads(store, '2026-10-29', [], [r]);
    const fri = Date.UTC(2026, 9, 30, 18);
    const g = await storedOptionsGates(store, fri, TZ);
    assert.equal(storedGateOf(g, 'aaa').fresh, true);
    assert.equal(storedGateOf(g, 'ZZZ').fresh, false);
    const seed = await optionsSeedFor(g, 'AAA', true);
    assert.ok((seed![OPTIONS_SNAPSHOT_SHEET] as unknown[][]).length > 2);
    assert.deepEqual(await optionsSeedFor(g, 'ZZZ', true), { [OPTIONS_SNAPSHOT_SHEET]: [] }, 'no read: an empty snapshot, never another stock\'s');
    const late = await storedOptionsGates(store, Date.UTC(2026, 10, 4, 18), TZ);
    assert.equal(storedGateOf(late, 'AAA').fresh, false, 'Thu read used the next Wed: 4 trading days');
  });
});

describe('paper twin "Engine, options off"', () => {
  const datesTo = (last: string, n: number): string[] => {
    const out: string[] = []; const d = new Date(last + 'T12:00:00Z');
    while (out.length < n) { if (d.getUTCDay() % 6) out.unshift(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() - 1); }
    return out;
  };
  const D = datesTo('2026-11-03', 260), days = D.slice(-3);
  const rising = D.map((_, i) => 50 + i * 0.2);
  const ser = new Map<string, PriceSeries>(PAPER_OWNER_LIST.map((t) => [t, { ticker: t, dates: D, opens: rising, highs: rising, lows: rising, closes: rising, volumes: rising.map(() => 1e6), splits: [] }]));
  const noExit = (t: string): ExitReadResult => ({ ticker: t, day: '', ok: true, actionClass: 'HOLD' as never, recommendation: 'HOLD', stopBreached: false, thesisInvalidated: false, hitT1: false, hitT2: false, t1: null, t2: null, stopLevel: null, close: null });
  const read = (t: string, extra: Partial<EngineRead> = {}): EngineRead => ({
    ticker: t, day: '', ok: true, finalConviction: 50, action: null, timing: 'WAIT_PULLBACK', regime: 'CHOP', entryPrice: 100, entryHigh: 101, entryConfidencePct: 50, stop: 90,
    ownScore: 60, blocked: false, verdict: 'MAJORITY', directions: {}, close: 100, ...extra,
  });
  const bars = Object.fromEntries([...PAPER_OWNER_LIST, 'QQQ'].map((t) => [t, { open: 100, close: 100 }]));
  // NVDA: 71 with options (2 points from the new measures), 69 with options off
  const reads = PAPER_OWNER_LIST.map((t) => read(t, t === 'NVDA' ? { finalConviction: 71, optionsOff: { finalConviction: 69, timing: 'WAIT_PULLBACK', action: 'x' } } : {}));
  const input = (k: number, applied: boolean): PaperDayInput => ({ day: days[k] as string, bars, reads: [], exitRead: noExit, lab: { reads, series: ser, ...(applied ? { optionsApplied: true } : {}) } });

  test('shadow: the twin never runs; applied: it joins, records the go-live date and decides on the options-off scores', () => {
    const off = newPaperState(['TSLA']);
    paperDay(off, input(0, false));
    assert.equal(off.lab!.accounts[OPTIONS_OFF_ID], undefined);
    assert.equal(off.lab!.optionsLive, undefined);
    const on = newPaperState(['TSLA']);
    paperDay(on, input(0, true));
    assert.equal(on.lab!.optionsLive, days[0]);
    assert.deepEqual(on.lab!.accounts['lab.engine']!.toBuy, ['NVDA'], 'the engine buys at 71');
    assert.deepEqual(on.lab!.accounts[OPTIONS_OFF_ID]!.toBuy, [], 'the twin sees 69: no buy');
    // the existing accounts decide exactly as without the twin
    assert.deepEqual(on.lab!.accounts['lab.engine'], off.lab!.accounts['lab.engine']);
    paperDay(on, input(1, true));
    paperDay(off, input(1, false));
    assert.deepEqual(on.lab!.accounts['lab.engine'], off.lab!.accounts['lab.engine']);
    assert.equal(on.marks.at(-1)!.values['lab.engine'], off.marks.at(-1)!.values['lab.engine']);
    assert.ok(standings(on).some((r) => r.key === OPTIONS_OFF_ID && r.name.startsWith('Engine, options off')));
    assert.ok(!standings(off).some((r) => r.key === OPTIONS_OFF_ID));
  });
});

describe('kill-rule reviews (pre-registered, data only)', () => {
  test('review dates from the go-live day; the 30% construction-bug rule', () => {
    assert.deepEqual(optionsReviewDates('2026-11-06'), [
      { review: '3 months', due: '2027-02-06' }, { review: '6 months', due: '2027-05-06' }, { review: '12 months', due: '2027-11-06' }, { review: '24 months', due: '2028-11-06' },
    ]);
    assert.equal(firesTooOften(31, 100), true); assert.equal(firesTooOften(20, 100), false); assert.equal(firesTooOften(0, 0), false);
    assert.ok(OPTIONS_KILL_RULES.every((r) => r.rule && r.action));
  });
});
