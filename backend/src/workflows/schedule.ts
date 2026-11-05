/**
 * FL-8w: the GitHub Actions schedules, timeouts, secrets and inputs as DATA, plus the
 * pure helpers the workflow files are checked against (test/fl8w.workflows.test.ts).
 * Nothing here touches GitHub or the network.
 *
 * Files live at the REPOSITORY ROOT: .github/workflows/*.yml (GitHub reads only that
 * folder). The backend is the subfolder `backend/`, so every run step uses
 * `working-directory: backend`.
 *
 * Nightly order (user decision F-76), run by `npm run nightly` after the US close:
 *   dark pool -> Evaluative Index -> RS ranking -> macro refresh -> analysis -> summary -> Buy report -> Exit report.
 * The three dark-pool keys are checked against DARK_POOL_DAILY_JOBS in the test.
 */

import { wallClockInTz } from '../core/dates.ts';
import { ALL_NIGHTLY_STEPS } from '../jobs/nightly/steps.ts';
import { activeProfile } from '../profile/active.ts';

export const ET_ZONE = 'America/New_York';
/** The user's own zone, profile `user.timeZone` (GENERIC_PLAN P2; display only, the engine runs on ET_ZONE). */
export const USER_ZONE: string = activeProfile().user.timeZone;
/** The owner's name for USER_ZONE (Asia/Jerusalem for the owner), kept for the owner's workflow tests. */
export const ISRAEL_ZONE: string = USER_ZONE;

/** Only these action versions may appear in any workflow. */
export const ALLOWED_ACTIONS: readonly string[] = [
  'actions/checkout@v4',
  'actions/setup-node@v4',
  'actions/upload-artifact@v4',
];

/** Relative to backend/. The first folder that holds nightly.yml is used. */
export const WORKFLOW_DIR_CANDIDATES: readonly string[] = ['../.github/workflows', '.github/workflows'];

export interface WorkflowSpec {
  readonly file: string;
  /** UTC cron lines, in file order. Empty = no schedule. */
  readonly crons: readonly string[];
  /** UTC timer lines kept by the Cloudflare relay instead of GitHub (relay/telegram-relay.worker.mjs timedJob). */
  readonly relayCrons?: readonly string[];
  readonly dispatch: boolean;
  /** The job-level timeout-minutes. */
  readonly timeoutMinutes: number;
  readonly concurrencyGroup: string;
  /** Exactly the secrets the file may reference (least privilege). */
  readonly secrets: readonly string[];
  /** npm commands the file must call. */
  readonly commands: readonly string[];
  /** GENERIC_PLAN P5: the file takes the `user` input and reads that user's secrets (PER_USER_* below). */
  readonly perUser?: boolean;
  /** GENERIC_PLAN P5: a per-user sheet writer that reads a non-owner user's `⚙️ Profile` tab first (profile-fetch). */
  readonly readsProfile?: boolean;
  /** `permissions: actions: read` and GITHUB_TOKEN / GITHUB_REPOSITORY on the run step (reads this repo's workflow runs). */
  readonly actionsRead?: boolean;
  /** `permissions: actions: write` (may start other workflows) and GH_TOKEN on the run step. Only nightly-backup.yml. */
  readonly actionsWrite?: boolean;
  /** `permissions: actions: read` and GH_TOKEN (the gh CLI) on a guard step, instead of GITHUB_TOKEN for the program. */
  readonly ghActionsRead?: boolean;
}

// ---- GENERIC_PLAN P5: one workflow, many users ----------------------------------------
//
// The owner is user `owner` (the default). An empty or `owner` user runs EXACTLY as before: the same concurrency
// group, the repo secrets under their plain names, the built-in profile (no extra sheet request). Another user `u2`
// reads the secrets named `U2_<NAME>` (repo secrets with a prefix: works on every GitHub plan; GitHub Environments
// are not used, they could not be verified on this private Free repo), its own concurrency group, and its own
// `⚙️ Profile` tab (npm run profile-fetch, before the main step). A missing `U2_` secret is EMPTY, never the
// owner's: the run fails loudly instead of touching the owner's sheets.

