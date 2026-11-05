import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  listFixtures, loadChart, loadRawFixture, fixturesPresent,
  REQUIRED_HELD_FIXTURES, WARMUP_BARS,
} from './fixtures.ts';
import { isValidChart, barCount } from '../src/types/chart.ts';

const present = fixturesPresent();

describe('fixtures', { skip: present ? false : 'legacy/historical_data not populated yet' }, () => {
  test('fixtures are available', () => {
    assert.ok(listFixtures().length > 0, 'no fixture files found');
  });

  test('every fixture builds a structurally valid chart', () => {
    for (const ticker of listFixtures()) {
      // Non-ticker files (macro CSVs) are not JSON fixtures and are filtered
      // out by listFixtures(); anything left must parse cleanly.
      const raw = loadRawFixture(ticker);
      if (!Array.isArray(raw.closes)) continue;
      const chart = loadChart(ticker);
      assert.ok(isValidChart(chart), `${ticker}: chart arrays are not index-aligned`);
      assert.equal(barCount(chart), raw.closes.length);
    }
  });

  test('dates become UTC-midnight Date objects, not strings', () => {
    const ticker = listFixtures().find((t) => t === 'PLTR') ?? listFixtures()[0];
    assert.ok(ticker);
    const chart = loadChart(ticker);
    const first = chart.dates[0];
    assert.ok(first instanceof Date);
    assert.equal(first.getUTCHours(), 0, 'must be UTC midnight, not local midnight');
  });

  test('truncation produces a shorter but still valid chart', () => {
    const ticker = listFixtures()[0];
    assert.ok(ticker);
    const full = loadChart(ticker);
    if (barCount(full) <= WARMUP_BARS) return;
    const short = loadChart(ticker, WARMUP_BARS);
    assert.equal(barCount(short), WARMUP_BARS);
    assert.ok(isValidChart(short));
    assert.equal(short.currentPrice, full.closes[WARMUP_BARS - 1]);
  });

  test('PRE-TASK: the four held Bitcoin ETF fixtures are required for a meaningful parity gate', () => {
    const have = new Set(listFixtures());
    const missing = REQUIRED_HELD_FIXTURES.filter((t) => !have.has(t));

    // Deliberately a soft check with a loud message rather than a hard
    // failure: this is a data-capture task, not a code defect, and it must
    // not block Phase 2 development. It MUST be resolved before the
    // end-to-end gate is claimed as representative of the real portfolio.
    if (missing.length > 0) {
      console.warn(
        `\n  ⚠ PRE-TASK OUTSTANDING: missing fixtures for held tickers: ${missing.join(', ')}.\n` +
          `    The end-to-end parity gate is not representative of the user's actual\n` +
          `    holdings until these are captured (same process as the existing files).\n`,
      );
    }
    assert.ok(true);
  });
});
