/**
 * 5 Nov 2026 watchdog count fixes:
 *  1. A job's log artifact holds out/<job>.log and out/<job>.console.log (the same lines twice): only the full log is
 *     scanned (the console copy only when no full log exists), so a warning is counted once.
 *  2. JSON / key=value zero counts (`"warning":0`, `"failed":0`, `"failed":false`) are zero, not warnings.
 *  3. The Run Health row links the run its top problem came from.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { zipBytes } from './secFixtures.ts';
import { GitHub, buildReport, scanLog, zipText, type GhFetch, type GhRun } from '../src/watchdog.ts';

const REPO = 'owner/TradingAnalyzerBackEnd';
const NOW = Date.parse('2026-11-04T10:00:00Z');
const WARN = '2026-11-04T04:11:01.000Z WARNING [nightly:TSLA] price fetch failed for TSLA: HTTP 429 after 3 tries';
const INFO = '2026-11-04T04:12:00.000Z INFO    [nightly] done';

const warnings = (text: string): number => [...scanLog(text).values()].filter((f) => f.level === 'warning').reduce((s, f) => s + f.count, 0);

describe('1. the console copy of a log is not counted again', () => {
  test('out/<job>.log + out/<job>.console.log -> the full log only', () => {
    const z = zipBytes([['out/nightly.log', WARN + '\n' + INFO, 'deflate'], ['out/nightly.console.log', WARN, 'deflate']]);
    assert.equal(warnings(zipText(z)), 1);
  });
  test('only a console log -> it is read', () => {
    const z = zipBytes([['out/nightly.console.log', WARN, 'deflate']]);
    assert.equal(warnings(zipText(z)), 1);
  });
  test('another job\'s console log in the same zip is still read', () => {
    const z = zipBytes([['out/nightly.log', WARN, 'deflate'], ['out/other.console.log', WARN.replace('TSLA', 'AAPL'), 'deflate']]);
    assert.equal(warnings(zipText(z)), 2);
  });
});

describe('2. JSON zero values are zero', () => {
  test('INFO lines with "warning":0 / "failed":0 / "failed":false are not warnings', () => {
    const text = [
      '2026-11-04T22:15:00.000Z INFO    [myOptions] run finished {"warning":0,"error":0,"failed":0}',
      '2026-11-04T22:15:01.000Z INFO    [myOptions] Saved price tabs for 12 tickers {"failed":false}',
      '2026-11-04T22:15:02.000Z INFO    [myOptions] summary warnings=0 errors = 0',
    ].join('\n');
    assert.deepEqual([...scanLog(text).values()], []);
  });
  test('a real WARNING is still counted, even with a zero field', () => {
    const text = [
      WARN,
      '2026-11-04T22:15:03.000Z WARNING [myOptions] quote missing for AAPL {"failed":false}',
      '2026-11-04T22:15:04.000Z INFO    [myOptions] run finished {"failed":3}',
    ].join('\n');
    assert.equal(warnings(text), 3);
  });
});

describe('3. the row links the top problem\'s run', () => {
  test('a clean newer run and an older run with the warnings -> the older run\'s link', async () => {
    const mk = (id: number, created: string): GhRun => ({
      id, name: 'Nightly', path: '.github/workflows/nightly.yml', event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
      created_at: created, run_started_at: created, updated_at: new Date(Date.parse(created) + 120_000).toISOString(),
      html_url: 'https://github.com/' + REPO + '/actions/runs/' + id,
    });
    const newer = mk(2, '2026-11-04T06:00:00Z'), older = mk(1, '2026-11-04T04:10:00Z');
    const logs: Record<number, string> = { [newer.id]: INFO, [older.id]: WARN + '\n' + WARN };
    const res = (body: unknown, bytes?: Uint8Array) => ({
      ok: true, status: 200, json: async () => body, arrayBuffer: async () => new Uint8Array(bytes ?? new Uint8Array()).buffer,
    });
    const f: GhFetch = async (url) => {
      const m = /\/runs\/(\d+)\/logs$/.exec(url);
      if (m) return res(null, zipBytes([['0_job.txt', logs[Number(m[1])] ?? '', 'deflate']]));
      if (/\/runs\/\d+\/artifacts/.test(url)) return res({ artifacts: [] });
      if (/\/runs\/\d+\/(jobs|timing)/.test(url)) return res({ jobs: [] });
      if (/\/actions\/runs\?/.test(url)) return res({ total_count: 2, workflow_runs: [newer, older] });
      throw new Error('unexpected URL ' + url);
    };
    const r = await buildReport({ env: {}, now: NOW }, new GitHub('t' + 'k', REPO, f));
    const row = r.rows.find((x) => x.file === 'nightly.yml' && x.ran === '2');
    assert.ok(row, JSON.stringify(r.rows));
    assert.equal(row.warnings, 2);
    assert.match(row.topProblem, /^2× WARNING/);
    assert.equal(row.link, older.html_url);
  });
});
