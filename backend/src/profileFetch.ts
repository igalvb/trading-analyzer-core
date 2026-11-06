/**
 * GENERIC_PLAN P5: `npm run profile-fetch -- --out <file>`. Reads the `⚙️ Profile` tab of the run user's My Portfolio
 * sheet, checks it (profile/schema.ts) and writes it as JSON to <file>; the workflow then sets PROFILE_FILE to it, so
 * every later step of the run uses that user's profile (profile/active.ts).
 *
 * The per-user workflows run this step for every user except the default user of a copy with a built-in profile
 * (workflows/schedule.ts PROFILE_STEP_IF, src/overlay.ts): that one keeps the built-in profile and makes no extra sheet
 * request (recordings and goldens unchanged).
 *
 * A missing or bad tab refuses the run with one plain line (stdout, and Telegram when the bot secrets are given).
 * The service-account value and the sheet ID are never printed.
 * Exit: 0 written, 1 the tab is missing / not valid / names another user, 2 configuration missing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { finish } from './core/finish.ts';
import { createSheetsApi, parseServiceAccount } from './sheets/serviceAccount.ts';
import { PROFILE_TAB, loadProfile, profileInputFromRows } from './profile/load.ts';
import { OWNER_USER, runUserOf, runUserProblem } from './profile/runUser.ts';
import { sendMessage } from './notify/telegram.ts';
import { processLine } from './core/logFile.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type Rows = ReadonlyArray<ReadonlyArray<unknown>>;

export interface ProfileFetchDeps {
  readonly env: Env;
  readonly argv: readonly string[];
  readonly out: (line: string) => void;
  /** Technical log lines (default stderr); the CRITICAL refusal line goes here and to the run log file. */
  readonly err?: (text: string) => void;
  /** The tab's rows (null = no such tab). Default: Google Sheets with GOOGLE_SERVICE_ACCOUNT_JSON / SPREADSHEET_ID. */
  readonly readRows?: (env: Env) => Promise<Rows | null>;
  readonly writeFile?: (file: string, text: string) => void;
  /** Telegram (tests inject a fake). */
  readonly fetchImpl?: typeof fetch;
}

/** The range read: two columns, Key | Value. */
export const PROFILE_RANGE = "'" + PROFILE_TAB + "'!A1:B300";

/** Sheet cells arrive as shown (FORMATTED_VALUE): TRUE / FALSE become booleans, "25%" becomes 0.25. */
export function normalizeCell(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
  const pct = /^(-?\d+(?:\.\d+)?)\s*%$/.exec(s);
  if (pct) return Number(pct[1]) / 100;
  return v;
}

async function googleRows(env: Env): Promise<Rows | null> {
  const api = createSheetsApi(parseServiceAccount(String(env.GOOGLE_SERVICE_ACCOUNT_JSON)));
  try {
    const res = await api.spreadsheets.values.get({ spreadsheetId: String(env.SPREADSHEET_ID).trim(), range: PROFILE_RANGE, valueRenderOption: 'FORMATTED_VALUE' });
    return (res.data.values ?? []) as Rows;
  } catch (e) {
    // A missing tab is "Unable to parse range"; anything else (no access, quota) is a real failure.
    if (/unable to parse range/i.test(String((e as Error)?.message ?? ''))) return null;
    throw new Error('the sheet could not be read (' + String((e as { code?: unknown })?.code ?? 'no code') + ')');
  }
}

export async function profileFetch(deps: ProfileFetchDeps): Promise<number> {
  const user = runUserOf(deps.env);
  const outIdx = deps.argv.indexOf('--out');
  const file = outIdx >= 0 ? (deps.argv[outIdx + 1] ?? '') : '';
  if (!file) { deps.out('Profile: give the file to write, --out <file>.'); return 2; }
  const badUser = runUserProblem(user);
  if (badUser) { deps.out('Profile: ' + badUser + '.'); return 2; }
  const missing = ['GOOGLE_SERVICE_ACCOUNT_JSON', 'SPREADSHEET_ID'].filter((n) => !(deps.env[n] ?? '').trim());
  if (missing.length) { deps.out('Profile: missing for user ' + user + ': ' + missing.join(', ') + ' (the secrets named ' + user.toUpperCase() + '_<NAME>).'); return 2; }

  const refuse = async (why: string): Promise<number> => {
    const line = '⚠️ Run refused for user ' + user + ': ' + why;
    deps.out(line);
    processLine('CRITICAL', 'profile', 'run refused: the profile of user ' + user + ' cannot be used', { why }, deps.env, deps.err ?? ((t) => { process.stderr.write(t); }));
    const token = (deps.env.TELEGRAM_BOT_TOKEN ?? '').trim(), chat = (deps.env.TELEGRAM_CHAT_ID ?? '').trim();
    if (token && chat) {
      await sendMessage({ token, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }, chat, line).catch((e: unknown) => {
        deps.out('Profile: the Telegram line could not be sent.');
        processLine('WARNING', 'profile', 'Telegram: the refusal line could not be sent', { detail: String(e) }, deps.env, deps.err ?? ((t) => { process.stderr.write(t); }));
      });
    }
    return 1;
  };

  let rows: Rows | null;
  try { rows = await (deps.readRows ?? googleRows)(deps.env); } catch (e) { return refuse(String((e as Error).message ?? e)); }
  if (!rows || rows.filter((r) => String(r[0] ?? '').trim()).length === 0) return refuse('the ' + PROFILE_TAB + ' tab is missing or empty in your My Portfolio sheet.');
  const sheetRows = rows.map((x) => [x[0], normalizeCell(x[1])]);
  const input = profileInputFromRows(sheetRows);
  // Only the tab counts here: PROFILE_JSON / PROFILE_FILE of the step's own environment are ignored.
  const r = loadProfile({}, { sheetRows });
  if (!r.ok) return refuse('the ' + PROFILE_TAB + ' tab is not valid: ' + r.errors.join('; ') + '.');
  // The default user's tab may carry any valid id (a single-user copy); another user's tab must name that user.
  if (user !== OWNER_USER && r.profile.user.id !== user) return refuse('the ' + PROFILE_TAB + ' tab is for user ' + r.profile.user.id + ', not ' + user + ' (user.id).');
  const write = deps.writeFile ?? ((f: string, t: string) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); });
  write(file, JSON.stringify(input, null, 2) + '\n');
  deps.out('Profile: user ' + user + ', ' + r.profile.lists.core.length + ' ticker(s) on the list, read from the ' + PROFILE_TAB + ' tab.');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  profileFetch({ env: process.env, argv: process.argv.slice(2), out: (l) => process.stdout.write(l + '\n') }).then((c) => finish(c), (e: unknown) => {
    processLine('CRITICAL', 'profile', 'profile-fetch stopped on an unexpected error (exit 1)', { detail: String(e) });
    finish(1);
  });
}
