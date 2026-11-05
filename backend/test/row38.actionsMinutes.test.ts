/**
 * Row 38: the nightly digest's "GitHub minutes this month" line (src/reports/digest/actionsMinutes.ts), with a fake
 * GitHub API. No network.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionsMinutesLine, readActionsMinutes, timingMinutes, wallMinutes, minutesLine, monthStartUtc,
  MAX_LISTED_RUNS, MAX_TIMING_CALLS, MINUTES_UNREADABLE, type FetchLike,
} from '../src/reports/digest/actionsMinutes.ts';

const NOW = Date.parse('2026-10-31T03:30:00Z');
const ENV = { GITHUB_TOKEN: 'ghs_test', GITHUB_REPOSITORY: 'owner/TradingAnalyzerBackEnd' };

interface FakeRun { id: number; status?: string; conclusion?: string | null; run_started_at?: string; updated_at?: string }

/** A fake GitHub: `runs` listed per_page at a time; `timing(id)` -> body, or a number = that HTTP status. */
function fakeGithub(runs: FakeRun[], timing: (id: number) => unknown, opts: { listStatus?: number } = {}) {
  const urls: string[] = [];
  const auth: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    urls.push(url);
    auth.push(init.headers.Authorization ?? '');
    const u = new URL(url);
    const m = /\/actions\/runs\/(\d+)\/timing$/.exec(u.pathname);
    if (m) {
      const body = timing(Number(m[1]));
      if (typeof body === 'number') return { ok: false, status: body, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => body };
    }
    if (opts.listStatus) return { ok: false, status: opts.listStatus, json: async () => ({}) };
    const page = Number(u.searchParams.get('page') ?? 1), per = Number(u.searchParams.get('per_page') ?? 30);
    return { ok: true, status: 200, json: async () => ({ total_count: runs.length, workflow_runs: runs.slice((page - 1) * per, page * per) }) };
  };
  return { fetchImpl, urls, auth };
}

const ubuntu = (...jobsMs: number[]) => ({ billable: { UBUNTU: { total_ms: jobsMs.reduce((a, b) => a + b, 0), jobs: jobsMs.length, job_runs: jobsMs.map((d, i) => ({ job_id: i, duration_ms: d })) } } });

