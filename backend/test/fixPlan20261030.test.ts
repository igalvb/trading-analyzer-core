/**
 * Fix plan 2026-10-30, the owner-approved items A2, B3, D3, D4, D5, D6 (A1 is in fl5.darkPool.test.ts, the
 * dashboard's plain-mode text in fl7e.dashboard.test.ts). Every legacy-text path keeps its old output; the oracle
 * suites pin that.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { occExpiryText } from '../src/core/dates.ts';
import { parseOcc } from '../src/fetch/cboe.ts';
import { HttpClient, ReplayTransport, ExchangeBook, type RecordedExchange } from '../src/net/http.ts';
import { MemoryPropertyStore } from '../src/storage/kv.ts';
import { ReportWorkbook, MemoryWorkbookBackend } from '../src/sheets/reportSheet.ts';
import { buildBottomLineSummary, BOTTOM_LINE_TAB } from '../src/reports/bottomLine/summarySheet.ts';
import { buildTop10, buildDashboard as buildOptionsDashboard, OptionsTabs } from '../src/reports/options/tabs.ts';
import { runFullAnalysis, recommendedCallReport, readOptionsSnapshot } from '../src/reports/options/run.ts';
import { computeChainContext, selectRecommendedCall, type RecommendedCall, type ScoredContracts } from '../src/analysis/options/conviction.ts';
import { analyzeOptionsForScoring } from '../src/analysis/options/scoring.ts';
import { formatOptionsDecisionPage, shortTermExitPlanLines, daysToExpiry, type OptionsDecisionInput } from '../src/analysis/reportPages.ts';
import { buildGeminiReport } from '../src/fetch/ai/geminiReview.ts';
import { buildMethodologySheet, METHODOLOGY_TAB } from '../src/ops/methodology.ts';
import { buildNarrative } from '../src/reports/text/narrative.ts';
import {
  putCallBand, putCallText, pickLabel, IV_CHAIN_PCT_LABEL, PUT_CALL_LABEL, PUT_CALL_FLOOR_LABEL, MIN_DAYS_FOR_IV_CONTEXT, SHORT_TERM_MIN_DAYS,
} from '../src/analysis/options/labels.ts';
import { recordedGet, cboeUrlOf, occ, chainJson, MULTS } from './cboeFixtures.ts';
import { genGeminiCase } from './fl7dFixtures.ts';
import { narrativeArgs } from './fl7hFixtures.ts';

const TZ = 'America/New_York';
const NOW = Date.UTC(2026, 9, 30, 17); // Fri Oct 30 2026, 13:00 New York
const OCC_290119 = parseOcc('TSLA290119C00400000').expUnix;
const DAY = 86_400_000;
const TODAY = Math.floor(NOW / DAY) * DAY;

async function inZone<T>(tz: string, fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try { return await fn(); } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
}

const gridText = (wb: ReportWorkbook, tab: string): string => wb.getSheetByName(tab)!.grid().flat().filter((v) => v !== '' && v != null).map(String).join('\n');
const pick = (expUnix: number, strike = 400): RecommendedCall => ({
  found: true, expUnix, deltaFieldSeen: true,
  contract: { strike, expUnix, symbol: 'X', delta: 0.75, theta: 0, gamma: 0, bid: 100, ask: 101, iv: 0.5 },
  allCandidates: [],
});

/** One call per expiry (delta 0.5 at the money) in Cboe's JSON shape. */
function callsAt(days: readonly number[]): string {
  const options = days.flatMap((d) => [0.9, 1, 1.1].map((m) => ({
    option: occ('TSLA', TODAY + d * DAY, 'C', 400 * m), delta: m === 1 ? 0.5 : m < 1 ? 0.7 : 0.3, bid: 10, ask: 11, iv: 0.5, open_interest: 100, volume: 10,
  })));
  return JSON.stringify({ data: { current_price: 400, options } });
}
const cboeDeps = (ex: readonly RecordedExchange[], legacy: boolean) => ({
  http: new HttpClient({ transport: new ReplayTransport(new ExchangeBook(ex)) }), memo: new Map(), clock: { now: () => NOW }, legacyExpiryLabel: legacy,
});

