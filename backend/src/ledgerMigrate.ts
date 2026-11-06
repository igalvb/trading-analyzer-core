/**
 * `npm run ledger-migrate -- --out <dir> [--check]` (docs/LEDGER.md phase 1): reads the Portfolio tab and the Watchlist
 * tab of My Portfolio READ-ONLY (a read-only Google scope; nothing is written to Google), converts them
 * (ledger/fromSheet.ts) and writes the ledger files into <dir>, laid out like the `data` branch:
 *
 *   <dir>/ledger/holdings.json, assets.json, watchlist.json
 *   <dir>/migration/needs-owner-check.json   every row it could not map with certainty, and each flagged total
 *   <dir>/migration/reconciliation.md        the table printed below
 *   <dir>/migration/crypto-price-cells.json  where each coin's price comes from today (for a later crypto price job)
 *   <dir>/ledger/targets.json                the values the owner typed under the layout's target labels (when any)
 *
 * Prints the counts and the reconciliation table (per group, and against the sheet's own totals; > 0.5% flagged).
 * --check = reconcile only: nothing is written; exit 1 when a line is flagged.
 * The sheet's words above the stock table come from ledger/layout.ts loadLedgerLayout (overlay / LEDGER_LAYOUT_FILE);
 * the user's answers to earlier checks from ledger/corrections.ts loadLedgerCorrections (overlay / LEDGER_CORRECTIONS_FILE):
 * fixes before the reconciliation, updates after it (both listed).
 * The service-account value and the sheet ID are never printed.
 * Exit: 0 done, 1 --check found a flag, 2 configuration missing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import { finish } from './core/finish.ts';
import { parseServiceAccount } from './sheets/serviceAccount.ts';
import { a1, Tabs } from './sheets/tabs.ts';
import type { SheetRow } from './sheets/coerce.ts';
import { formatDateInTz } from './core/dates.ts';
import { fromSheet, type FromSheetResult } from './ledger/fromSheet.ts';
import { reconcile, reconciliationTable } from './ledger/reconcile.ts';
import { loadLedgerLayout } from './ledger/layout.ts';
import { applyCorrections, applyUpdates, loadLedgerCorrections } from './ledger/corrections.ts';
import { formatJson, writeLedgerJson } from './ledger/store.ts';

type Env = Readonly<Record<string, string | undefined>>;
export interface SheetGrids { readonly portfolio: SheetRow[]; readonly watchlist: SheetRow[]; readonly formulas: SheetRow[] | null }

export interface LedgerMigrateDeps {
  readonly env: Env;
  readonly argv: readonly string[];
  readonly out: (line: string) => void;
  /** The two tabs (default: Google Sheets, read-only, GOOGLE_SERVICE_ACCOUNT_JSON / SPREADSHEET_ID). */
  readonly readGrids?: (env: Env) => Promise<SheetGrids>;
  readonly now?: () => number;
}

export const READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