describe('Row 38: GitHub Actions minutes this month', () => {
  test('the month starts on the 1st, UTC', () => {
    assert.equal(monthStartUtc(NOW), '2026-10-01');
    assert.equal(monthStartUtc(Date.parse('2026-11-01T00:00:00Z')), '2026-11-01');
  });

  test('timing: each job rounded up to a whole minute; total_ms when there are no job_runs; Windows x2, macOS x10; no billable = null', () => {
    assert.equal(timingMinutes(ubuntu(61_000, 1_000)), 3);
    assert.equal(timingMinutes({ billable: { UBUNTU: { total_ms: 120_001 } } }), 3);
    assert.equal(timingMinutes({ billable: { WINDOWS: { total_ms: 60_000 }, MACOS: { total_ms: 30_000 } } }), 12);
    assert.equal(timingMinutes({ billable: {} }), null);
    assert.equal(timingMinutes({}), null);
    assert.equal(timingMinutes(null), null);
  });

  test('fallback: run_started_at -> updated_at rounded up; skipped or bad dates = 0', () => {
    assert.equal(wallMinutes({ run_started_at: '2026-10-30T03:23:00Z', updated_at: '2026-10-30T03:40:01Z' }), 18);
    assert.equal(wallMinutes({ conclusion: 'skipped', run_started_at: '2026-10-30T03:23:00Z', updated_at: '2026-10-30T03:40:00Z' }), 0);
    assert.equal(wallMinutes({}), 0);
  });

  test('the line: thousands separator, the warning from 1,500, "+" when runs were left unlisted', () => {
    assert.equal(minutesLine(412), 'GitHub minutes this month: ~412 of 2,000 (est.)');
    assert.equal(minutesLine(1499), 'GitHub minutes this month: ~1,499 of 2,000 (est.)');
    assert.equal(minutesLine(1500), 'GitHub minutes this month: ~1,500 of 2,000 (est.) ⚠️ near the free limit');
    assert.equal(minutesLine(2310, true), 'GitHub minutes this month: ~2,310+ of 2,000 (est.) ⚠️ near the free limit');
    assert.equal(minutesLine(null), MINUTES_UNREADABLE);
  });

  test('sums the timing of every run created since the 1st; a failed timing read falls back to the wall clock', async () => {
    const runs: FakeRun[] = [
      { id: 1, conclusion: 'success', run_started_at: '2026-10-02T03:23:00Z', updated_at: '2026-10-02T03:50:00Z' },
      { id: 2, conclusion: 'success', run_started_at: '2026-10-03T03:23:00Z', updated_at: '2026-10-03T03:30:00Z' },
      { id: 3, conclusion: 'skipped' },
    ];
    const gh = fakeGithub(runs, (id) => (id === 1 ? ubuntu(25 * 60_000 + 1) : 502));
    const r = await readActionsMinutes({ env: ENV, now: NOW, fetchImpl: gh.fetchImpl });
    assert.equal(r.minutes, 26 + 7);
    assert.equal(r.runs, 3);
    assert.equal(r.more, false);
    assert.equal(r.timingCalls, 2, 'no timing read for a skipped run');
    const list = new URL(gh.urls[0] as string);
    assert.equal(list.pathname, '/repos/owner/TradingAnalyzerBackEnd/actions/runs');
    assert.equal(list.searchParams.get('created'), '>=2026-10-01');
    assert.ok(gh.auth.every((a) => a === 'Bearer ghs_test'));
  });

  test('the API calls are capped: at most 3 list pages and 100 timing reads; the rest use the wall clock', async () => {
    const runs: FakeRun[] = Array.from({ length: 450 }, (_, i) => ({ id: i + 1, conclusion: 'success', run_started_at: '2026-10-05T00:00:00Z', updated_at: '2026-10-05T00:02:00Z' }));
    const gh = fakeGithub(runs, () => ubuntu(60_000));
    const r = await readActionsMinutes({ env: ENV, now: NOW, fetchImpl: gh.fetchImpl });
    const timingUrls = gh.urls.filter((u) => u.endsWith('/timing'));
    assert.equal(gh.urls.length - timingUrls.length, MAX_LISTED_RUNS / 100);
    assert.equal(timingUrls.length, MAX_TIMING_CALLS);
    assert.equal(r.runs, MAX_LISTED_RUNS);
    assert.equal(r.minutes, MAX_TIMING_CALLS * 1 + (MAX_LISTED_RUNS - MAX_TIMING_CALLS) * 2);
    assert.equal(r.more, true);
  });

  test('never throws: no token, a refused list, a thrown fetch or a hang give "could not read"', async () => {
    const logs: string[] = [];
    assert.equal(await actionsMinutesLine({ env: {}, now: NOW, fetchImpl: fakeGithub([], () => ({})).fetchImpl, log: (m) => logs.push(m) }), MINUTES_UNREADABLE);
    assert.equal(await actionsMinutesLine({ env: ENV, now: NOW, fetchImpl: fakeGithub([], () => ({}), { listStatus: 403 }).fetchImpl }), MINUTES_UNREADABLE);
    assert.equal(await actionsMinutesLine({ env: ENV, now: NOW, fetchImpl: async () => { throw new Error('network down'); } }), MINUTES_UNREADABLE);
    assert.equal(await actionsMinutesLine({ env: ENV, now: NOW, fetchImpl: () => new Promise(() => {}), totalTimeoutMs: 20 }), MINUTES_UNREADABLE);
    assert.ok(logs.some((l) => l.includes('GitHub minutes not read')));
  });

  test('the happy line', async () => {
    const runs: FakeRun[] = [{ id: 7, conclusion: 'success' }];
    const line = await actionsMinutesLine({ env: ENV, now: NOW, fetchImpl: fakeGithub(runs, () => ubuntu(1600 * 60_000)).fetchImpl });
    assert.equal(line, 'GitHub minutes this month: ~1,600 of 2,000 (est.) ⚠️ near the free limit');
  });
});
