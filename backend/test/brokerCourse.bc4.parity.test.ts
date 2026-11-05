/**
 * Broker Course BC-4 parity: Phases 6-10 (20 functions + 1 var) --
 * fundamentals screen, technique/entry, risk overlay, macro overlay, VIX
 * and short squeeze.
 *
 * ══ REAL DATA WHERE IT EXISTS, INJECTION WHERE IT DOES NOT ════════════
 * Real: technique reads on every fixture (production-shaped: n = len-1,
 * S/R exactly as :1997); rate trends on the real FRED histories in
 * historical_data/ (parsed as fetchFredSeriesV1 parses them); VIX regimes
 * on the real VIX history. Injected: market cap and target price (both
 * fund/caller-supplied, absent from fixtures), and the two ETF fetchers
 * via oracle.setGlobal -- without that, only the "Not available" arms of
 * the overlay could ever be compared. Synthetic inputs (XML, boundary
 * bars, support levels) were each probed on the oracle first.
 *
 * F-25, F-26 and the orphaned functions are asserted at SOURCE level;
 * F-27 against the engine's own lockupExpirationV7 in the oracle.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadOracle, legacyFilesPresent, LEGACY_DIR, ORACLE_FILES } from './oracle.ts';
import { listFixtures, loadRawFixture, buildChart, fixturesPresent, FIXTURE_DIR } from './fixtures.ts';
import { findSupportResistanceV1, type SrLevel } from '../src/analysis/models/brokerCourse/technicals.ts';
import type { SharesOutstandingPoint } from '../src/analysis/models/brokerCourse/screens.ts';
import {
  revenueRedFlagV1, lockupExpirationReadV1, fundamentalsScreenReadV1, type FundamentalsScreen,
} from '../src/analysis/models/brokerCourse/fundamentals.ts';
import {
  secondaryDayEntryReadV1, counterTrendAtSupportReadV1, stopPlacementV1, techniqueEntryReadV1,
  type TechniqueEntryRead,
} from '../src/analysis/models/brokerCourse/technique.ts';
import {
  positionSizeRangeV1, breakevenLockNoteV1, SPDR_ETF_TICKERS, parseSpdrSharedStringsV1, spdrCellValueV1,
  parseSpdrHoldingsV1, riskOverlayReadV1,
  type PositionSizeRange, type SpdrHoldings, type QqqHoldings, type RiskOverlay,
} from '../src/analysis/models/brokerCourse/risk.ts';
import {
  treasuryYieldTrendReadV1, fedFundsTrendReadV1, macroOverlayReadV1, type RateTrendRead,
} from '../src/analysis/models/brokerCourse/macro.ts';
import {
  vixRegimeReadV1, shortInterestTierV1, shortSqueezeSetupReadV1, vixAndSqueezeReadV1,
  type VixRegimeRead, type ShortSqueezeRead,
} from '../src/analysis/models/brokerCourse/vixSqueeze.ts';

const ready = legacyFilesPresent() && fixturesPresent();

/** Reads a top-level `const`/`var` from the oracle's realm. */
function oracleConst<T>(name: string): T {
  const F = loadOracle().fns.setStatusV7.constructor as new (body: string) => () => unknown;
  return structuredClone(new F('return ' + name + ';')()) as T;
}

/** Comment-stripped source of every legacy file, keyed by file name. */
function legacySources(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of ORACLE_FILES) {
    out[file] = fs.readFileSync(path.join(LEGACY_DIR, file), 'utf8')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  }
  return out;
}

/** Non-comment `name(` occurrences across all ten files. */
function callCount(src: Record<string, string>, name: string): number {
  let n = 0;
  for (const code of Object.values(src)) n += code.match(new RegExp('\\b' + name + '\\s*\\(', 'g'))?.length ?? 0;
  return n;
}

/** A FRED CSV parsed exactly as fetchFredSeriesV1 does: non-numeric rows dropped. */
function fredSeries(file: string): number[] {
  const lines = fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8').split('\n').filter((l) => l.trim().length);
  const values: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 2) continue;
    const v = parseFloat(parts[1]);
    if (!isNaN(v)) values.push(v);
  }
  return values;
}

const D = (y: number, m: number, d: number, h = 0, mi = 0): Date => new Date(Date.UTC(y, m - 1, d, h, mi));