describe('A2 — option expiries print the OCC date (00:00 UTC), with the weekday', () => {
  test('occExpiryText: OCC 290119 is Fri Jan 19 2029 in every zone', async () => {
    for (const tz of ['America/New_York', 'America/Los_Angeles', 'UTC', 'Asia/Jerusalem', 'Pacific/Kiritimati']) {
      await inZone(tz, () => {
        assert.equal(occExpiryText(OCC_290119), 'Fri Jan 19 2029', tz);
        assert.equal(occExpiryText(new Date(OCC_290119 * 1000)), 'Fri Jan 19 2029', tz);
      });
    }
    assert.equal(occExpiryText(Date.UTC(2027, 0, 5) / 1000), 'Tue Jan 05 2027', 'the day is two digits, as toDateString prints it');
    assert.equal(occExpiryText(undefined), 'Invalid Date');
    assert.equal(occExpiryText(NaN), 'Invalid Date');
  });

  test('Bottom Line, Top 10 tab and the Recommended Call report print Fri Jan 19 2029; legacy text keeps the New York date', async () => {
    await inZone(TZ, async () => {
      // Bottom Line
      const bl = async (legacyReportText: boolean) => {
        const wb = await ReportWorkbook.open(new MemoryWorkbookBackend({}));
        buildBottomLineSummary(wb, 'TSLA', { score: 70, verdict: 'Good' }, { techScore: 60, timing: 'BUY_NOW', regime: 'TREND_UP', entryCount: 0, entryLow: 1, entryHigh: 2 },
          { action: 'x', finalConviction: 50 }, pick(OCC_290119) as never, pick(OCC_290119, 420) as never, { clock: { now: () => NOW }, timeZone: TZ, legacyReportText, legacyTabName: false });
        return gridText(wb, BOTTOM_LINE_TAB);
      };
      const plain = await bl(false);
      assert.ok(plain.includes('$400 call, exp Fri Jan 19 2029'), plain);
      assert.ok(plain.includes('📞 Options — ' + pickLabel(true, 0.75)), 'D6: the LEAPS rule');
      assert.ok(plain.includes('📞 Options — ' + pickLabel(false, 0.5)));
      assert.ok(!plain.includes('Thu Jan 18 2029') && !plain.includes('(>1yr)'));
      const legacy = await bl(true);
      assert.ok(legacy.includes('$400 call, exp Thu Jan 18 2029') && legacy.includes('📞 Options — LEAPS (>1yr)'), 'legacy unchanged');

      // Top 10 tab
      const top = async (legacyText: boolean) => {
        const wb = await ReportWorkbook.open(new MemoryWorkbookBackend({}));
        buildTop10(wb, [] as unknown as ScoredContracts, 'TSLA', pick(OCC_290119), pick(OCC_290119, 420), null, { nowMs: NOW, timeZone: TZ, legacyText });
        return gridText(wb, OptionsTabs.TOP10);
      };
      const t = await top(false);
      assert.ok(t.includes('✅ $400 call, exp Fri Jan 19 2029'), t);
      assert.ok(t.includes(pickLabel(true, 0.75) + ':') && t.includes(pickLabel(false, 0.5) + ':'));
      const tl = await top(true);
      assert.ok(tl.includes('✅ $400 call, exp Thu Jan 18 2029') && tl.includes('LEAPS (target delta 0.75):'));

      // The Recommended Call report (and its CBOE diagnostic's sample date) read the chain.
      const body = JSON.stringify({ data: { current_price: 400, options: [
        { option: 'TSLA290119C00400000', delta: 0.75, bid: 100, ask: 101, iv: 0.5, open_interest: 10, volume: 1 },
        { option: occ('TSLA', TODAY + 90 * DAY, 'C', 400), delta: 0.5, bid: 10, ask: 11, iv: 0.5, open_interest: 10, volume: 1 },
      ] } });
      const report = async (legacy: boolean) => recommendedCallReport({
        ...cboeDeps([recordedGet(cboeUrlOf('TSLA'), 200, body)], legacy), kv: new MemoryPropertyStore(), timeZone: TZ,
        workbook: await ReportWorkbook.open(new MemoryWorkbookBackend({})), fetchNextEarnings: async () => null,
      } as never, 'TSLA');
      const r = await report(false);
      assert.ok(r.includes('✅ PICKED: $400 call, exp Fri Jan 19 2029'), r);
      assert.ok(r.includes(pickLabel(true, 0.75) + ':'));
      assert.ok((await report(true)).includes('✅ PICKED: $400 call, exp Thu Jan 18 2029'));
    });
  });

  test('the AI briefing: the recommended contract carries Fri Jan 19 2029 when given occExpiryText (compose / ai.ts outside parity)', async () => {
    const c = genGeminiCase(3);
    const inputs = { ...c.inputs, leapsCall: { found: true, contract: { strike: 400, expUnix: OCC_290119, delta: 0.75 } }, shortTermCall: null };
    const report = await buildGeminiReport(inputs as never, () => c.macro as never, occExpiryText, { plainLabels: true });
    assert.equal(report.recommendedContract.leaps.expiry, 'Fri Jan 19 2029');
  });
});

