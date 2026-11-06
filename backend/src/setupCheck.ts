/**
 * GENERIC_PLAN P7: npm run setup-check. One table: each key or setting -> ✅ / ❌ / ➖ (not needed) + a plain fix.
 * One cheap request per key. Prints NAMES only, never a value (a key, a token, a sheet id or a chat id).
 * Exit: 0 every needed item ✅, 1 something needed is ❌.
 *
 * Optional items (AI keys when features.ai is off, the Anthropic key) show ➖ when absent.
 * "Choose your stocks" rows: the 🎯 Watchlist tab has tickers, the Profile `lists.core` has 3+, and (paper test on)
 * `paper.fixedUniverse` is not empty. Counts only, never the tickers.
 */

import { processLine } from './core/logFile.ts';
import { finish } from './core/finish.ts';
import { activeProfile, activeProfileSource } from './profile/active.ts';

export type Mark = '✅' | '❌' | '➖';
export interface CheckRow { readonly item: string; readonly mark: Mark; readonly note: string }

export interface SetupCheckDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl: typeof fetch;
  /** Reads a spreadsheet's title with the robot key; throws on no access. */
  readonly sheetTitle: (credentialsJson: string, spreadsheetId: string) => Promise<string>;
  /** features.ai of the run's profile (AI keys are optional when off). */
  readonly aiOn: boolean;
  /**
   * Counts the tickers in the 🎯 Watchlist tab (column A under the header, distinct) with the robot key; null when
   * the tab is not there yet; throws on no access. Only the count leaves it.
   */
  readonly watchlistCount: (credentialsJson: string, spreadsheetId: string) => Promise<number | null>;
  /** The run's profile (with the sizes of its stock lists, never the tickers), or the one-line reason it is not valid. */
  readonly profile?: {
    readonly ok: true; readonly paperOn: boolean; readonly paperStart: string | null; readonly source: string;
    /** How many tickers in `lists.core` and `paper.fixedUniverse`. */
    readonly coreCount: number; readonly fixedUniverseCount: number;
  } | { readonly ok: false; readonly error: string };
  readonly out: (line: string) => void;
}

const TIMEOUT_MS = 15_000;
/** The 'your list' paper accounts need at least this many tickers in `lists.core` to mean anything. */
export const MIN_CORE_TICKERS = 3;
/** Same name as sheets/tabs.ts Tabs.WATCHLIST (not imported: that module reads the profile when loaded). */
export const WATCHLIST_TAB = '🎯 Watchlist';
const CHOOSE = ' (SETUP_GUIDE "Choose your stocks").';

/** Distinct tickers in column A under the header row (same rule as sheets/readers/watchlist.ts parseWatchlistRows). */
export function countWatchlistRows(rows: ReadonlyArray<ReadonlyArray<unknown>>): number {
  const seen = new Set<string>();
  for (let r = 1; r < rows.length; r++) { const t = String(rows[r]?.[0] ?? '').trim().toUpperCase(); if (t) seen.add(t); }
  return seen.size;
}

async function getJson(f: typeof fetch, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await f(url, { headers, signal: ctl.signal });
    let body: unknown = null;
    try { body = await r.json(); } catch { body = null; }
    return { status: r.status, body };
  } finally { clearTimeout(t); }
}

const has = (env: SetupCheckDeps['env'], k: string): string => (env[k] ?? '').trim();
const ok = (item: string, note: string): CheckRow => ({ item, mark: '✅', note });
const bad = (item: string, note: string): CheckRow => ({ item, mark: '❌', note });
const skip = (item: string, note: string): CheckRow => ({ item, mark: '➖', note });
const missing = (k: string): CheckRow => bad(k, 'Missing. Add the secret ' + k + ' (SETUP_GUIDE P-3).');

async function guarded(item: string, fn: () => Promise<CheckRow>): Promise<CheckRow> {
  try { return await fn(); } catch { return bad(item, 'Could not reach the service (network or time-out). Run again later.'); }
}