describe('Broker Course P6 — fundamentals screen', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('revenue flag, lock-up and the screen match across every input state', () => {
    const oracle = loadOracle();
    for (const g of [null, undefined, -0.1, 0, 0.0001, 0.25]) {
      assert.deepStrictEqual(revenueRedFlagV1(g), oracle.callNormalized('revenueRedFlagV1', g), `rev ${g}`);
    }
    // "Minimal" is read as <= 0: exactly zero growth is a red flag.
    assert.equal(revenueRedFlagV1(0)?.isRedFlag, true);
    assert.equal(revenueRedFlagV1(0.0001)?.isRedFlag, false);

    // Yahoo's firstTradeDate is a market-open timestamp, not midnight.
    const ipo = D(2026, 1, 5, 14, 30);
    const nows = [-1, 0, 1, 179, 180, 181, 210, 211].flatMap((d) => [D(2026, 1, 5 + d, 0), D(2026, 1, 5 + d, 20)]);
    for (const now of nows) {
      assert.deepStrictEqual(lockupExpirationReadV1(ipo, now), oracle.callNormalized('lockupExpirationReadV1', ipo, now),
        now.toISOString());
    }
    assert.equal(lockupExpirationReadV1(null, D(2026, 3, 1)), null);

    // The screen: the two Phase 13 params are THREE-state (absent / null / data).
    const rising: SharesOutstandingPoint[] = [{ date: 'a', value: 100 }, { date: 'b', value: 110 }, { date: 'c', value: 120 }];
    const flat: SharesOutstandingPoint[] = [{ date: 'a', value: 100 }, { date: 'b', value: 100 }];
    const histories: Array<SharesOutstandingPoint[] | null | undefined> = [undefined, null, rising, flat];
    const hitsList: Array<Record<string, number | null> | null | undefined> = [undefined, null, {}, { offering: 2, shelf: 0 }];
    const tags = new Set<string>();
    const soTexts = new Set<string>();
    const filingTexts = new Set<string>();
    let comparisons = 0;
    for (const g of [null, -0.2, 0.3]) {
      for (const [ft, now] of [[null, D(2026, 3, 1)], [ipo, D(2026, 3, 1, 20)], [ipo, D(2027, 3, 1)]] as Array<[Date | null, Date]>) {
        for (const h of histories) {
          for (const k of hitsList) {
            // `undefined` must be passed positionally to reach the absent arm.
            const expected = oracle.callNormalized<FundamentalsScreen>('fundamentalsScreenReadV1', g, ft, now, h, k);
            assert.deepStrictEqual(fundamentalsScreenReadV1(g, ft, now, h, k), expected,
              `g=${g} ft=${ft?.toISOString()} h=${JSON.stringify(h)} k=${JSON.stringify(k)}`);
            comparisons++;
            tags.add(expected.tag);
            soTexts.add(expected.sharesOutstandingTrend.slice(0, 20));
            filingTexts.add(expected.filingKeywordSearch.slice(0, 20));
          }
        }
      }
    }
    assert.equal(comparisons, 144);
    assert.equal(tags.size, 2);
    // absent / fetch-failed / real read (rising and not-rising share a prefix).
    assert.ok(soTexts.size >= 3, [...soTexts].join(' | '));
    assert.ok(filingTexts.size >= 3, [...filingTexts].join(' | '));
    // Absent and null are NOT the same: different disclosure text.
    assert.match(fundamentalsScreenReadV1(null, null, D(2026, 3, 1)).sharesOutstandingTrend, /^Not available — needs multi-year/);
    assert.match(fundamentalsScreenReadV1(null, null, D(2026, 3, 1), null).sharesOutstandingTrend, /^SEC EDGAR data fetch failed/);
    // Evidence order is fixed: revenue, shares, filings, then lock-up.
    const all = fundamentalsScreenReadV1(-0.2, ipo, D(2026, 3, 1, 20), rising, { offering: 2 });
    assert.equal(all.evidence.length, 4);
    assert.match(all.evidence[0], /^Revenue growth/);
    assert.match(all.evidence[1], /^Shares outstanding steadily rising/);
    assert.match(all.evidence[2], /^Recent filings mention/);
    assert.match(all.evidence[3], /^Lock-up expiration/);
  });

  test('F-27: the lock-up copy kept the time-of-day bug the engine fixed', () => {
    const oracle = loadOracle();
    // The engine's lockupExpirationV7 (:9115) zeroes BOTH dates to UTC
    // midnight (its own v9.46 fix); this copy differences raw timestamps.
    const ipo = D(2026, 1, 5, 14, 30);
    const hours = [0, 6, 12, 14, 15, 20, 23];
    let compared = 0;
    const disagreeHours = new Set<number>();
    let disagreements = 0;
    for (let d = -2; d <= 213; d++) {
      for (const h of hours) {
        const now = D(2026, 1, 5 + d, h);
        const mine = lockupExpirationReadV1(ipo, now);
        assert.deepStrictEqual(mine, oracle.callNormalized('lockupExpirationReadV1', ipo, now));
        const eng = oracle.call<{ status: string; daysUntilExpiration: number } | null>('lockupExpirationV7', ipo, now);
        compared++;
        const a = mine && mine.status + ':' + mine.daysUntilLockupEnd;
        const b = eng && eng.status + ':' + eng.daysUntilExpiration;
        if (a !== b) {
          disagreements++;
          disagreeHours.add(h);
        }
      }
    }
    assert.equal(compared, 1512);
    assert.equal(disagreements, 848);
    // Exactly the runs BEFORE the IPO timestamp's time of day (14:30 UTC).
    assert.deepStrictEqual([...disagreeHours].sort((x, y) => x - y), [0, 6, 12, 14]);
    // On day 180, a morning run: the report says "1 day left", the engine "passed".
    assert.equal(lockupExpirationReadV1(ipo, D(2026, 1, 5 + 180, 6))?.status, 'UPCOMING');
    assert.equal(oracle.call<{ status: string }>('lockupExpirationV7', ipo, D(2026, 1, 5 + 180, 6)).status, 'PASSED');
    // And on IPO day itself before the open, this copy reports nothing.
    assert.equal(lockupExpirationReadV1(ipo, D(2026, 1, 5, 6)), null);
    assert.ok(oracle.call('lockupExpirationV7', ipo, D(2026, 1, 5, 6)) !== null);
  });
});

