/**
 * npm run watchdog (owner request 2026-11-04): one daily check of EVERY GitHub Actions run, after the Cloudflare relay
 * timers silently stopped and nobody noticed a missing Nightly for three days (2-4 Nov).
 *
 * With the workflow's own GITHUB_TOKEN (`actions: read`) it reads this repo's runs and reports:
 *   (a) EXPECTED runs that did not happen:
 *       - Nightly: one run CREATED between 03:00 and 13:00 UTC on the night after every NYSE trading day
 *         (live/marketCalendar.ts: weekends and holidays are not expected);
 *       - My Options: one REAL run (its "Refresh My Options values" step not skipped by the late-firing guard)
 *         created between 17:00 New York on every trading day and 05:00 UTC the next day.
 *       Windows that closed in the last LOOKBACK_CLOSED_H hours are judged; a window still open is "not yet" (⚠️).
 *   (b) every run of the last 24 h: failure / cancelled / timed_out -> ❌; longer than 2x the median of the same
 *       workflow's earlier successful runs (same trigger, runs over a minute) -> ⚠️;
 *   (c) each finished run's log: its log artifact (zip), else GitHub's own run log (zip; the step scripts in
 *       ##[group] blocks are skipped). Lines at WARNING / ERROR / CRITICAL, "degraded", "failed", "partial",
 *       "Unhandled", "TypeError", ::error:: and stack traces are grouped by message pattern (numbers, tickers and URLs
 *       blanked) and counted. The watchdog's (and ops-verify's) own runs are not scanned (their reports echo the patterns);
 *   (d) the GitHub minutes this month (reports/digest/actionsMinutes.ts, the nightly digest's line).
 * Output: the full report (✅/⚠️/❌ per job, the top 5 problems with counts and a run link, the minutes line) in the
 * run log and as rows appended to '🩺 Run Health' in the reports spreadsheet (created with its header when missing).
 * Telegram (clean policy, notify/policy.ts): NOTHING when every job is ✅; else ONE line (watchdogAlert). ❌ = failed or did not run; ⚠️ = slow, still running, not yet run, or ERROR-level log lines; warnings are
 * counted, not flagged (the Nightly logs routine warnings every night).
 *
 * Never fails loudly: any error of its own (GitHub unreadable, the Sheet refused) is the Telegram line, and the exit code is 0. Only a missing Telegram connection leaves the report in the run log alone.
 *
 * Imports: no profile-reading module at load (workflows/schedule.ts, sheets/*), so a run for another user without a
 * fetched profile still reaches Telegram; the Sheet modules are loaded only when the rows are written.
 */

import { pathToFileURL } from 'node:url';
import { unzip } from './net/unzip.ts';
import type { TelegramDeps } from './notify/telegram.ts';
import { notifyIfNeeded } from './notify/policy.ts';
import { isTradingDay } from './live/marketCalendar.ts';
import { actionsMinutesLine, wallMinutes } from './reports/digest/actionsMinutes.ts';
import { finish } from './core/finish.ts';
import { redactSecrets } from './ops/redact.ts';

export const RUN_HEALTH_TAB = '🩺 Run Health';
export const RUN_HEALTH_HEADER: readonly string[] = ['Date', 'Job', 'Expected', 'Ran', 'Result', 'Minutes', 'Warnings', 'Errors', 'Top problem', 'Run link'];

/** Runs of the last 24 h are checked; earlier ones (up to HISTORY_DAYS) only give the normal durations. */
export const RECENT_H = 24;
export const HISTORY_DAYS = 10;
/** An expected-run window that closed this long ago or less is judged (a late watchdog still sees yesterday's). */
export const LOOKBACK_CLOSED_H = 36;
export const NIGHTLY_FILE = 'nightly.yml';
export const MY_OPTIONS_FILE = 'my-options.yml';
export const WATCHDOG_FILE = 'watchdog.yml';
/** npm run ops-verify's workflow (src/verify.ts): its logs echo the problems too, so they are not scanned either. */
export const VERIFY_FILE = 'verify.yml';
const NOT_SCANNED: ReadonlySet<string> = new Set([WATCHDOG_FILE, VERIFY_FILE]);
/** The UTC hours of the Nightly window on the day after the trading day (schedule.ts NIGHTLY_BACKUP_SINCE_UTC / CUTOFF). */
export const NIGHTLY_FROM_UTC_H = 3;
export const NIGHTLY_TO_UTC_H = 13;
/** My Options: from 17:00 New York on the trading day until 05:00 UTC the next day. */
export const MY_OPTIONS_FROM_ET_H = 17;
export const MY_OPTIONS_TO_UTC_H = 5;
/** The step a real My Options run does not skip. */
export const MY_OPTIONS_REAL_STEP = 'Refresh My Options values';
export const SLOW_FACTOR = 2;
/** Runs this short are never "slow" and never set the normal duration (early-ended guards, quick checks). */
export const MIN_DURATION_MS = 60_000;
export const TOP_PROBLEMS = 5;
const MAX_LISTED = 300;
const PER_PAGE = 100;
const MAX_SCANNED = 40;
const MAX_ZIP_BYTES = 25 * 1024 * 1024;
const SCAN_CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 30_000;
export const TOTAL_TIMEOUT_MS = 4 * 60_000;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---- GitHub ------------------------------------------------------------------------------

