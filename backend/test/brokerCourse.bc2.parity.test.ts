/**
 * Broker Course BC-2 parity: Phase 1 (Stock ID Card) and Phase 4 (gaps),
 * 15 functions.
 *
 * ══ WHAT IS REAL DATA AND WHAT HAD TO BQZA INJECTED ══════════════════════
 * Real fixtures alone reach every ID-card branch EXCEPT the fund-derived
 * ones -- no fixture carries fundamentals, so market-cap tier, float tier,
 * sector and shares-outstanding would compare null to null everywhere (the
 * vacuity trap). Synthetic funds spanning every tier are injected on both
 * sides. Likewise no fixture carries an earnings history, so every
 * earnings case is synthetic, and each was probed against the oracle
 * before being trusted as an assertion.
 *
 * The reverse-split flag needs NO synthetic data: CQZB (1:10, 2019-12-11)
 * and HQZA (1:5, 2023-12-04) are real reverse splits, and truncating those
 * charts around the split walks the flag across its real 60-bar boundary.
 * Gap typing reaches all five types on real gaps.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, loadChart, fixturesPresent } from './fixtures.ts';
import {
  marketCapTierV1, floatTierFlagV1, atrPctFlagV1, relativeVolumeReadV1,
  computeATRV1, trailingRangeVolatilityPctV1, volatilityHotColdReadV1,
  trailing52WeekRangeV1, volumeStatsV1, buildStockIdCardV1,
  type StockIdCard, type StockIdCardFund,
} from '../src/analysis/models/brokerCourse/stockIdCard.ts';
import {
  detectPriceGapsV1, gapMarketCapSignificanceV1, classifyGapTypeV1,
  classifyEarningsGapV1, reverseSplitAvoidFlagV1,
  type BrokerGap, type EarningsEvent,
} from '../src/analysis/models/brokerCourse/gaps.ts';
import { recentReverseSplit } from '../src/analysis/indicators/events.ts';

const ready = legacyFilesPresent() && fixturesPresent();

describe('Broker Course P1 — Stock ID Card', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('every tier and flag read matches the oracle at its exact boundary', () => {
    const oracle = loadOracle();
    const caps = [null, undefined, NaN, 0, -5, 249.99e6, 250e6, 2e9 - 1, 2e9,
      10e9 - 1, 10e9, 100e9 - 1, 100e9, 3e12];
    const floats = [null, undefined, NaN, 0, 9.99e6, 10e6, 29.99e6, 30e6, 49.99e6, 50e6, 1e9];
    const atrPcts = [null, undefined, NaN, 0, 0.0999, 0.10, 0.1001, 0.5];
    const relVols = [null, undefined, NaN, 0, 1.4999, 1.5, 3];
    const pcts = [null, undefined, NaN, 0, 0.0299, 0.03, 0.04, 0.05, 0.05001, 0.2];
    for (const v of caps) assert.equal(marketCapTierV1(v), oracle.call('marketCapTierV1', v), `cap ${v}`);
    for (const v of floats) assert.equal(floatTierFlagV1(v), oracle.call('floatTierFlagV1', v), `float ${v}`);
    for (const v of atrPcts) assert.equal(atrPctFlagV1(v), oracle.call('atrPctFlagV1', v), `atr% ${v}`);
    for (const v of relVols) {
      assert.equal(relativeVolumeReadV1(v), oracle.call('relativeVolumeReadV1', v), `relVol ${v}`);
    }
    for (const v of pcts) {
      assert.deepStrictEqual(volatilityHotColdReadV1(v),
        oracle.callNormalized('volatilityHotColdReadV1', v), `pct ${v}`);
    }

    assert.equal(new Set(caps.map((c) => marketCapTierV1(c)).filter(Boolean)).size, 5);
    assert.equal(new Set(floats.map((f) => floatTierFlagV1(f)).filter(Boolean)).size, 4);
    assert.equal(new Set(pcts.map((p) => volatilityHotColdReadV1(p)?.tier).filter(Boolean)).size, 3);

    // Market-cap floors are inclusive (>=) ...
    assert.equal(marketCapTierV1(100e9), 'Mega Cap');
    assert.equal(marketCapTierV1(250e6), 'Small Cap');
    // ... float tiers are strict (<), so exactly 10M is NOT "extreme low".
    assert.equal(floatTierFlagV1(10e6), 'Very low float (<30M)');
    assert.equal(floatTierFlagV1(50e6), 'Normal float');
    // ATR% is strict (>10%); relative volume is inclusive (>=1.5x).
    assert.equal(atrPctFlagV1(0.10), 'Normal-to-elevated volatility');
    assert.equal(relativeVolumeReadV1(1.5), 'Elevated — something is happening');
    // Zero and negative caps are labelled, not refused.
    assert.equal(marketCapTierV1(0), 'Tiny/Micro Cap');
    // Both hot/coiled bands are strict: exactly 3% and 5% read Normal.
    assert.equal(volatilityHotColdReadV1(0.03)?.tier, 'Normal');
    assert.equal(volatilityHotColdReadV1(0.05)?.tier, 'Normal');
    // The text rounds AFTER the strict test, so at a boundary it can
    // contradict its own tier. Measured, reproduced as written.
    assert.equal(volatilityHotColdReadV1(0.0299)?.tier, 'Coiled');
    assert.match(volatilityHotColdReadV1(0.0299)!.read, /^Volatility 3\.0% — below the course's 3%/);
    assert.equal(volatilityHotColdReadV1(0.05001)?.tier, 'Hot');
    assert.match(volatilityHotColdReadV1(0.05001)!.read, /^Volatility 5\.0% — above/);
    // The only Phase 1 read with no isNaN guard: NaN falls through to Normal.
    assert.equal(volatilityHotColdReadV1(NaN)?.tier, 'Normal');
    assert.equal(marketCapTierV1(NaN), null);
  });

  test('ATR, range volatility, 52-week range and volume stats match on every fixture', () => {
    const oracle = loadOracle();
    let comparisons = 0;
    let atrNull = 0;
    let atrNum = 0;
    for (const ticker of listFixtures()) {
      let raw;
      try {
        raw = loadRawFixture(ticker);
      } catch {
        continue;
      }
      if (!Array.isArray(raw.closes)) continue;
      // 15 is the first length ATR(14) can compute at (period + 1 bars).
      for (const len of [1, 2, 6, 14, 15, 22, 80, 253, raw.closes.length]) {
        if (len > raw.closes.length) continue;
        const ch = buildChart(raw, len);
        for (const p of [undefined, 0, 5, 14, 20]) {
          const expected = oracle.call<number | null>('computeATRV1', ch.highs, ch.lows, ch.closes, p);
          assert.equal(computeATRV1(ch.highs, ch.lows, ch.closes, p), expected,
            `${ticker}@${len} atr p=${p}`);
          expected == null ? atrNull++ : atrNum++;
          comparisons++;
        }
        for (const lb of [0, 5, 21, len, len + 1]) {
          assert.equal(trailingRangeVolatilityPctV1(ch.highs, ch.lows, ch.closes, lb),
            oracle.call('trailingRangeVolatilityPctV1', ch.highs, ch.lows, ch.closes, lb),
            `${ticker}@${len} rangeVol lb=${lb}`);
          assert.deepStrictEqual(volumeStatsV1(ch.volumes, lb),
            oracle.callNormalized('volumeStatsV1', ch.volumes, lb), `${ticker}@${len} volStats lb=${lb}`);
          comparisons += 2;
        }
        assert.deepStrictEqual(trailing52WeekRangeV1(ch.highs, ch.lows, ch.dates),
          oracle.callNormalized('trailing52WeekRangeV1', ch.highs, ch.lows, ch.dates),
          `${ticker}@${len} 52w`);
        comparisons++;
      }
    }
    assert.ok(comparisons > 2500, `only ${comparisons} comparisons`);
    assert.ok(atrNull > 0 && atrNum > 0, 'both ATR branches must occur');

    // ATR needs period+1 bars, and `period || 14` sends 0 to 14.
    const h = [2, 3, 4, 5, 6];
    const l = [1, 2, 3, 4, 5];
    const c = [1.5, 2.5, 3.5, 4.5, 5.5];
    assert.equal(computeATRV1(h, l, c, 4), 1.5);
    assert.equal(computeATRV1(h, l, c, 5), null, '5 bars cannot seed a 5-period ATR');
    assert.equal(computeATRV1(h, l, c, 0), null, 'period 0 falls back to 14');
    // The volume mean EXCLUDES today: [4,5] averaged, not [5,6].
    assert.deepStrictEqual(volumeStatsV1([1, 2, 3, 4, 5, 6], 2), { current: 6, avg: 4.5, relVol: 6 / 4.5 });
    // A zero mean yields relVol null, not Infinity.
    assert.equal(volumeStatsV1([0, 0, 7], 20)?.relVol, null);
    assert.equal(volumeStatsV1([5], 20), null, 'needs 2 bars');

    // Harness-only (production drops null-close bars, dataLayerV1.gs:311-314):
    // one null low in the trailing year poisons the 52-week LOW to null,
    // while a null high recovers. _VIX carries 182 null closes, which the
    // harness reuses as its highs/lows.
    if (listFixtures().includes('_VIX')) {
      const vix = loadChart('_VIX');
      const r = trailing52WeekRangeV1(vix.highs, vix.lows, vix.dates);
      assert.deepStrictEqual(r, oracle.callNormalized('trailing52WeekRangeV1', vix.highs, vix.lows, vix.dates));
      assert.equal(r?.low, null);
      assert.equal(typeof r?.high, 'number');
    }
  });

  test('the assembled ID card matches with every fund tier injected', () => {
    const oracle = loadOracle();
    // The vacuity trap: no fixture carries fundamentals, so without these
    // every fund-derived field would compare null to null.
    const floatsByTier = [5e6, 20e6, 40e6, 2e9];
    const funds: Array<StockIdCardFund | null> = [
      null,
      {},
      ...[3e12, 50e9, 5e9, 500e6, 100e6].flatMap((marketCap, i): StockIdCardFund[] => [
        { marketCap, shareFloat: floatsByTier[i % 4], sector: 'Technology', industry: 'Semiconductors', _sources: ['FMP', 'Finnhub'] },
        { marketCap, shareFloat: floatsByTier[(i + 1) % 4], sector: null, industry: null, _sources: [] },
      ]),
      { marketCap: null, shareFloat: null, sector: 'Energy', industry: 'Oil & Gas', _sources: ['AV'] },
    ];
    const seen = {
      cap: new Set<unknown>(), float: new Set<unknown>(), atrFlag: new Set<unknown>(),
      wk: new Set<unknown>(), mo: new Set<unknown>(), rv: new Set<unknown>(),
    };
    let comparisons = 0;
    for (const ticker of listFixtures()) {
      let raw;
      try {
        raw = loadRawFixture(ticker);
      } catch {
        continue;
      }
      if (!Array.isArray(raw.closes)) continue;
      for (const len of [30, 300, raw.closes.length]) {
        if (len > raw.closes.length) continue;
        const ch = buildChart(raw, len);
        for (const fund of funds) {
          // Legacy signature: (ticker, log, existingChart, existingFund).
          // A defined fund and a real chart mean legacy takes neither fetch.
          const expected = oracle.callNormalized<StockIdCard | null>(
            'buildStockIdCardV1', ticker, undefined, ch, fund,
          );
          assert.deepStrictEqual(buildStockIdCardV1(ticker, ch, fund), expected,
            `${ticker}@${len} fund=${JSON.stringify(fund)}`);
          comparisons++;
          if (!expected) continue;
          seen.cap.add(expected.marketCapTier);
          seen.float.add(expected.floatTier);
          seen.atrFlag.add(expected.atrFlag);
          seen.wk.add(expected.weeklyVolatilityRead?.tier);
          seen.mo.add(expected.monthlyVolatilityRead?.tier);
          seen.rv.add(expected.relativeVolumeRead);
        }
      }
    }
    assert.ok(comparisons > 900, `only ${comparisons} comparisons`);
    assert.equal(seen.cap.size, 6, 'all 5 market-cap tiers plus null');
    assert.equal(seen.float.size, 5, 'all 4 float tiers plus null');
    assert.equal(seen.atrFlag.size, 2, 'both ATR flags, on real charts');
    for (const k of ['wk', 'mo'] as const) {
      assert.ok(['Hot', 'Normal', 'Coiled'].every((t) => seen[k].has(t)), `${k}: ${[...seen[k]].join(',')}`);
    }
    // Both reads, plus null: a zero-volume window gives relVol null.
    assert.equal(seen.rv.size, 3);

    const ch = buildChart(loadRawFixture('AMD'), 300);
    // A fund object with a field ABSENT leaks `undefined`, not null, while
    // the DERIVED tiers (each with its own == null guard) stay null.
    const empty = buildStockIdCardV1('AMD', ch, {})!;
    for (const k of ['marketCap', 'floatShares', 'sector', 'industry', 'fundSources'] as const) {
      assert.equal(empty[k], undefined, `${k} should be undefined`);
    }
    assert.equal(empty.marketCapTier, null);
    assert.equal(empty.sharesOutstandingApprox, null);
    assert.equal(buildStockIdCardV1('AMD', ch, null)!.marketCap, null);
    // Shares outstanding is DERIVED from the live quote, not fetched.
    const mega = buildStockIdCardV1('AMD', ch, { marketCap: 3e12 })!;
    assert.equal(mega.sharesOutstandingApprox, 3e12 / ch.currentPrice);
    // Six disclosed gaps, always null.
    for (const k of ['exchange', 'companyName', 'hq', 'employees', 'revenueAbsolute', 'shortable'] as const) {
      assert.equal(mega[k], null);
    }
    // A zero quote nulls both ratios that divide by it.
    const zeroPx = { ...ch, currentPrice: 0 };
    const z = buildStockIdCardV1('AMD', zeroPx, { marketCap: 3e12 })!;
    assert.deepStrictEqual(z, oracle.callNormalized('buildStockIdCardV1', 'AMD', undefined, zeroPx, { marketCap: 3e12 }));
    assert.equal(z.atrPct, null);
    assert.equal(z.sharesOutstandingApprox, null);
    assert.ok(z.atr != null, 'ATR itself does not depend on the quote');
  });

  test('with no chart the card refuses and logs exactly what legacy logs', () => {
    const oracle = loadOracle();
    const portLog: string[] = [];
    const oracleLog: string[] = [];
    assert.equal(buildStockIdCardV1('ZZZ', null, null, (m) => portLog.push(m)), null);
    // Legacy falls back to fetchYahooChart, which returns null in the
    // sandbox (UrlFetchApp is a 404 stub) -- legacy's real failure branch.
    assert.equal(oracle.call('buildStockIdCardV1', 'ZZZ', (m: string) => oracleLog.push(m), null, null), null);
    assert.deepStrictEqual(portLog, oracleLog);
    assert.deepStrictEqual(portLog, ['  ID Card: chart fetch failed for ZZZ']);
    assert.equal(buildStockIdCardV1('ZZZ', null, null), null, 'no log callback is fine');
  });
});

describe('Broker Course P4 — gaps and reverse splits', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('gap detection matches on every fixture, at every threshold', () => {
    const oracle = loadOracle();
    let comparisons = 0;
    let gapsSeen = 0;
    const dirs = new Set<string>();
    for (const ticker of listFixtures()) {
      let raw;
      try {
        raw = loadRawFixture(ticker);
      } catch {
        continue;
      }
      if (!Array.isArray(raw.closes)) continue;
      for (const len of [1, 2, 30, 250, raw.closes.length]) {
        if (len > raw.closes.length) continue;
        const ch = buildChart(raw, len);
        for (const m of [undefined, null, 0.01, 0.02, 0.05]) {
          const expected = oracle.callNormalized<BrokerGap[]>('detectPriceGapsV1', ch.opens, ch.closes, ch.dates, m);
          assert.deepStrictEqual(detectPriceGapsV1(ch.opens, ch.closes, ch.dates, m), expected,
            `${ticker}@${len} min=${m}`);
          comparisons++;
          gapsSeen += expected.length;
          for (const g of expected) dirs.add(g.type);
        }
      }
    }
    assert.ok(comparisons > 500, `only ${comparisons} comparisons`);
    assert.ok(gapsSeen > 10000, `only ${gapsSeen} gaps`);
    assert.deepStrictEqual([...dirs].sort(), ['DOWN', 'UP']);

    const d = [0, 1, 2].map((i) => new Date(Date.UTC(2024, 0, 2 + i)));
    // Exactly 2% is a gap: inclusive, and 0.02 is the default.
    const exact = detectPriceGapsV1([100, 102, 100], [100, 100, 100], d);
    assert.deepStrictEqual(exact, [{ idx: 1, date: d[1], type: 'UP', sizePct: 0.02, level: 100 }]);
    assert.deepStrictEqual(exact, oracle.callNormalized('detectPriceGapsV1', [100, 102, 100], [100, 100, 100], d));
    // With a 0 threshold an unchanged open is a zero-size DOWN gap.
    const zero = detectPriceGapsV1([100, 100], [100, 100], d.slice(0, 2), 0);
    assert.equal(zero[0]?.type, 'DOWN');
    assert.equal(zero[0]?.sizePct, 0);
    assert.deepStrictEqual(zero, oracle.callNormalized('detectPriceGapsV1', [100, 100], [100, 100], d.slice(0, 2), 0));
    // A zero prior close is skipped, not divided by.
    assert.deepStrictEqual(detectPriceGapsV1([100, 150], [0, 150], d.slice(0, 2)), []);

    // Harness-only: _VIX's opens ARE its closes (an index, no real opens)
    // and carry 182 nulls; each null open after a real close coerces to 0
    // and reads as a -100% DOWN gap. Production cannot reach this --
    // fetchYahooChartRaw_ drops null-close bars and backfills null opens
    // (dataLayerV1.gs:311-314) -- so it is pinned here, not registered.
    if (listFixtures().includes('_VIX')) {
      const vix = loadChart('_VIX');
      const phantom = detectPriceGapsV1(vix.opens, vix.closes, vix.dates).filter((g) => g.sizePct === -1);
      assert.equal(phantom.length, 181);
    }
  });

  test('all five gap types classify exactly as the oracle does, on real gaps', () => {
    const oracle = loadOracle();
    const types = new Map<string, number>();
    const flagCombos: Array<[boolean, boolean]> = [[true, true], [false, false], [true, false], [false, true]];
    let comparisons = 0;
    let flagSensitiveFirstThree = 0;
    let cloneChecks = 0;
    for (const ticker of listFixtures()) {
      let raw;
      try {
        raw = loadRawFixture(ticker);
      } catch {
        continue;
      }
      if (!Array.isArray(raw.closes)) continue;
      const n = raw.closes.length;
      for (const len of [30, 80, 250, 600, n]) {
        if (len > n) continue;
        const ch = buildChart(raw, len);
        const gaps = detectPriceGapsV1(ch.opens, ch.closes, ch.dates, 0.02);
        // Every gap on the shorter charts; on full history only the latest
        // 40. The classifier rescans swings on every call, so all ~19,500
        // real gaps would cost ~14s on the oracle side alone.
        const sample = len === n && n > 600 ? gaps.slice(-40) : gaps;
        for (const g of sample) {
          const results: string[] = [];
          for (const [ath, down] of flagCombos) {
            const expected = oracle.call<string>('classifyGapTypeV1',
              g, gaps, ch.highs, ch.lows, ch.volumes, ch.closes, ath, down);
            assert.equal(classifyGapTypeV1(g, gaps, ch.highs, ch.lows, ch.volumes, ch.closes, ath, down),
              expected, `${ticker}@${len} gap@${g.idx} ath=${ath} down=${down}`);
            comparisons++;
            types.set(expected, (types.get(expected) ?? 0) + 1);
            results.push(expected);
          }
          const firstThree = results.some((r) => r === 'Breakaway' || r === 'Exhaustion' || r === 'Island');
          if (firstThree && new Set(results).size > 1) flagSensitiveFirstThree++;
        }
        // `other !== gap` is redundant: `other.type !== gap.type` already
        // excludes the gap itself, so a COPY classifies identically.
        const last = gaps[gaps.length - 1];
        if (last) {
          assert.equal(
            classifyGapTypeV1(structuredClone(last), gaps, ch.highs, ch.lows, ch.volumes, ch.closes, false, false),
            classifyGapTypeV1(last, gaps, ch.highs, ch.lows, ch.volumes, ch.closes, false, false),
          );
          cloneChecks++;
        }
      }
    }
    assert.ok(comparisons > 20000, `only ${comparisons} comparisons`);
    assert.deepStrictEqual([...types.keys()].sort(),
      ['Breakaway', 'Common', 'Exhaustion', 'Island', 'Runaway']);
    // EQUAL by construction: a gap that reaches the runaway test reads
    // Runaway in exactly 2 of the 4 flag combinations (its own direction's
    // flag true) and Common in the other 2.
    assert.equal(types.get('Runaway'), types.get('Common'));
    // The first three tests never look at the context flags.
    assert.equal(flagSensitiveFirstThree, 0);
    assert.ok(cloneChecks > 50);
    assert.equal(classifyGapTypeV1(null, [], [], [], [], [], true, true), null);
  });

  test('market-cap significance has one real number, for one tier', () => {
    const oracle = loadOracle();
    const tiers = ['Mega Cap', 'Large Cap', 'Mid Cap', 'Small Cap', 'Tiny/Micro Cap', '', null, undefined];
    const sizes = [null, undefined, 0, 0.0299, 0.03, -0.03, 0.1, -0.1, 0.5];
    const outputs = new Set<string | null>();
    for (const t of tiers) {
      for (const s of sizes) {
        const expected = oracle.call<string | null>('gapMarketCapSignificanceV1', s, t);
        assert.equal(gapMarketCapSignificanceV1(s, t), expected, `size=${s} tier=${t}`);
        outputs.add(expected);
      }
    }
    // Two Mega arms, four informational tiers, and null.
    assert.equal(outputs.size, 7);
    assert.match(gapMarketCapSignificanceV1(0.03, 'Mega Cap')!, /^Mega-cap gap >=3% — significant/);
    assert.match(gapMarketCapSignificanceV1(-0.03, 'Mega Cap')!, /^Mega-cap gap >=3% — significant/,
      'direction-blind');
    assert.match(gapMarketCapSignificanceV1(0.0299, 'Mega Cap')!, /likely not significant/);
    assert.match(gapMarketCapSignificanceV1(0.5, 'Small Cap')!, /informational only/,
      'even a 50% gap gets no verdict below Mega');
    assert.equal(gapMarketCapSignificanceV1(0.05, ''), null);
  });

  test('earnings tagging: nearest report within the window, causality-blind', () => {
    const oracle = loadOracle();
    const D = (y: number, m: number, d: number, h = 0, mi = 0): Date => new Date(Date.UTC(y, m - 1, d, h, mi));
    const E = (date: Date, ea: number | null, ee: number | null, ra: number | null, re: number | null): EarningsEvent =>
      ({ date, epsActual: ea, epsEstimated: ee, revenueActual: ra, revenueEstimated: re });
    // Wednesday 2024-05-15. Synthetic throughout: no fixture carries an
    // earnings history, and every case below was probed on the oracle first.
    const gap: BrokerGap = { idx: 10, date: D(2024, 5, 15), type: 'UP', sizePct: 0.05, level: 100 };
    // Production bar timestamps are intraday, not midnight.
    const gapIntraday: BrokerGap = { ...gap, date: D(2024, 5, 15, 14, 30) };
    const mondayGap: BrokerGap = { ...gap, date: D(2024, 5, 13) };
    const cases: Array<[string, BrokerGap, EarningsEvent[] | null, number | null | undefined]> = [
      ['same day', gap, [E(D(2024, 5, 15), 1.2, 1.0, 110, 100)], 1],
      ['previous day (after-close report)', gap, [E(D(2024, 5, 14), 1.2, 1.0, 110, 100)], 1],
      ['next day (report AFTER the gap)', gap, [E(D(2024, 5, 16), 1.2, 1.0, 110, 100)], 1],
      ['two days off', gap, [E(D(2024, 5, 13), 1.2, 1.0, 110, 100)], 1],
      ['Friday report, Monday gap', mondayGap, [E(D(2024, 5, 10), 1.2, 1.0, 110, 100)], 1],
      ['nearest wins', gap, [E(D(2024, 5, 14), 9, 1, null, null), E(D(2024, 5, 15), 1.2, 1.0, 110, 100)], 1],
      ['equidistant: first listed wins', gap,
        [E(D(2024, 5, 16), 2, 1, null, null), E(D(2024, 5, 14), 3, 1, null, null)], 1],
      ['zero estimates', gap, [E(D(2024, 5, 15), 0.1, 0, 110, 0)], 1],
      ['missing actuals', gap, [E(D(2024, 5, 15), null, 1, null, 100)], 1],
      ['negative estimate', gap, [E(D(2024, 5, 15), -0.25, -0.5, null, null)], 1],
      ['tolerance undefined', gap, [E(D(2024, 5, 14), 1, 1, 1, 1)], undefined],
      ['tolerance null', gap, [E(D(2024, 5, 14), 1, 1, 1, 1)], null],
      ['tolerance 0, same day', gap, [E(D(2024, 5, 15), 1, 1, 1, 1)], 0],
      ['tolerance 0, previous day', gap, [E(D(2024, 5, 14), 1, 1, 1, 1)], 0],
      ['tolerance 3, Friday -> Monday', mondayGap, [E(D(2024, 5, 10), 1, 1, 1, 1)], 3],
      ['empty history', gap, [], 1],
      ['null history', gap, null, 1],
    ];
    let matched = 0;
    for (const [label, g, h, tol] of cases) {
      const expected = oracle.callNormalized<unknown>('classifyEarningsGapV1', g, h, tol);
      assert.deepStrictEqual(classifyEarningsGapV1(g, h, tol), expected, label);
      if (g === gap) {
        assert.deepStrictEqual(classifyEarningsGapV1(gapIntraday, h, tol), expected, label + ' (intraday)');
      }
      // The engine's original, at the production tolerance: identical.
      if (tol === 1 && h) {
        assert.deepStrictEqual(expected, oracle.callNormalized('classifyGapCauseV7', g, h), label + ' vs engine');
      }
      if (expected) matched++;
    }
    assert.equal(matched, 12);
    assert.equal(classifyEarningsGapV1(null, [E(D(2024, 5, 15), 1, 1, 1, 1)]), null);

    const at1 = (h: EarningsEvent[], g: BrokerGap = gap) => classifyEarningsGapV1(g, h, 1);
    assert.ok(at1([E(D(2024, 5, 16), 1, 1, 1, 1)]), 'a report the day AFTER the gap is still tagged as its cause');
    assert.equal(at1([E(D(2024, 5, 10), 1, 1, 1, 1)], mondayGap), null,
      'a Friday report against a Monday gap is missed at the production tolerance');
    assert.equal(at1([E(D(2024, 5, 16), 2, 1, null, null), E(D(2024, 5, 14), 3, 1, null, null)])?.reportDate.getTime(),
      D(2024, 5, 16).getTime(), 'equidistant: the first listed wins, even though it is the later report');
    assert.equal(at1([E(D(2024, 5, 15), 0.1, 0, 110, 0)])?.epsSurprisePct, null, 'a $0.00 estimate is falsy');
    assert.equal(at1([E(D(2024, 5, 15), -0.25, -0.5, null, null)])?.epsSurprisePct, 50,
      'a beat on a negative estimate reads positive');
    assert.equal(at1([E(D(2024, 5, 15), 1.2, 1.0, 110, 100)])?.revenueSurprisePct, 10);
  });

  test('the reverse-split flag walks its real 60-bar boundary on CQZB and HQZA', () => {
    const oracle = loadOracle();
    const fx = listFixtures();
    let boundaryChecks = 0;
    for (const ticker of ['CQZB', 'HQZA']) {
      if (!fx.includes(ticker)) continue;
      const full = loadChart(ticker);
      const s = full.splits.find((x) => x.numerator < x.denominator)!;
      // The first bar on or after the split.
      const si = full.dates.findIndex((d) => d >= s.date);
      for (const k of [-5, -1, 0, 1, 30, 59, 60, 61, 100]) {
        const L = si + k + 1;
        const dates = full.dates.slice(0, L);
        const got = reverseSplitAvoidFlagV1(full.splits, dates, L - 1);
        assert.deepStrictEqual(got, oracle.callNormalized('reverseSplitAvoidFlagV1', full.splits, dates, L - 1),
          `${ticker} k=${k}`);
        if (k <= 59) {
          assert.ok(got, `${ticker}: ${k} bars after the split should still flag`);
          assert.match(got.read, /^Recent reverse split \(1:\d+, -?\d+d ago\)/);
        } else {
          assert.equal(got, null, `${ticker}: ${k} bars after the split should have cleared`);
        }
        // No upper bound on the split date: before the split bar the flag
        // still fires, with a negative daysAgo. Production cannot see a
        // future split; a truncated test chart can.
        if (k === -5) assert.ok(got!.daysAgo < 0);
        boundaryChecks++;
      }
    }
    assert.equal(boundaryChecks, 18, 'both real reverse splits must be present');

    // Forward splits never flag, on any fixture, near any split.
    let forwardChecks = 0;
    for (const ticker of fx) {
      const full = loadChart(ticker);
      for (const s of full.splits.filter((x) => x.numerator >= x.denominator)) {
        const si = full.dates.findIndex((d) => d >= s.date);
        if (si < 0) continue;
        for (const k of [0, 1, 30]) {
          const L = Math.min(si + k + 1, full.closes.length);
          const dates = full.dates.slice(0, L);
          assert.equal(reverseSplitAvoidFlagV1(full.splits, dates, L - 1), null, `${ticker} forward k=${k}`);
          assert.equal(oracle.call('reverseSplitAvoidFlagV1', full.splits, dates, L - 1), null);
          forwardChecks++;
        }
      }
    }
    assert.ok(forwardChecks >= 30, `only ${forwardChecks} forward-split checks`);

    // `lastIdx` is an INDEX. Passing the length reads past the end: "NaNd ago".
    if (fx.includes('HQZA')) {
      const full = loadChart('HQZA');
      const si = full.dates.findIndex((d) => d >= full.splits[0].date);
      const dates = full.dates.slice(0, si + 10);
      const byLength = reverseSplitAvoidFlagV1(full.splits, dates, dates.length);
      assert.deepStrictEqual(byLength,
        oracle.callNormalized('reverseSplitAvoidFlagV1', full.splits, dates, dates.length));
      assert.ok(Number.isNaN(byLength?.daysAgo));
      assert.match(byLength!.read, /NaNd ago/);
    }
    assert.equal(reverseSplitAvoidFlagV1(null, [new Date()], 0), null);
    assert.equal(reverseSplitAvoidFlagV1([], [new Date()], 0), null);
    assert.equal(reverseSplitAvoidFlagV1([{ date: new Date(), numerator: 1, denominator: 10 }], [], 0), null);
  });

  test('F-23: the broker and engine reverse-split copies disagree on one bar per split', () => {
    const oracle = loadOracle();
    const fx = listFixtures();
    const disagreements: string[] = [];
    let compared = 0;
    for (const ticker of ['CQZB', 'HQZA']) {
      if (!fx.includes(ticker)) continue;
      const full = loadChart(ticker);
      for (let L = 61; L <= full.closes.length; L++) {
        const dates = full.dates.slice(0, L);
        // Production-shaped calls. The engine passes n = closes.length
        // (computeAllIndicators :6250 -> :7761); the broker report passes
        // n = closes.length - 1 (:1894 -> :2047).
        const engine = recentReverseSplit(full.splits, dates, L);
        const broker = reverseSplitAvoidFlagV1(full.splits, dates, L - 1);
        compared++;
        if ((engine == null) !== (broker == null)) {
          // Each side re-checked against its own legacy original.
          assert.equal(oracle.call('recentReverseSplitV7', full.splits, dates, L) == null, engine == null);
          assert.equal(oracle.call('reverseSplitAvoidFlagV1', full.splits, dates, L - 1) == null, broker == null);
          disagreements.push(`${ticker} ${dates[L - 1].toISOString().slice(0, 10)} engine=${engine ? 'flag' : 'null'} broker=${broker ? broker.daysAgo + 'd' : 'null'}`);
        } else if (engine && broker) {
          assert.equal(engine.daysAgo, broker.daysAgo, 'when both flag they agree on the age');
        }
      }
    }
    assert.ok(compared > 4000, `only ${compared} bars compared`);
    assert.equal(disagreements.length, 2, disagreements.join('; '));
    // Always the same direction: the broker's window is the wider one.
    assert.ok(disagreements.every((d) => d.includes('engine=null')), disagreements.join('; '));
  });
});