describe('Broker Course P7 — technique / entry', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('production-shaped technique reads on real charts, with injected market caps and targets', () => {
    const oracle = loadOracle();
    const tags = new Set<string>();
    const rr = new Set<boolean>();
    let comparisons = 0;
    let twin = 0;
    let twinTriggers = 0;
    for (const ticker of listFixtures()) {
      let raw;
      try {
        raw = loadRawFixture(ticker);
      } catch {
        continue;
      }
      if (!Array.isArray(raw.closes)) continue;
      const N = raw.closes.length;
      for (let cut = 0; cut < 400; cut += 3) {
        const L = N - cut;
        if (L < 25) continue;
        const ch = buildChart(raw, L);
        const n = L - 1;
        // Production: n = closes.length - 1 (:1894), S/R called exactly like :1997.
        const { supportLevels } = findSupportResistanceV1(ch.highs, ch.lows, 0.03, n);
        // Vacuity trap: market cap is fund-derived, absent from fixtures.
        for (const cap of [null, 1e9, 20e9, 25e9, 5e11]) {
          for (const target of [null, ch.closes[n] * 1.1, ch.closes[n] * 1.01]) {
            const expected = oracle.callNormalized<TechniqueEntryRead>('techniqueEntryReadV1',
              ch.closes, ch.highs, ch.volumes, n, cap, supportLevels, target);
            assert.deepStrictEqual(techniqueEntryReadV1(ch.closes, ch.highs, ch.volumes, n, cap, supportLevels, target),
              expected, `${ticker}@${L} cap=${cap} target=${target}`);
            comparisons++;
            tags.add(expected.tag);
            if (expected.riskReward) rr.add(expected.riskReward.meetsMinimum);
          }
          assert.deepStrictEqual(counterTrendAtSupportReadV1(cap, ch.closes[n], supportLevels),
            oracle.callNormalized('counterTrendAtSupportReadV1', cap, ch.closes[n], supportLevels));
          comparisons++;
        }
        // The engine's own secondaryDayV7 (n = closes.length, :7740) agrees.
        const mine = secondaryDayEntryReadV1(ch.closes, ch.highs, ch.volumes, n);
        assert.deepStrictEqual(mine, oracle.callNormalized('secondaryDayEntryReadV1', ch.closes, ch.highs, ch.volumes, n));
        const eng = oracle.call<{ triggered: boolean } | null>('secondaryDayV7', ch.closes, ch.highs, ch.volumes, L);
        assert.equal(!!mine?.isSecondaryDay, !!eng?.triggered, `${ticker}@${L} secondary twin`);
        twin++;
        if (eng?.triggered) twinTriggers++;
      }
    }
    assert.ok(comparisons > 30000, `only ${comparisons} comparisons`);
    assert.deepStrictEqual([...tags].sort(),
      ['Counter-Trend-At-Institutional-Support', 'No specific entry technique identified', 'Secondary-Day-Entry']);
    assert.deepStrictEqual([...rr].sort(), [false, true], 'both sides of the 1:1 floor, with a target supplied');
    assert.ok(twin > 3000 && twinTriggers > 50, `${twin} twin checks, ${twinTriggers} triggers`);
  });

  test('edges: the strict 1.5x, the $20B boundary, and the ineligible shape', () => {
    const oracle = loadOracle();
    // 20 bars of volume 1, yesterday at exactly 1.5x / just above, today
    // closing above yesterday's high.
    const mk = (y: number): [number[], number[], number[]] => {
      const v = Array.from({ length: 22 }, () => 1);
      v[20] = y;
      const c = Array.from({ length: 22 }, () => 10);
      const h = Array.from({ length: 22 }, () => 10.5);
      c[21] = 11;
      return [c, h, v];
    };
    for (const y of [1.5, 1.51]) {
      const [c, h, v] = mk(y);
      assert.deepStrictEqual(secondaryDayEntryReadV1(c, h, v, 21), oracle.callNormalized('secondaryDayEntryReadV1', c, h, v, 21));
    }
    // Strict: exactly 1.5x is NOT elevated here, although the source's own
    // comment calls this "the same >1.5x convention as Phase 1" -- and
    // Phase 1's relativeVolumeReadV1 is inclusive (>= 1.5).
    assert.equal(secondaryDayEntryReadV1(...mk(1.5), 21)?.isSecondaryDay, false);
    assert.equal(secondaryDayEntryReadV1(...mk(1.51), 21)?.isSecondaryDay, true);
    for (const n of [null, 0, 1, 22]) {
      const [c, h, v] = mk(2);
      assert.deepStrictEqual(secondaryDayEntryReadV1(c, h, v, n), oracle.callNormalized('secondaryDayEntryReadV1', c, h, v, n), `n=${n}`);
    }
    assert.equal(secondaryDayEntryReadV1(...mk(2), 1), null, 'n=1 has no baseline: 0/0 refuses');

    const lv: SrLevel[] = [{ level: 100, touchCount: 3, duration: 40, tier: 'Secondary', trendFavored: null, lastTouchIdx: 50 }];
    for (const cap of [null, 19.99e9, 20e9, 20.01e9]) {
      for (const px of [null, 96, 97, 103, 104]) {
        assert.deepStrictEqual(counterTrendAtSupportReadV1(cap, px, lv), oracle.callNormalized('counterTrendAtSupportReadV1', cap, px, lv), `${cap}/${px}`);
      }
    }
    // $20B exactly is ineligible (strict >), and the ineligible object has
    // NO `level` key at all -- not level: null.
    const inel = counterTrendAtSupportReadV1(20e9, 100, lv)!;
    assert.equal(inel.eligible, false);
    assert.ok(!('level' in inel));
    assert.equal(counterTrendAtSupportReadV1(25e9, 104, lv)?.level, null, 'eligible but away from support: level null');
    for (const [lvl, m] of [[null, null], [100, undefined], [100, 0.05], [52.345, 0]] as Array<[number | null, number | null | undefined]>) {
      assert.deepStrictEqual(stopPlacementV1(lvl, m), oracle.callNormalized('stopPlacementV1', lvl, m));
    }
  });

  test('F-26: the risk:reward rule never runs in production', () => {
    const src = legacySources();
    // riskRewardV1 has exactly one call site, inside techniqueEntryReadV1,
    // behind `targetPrice != null` ...
    assert.equal(callCount(src, 'riskRewardV1'), 2, 'definition + the one gated call');
    // ... and the only production call passes targetPrice as a literal null.
    assert.equal(callCount(src, 'techniqueEntryReadV1'), 2);
    assert.match(src['brokerCourseModelV1.gs'], /techniqueEntryReadV1\(chart\.closes, chart\.highs, chart\.volumes, n, idCard\.marketCap, supportLevels, null\)/);
    // Same class as F-24, in Phase 3 (ported in BC-1): two more functions
    // that appear only as their own definitions.
    assert.equal(callCount(src, 'fibonacciExtensionTargetsV1'), 1);
    assert.equal(callCount(src, 'flagPatternQualityV1'), 1);
    // Demonstrated on a real chart: a counter-trend setup WITH a stop,
    // production-shaped, still has no R:R.
    const raw = loadRawFixture('AMD');
    let checked = 0;
    for (let cut = 0; cut < 400 && checked < 5; cut += 3) {
      const ch = buildChart(raw, raw.closes.length - cut);
      const n = ch.closes.length - 1;
      const { supportLevels } = findSupportResistanceV1(ch.highs, ch.lows, 0.03, n);
      const r = techniqueEntryReadV1(ch.closes, ch.highs, ch.volumes, n, 5e11, supportLevels, null);
      if (r.tag !== 'Counter-Trend-At-Institutional-Support') continue;
      assert.equal(r.riskReward, null);
      assert.equal(r.evidence.length, 2, 'setup + stop, never the R:R line');
      checked++;
    }
    assert.ok(checked > 0, 'no counter-trend setup found to demonstrate on');
  });
});