/** The user id the owner runs as (profile `user.id` of the built-in owner profile). */
export const OWNER_USER = 'owner';
/** The workflow_dispatch input every per-user file carries (its last input). */
export const USER_INPUT = { name: 'user', type: 'string', default: OWNER_USER } as const;
/** GitHub expression: true when the run is for someone other than the owner (empty / missing / `owner` = owner). */
const NOT_OWNER = "(inputs.user || '" + OWNER_USER + "') != '" + OWNER_USER + "'";
/** Workflow-level env lines of a per-user file, exactly as they must appear (name, value). */
export const PER_USER_ENV: ReadonlyArray<readonly [string, string]> = [
  ['RUN_USER', "${{ inputs.user || '" + OWNER_USER + "' }}"],
  ['SECRET_PREFIX', '${{ ' + NOT_OWNER + " && format('{0}_', inputs.user) || '' }}"],
  ['PROFILE_SOURCE', 'sheet'], // core: every user, the default one too, reads its Profile tab (no built-in profile)
];
/** The concurrency group of a per-user file: the owner keeps `base` byte for byte; user u2 gets `base-u2`. */
export function perUserGroup(base: string): string {
  return "${{ (inputs.user || '" + OWNER_USER + "') == '" + OWNER_USER + "' && '" + base + "' || format('" + base + "-{0}', inputs.user) }}";
}
/** How a per-user file passes one secret (SECRET_PREFIX is '' for the owner, so the owner reads `NAME` as before). */
export function perUserSecretLine(name: string): string {
  return name + ": ${{ secrets[format('{0}" + name + "', env.SECRET_PREFIX)] }}";
}
/** JS mirror of the YAML user test (GitHub's `||` treats '' and null as missing; its `==` ignores case). */
function isOwnerInput(user: string | null | undefined): boolean {
  return (user || OWNER_USER).toLowerCase() === OWNER_USER;
}
/** The secret a run for `user` reads (JS mirror of the YAML; GitHub secret names ignore case): owner / empty -> NAME, u2 -> U2_NAME. */
export function secretNameFor(user: string | null | undefined, name: string): string {
  return isOwnerInput(user) ? name : String(user).toUpperCase() + '_' + name;
}
/** The concurrency group a run for `user` gets (JS mirror of perUserGroup). */
export function groupFor(user: string | null | undefined, base: string): string {
  return isOwnerInput(user) ? base : base + '-' + String(user);
}

/** 03:23 UTC every day = 23:23 EDT / 22:23 EST the evening before. Started by the Cloudflare relay's timer, not by GitHub (docs/RELAY_SCHEDULES_PLAN.md). */
export const NIGHTLY_CRON = '23 3 * * *';
/** 17:05 New York in summer (EDT = UTC-4) and in winter (EST = UTC-5). */
export const MY_OPTIONS_CRON_EDT = '5 21 * * *';
export const MY_OPTIONS_CRON_EST = '5 22 * * *';
export const MY_OPTIONS_ET_HOUR = 17;
/**
 * Owner 2026-11-04: GitHub's schedules fire 3-7 hours late (My Options 21:05/22:05 UTC seen at 00:30-03:26 UTC),
 * so the Nightly gets a GitHub backup timer (the Cloudflare relay timer never started a run 30 Oct-4 Nov):
 * 03:23 and 05:23 UTC, each one a ~10-20 s check without checkout or npm.
 */
export const NIGHTLY_BACKUP_CRONS: readonly string[] = [NIGHTLY_CRON, '23 5 * * *'];
/** A Nightly run created since this UTC time today counts as "already ran tonight" (any status). */
export const NIGHTLY_BACKUP_SINCE_UTC = '03:00';
/** From this UTC hour on (US market hours) the backup does not start the Nightly; it only tells the owner. */
export const NIGHTLY_BACKUP_CUTOFF_UTC_HOUR = 13;

/**
 * FL-9m (F1): derived from the step table in jobs/nightly/steps.ts (the single source of truth), never typed twice.
 * Every step the nightly knows (the workflow is the same for every user; the profile's features drop steps at run time).
 */
export const NIGHTLY_STEP_ORDER: readonly string[] = ALL_NIGHTLY_STEPS.map((s) => s.id);

