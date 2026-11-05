import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAILY_AUTOMATION_REJECTED_NOTE, mayAppendHistory, normalizeNightlyHistoryPolicy, watchlistDecisionRows } from '../src/jobs/history/historyPolicy.ts';

const row = (ticker: string, sets: string[], decision: unknown | null, hasResult = true) => ({ ticker, sets, result: hasResult ? { decision } : null });

test('watchlistDecisionRows keeps only watchlist tickers that have a decision', () => {
  const rows = [
    row('AAPL', ['portfolio', 'watchlist'], { action: 'Buy' }),
    row('MSFT', ['portfolio'], { action: 'Hold' }),
    row('NVDA', ['watchlist'], null),
    row('BADX', ['watchlist'], null, false),
    row('AMD', ['watchlist'], { action: 'Wait' }),
  ];
  assert.deepEqual(watchlistDecisionRows(rows).map((r) => r.ticker), ['AAPL', 'AMD']);
});

test('normalizeNightlyHistoryPolicy: dailyAutomation is rejected and falls back to the Buy pipeline', () => {
  const n = normalizeNightlyHistoryPolicy({ writer: 'dailyAutomation' });
  assert.equal(n.rejected, true);
  assert.equal(n.policy.writer, 'buyPipeline');
  assert.equal(mayAppendHistory('buyPipeline', n.policy), true);
  assert.equal(mayAppendHistory('nightlySummary', n.policy), false);
  assert.match(DAILY_AUTOMATION_REJECTED_NOTE, /^[A-Z]/);
  assert.doesNotMatch(DAILY_AUTOMATION_REJECTED_NOTE, /cach|https?:|\bHTTP\b/i);
});

test('normalizeNightlyHistoryPolicy: other policies pass through untouched', () => {
  for (const p of [undefined, {}, { writer: 'buyPipeline' }, { writer: 'nightlySummary' }, { writer: 'dailyAutomation', legacyDoubleAppend: true }, { legacyDoubleAppend: true }] as const) {
    const n = normalizeNightlyHistoryPolicy(p as never);
    assert.equal(n.rejected, false);
    assert.deepEqual(n.policy, p ?? {});
  }
});