describe('Broker Course P8 — risk overlay', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('position-size tiers, the volatility note and the standing reminder', () => {
    const oracle = loadOracle();
    const tiers = new Set<string>();
    for (const cap of [null, undefined, 0, 1.99e9, 2e9, 30e9, 30.01e9, 1e12]) {
      for (const atr of [null, 0.05, 0.10, 0.1001]) {
        const expected = oracle.callNormalized<PositionSizeRange | null>('positionSizeRangeV1', cap, atr);
        assert.deepStrictEqual(positionSizeRangeV1(cap, atr), expected, `${cap}/${atr}`);
        if (expected) tiers.add(expected.tier);
      }
    }
    assert.equal(tiers.size, 3);
    // Both boundaries exclude themselves: $2B and $30B exactly are Mid-range.
    assert.equal(positionSizeRangeV1(2e9, null)?.tier, 'Mid-range');
    assert.equal(positionSizeRangeV1(30e9, null)?.tier, 'Mid-range');
    assert.equal(positionSizeRangeV1(1e12, 0.10)?.volatilityNote, null, 'exactly 10% ATR is not flagged');
    assert.equal(breakevenLockNoteV1(), oracle.call('breakevenLockNoteV1'));
    assert.deepStrictEqual([...SPDR_ETF_TICKERS], oracleConst<string[]>('SPDR_ETF_TICKERS_V1'));
  });

  test('the SPDR XLSX parsers, including a latent self-closing-cell hazard', () => {
    const oracle = loadOracle();
    const ss = '<sst><si><t>Apple Inc.</t></si><si><t>AAPL</t></si>'
      + '<si><r><t>AT&amp;T</t></r><r><t xml:space="preserve"> Inc</t></r></si><si><t>T</t></si>'
      + '<si><t>&lt;x&gt; &quot;q&quot; &#39;a&#39;</t></si></sst>';
    const shared = parseSpdrSharedStringsV1(ss);
    assert.deepStrictEqual(shared, oracle.callNormalized('parseSpdrSharedStringsV1_', ss));
    assert.deepStrictEqual(shared, ['Apple Inc.', 'AAPL', 'AT&T Inc', 'T', '<x> "q" \'a\'']);
    const row = (r: number, cells: string): string => '<row r="' + r + '" spans="1:8">' + cells + '</row>';
    const S = (c: string, i: number): string => '<c r="' + c + '" t="s"><v>' + i + '</v></c>';
    const N = (c: string, v: string): string => '<c r="' + c + '" s="2"><v>' + v + '</v></c>';
    const E = (c: string): string => '<c r="' + c + '" s="3"/>';
    const sheets = {
      clean: '<sheetData>' + row(5, S('A5', 0) + S('B5', 1)) + row(6, S('A6', 0) + S('B6', 1) + N('C6', 'x') + N('E6', '7.5'))
        + row(7, S('A7', 2) + S('B7', 3) + N('E7', '2.25')) + row(8, '') + '</sheetData>',
      selfClosingBeforeWeight: '<sheetData>' + row(6, S('A6', 0) + S('B6', 1) + E('C6') + E('D6') + N('E6', '7.5') + S('F6', 4)) + '</sheetData>',
      selfClosingEarlier: '<sheetData>' + row(6, S('A6', 0) + S('B6', 1) + E('C6') + N('D6', '99') + N('E6', '7.5')) + '</sheetData>',
      rowless: '<x/>',
    };
    for (const [label, xml] of Object.entries(sheets)) {
      for (const topN of [1, 10]) {
        assert.deepStrictEqual(parseSpdrHoldingsV1(xml, shared, topN),
          oracle.callNormalized('parseSpdrHoldingsV1_', xml, shared, topN), `${label} topN=${topN}`);
      }
    }
    assert.deepStrictEqual(parseSpdrHoldingsV1(sheets.clean, shared, 10),
      [{ name: 'Apple Inc.', ticker: 'AAPL', weightPct: 7.5 }, { name: 'AT&T Inc', ticker: 'T', weightPct: 2.25 }],
      'header row 5 skipped, empty row 8 skipped');
    // Latent hazard: the cell regex's optional `(...)?</c>` lets a
    // SELF-CLOSING cell swallow the next cell. A self-closing D eats E
    // (Weight), so weightPct comes back undefined -- and riskOverlayReadV1's
    // `h.weightPct.toFixed(1)` would then throw. No fixture shows whether
    // real State Street files contain self-closing cells; not registered.
    const hazard = parseSpdrHoldingsV1(sheets.selfClosingBeforeWeight, shared, 10);
    assert.equal(hazard.length, 1);
    assert.ok('weightPct' in hazard[0] && hazard[0].weightPct === undefined);
    for (const cell of ['<c r="A1" t="s"/>', '<c r="A1"><v>1.5</v></c>', '<c r="A1" t="s"><v>99</v></c>']) {
      assert.equal(spdrCellValueV1(cell, shared), oracle.call('spdrCellValueV1_', cell, shared), cell);
    }
    assert.equal(spdrCellValueV1('<c r="A1" t="s"><v>99</v></c>', shared), undefined, 'out-of-range index is undefined, not null');
  });

  test('the overlay text, with the two ETF fetchers injected into the oracle', () => {
    const oracle = loadOracle();
    const spdr = (t: string): SpdrHoldings | null => t === 'SPY'
      ? { holdings: [{ ticker: 'NVDA', weightPct: 7.87 }, { ticker: 'AAPL', weightPct: 6.5 }], top10ConcentrationPct: 14.37 }
      : null;
    const qqq: QqqHoldings = { holdings: [{ name: 'Apple Inc.', weightPct: 8.9 }], top10ConcentrationPct: 8.9, filingDate: '2026-09-01' };
    const kinds = new Set<string>();
    const kind = (s: string): string => s.startsWith('Top-10 holdings: ') ? 'spdr'
      : s.startsWith('Top-10 holdings (by name') ? 'qqq'
        : s.startsWith('Not available for ') ? 'out-of-scope'
          : 'failed';
    const origSpdr = oracle.getGlobal('fetchSpdrEtfTopHoldingsV1');
    const origQqq = oracle.getGlobal('fetchQqqTopHoldingsV1');
    try {
      // Vacuity trap: both fetchers return null in the sandbox, so without
      // injection only the "Not available" arms could ever be compared.
      oracle.setGlobal('fetchSpdrEtfTopHoldingsV1', spdr);
      oracle.setGlobal('fetchQqqTopHoldingsV1', () => qqq);
      for (const t of ['SPY', 'XLK', 'QQQ', 'AAPL', 'SMH', null, '']) {
        for (const [cap, atr] of [[5e11, 0.2], [1e9, 0.02], [null, null]] as Array<[number | null, number | null]>) {
          // Resolve the fetches exactly as legacy :1611/:1615 decide them.
          const s = t ? spdr(t) : null;
          const q = !s && t === 'QQQ' ? qqq : null;
          const expected = oracle.callNormalized<RiskOverlay>('riskOverlayReadV1', cap, atr, t);
          assert.deepStrictEqual(riskOverlayReadV1(cap, atr, t, s, q), expected, `${t} ${cap}`);
          kinds.add(kind(expected.etfPositionSizing));
        }
      }
    } finally {
      oracle.setGlobal('fetchSpdrEtfTopHoldingsV1', origSpdr);
      oracle.setGlobal('fetchQqqTopHoldingsV1', origQqq);
    }
    // All four arms reached. (A first draft grouped by text prefix and got
    // 5 -- the out-of-scope text embeds the ticker.)
    assert.deepStrictEqual([...kinds].sort(), ['failed', 'out-of-scope', 'qqq', 'spdr']);
    // Restored: the sandbox's own fetcher fails, and the text says so --
    // the same text a missing ticker gets, though nothing was fetched.
    assert.equal(oracle.call<RiskOverlay>('riskOverlayReadV1', 5e11, 0.02, 'SPY').etfPositionSizing,
      riskOverlayReadV1(5e11, 0.02, 'SPY', null, null).etfPositionSizing);
    assert.equal(riskOverlayReadV1(5e11, 0.02, null, null, null).etfPositionSizing,
      riskOverlayReadV1(5e11, 0.02, 'SPY', null, null).etfPositionSizing);
  });

  test('F-25: the ETF holdings the overlay fetches are never shown or read', () => {
    const src = legacySources();
    let total = 0;
    const lines: number[] = [];
    for (const [file, code] of Object.entries(src)) {
      code.split('\n').forEach((l, i) => {
        const hits = l.match(/\betfPositionSizing\b/g)?.length ?? 0;
        if (hits) {
          total += hits;
          assert.equal(file, 'brokerCourseModelV1.gs');
          lines.push(i + 1);
        }
      });
    }
    // Produced (:1616) and returned (:1626) -- and nothing else, anywhere.
    assert.equal(total, 2);
    assert.ok(lines.every((l) => l >= 1597 && l <= 1628), `outside riskOverlayReadV1: ${lines.join(',')}`);
    // The formatter's risk section renders `evidence` only.
    const fmt = src['brokerCourseModelV1.gs'].split('\n').slice(2154, 2245).join('\n');
    assert.match(fmt, /report\.risk\.evidence\.forEach/);
    assert.doesNotMatch(fmt, /report\.risk\.(?!evidence)/);
  });
});