export const NIGHTLY: WorkflowSpec = {
  file: 'nightly.yml', crons: [], relayCrons: [NIGHTLY_CRON], dispatch: true, timeoutMinutes: 120, concurrencyGroup: perUserGroup('sheet-report-writers'), perUser: true, readsProfile: true,
  // Row 38: actions: read for the digest's "GitHub minutes this month" line (reports/digest/actionsMinutes.ts).
  actionsRead: true,
  secrets: ['GOOGLE_SERVICE_ACCOUNT_JSON', 'SPREADSHEET_ID', 'REPORTS_SPREADSHEET_ID', 'DATA_SPREADSHEET_ID', 'FMP_API_KEY', 'ALPHAVANTAGE_KEY', 'FINNHUB_KEY', 'SEC_CONTACT_EMAIL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
  commands: ['npm run nightly', 'npm run lock-sheets'],
};
export const MY_OPTIONS: WorkflowSpec = {
  file: 'my-options.yml', crons: [MY_OPTIONS_CRON_EDT, MY_OPTIONS_CRON_EST], dispatch: true, timeoutMinutes: 15, concurrencyGroup: perUserGroup('my-options'), perUser: true, readsProfile: true,
  // Owner 2026-11-04: the guard asks GitHub whether My Options already succeeded since 17:00 New York (late firings).
  ghActionsRead: true,
  // F-B10-1: compose.ts requires SEC_CONTACT_EMAIL for every run (SEC user agent), so my-options needs it too.
  secrets: ['GOOGLE_SERVICE_ACCOUNT_JSON', 'SPREADSHEET_ID', 'REPORTS_SPREADSHEET_ID', 'DATA_SPREADSHEET_ID', 'SEC_CONTACT_EMAIL'],
  commands: ['npm run my-options', 'npm run lock-sheets'],
};
export const AI_DISPATCH: WorkflowSpec = {
  file: 'ai-dispatch.yml', crons: [], dispatch: true, timeoutMinutes: 30, concurrencyGroup: perUserGroup('sheet-report-writers'), perUser: true, readsProfile: true,
  // F-W12: the AI run re-analyses every ticker, so it also needs the data keys and the SEC contact (same four as the nightly).
  // Plan #47 (owner 2026-11-04): the Exit Opus box also writes one portfolio-wide Opus view, sent to Telegram too.
  secrets: ['GOOGLE_SERVICE_ACCOUNT_JSON', 'SPREADSHEET_ID', 'REPORTS_SPREADSHEET_ID', 'DATA_SPREADSHEET_ID', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'FMP_API_KEY', 'ALPHAVANTAGE_KEY', 'FINNHUB_KEY', 'SEC_CONTACT_EMAIL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
  commands: ['npm run ai', 'npm run lock-sheets'],
};
export const CI: WorkflowSpec = {
  file: 'ci.yml', crons: [], dispatch: true, timeoutMinutes: 25, concurrencyGroup: 'ci-${{ github.ref }}',
  secrets: [], commands: ['npm run typecheck', 'npm test'],
};
/** Backlog recordings R-A1 / R-N1 / R-AI1 (src/record.ts): manual, memory mode only, so no Sheet secrets; Gemini for `ai`. */
export const RECORD: WorkflowSpec = {
  file: 'record.yml', crons: [], dispatch: true, timeoutMinutes: 60, concurrencyGroup: 'record',
  secrets: ['FMP_API_KEY', 'ALPHAVANTAGE_KEY', 'FINNHUB_KEY', 'SEC_CONTACT_EMAIL', 'GEMINI_API_KEY'],
  commands: ['npm run record'],
};
/** Telegram delivery check (src/telegramCheck.ts): manual, Telegram secrets only. */
export const TELEGRAM_CHECK: WorkflowSpec = {
  file: 'telegram-check.yml', crons: [], dispatch: true, timeoutMinutes: 5, concurrencyGroup: perUserGroup('telegram'), perUser: true,
  secrets: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
  commands: ['npm run telegram-check'],
};
/**
 * Analyze one ticker from the phone (src/analyzeReport.ts): Sheet, PDF, Telegram. Queues behind the nightly.
 * Owner 2026-11-01: plus a Claude Opus second opinion (ANTHROPIC_API_KEY; input `opus`, default true, ANALYZE_INPUTS).
 */
export const ANALYZE: WorkflowSpec = {
  file: 'analyze.yml', crons: [], dispatch: true, timeoutMinutes: 30, concurrencyGroup: perUserGroup('sheet-report-writers'), perUser: true, readsProfile: true,
  secrets: ['GOOGLE_SERVICE_ACCOUNT_JSON', 'SPREADSHEET_ID', 'REPORTS_SPREADSHEET_ID', 'DATA_SPREADSHEET_ID', 'FMP_API_KEY', 'ALPHAVANTAGE_KEY', 'FINNHUB_KEY', 'SEC_CONTACT_EMAIL', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
  commands: ['npm run analyze-report', 'npm run lock-sheets'],
};
/** The Exit step alone from the phone (src/exitReportPdf.ts): Sheet, PDF, Telegram. Queues behind the nightly. */
export const EXIT_REPORT: WorkflowSpec = {
  file: 'exit-report.yml', crons: [], dispatch: true, timeoutMinutes: 30, concurrencyGroup: perUserGroup('sheet-report-writers'), perUser: true, readsProfile: true,
  secrets: ['GOOGLE_SERVICE_ACCOUNT_JSON', 'SPREADSHEET_ID', 'REPORTS_SPREADSHEET_ID', 'DATA_SPREADSHEET_ID', 'FMP_API_KEY', 'ALPHAVANTAGE_KEY', 'FINNHUB_KEY', 'SEC_CONTACT_EMAIL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
  commands: ['npm run exit-report-pdf', 'npm run lock-sheets'],
};
/** Telegram /exit (src/sendExit.ts): the saved Exit Report as a PDF; the Exit AI (Gemini) first when its section is empty. */
export const SEND_EXIT: WorkflowSpec = {
  file: 'send-exit.yml', crons: [], dispatch: true, timeoutMinutes: 20, concurrencyGroup: perUserGroup('sheet-report-writers'), perUser: true, readsProfile: true,
  secrets: ['GOOGLE_SERVICE_ACCOUNT_JSON', 'SPREADSHEET_ID', 'REPORTS_SPREADSHEET_ID', 'DATA_SPREADSHEET_ID', 'FMP_API_KEY', 'ALPHAVANTAGE_KEY', 'FINNHUB_KEY', 'SEC_CONTACT_EMAIL', 'GEMINI_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
  commands: ['npm run send-exit', 'npm run ai', 'npm run lock-sheets'],
};
/** One-time: connect the bot to the Cloudflare relay and set its menu (src/telegramSetup.ts). */
export const TELEGRAM_SETUP: WorkflowSpec = {
  file: 'telegram-setup.yml', crons: [], dispatch: true, timeoutMinutes: 5, concurrencyGroup: perUserGroup('telegram'), perUser: true,
  secrets: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'],
  commands: ['npm run telegram-setup'],
};
/** Owner files from Google Drive (e.g. the books for new models) onto the `files` branch. No secrets; no npm. */
export const FETCH_FILES: WorkflowSpec = {
  file: 'fetch-files.yml', crons: [], dispatch: true, timeoutMinutes: 30, concurrencyGroup: 'fetch-files',
  secrets: [], commands: [],
};
/**
 * The data move to three spreadsheets (src/migrateDataTabs.ts, docs/SHEETS_CLEANUP_PLAN.md (e)). Manual only. Its OWN
 * concurrency group: GitHub keeps only the newest pending run per group, so inside `sheet-report-writers` a second
 * Telegram /analyze would silently cancel the first one waiting behind it. Instead the tool sets a maintenance pause
 * that the writers respect (they exit cleanly), and waits for running writer runs (`actions: read`).
 */
export const MIGRATE_DATA_TABS: WorkflowSpec = {
  file: 'migrate-data-tabs.yml', crons: [], dispatch: true, timeoutMinutes: 120, concurrencyGroup: 'sheet-migration', actionsRead: true,
  secrets: ['GOOGLE_SERVICE_ACCOUNT_JSON', 'SPREADSHEET_ID', 'REPORTS_SPREADSHEET_ID', 'DATA_SPREADSHEET_ID'],
  commands: ['npm run migrate-data-tabs', 'npm run lock-sheets'],
};
/**
 * docs/LONG_HISTORY_PLAN.md: the long price history (2007 to today) as CSV files on the separate `prices` branch
 * (src/longHistory.ts). Manual only (no schedule, no push trigger); no secrets (Yahoo needs none); writes only that branch.
 */
export const LONG_HISTORY: WorkflowSpec = {
  file: 'long-history.yml', crons: [], dispatch: true, timeoutMinutes: 30, concurrencyGroup: 'long-history',
  secrets: [], commands: ['npm run long-history'],
};
/** The GitHub backup timer for the Nightly (owner 2026-11-04; see NIGHTLY_BACKUP_CRONS). Telegram only; no npm. */
export const NIGHTLY_BACKUP: WorkflowSpec = {
  file: 'nightly-backup.yml', crons: NIGHTLY_BACKUP_CRONS, dispatch: true, timeoutMinutes: 5, concurrencyGroup: 'nightly-backup', actionsWrite: true,
  secrets: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
  commands: ['gh workflow run nightly.yml --ref main -f run_checks=false'],
};
/**
 * The daily run watchdog (owner 2026-11-04; src/watchdog.ts): every run of the last 24 h, the expected Nightly / My
 * Options runs, the run logs, the GitHub minutes -> Telegram and the '🩺 Run Health' tab. GitHub's own timer (fires
 * late; fine). `npm ci --omit=dev`, about 30-45 s (one billed minute) a day. Its own concurrency group: never queues
 * behind the sheet writers.
 */
export const WATCHDOG_CRON = '7 6 * * *';
export const WATCHDOG: WorkflowSpec = {
  file: 'watchdog.yml', crons: [WATCHDOG_CRON], dispatch: true, timeoutMinutes: 6, concurrencyGroup: perUserGroup('watchdog'), perUser: true,
  actionsRead: true,
  secrets: ['GOOGLE_SERVICE_ACCOUNT_JSON', 'SPREADSHEET_ID', 'REPORTS_SPREADSHEET_ID', 'DATA_SPREADSHEET_ID', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
  commands: ['npm ci --omit=dev', 'npm run watchdog'],
};
/**
 * Layer 2 of the run monitoring (owner 2026-11-04; src/verify.ts): started by hand (Telegram /verify or /check, or the
 * Actions page). The watchdog's facts for the last `days` days (default 3) plus the '🩺 Run Health' rows -> ONE Claude
 * Opus diagnosis -> Telegram. Read-only (one Verify row in Run Health). No schedule. Its own concurrency group.
 */
export const VERIFY: WorkflowSpec = {
  file: 'verify.yml', crons: [], dispatch: true, timeoutMinutes: 10, concurrencyGroup: perUserGroup('verify'), perUser: true,
  actionsRead: true,
  secrets: ['GOOGLE_SERVICE_ACCOUNT_JSON', 'SPREADSHEET_ID', 'REPORTS_SPREADSHEET_ID', 'DATA_SPREADSHEET_ID', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'ANTHROPIC_API_KEY'],
  commands: ['npm ci --omit=dev', 'npm run ops-verify'],
};
export const WORKFLOWS: readonly WorkflowSpec[] = [NIGHTLY, NIGHTLY_BACKUP, MY_OPTIONS, AI_DISPATCH, CI, RECORD, TELEGRAM_CHECK, ANALYZE, EXIT_REPORT, SEND_EXIT, TELEGRAM_SETUP, FETCH_FILES, MIGRATE_DATA_TABS, LONG_HISTORY, WATCHDOG, VERIFY];

/** The six workflows that write the spreadsheets: the migration waits for their running runs, and they respect its pause. */
export const SHEET_WRITER_WORKFLOWS: readonly WorkflowSpec[] = [NIGHTLY, ANALYZE, EXIT_REPORT, SEND_EXIT, AI_DISPATCH, MY_OPTIONS];

/** The migrate workflow's `step` input (plan (e) "Sub-steps"; rehearse-cleanup = `rehearse --cleanup`). The always() step runs `unpause`. */
export const MIGRATION_STEPS: readonly string[] = ['check', 'plan', 'rehearse', 'rehearse-cleanup', 'migrate', 'delete', 'copy-back', 'abort'];

/**
 * UTC windows in which a writing migration step refuses to start: My Options (21:05 / 22:05 UTC) and the Nightly
 * (03:23 UTC, up to its 120-minute timeout). Half-open [from, to), "HH:MM".
 */
export const MIGRATION_BLOCKED_WINDOWS_UTC: ReadonlyArray<{ readonly from: string; readonly to: string; readonly why: string }> = [
  { from: '20:30', to: '23:00', why: 'My Options runs at 21:05 or 22:05 UTC' },
  { from: '03:00', to: '05:30', why: 'the Nightly runs from 03:23 UTC for up to 2 hours' },
];

/** The blocked window `now` falls in, or null. */
export function migrationBlockedWindow(now: Date): { readonly from: string; readonly to: string; readonly why: string } | null {
  const m = now.getUTCHours() * 60 + now.getUTCMinutes();
  const mins = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  return MIGRATION_BLOCKED_WINDOWS_UTC.find((w) => m >= mins(w.from) && m < mins(w.to)) ?? null;
}

/** The seven dispatch inputs of ai-dispatch.yml (sub-plan 6 section 3.1). */
export const AI_INPUTS: ReadonlyArray<{ readonly name: string; readonly type: 'boolean' | 'choice'; readonly default: string }> = [
  { name: 'buy', type: 'boolean', default: 'false' },
  { name: 'buy_gemini', type: 'boolean', default: 'true' },
  { name: 'buy_opus', type: 'boolean', default: 'false' },
  { name: 'exit', type: 'boolean', default: 'false' },
  { name: 'exit_gemini', type: 'boolean', default: 'true' },
  { name: 'exit_opus', type: 'boolean', default: 'false' },
  { name: 'effort', type: 'choice', default: 'medium' },
];
export const AI_EFFORT_OPTIONS: readonly string[] = ['low', 'medium', 'high'];

/**
 * analyze.yml's dispatch inputs before `user` (owner 2026-11-01: `opus`, default true). The Telegram relay sends
 * {ticker, ai, update_sheet} only, so `opus` takes its default.
 */
export const ANALYZE_INPUTS: ReadonlyArray<{ readonly name: string; readonly type: 'boolean' | 'string'; readonly default: string }> = [
  { name: 'ticker', type: 'string', default: '' },
  { name: 'ai', type: 'boolean', default: 'true' },
  { name: 'update_sheet', type: 'boolean', default: 'true' },
  { name: 'opus', type: 'boolean', default: 'true' },
];

// ---- cron + time-zone helpers -------------------------------------------------------

export interface CronTime { readonly minute: number; readonly hour: number; readonly dow: string }

/** Parses the only shape used here: "M H * * D" (D = * or a day number/range). */
export function parseCron(cron: string): CronTime {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6](?:-[0-6])?)$/.exec(cron.trim());
  if (!m) throw new Error('unsupported cron line: ' + cron);
  const minute = Number(m[1]);
  const hour = Number(m[2]);
  if (minute > 59 || hour > 23) throw new Error('cron out of range: ' + cron);
  return { minute, hour, dow: m[3] as string };
}

/** The instant (UTC) a cron line fires on the given UTC calendar day, "YYYY-MM-DD". */
export function cronInstant(isoDay: string, cron: string): Date {
  const { minute, hour } = parseCron(cron);
  return new Date(isoDay + 'T' + String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0') + ':00Z');
}

export interface LocalClock { readonly date: string; readonly hour: number; readonly minute: number; readonly hhmm: string }

export function localClock(instant: Date, timeZone: string): LocalClock {
  const w = wallClockInTz(instant.getTime(), timeZone);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return { date: w.year + '-' + p2(w.month) + '-' + p2(w.day), hour: w.hour, minute: w.minute, hhmm: p2(w.hour) + ':' + p2(w.minute) };
}

export function etHourOf(now: Date): number {
  return wallClockInTz(now.getTime(), ET_ZONE).hour;
}

/**
 * The ON-TIME arm of the double cron: true when the New York hour of `now` equals the wanted hour. Because the two
 * cron lines are one hour apart, exactly one of them lands in that hour on any day of the year when GitHub fires on
 * time. The real guard in my-options.yml is myOptionsScheduledShouldRun (late firings, owner 2026-11-04).
 */
export function shouldRunNow(etHour: number, now: Date): boolean {
  return etHourOf(now) === etHour;
}

/** Which of the my-options cron lines would pass the guard if they fire on that UTC day. */
export function cronsThatPassGuard(isoDay: string): string[] {
  return MY_OPTIONS.crons.filter((c) => shouldRunNow(MY_OPTIONS_ET_HOUR, cronInstant(isoDay, c)));
}

/**
 * JS mirror of my-options.yml's guard for a SCHEDULED run (owner 2026-11-04): go when the New York hour is the wanted
 * hour or later (same New York day, until midnight) and no successful My Options run was created since that hour
 * today. `alreadyRan` null = GitHub could not be asked: run anyway (a second refresh is harmless, a missed one is not).
 */
export function myOptionsScheduledShouldRun(now: Date, alreadyRan: boolean | null): boolean {
  return etHourOf(now) >= MY_OPTIONS_ET_HOUR && alreadyRan !== true;
}

/** JS mirror of nightly-backup.yml: what one check does. */
export type NightlyBackupAction = 'already-ran' | 'too-late' | 'start';
export function nightlyBackupAction(now: Date, nightlyCreatedSinceWindow: boolean): NightlyBackupAction {
  if (nightlyCreatedSinceWindow) return 'already-ran';
  return now.getUTCHours() >= NIGHTLY_BACKUP_CUTOFF_UTC_HOUR ? 'too-late' : 'start';
}

/** The "schedule:" block exactly as it must appear in a workflow file. */
export function renderScheduleBlock(crons: readonly string[]): string {
  return '  schedule:\n' + crons.map((c) => "    - cron: '" + c + "'").join('\n');
}

// ---- validators ----------------------------------------------------------------------

/**
 * A deliberately tiny YAML "shape" check (no dependency). It catches the mistakes that
 * break these files in practice: tabs, odd indentation, unbalanced ${{ }}, a line that is
 * neither "key: value" nor a list item, an unquoted value containing ": ", and a missing
 * top-level key. Block scalars (run: |) are skipped by indentation. It is NOT a full
 * YAML parser; GitHub itself is the final judge.
 */
export function yamlSubsetProblems(text: string): string[] {
  const problems: string[] = [];
  let blockIndent = -1;
  text.split('\n').forEach((raw, i) => {
    const n = i + 1;
    if (raw.includes('\t')) problems.push('line ' + n + ': tab character');
    if (raw.trim() === '') return;
    const indent = raw.length - raw.trimStart().length;
    if (blockIndent >= 0) {
      if (indent > blockIndent) return;
      blockIndent = -1;
    }
    const t = raw.trim();
    if (t.startsWith('#')) return;
    if (indent % 2 !== 0) problems.push('line ' + n + ': odd indentation');
    const opens = (t.match(/\$\{\{/g) ?? []).length;
    const closes = (t.match(/\}\}/g) ?? []).length;
    if (opens !== closes) problems.push('line ' + n + ': unbalanced ${{ }}');
    const isItem = t.startsWith('- ');
    const body = isItem ? t.slice(2).trim() : t;
    const kv = /^("[^"]*"|'[^']*'|[A-Za-z0-9_./-]+):(?:\s+(.*))?$/.exec(body);
    if (!kv) {
      if (!isItem) problems.push('line ' + n + ': not "key: value" or a list item: ' + t);
    } else {
      const value = (kv[2] ?? '').trim();
      if (/^[|>][-+]?$/.test(value)) {
        blockIndent = indent;
      } else if (value !== '' && !/^["'[{|>]/.test(value)) {
        if (/^[*&!%@`]/.test(value)) problems.push('line ' + n + ': value starts with a YAML indicator character');
        if (/: /.test(value) && !value.startsWith('${{')) problems.push('line ' + n + ': unquoted value contains ": "');
      }
    }
  });
  for (const key of ['name', 'on', 'permissions', 'jobs']) {
    if (!new RegExp('^' + key + ':', 'm').test(text)) problems.push('missing top-level key: ' + key);
  }
  return problems;
}

export const SECRET_PATTERNS: ReadonlyArray<{ readonly name: string; readonly re: RegExp }> = [
  { name: 'apikey= query string', re: /apikey=/i },
  { name: 'Google API key prefix', re: /AIza/ },
  { name: 'sk- style key', re: /(^|[^A-Za-z0-9])sk-/ },
  { name: 'long hex string', re: /\b[0-9a-f]{32,}\b/i },
  { name: 'private key block', re: /BEGIN (?:RSA |EC )?PRIVATE KEY/ },
  { name: 'private_key JSON field', re: /"private_key"/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'shell tracing', re: /\bset -[a-z]*x/ },
  { name: 'environment dump', re: /\bprintenv\b|^\s*(?:run:\s*)?env\s*$/m },
  { name: 'secret echoed', re: /echo[^\n]*\$\{\{\s*secrets\./ },
];

/** Names of the secret-like patterns found in `text` (empty = clean). */
export function findSecretLikeText(text: string): string[] {
  return SECRET_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
}
