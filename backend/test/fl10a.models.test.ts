/**
 * FL-10a: direct legacy-vs-port tests for model helpers that were only
 * covered through their parent report builders:
 *   schabackerSRTrendLineReadV1_, schabackerTradingTacticsV1_ (schabackerModelV1.gs)
 *   turtleShadowS1OutcomeV1_ (turtleModelV1.gs).
 * The port of schabackerSRTrendLineReadV1_ drops the unused `confluence`
 * parameter (finding F-19, already documented), so the oracle is given null.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import { schabackerSrTrendLineRead, schabackerTradingTactics } from '../src/analysis/models/schabacker.ts';
import { turtleShadowS1Outcome } from '../src/analysis/models/turtle.ts';

const ready = legacyFilesPresent() && fixturesPresent();
const skip = ready ? false : 'legacy/ or fixtures not populated';

function fixtureRaws(): Array<{ ticker: string; raw: ReturnType<typeof loadRawFixture> }> {
  const out: Array<{ ticker: string; raw: ReturnType<typeof loadRawFixture> }> = [];
  for (const ticker of listFixtures()) {
    try {
      const raw = loadRawFixture(ticker);
      if (Array.isArray(raw.closes) && Array.isArray(raw.highs) && Array.isArray(raw.lows) && raw.closes.length >= 250) out.push({ ticker, raw });
    } catch {
      /* skip unreadable fixture */
    }
  }
  return out;
}

describe('FL-10a models: Schabacker', { skip }, () => {
  test('schabackerSrTrendLineRead matches schabackerSRTrendLineReadV1_ on real indicators', () => {
    const oracle = loadOracle();
    let weighted = 0;
    let halfway = 0;
    for (const { ticker, raw } of fixtureRaws()) {
      for (const len of [250, raw.closes.length]) {
        if (len > raw.closes.length) continue;
        const chart = buildChart(raw, len);
        const rawInd = oracle.call<Record<string, unknown>>('computeAllIndicators', chart);
        const got = schabackerSrTrendLineRead(structuredClone(rawInd) as never);
        assert.deepStrictEqual(got, oracle.callNormalized('schabackerSRTrendLineReadV1_', rawInd, null), `${ticker}@${len}`);
        weighted += got.memoryFactor.resistance.length + got.memoryFactor.support.length;
        if (got.halfway) halfway++;
      }
    }
    assert.ok(weighted > 0, 'no volume-weighted levels seen, memoryFactor branch untested');
    assert.ok(halfway >= 0);
  });

  test('schabackerSrTrendLineRead matches on synthetic indicator objects (missing, null and zero fields)', () => {
    const oracle = loadOracle();
    const lv = (level: number, touchCount: number, v: unknown) => ({ level, touchCount, tier: 'Minor', volumeWeightedStrength: v });
    const inds: Array<Record<string, unknown>> = [
      {},
      { srLevels: null },
      { srLevels: {} },
      { srLevels: { resistanceLevels: [], supportLevels: [] } },
      { srLevels: { resistanceLevels: [lv(100, 3, 5000), lv(110, 2, null), lv(120, 2, undefined), lv(130, 2, 0)], supportLevels: [lv(90, 4, 1)] } },
      { srLevels: { resistanceLevels: undefined, supportLevels: [lv(90, 4, 12)] } },
      { roundNumber: 100 },
      { roundNumber: 0 },
      { roundNumber: '' },
      { roundNumber: { level: 50, distancePct: 1.2 } },
      { halfwayRetracementRead: { retracedPct: 45, classification: 'normal' } },
      { halfwayRetracementRead: { retracedPct: 70, classification: 'suspect-major-reversal' } },
      { halfwayRetracementRead: null },
    ];
    for (const ind of inds) {
      assert.deepStrictEqual(schabackerSrTrendLineRead(ind as never), oracle.callNormalized('schabackerSRTrendLineReadV1_', ind, null), JSON.stringify(ind));
    }
  });

  test('schabackerTradingTactics matches schabackerTradingTacticsV1_ across price bands and swing-power ratios', () => {
    const oracle = loadOracle();
    const prices: unknown[] = [null, undefined, 0, 5, 9.99, 10, 12, 14.99, 15, 30, 60, 60.01, 200, NaN];
    const lasts: unknown[] = [null, undefined, 12, 100];
    const rsps: unknown[] = [
      null, undefined,
      { ratio: 1.35, etf: 'SMH', sector: 'Semis' },
      { ratio: 0.72, etf: 'XLV', sector: 'Health' },
      { ratio: 1, etf: 'SPY', sector: 'Broad' },
      { ratio: 0, etf: 'X', sector: 'Y' },
      { ratio: 2.5, etf: 'X', sector: 'Y' },
      { ratio: 0.995, etf: 'X', sector: 'Y' },
      { ratio: 1.005, etf: 'X', sector: 'Y' },
      { ratio: NaN, etf: 'X', sector: 'Y' },
    ];
    const fits = new Set<string>();
    for (const p of prices) for (const last of lasts) for (const rsp of rsps) {
      const chart = { currentPrice: p, relativeSwingPower: rsp };
      const ind = { last };
      const got = schabackerTradingTactics(chart as never, ind as never);
      assert.deepStrictEqual(got, oracle.callNormalized('schabackerTradingTacticsV1_', chart, ind), JSON.stringify([p, last, rsp]));
      fits.add(got.priceLevelFit.split('—')[0]!.trim());
    }
    assert.ok(fits.size >= 5, `only ${fits.size} price bands seen: ${[...fits].join(' | ')}`);
  });
});