export interface GhResponse { readonly ok: boolean; readonly status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }
/** The subset of fetch used (tests pass a fake GitHub). */
export type GhFetch = (url: string, init: { readonly headers: Readonly<Record<string, string>> }) => Promise<GhResponse>;

export interface GhRun {
  readonly id: number;
  readonly name?: string;
  readonly path?: string;
  readonly event?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly created_at?: string;
  readonly run_started_at?: string;
  readonly updated_at?: string;
  readonly html_url?: string;
}
interface GhArtifact { readonly name?: string; readonly expired?: boolean; readonly archive_download_url?: string; readonly size_in_bytes?: number }
interface GhJob { readonly steps?: ReadonlyArray<{ readonly name?: string; readonly conclusion?: string | null }> }

export class GitHub {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly f: GhFetch;
  readonly repo: string;
  constructor(token: string, repo: string, f?: GhFetch) {
    this.repo = repo;
    this.base = 'https://api.github.com/repos/' + repo + '/actions';
    this.headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    this.f = f ?? ((url, init) => globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }));
  }
  get fetchImpl(): GhFetch { return this.f; }
  private async res(url: string): Promise<GhResponse> {
    const r = await this.f(url, { headers: this.headers });
    if (!r.ok) throw new Error('GitHub API HTTP ' + r.status + ' for ' + url.replace(this.base, '').split('?')[0]);
    return r;
  }
  async json(path: string): Promise<unknown> { return (await this.res(this.base + path)).json(); }
  async bytes(urlOrPath: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.res(urlOrPath.startsWith('https://') ? urlOrPath : this.base + urlOrPath)).arrayBuffer());
  }
  /** Runs created since `sinceMs`, newest first, at most MAX_LISTED. */
  async runsSince(sinceMs: number): Promise<GhRun[]> {
    const out: GhRun[] = [];
    const since = new Date(sinceMs).toISOString().slice(0, 19) + 'Z';
    for (let page = 1; out.length < MAX_LISTED; page++) {
      const body = (await this.json('/runs?created=' + encodeURIComponent('>=' + since) + '&per_page=' + PER_PAGE + '&page=' + page)) as { total_count?: number; workflow_runs?: GhRun[] };
      const items = Array.isArray(body?.workflow_runs) ? body.workflow_runs.filter((r) => typeof r?.id === 'number') : [];
      out.push(...items.slice(0, MAX_LISTED - out.length));
      if (items.length < PER_PAGE || out.length >= (Number(body?.total_count) || 0)) break;
    }
    return out;
  }
  async jobs(runId: number): Promise<GhJob[]> {
    const body = (await this.json('/runs/' + runId + '/jobs?per_page=20')) as { jobs?: GhJob[] };
    return Array.isArray(body?.jobs) ? body.jobs : [];
  }
  async artifacts(runId: number): Promise<GhArtifact[]> {
    const body = (await this.json('/runs/' + runId + '/artifacts?per_page=20')) as { artifacts?: GhArtifact[] };
    return Array.isArray(body?.artifacts) ? body.artifacts : [];
  }
}

// ---- small helpers -------------------------------------------------------------------------

const ms = (s: string | undefined): number => { const t = Date.parse(s ?? ''); return Number.isFinite(t) ? t : NaN; };
export const fileOf = (r: GhRun): string => (r.path ?? '').split('/').pop()?.replace(/@.*$/, '') || String(r.name ?? 'unknown');
const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);
const addDays = (day: string, n: number): string => iso(Date.parse(day + 'T12:00:00Z') + n * DAY);
const hhmm = (t: number): string => new Date(t).toISOString().slice(11, 16);
const median = (xs: readonly number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};
const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required', 'stale']);
export const isFailed = (r: GhRun): boolean => r.status === 'completed' && FAILED.has(String(r.conclusion));
export const duration = (r: GhRun): number | null => {
  if (r.status !== 'completed') return null;
  const a = ms(r.run_started_at ?? r.created_at), b = ms(r.updated_at);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null;
};

