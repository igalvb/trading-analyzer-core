/**
 * The words the ledger migration (ledger/fromSheet.ts) looks for in a user's Portfolio tab ABOVE the stock table: the
 * summary totals, the sub-type block and the pension / savings / property block. The stock, options and CLOSED tables
 * use the template's own headers (sheets/readers/portfolio.ts, initUserSheets.ts) and need nothing here.
 *
 * The shared core carries only the plain English default below. A user whose sheet is written in another language
 * keeps their own words in a private overlay, src/owner/ledgerLayout.ts (export OWNER_LEDGER_LAYOUT), or in a JSON
 * file named by LEDGER_LAYOUT_FILE; loadLedgerLayout picks the first found: the file, the overlay, the default.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Where a total's number sits relative to its label cell. */
export type LabelAt = 'below' | 'left' | 'right';
export interface TotalLabel { readonly label: string; readonly at: LabelAt }

export const TOTAL_KEYS = ['portfolioUsd', 'portfolioIls', 'pensionIls', 'savingsIls', 'savingsWithAssetsIls', 'debtIls', 'fxUsdIls', 'realEstateIls'] as const;
export type TotalKey = (typeof TOTAL_KEYS)[number];

export interface SheetLayout {
  /** The sheet's own totals (reconciliation only); null = this sheet has no such total. */
  readonly totals: Readonly<Record<TotalKey, TotalLabel | null>>;
  /** The sub-type block: its header row (two labels) and the label of its options row. */
  readonly subTypes: { readonly header: readonly [string, string]; readonly optionsLabel: string } | null;
  /** The pension / savings / property block: the four header labels; the column right of `amount` holds whose it is. */
  readonly funds: { readonly track: string; readonly provider: string; readonly type: string; readonly amount: string } | null;
  /** Words of the `type` cell (lower case, "contains") that put a row in a group; checked in this order. */
  readonly groups: { readonly realEstate: readonly string[]; readonly pension: readonly string[]; readonly funds: readonly string[]; readonly cash: readonly string[] };
  /** Words of a property's note: "value 3.3 million but 1.3 mortgage". */
  readonly notes: { readonly value: readonly string[]; readonly debt: readonly string[]; readonly million: readonly string[]; readonly thousand: readonly string[] };
  /** Where the sheet's separate debt line belongs: 'realEstate' = the debt of the one property without a mortgage yet; 'cash' = a negative cash item. */
  readonly debtTo: 'realEstate' | 'cash';
  /** Values the user typed for himself (ledger/targets.json): the label cell, and the names of the numbers below it (one name per number). */
  readonly targets: ReadonlyArray<{ readonly label: string; readonly names: readonly string[] }>;
  /** Cells a sheet script fills with crypto prices (cell -> coin symbol), for the reconciliation report only. */
  readonly cryptoApiCells: Readonly<Record<string, string>>;
}

/** Plain English: the words a new user's sheet would use (none of them is required: a missing block is skipped). */
export const DEFAULT_LEDGER_LAYOUT: SheetLayout = {
  totals: {
    portfolioUsd: { label: 'Total Portfolio Sum $', at: 'below' },
    portfolioIls: { label: 'Total Portfolio Sum NIS', at: 'below' },
    pensionIls: { label: 'Total pension NIS', at: 'below' },
    savingsIls: { label: 'Total Savings NIS', at: 'below' },
    savingsWithAssetsIls: { label: 'Total savings with assets', at: 'below' },
    debtIls: { label: 'DEBT in NIS', at: 'below' },
    fxUsdIls: { label: 'USD to NIS', at: 'below' },
    realEstateIls: { label: 'Real estate total', at: 'left' },
  },
  subTypes: { header: ['sub-type', 'Aggregated Investment Value'], optionsLabel: 'Options' },
  funds: { track: 'Track', provider: 'Provider', type: 'Type', amount: 'Amount' },
  groups: { realEstate: ['real estate', 'property', 'apartment'], pension: ['pension', 'insurance'], funds: ['fund', 'saving'], cash: ['cash', 'deposit'] },
  notes: { value: ['value', 'worth'], debt: ['mortgage', 'debt', 'loan'], million: ['million', 'm'], thousand: ['thousand', 'k'] },
  debtTo: 'cash',
  targets: [],
  cryptoApiCells: {},
};

type Env = Readonly<Record<string, string | undefined>>;

/** backend/src/owner/ledgerLayout.ts (present only in a copy with a private overlay). */
export const OVERLAY_LAYOUT_FILE = path.join(import.meta.dirname, '..', 'owner', 'ledgerLayout.ts');

/** The layout of this user's sheet: LEDGER_LAYOUT_FILE (JSON), else the overlay's, else the default. */
export async function loadLedgerLayout(env: Env = process.env): Promise<{ readonly layout: SheetLayout; readonly source: 'file' | 'overlay' | 'default' }> {
  const file = (env.LEDGER_LAYOUT_FILE ?? '').trim();
  if (file) return { layout: { ...DEFAULT_LEDGER_LAYOUT, ...(JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SheetLayout>) }, source: 'file' };
  if (fs.existsSync(OVERLAY_LAYOUT_FILE)) {
    const m = await import(pathToFileURL(OVERLAY_LAYOUT_FILE).href) as { readonly OWNER_LEDGER_LAYOUT?: SheetLayout };
    if (m.OWNER_LEDGER_LAYOUT) return { layout: m.OWNER_LEDGER_LAYOUT, source: 'overlay' };
  }
  return { layout: DEFAULT_LEDGER_LAYOUT, source: 'default' };
}
