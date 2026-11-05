/**
 * FL-10a: direct legacy-vs-port tests for indicator slice functions that were
 * only covered through computeAllIndicators:
 *   asymmetricVolumeConfirmationV1_, singleCandleClassifyV7, trendMaturityV7,
 *   volatilityHotColdV7, detectDivergence, srLevelsV7, resampleHighLowV7,
 *   srMultiTimeframeConfluenceV7, wyckoffSchematicV7.
 *
 * FINDING (cosmetic): with no volumes, legacy srLevelsV7 returns every level
 * with an own key volumeWeightedStrength whose value is undefined; the port
 * omits the key. They are identical as JSON, so that case is compared after a
 * JSON round trip, and the with-volumes case is compared strictly.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent, type OracleChart } from './fixtures.ts';
import { volatilityHotCold, detectDivergence, singleCandleClassify, trendMaturity } from '../src/analysis/indicators/slices.ts';
import { asymmetricVolumeConfirmation, computeChartPatterns } from '../src/analysis/indicators/chartPatterns.ts';
import { srLevels, resampleHighLow, srMultiTimeframeConfluence } from '../src/analysis/indicators/srLevels.ts';
import { wyckoffSchematic } from '../src/analysis/indicators/wyckoff.ts';

const ready = legacyFilesPresent() && fixturesPresent();
const skip = ready ? false : 'legacy/ or fixtures not populated';

function fixtureCharts(lengths: number[]): Array<{ ticker: string; len: number; chart: OracleChart }> {
  const out: Array<{ ticker: string; len: number; chart: OracleChart }> = [];
  for (const ticker of listFixtures()) {
    let raw;
    try {
      raw = loadRawFixture(ticker);
    } catch {
      continue;
    }
    if (!Array.isArray(raw.closes) || !Array.isArray(raw.highs) || !Array.isArray(raw.lows) || raw.closes.length < 250) continue;
    for (const len of [...lengths, raw.closes.length]) {
      if (len > raw.closes.length) continue;
      out.push({ ticker, len, chart: buildChart(raw, len) });
    }
  }
  return out;
}

function rngOf(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const json = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('FL-10a indicator slices: asymmetric volume and volatility band', { skip }, () => {
  test('asymmetricVolumeConfirmation matches asymmetricVolumeConfirmationV1_', () => {
    const oracle = loadOracle();
    const dirs: unknown[] = ['up', 'down', 'sideways', '', null];
    const bos: unknown[] = [null, undefined, 0, 49, 50, 64.9, 65, 65.0001, 100, NaN];
    const avgs: unknown[] = [50, 0, -1, NaN, undefined, null, 0.0001];
    for (const d of dirs) for (const b of bos) for (const a of avgs) {
      assert.deepStrictEqual(
        asymmetricVolumeConfirmation(d as never, b as never, a as never),
        oracle.callNormalized('asymmetricVolumeConfirmationV1_', d, b, a),
        JSON.stringify([d, b, a]),
      );
    }
  });

  test('volatilityHotCold matches volatilityHotColdV7', () => {
    const oracle = loadOracle();
    const vals: unknown[] = [null, undefined, 0, 0.0299, 0.03, 0.0300001, 0.04, 0.05, 0.0500001, 0.08, 1, -0.01, NaN];
    for (const v of vals) {
      assert.deepStrictEqual(volatilityHotCold(v as never), oracle.callNormalized('volatilityHotColdV7', v), String(v));
    }
    for (let p = 0; p <= 0.12; p += 0.0005) {
      assert.deepStrictEqual(volatilityHotCold(p), oracle.callNormalized('volatilityHotColdV7', p), String(p));
    }
  });
});

describe('FL-10a indicator slices: candle and trend maturity', { skip }, () => {
  test('singleCandleClassify matches singleCandleClassifyV7 on a grid and on every real bar', () => {
    const oracle = loadOracle();
    const seen = new Set<string>();
    const px = [90, 91, 95, 99, 100, 101, 105, 109, 110];
    for (const o of px) for (const c of px) {
      const got = singleCandleClassify(o, 110, 90, c);
      assert.deepStrictEqual(got, oracle.callNormalized('singleCandleClassifyV7', o, 110, 90, c), `grid ${o}/${c}`);
      seen.add(got ? got.type : 'null');
    }
    for (const t of ['DRAGONFLY_DOJI', 'GRAVESTONE_DOJI', 'LONG_LEGGED_DOJI', 'DOJI', 'FULL_MARUBOZU', 'HAMMER_COURSE_TERM', 'INVERTED_HAMMER_COURSE_TERM']) {
      assert.ok(seen.has(t), `grid never produced ${t}`);
    }
    // Missing and degenerate inputs.
    const odd: unknown[][] = [
      [null, 1, 1, 1], [1, null, 1, 1], [1, 1, null, 1], [1, 1, 1, null], [undefined, 1, 1, 1],
      [100, 100, 100, 100], [100, 90, 110, 100], [NaN, 110, 90, 100], [100, 110, 90, NaN], [120, 110, 90, 100],
    ];
    for (const a of odd) {
      assert.deepStrictEqual(
        singleCandleClassify(a[0] as never, a[1] as never, a[2] as never, a[3] as never),
        oracle.callNormalized('singleCandleClassifyV7', ...a),
        JSON.stringify(a),
      );
    }
    let bars = 0;
    for (const { chart } of fixtureCharts([])) {
      for (let i = 0; i < chart.closes.length; i++) {
        assert.deepStrictEqual(
          singleCandleClassify(chart.opens[i] as number, chart.highs[i] as number, chart.lows[i] as number, chart.closes[i] as number),
          oracle.callNormalized('singleCandleClassifyV7', chart.opens[i], chart.highs[i], chart.lows[i], chart.closes[i]),
          `${chart.ticker} bar ${i}`,
        );
        bars++;
      }
    }
    assert.ok(bars > 1000);
  });

  test('trendMaturity matches trendMaturityV7 on real series, truncations and synthetic shapes', () => {
    const oracle = loadOracle();
    let nonNull = 0;
    for (const len of [0, 1, 199, 200, 201]) {
      const closes = Array.from({ length: len }, (_, i) => 100 + i);
      assert.deepStrictEqual(trendMaturity(closes), oracle.callNormalized('trendMaturityV7', closes), `rising ${len}`);
    }
    const synth: Array<[string, number[]]> = [
      ['flat', Array(300).fill(100)],
      ['rising', Array.from({ length: 400 }, (_, i) => 100 + i)],
      ['falling', Array.from({ length: 400 }, (_, i) => 1000 - i)],
      ['oscillating', Array.from({ length: 700 }, (_, i) => 100 + 40 * Math.sin(i / 40))],
      ['slow oscillation', Array.from({ length: 900 }, (_, i) => 100 + 30 * Math.sin(i / 90) + i * 0.01)],
    ];
    for (const [label, closes] of synth) {
      const got = trendMaturity(closes);
      assert.deepStrictEqual(got, oracle.callNormalized('trendMaturityV7', closes), label);
      if (got) nonNull++;
    }
    for (const { ticker, len, chart } of fixtureCharts([150, 199, 200, 201, 260, 400, 800])) {
      const got = trendMaturity(chart.closes);
      assert.deepStrictEqual(got, oracle.callNormalized('trendMaturityV7', chart.closes), `${ticker}@${len}`);
      if (got) nonNull++;
    }
    assert.ok(nonNull > 20, `only ${nonNull} non-null reads`);
  });
});

describe('FL-10a indicator slices: divergence', { skip }, () => {
  test('detectDivergence matches the oracle across windows, oscillators, look-backs and labels', () => {
    const oracle = loadOracle();
    const looks: unknown[] = [undefined, 0, 19, 20, 30, 60, 100, 500];
    const labels: unknown[] = [undefined, 'MACD', 'OBV', ''];
    const seen = new Set<string>();
    let n = 0;
    for (const { chart } of fixtureCharts([250])) {
      const closes = chart.closes;
      const r = rngOf(closes.length);
      const oscA = closes.map((c, i) => (i < 5 ? 0 : c - (closes[i - 5] as number)));
      const oscB = closes.map((_, i) => Math.sin(i / 6) * 40 + 50);
      const oscC = closes.map(() => r() * 100);
      for (let end = 130; end <= closes.length; end += 61) {
        const c = closes.slice(0, end);
        for (const osc of [oscA, oscB, oscC]) {
          const o = osc.slice(0, end);
          for (const look of looks) for (const label of labels) {
            const got = detectDivergence(c, o, look as number, label as string);
            assert.deepStrictEqual(got, oracle.callNormalized('detectDivergence', c, o, look, label), `end ${end} look ${String(look)} ${String(label)}`);
            seen.add(got.type);
            n++;
          }
        }
      }
    }
    assert.ok(n > 1000, `only ${n} comparisons`);
    assert.ok(seen.size >= 2, `only result types ${[...seen].join(',')} seen`);
  });

  test('detectDivergence edge inputs: short series, mismatched lengths, empty, NaN', () => {
    const oracle = loadOracle();
    const c = Array.from({ length: 80 }, (_, i) => 100 + 5 * Math.sin(i / 4));
    const cases: Array<[number[], number[], number]> = [
      [[], [], 60], [[1, 2, 3], [1, 2, 3], 60], [c, c.slice(0, 50), 60], [c.slice(0, 50), c, 60],
      [c.map((x, i) => (i === 40 ? NaN : x)), c, 60], [c, c.map(() => 50), 60],
    ];
    for (const [a, b, look] of cases) {
      assert.deepStrictEqual(detectDivergence(a, b, look), oracle.callNormalized('detectDivergence', a, b, look));
    }
  });
});

describe('FL-10a indicator slices: support and resistance', { skip }, () => {
  test('srLevels matches srLevelsV7: with volumes strictly, without volumes after a JSON round trip', () => {
    const oracle = loadOracle();
    const trends: unknown[] = [undefined, 'up', 'down', 'flat'];
    let levels = 0;
    for (const { ticker, len, chart } of fixtureCharts([60, 100, 201, 400])) {
      for (const t of trends) {
        const w = `${ticker}@${len} trend ${String(t)}`;
        const got = srLevels(chart.highs, chart.lows, t as never, chart.volumes);
        assert.deepStrictEqual(got, oracle.callNormalized('srLevelsV7', chart.highs, chart.lows, t, chart.volumes), w + ' with volumes');
        levels += got.resistanceLevels.length + got.supportLevels.length;
        // FINDING: legacy keeps volumeWeightedStrength as an undefined-valued key here; the port omits it.
        for (const v of [undefined, [] as number[]]) {
          const g2 = srLevels(chart.highs, chart.lows, t as never, v);
          const e2 = oracle.callNormalized('srLevelsV7', chart.highs, chart.lows, t, v);
          assert.deepStrictEqual(json(g2), json(e2), w + ' without volumes');
        }
      }
    }
    assert.ok(levels > 500, `only ${levels} levels compared`);
    const short = srLevels(Array(8).fill(100), Array(8).fill(99));
    assert.deepStrictEqual(json(short), json(oracle.callNormalized('srLevelsV7', Array(8).fill(100), Array(8).fill(99))));
    assert.deepStrictEqual(json(srLevels([], [])), json(oracle.callNormalized('srLevelsV7', [], [])));
  });

  test('resampleHighLow matches resampleHighLowV7 for several group sizes and lengths', () => {
    const oracle = loadOracle();
    const r = rngOf(5);
    for (const len of [0, 1, 4, 5, 6, 21, 22, 100, 253]) {
      const highs = Array.from({ length: len }, () => 100 + r() * 20);
      const lows = highs.map((h) => h - r() * 5);
      for (const g of [1, 2, 3, 5, 21, 400]) {
        assert.deepStrictEqual(resampleHighLow(highs, lows, g), oracle.callNormalized('resampleHighLowV7', highs, lows, g), `len ${len} group ${g}`);
      }
    }
    for (const { ticker, len, chart } of fixtureCharts([250])) {
      for (const g of [5, 21]) {
        assert.deepStrictEqual(resampleHighLow(chart.highs, chart.lows, g), oracle.callNormalized('resampleHighLowV7', chart.highs, chart.lows, g), `${ticker}@${len} g${g}`);
      }
    }
  });

  test('srMultiTimeframeConfluence matches srMultiTimeframeConfluenceV7, all strengths seen', () => {
    const oracle = loadOracle();
    const strengths = new Set<string>();
    for (const { ticker, len, chart } of fixtureCharts([60, 100, 201, 250, 400])) {
      const got = srMultiTimeframeConfluence(chart.highs, chart.lows);
      assert.deepStrictEqual(got, oracle.callNormalized('srMultiTimeframeConfluenceV7', chart.highs, chart.lows), `${ticker}@${len}`);
      for (const s of [got.resistance, got.support]) if (s) strengths.add(s.strength);
    }
    assert.ok(strengths.size >= 2, `only ${[...strengths].join(',')} observed`);
    for (const [h, l] of [[[], []], [Array(8).fill(100), Array(8).fill(99)]] as Array<[number[], number[]]>) {
      assert.deepStrictEqual(srMultiTimeframeConfluence(h, l), oracle.callNormalized('srMultiTimeframeConfluenceV7', h, l));
    }
  });
});

// ── Wyckoff: synthetic trading ranges (no real fixture yields a RECTANGLE) ──

interface Synth {
  closes: number[]; highs: number[]; lows: number[]; opens: number[]; volumes: number[]; dates: Date[];
  splits: never[]; ipoDate: Date; ticker: string; currentPrice: number; prevClose: number; currency: string;
}

function buildRectChart(nBars: number, climaxAt: number, climaxVolMult: number, tailBreak = false, finalVolMult = 1): Synth {
  const closes: number[] = [], highs: number[] = [], lows: number[] = [], opens: number[] = [], volumes: number[] = [], dates: Date[] = [];
  const base = new Date('2024-01-01T00:00:00Z');
  for (let i = 0; i < nBars; i++) {
    const t = (i % 20) / 20;
    let c = 103 + 3 * Math.sin(t * 2 * Math.PI);
    if (tailBreak && i >= nBars - 2) c = 108;
    let hi = c + 0.3;
    let lo = c - 0.3;
    if (i === climaxAt) {
      c = (closes[i - 1] as number) - 1.0;
      lo = c - 0.5;
      hi = c + 0.1;
    }
    closes.push(c); opens.push(c); highs.push(hi); lows.push(lo);
    volumes.push(i === climaxAt ? 1_000_000 * climaxVolMult : i === nBars - 1 ? 1_000_000 * finalVolMult : 1_000_000);
    dates.push(new Date(base.getTime() + i * 86400000));
  }
  return { closes, highs, lows, opens, volumes, dates, splits: [], ipoDate: dates[0] as Date, ticker: 'SYNTH', currentPrice: closes[nBars - 1] as number, prevClose: closes[nBars - 2] as number, currency: 'USD' };
}

function volRatioOf(c: { volumes: number[] }): number {
  const n = c.volumes.length;
  const v20 = c.volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return v20 > 0 ? (c.volumes[n - 1] as number) / (v20 || 1) : 1;
}

describe('FL-10a indicator slices: wyckoffSchematic', { skip }, () => {
  test('wyckoffSchematic matches wyckoffSchematicV7 on synthetic ranges, with several volume ratios', () => {
    const oracle = loadOracle();
    const cases: Array<[string, Synth]> = [
      ['flat range, no climax', buildRectChart(200, -1, 1)],
      ['climax at 120', buildRectChart(200, 120, 5)],
      ['climax at 150, breaks up', buildRectChart(200, 150, 5, true)],
      ['climax before scan window', buildRectChart(220, 100, 8)],
      ['SOS: break on heavy volume', buildRectChart(200, 150, 5, true, 2.0)],
      ['break on light volume', buildRectChart(200, 150, 5, true, 0.5)],
      ['too short', buildRectChart(70, 60, 5)],
    ];
    let nonNull = 0;
    for (const [label, chart] of cases) {
      const patterns = computeChartPatterns(chart as never);
      for (const vr of [volRatioOf(chart), 0.5, 1, 1.3, 1.31, 2]) {
        const got = wyckoffSchematic(chart as never, vr, patterns);
        const expected = oracle.callNormalized('wyckoffSchematicV7', chart.dates, chart.closes, chart.highs, chart.lows, chart.volumes, vr, patterns);
        assert.deepStrictEqual(got, expected, `${label} volRatio ${vr}`);
        if (got) nonNull++;
      }
      for (const p of [null, [] as never[]]) {
        assert.deepStrictEqual(
          wyckoffSchematic(chart as never, 1, p),
          oracle.callNormalized('wyckoffSchematicV7', chart.dates, chart.closes, chart.highs, chart.lows, chart.volumes, 1, p),
          `${label} patterns ${String(p)}`,
        );
      }
    }
    assert.ok(nonNull >= 2, `only ${nonNull} non-null results, verification would be vacuous`);
  });

  test('wyckoffSchematic matches the oracle on real fixtures (mostly null paths)', () => {
    const oracle = loadOracle();
    let n = 0;
    for (const { ticker, len, chart } of fixtureCharts([250, 400])) {
      const patterns = computeChartPatterns(chart as never);
      const vr = volRatioOf(chart);
      assert.deepStrictEqual(
        wyckoffSchematic(chart as never, vr, patterns),
        oracle.callNormalized('wyckoffSchematicV7', chart.dates, chart.closes, chart.highs, chart.lows, chart.volumes, vr, patterns),
        `${ticker}@${len}`,
      );
      n++;
    }
    assert.ok(n > 10);
  });
});
