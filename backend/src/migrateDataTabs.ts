/**
 * `npm run migrate-data-tabs -- <step> [--yes] [--accept-references]` (docs/SHEETS_CLEANUP_PLAN.md (e)).
 * Run by .github/workflows/migrate-data-tabs.yml in its own concurrency group `sheet-migration`.
 *
 *   check             opens all three spreadsheets, checks edit access, different IDs, empty new sheets (read-only
 *                     apart from a no-op title write that proves edit access)
 *   plan              the tabs to copy, delete and keep, and the reference check (read-only)
 *   rehearse          the full copy path and the copy-back replace path in the two new sheets, then empties them
 *   rehearse-cleanup  `rehearse --cleanup` alone (idempotent)
 *   migrate           reference check -> copy -> verify -> flag -> marker, in one job
 *   delete            the post-switch check, then removes the moved tabs from My Portfolio (dry run unless --yes)
 *   copy-back         the rollback: every moved tab back into My Portfolio, verified; then the flag is cleared
 *   abort             clears the pause; with no marker, also clears the flag
 *   unpause           clears the pause only (the workflow's always() step)
 *
 * Every WRITING step (rehearse, rehearse-cleanup, migrate, delete, copy-back):
 *   1. refuses inside the My Options and Nightly windows (workflows/schedule.ts MIGRATION_BLOCKED_WINDOWS_UTC);
 *   2. sets the `sheetsPaused` flag on My Portfolio, expiring 2 hours ahead (a crashed migration never pauses longer);
 *   3. waits up to 30 minutes for running writer workflow runs (GitHub API, `actions: read`); still running -> clears
 *      the pause and stops, nothing done;
 *   4. does the work; 5. clears the pause (also in a `finally`, and again by the workflow's always() step).
 * Every Sheets call of the three spreadsheets goes through ONE shared limiter.
 *
 * Exit: 0 passed, 1 a check or a step failed, 2 refused (configuration, time window, state).
 */

import { processLine } from './core/logFile.ts';
import { pathToFileURL } from 'node:url';
import type { RunContext } from './core/context.ts';
import { createContext } from './core/context.ts';
import { SheetsClient, createSheetsApi, createSheetsLimiter, parseServiceAccount } from './sheets/client.ts';
import { sheetIdsFromEnv, PAUSED_FLAG } from './sheets/threeSheets.ts';
import {
  MigrationError, clearPause, idProblem, setPause, stepAbort, stepCheck, stepCopyBack, stepDelete, stepMigrate, stepPlan, stepRehearse,
  stepRehearseCleanup, type MigrationClient, type MigrationSheets, type StepDeps, type StepOutput,
} from './sheets/migration.ts';
import { MIGRATION_STEPS, SHEET_WRITER_WORKFLOWS, migrationBlockedWindow } from './workflows/schedule.ts';

export const PAUSE_MS = 2 * 60 * 60_000;
export const WRITER_WAIT_MS = 30 * 60_000;
export const WRITER_POLL_MS = 30_000;
const WRITING_STEPS = new Set(['rehearse', 'rehearse-cleanup', 'migrate', 'delete', 'copy-back']);

export interface MigrateCliDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly argv: readonly string[];
  readonly out: (line: string) => void;
  readonly errOut: (line: string) => void;
  /** Tests: the three clients. Default: real clients sharing one Google client and ONE limiter. */
  readonly makeSheets?: (spreadsheetId: string) => MigrationClient;
  /** Names of the writer workflow runs in progress (default: the GitHub API with GITHUB_TOKEN / GITHUB_REPOSITORY). */
  readonly listRunningWriters?: () => Promise<string[]>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly ctx?: RunContext;
}

