/**
 * Row 38: GitHub Actions minutes used this month, for the nightly digest. The owner runs on the FREE minutes only
 * (2,000 a month on a private repo; they ran out once, on 30 Oct), so the digest carries one line:
 *   "GitHub minutes this month: ~N of 2,000 (est.)"   (+ " ⚠️ near the free limit" from 1,500)
 *
 * How: the workflow's own GITHUB_TOKEN (`actions: read`) lists the repo's runs created since the 1st of the month
 * (UTC), then each run's billable time from `/actions/runs/{id}/timing` (each job rounded UP to a whole minute, as
 * GitHub bills; Windows x2 and macOS x10, though every workflow here runs on Ubuntu). When a run's timing is missing,
 * the estimate falls back to run_started_at -> updated_at, rounded up.
 *
 * Fix 2026-11-04 (the line read "~0" after 14 runs): `/timing` can answer `billable: {}` or billable entries whose
 * job durations are all 0 (GitHub no longer fills them on every plan); a 0 was taken as the real figure. Now a
 * billable figure of 0 for a completed run that lasted more than MIN_REAL_RUN_MS is treated as missing: the run's
 * jobs (`/actions/runs/{id}/jobs`) are summed, each rounded UP to a minute; when job timing is unavailable too, the
 * run's own duration (`run_duration_ms`, else run_started_at -> updated_at) is used, rounded up. The API calls are capped (MAX_LISTED_RUNS
 * listed, MAX_TIMING_CALLS timing reads; the rest of the runs use the fallback). It is an ESTIMATE: only this repo's
 * runs are seen, while the free minutes are per account.
 *
 * Never throws: any failure gives the line "GitHub minutes: could not read" (the nightly and the digest go on).
 */

export const FREE_MINUTES = 2000;
export const WARN_MINUTES = 1500;
export const MAX_LISTED_RUNS = 300;
export const MAX_TIMING_CALLS = 100;
const PER_PAGE = 100;
const TIMING_CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 15_000;
/** The whole read gives up after this (the digest must not wait on GitHub). */
export const TOTAL_TIMEOUT_MS = 90_000;
export const MINUTES_UNREADABLE = 'GitHub minutes: could not read';

/** The subset of fetch this uses (tests pass a fake). */
export type FetchLike = (url: string, init: { readonly headers: Readonly<Record<string, string>> }) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;

export interface ActionsMinutesDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: number;
  readonly fetchImpl?: FetchLike;
  readonly log?: (m: string) => void;
  /** Tests: a shorter overall limit. */
  readonly totalTimeoutMs?: number;
}

interface RunItem { readonly id?: number; readonly status?: string; readonly conclusion?: string | null; readonly run_started_at?: string; readonly updated_at?: string }
interface Timing { readonly billable?: Readonly<Record<string, { readonly total_ms?: number; readonly job_runs?: ReadonlyArray<{ readonly duration_ms?: number }> }>>; readonly run_duration_ms?: number }
interface JobItem { readonly conclusion?: string | null; readonly started_at?: string | null; readonly completed_at?: string | null }

/** A completed run longer than this cannot really bill 0 minutes (every job bills at least one). */
export const MIN_REAL_RUN_MS = 5_000;

/** Billing multipliers by runner OS (GitHub's published rates). */
const MULTIPLIER: Readonly<Record<string, number>> = { UBUNTU: 1, WINDOWS: 2, MACOS: 10 };

/** The first day of `now`'s month, UTC, as YYYY-MM-DD. */
export function monthStartUtc(now: number): string {
  return new Date(now).toISOString().slice(0, 8) + '01';
}

/** Billable minutes of one run from its timing body, null when the body carries no billable data. */
export function timingMinutes(t: Timing | null | undefined): number | null {
  const b = t?.billable;
  if (!b || typeof b !== 'object') return null;
  let total = 0, seen = false;
  for (const [os, v] of Object.entries(b)) {
    if (!v) continue;
    const mult = MULTIPLIER[os] ?? 1;
    const jobs = Array.isArray(v.job_runs) ? v.job_runs : null;
    if (jobs && jobs.length) { seen = true; for (const j of jobs) total += Math.ceil(Math.max(0, Number(j.duration_ms) || 0) / 60_000) * mult; }
    else if (typeof v.total_ms === 'number') { seen = true; total += Math.ceil(Math.max(0, v.total_ms) / 60_000) * mult; }
  }
  return seen ? total : null;
}

/** The fallback: run_started_at -> updated_at, rounded up to a whole minute (0 for a skipped run or bad dates). */
export function wallMinutes(r: RunItem): number {
  if (r.conclusion === 'skipped') return 0;
  const a = Date.parse(r.run_started_at ?? ''), b = Date.parse(r.updated_at ?? '');
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return Math.ceil((b - a) / 60_000);
}

/** Minutes from a run's jobs listing, each job rounded up (skipped / unfinished jobs = 0); null when no job has timing. */
export function jobsMinutes(body: unknown): number | null {
  const jobs = (body as { jobs?: JobItem[] } | null)?.jobs;
  if (!Array.isArray(jobs)) return null;
  let total = 0, seen = false;
  for (const j of jobs) {
    if (j.conclusion === 'skipped') continue;
    const a = Date.parse(j.started_at ?? ''), b = Date.parse(j.completed_at ?? '');
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) continue;
    seen = true;
    total += Math.max(1, Math.ceil((b - a) / 60_000));
  }
  return seen && total > 0 ? total : null;
}