/** Portfolio (values, dates as serial numbers, as the runs read it), the Watchlist, and Portfolio again as formulas. */
async function googleGrids(env: Env): Promise<SheetGrids> {
  const credentials = parseServiceAccount(String(env.GOOGLE_SERVICE_ACCOUNT_JSON));
  const api = google.sheets({ version: 'v4', auth: new google.auth.GoogleAuth({ credentials, scopes: [READONLY_SCOPE] }) });
  const spreadsheetId = String(env.SPREADSHEET_ID).trim();
  const values = await api.spreadsheets.values.batchGet({ spreadsheetId, ranges: [a1(Tabs.PORTFOLIO, 'A:Z'), a1(Tabs.WATCHLIST, 'A:A')], valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' })
    .catch((e: unknown) => { throw new Error('the sheet could not be read (' + String((e as { code?: unknown })?.code ?? 'no code') + ')'); });
  const formulas = await api.spreadsheets.values.batchGet({ spreadsheetId, ranges: [a1(Tabs.PORTFOLIO, 'A:Z')], valueRenderOption: 'FORMULA' })
    .then((r) => (r.data.valueRanges?.[0]?.values ?? []) as SheetRow[], () => null);
  const vr = values.data.valueRanges ?? [];
  return { portfolio: (vr[0]?.values ?? []) as SheetRow[], watchlist: (vr[1]?.values ?? []) as SheetRow[], formulas };
}

const money = (x: number): string => x.toLocaleString('en-US', { maximumFractionDigits: 2 });

export async function ledgerMigrate(deps: LedgerMigrateDeps): Promise<number> {
  const arg = (k: string): string | undefined => { const i = deps.argv.indexOf(k); return i >= 0 ? deps.argv[i + 1] : undefined; };
  const check = deps.argv.includes('--check');
  const dir = arg('--out');
  if (!dir && !check) { deps.out('Ledger migration: give the folder to write, --out <dir> (or --check to reconcile only).'); return 2; }
  if (!deps.readGrids) {
    const missing = ['GOOGLE_SERVICE_ACCOUNT_JSON', 'SPREADSHEET_ID'].filter((n) => !(deps.env[n] ?? '').trim());
    if (missing.length) { deps.out('Ledger migration: missing ' + missing.join(', ') + '.'); return 2; }
  }
  const { layout, source } = await loadLedgerLayout(deps.env);
  const grids = await (deps.readGrids ?? googleGrids)(deps.env);
  const today = formatDateInTz(new Date((deps.now ?? Date.now)()), 'America/New_York');
  const read: FromSheetResult = fromSheet({ portfolio: grids.portfolio, watchlist: grids.watchlist, formulas: grids.formulas, today, layout, tab: Tabs.PORTFOLIO });
  const { corrections, source: corrSource } = await loadLedgerCorrections(deps.env, source);
  const fixed = applyCorrections(read, corrections, grids.portfolio, Tabs.PORTFOLIO);
  const rec = reconcile(fixed.result);
  const updated = applyUpdates(fixed.result, corrections);
  const m = updated.result;
  const table = reconciliationTable(rec);
  if (corrSource !== 'none') {
    table.push('', 'Corrections (' + corrections.label + ', ' + corrSource + '), applied before the reconciliation:', ...(fixed.applied.length ? fixed.applied.map((l) => '- ' + l) : ['- none']));
    if (updated.applied.length) table.push('', 'Updates after the sheet (applied after the reconciliation; the sheet\'s totals do not know them):', ...updated.applied.map((l) => '- ' + l));
  }

  const h = m.holdings;
  deps.out('Ledger migration (' + today + ', sheet words: ' + source + '), read-only from Google:');
  deps.out('  holdings: ' + h.stocks.length + ' stock-table item(s) (' + h.stocks.filter((s) => s.kind === 'stock').length + ' stocks, ' + h.stocks.filter((s) => s.kind === 'btcFund').length
    + ' bitcoin funds, ' + h.stocks.filter((s) => s.kind === 'crypto').length + ' crypto), ' + h.options.length + ' open option(s), ' + h.closed.length + ' closed');
  deps.out('  assets: ' + m.assets.items.length + ' item(s); watchlist: ' + m.watchlist.tickers.length + ' ticker(s); typed targets: ' + m.targets.items.length);
  for (const l of table) deps.out(l);
  deps.out(''); deps.out('Crypto prices today (cell <- source [script symbol]):');
  for (const c of m.cryptoPriceCells) deps.out('  ' + c.ticker + ': ' + c.cell + ' <- ' + (c.source ?? 'typed') + (c.apiSymbol ? ' [' + c.apiSymbol + ']' : ''));
  const unused = Object.entries(m.unusedCryptoApiCells);
  if (unused.length) deps.out('  filled by the script but read by no holding row: ' + unused.map(([c, sym]) => c + ' ' + sym).join(', '));
  const flaggedTotals = rec.lines.filter((l) => l.flagged).map((l) => ({ where: 'reconciliation', item: l.check, why: 'ledger ' + (l.ledger == null ? '—' : money(l.ledger)) + ' vs the sheet ' + (l.sheet == null ? '—' : money(l.sheet)) + ' ' + l.currency + (l.diffPct == null ? '' : ' (' + l.diffPct + '%)') + ': check which one is right', raw: '' }));
  const ownerCheck = [...m.needsOwnerCheck, ...flaggedTotals];
  deps.out('Needs owner check: ' + ownerCheck.length + ' item(s)');
  for (const c of ownerCheck) deps.out('  - ' + c.where + ' ' + c.item + ': ' + c.why);

  if (check) return rec.flagged ? 1 : 0;
  const root = path.resolve(dir as string);
  writeLedgerJson(root, 'holdings', m.holdings);
  writeLedgerJson(root, 'assets', m.assets);
  writeLedgerJson(root, 'watchlist', m.watchlist);
  fs.mkdirSync(path.join(root, 'migration'), { recursive: true });
  fs.writeFileSync(path.join(root, 'migration', 'needs-owner-check.json'), formatJson({ date: today, items: ownerCheck }));
  fs.writeFileSync(path.join(root, 'migration', 'reconciliation.md'), ['# Ledger migration reconciliation, ' + today, '', ...table, ''].join('\n'));
  fs.writeFileSync(path.join(root, 'migration', 'crypto-price-cells.json'), formatJson({ date: today, cells: m.cryptoPriceCells, scriptCells: layout.cryptoApiCells, unusedScriptCells: m.unusedCryptoApiCells }));
  const files = ['ledger/holdings.json', 'ledger/assets.json', 'ledger/watchlist.json'];
  if (m.targets.items.length) { writeLedgerJson(root, 'targets', m.targets); files.push('ledger/targets.json'); }
  deps.out('Written to ' + root + ': ' + files.join(', ') + ', migration/ (3 files).');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ledgerMigrate({ env: process.env, argv: process.argv.slice(2), out: (l) => { process.stdout.write(l + '\n'); } }).then(
    (code) => finish(code),
    (e: unknown) => { process.stderr.write('Ledger migration failed: ' + String(e instanceof Error ? e.message : e) + '\n'); finish(1); },
  );
}