describe('D3 — the short-term call: at least 60 days left, else no contract', () => {
  test('nearest expiry with 60 to 180 days left; legacy keeps the nearest 14+ day expiry', async () => {
    await inZone(TZ, async () => {
      const ex = [recordedGet(cboeUrlOf('TSLA'), 200, callsAt([1, 21, 45, 64, 120, 400]))];
      const fixed = await selectRecommendedCall(cboeDeps(ex, false), 'TSLA', 0.5, false);
      assert.ok(fixed.found);
      assert.equal(fixed.expUnix * 1000, TODAY + 64 * DAY, 'the 21- and 45-day expiries are too close to the 30-day exit');
      assert.ok(daysToExpiry(fixed.expUnix, NOW, TZ) >= SHORT_TERM_MIN_DAYS);
      const legacy = await selectRecommendedCall(cboeDeps(ex, true), 'TSLA', 0.5, false);
      assert.ok(legacy.found);
      assert.equal(legacy.expUnix * 1000, TODAY + 21 * DAY, 'legacy: the nearest expiry over 14 days');
      // The LEAPS pick is unchanged.
      const leaps = await selectRecommendedCall(cboeDeps(ex, false), 'TSLA', 0.75, true);
      assert.ok(leaps.found && leaps.expUnix * 1000 === TODAY + 400 * DAY);
    });
  });

  test('no expiry with 60+ days under 180: no contract (legacy fell back to the nearest)', async () => {
    const ex = [recordedGet(cboeUrlOf('TSLA'), 200, callsAt([3, 21, 45, 400]))];
    const fixed = await selectRecommendedCall(cboeDeps(ex, false), 'TSLA', 0.5, false);
    assert.deepStrictEqual(fixed, { found: false, reason: 'no expiry with 60 to 180 days left for TSLA' });
    const legacy = await selectRecommendedCall(cboeDeps(ex, true), 'TSLA', 0.5, false);
    assert.ok(legacy.found && legacy.expUnix * 1000 === TODAY + 21 * DAY);
    // The Options Decision page says why, in plain words.
    const page = formatOptionsDecisionPage(decisionInput({ shortTermCall: fixed }));
    assert.ok(page.includes("2. SHORT-TERM (the nearest expiry with 60 to 180 days left, aiming at delta 0.50): DON'T BUY"), page);
    assert.ok(page.includes('What happened: no expiry with 60 to 180 days left (a shorter call would be sold by the 30-day exit almost as soon as it is bought).'), page);
  });

  test('exit plan (owner 2026-10-30 replaced the D3 +50% plan): the weekly-chart rule, the 30-day hard limit kept; LEAPS unchanged', () => {
    const tp = (t1Days: number | null) => ({
      timing: 'BUY_NOW', regime: 'TREND_UP', stop: 90, t1: { price: 130 }, t2: { price: 150 },
      t1Time: t1Days == null ? null : { baseDays: t1Days }, t2Time: null,
    });
    const a = shortTermExitPlanLines(tp(20), 90);
    const text = a.join('\n');
    assert.ok(!/\+50%/.test(text), 'no +50% rule');
    assert.match(text, /Read on the WEEKLY chart/);
    assert.match(text, /2\. The stock reached the engine's sell zone \(none this run\) or T1 \(stock at \$130\.00, expected in about 28 days\)/);
    assert.ok(a.includes('    4. Hard limit: sell everything 30 days before expiry, whatever the price (that leaves about 60 days to hold this call).'), text);
    assert.ok(a.includes('      Today: ✅ keep — 90 days to expiry, 60 before the 30-day limit.'), text);
    // The page uses it for the short-term pick only.
    const page = formatOptionsDecisionPage(decisionInput({ techPlan: tp(20) }));
    assert.ok(page.includes('    1. Out of steam after a gain: the stock is up since the reference price AND at least 2 of:'), page);
    assert.ok(page.includes("2. The stock reached the engine's sell zone (from $140.00) or T1 (stock at $130.00"), 'the sell zone comes from the confluence exit zone');
    assert.ok(page.includes('      Today: not available — not enough weekly history'), 'no chart given: readings say not available');
    assert.ok(page.includes('Sell about a third at T1 (stock at $130.00), a third at T2 (stock at $150.00)'), 'the LEAPS plan is unchanged');
    assert.ok(page.includes('  - Sell everything 60 days before expiry, whatever the price.'), 'the LEAPS 60-day exit is unchanged');
  });
});

const exp = (days: number): number => Math.floor(NOW / DAY + days) * 86400;
const decisionInput = (over: Partial<OptionsDecisionInput> = {}): OptionsDecisionInput => ({
  ticker: 'TEST', leapsCall: pick(exp(400), 100), shortTermCall: pick(exp(90), 120), decision: { action: '✅ BUY NOW', finalConviction: 80 },
  techPlan: { timing: 'BUY_NOW', regime: 'TREND_UP', stop: 90, entryHigh: 104, entryLow: 98, t1: { price: 130 }, t2: { price: 150 } }, fund: { score: 70 },
  confluence: { entryLow: 98, entryHigh: 104, entryCount: 3, exitLow: 140 }, flow: { available: true, leapsLean: 0.6, ivRank: 86, putCallOI: 0.92 }, nowMs: NOW, timeZone: TZ, ...over,
});

describe('D4 / D5 — one whole-chain put/call ratio; 0-6 day options out of the IV figures', () => {
  test('putCallBand: the scoring bands (0.6 / 0.8 / 1.1 / 1.4)', () => {
    assert.equal(putCallBand(0.533), 'calls dominate (bullish)');
    assert.equal(putCallBand(0.6), 'calls dominate (bullish)');
    assert.equal(putCallBand(0.7), 'more calls than puts (mildly bullish)');
    assert.equal(putCallBand(0.92), 'balanced (neutral)');
    assert.equal(putCallBand(1.2), 'more puts than calls (mildly bearish)');
    assert.equal(putCallBand(1.5), 'puts dominate (bearish)');
    assert.equal(putCallText(null), 'not available');
    assert.equal(putCallText(0.92), '0.92 — balanced (neutral)');
  });

  test('computeChainContext: under-7-day contracts leave the front IV, term structure and IV percentile; P/C unchanged; default = legacy', () => {
    const c = (side: string, daysToExpiry: number, iv: number, oi = 100) => ({ side, strike: 100, oi, vol: 1, iv, daysToExpiry });
    const chain = [
      c('call', 1, 2.0, 5000), c('put', 1, 2.2, 1000), c('call', 2, 1.7), // today's / tomorrow's options at 170-220% IV
      c('call', 30, 0.5), c('put', 30, 0.55), c('call', 80, 0.45), c('put', 200, 0.5), c('call', 400, 0.5), c('put', 500, 0.5),
    ];
    const legacy = computeChainContext(chain);
    const fixed = computeChainContext(chain, { minIvDays: MIN_DAYS_FOR_IV_CONTEXT });
    assert.equal(fixed.putCallRatioOI, legacy.putCallRatioOI, 'the whole chain still counts for P/C');
    assert.equal(fixed.netBiasPct, legacy.netBiasPct);
    assert.ok(Math.abs((fixed.frontIV as number) - 0.5) < 1e-12, 'front IV from the 30- and 80-day contracts only');
    assert.ok((legacy.frontIV as number) > 1, 'legacy: the 0-day options lift the front IV');
    assert.match(legacy.termNote, /^Inverted/);
    assert.match(fixed.termNote, /^Flat/);
    assert.notEqual(fixed.ivRankPct, legacy.ivRankPct);
    assert.equal(fixed.ivRankPct, 83, 'ranked among the 6 contracts with 7+ days: 5 of 6 IVs are at or below 0.5');
    assert.equal(legacy.ivRankPct, 67);
    assert.deepStrictEqual(computeChainContext(chain, {}), legacy);
  });

  test('a full options run: the Dashboard, Near/Mid/LEAPS and the saved snapshot show the same whole-chain P/C; the $-floor ratio is labelled', async () => {
    await inZone(TZ, async () => {
      const today1 = Array.from({ length: 8 }, (_, i) => ({ option: occ('TSLA', TODAY + DAY, 'C', 380 + i * 5), delta: 0.5, bid: 2, ask: 2.2, iv: 2.1, open_interest: 40, volume: 900 }));
      const body = chainJson(11, { root: 'TSLA', spot: 400, nowMs: NOW, days: [1, 2, 10, 45, 80, 120, 200, 400, 760], strikeMults: MULTS, maxOi: 60000 }, today1);
      const run = async (legacy: boolean) => {
        const wb = await ReportWorkbook.open(new MemoryWorkbookBackend({}));
        const r = await runFullAnalysis({
          ...cboeDeps([recordedGet(cboeUrlOf('TSLA'), 200, body)], legacy), kv: new MemoryPropertyStore(), timeZone: TZ, workbook: wb,
          fetchNextEarnings: async () => null, log: () => {},
        } as never, 'TSLA');
        return { wb, r: r!, snap: readOptionsSnapshot(wb, 'TSLA', NOW, TZ)! };
      };
      const { wb, r, snap } = await run(false);
      const whole = (snap.context as { putCallRatioOI: number }).putCallRatioOI;
      const dash = wb.getSheetByName(OptionsTabs.DASHBOARD)!.grid();
      assert.equal(dash[3]![0], PUT_CALL_LABEL);
      assert.equal(dash[3]![2], PUT_CALL_FLOOR_LABEL);
      assert.equal(dash[4]![0], whole.toFixed(2), 'the Dashboard headline is the whole chain');
      assert.equal(dash[4]![1], putCallBand(whole));
      const buckets = gridText(wb, OptionsTabs.BUCKETS);
      assert.ok(buckets.includes(PUT_CALL_LABEL + ': ' + putCallText(whole)), buckets.slice(0, 400));
      assert.ok(buckets.includes(IV_CHAIN_PCT_LABEL + ': '));
      assert.ok(!buckets.includes('IV percentile (vs today'));
      // D5: the saved context (the ivRank input) leaves the 1-2 day contracts out.
      const ctx = snap.context as { frontIV: number; ivRankPct: number };
      assert.ok(ctx.frontIV < 1, 'front IV without the 210% one-day options: ' + ctx.frontIV);
      // D3 in the run: the short-term pick has 60+ days left.
      assert.ok(r.shortTermCall.found && daysToExpiry(r.shortTermCall.expUnix, NOW, TZ) >= SHORT_TERM_MIN_DAYS);
      // Legacy text unchanged: the old 3-decimal $-floor ratio with its own bands, 0-day IVs included.
      const L = await run(true);
      const ldash = L.wb.getSheetByName(OptionsTabs.DASHBOARD)!.grid();
      assert.equal(ldash[3]![2], 'P/C Ratio');
      assert.match(String(ldash[4]![2]), /^\d\.\d{3}$/);
      assert.ok((L.snap.context as { frontIV: number }).frontIV > ctx.frontIV, 'legacy front IV includes the one-day options');
      assert.ok(L.r.shortTermCall.found && daysToExpiry(L.r.shortTermCall.expUnix, NOW, TZ) < SHORT_TERM_MIN_DAYS, 'legacy picks the 45-day expiry');
    });
  });

  test('the options Dashboard tab writer: whole-chain headline, the $-floor ratio in its own labelled column', async () => {
    const sc = (side: string, oi: number) => ({ side, strike: 400, oi, vol: 0, iv: 0.5, daysToExpiry: 30, expiryStr: 'x', bucket: 'Near (0–3m)', dollarsCommitted: 1e9, conviction: 50 });
    const contracts = [sc('call', 1500), sc('put', 800)] as unknown as ScoredContracts; // 0.533 above the $ floor
    const wb = await ReportWorkbook.open(new MemoryWorkbookBackend({}));
    buildOptionsDashboard(wb, contracts, 'TSLA', { nowMs: NOW, timeZone: TZ }, 0.92);
    const g = wb.getSheetByName(OptionsTabs.DASHBOARD)!.grid();
    assert.deepStrictEqual(g[4]!.slice(0, 3), ['0.92', 'balanced (neutral)', '0.53']);
    assert.ok(!gridText(wb, OptionsTabs.DASHBOARD).includes('Bullish — calls dominate'));
  });

  test('the notes, the narrative, the Options Decision page and the methodology tab use the same words', async () => {
    const snap = { ticker: 'T', contracts: [{ side: 'call', strike: 1, daysToExpiry: 30, conviction: 50, dollarsCommitted: 1 }, { side: 'put', strike: 1, daysToExpiry: 30, conviction: 40, dollarsCommitted: 1 }], context: { putCallRatioOI: 0.92, netBiasPct: 5, ivRankPct: 86 } };
    const plain = analyzeOptionsForScoring(snap as never, null, { plainLabels: true });
    assert.ok(plain.notes.includes('Put/call ratio (open interest, whole chain) 0.92 — balanced (neutral)'), plain.notes.join(' | '));
    assert.ok(plain.notes.some((n) => n.startsWith('IV vs this chain (percentile) 86 (elevated')));
    const legacy = analyzeOptionsForScoring(snap as never, null);
    assert.ok(legacy.notes.includes('Put/Call OI 0.92 (neutral)') && legacy.notes.some((n) => n.startsWith('IV %ile 86')));
    assert.deepStrictEqual({ ...plain, notes: [] }, { ...legacy, notes: [] }, 'only the note text differs');

    const args = narrativeArgs({ opts: { available: true, confirm: 'confirm', putCallOI: 0.92, netBiasPct: 5, ivRank: 86 } });
    const nPlain = (buildNarrative as (...a: unknown[]) => ReturnType<typeof buildNarrative>)(...args, { plainLabels: true }).map((p) => p.body).join('\n');
    assert.ok(nPlain.includes('put/call OI (whole chain) 0.92 — balanced (neutral)') && nPlain.includes('IV vs this chain (percentile) 86th'), nPlain);
    assert.ok(!nPlain.includes('%ile'));

    const page = formatOptionsDecisionPage(decisionInput());
    assert.ok(page.includes('  IV vs this chain (percentile): 86 — where the near-term IV sits among all of today\'s contract IVs for this stock (not a history-based IV rank)'), page);
    assert.ok(page.includes('  Put/call ratio (open interest, whole chain): 0.92 — balanced (neutral)'));
    assert.ok(!/IV rank:/.test(page));

    const wb = await ReportWorkbook.open(new MemoryWorkbookBackend({}));
    buildMethodologySheet(wb, { alert: () => {}, plainLabels: true });
    const m = gridText(wb, METHODOLOGY_TAB);
    assert.ok(m.includes(IV_CHAIN_PCT_LABEL) && !m.includes('IV Percentile') && !m.includes('own historical range'));
    assert.ok(m.includes(PUT_CALL_LABEL) && m.includes('up to 0.60 bullish'));
  });

  test('the AI prompt: the options block names "IV vs this chain (percentile)", not ivRankPct (legacy keeps ivRankPct)', async () => {
    const c = genGeminiCase(5);
    const inputs = { ...c.inputs, optAnalysis: { available: true, confirm: 'confirm', putCallOI: 0.92, netBiasPct: 5, dirSig: 0.4, leapsLean: 0.2, ivRank: 86, notes: [] } };
    const plain = await buildGeminiReport(inputs as never, () => c.macro as never, occExpiryText, { plainLabels: true });
    assert.equal(plain.options.ivVsThisChainPercentile, 86);
    assert.ok(!('ivRankPct' in plain.options));
    assert.match(plain.options.ivVsThisChainPercentileMeans, /IV vs this chain \(percentile\)/);
    const legacy = await buildGeminiReport(inputs as never, () => c.macro as never);
    assert.equal(legacy.options.ivRankPct, 86);
  });
});