/** The UTC instant of hh:00 New York time on `day` (EDT or EST, whichever New York is on). */
export function nyHourUtc(day: string, hour: number): number {
  for (const off of [4, 5]) {
    const t = Date.parse(day + 'T00:00:00Z') + (hour + off) * HOUR;
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date(t));
    if (Number(p) === hour) return t;
  }
  return Date.parse(day + 'T00:00:00Z') + (hour + 5) * HOUR;
}
const nyDay = (t: number): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));

// ---- (a) expected runs -----------------------------------------------------------------------

export type ExpectedJob = 'Nightly' | 'My Options';
export interface ExpectedCheck {
  readonly job: ExpectedJob;
  readonly file: string;
  /** The NYSE trading day the run belongs to. */
  readonly day: string;
  readonly from: number;
  readonly to: number;
  readonly state: 'ran' | 'missing' | 'pending';
  readonly run: GhRun | null;
}

/** How many trading days back the expected checks look (4 for the daily watchdog's 36 h). */
const daysBackFor = (lookbackClosedH: number): number => Math.max(4, Math.ceil(lookbackClosedH / 24) + 2);

export function nightlyWindow(day: string): { from: number; to: number } {
  const next = Date.parse(addDays(day, 1) + 'T00:00:00Z');
  return { from: next + NIGHTLY_FROM_UTC_H * HOUR, to: next + NIGHTLY_TO_UTC_H * HOUR };
}
export function myOptionsWindow(day: string): { from: number; to: number } {
  return { from: nyHourUtc(day, MY_OPTIONS_FROM_ET_H), to: Date.parse(addDays(day, 1) + 'T00:00:00Z') + MY_OPTIONS_TO_UTC_H * HOUR };
}

/**
 * The expected Nightly and My Options runs whose window has opened and closed less than LOOKBACK_CLOSED_H ago.
 * `realMyOptions`: ids of My Options runs that really refreshed (not ended early by the guard); a run with an
 * unknown answer (not in `checkedMyOptions`) counts as real.
 */
export function expectedChecks(now: number, runs: readonly GhRun[], realMyOptions: ReadonlySet<number>, checkedMyOptions: ReadonlySet<number> = realMyOptions, lookbackClosedH = LOOKBACK_CLOSED_H): ExpectedCheck[] {
  const out: ExpectedCheck[] = [];
  const today = nyDay(now);
  for (let k = daysBackFor(lookbackClosedH); k >= 0; k--) {
    const day = addDays(today, -k);
    if (!isTradingDay(day)) continue;
    for (const [job, file, w] of [['Nightly', NIGHTLY_FILE, nightlyWindow(day)], ['My Options', MY_OPTIONS_FILE, myOptionsWindow(day)]] as const) {
      if (w.from > now || w.to <= now - lookbackClosedH * HOUR) continue;
      const inWindow = runs.filter((r) => fileOf(r) === file && ms(r.created_at) >= w.from && ms(r.created_at) < w.to)
        .filter((r) => file !== MY_OPTIONS_FILE || realMyOptions.has(r.id) || !checkedMyOptions.has(r.id));
      // The best run of the window: a success, else the newest.
      const run = inWindow.find((r) => r.conclusion === 'success') ?? inWindow.sort((a, b) => ms(b.created_at) - ms(a.created_at))[0] ?? null;
      out.push({ job, file, day, from: w.from, to: w.to, state: run ? 'ran' : now < w.to ? 'pending' : 'missing', run });
    }
  }
  return out;
}

/** True when a My Options run did the refresh (its main step was not skipped by the late-firing guard). */
export function myOptionsWasReal(jobs: readonly GhJob[]): boolean {
  const steps = jobs.flatMap((j) => j.steps ?? []);
  const main = steps.find((s) => s.name === MY_OPTIONS_REAL_STEP);
  return main ? main.conclusion !== 'skipped' : steps.length === 0 ? true : false;
}

// ---- (c) log scanning ------------------------------------------------------------------------

export type Level = 'error' | 'warning';
export interface Finding { readonly key: string; readonly level: Level; readonly sample: string; count: number }

