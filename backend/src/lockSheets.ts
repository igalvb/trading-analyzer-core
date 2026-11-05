/**
 * npm run lock-sheets: puts the Master Lock back on every tab. Used as the last step of every workflow under
 * `if: always()`, so a crashed or killed run still leaves the sheet locked. `--unlock` (npm run unlock-sheets) is
 * the manual deep-clean; `--clear-all` with it clears non-red tab colours too.
 *
 * Output is counts and variable NAMES only. The service-account value is never printed.
 * Exit code: 0 done, 1 the lock/unlock of My Portfolio failed, 2 configuration missing or unusable.
 *
 * Three spreadsheets (docs/SHEETS_CLEANUP_PLAN.md (d)): this step NEVER refuses for a migration state. It is the
 * backstop after a crash, so it runs no startup guard and writes no data: it locks My Portfolio, then each new
 * spreadsheet whose ID is set (REPORTS_SPREADSHEET_ID, DATA_SPREADSHEET_ID; '' = unset) and reachable. A new
 * spreadsheet that cannot be reached or locked only gives a warning line; the exit code is My Portfolio's.
 */

import { processLine } from './core/logFile.ts';
import { pathToFileURL } from 'node:url';
import { createContext } from './core/context.ts';
import type { RunContext } from './core/context.ts';
import { SheetsClient, createSheetsApi, createSheetsLimiter, parseServiceAccount } from './sheets/client.ts';
import { lockAllTabs, unlockAllTabs } from './sheets/masterLock.ts';
import type { MasterLockSheets } from './sheets/masterLock.ts';

export interface LockCliDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly argv: readonly string[];
  readonly out: (line: string) => void;
  readonly errOut: (line: string) => void;
  /** Tests inject a fake. Default: the real Sheets client from the environment. */
  readonly makeSheets?: (env: Readonly<Record<string, string | undefined>>) => MasterLockSheets;
  /** Tests: the client of one of the two new spreadsheets. Default: a real client sharing My Portfolio's limiter. */
  readonly makeSheetsFor?: (env: Readonly<Record<string, string | undefined>>, spreadsheetId: string) => MasterLockSheets;
  readonly ctx?: RunContext;
}

const REQUIRED = ['GOOGLE_SERVICE_ACCOUNT_JSON', 'SPREADSHEET_ID'] as const;

/** One Google client and ONE limiter for all three spreadsheets (the quota is per user and project). */
function realFactory(env: Readonly<Record<string, string | undefined>>): (spreadsheetId: string) => MasterLockSheets {
  const api = createSheetsApi(parseServiceAccount(env['GOOGLE_SERVICE_ACCOUNT_JSON'] as string));
  const limiter = createSheetsLimiter();
  return (spreadsheetId) => new SheetsClient({ spreadsheetId, api, limiter });
}

const NEW_SHEETS = [['REPORTS_SPREADSHEET_ID', 'reports spreadsheet'], ['DATA_SPREADSHEET_ID', 'data spreadsheet']] as const;

export async function runLockSheets(deps: LockCliDeps): Promise<number> {
  const missing = REQUIRED.filter((n) => !(deps.env[n] ?? '').trim());
  if (missing.length > 0) {
    deps.errOut('Master Lock: missing environment variable(s): ' + missing.join(', '));
    return 2;
  }
  let sheets: MasterLockSheets;
  let factory: ((id: string) => MasterLockSheets) | null = null;
  try {
    if (deps.makeSheets) sheets = deps.makeSheets(deps.env);
    else { factory = realFactory(deps.env); sheets = factory(deps.env['SPREADSHEET_ID'] as string); }
  } catch (e) {
    // parseServiceAccount messages never echo the value.
    deps.errOut('Master Lock: ' + (e instanceof Error ? e.message : 'the Google credentials are unusable'));
    return 2;
  }
  const ctx = deps.ctx ?? createContext({ mode: 'lock' });
  const unlock = deps.argv.includes('--unlock');
  const keepAccentsOnUnlock = !deps.argv.includes('--clear-all');
  try {
    let code: number;
    if (unlock) {
      const r = await unlockAllTabs(ctx, sheets, { keepAccentsOnUnlock });
      if (!r.ok) { deps.errOut('Master Lock: the tabs could not be unlocked. Details are in the run log.'); code = 1; }
      else { deps.out(`Master Lock: ${r.value.changed} of ${r.value.total} tab(s) unlocked, ${r.value.keptAccents} accent colour(s) kept.`); code = 0; }
    } else {
      const r = await lockAllTabs(ctx, sheets);
      if (!r.ok) { deps.errOut('Master Lock: the tabs could not be locked. Details are in the run log.'); code = 1; }
      else { deps.out(`Master Lock: ${r.value.changed} of ${r.value.total} tab(s) locked (the rest were already locked).`); code = 0; }
    }
    // The two new spreadsheets: best effort, never a refusal and never a failing exit code.
    for (const [name, label] of NEW_SHEETS) {
      const id = (deps.env[name] ?? '').trim();
      if (!id || id === (deps.env['SPREADSHEET_ID'] ?? '').trim()) continue;
      try {
        const other = deps.makeSheetsFor ? deps.makeSheetsFor(deps.env, id) : (factory ?? realFactory(deps.env))(id);
        const r = unlock ? await unlockAllTabs(ctx, other, { keepAccentsOnUnlock }) : await lockAllTabs(ctx, other);
        if (r.ok) deps.out(`Master Lock (${label}): ${r.value.changed} of ${r.value.total} tab(s) ${unlock ? 'unlocked' : 'locked'}.`);
        else deps.out(`Master Lock warning: the ${label} could not be ${unlock ? 'unlocked' : 'locked'} (not reachable?). Details are in the run log.`);
      } catch (e) {
        ctx.log.warning('Master Lock: ' + label + ' skipped', { detail: e instanceof Error ? e.message : String(e) });
        deps.out(`Master Lock warning: the ${label} was skipped. Details are in the run log.`);
      }
    }
    return code;
  } catch (e) {
    ctx.log.error('Master Lock CLI: unexpected failure', { detail: e instanceof Error ? e.message : String(e) });
    deps.errOut('Master Lock: unexpected failure. Details are in the run log.');
    return 1;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  runLockSheets({ env: process.env, argv: process.argv.slice(2), out: (l) => console.log(l), errOut: (l) => console.error(l) }).then(
    (code) => { process.exitCode = code; },
    (e: unknown) => { console.error('Master Lock: unexpected failure.'); processLine('CRITICAL', 'lock', 'stopped on an unexpected error (exit 1)', { detail: String(e) }); process.exitCode = 1; },
  );
}
