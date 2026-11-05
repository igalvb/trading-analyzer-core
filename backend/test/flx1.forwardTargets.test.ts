/**
 * F-X1: the Exit strategy must be FORWARD-LOOKING. A target counts as reached
 * only when the CURRENT price is at or above it, never because a past peak
 * touched it. legacyHistoricalTargets restores the old behaviour exactly.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import {
  computePositionExitRead, computePositionExitReadFixedLookback, evaluateTargetHits, distanceToTargetPct, useLegacyTargets,
} from '../src/analysis/exitRead.ts';
import { computeOptionsPositionExitRead } from '../src/analysis/optionsExitRead.ts';
import { computeOptionsPositionExitReadFixedLookback } from '../src/portfolio/positions/optionsFixedLookback.ts';
import { formatTargets, formatStockSignals } from '../src/reports/exit/exitReport.ts';
import { positionRows } from '../src/portfolio/positions/analyzePosition.ts';

const LEGACY = { legacyHistoricalTargets: true } as const;
const NOW = Date.UTC(2026, 9, 23);
const EXPIRY = "Dec18'26";

type StockOk = Extract<ReturnType<typeof computePositionExitRead>, { error: null }>;
type FixedOk = Extract<ReturnType<typeof computePositionExitReadFixedLookback>, { error: null }>;

describe('F-X1 forward-looking targets: pure rule', () => {
  test('MSTR case: peak passed T1 (500), price fell back to 400 -> NOT reached (fixed), reached (legacy)', () => {
    const fixed = evaluateTargetHits(400, 550, 500, 700, false);
    assert.deepEqual(fixed, { hitT1: false, hitT2: false });
    const legacy = evaluateTargetHits(400, 550, 500, 700, true);
    assert.deepEqual(legacy, { hitT1: true, hitT2: false });
  });
  test('price currently at or above T1 -> reached; exactly at T1 counts', () => {
    assert.deepEqual(evaluateTargetHits(510, 520, 500, 700, false), { hitT1: true, hitT2: false });
    assert.deepEqual(evaluateTargetHits(500, 500, 500, 700, false), { hitT1: true, hitT2: false });
    assert.deepEqual(evaluateTargetHits(710, 710, 500, 700, false), { hitT1: true, hitT2: true });
  });
  test('missing targets are never reached', () => {
    assert.deepEqual(evaluateTargetHits(100, 999, null, null, false), { hitT1: false, hitT2: false });
    assert.deepEqual(evaluateTargetHits(100, 999, null, null, true), { hitT1: false, hitT2: false });
  });
  test('distance percent is relative to the current price', () => {
    assert.equal(distanceToTargetPct(400, 500), 25);
    assert.equal(distanceToTargetPct(500, 400), -20);
    assert.equal(distanceToTargetPct(400, null), null);
    assert.equal(distanceToTargetPct(0, 500), null);
  });
  test('option names: legacy by either flag, fixed by default', () => {
    assert.equal(useLegacyTargets({}), false);
    assert.equal(useLegacyTargets(undefined), false);
    assert.equal(useLegacyTargets({ legacyHistoricalTargets: true }), true);
    assert.equal(useLegacyTargets({ forwardTargets: false }), true);
    assert.equal(useLegacyTargets({ forwardTargets: true }), false);
  });
});

describe('F-X1 on real charts', { skip: fixturesPresent() ? false : 'fixtures/ not populated' }, () => {
  function* stockReads() {
    for (const ticker of listFixtures()) {
      let raw;
      try { raw = loadRawFixture(ticker); } catch { continue; }
      if (!Array.isArray(raw.closes) || raw.closes.length < 250) continue;
      for (const len of [250, raw.closes.length]) {
        if (len > raw.closes.length) continue;
        const chart = buildChart(raw, len);
        const n = chart.dates.length;
        for (const frac of [0, 0.1, 0.3, 0.5, 0.7, 0.9]) {
          const i = Math.floor(n * frac);
          const ds = chart.dates[i].toISOString().slice(0, 10);
          yield { ticker, chart, ep: chart.closes[i], ds, len };
        }
      }
    }
  }

  test('since-entry read: fixed vs legacy, field by field', () => {
    let reads = 0, legacyOnlyT1 = 0, legacyOnlyT2 = 0, fixedT1 = 0;
    for (const { ticker, chart, ep, ds } of stockReads()) {
      const L = computePositionExitRead(ticker, ep, ds, chart, LEGACY);
      const F = computePositionExitRead(ticker, ep, ds, chart);
      const F2 = computePositionExitRead(ticker, ep, ds, chart, { forwardTargets: true });
      const L2 = computePositionExitRead(ticker, ep, ds, chart, { forwardTargets: false });
      if ('error' in L && L.error) { assert.deepStrictEqual(F, L); continue; }
      const l = L as StockOk, f = F as StockOk;
      reads++;
      assert.deepStrictEqual(F2, F);
      assert.deepStrictEqual(L2, L);
      // legacy output carries no new keys (oracle parity)
      assert.ok(!('distanceToT1Pct' in l) && !('distanceToT2Pct' in l));
      // unchanged: targets, peak info, stop, thesis, trailing opinions
      for (const k of ['t1', 't2', 'cp', 'highestHighSinceEntry', 'chandelierSinceEntry', 'stopBreached', 'thesisInvalidated', 'classicalTrailing', 'turtlePyramid', 'unrealizedPct', 'daysHeld'] as const) {
        assert.deepStrictEqual(f[k], l[k], `${ticker} ${ds} ${k}`);
      }
      // the rule
      assert.equal(f.hitT1, f.t1 != null && f.cp >= f.t1, `${ticker} ${ds} hitT1`);
      assert.equal(f.hitT2, f.t2 != null && f.cp >= f.t2, `${ticker} ${ds} hitT2`);
      assert.equal(l.hitT1, l.t1 != null && l.highestHighSinceEntry >= l.t1);
      // fixed can only be a subset of legacy (cp never exceeds the peak high)
      if (f.hitT1) assert.ok(l.hitT1);
      if (f.hitT2) assert.ok(l.hitT2);
      if (l.hitT1 && !f.hitT1) legacyOnlyT1++;
      if (l.hitT2 && !f.hitT2) legacyOnlyT2++;
      if (f.hitT1) fixedT1++;
      // distances
      assert.equal(f.distanceToT1Pct, f.t1 == null ? null : ((f.t1 - f.cp) / f.cp) * 100);
      assert.equal(f.distanceToT2Pct, f.t2 == null ? null : ((f.t2 - f.cp) / f.cp) * 100);
      // wording
      assert.ok(!/at some point since entry/.test(f.reason), f.reason);
      if (f.recommendation.startsWith('T1') || f.recommendation.startsWith('T2')) assert.match(f.reason, /at or above/);
      if (f.recommendation === 'HOLD' && f.t1 != null) assert.match(f.reason, /above the current price|below the current price/);
      // ladder order untouched
      if (f.stopBreached) assert.equal(f.recommendation, 'STOP HIT — EXIT');
      else if (f.thesisInvalidated) assert.equal(f.recommendation, 'THESIS INVALIDATED — CONSIDER EXIT');
    }
    assert.ok(reads > 200, `only ${reads} reads`);
    assert.ok(legacyOnlyT1 > 0, 'no case where a past peak passed T1 but the price fell back: the bug is not exercised');
    assert.ok(legacyOnlyT2 > 0, 'T2 variant not exercised');
    console.log(`F-X1 since-entry: ${reads} reads, legacy-only T1 ${legacyOnlyT1}, legacy-only T2 ${legacyOnlyT2}, fixed T1 ${fixedT1}`);
  });

  test('peak since entry is still reported as information', () => {
    for (const { ticker, chart, ep, ds } of stockReads()) {
      const f = computePositionExitRead(ticker, ep, ds, chart);
      if ('error' in f && f.error) continue;
      const ok = f as StockOk;
      assert.equal(typeof ok.highestHighSinceEntry, 'number');
      assert.ok(ok.highestHighSinceEntry >= ok.cp - 1e-9 || ok.highestHighSinceEntry > 0);
      break;
    }
  });

  test('fixed-lookback read: same rule, window high stays as information', () => {
    let reads = 0, legacyOnly = 0;
    for (const { ticker, chart } of stockReads()) {
      for (const lb of [undefined, 50, 250]) {
        const ep = chart.closes[0];
        const L = computePositionExitReadFixedLookback(ticker, ep, chart, lb, LEGACY);
        const F = computePositionExitReadFixedLookback(ticker, ep, chart, lb);
        if ('error' in L && L.error) continue;
        const l = L as FixedOk, f = F as FixedOk;
        reads++;
        assert.ok(!('distanceToT1Pct' in l));
        for (const k of ['t1', 't2', 'cp', 'highestHighInWindow', 'chandelierGeneric', 'stopBreached', 'thesisInvalidated'] as const) assert.deepStrictEqual(f[k], l[k]);
        assert.equal(f.hitT1, f.t1 != null && f.cp >= f.t1);
        assert.equal(f.hitT2, f.t2 != null && f.cp >= f.t2);
        assert.equal(f.distanceToT1Pct, f.t1 == null ? null : ((f.t1 - f.cp) / f.cp) * 100);
        assert.ok(!/within the last/.test(f.reason), f.reason);
        if (l.hitT1 && !f.hitT1) legacyOnly++;
      }
    }
    assert.ok(reads > 200 && legacyOnly > 0, `reads ${reads}, legacyOnly ${legacyOnly}`);
  });

  test('options since-entry read: underlying follows the same rule, legacy option restores old output', () => {
    let reads = 0, legacyOnly = 0;
    for (const { ticker, chart, ds } of stockReads()) {
      const L = computeOptionsPositionExitRead(ticker, 100, EXPIRY, 5.25, ds, chart, NOW, LEGACY);
      const F = computeOptionsPositionExitRead(ticker, 100, EXPIRY, 5.25, ds, chart, NOW);
      if ('error' in L && L.error) continue;
      const lt = (L as { technical: StockOk | { error: string } }).technical;
      const ft = (F as { technical: StockOk | { error: string } }).technical;
      if ('error' in lt && lt.error) continue;
      const l = lt as StockOk, f = ft as StockOk;
      reads++;
      assert.equal(f.hitT1, f.t1 != null && f.cp >= f.t1);
      assert.equal(f.hitT2, f.t2 != null && f.cp >= f.t2);
      assert.ok(typeof f.highestHighSinceEntry === 'number');
      assert.ok(!('distanceToT1Pct' in l));
      assert.equal(f.distanceToT1Pct, f.t1 == null ? null : ((f.t1 - f.cp) / f.cp) * 100);
      if (l.hitT1 && !f.hitT1) legacyOnly++;
    }
    assert.ok(reads > 100 && legacyOnly > 0, `reads ${reads}, legacyOnly ${legacyOnly}`);
  });

  test('options fixed-lookback read: same rule', () => {
    let reads = 0, legacyOnly = 0;
    for (const { ticker, chart } of stockReads()) {
      const L = computeOptionsPositionExitReadFixedLookback(ticker, 100, EXPIRY, 5.25, chart, 50, NOW, LEGACY);
      const F = computeOptionsPositionExitReadFixedLookback(ticker, 100, EXPIRY, 5.25, chart, 50, NOW);
      if ('error' in L && L.error) continue;
      const lt = (L as { technical: FixedOk | { error: string } }).technical;
      const ft = (F as { technical: FixedOk | { error: string } }).technical;
      if ('error' in lt && lt.error) continue;
      const l = lt as FixedOk, f = ft as FixedOk;
      reads++;
      assert.equal(f.hitT1, f.t1 != null && f.cp >= f.t1);
      assert.equal(f.hitT2, f.t2 != null && f.cp >= f.t2);
      assert.ok(typeof f.highestHighInWindow === 'number');
      assert.ok(!('distanceToT1Pct' in l));
      if (l.hitT1 && !f.hitT1) legacyOnly++;
    }
    assert.ok(reads > 100 && legacyOnly > 0, `reads ${reads}, legacyOnly ${legacyOnly}`);
  });
});

describe('F-X1 report plumbing', () => {
  test('formatTargets: 4 args = legacy text; distances add the percent away only when not reached', () => {
    assert.equal(formatTargets(500, false, 700, false), 'T1 $500.00  |  T2 $700.00');
    assert.equal(formatTargets(500, false, 700, false, 25, 75), 'T1 $500.00 (25.0% away)  |  T2 $700.00 (75.0% away)');
    assert.equal(formatTargets(500, true, 700, false, -2, 75), 'T1 $500.00 ✓reached  |  T2 $700.00 (75.0% away)');
  });
  test('formatStockSignals passes the distances through', () => {
    const s = formatStockSignals({ error: null, chandelierSinceEntry: 300, t1: 500, hitT1: false, t2: 700, hitT2: false, distanceToT1Pct: 25, distanceToT2Pct: 75, entryDateStr: '2025-03-01' } as never, true);
    assert.match(s.targets, /25\.0% away/);
  });
  test('position tab: 12 rows either way; fixed mode relabels the peak and shows the distance', () => {
    const base = { cp: 400, unrealizedPct: 0.1, daysHeld: 30, highestHighSinceEntry: 550, chandelierSinceEntry: 300, stopBreached: false, classicalTrailing: null, turtlePyramid: null, t1: 500, t2: 700, hitT1: false, hitT2: false, thesisInvalidated: false, recommendation: 'HOLD', reason: 'x' };
    const legacyRows = positionRows(300, '2025-03-01', base as never);
    const fixedRows = positionRows(300, '2025-03-01', { ...base, distanceToT1Pct: 25, distanceToT2Pct: 75 } as never);
    assert.equal(legacyRows.length, 12);
    assert.equal(fixedRows.length, 12);
    assert.equal(legacyRows[7]![0], 'Highest High Since Entry');
    assert.equal(fixedRows[7]![0], 'Highest price since you bought (information only)');
    assert.equal(fixedRows[7]![1], '$550.00');
    assert.match(String(fixedRows[8]![1]), /\$500\.00 \(25\.0% above the current price\) \/ \$700\.00 \(75\.0% above the current price\)/);
    assert.equal(legacyRows[8]![1], '$500.00 / $700.00');
  });
});
