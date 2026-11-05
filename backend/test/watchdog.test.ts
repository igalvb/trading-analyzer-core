/**
 * Owner 2026-11-04: the daily run watchdog (src/watchdog.ts) against a fake GitHub API and a fake Telegram.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { zipBytes } from './secFixtures.ts';
import {
  RUN_HEALTH_HEADER, RUN_HEALTH_TAB, expectedChecks, myOptionsWindow, nightlyWindow, patternOf, runWatchdog, scanLog,
  type GhFetch, type GhRun,
} from '../src/watchdog.ts';
import { OPS_REPORT_TABS, PROTECTED_TABS, isAllowListedName, sheetFor } from '../src/sheets/tabs.ts';

const REPO = 'owner/TradingAnalyzerBackEnd';
const ENV = { GITHUB_TOKEN: 'gh-test', GITHUB_REPOSITORY: REPO, TELEGRAM_BOT_TOKEN: 'tg-test', TELEGRAM_CHAT_ID: '42' };
const NOW = Date.parse('2026-11-04T10:00:00Z'); // Wednesday; New York on EST since 1 Nov

let nextId = 1000;
function run(file: string, created: string, opts: Partial<GhRun> & { minutes?: number } = {}): GhRun {
  const id = nextId++;
  const start = Date.parse(created);
  return {
    id, name: file === 'nightly.yml' ? 'Nightly' : file === 'my-options.yml' ? 'My Options' : file, path: '.github/workflows/' + file,
    event: 'workflow_dispatch', status: 'completed', conclusion: 'success', created_at: created, run_started_at: created,
    updated_at: new Date(start + (opts.minutes ?? 2) * 60_000).toISOString(), html_url: 'https://github.com/' + REPO + '/actions/runs/' + id, ...opts,
  };
}

interface FakeGh { runs: GhRun[]; logs?: Record<number, string>; artifactLogs?: Record<number, string>; skipped?: Set<number>; fail?: boolean }

function fakeGitHub(g: FakeGh): { fetch: GhFetch; calls: string[] } {
  const calls: string[] = [];
  const res = (body: unknown, bytes?: Uint8Array, status = 200) => ({
    ok: status < 400, status, json: async () => body, arrayBuffer: async () => new Uint8Array(bytes ?? new Uint8Array()).buffer,
  });
  const fetch: GhFetch = async (url, init) => {
    calls.push(url);
    assert.equal(init.headers.Authorization, 'Bearer gh-test');
    if (g.fail) return res({}, undefined, 500);
    let m: RegExpExecArray | null;
    if ((m = /\/runs\/(\d+)\/timing$/.exec(url))) return res({ billable: { UBUNTU: { total_ms: 120_000 } } });
    if ((m = /\/runs\/(\d+)\/jobs/.exec(url))) {
      const skipped = g.skipped?.has(Number(m[1]));
      return res({ jobs: [{ steps: [{ name: 'New York hour guard', conclusion: 'success' }, { name: 'Refresh My Options values', conclusion: skipped ? 'skipped' : 'success' }] }] });
    }
    if ((m = /\/runs\/(\d+)\/artifacts/.exec(url))) {
      const id = Number(m[1]);
      return res({ artifacts: g.artifactLogs?.[id] != null ? [{ name: 'nightly-log-' + id, expired: false, size_in_bytes: 100, archive_download_url: 'https://api.github.com/repos/' + REPO + '/actions/artifacts/' + id + '/zip' }] : [] });
    }
    if ((m = /\/artifacts\/(\d+)\/zip$/.exec(url))) return res(null, zipBytes([['nightly.log', g.artifactLogs?.[Number(m[1])] ?? '', 'deflate']]));
    if ((m = /\/runs\/(\d+)\/logs$/.exec(url))) {
      const text = g.logs?.[Number(m[1])] ?? '2026-11-04T04:00:00.0000000Z all good';
      return res(null, zipBytes([['0_job.txt', text, 'deflate'], ['job/1_step.txt', text, 'store']]));
    }
    if (/\/actions\/runs\?/.test(url)) return res({ total_count: g.runs.length, workflow_runs: g.runs });
    throw new Error('unexpected URL ' + url);
  };
  return { fetch, calls };
}

function fakeTelegram(): { fetch: typeof fetch; sent: string[] } {
  const sent: string[] = [];
  const f = (async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body).text);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: f, sent };
}

/** My Options real runs in both judged windows (2 Nov and 3 Nov, 17:05 New York = 22:05 UTC). */
const myOptionsOk = (): GhRun[] => [run('my-options.yml', '2026-11-02T22:10:00Z', { event: 'schedule' }), run('my-options.yml', '2026-11-03T22:10:00Z', { event: 'schedule' })];