describe('FL-10a models: Turtle', { skip }, () => {
  test('turtleShadowS1Outcome matches turtleShadowS1OutcomeV1_ on real series', () => {
    const oracle = loadOracle();
    const seen = new Set<string>();
    let n = 0;
    for (const { ticker, raw } of fixtureRaws()) {
      const { highs, lows, closes } = buildChart(raw);
      for (let idx = 20; idx < closes.length; idx += 29) {
        const entry = closes[idx] as number;
        for (const nPct of [0.005, 0.01, 0.02, 0.05]) {
          const N = entry * nPct;
          const got = turtleShadowS1Outcome(highs, lows, closes, idx, entry, N);
          assert.deepStrictEqual(got, oracle.callNormalized('turtleShadowS1OutcomeV1_', highs, lows, closes, idx, entry, N), `${ticker} idx ${idx} N ${nPct}`);
          seen.add(String(got));
          n++;
        }
      }
    }
    assert.ok(n > 500, `only ${n} comparisons`);
    assert.ok(seen.size >= 2, `only outcomes ${[...seen].join(',')} seen`);
  });

  test('turtleShadowS1Outcome edge inputs: flat series (strict exit), winner, loser, unresolved, bad index and N', () => {
    const oracle = loadOracle();
    const flat = Array(30).fill(100) as number[];
    const falling = Array.from({ length: 40 }, (_, i) => 100 - i);
    const cases: Array<[string, number[], number[], number[], number, number, number]> = [
      ['flat is unresolved', flat, flat, flat, 0, 100, 1],
      ['winner on a new low', falling, falling, falling, 0, 100, 50],
      ['loser on a stop hit', falling, falling, falling, 0, 100, 1],
      ['entry on last bar', falling, falling, falling, 39, 61, 1],
      ['entry past the end', falling, falling, falling, 99, 61, 1],
      ['negative entry index', falling, falling, falling, -1, 100, 50],
      ['N zero', falling, falling, falling, 0, 100, 0],
      ['N NaN', falling, falling, falling, 0, 100, NaN],
      ['empty arrays', [], [], [], 0, 100, 1],
    ];
    for (const [label, h, l, c, idx, entry, N] of cases) {
      assert.deepStrictEqual(
        turtleShadowS1Outcome(h, l, c, idx, entry, N),
        oracle.callNormalized('turtleShadowS1OutcomeV1_', h, l, c, idx, entry, N),
        label,
      );
    }
  });
});
