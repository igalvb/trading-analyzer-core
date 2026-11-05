import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadOracle, legacyFilesPresent, ORACLE_FILES, EXPECTED_FUNCTION_COUNT,
  LEGACY_DIR, computeChecksums, readManifest,
} from './oracle.ts';

const present = legacyFilesPresent();

describe('oracle', { skip: present ? false : 'legacy/ not populated yet' }, () => {
  test('all 10 legacy files load into one vm context', () => {
    const oracle = loadOracle();
    assert.ok(oracle.functionNames().length > 0);
  });

  test('exposes exactly the expected number of functions', () => {
    // A drift here means a legacy file changed, moved, or failed to load --
    // any of which silently invalidates every parity number.
    const oracle = loadOracle();
    assert.equal(
      oracle.functionNames().length,
      EXPECTED_FUNCTION_COUNT,
      'oracle function count changed — the frozen legacy code is no longer frozen',
    );
  });

  test('the functions the port depends on are all present', () => {
    const oracle = loadOracle();
    const required = [
      'computeAllIndicators', 'computeGannInline', 'computeConfluenceTargets',
      'computeTechnicalPlanV7', 'synthesizeDecisionV7',
      'buildSchabackerReportV1', 'buildEdwardsMageeReportV1', 'buildTurtleReportV1',
      'computePositionExitReadV1_', 'computePositionExitReadFixedLookbackV1_',
      'computeOptionsPositionExitReadV1_', 'parsePortfolioNumberV1_',
      'fetchGeminiReviewV7', 'appendPriceCacheV7_',
    ];
    const missing = required.filter((n) => !oracle.has(n));
    assert.deepEqual(missing, [], `oracle is missing: ${missing.join(', ')}`);
  });

  test('SECURITY: no real-looking API key survives in the frozen oracle', () => {
    // The legacy engine carries 4 plaintext keys at lines 5311-5314. They must
    // be replaced with placeholders before legacy/ is committed. The oracle
    // never needs real keys: every parity test mocks the network, and the 291
    // pure functions make no network calls at all.
    const src = fs.readFileSync(path.join(LEGACY_DIR, 'fullStockAnalysisV10_9.gs'), 'utf8');

    const keyLines = src
      .split('\n')
      .filter((l) => /^const (FMP_API_KEY|ALPHAVANTAGE_KEY|FINNHUB_KEY|GEMINI_API_KEY)\s*=/.test(l));

    assert.equal(keyLines.length, 4, 'expected exactly 4 key declarations');

    for (const line of keyLines) {
      const value = /=\s*'([^']*)'/.exec(line)?.[1] ?? '';
      assert.ok(
        value.toUpperCase().includes('PLACEHOLDER'),
        `an API key in legacy/ does not look like a placeholder: ${line.split('=')[0]?.trim()}`,
      );
    }
  });

  test('the oracle is frozen — checksums match the manifest', () => {
    const manifest = readManifest();
    if (!manifest) {
      assert.fail(
        'legacy/checksums.json is missing. Run `npm run oracle:freeze` once after copying ' +
          'the .gs files in (and after the key placeholder swap) to lock the oracle.',
      );
    }
    const actual = computeChecksums();
    for (const file of ORACLE_FILES) {
      assert.equal(actual[file], manifest[file], `legacy/${file} has been modified — the oracle must stay frozen`);
    }
  });

  test('calling an unknown function fails loudly', () => {
    const oracle = loadOracle();
    assert.throws(() => oracle.call('thisDoesNotExist'), /no function/);
  });
});

test('oracle files list matches the documented set', () => {
  assert.equal(ORACLE_FILES.length, 10);
});