describe('Broker Course P9 — macro overlay', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('rate trends on real FRED history, and the overlay in every input state', () => {
    const oracle = loadOracle();
    const dgs10 = fredSeries('dgs10.csv');
    const fedfunds = fredSeries('fedfunds.csv');
    assert.ok(dgs10.length > 15000 && fedfunds.length > 800);
    const dirs = new Set<string>();
    let comparisons = 0;
    // Production windows: last 20 yields, last 12 rates (:2102).
    for (let end = 21; end <= dgs10.length; end += 37) {
      const w = dgs10.slice(end - 20, end);
      const expected = oracle.callNormalized<RateTrendRead>('treasuryYieldTrendReadV1', w);
      assert.deepStrictEqual(treasuryYieldTrendReadV1(w), expected);
      dirs.add('y:' + expected.direction);
      comparisons++;
    }
    for (let end = 13; end <= fedfunds.length; end++) {
      const w = fedfunds.slice(end - 12, end);
      const expected = oracle.callNormalized<RateTrendRead>('fedFundsTrendReadV1', w);
      assert.deepStrictEqual(fedFundsTrendReadV1(w), expected);
      dirs.add('f:' + expected.direction);
      comparisons++;
    }
    assert.ok(comparisons > 1000);
    // All three directions, on real data, for both series.
    assert.deepStrictEqual([...dirs].sort(), ['f:falling', 'f:flat', 'f:rising', 'y:falling', 'y:flat', 'y:rising']);
    for (const bad of [null, [], [4.1]]) {
      assert.equal(treasuryYieldTrendReadV1(bad), null);
      assert.equal(fedFundsTrendReadV1(bad), null);
    }

    const yields = dgs10.slice(-20);
    const rates = fedfunds.slice(-12);
    let overlays = 0;
    for (const y of [null, yields]) {
      for (const r of [null, rates]) {
        for (const gdp of [undefined, null, [100, 102, 105], [100, 99, 98]]) {
          for (const icr of [undefined, null, 0, 0.5, 3]) {
            assert.deepStrictEqual(macroOverlayReadV1(y, r, gdp, icr), oracle.callNormalized('macroOverlayReadV1', y, r, gdp, icr),
              `gdp=${JSON.stringify(gdp)} icr=${icr}`);
            overlays++;
          }
        }
      }
    }
    assert.equal(overlays, 80);
    // Absent vs null again carry different text.
    assert.match(macroOverlayReadV1(null, null).businessCyclePhase, /^Not available — course names 4 phases/);
    assert.match(macroOverlayReadV1(null, null, null).businessCyclePhase, /^FRED GDP data fetch failed/);
    // The cycle phase always lands in evidence; the zombie read only when it flags.
    assert.equal(macroOverlayReadV1(null, null, [100, 102, 105], 3).evidence.length, 1);
    assert.equal(macroOverlayReadV1(null, null, [100, 102, 105], 0.5).evidence.length, 2);
  });
});