export async function runSetupCheck(d: SetupCheckDeps): Promise<{ rows: CheckRow[]; code: number }> {
  const e = d.env;
  const rows: CheckRow[] = [];

  // Google robot key + the 3 spreadsheets.
  const sa = has(e, 'GOOGLE_SERVICE_ACCOUNT_JSON');
  let saOk = false;
  if (!sa) rows.push(missing('GOOGLE_SERVICE_ACCOUNT_JSON'));
  else {
    type KeyFile = { client_email?: unknown; private_key?: unknown };
    const parsed: KeyFile | null = ((): KeyFile | null => { try { return JSON.parse(sa) as KeyFile; } catch { return null; } })();
    if (!parsed || typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') {
      rows.push(bad('GOOGLE_SERVICE_ACCOUNT_JSON', 'Not a robot key file. Paste the WHOLE downloaded .json file (SETUP_GUIDE P-2).'));
    } else { saOk = true; rows.push(ok('GOOGLE_SERVICE_ACCOUNT_JSON', 'Robot key file looks right.')); }
  }
  for (const k of ['SPREADSHEET_ID', 'REPORTS_SPREADSHEET_ID', 'DATA_SPREADSHEET_ID']) {
    const id = has(e, k);
    if (!id) { rows.push(missing(k)); continue; }
    if (!saOk) { rows.push(bad(k, 'Cannot test until the robot key is right.')); continue; }
    rows.push(await guarded(k, async () => {
      try { await d.sheetTitle(sa, id); return ok(k, 'The robot can open this sheet.'); }
      catch { return bad(k, 'The robot cannot open it. Check the id, and share the sheet with the robot e-mail as Editor (SETUP_GUIDE P-4).'); }
    }));
  }

  // Your stocks, part 1: the 🎯 Watchlist tab (Buy report candidates; also joins the paper 'A original' universe).
  const WL = WATCHLIST_TAB + ' tab';
  if (rows.find((r) => r.item === 'SPREADSHEET_ID')?.mark !== '✅') rows.push(skip(WL, 'Cannot read it until the robot key and SPREADSHEET_ID rows are ✅.'));
  else rows.push(await guarded(WL, async () => {
    const n = await d.watchlistCount(sa, has(e, 'SPREADSHEET_ID'));
    if (n === null) return bad(WL, 'The tab is not there yet. Run "Init user sheets", then type your buy candidates in column A' + CHOOSE);
    return n > 0 ? ok(WL, n + ' ticker(s).') : bad(WL, 'No tickers. Type your buy candidates in column A under the header (the Buy report reads them)' + CHOOSE);
  }));

  // Data keys.
  const fmp = has(e, 'FMP_API_KEY');
  rows.push(!fmp ? missing('FMP_API_KEY') : await guarded('FMP_API_KEY', async () => {
    const r = await getJson(d.fetchImpl, 'https://financialmodelingprep.com/stable/profile?symbol=AAPL&apikey=' + encodeURIComponent(fmp));
    if (r.status === 401 || r.status === 403) return bad('FMP_API_KEY', 'Key refused. Copy it again from the FMP dashboard.');
    if (r.status === 429) return ok('FMP_API_KEY', 'Key works (daily limit reached right now).');
    return r.status === 200 && Array.isArray(r.body) ? ok('FMP_API_KEY', 'Key works.') : bad('FMP_API_KEY', 'Unexpected answer (HTTP ' + r.status + '). Check the key.');
  }));
  const fh = has(e, 'FINNHUB_KEY');
  rows.push(!fh ? missing('FINNHUB_KEY') : await guarded('FINNHUB_KEY', async () => {
    const r = await getJson(d.fetchImpl, 'https://finnhub.io/api/v1/quote?symbol=AAPL&token=' + encodeURIComponent(fh));
    if (r.status === 401 || r.status === 403) return bad('FINNHUB_KEY', 'Key refused. Copy it again from the Finnhub dashboard.');
    const c = (r.body as { c?: unknown } | null)?.c;
    return r.status === 200 && typeof c === 'number' ? ok('FINNHUB_KEY', 'Key works.') : bad('FINNHUB_KEY', 'Unexpected answer (HTTP ' + r.status + ').');
  }));
  const av = has(e, 'ALPHAVANTAGE_KEY');
  rows.push(!av ? missing('ALPHAVANTAGE_KEY') : await guarded('ALPHAVANTAGE_KEY', async () => {
    const r = await getJson(d.fetchImpl, 'https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=IBM&apikey=' + encodeURIComponent(av));
    const b = (r.body ?? {}) as Record<string, unknown>;
    if (b['Error Message'] || (typeof b['Information'] === 'string' && /invalid|api key/i.test(b['Information'] as string))) return bad('ALPHAVANTAGE_KEY', 'Key refused. Copy it again.');
    if (b['Note'] || b['Information']) return ok('ALPHAVANTAGE_KEY', 'Key works (free limit reached right now).');
    return r.status === 200 && b['Global Quote'] ? ok('ALPHAVANTAGE_KEY', 'Key works.') : bad('ALPHAVANTAGE_KEY', 'Unexpected answer (HTTP ' + r.status + ').');
  }));

  // AI keys.
  const gem = has(e, 'GEMINI_API_KEY');
  rows.push(!gem ? (d.aiOn ? missing('GEMINI_API_KEY') : skip('GEMINI_API_KEY', 'Not needed: AI review is off in your profile.')) : await guarded('GEMINI_API_KEY', async () => {
    const r = await getJson(d.fetchImpl, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=' + encodeURIComponent(gem));
    return r.status === 200 ? ok('GEMINI_API_KEY', 'Key works.') : bad('GEMINI_API_KEY', 'Key refused (HTTP ' + r.status + '). Make a new key in Google AI Studio.');
  }));
  const ant = has(e, 'ANTHROPIC_API_KEY');
  rows.push(!ant ? skip('ANTHROPIC_API_KEY', 'Optional (paid). Without it the second AI opinion is skipped.') : await guarded('ANTHROPIC_API_KEY', async () => {
    const r = await getJson(d.fetchImpl, 'https://api.anthropic.com/v1/models?limit=1', { 'x-api-key': ant, 'anthropic-version': '2023-06-01' });
    return r.status === 200 ? ok('ANTHROPIC_API_KEY', 'Key works.') : bad('ANTHROPIC_API_KEY', 'Key refused (HTTP ' + r.status + '). Check it in the Anthropic console.');
  }));

  // Telegram.
  const tok = has(e, 'TELEGRAM_BOT_TOKEN');
  let botOk = false;
  if (!tok) rows.push(missing('TELEGRAM_BOT_TOKEN'));
  else rows.push(await guarded('TELEGRAM_BOT_TOKEN', async () => {
    const r = await getJson(d.fetchImpl, 'https://api.telegram.org/bot' + tok + '/getMe');
    botOk = r.status === 200 && (r.body as { ok?: unknown } | null)?.ok === true;
    return botOk ? ok('TELEGRAM_BOT_TOKEN', 'Bot found.') : bad('TELEGRAM_BOT_TOKEN', 'Bot key refused. Copy it again from BotFather (SETUP_GUIDE P-6).');
  }));
  const chat = has(e, 'TELEGRAM_CHAT_ID');
  if (!chat) rows.push(bad('TELEGRAM_CHAT_ID', 'Missing. Send your bot a message, then run "Telegram check" to get the number (SETUP_GUIDE P-6).'));
  else if (!botOk) rows.push(bad('TELEGRAM_CHAT_ID', 'Cannot test until the bot key is right.'));
  else rows.push(await guarded('TELEGRAM_CHAT_ID', async () => {
    const r = await getJson(d.fetchImpl, 'https://api.telegram.org/bot' + tok + '/getChat?chat_id=' + encodeURIComponent(chat));
    return r.status === 200 ? ok('TELEGRAM_CHAT_ID', 'The bot can reach your chat.') : bad('TELEGRAM_CHAT_ID', 'The bot cannot reach this chat. Press Start in your bot, then run "Telegram check".');
  }));
  rows.push(has(e, 'TELEGRAM_WEBHOOK_SECRET') ? ok('TELEGRAM_WEBHOOK_SECRET', 'Present (used by the relay).') : skip('TELEGRAM_WEBHOOK_SECRET', 'Only needed for typed Telegram commands (relay, SETUP_GUIDE P-5).'));

  // SEC contact.
  const sec = has(e, 'SEC_CONTACT_EMAIL');
  rows.push(!sec ? missing('SEC_CONTACT_EMAIL') : /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sec) ? ok('SEC_CONTACT_EMAIL', 'Looks like an e-mail.') : bad('SEC_CONTACT_EMAIL', 'Not an e-mail address. The SEC asks for one.'));

  // Profile.
  const pr = d.profile;
  if (pr) {
    if (!pr.ok) rows.push(bad('Profile', pr.error));
    else if (pr.paperOn && !pr.paperStart) rows.push(bad('Profile', 'Paper test is on but paper.start is empty. Set it to the next trading day (YYYY-MM-DD) in the ⚙️ Profile tab.'));
    else rows.push(ok('Profile', 'Valid (' + pr.source + ').'));

    // Your stocks, part 2: the Profile lists (counts only).
    const CORE = 'Profile lists.core', FIXED = 'Profile paper.fixedUniverse';
    if (!pr.ok) { rows.push(skip(CORE, 'Fix the Profile row first.')); rows.push(skip(FIXED, 'Fix the Profile row first.')); }
    else {
      const c = pr.coreCount;
      rows.push(c >= MIN_CORE_TICKERS ? ok(CORE, c + ' ticker(s).')
        : bad(CORE, (c === 0 ? 'Empty.' : 'Only ' + c + ' ticker(s).') + ' Put ' + MIN_CORE_TICKERS + '+ tickers (10-20 is typical) in lists.core in the ⚙️ Profile tab: the paper \'your list\' accounts trade them' + CHOOSE));
      if (!pr.paperOn) rows.push(skip(FIXED, 'Not needed: the paper test is off in your profile.'));
      else rows.push(pr.fixedUniverseCount > 0 ? ok(FIXED, pr.fixedUniverseCount + ' ticker(s).')
        : bad(FIXED, 'Empty. Put your tickers in paper.fixedUniverse in the ⚙️ Profile tab (or remove the row to use lists.core): the paper \'A original\' accounts trade them' + CHOOSE));
    }
  }

  const code = rows.some((r) => r.mark === '❌') ? 1 : 0;
  return { rows, code };
}

