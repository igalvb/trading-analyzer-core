/**
 * FL-9g: every status written by resolveFundamentals gets a catalog reason code, and in plain mode the banner and
 * failure sheet show catalog text only (no raw detail, no word 'cache'). Legacy mode is unchanged.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryPropertyStore, saveFundamentalsCache } from '../src/storage/kv.ts';
import { resolveFundamentals } from '../src/fetch/fundamentals/resolve.ts';
import { newDataStatus, setStatus } from '../src/analysis/dataStatus.ts';
import { ReportWorkbook, MemoryWorkbookBackend } from '../src/sheets/reportSheet.ts';
import { buildDataStatusBanner, buildFailureSheet, ANALYSIS_TAB, DASH_COLS, type RunStatus } from '../src/reports/text/textReports.ts';
import { findReportLeaks, assertNoReportLeaks } from '../src/reports/messages/leakScan.ts';
import { REASON_CODES } from '../src/reports/messages/catalog.ts';

const TIME = { nowMs: Date.UTC(2026, 9, 23, 15, 0, 0), timeZone: 'America/New_York' };
const NO_FUND = { fund: null, source: 'none' } as never;

async function run(opts: { cached?: boolean; seriesless?: boolean }) {
  const store = new MemoryPropertyStore();
  if (opts.cached) await saveFundamentalsCache(store, 'PLTR', { _sources: ['fmp'], beta: 1 }, new Date('2026-10-20T15:00:00Z'));
  const status = newDataStatus();
  const gather = async () => (opts.seriesless
    ? ({ fund: { _sources: ['fmp'], beta: 1, _metricSeries: null, _peersRaw: [] }, source: 'live' } as never)
    : NO_FUND);
  await resolveFundamentals('PLTR', {
    gather, store, now: () => new Date('2026-10-23T15:00:00Z'), log: () => {},
    setStatus: (k, st, d, rc) => setStatus(status as never, k, st, d, rc),
  } as never);
  return status;
}

async function banner(status: unknown): Promise<string[]> {
  return buildDataStatusBanner(status as RunStatus).flatMap((r) => r.text.map(String));
}

describe('FL-9g -- reason codes at the fundamentals call sites', () => {
  test('no data at all: all three failed with codes, banner clean and says why', async () => {
    const st = await run({});
    assert.equal(st.fundamentals.state, 'failed');
    assert.equal(st.fundamentals.reasonCode, 'NO_DATA_FOR_TICKER');
    assert.equal(st.series.reasonCode, 'NOT_RUN');
    assert.equal(st.peers.reasonCode, 'NOT_RUN');
    const lines = await banner(st);
    assert.ok(lines.join('\n').includes('Fundamentals: The provider returned no data for this ticker.'), lines.join('|'));
    for (const l of lines) assert.deepEqual(findReportLeaks(l), [], l);
    assert.ok(!/cache/i.test(lines.join('\n')));
  });

  test('saved copy used: degraded with codes, no raw detail and no word cache in plain mode', async () => {
    const st = await run({ cached: true });
    assert.equal(st.fundamentals.state, 'degraded');
    assert.equal(st.fundamentals.reasonCode, 'PROVIDER_NO_RESPONSE');
    assert.equal(st.series.reasonCode, 'NOT_RUN');
    const lines = await banner(st);
    assert.ok(!/cache/i.test(lines.join('\n')), lines.join('|'));
    for (const l of lines) assert.deepEqual(findReportLeaks(l), [], l);
    // legacy mode keeps the old text (parity)
    const legacy = buildDataStatusBanner(st as unknown as RunStatus, { legacyReportText: true }).flatMap((r) => r.text.map(String)).join('\n');
    assert.ok(legacy.includes('CACHED fundamentals'));
  });

  test('live but no series and no peers: degraded with NO_DATA_FOR_TICKER; ok clears the code', async () => {
    const st = await run({ seriesless: true });
    assert.equal(st.series.reasonCode, 'NO_DATA_FOR_TICKER');
    assert.equal(st.peers.reasonCode, 'NO_DATA_FOR_TICKER');
    assert.equal('reasonCode' in st.fundamentals, false);
    setStatus(st as never, 'series', 'ok', '');
    assert.equal('reasonCode' in st.series, false);
  });

  test('failure sheet detail column shows catalog text for the wired statuses', async () => {
    const st = await run({});
    const wb = await ReportWorkbook.open(new MemoryWorkbookBackend({} as never), ['*']);
    buildFailureSheet(wb, 'PLTR', st as never, new Error('boom'), TIME);
    const grid = wb.getSheetByName(ANALYSIS_TAB)!.grid(DASH_COLS);
    assertNoReportLeaks(grid);
    assert.ok(grid.some((row) => String(row[2] ?? '') === 'The provider returned no data for this ticker.'));
  });

  test('every code used by the wiring exists in the catalog', () => {
    for (const c of ['NO_DATA_FOR_TICKER', 'PROVIDER_NO_RESPONSE', 'NOT_RUN', 'SECTION_UNAVAILABLE', 'SAVED_COPY_TOO_OLD', 'AI_REVIEW_UNAVAILABLE']) {
      assert.ok((REASON_CODES as readonly string[]).includes(c), c);
    }
  });
});
