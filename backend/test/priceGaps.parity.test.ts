import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOracle, legacyFilesPresent } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent } from './fixtures.ts';
import { computePriceGaps, type PriceGap, type GapInput } from '../src/analysis/indicators/priceGaps.ts';

const ready = legacyFilesPresent() && fixturesPresent();
const LENGTHS = [60, 100, 201, 250, 400];

function gapCases(): Array<{ ticker: string; chart: GapInput; len: number }> {
  const out: Array<{ ticker: string; chart: GapInput; len: number }> = [];
  for (const ticker of listFixtures()) {
    let raw;
    try {
      raw = loadRawFixture(ticker);
    } catch {
      continue;
    }
    if (!Array.isArray(raw.closes) || !Array.isArray(raw.highs) || raw.closes.length < 250) continue;
    for (const len of [...LENGTHS, raw.closes.length]) {
      if (len > raw.closes.length) continue;
      out.push({ ticker, chart: buildChart(raw, len), len });
    }
  }
  return out;
}

describe('priceGaps — parity', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('matches the oracle exactly, including gapType and both optional flags', () => {
    const oracle = loadOracle();
    let instances = 0;
    for (const { ticker, chart, len } of gapCases()) {
      const all = oracle.callNormalized<Record<string, unknown>>('computeAllIndicators', chart);
      const expected = (all['priceGaps'] as PriceGap[]) ?? [];
      assert.deepStrictEqual(computePriceGaps(chart), expected, `${ticker}@${len} priceGaps`);
      instances += expected.length;
    }
    assert.ok(instances > 400, `only ${instances} gap instances compared`);
  });

  test('every gapType branch is genuinely exercised', () => {
    // A field that only ever takes one value would pass parity while proving
    // almost nothing. All five must appear across the fixtures.
    const seen = new Set<string>();
    for (const { chart } of gapCases()) {
      for (const g of computePriceGaps(chart)) if (g.gapType) seen.add(g.gapType);
    }
    for (const t of ['BREAKAWAY', 'EXHAUSTION', 'ISLAND', 'RUNAWAY', 'COMMON']) {
      assert.ok(seen.has(t), `gapType ${t} never observed — that branch is unverified`);
    }
  });

  test('a gap is a true void, not merely a higher open', () => {
    for (const { chart } of gapCases()) {
      for (const g of computePriceGaps(chart)) {
        if (g.type === 'UP') {
          assert.ok((chart.lows[g.idx] as number) > g.level, 'UP gap needs low above the prior high');
          assert.equal(g.level, chart.highs[g.idx - 1]);
          assert.ok(g.sizePct > 0);
        } else {
          assert.ok((chart.highs[g.idx] as number) < g.level, 'DOWN gap needs high below the prior low');
          assert.equal(g.level, chart.lows[g.idx - 1]);
          assert.ok(g.sizePct < 0, 'a DOWN gap has a negative sizePct');
        }
      }
    }
  });

  test('fill status uses intraday extremes, not closes', () => {
    // Touching the level counts as filling it, so a close that never reached
    // the level can still coexist with filled=true.
    for (const { chart } of gapCases()) {
      const n = chart.closes.length;
      for (const g of computePriceGaps(chart)) {
        let expected = false;
        for (let j = g.idx + 1; j < n; j++) {
          if (g.type === 'UP' ? (chart.lows[j] as number) <= g.level : (chart.highs[j] as number) >= g.level) {
            expected = true;
            break;
          }
        }
        assert.equal(g.filled, expected);
      }
    }
  });

  test('hindsight-dependent flag is set on exactly EXHAUSTION and ISLAND', () => {
    // Both depend on bars AFTER the gap, so neither could have been called at
    // the time. The flag is a real disclosure, not decoration.
    for (const { chart } of gapCases()) {
      for (const g of computePriceGaps(chart)) {
        const expectFlag = g.gapType === 'EXHAUSTION' || g.gapType === 'ISLAND';
        assert.equal(g.gapTypeHindsightDependent, expectFlag ? true : undefined, `${g.gapType} hindsight flag`);
      }
    }
  });

  test('meetsStrictValidity appears only on ISLAND gaps', () => {
    // A stricter, separate bar than detection -- reported alongside the
    // classification, never used to reject it.
    let islands = 0;
    for (const { chart } of gapCases()) {
      for (const g of computePriceGaps(chart)) {
        if (g.gapType === 'ISLAND') {
          islands++;
          // Present whenever a partner gap was found, which is the ISLAND
          // precondition, so it should always be set here.
          assert.equal(typeof g.meetsStrictValidity, 'boolean');
        } else {
          assert.equal(g.meetsStrictValidity, undefined, `${g.gapType} must not carry meetsStrictValidity`);
        }
      }
    }
    assert.ok(islands > 0, 'expected ISLAND gaps across the fixtures');
  });

  test('BREAKAWAY outranks the other classifications', () => {
    // Branch order is load-bearing: each returns, so an earlier match wins.
    // A BREAKAWAY is therefore never also flagged hindsight-dependent.
    for (const { chart } of gapCases()) {
      for (const g of computePriceGaps(chart)) {
        if (g.gapType === 'BREAKAWAY') {
          assert.equal(g.gapTypeHindsightDependent, undefined);
          assert.equal(g.meetsStrictValidity, undefined);
        }
      }
    }
  });

  test('the detection window is bounded to the trailing 60 bars', () => {
    for (const { chart } of gapCases()) {
      const n = chart.closes.length;
      for (const g of computePriceGaps(chart)) {
        assert.ok(g.idx >= Math.max(1, n - 60), 'gap outside the lookback window');
        assert.ok(g.idx < n);
      }
    }
  });
});