/** In-progress runs of the six writer workflows, from the GitHub API. */
export async function githubRunningWriters(env: Readonly<Record<string, string | undefined>>, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const token = (env.GITHUB_TOKEN ?? '').trim(), repo = (env.GITHUB_REPOSITORY ?? '').trim();
  if (!token || !repo) throw new MigrationError('GITHUB_TOKEN and GITHUB_REPOSITORY are needed to see running workflow runs.');
  const files = new Set(SHEET_WRITER_WORKFLOWS.map((w) => w.file));
  const res = await fetchImpl('https://api.github.com/repos/' + repo + '/actions/runs?status=in_progress&per_page=100', {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!res.ok) throw new MigrationError('GitHub refused the list of running workflow runs (HTTP ' + res.status + ').');
  const body = (await res.json()) as { workflow_runs?: Array<{ path?: string; name?: string; id?: number }> };
  return (body.workflow_runs ?? []).filter((r) => files.has(String(r.path ?? '').split('/').pop() ?? '')).map((r) => String(r.name ?? r.path) + ' #' + String(r.id ?? ''));
}

export async function runMigrateDataTabs(deps: MigrateCliDeps): Promise<number> {
  const step = deps.argv.find((a) => !a.startsWith('--')) ?? '';
  const yes = deps.argv.includes('--yes');
  const acceptReferences = deps.argv.includes('--accept-references');
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (![...MIGRATION_STEPS, 'unpause'].includes(step)) { deps.errOut('Migration: unknown step "' + step + '". Steps: ' + [...MIGRATION_STEPS, 'unpause'].join(', ') + '.'); return 2; }
  const ids = sheetIdsFromEnv(deps.env);
  if (!ids.portfolio || (!deps.makeSheets && !(deps.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? '').trim())) { deps.errOut('Migration: GOOGLE_SERVICE_ACCOUNT_JSON and SPREADSHEET_ID are needed.'); return 2; }
  const needsAll = step !== 'unpause' && step !== 'abort';
  const problem = idProblem(ids);
  if (needsAll && problem) { deps.errOut('Migration: ' + problem); return 2; }
  const blocked = migrationBlockedWindow(new Date(now()));
  if (WRITING_STEPS.has(step) && blocked) { deps.errOut('Migration: refused between ' + blocked.from + ' and ' + blocked.to + ' UTC (' + blocked.why + '). Nothing was done.'); return 2; }

  let make = deps.makeSheets;
  try {
    if (!make) {
      const api = createSheetsApi(parseServiceAccount(deps.env.GOOGLE_SERVICE_ACCOUNT_JSON as string));
      const limiter = createSheetsLimiter();
      const clients = new Map<string, SheetsClient>();
      make = (id) => { let c = clients.get(id); if (!c) { c = new SheetsClient({ spreadsheetId: id, api, limiter }); clients.set(id, c); } return c; };
    }
  } catch (e) {
    deps.errOut('Migration: ' + (e instanceof Error ? e.message : 'the Google credentials are unusable'));
    return 2;
  }
  const ctx = deps.ctx ?? createContext({ mode: 'migrate' });
  const portfolio = make(ids.portfolio);
  const sheets: MigrationSheets = {
    portfolio,
    reports: ids.reports ? make(ids.reports) : portfolio,
    data: ids.data ? make(ids.data) : portfolio,
  };
  const d: StepDeps = { ctx, sheets, ids, now, out: deps.out };

  try {
    if (step === 'unpause') {
      const st = await portfolio.spreadsheetState(ctx);
      if (st.ok && st.value.metadata[PAUSED_FLAG] === undefined) { deps.out('unpause: no pause was set.'); return 0; }
      await clearPause(ctx, portfolio);
      deps.out('unpause: the maintenance pause is cleared.');
      return 0;
    }
    if (step === 'abort') {
      const reachable = !ids.data || (await sheets.data.spreadsheetState(ctx)).ok;
      return (await stepAbort(d, reachable)).ok ? 0 : 1;
    }
    if (step === 'check') return (await stepCheck(d)).ok ? 0 : 1;
    if (step === 'plan') return (await stepPlan(d)).ok ? 0 : 1;

    // A writing step: pause, wait for running writers, work, unpause.
    const until = new Date(now() + PAUSE_MS);
    await setPause(ctx, portfolio, until);
    deps.out('Maintenance pause set until ' + until.toISOString().slice(11, 16) + ' UTC.');
    try {
      const list = deps.listRunningWriters ?? (() => githubRunningWriters(deps.env));
      const start = now();
      for (;;) {
        const running = await list();
        if (!running.length) break;
        if (now() - start >= WRITER_WAIT_MS) {
          deps.out('Still running after 30 minutes: ' + running.join(', ') + '. Nothing was done.');
          return 1;
        }
        deps.out('Waiting for: ' + running.join(', '));
        await sleep(WRITER_POLL_MS);
      }
      let r: StepOutput;
      if (step === 'rehearse') r = await stepRehearse(d);
      else if (step === 'rehearse-cleanup') r = await stepRehearseCleanup(d);
      else if (step === 'migrate') r = await stepMigrate(d, { acceptReferences });
      else if (step === 'delete') r = await stepDelete(d, yes);
      else r = await stepCopyBack(d);
      return r.ok ? 0 : 1;
    } finally {
      await clearPause(ctx, portfolio).then(
        () => deps.out('Maintenance pause cleared.'),
        () => deps.out('The maintenance pause could not be cleared; it ends by itself at ' + until.toISOString().slice(11, 16) + ' UTC.'),
      );
    }
  } catch (e) {
    if (e instanceof MigrationError) { deps.out(e.message); return e.message.startsWith('Refused') ? 2 : 1; }
    ctx.log.error('Migration: unexpected failure', { detail: e instanceof Error ? e.message : String(e) });
    deps.errOut('Migration: unexpected failure. Details are in the run log.');
    return 1;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  runMigrateDataTabs({ env: process.env, argv: process.argv.slice(2), out: (l) => console.log(l), errOut: (l) => console.error(l) }).then(
    (code) => { process.exitCode = code; },
    (e: unknown) => { console.error('Migration: unexpected failure.'); processLine('CRITICAL', 'migrate', 'stopped on an unexpected error (exit 1)', { detail: String(e) }); process.exitCode = 1; },
  );
}
