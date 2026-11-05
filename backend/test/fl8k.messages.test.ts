/**
 * FL-8k: the report message catalog, classifyError, the Data quality block and the report leak scanner.
 * Real leaking strings from findings F-E3, F-F6, F-H1..H3 and F-I6 are the true positives.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HttpStatusError } from '../src/net/http.ts';
import { TimeoutError } from '../src/core/errors.ts';
import {
  REASON_CODES, EFFECTS, classifyError, reasonLine, reasonSentence, severityOf, labelledReason,
  dataQualityLines, dataAgeText, type EffectCode, type QualityItem,
} from '../src/reports/messages/catalog.ts';
import { findReportLeaks, assertNoReportLeaks } from '../src/reports/messages/leakScan.ts';

const NOW = new Date('2026-10-24T16:00:00Z');
const OCT12 = new Date('2026-10-12T16:00:00Z');

describe('catalog sentences', () => {
  test('every reason code builds a clean sentence', () => {
    for (const code of REASON_CODES) {
      assert.deepEqual(findReportLeaks(reasonLine(code)), [], code);
      assert.deepEqual(findReportLeaks(reasonSentence(code)), [], code);
      assert.match(reasonLine(code), /^[A-Z].*\.$/, code);
      assert.ok(['Note', 'Warning'].includes(severityOf(code)), code);
      assert.deepEqual(findReportLeaks(labelledReason('Exit ladder', code)), [], code);
    }
  });
  test('every effect sentence is clean and ends with a period', () => {
    for (const [k, v] of Object.entries(EFFECTS)) {
      assert.deepEqual(findReportLeaks(v), [], k);
      assert.match(v, /^[A-Z].*\.$/, k);
    }
  });
  test('named sentences', () => {
    assert.equal(reasonLine('RATE_LIMIT'), 'The request limit was reached.');
    assert.equal(reasonSentence('PROVIDER_NO_RESPONSE'), 'the data provider did not respond');
    assert.equal(labelledReason('Portfolio', 'SHEET_UNREADABLE'), 'Portfolio: The sheet could not be read.');
    assert.equal(reasonLine('NOT_SAVED_YET'), 'The nightly job has not saved a recent copy yet.', 'L-2');
  });
});

describe('classifyError', () => {
  const U = 'https://api.example.com/v1/q?apikey=SECRET123456';
  test('HTTP statuses', () => {
    assert.equal(classifyError(new HttpStatusError(429, U)), 'RATE_LIMIT');
    assert.equal(classifyError(new HttpStatusError(503, U)), 'PROVIDER_NO_RESPONSE');
    assert.equal(classifyError(new HttpStatusError(500, U)), 'PROVIDER_NO_RESPONSE');
    assert.equal(classifyError(new HttpStatusError(404, U)), 'NO_DATA_FOR_TICKER');
    assert.equal(classifyError(new HttpStatusError(400, U)), 'RESPONSE_UNREADABLE');
    assert.equal(classifyError(Object.assign(new Error('x'), { status: 429 })), 'RATE_LIMIT');
  });
  test('timeouts and network errors', () => {
    assert.equal(classifyError(new TimeoutError(1000, 'step')), 'PROVIDER_NO_RESPONSE');
    assert.equal(classifyError(Object.assign(new Error('net'), { code: 'ECONNRESET' })), 'PROVIDER_NO_RESPONSE');
    assert.equal(classifyError(Object.assign(new Error('aborted'), { name: 'AbortError' })), 'PROVIDER_NO_RESPONSE');
  });
  test('parse errors and unknown values', () => {
    assert.equal(classifyError(new SyntaxError('Unexpected token < in JSON at position 0')), 'RESPONSE_UNREADABLE');
    assert.equal(classifyError(new TypeError("Cannot read properties of undefined (reading 'toFixed')")), 'RESPONSE_UNREADABLE');
    assert.equal(classifyError(undefined), 'RESPONSE_UNREADABLE');
    assert.equal(classifyError('boom'), 'RESPONSE_UNREADABLE');
    assert.equal(classifyError({ weird: true }), 'RESPONSE_UNREADABLE');
  });
  test('provider wording', () => {
    assert.equal(classifyError(new Error('Limit Reach - upgrade your plan')), 'RATE_LIMIT');
    assert.equal(classifyError(new Error('No data found for ZZZZ')), 'NO_DATA_FOR_TICKER');
  });
  test('the error text never reaches the sentence', () => {
    const errs = [new HttpStatusError(429, U), new TypeError('Cannot read properties of undefined'), new Error('SEC EDGAR returned 503'), new TimeoutError(5, 'https://x.test/?token=abc')];
    for (const e of errs) {
      const line = reasonLine(classifyError(e));
      assert.ok(!line.includes('SECRET123456') && !line.includes('503') && !line.includes('http'), line);
      assert.deepEqual(findReportLeaks(line), []);
    }
  });
});

describe('dataQualityLines', () => {
  const item = (o: Partial<QualityItem>): QualityItem =>
    ({ label: 'Fundamentals', reasonCode: 'PROVIDER_NO_RESPONSE', effect: 'PRICE_CHART_ONLY', now: NOW, ...o });
  test('missing source', () => {
    assert.deepEqual(dataQualityLines([item({})]), [
      'Data quality',
      'Warning: Fundamentals: The data provider did not respond. The score uses price and chart signals only.',
    ]);
  });
  test('saved copy reused shows its age', () => {
    const lines = dataQualityLines([item({ savedDate: OCT12, effect: 'USES_SAVED_DATA' })]);
    assert.equal(lines[1], 'Warning: Fundamentals from Oct 12, 12 days old, used because the data provider did not respond. The score uses the saved data.');
  });
  test('saved copy too old', () => {
    const lines = dataQualityLines([item({ reasonCode: 'SAVED_COPY_TOO_OLD', savedDate: new Date('2025-12-01T15:00:00Z') })]);
    assert.equal(lines[1], 'Warning: Fundamentals: The saved copy from Dec 1, 2025, 327 days old is too old to trust. The score uses price and chart signals only.');
  });
  test('note severity and no issues', () => {
    assert.equal(dataQualityLines([item({ label: 'AI narrative', reasonCode: 'AI_REVIEW_UNAVAILABLE', effect: 'NO_AI_SUMMARY' })])[1],
      'Note: AI narrative: The AI review was not available. The report has no AI summary.');
    assert.deepEqual(dataQualityLines([]), ['Data quality', 'No data issues.']);
  });
  test('age wording and New York day boundaries', () => {
    assert.equal(dataAgeText(NOW, NOW), 'Oct 24, saved today');
    assert.equal(dataAgeText(new Date('2026-10-23T12:00:00Z'), NOW), 'Oct 23, 1 day old');
    // 02:00 UTC on Oct 24 is still Oct 23 in New York.
    assert.equal(dataAgeText(new Date('2026-10-24T02:00:00Z'), new Date('2026-10-24T20:00:00Z')), 'Oct 23, 1 day old');
  });
  test('every code x effect line is clean', () => {
    for (const reasonCode of REASON_CODES) for (const effect of Object.keys(EFFECTS) as EffectCode[]) {
      assert.deepEqual(dataQualityLines([item({ reasonCode, effect, savedDate: OCT12 }), item({ reasonCode, effect })]).flatMap(findReportLeaks), []);
    }
  });
});

describe('leak scanner', () => {
  const leaks = [
    'ERROR: Entry price (avg cost) must be a valid positive number. Got: 0',
    "⚠️ LILO ladder error: Cannot read properties of undefined (reading 'toFixed')",
    'SEC EDGAR returned 503',
    'HTTP 429 from https://api.example.com/v1/q?apikey=abc',
    'http://example.com',
    'Request failed, status 500',
    'TypeError: x is not a function',
    '    at Object.<anonymous> (/Users/me/app/src/x.ts:10:5)',
    'at fetchAll (file.ts:12:3)',
    'url?apikey=abc123',
    'token=abc',
    'key=zzz',
    'a3f5c9d8e7b6a5f4c3d2e1f0a9b8c7d6e5f4a3b2',
    'Authorization: Bearer abcdef123456',
    'Saw it in /Users/me/stocks/run.log',
    'see C:\\Users\\me\\x.txt',
    'src/reports/text/textReports.ts',
    'not found — undefined',
    'Got [object Object]',
    'code 404 returned',
  ];
  test('true positives', () => {
    for (const t of leaks) assert.ok(findReportLeaks(t).length > 0, t);
  });
  const clean = [
    'Fundamentals: The data provider did not respond. The score uses price and chart signals only.',
    'Conviction 72/100', 'Score 72/100 with a $150.50 entry', 'Fundamentals from Oct 12, 12 days old', '2026-10-24', '10/12/2026',
    'Buy near $150.50, stop $142.00, target $171.25', 'Volume was 1,250,000 shares', 'RSI 58.3, up 2.4% on the week',
    'The stock is at 52-week highs', 'Market opens at 9:30 AM ET', 'Support at 148, resistance at 155', 'Q3 2026 EPS $2.15 beat by 4%',
    'Price 503.20 and volume up', 'Key levels: support 148', 'No data issues.',
  ];
  test('true negatives', () => {
    for (const t of clean) assert.deepEqual(findReportLeaks(t), [], t);
  });
  test('assertNoReportLeaks', () => {
    assert.doesNotThrow(() => assertNoReportLeaks([['Ticker', 'AAPL', 72], ['Data quality'], []]));
    assert.throws(() => assertNoReportLeaks([['ok', 'SEC EDGAR returned 503']]), /R1C2/);
    assert.throws(() => assertNoReportLeaks([[new Error('boom')]]), /Error object/);
  });
});
