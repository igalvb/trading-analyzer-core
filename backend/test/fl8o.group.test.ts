import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BITCOIN_ETF_GROUP, resolveGroups, sharedThesisDisclosure, buildSharedThesis, defaultScaleInvariantThesis,
} from '../src/jobs/exit/correlatedGroup.ts';
import { fixturesPresent, loadChart } from './fixtures.ts';
import type { Chart } from '../src/types/chart.ts';

test('the Bitcoin ETF group is exactly GBTC, BTC, FBTC, BITB, IBIT', () => {
  assert.deepEqual([...BITCOIN_ETF_GROUP.members], ['GBTC', 'BTC', 'FBTC', 'BITB', 'IBIT']);
});

test('anchor order is Bitcoin itself, then IBIT, and never GBTC', () => {
  assert.deepEqual(BITCOIN_ETF_GROUP.anchors.map((a) => a.symbol), ['BTC-USD', 'IBIT']);
  assert.ok(!BITCOIN_ETF_GROUP.anchors.some((a) => a.symbol === 'GBTC'));
});

test('membership resolves over whichever members are actually held, case-insensitive', () => {
  const r = resolveGroups(['tsla', 'gbtc', 'IBIT']);
  assert.equal(r.length, 1); assert.deepEqual([...r[0].present], ['GBTC', 'IBIT']); assert.equal(r[0].shared, true);
});

test('a single held member is not a shared thesis', () => {
  const r = resolveGroups(['TSLA', 'GBTC']);
  assert.equal(r.length, 1); assert.equal(r[0].shared, false);
  assert.deepEqual(resolveGroups(['TSLA', 'NVDA']), []);
});

test('the disclosure sentence is the plan wording with the held members', () => {
  const rg = resolveGroups(['GBTC', 'BTC', 'FBTC', 'BITB', 'IBIT'])[0];
  assert.equal(sharedThesisDisclosure(rg),
    'Technical read shared across Bitcoin-tracking ETFs (GBTC, BTC, FBTC, BITB, IBIT), since they track the same underlying asset. Your stop, targets, fundamentals, and position details below are specific to this holding.');
});

test('buildSharedThesis carries only scale-invariant fields and a plain narrative', () => {
  const rg = resolveGroups(['GBTC', 'IBIT'])[0];
  const t = buildSharedThesis(rg, BITCOIN_ETF_GROUP.anchors[1], 1, { regime: 'TREND_UP', rsi14: 61.2, rsiWeekly: 55.5, stochRsi: null, weeklyTrend: null, trendMaturity: null, patternTypes: ['DOUBLE_TOP'] });
  assert.equal(t.usedFallbackAnchor, true); assert.equal(t.anchorSymbol, 'IBIT');
  assert.match(t.narrative, /trending up/); assert.match(t.narrative, /Weekly RSI is 56/);
  assert.deepEqual(Object.keys(t).filter((k) => /stop|target|price|level/i.test(k)), []);
});

test('regime wording covers all four regimes', () => {
  const rg = resolveGroups(['GBTC', 'IBIT'])[0];
  const mk = (regime: string) => buildSharedThesis(rg, BITCOIN_ETF_GROUP.anchors[0], 0, { regime, rsi14: null, rsiWeekly: null, stochRsi: null, weeklyTrend: null, trendMaturity: null, patternTypes: [] }).narrative;
  assert.match(mk('TREND_DOWN'), /trending down/); assert.match(mk('CHOP'), /sideways/); assert.match(mk('HIGH_VOL'), /swinging widely/);
});

test('real IBIT fixture: the default extractor returns a regime and a pattern list', { skip: fixturesPresent() ? false : 'fixtures not populated' }, () => {
  const core = defaultScaleInvariantThesis(loadChart('IBIT') as unknown as Chart);
  assert.ok(['TREND_UP', 'TREND_DOWN', 'CHOP', 'HIGH_VOL'].includes(core.regime as string));
  assert.ok(Array.isArray(core.patternTypes));
});