/** The table as plain text lines (also sent to Telegram when the bot works). */
export function formatRows(rows: readonly CheckRow[]): string[] {
  const out = ['Setup check', '| Item | | What to do |', '|---|---|---|'];
  for (const r of rows) out.push('| ' + r.item + ' | ' + r.mark + ' | ' + r.note + ' |');
  const bads = rows.filter((r) => r.mark === '❌').length;
  out.push(bads ? bads + ' item(s) to fix.' : 'All set.');
  return out;
}

async function googleWatchlistCount(credentialsJson: string, spreadsheetId: string): Promise<number | null> {
  const { google } = await import('googleapis');
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(credentialsJson), scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const api = google.sheets({ version: 'v4', auth });
  const meta = await api.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  if (!(meta.data.sheets ?? []).some((sh) => sh.properties?.title === WATCHLIST_TAB)) return null;
  const res = await api.spreadsheets.values.get({ spreadsheetId, range: "'" + WATCHLIST_TAB + "'!A:A" });
  return countWatchlistRows(res.data.values ?? []);
}

async function googleSheetTitle(credentialsJson: string, spreadsheetId: string): Promise<string> {
  const { google } = await import('googleapis');
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(credentialsJson), scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const res = await google.sheets({ version: 'v4', auth }).spreadsheets.get({ spreadsheetId, fields: 'properties.title' });
  return res.data.properties?.title ?? '';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = (l: string): void => { process.stdout.write(l + '\n'); };
  const profile = ((): SetupCheckDeps['profile'] => {
    try {
      const p = activeProfile();
      return { ok: true, paperOn: p.features.paper, paperStart: p.paper.start ?? null, source: activeProfileSource(), coreCount: p.lists.core.length, fixedUniverseCount: p.paper.fixedUniverse.length };
    }
    catch (e) { return { ok: false, error: String((e as Error).message ?? e) }; }
  })();
  runSetupCheck({ env: process.env, fetchImpl: fetch, sheetTitle: googleSheetTitle, watchlistCount: googleWatchlistCount, aiOn: profile?.ok ? activeProfile().features.ai : false, profile, out })
    .then(({ rows, code }) => { formatRows(rows).forEach(out); finish(code); }, (e: unknown) => { out('Setup check: unexpected failure.'); processLine('CRITICAL', 'setup', 'setup check stopped on an unexpected error (exit 1)', { detail: String(e) }); finish(1); });
}