const TS = /^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z?\s+/;
const ERROR_RE = /\b(ERROR|CRITICAL|FATAL)\b|Unhandled|\b(TypeError|ReferenceError|RangeError|SyntaxError)\b|::error::|^##\[error\]/;
const WARNING_RE = /\bWARN(ING)?\b|degraded|\bfail(ed|ing|ure)?\b|\bpartial(ly)?\b|\bcould not\b|::warning::|^##\[warning\]/i;
const ZERO_RE = /\b0 (fail(ed|ures?)?|errors?|warnings?)\b|\b(fail(ed|ures?)?|errors?|warnings?)[:=]?\s+0\b/i;
/** JSON / key=value zero counts (`"warning":0`, `"failed":false`, `errors=0`): blanked before a line is judged. */
const ZERO_FIELD_RE = /(fail(ed|ures?)?|errors?|warnings?)"?\s*[:=]\s*(0|false)\b/gi;
const FRAME_RE = /^\s+at\s+\S.*(\(.*:\d+:\d+\)|:\d+:\d+|<anonymous>|native)\s*$/;
/** Capital words kept when the pattern blanks tickers. */
const KEEP = new Set(['ERROR', 'WARNING', 'WARN', 'INFO', 'DEBUG', 'CRITICAL', 'FATAL', 'HTTP', 'HTTPS', 'API', 'URL', 'JSON', 'PDF', 'CSV', 'SEC', 'FMP', 'AI', 'UTC', 'ET', 'NY', 'OK', 'ID', 'IV', 'RS', 'ETF', 'GET', 'POST', 'PUT', 'N/A', 'NO', 'TODO']);

/** A log line without its timestamps (GitHub's and the logger's). */
export function stripTimestamps(line: string): string {
  return line.replace(TS, '').replace(TS, '').trimEnd();
}

