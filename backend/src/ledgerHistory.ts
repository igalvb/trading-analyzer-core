/**
 * `npm run ledger-history -- --out <dir>` (docs/LEDGER.md phase 4): copies the system's own history tabs
 * (ledger/history.ts HISTORY_MANIFEST) from Google, READ-ONLY (a read-only scope), into <dir>/history/ as files, plus
 * history/manifest.json. Prints one line per tab: rows, bytes and the file -- never a cell value; for 💾 Script
 * Properties only the number of keys and the KEYS of any secret-shaped value left out.
 *
 * Each tab is read from the spreadsheet that holds it (sheets/tabs.ts sheetFor: data / reports / My Portfolio; the
 * matching *_SPREADSHEET_ID, else SPREADSHEET_ID), falling back to My Portfolio (a copy not yet split in three).
 * Exit: 0 done, 2 configuration missing.
 */

import path from 'node:path';
import { google } from 'googleapis';
import { finish } from './core/finish.ts';
import { parseServiceAccount } from './sheets/serviceAccount.ts';
import { a1, sheetFor } from './sheets/tabs.ts';
import { copyHistory, type CopiedTab } from './ledger/history.ts';
import { READONLY_SCOPE } from './ledgerMigrate.ts';

type Env = Readonly<Record<string, string | undefined>>;

export interface LedgerHistoryDeps {
  readonly env: Env;
  readonly argv: readonly string[];
  readonly out: (line: string) => void;
  /** One tab's rows (null = no such tab). Default: Google Sheets, read-only. */
  readonly readTab?: (tab: string) => Promise<unknown[][] | null>;
  readonly now?: () => number;
}

function googleReader(env: Env): (tab: string) => Promise<unknown[][] | null> {
  const credentials = parseServiceAccount(String(env.GOOGLE_SERVICE_ACCOUNT_JSON));
  const api = google.sheets({ version: 'v4', auth: new google.auth.GoogleAuth({ credentials, scopes: [READONLY_SCOPE] }) });
  const id = (n: string): string => (env[n] ?? '').trim();
  const get = (spreadsheetId: string, tab: string): Promise<unknown[][] | null> => api.spreadsheets.values.get({ spreadsheetId, range: a1(tab), valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' })
    .then((r) => (r.data.values ?? []) as unknown[][], (e: unknown) => {
      if (/unable to parse range/i.test(String((e as Error)?.message ?? ''))) return null;
      throw new Error('the sheet could not be read (' + String((e as { code?: unknown })?.code ?? 'no code') + ')');
    });
  return async (tab) => {
    const role = sheetFor(tab);
    const own = role === 'data' ? id('DATA_SPREADSHEET_ID') : role === 'reports' ? id('REPORTS_SPREADSHEET_ID') : '';
    const main = id('SPREADSHEET_ID');
    return (own ? await get(own, tab) : null) ?? (own !== main ? await get(main, tab) : null);
  };
}

const line = (t: CopiedTab): string => '  ' + t.tab + ' -> ' + t.file + ': ' + (t.missing ? 'no such tab (skipped)' : t.rows + (t.file.endsWith('.json') ? ' key(s)' : ' row(s)') + ', ' + t.bytes + ' bytes'
  + (t.withheld?.length ? '; ' + t.withheld.length + ' secret-shaped value(s) left out, keys: ' + t.withheld.join(', ') : ''));

export async function ledgerHistory(deps: LedgerHistoryDeps): Promise<number> {
  const i = deps.argv.indexOf('--out');
  const dir = i >= 0 ? deps.argv[i + 1] : undefined;
  if (!dir) { deps.out('History copy: give the folder to write, --out <dir>.'); return 2; }
  if (!deps.readTab) {
    const missing = ['GOOGLE_SERVICE_ACCOUNT_JSON', 'SPREADSHEET_ID'].filter((n) => !(deps.env[n] ?? '').trim());
    if (missing.length) { deps.out('History copy: missing ' + missing.join(', ') + '.'); return 2; }
  }
  const root = path.resolve(dir);
  const copied = await copyHistory(deps.readTab ?? googleReader(deps.env), root, new Date((deps.now ?? Date.now)()).toISOString());
  deps.out('History copy (read-only from Google) into ' + root + ':');
  for (const t of copied) deps.out(line(t));
  deps.out(copied.filter((t) => !t.missing).length + ' of ' + copied.length + ' tab(s) copied; history/manifest.json written. No run reads these files yet.');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ledgerHistory({ env: process.env, argv: process.argv.slice(2), out: (l) => { process.stdout.write(l + '\n'); } }).then(
    (code) => finish(code),
    (e: unknown) => { process.stderr.write('History copy failed: ' + String(e instanceof Error ? e.message : e) + '\n'); finish(1); },
  );
}