/** A finished run that lasted long enough to have billed something. */
function isRealCompletedRun(r: RunItem): boolean {
  if (r.status !== undefined && r.status !== 'completed') return false;
  if (r.conclusion === 'skipped') return false;
  const a = Date.parse(r.run_started_at ?? ''), b = Date.parse(r.updated_at ?? '');
  return Number.isFinite(a) && Number.isFinite(b) && b - a > MIN_REAL_RUN_MS;
}

/** The digest line for `minutes` (null = could not read). `more` = there were more runs than were listed. */
export function minutesLine(minutes: number | null, more = false): string {
  if (minutes == null) return MINUTES_UNREADABLE;
  const n = Math.round(minutes).toLocaleString('en-US');
  return 'GitHub minutes this month: ~' + n + (more ? '+' : '') + ' of ' + FREE_MINUTES.toLocaleString('en-US') + ' (est.)' + (minutes >= WARN_MINUTES ? ' ⚠️ near the free limit' : '');
}

/** Minutes this month (estimate) and whether the listing was cut by the cap. Throws on any API problem (the caller catches). */
export async function readActionsMinutes(d: ActionsMinutesDeps): Promise<{ readonly minutes: number; readonly runs: number; readonly more: boolean; readonly timingCalls: number; readonly jobCalls: number }> {
  const token = (d.env.GITHUB_TOKEN ?? '').trim(), repo = (d.env.GITHUB_REPOSITORY ?? '').trim();
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GITHUB_TOKEN / GITHUB_REPOSITORY not set');
  const f: FetchLike = d.fetchImpl ?? ((url, init) => globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }));
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const base = 'https://api.github.com/repos/' + repo + '/actions/runs';
  const get = async (url: string): Promise<unknown> => {
    const res = await f(url, { headers });
    if (!res.ok) throw new Error('GitHub API HTTP ' + res.status);
    return res.json();
  };
  const runs: RunItem[] = [];
  let total = 0;
  for (let page = 1; runs.length < MAX_LISTED_RUNS; page++) {
    const body = (await get(base + '?created=' + encodeURIComponent('>=' + monthStartUtc(d.now)) + '&per_page=' + PER_PAGE + '&page=' + page)) as { total_count?: number; workflow_runs?: RunItem[] };
    const items = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
    total = Number(body?.total_count) || 0;
    runs.push(...items.slice(0, MAX_LISTED_RUNS - runs.length));
    if (items.length < PER_PAGE || runs.length >= total) break;
  }
  // The timing reads, capped; a single failed read falls back to the wall-clock estimate for that run.
  const withTiming = runs.slice(0, MAX_TIMING_CALLS);
  const minutesOf = new Map<RunItem, number>();
  let next = 0, timingCalls = 0, jobCalls = 0;
  const worker = async (): Promise<void> => {
    while (next < withTiming.length) {
      const r = withTiming[next++] as RunItem;
      if (typeof r.id !== 'number' || r.conclusion === 'skipped') continue;
      timingCalls++;
      const t = await get(base + '/' + r.id + '/timing').then((b) => b as Timing, () => null);
      const m = timingMinutes(t);
      if (m != null && (m > 0 || !isRealCompletedRun(r))) { minutesOf.set(r, m); continue; }
      if (!isRealCompletedRun(r)) continue; // no timing for an unfinished run: the wall clock below
      // Billable missing or 0 for a real run: the jobs, each rounded up; else the run's own duration, rounded up.
      jobCalls++;
      const jm = await get(base + '/' + r.id + '/jobs?per_page=100').then(jobsMinutes, () => null);
      if (jm != null) { minutesOf.set(r, jm); continue; }
      const runMs = Number(t?.run_duration_ms);
      if (Number.isFinite(runMs) && runMs > 0) minutesOf.set(r, Math.ceil(runMs / 60_000));
    }
  };
  await Promise.all(Array.from({ length: TIMING_CONCURRENCY }, worker));
  const minutes = runs.reduce((s, r) => s + (minutesOf.get(r) ?? wallMinutes(r)), 0);
  return { minutes, runs: runs.length, more: total > runs.length, timingCalls, jobCalls };
}

/** The digest line. Never throws. */
export async function actionsMinutesLine(d: ActionsMinutesDeps): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out after ' + TOTAL_TIMEOUT_MS / 1000 + ' s')), d.totalTimeoutMs ?? TOTAL_TIMEOUT_MS); });
  return Promise.race([readActionsMinutes(d), limit]).finally(() => clearTimeout(timer)).then(
    (r) => { d.log?.('nightly digest: GitHub minutes ~' + r.minutes + ' from ' + r.runs + ' run(s), ' + r.timingCalls + ' timing read(s)' + (r.jobCalls ? ', ' + r.jobCalls + ' job listing(s) (billable time missing)' : '') + (r.more ? ', more runs not listed' : '')); return minutesLine(r.minutes, r.more); },
    (e: unknown) => { d.log?.('nightly digest: GitHub minutes not read: ' + String(e)); return MINUTES_UNREADABLE; },
  );
}