/** The grouping key of a line: numbers, tickers, URLs, quoted values and the JSON tail blanked. */
export function patternOf(line: string): string {
  return stripTimestamps(line)
    .replace(/\s\{".*\}\s*$/, '')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/"[^"]{0,80}"|'[^']{0,80}'/g, '"…"')
    .replace(/\b[A-Z][A-Z0-9]{0,4}(\.[A-Z])?\b/g, (t) => (KEEP.has(t) ? t : '*'))
    .replace(/\d+([.,:/-]\d+)*/g, '#')
    .replace(/\s+/g, ' ').trim().slice(0, 140);
}

/** Problem lines of one log, grouped by pattern. GitHub's ##[group] blocks (the step scripts and env) are skipped. */
export function scanLog(text: string, into: Map<string, Finding> = new Map()): Map<string, Finding> {
  let inGroup = false, prev = '', inTrace = false;
  const add = (level: Level, key: string, sample: string): void => {
    const k = level + '|' + key;
    const f = into.get(k);
    if (f) f.count++;
    else into.set(k, { key, level, sample: sample.slice(0, 160), count: 1 });
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = stripTimestamps(raw);
    if (line.startsWith('##[group]')) { inGroup = true; continue; }
    if (line.startsWith('##[endgroup]')) { inGroup = false; continue; }
    if (inGroup || !line.trim()) continue;
    if (FRAME_RE.test(line)) {
      if (!inTrace) add('error', 'stack trace after: ' + patternOf(prev), 'stack trace after: ' + prev.trim());
      inTrace = true;
      continue;
    }
    inTrace = false;
    prev = line;
    const probe = line.replace(ZERO_FIELD_RE, '');
    if (ZERO_RE.test(probe) && !/\b(ERROR|CRITICAL)\b/.test(probe)) continue;
    if (ERROR_RE.test(probe)) add('error', patternOf(line), line.trim());
    else if (WARNING_RE.test(probe)) add('warning', patternOf(line), line.trim());
  }
  return into;
}

/**
 * The text of a zip's log files (top-level entries only when the zip also holds per-step copies).
 * A job's artifact holds both out/<job>.log and out/<job>.console.log (the same lines twice): the console copy
 * is read only when its full log is missing, so each problem is counted once.
 */
export function zipText(bytes: Uint8Array): string {
  const entries = unzip(bytes).filter((e) => !e.name.endsWith('/'));
  const top = entries.filter((e) => !e.name.includes('/'));
  const picked = top.length ? top : entries;
  const names = new Set(picked.map((e) => e.name));
  const keep = picked.filter((e) => !(e.name.endsWith('.console.log') && names.has(e.name.slice(0, -'.console.log'.length) + '.log')));
  return keep.map((e) => e.text()).join('\n');
}

// ---- the report ----------------------------------------------------------------------------

export type Icon = '✅' | '⚠️' | '❌';
export interface Problem { readonly level: Level | 'failed' | 'missing'; readonly job: string; readonly text: string; readonly count: number; readonly link: string }
export interface JobRow {
  readonly job: string;
  readonly file: string;
  expected: string;
  ran: string;
  icon: Icon;
  result: string;
  minutes: number;
  warnings: number;
  errors: number;
  topProblem: string;
  link: string;
}
export interface Report {
  readonly at: number;
  /** The hours checked (RECENT_H for the daily watchdog; npm run ops-verify asks for more). */
  readonly recentH: number;
  /** The runs of those hours (the watchdog's own run excluded), newest first. */
  readonly recent: readonly GhRun[];
  readonly rows: JobRow[];
  readonly problems: Problem[];
  readonly minutesLine: string;
  readonly notes: string[];
}

export interface WatchdogDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: number;
  readonly fetchImpl?: GhFetch;
  /** Telegram's fetch (tests: a fake). */
  readonly telegramFetch?: typeof fetch;
  /** Writes the rows to the sheet; default: the reports spreadsheet. Returns the rows written. */
  readonly appendRows?: (rows: readonly (readonly (string | number)[])[]) => Promise<number>;
  readonly log?: (line: string) => void;
}

const problemRank = (p: Problem): number => ({ missing: 0, failed: 1, error: 2, warning: 3 })[p.level];
const ICON_RANK: Record<Icon, number> = { '❌': 2, '⚠️': 1, '✅': 0 };
const worse = (a: Icon, b: Icon): Icon => (ICON_RANK[b] > ICON_RANK[a] ? b : a);

/** One run's problem lines: its log artifacts (zip), else GitHub's own run log (zip). Rejects when unreadable. */
async function readRunLogs(gh: GitHub, runId: number): Promise<Map<string, Finding>> {
  const arts = (await gh.artifacts(runId)).filter((a) => !a.expired && a.archive_download_url && (a.size_in_bytes ?? 0) <= MAX_ZIP_BYTES && /log|analy|exit|migration/i.test(a.name ?? ''));
  const texts: string[] = [];
  for (const a of arts) texts.push(zipText(await gh.bytes(a.archive_download_url as string)));
  if (!texts.length) texts.push(zipText(await gh.bytes('/runs/' + runId + '/logs')));
  const m = new Map<string, Finding>();
  for (const t of texts) scanLog(t, m);
  return m;
}

/** buildReport's window: the daily watchdog uses the defaults (RECENT_H, LOOKBACK_CLOSED_H). */
export interface ReportWindow { readonly recentH?: number; readonly lookbackClosedH?: number }

/** Builds the report from GitHub. Throws only when the run list itself cannot be read. */
export async function buildReport(d: WatchdogDeps, gh: GitHub, w: ReportWindow = {}): Promise<Report> {
  const now = d.now, notes: string[] = [];
  const recentH = w.recentH ?? RECENT_H, lookbackClosedH = w.lookbackClosedH ?? LOOKBACK_CLOSED_H;
  const all = await gh.runsSince(now - Math.max(HISTORY_DAYS, Math.ceil(recentH / 24) + 7) * DAY);
  const selfId = Number(d.env.GITHUB_RUN_ID) || -1;
  const recent = all.filter((r) => r.id !== selfId && ms(r.created_at) >= now - recentH * HOUR);

  // (a) My Options runs inside a window: did the refresh really run (one jobs call each)?
  const real = new Set<number>(), checked = new Set<number>();
  const firstWindow = myOptionsWindow(addDays(nyDay(now), -daysBackFor(lookbackClosedH))).from;
  for (const r of all.filter((x) => fileOf(x) === MY_OPTIONS_FILE && ms(x.created_at) >= firstWindow && x.status === 'completed')) {
    await gh.jobs(r.id).then((jobs) => { checked.add(r.id); if (myOptionsWasReal(jobs)) real.add(r.id); }, () => {});
  }
  const expected = expectedChecks(now, all, real, checked, lookbackClosedH);

  // (b) + (c) per run.
  const byFile = new Map<string, GhRun[]>();
  for (const r of recent) byFile.set(fileOf(r), [...(byFile.get(fileOf(r)) ?? []), r]);
  const findingsOf = new Map<number, Map<string, Finding>>();
  const toScan = recent.filter((r) => r.status === 'completed' && r.conclusion !== 'skipped' && !NOT_SCANNED.has(fileOf(r))).slice(0, MAX_SCANNED);
  if (recent.filter((r) => r.status === 'completed' && !NOT_SCANNED.has(fileOf(r))).length > toScan.length) notes.push('only the newest ' + MAX_SCANNED + ' run logs were read');
  let unreadLogs = 0, next = 0;
  const worker = async (): Promise<void> => {
    while (next < toScan.length) {
      const r = toScan[next++] as GhRun;
      await readRunLogs(gh, r.id).then((m) => { findingsOf.set(r.id, m); }, () => { unreadLogs++; });
    }
  };
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
  if (unreadLogs) notes.push(unreadLogs + ' run log(s) could not be read');

  const problems: Problem[] = [];
  const rows: JobRow[] = [];
  for (const [file, runs] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const name = String(runs[0]?.name ?? file);
    const row: JobRow = { job: name, file, expected: '', ran: String(runs.length), icon: '✅', result: '', minutes: 0, warnings: 0, errors: 0, topProblem: '', link: String(runs[0]?.html_url ?? '') };
    const bits: string[] = [];
    const failed = runs.filter(isFailed), running = runs.filter((r) => r.status !== 'completed');
    for (const r of failed) {
      row.icon = '❌';
      problems.push({ level: 'failed', job: name, text: name + ' run ' + String(r.conclusion), count: 1, link: String(r.html_url ?? '') });
    }
    if (failed.length) { bits.push(failed.length + ' ' + [...new Set(failed.map((r) => String(r.conclusion)))].join('/')); row.link = String(failed[0]?.html_url ?? row.link); }
    if (running.length) { row.icon = worse(row.icon, '⚠️'); bits.push(running.length + ' still running'); }
    // Slow: against the earlier successful runs of the same workflow and trigger.
    for (const r of runs) {
      const dur = duration(r);
      if (dur == null || dur < MIN_DURATION_MS) continue;
      const base = median(all.filter((x) => x.id !== r.id && fileOf(x) === file && x.event === r.event && x.conclusion === 'success' && ms(x.created_at) < ms(r.created_at))
        .map(duration).filter((x): x is number => x != null && x >= MIN_DURATION_MS));
      if (base != null && dur > SLOW_FACTOR * base) {
        row.icon = worse(row.icon, '⚠️');
        bits.push('slow ' + Math.round(dur / 60_000) + ' min vs ' + Math.round(base / 60_000) + ' normal');
        problems.push({ level: 'warning', job: name, text: name + ' took ' + Math.round(dur / 60_000) + ' min (normal ' + Math.round(base / 60_000) + ')', count: 1, link: String(r.html_url ?? '') });
      }
    }
    row.minutes = runs.reduce((s, r) => s + wallMinutes(r as Parameters<typeof wallMinutes>[0]), 0);
    // Log findings, summed over the job's runs.
    const merged = new Map<string, Finding & { link: string }>();
    for (const r of runs) {
      for (const [k, f] of findingsOf.get(r.id) ?? []) {
        const m = merged.get(k);
        if (m) m.count += f.count;
        else merged.set(k, { ...f, link: String(r.html_url ?? '') });
      }
    }
    for (const f of merged.values()) {
      if (f.level === 'error') row.errors += f.count; else row.warnings += f.count;
      problems.push({ level: f.level, job: name, text: f.sample, count: f.count, link: f.link });
    }
    if (row.errors) row.icon = worse(row.icon, '⚠️');
    const top = [...merged.values()].sort((a, b) => (a.level === b.level ? b.count - a.count : a.level === 'error' ? -1 : 1))[0];
    if (top) { row.topProblem = top.count + '× ' + top.sample; if (top.link) row.link = top.link; }
    if (!bits.length) bits.push(running.length === runs.length ? 'running' : 'ok');
    row.result = bits.join('; ');
    rows.push(row);
  }

  // Fold the expected checks in: a run in the last 24 h marks its job row, the rest get their own row.
  for (const c of expected) {
    const label = c.job + ' for ' + c.day;
    const jr = c.run ? rows.find((r) => r.file === c.file && (byFile.get(c.file) ?? []).some((x) => x.id === c.run?.id)) : undefined;
    if (c.state === 'ran' && jr) { jr.expected = jr.expected ? jr.expected + ', ' + c.day : 'yes (' + c.day + ')'; continue; }
    if (c.state === 'ran') continue; // ran before the checked hours: already reported then
    const pending = c.state === 'pending';
    const text = pending
      ? c.job + ' not run yet for ' + c.day + ' (window open until ' + hhmm(c.to) + ' UTC)'
      : c.job + ' did not run for ' + c.day + ' (nothing ' + (c.file === MY_OPTIONS_FILE ? 'real ' : '') + 'created ' + new Date(c.from).toISOString().slice(5, 16).replace('T', ' ') + '–' + new Date(c.to).toISOString().slice(5, 16).replace('T', ' ') + ' UTC)';
    rows.unshift({ job: c.job, file: c.file, expected: 'yes (' + c.day + ')', ran: pending ? 'not yet' : 'no', icon: pending ? '⚠️' : '❌', result: pending ? 'not yet' : 'did not run', minutes: 0, warnings: 0, errors: 0, topProblem: text, link: '' });
    problems.push({ level: pending ? 'warning' : 'missing', job: c.job, text, count: 1, link: 'https://github.com/' + gh.repo + '/actions/workflows/' + c.file });
  }
  problems.sort((a, b) => problemRank(a) - problemRank(b) || b.count - a.count);

  const minutesLine = await actionsMinutesLine({ env: d.env, now, fetchImpl: gh.fetchImpl, log: d.log });
  return { at: now, recentH, recent, rows, problems, minutesLine, notes };
}

/** The Telegram text: one line per job, the top problems, the minutes line. Plain text (links stay clickable). */
export function reportText(r: Report): string {
  const head = '🩺 Run Health — ' + new Date(r.at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC (last ' + r.recentH + ' h)';
  const worst = r.rows.reduce<Icon>((w, x) => worse(w, x.icon), '✅');
  const lines = [head, worst === '✅' ? 'Everything ran and finished cleanly.' : worst === '❌' ? 'Something failed or did not run.' : 'All ran; some things to look at.', ''];
  if (!r.rows.length) lines.push('No runs in the last ' + r.recentH + ' h and none expected.');
  for (const x of r.rows) {
    const runs = /^\d+$/.test(x.ran) ? x.ran + (x.ran === '1' ? ' run' : ' runs') : x.ran === 'no' ? 'did not run' : x.ran;
    const parts = [runs];
    if (x.result && x.result !== 'ok' && x.result !== 'did not run' && x.result !== x.ran) parts.push(x.result);
    if (/^\d+$/.test(x.ran)) parts.push(x.minutes + ' min', x.warnings + ' W / ' + x.errors + ' E');
    if (x.expected && /^\d+$/.test(x.ran)) parts.push('expected ✓');
    lines.push(x.icon + ' ' + x.job + ' — ' + parts.join(', '));
  }
  const top = r.problems.slice(0, TOP_PROBLEMS);
  if (top.length) {
    lines.push('', 'Top problems:');
    top.forEach((p, i) => {
      const icon = p.level === 'warning' ? '⚠️' : '❌';
      lines.push((i + 1) + '. ' + icon + ' ' + p.count + '× ' + p.job + ': ' + p.text.slice(0, 140) + (p.link ? '\n   ' + p.link : ''));
    });
  }
  lines.push('', r.minutesLine);
  for (const n of r.notes) lines.push('ℹ️ ' + n);
  return lines.join('\n');
}

/** The sheet rows (RUN_HEALTH_HEADER order). */
export function reportRows(r: Report): (string | number)[][] {
  const date = iso(r.at);
  return r.rows.map((x) => [date, x.job, x.expected || '—', x.ran, x.icon + ' ' + (x.result || 'ok'), x.minutes, x.warnings, x.errors, x.topProblem.slice(0, 300), x.link]);
}

/** The default sheet writer: '🩺 Run Health' in the reports spreadsheet (My Portfolio before the split), created when missing. */
export async function appendToReportsSheet(env: Readonly<Record<string, string | undefined>>, rows: readonly (readonly (string | number)[])[]): Promise<number> {
  const json = (env.GOOGLE_SERVICE_ACCOUNT_JSON ?? '').trim();
  const id = (env.REPORTS_SPREADSHEET_ID ?? '').trim() || (env.SPREADSHEET_ID ?? '').trim();
  if (!json || !id) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON / REPORTS_SPREADSHEET_ID not set');
  const { SheetsClient, createSheetsApi, parseServiceAccount } = await import('./sheets/client.ts');
  const { a1 } = await import('./sheets/tabs.ts');
  const { createContext } = await import('./core/context.ts');
  const ctx = createContext({ mode: 'lock' });
  const c = new SheetsClient({ spreadsheetId: id, api: createSheetsApi(parseServiceAccount(json)) });
  const ids = await c.tabIds(ctx);
  if (!ids.ok) throw new Error('the reports sheet tab list could not be read');
  let out = rows;
  if (!Object.hasOwn(ids.value, RUN_HEALTH_TAB)) {
    const added = await c.addTabs(ctx, [RUN_HEALTH_TAB]);
    if (!added.ok) throw new Error('the ' + RUN_HEALTH_TAB + ' tab could not be created');
    out = [RUN_HEALTH_HEADER, ...rows];
  }
  const res = await c.append(ctx, a1(RUN_HEALTH_TAB, 'A1'), out.map((r) => [...r]));
  if (!res.ok) throw new Error('the rows could not be appended');
  return out.length;
}

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Quiet unless needed (notify/policy.ts): null when every job is ✅ and nothing went wrong on the way (all quiet,
 * nothing is sent); else ONE line: the worst icon, the top problem and how many more, and where to look.
 */
export function watchdogAlert(r: Report): string | null {
  const worst = r.rows.reduce<Icon>((w, x) => worse(w, x.icon), '✅');
  if (worst === '✅' && !r.notes.length) return null;
  const top = r.problems[0];
  const more = Math.max(0, r.problems.length - 1);
  const what = top ? top.job + ': ' + top.text.slice(0, 140) : worst === '✅' ? r.notes.join('; ') : (r.rows.find((x) => x.icon === worst)?.job ?? '') + ' ' + (r.rows.find((x) => x.icon === worst)?.result ?? '');
  return '🩺 ' + (worst === '✅' ? 'ℹ️' : worst) + ' ' + what.trim() + (more ? ' (+' + more + ' more)' : '') + ' — /verify for details' + (top?.link ? ' ' + top.link : '');
}

/** The report text and its alert line; the sheet rows are appended on the way. Rejects only when GitHub cannot be read at all. */
async function checkAndRecord(d: WatchdogDeps, log: (line: string) => void): Promise<{ text: string; alert: string | null }> {
  const token = (d.env.GITHUB_TOKEN ?? '').trim(), repo = (d.env.GITHUB_REPOSITORY ?? '').trim();
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GITHUB_TOKEN / GITHUB_REPOSITORY not set');
  const gh = new GitHub(token, repo, d.fetchImpl);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out after ' + TOTAL_TIMEOUT_MS / 60_000 + ' min')), TOTAL_TIMEOUT_MS); });
  const report = await Promise.race([buildReport(d, gh), limit]).finally(() => clearTimeout(timer));
  const append = d.appendRows ?? ((rows) => appendToReportsSheet(d.env, rows));
  await Promise.resolve().then(() => append(reportRows(report))).then(
    (n) => log('watchdog: ' + n + ' row(s) appended to ' + RUN_HEALTH_TAB),
    (e: unknown) => { report.notes.push('Sheet not updated: ' + msgOf(e)); },
  );
  return { text: reportText(report), alert: watchdogAlert(report) };
}

/**
 * The whole check. Never throws; returns the full report text (the run log has it). Telegram gets ONE line only when
 * something needs the owner (watchdogAlert); an all-✅ day sends nothing.
 */
export async function runWatchdog(d: WatchdogDeps): Promise<string> {
  const log = d.log ?? (() => {});
  const { text, alert } = await Promise.resolve().then(() => checkAndRecord(d, log)).then(
    (r) => r,
    (e: unknown) => ({ text: '🩺 Run Health — ❌ the watchdog itself failed: ' + msgOf(e) + '\nThe runs were NOT checked today. Open Actions → Watchdog for the log.', alert: '🩺 ❌ the watchdog itself failed: ' + msgOf(e) + ' — the runs were NOT checked today (Actions → Watchdog).' } as { text: string; alert: string | null }),
  );
  log(text);
  if (!alert) { log('watchdog: all ✅, nothing sent to Telegram.'); return text; }
  const tg = (d.env.TELEGRAM_BOT_TOKEN ?? '').trim(), chat = (d.env.TELEGRAM_CHAT_ID ?? '').trim();
  if (!tg || !chat) { log('watchdog: Telegram secrets missing; the report is in this log only.'); return text; }
  const deps: TelegramDeps = { token: tg, ...(d.telegramFetch ? { fetchImpl: d.telegramFetch } : {}) };
  const sent = await notifyIfNeeded({ deps, chatId: chat }, redactSecrets(alert, d.env), (m) => log('watchdog: the Telegram line could not be sent: ' + m));
  if (sent) log('watchdog: Telegram alert line sent.');
  return text;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runWatchdog({ env: process.env, now: Date.now(), log: (l) => process.stdout.write(l + '\n') }).then(() => finish(0), () => finish(0));
}