describe('Broker Course P10 — VIX and short squeeze', { skip: ready ? false : 'legacy/ not populated' }, () => {
  test('VIX regimes on the real VIX history, and every band edge', () => {
    const oracle = loadOracle();
    const regimes = new Set<string>();
    let comparisons = 0;
    if (listFixtures().includes('_VIX')) {
      for (const v of loadRawFixture('_VIX').closes) {
        const expected = oracle.callNormalized<VixRegimeRead | null>('vixRegimeReadV1', v);
        assert.deepStrictEqual(vixRegimeReadV1(v), expected);
        if (expected) regimes.add(expected.regime);
        comparisons++;
      }
      // All five, on real index data -- including Extreme (70+) in 2008/2020.
      assert.equal(regimes.size, 5, [...regimes].join(','));
    }
    for (const v of [null, undefined, 0, 12.99, 13, 25, 25.01, 40, 40.01, 70, 70.01, 85]) {
      assert.deepStrictEqual(vixRegimeReadV1(v), oracle.callNormalized('vixRegimeReadV1', v), `vix ${v}`);
      comparisons++;
    }
    assert.ok(comparisons > 5000);
    // Lower band edge exclusive, upper edges inclusive.
    assert.equal(vixRegimeReadV1(13)?.regime, 'Normal (13-25)');
    assert.equal(vixRegimeReadV1(25)?.regime, 'Normal (13-25)');
    assert.equal(vixRegimeReadV1(70)?.regime, 'Crisis (40-70)');
  });

  test('short-interest tiers, the squeeze setup and the orphaned wrapper', () => {
    const oracle = loadOracle();
    const pcts = [null, 0, 0.1, 0.1001, 0.2, 0.2001, 0.4, 0.41];
    for (const p of pcts) assert.equal(shortInterestTierV1(p), oracle.call('shortInterestTierV1', p), `tier ${p}`);
    const reads = new Set<string>();
    for (const p of pcts) {
      for (const px of [null, 90, 96.9, 97, 100, 120]) {
        for (const hi of [null, 100]) {
          for (const tol of [undefined, null, 0.05]) {
            const expected = oracle.callNormalized<ShortSqueezeRead | null>('shortSqueezeSetupReadV1', p, px, hi, tol);
            assert.deepStrictEqual(shortSqueezeSetupReadV1(p, px, hi, tol), expected, `${p}/${px}/${hi}/${tol}`);
            if (expected) reads.add(expected.read.slice(0, 12));
          }
          for (const vix of [null, 18]) {
            assert.deepStrictEqual(vixAndSqueezeReadV1(vix, p, px, hi), oracle.callNormalized('vixAndSqueezeReadV1', vix, p, px, hi));
          }
        }
      }
    }
    // Squeeze / at-high-but-low-SI / not-at-high.
    assert.equal(reads.size, 3, [...reads].join(' | '));
    // "New high" is within 3% of the 52-week high, inclusive.
    assert.equal(shortSqueezeSetupReadV1(0.25, 97, 100)?.atNewHigh, true);
    assert.equal(shortSqueezeSetupReadV1(0.25, 96.9, 100)?.atNewHigh, false);
    // 20% exactly is not enough (strict), matching the tier boundary.
    assert.equal(shortSqueezeSetupReadV1(0.2, 100, 100)?.isSqueezeSetup, false);
    // The wrapper never reports a squeeze when data is missing: false, not null.
    assert.equal(vixAndSqueezeReadV1(null, null, null, null).isSqueezeSetup, false);
    // Orphaned: the builder calls the two parts directly (:2028, :2069) --
    // its own comment (:2070-2076) records that bypassing the wrapper
    // dropped the coverage disclosure, re-added there as shortInterestNote.
    assert.equal(callCount(legacySources(), 'vixAndSqueezeReadV1'), 1, 'definition only');
  });
});