async function check(g: FakeGh, now = NOW) {
  const gh = fakeGitHub(g), tg = fakeTelegram();
  const appended: (readonly (string | number)[])[] = [];
  const text = await runWatchdog({ env: ENV, now, fetchImpl: gh.fetch, telegramFetch: tg.fetch, appendRows: async (rows) => { appended.push(...rows); return rows.length; } });
  return { text, sent: tg.sent, rows: appended, calls: gh.calls };
}

describe('watchdog: expected runs', () => {
  test('a missing Nightly -> ❌ did not run (and tonight\'s still-open window -> ⚠️ not yet)', async () => {
    const r = await check({ runs: myOptionsOk() });
    assert.equal(r.sent.length, 1, 'one Telegram message');
    assert.equal(r.sent[0], r.text);
    assert.match(r.text, /❌ Nightly — did not run/);
    assert.match(r.text, /Nightly did not run for 2026-11-02/);
    assert.match(r.text, /⚠️ Nightly — not yet/);
    const row = r.rows.find((x) => x[1] === 'Nightly' && x[2] === 'yes (2026-11-02)');
    assert.ok(row, 'a sheet row for the missing night');
    assert.equal(row[3], 'no');
    assert.equal(row[4], '❌ did not run');
    assert.ok(!/My Options did not run/.test(r.text), 'My Options ran in both windows');
  });
  test('a Nightly created in the window counts; a My Options run ended early by its guard does not', async () => {
    const early = run('my-options.yml', '2026-11-03T22:10:00Z', { event: 'schedule', minutes: 0.2 });
    const r = await check({ runs: [run('nightly.yml', '2026-11-03T05:30:00Z', { minutes: 6 }), run('nightly.yml', '2026-11-04T04:10:00Z', { minutes: 6 }), run('my-options.yml', '2026-11-02T22:10:00Z'), early], skipped: new Set([early.id]) });
    assert.ok(!/Nightly did not run/.test(r.text), r.text);
    assert.match(r.text, /My Options did not run for 2026-11-03 \(nothing real created/);
    assert.match(r.text, /✅ Nightly — 1 run, 6 min, 0 W \/ 0 E, expected ✓/);
  });
  test('a holiday is not expected (Thanksgiving 2026-11-26: no Nightly the next morning, no My Options)', () => {
    const now = Date.parse('2026-11-27T12:00:00Z');
    const checks = expectedChecks(now, [], new Set());
    assert.ok(!checks.some((c) => c.day === '2026-11-26'), JSON.stringify(checks.map((c) => c.job + ' ' + c.day)));
    assert.ok(checks.some((c) => c.job === 'Nightly' && c.day === '2026-11-25' && c.state === 'missing'), 'the day before still is');
    // A weekend: Saturday 7 Nov at noon UTC judges Friday's night and nothing for Saturday.
    const sat = expectedChecks(Date.parse('2026-11-08T12:00:00Z'), [], new Set());
    assert.ok(sat.every((c) => c.day <= '2026-11-06'), JSON.stringify(sat.map((c) => c.day)));
  });
  test('the windows: Nightly 03:00-13:00 UTC the next day; My Options 17:00 New York (EDT and EST) to 05:00 UTC', () => {
    assert.deepEqual(Object.values(nightlyWindow('2026-11-03')).map((t) => new Date(t).toISOString()), ['2026-11-04T03:00:00.000Z', '2026-11-04T13:00:00.000Z']);
    assert.equal(new Date(myOptionsWindow('2026-11-03').from).toISOString(), '2026-11-03T22:00:00.000Z');
    assert.equal(new Date(myOptionsWindow('2026-10-30').from).toISOString(), '2026-10-30T21:00:00.000Z');
    assert.equal(new Date(myOptionsWindow('2026-11-03').to).toISOString(), '2026-11-04T05:00:00.000Z');
  });
});

describe('watchdog: runs and logs', () => {
  test('a failed run -> ❌ with its link among the top problems', async () => {
    const bad = run('nightly.yml', '2026-11-04T04:10:00Z', { conclusion: 'failure' });
    const r = await check({ runs: [...myOptionsOk(), run('nightly.yml', '2026-11-03T04:00:00Z'), bad] });
    assert.match(r.text, /❌ Nightly — 1 run, 1 failure/);
    assert.match(r.text, /Top problems:\n1\. ❌ 1× Nightly: Nightly run failure\n {3}https:\/\/github\.com\/.*\/runs\/\d+/);
    assert.ok(r.text.includes(String(bad.html_url)));
    const row = r.rows.find((x) => x[1] === 'Nightly' && x[3] === '1');
    assert.ok(row && String(row[4]).startsWith('❌'));
  });
  test('a log with 3 WARNING lines of one pattern -> one group counted 3', async () => {
    const n = run('nightly.yml', '2026-11-04T04:10:00Z', { minutes: 6 });
    const log = [
      '2026-11-04T04:11:00.000Z INFO    [nightly] start',
      '2026-11-04T04:11:01.000Z WARNING [nightly:TSLA] price fetch failed for TSLA: HTTP 429 after 3 tries',
      '2026-11-04T04:11:02.000Z WARNING [nightly:AAPL] price fetch failed for AAPL: HTTP 429 after 3 tries',
      '2026-11-04T04:11:03.000Z WARNING [nightly:MSFT] price fetch failed for MSFT: HTTP 429 after 4 tries {"detail":"x"}',
      '2026-11-04T04:12:00.000Z INFO    [nightly] 0 failed, done',
    ].join('\n');
    const r = await check({ runs: [...myOptionsOk(), n], artifactLogs: { [n.id]: log } });
    assert.match(r.text, /✅ Nightly — 1 run, 6 min, 3 W \/ 0 E/);
    assert.match(r.text, /⚠️ 3× Nightly: WARNING \[nightly:TSLA\] price fetch failed for TSLA/);
    const row = r.rows.find((x) => x[1] === 'Nightly' && x[3] === '1');
    assert.equal(row?.[6], 3);
    assert.equal(row?.[7], 0);
    assert.match(String(row?.[8]), /^3× WARNING/);
    assert.ok(r.calls.some((u) => u.endsWith('/artifacts/' + n.id + '/zip')), 'the artifact was read');
    assert.ok(!r.calls.some((u) => u.endsWith('/runs/' + n.id + '/logs')), 'not the run log as well');
  });
  test('scanLog: errors, stack traces once per block, the step scripts in ##[group] skipped, zero counts ignored', () => {
    const text = [
      '2026-11-04T04:00:00.1Z ##[group]Run npm run nightly',
      '2026-11-04T04:00:00.1Z echo "::error::The value of $name appears in the run log."',
      '2026-11-04T04:00:00.1Z ##[endgroup]',
      '2026-11-04T04:00:01.1Z TypeError: Cannot read properties of undefined (reading \'close\')',
      '    at analyze (file:///x/src/a.ts:10:5)',
      '    at main (file:///x/src/b.ts:3:1)',
      '2026-11-04T04:00:02.1Z ERROR   [nightly] step exit.report degraded',
      '# fail 0',
      'Errors: 0',
    ].join('\n');
    const f = [...scanLog(text).values()];
    assert.deepEqual(f.map((x) => [x.level, x.count]), [['error', 1], ['error', 1], ['error', 1]]);
    assert.ok(f.some((x) => x.key.startsWith('stack trace after: TypeError')));
    assert.equal(patternOf('WARNING [nightly:TSLA] fetch failed for TSLA 3'), patternOf('WARNING [nightly:NVDA] fetch failed for NVDA 12'));
  });
  test('a run without a log artifact: GitHub\'s run log is read (top-level files only, not the per-step copies)', async () => {
    const b = run('nightly-backup.yml', '2026-11-04T08:00:00Z', { name: 'Nightly Backup', minutes: 0.3 });
    const r = await check({ runs: [...myOptionsOk(), run('nightly.yml', '2026-11-04T04:00:00Z'), b], logs: { [b.id]: '2026-11-04T08:00:01.0000000Z Telegram message could not be sent.' } });
    assert.match(r.text, /✅ Nightly Backup — 1 run, 1 min, 1 W \/ 0 E/);
  });
  test('a run twice as slow as its normal -> ⚠️ slow', async () => {
    const hist = ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31'].map((d) => run('nightly.yml', d + 'T04:00:00Z', { minutes: 5 }));
    const r = await check({ runs: [...myOptionsOk(), ...hist, run('nightly.yml', '2026-11-03T04:00:00Z', { minutes: 5 }), run('nightly.yml', '2026-11-04T04:00:00Z', { minutes: 14 })] });
    assert.match(r.text, /⚠️ Nightly — 1 run, slow 14 min vs 5 normal, 14 min/);
  });
  test('the minutes line and the sheet rows follow the header', async () => {
    const r = await check({ runs: [...myOptionsOk(), run('nightly.yml', '2026-11-04T04:00:00Z')] });
    assert.match(r.text, /GitHub minutes this month: ~\d+ of 2,000 \(est\.\)/);
    for (const row of r.rows) assert.equal(row.length, RUN_HEALTH_HEADER.length);
    assert.equal(r.rows[0]?.[0], '2026-11-04');
    assert.deepEqual([...RUN_HEALTH_HEADER], ['Date', 'Job', 'Expected', 'Ran', 'Result', 'Minutes', 'Warnings', 'Errors', 'Top problem', 'Run link']);
  });
});

describe('watchdog: never fails loudly', () => {
  test('GitHub unreadable -> the failure itself goes to Telegram', async () => {
    const r = await check({ runs: [], fail: true });
    assert.equal(r.sent.length, 1);
    assert.match(r.sent[0] as string, /❌ the watchdog itself failed: GitHub API HTTP 500/);
  });
  test('the sheet refusing -> still one Telegram message, with a note', async () => {
    const gh = fakeGitHub({ runs: myOptionsOk() }), tg = fakeTelegram();
    const text = await runWatchdog({ env: ENV, now: NOW, fetchImpl: gh.fetch, telegramFetch: tg.fetch, appendRows: async () => { throw new Error('quota'); } });
    assert.equal(tg.sent.length, 1);
    assert.match(text, /ℹ️ Sheet not updated: quota/);
  });
  test('no GitHub token -> reported, nothing thrown', async () => {
    const tg = fakeTelegram();
    const text = await runWatchdog({ env: { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' }, now: NOW, telegramFetch: tg.fetch, appendRows: async () => 0 });
    assert.match(text, /GITHUB_TOKEN/);
    assert.equal(tg.sent.length, 1);
  });
  test('the tab is a known, protected report tab in the reports sheet', () => {
    assert.deepEqual([...OPS_REPORT_TABS], [RUN_HEALTH_TAB]);
    assert.equal(sheetFor(RUN_HEALTH_TAB), 'reports');
    assert.ok(isAllowListedName(RUN_HEALTH_TAB) && PROTECTED_TABS.includes(RUN_HEALTH_TAB));
  });
});
