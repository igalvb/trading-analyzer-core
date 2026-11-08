/**
 * The owner's ledger: everything the Portfolio tab holds, as plain JSON files on the repository's private `data`
 * branch (owner 2026-11-06: leave Google Sheets; only the Portfolio tab and the Watchlist move, plus the system's own
 * history). This file is the ONE shared format: the migration (sheets -> files), the runs (read the holdings, write
 * snapshots), the dashboard (read everything) and the dashboard's edit function (append edits) all use it.
 *
 *   ledger/holdings.json      LedgerHoldings   stocks, crypto, calls (open) and closed positions
 *   ledger/assets.json        LedgerAssets     pension, other funds, real estate (+ mortgage), cash: static values
 *   ledger/watchlist.json     LedgerWatchlist  the Buy report's candidates
 *   ledger/flows.jsonl        LedgerFlow       money in / out, one JSON object per line (append-only)
 *   ledger/snapshots.jsonl    LedgerSnapshot   one line per day: value per group (the growth graph), append-only
 *   ledger/edits.jsonl        LedgerEdit       every edit made in the dashboard (audit trail), append-only
 *   ledger/targets.json       LedgerTargets    optional: values the owner typed for himself (additive 2026-11-06)
 *   ledger/prices.json        LedgerPrices     optional: the Nightly's own prices of the night (additive 2026-11-06)
 *   ledger/journal.jsonl      LedgerJournalEntry  the advice journal: every advice given, one line each (additive 2026-11-08)
 *
 * Money: `currency` per item ('USD' | 'ILS'); totals are converted with the day's USD/ILS rate (`fxUsdIls` in a
 * snapshot). Dates are 'YYYY-MM-DD' (New York date for market data, the owner's date for his own entries).
 * Every file carries `schema: LEDGER_SCHEMA` (jsonl: in each line) so a reader can refuse a newer format.
 */

export const LEDGER_SCHEMA = 1;
export const LEDGER_BRANCH = 'data';
export const LEDGER_DIR = 'ledger';

export type Currency = 'USD' | 'ILS';
/** The groups of the net-worth screen and the growth graph's filter chips. */
export const LEDGER_GROUPS = ['stocks', 'btcFunds', 'crypto', 'calls', 'pension', 'funds', 'realEstate', 'cash'] as const;
export type LedgerGroup = (typeof LEDGER_GROUPS)[number];

export interface LedgerStock {
  readonly id: string;
  readonly ticker: string;
  /** 'stock' (incl. ETFs) | 'btcFund' (a spot bitcoin ETF) | 'crypto' (a coin, not analysed). */
  readonly kind: 'stock' | 'btcFund' | 'crypto';
  readonly qty: number;
  /** Average cost per unit, in `currency`. */
  readonly avgCost: number | null;
  readonly currency: Currency;
  /** 'YYYY-MM-DD'; null = unknown (the runs then assume profile sheets.portfolio.assumedPurchaseDate). */
  readonly bought: string | null;
  /** A price typed by the owner (crypto, or a holding no data source covers); null = the runs price it. */
  readonly manualPrice?: number | null;
  readonly note?: string;
  /** Added 2026-11-06 (dashboard, additive): the Portfolio tab's sub-type, as written (the allocation pie); absent = by kind. */
  readonly subType?: string;
  /**
   * Added 2026-11-06 (crypto prices, additive): the coin's symbol at the crypto price source (ledger/cryptoPrices.ts),
   * when it differs from the ticker as written; filled by the migration from the sheet's price-script cells. Absent =
   * the ticker without trailing dots. Read only when profile ledger.cryptoPrices is 'on'.
   */
  readonly priceSymbol?: string;
  /**
   * Added 2026-11-07 (dated purchase lots, additive): the buys that make up the holding, as the owner's broker shows
   * them. Rule (ledger/lots.ts): the lots hold at most `qty`; the rest is ONE implicit undated lot priced so the total
   * cost stays qty x avgCost (computed, never stored; a negative or absurd implied price is a check, not a number).
   * `bought` absent / null = the earliest dated lot (lots.ts boughtOf). Display only: the runs keep reading qty and
   * avgCost (toPortfolio.ts). Absent = no lots (the whole quantity is one lot bought on `bought` at avgCost).
   */
  readonly lots?: readonly LedgerLot[];
}

/** One dated purchase of a holding (LedgerStock.lots). After a split: post-split numbers, the old ones in `note`. */
export interface LedgerLot {
  /** 'YYYY-MM-DD'; null = an undated lot. */
  readonly date: string | null;
  /** Units bought (> 0). */
  readonly qty: number;
  /** Price paid per unit, in the holding's currency. */
  readonly price: number;
  readonly note?: string;
}

export interface LedgerOption {
  readonly id: string;
  readonly ticker: string;
  readonly side: 'call' | 'put';
  readonly contracts: number;
  readonly strike: number;
  readonly expiry: string;
  /** Premium paid per share (x100 per contract). */
  readonly avgPremium: number | null;
  readonly bought: string | null;
  /** Last market value of all contracts (written by My Options); null when unknown. */
  readonly currentValue?: number | null;
  readonly note?: string;
}

export interface LedgerClosed {
  readonly id: string;
  readonly ticker: string;
  readonly kind: 'stock' | 'btcFund' | 'crypto' | 'call' | 'put';
  readonly qty: number;
  readonly strike?: number | null;
  readonly expiry?: string | null;
  /** Total cost of the closed quantity, in `currency`. */
  readonly cost: number | null;
  /** Total proceeds of the sale, in `currency`. */
  readonly proceeds: number | null;
  readonly currency: Currency;
  readonly bought: string | null;
  readonly sold: string | null;
  readonly note?: string;
}

export interface LedgerHoldings {
  readonly schema: number;
  readonly updated: string;
  readonly stocks: readonly LedgerStock[];
  readonly options: readonly LedgerOption[];
  readonly closed: readonly LedgerClosed[];
}

/** A static-value item: a pension or savings fund, a property (with its mortgage), cash. */
export interface LedgerAsset {
  readonly id: string;
  readonly group: 'pension' | 'funds' | 'realEstate' | 'cash';
  /** As the owner writes it (Hebrew kept, e.g. a flat's or a pension track's own name). */
  readonly name: string;
  /** Who manages it / the track, as written (Hebrew kept). */
  readonly provider?: string;
  readonly value: number;
  /** Real estate: the outstanding mortgage (net = value - debt). */
  readonly debt?: number | null;
  readonly currency: Currency;
  /** The date the owner last updated the value. */
  readonly asOf: string;
  readonly note?: string;
  /** Added 2026-11-06 (dashboard, additive): whose it is, as written (per-person subtotals on the net worth screen). */
  readonly person?: string;
  /** Additive (migration 2026-11-06): the savings type as the sheet names it (pension, study fund, managers' insurance...). */
  readonly savingsType?: string;
}

export interface LedgerAssets {
  readonly schema: number;
  readonly updated: string;
  readonly items: readonly LedgerAsset[];
}

export interface LedgerWatchlist {
  readonly schema: number;
  readonly updated: string;
  readonly tickers: readonly string[];
}

/** Money put in (+) or taken out (-) of a group / item, for the graph's marks and growth-without-deposits. */
export interface LedgerFlow {
  readonly schema: number;
  readonly id: string;
  readonly date: string;
  readonly group: LedgerGroup;
  /** The asset id or holding id it concerns, when one. */
  readonly itemId?: string | null;
  /** Positive = money in, negative = money out, in `currency`. */
  readonly amount: number;
  readonly currency: Currency;
  readonly note?: string;
  /** 'owner' = typed in the dashboard; 'suggested' = detected by a run, waiting for the owner; 'confirmed' = a suggestion the owner accepted. */
  readonly source: 'owner' | 'suggested' | 'confirmed' | 'migration';
  /**
   * Added 2026-11-06 (dashboard edits, additive): true = the owner dismissed this suggested flow. The dashboard's edit
   * function confirms or dismisses a flow by APPENDING a new line with the same `id` (source 'confirmed', or
   * `dismissed: true`); a reader keeps the LAST line of each id (src/ledger/networth.ts latestFlows).
   */
  readonly dismissed?: boolean;
}

/** One day's values per group (in USD and ILS), written by the Nightly; the growth graph reads these. */
export interface LedgerSnapshot {
  readonly schema: number;
  readonly date: string;
  readonly fxUsdIls: number | null;
  /** Value per group in USD (real estate: net of debt). */
  readonly usd: Readonly<Partial<Record<LedgerGroup, number>>>;
  readonly totalUsd: number;
  readonly totalIls: number | null;
}

/**
 * Additive (2026-11-06), optional file ledger/targets.json: values the owner typed for himself next to his holdings
 * (e.g. an all-time-high ratio he watches). Not read by any run; kept so nothing he typed is lost when the sheet goes.
 */
export interface LedgerTarget {
  readonly id: string;
  readonly name: string;
  readonly value: number;
  readonly note?: string;
}
export interface LedgerTargets {
  readonly schema: number;
  readonly updated: string;
  readonly items: readonly LedgerTarget[];
}

/**
 * Additive (2026-11-06), optional file ledger/prices.json: the prices the Nightly used for the day's snapshot where it
 * priced a holding itself (profile ledger.cryptoPrices 'on': the crypto), USD per unit by holding id. Rewritten each
 * night; the dashboard prefers it over manualPrice while its `date` is not older than holdings.json's `updated`.
 */
export interface LedgerPrices {
  readonly schema: number;
  readonly date: string;
  readonly prices: Readonly<Record<string, number>>;
}

/** The kinds of dashboard edit (dashboard/functions/api/edit.js LEDGER.editKinds mirrors this). */
export const LEDGER_EDIT_KINDS = ['add', 'change', 'remove', 'sell', 'flow', 'watchlist', 'lot'] as const;
export type LedgerEditKind = (typeof LEDGER_EDIT_KINDS)[number];

/** One dashboard edit (the audit trail). `before` / `after` are the item as it was / is. */
export interface LedgerEdit {
  readonly schema: number;
  readonly at: string;
  readonly by: string;
  /** 'lot' (additive 2026-11-07): a dated purchase lot added to / removed from a holding (LedgerStock.lots). */
  readonly kind: LedgerEditKind;
  readonly file: string;
  readonly itemId: string | null;
  readonly before: unknown;
  readonly after: unknown;
}

export const LEDGER_FILES = {
  holdings: LEDGER_DIR + '/holdings.json',
  assets: LEDGER_DIR + '/assets.json',
  watchlist: LEDGER_DIR + '/watchlist.json',
  flows: LEDGER_DIR + '/flows.jsonl',
  snapshots: LEDGER_DIR + '/snapshots.jsonl',
  edits: LEDGER_DIR + '/edits.jsonl',
  /** Optional (additive 2026-11-06). */
  targets: LEDGER_DIR + '/targets.json',
  /** Optional (additive 2026-11-06): written by the Nightly. */
  prices: LEDGER_DIR + '/prices.json',
  /** Optional (additive 2026-11-08): the advice journal (ledger/journal.ts), append-only. */
  journal: LEDGER_DIR + '/journal.jsonl',
} as const;

/**
 * Additive (2026-11-08), optional file ledger/journal.jsonl: the advice journal (ledger/journal.ts, docs/LEDGER.md
 * "The advice journal"). One line per NEW or CHANGED piece of advice the system or Claude gave, append-only, so it can
 * be scored a year later. Whether the owner acted on it and whether it was right are NOT stored: the dashboard computes
 * both at each build (from edits.jsonl / holdings.json and the price history).
 */
export const JOURNAL_SOURCES = ['exit', 'buy', 'washout', 'marketShock', 'business', 'eventCheck', 'claudeIdea', 'claudeChat', 'top5'] as const;
export type JournalSource = (typeof JOURNAL_SOURCES)[number];
export const JOURNAL_ADVICE = ['BUY', 'ADD', 'HOLD', 'REVIEW', 'EXIT', 'WAIT', 'AVOID', 'BUY_POINT', 'ALERT'] as const;
export type JournalAdvice = (typeof JOURNAL_ADVICE)[number];

export interface LedgerJournalEntry {
  readonly schema: number;
  /** Stable: date, source, subject and advice (ledger/journal.ts journalId); a second line with the same id is refused. */
  readonly id: string;
  /** 'YYYY-MM-DD', New York: the day the advice was given. */
  readonly date: string;
  readonly source: JournalSource;
  /** null = the whole market (a market shock, a market event check). */
  readonly ticker: string | null;
  readonly advice: JournalAdvice;
  /** The short reason, as the report or Claude gave it. */
  readonly detail: string;
  /** The stock's price when the advice was given (an option: its underlying); null = not known (the history's close that day is used). */
  readonly priceAtAdvice: number | null;
  /** QQQ's price then; null = not known (the history's close that day is used). */
  readonly qqqAtAdvice: number | null;
  /** The horizon the advice names, as written ("6-12 months", "until 17 Nov earnings"); '' = none named. */
  readonly horizon: string;
  /** Where it came from: the holding's label, the entry zone, the report's run time, an alert's signature... */
  readonly refs?: Readonly<Record<string, string | number | null>>;
  /** When the line was written (ISO). */
  readonly at?: string;
}

/** The group of a holding (net-worth screen, filters, snapshots). */
export function groupOfStock(s: Pick<LedgerStock, 'kind'>): LedgerGroup {
  return s.kind === 'crypto' ? 'crypto' : s.kind === 'btcFund' ? 'btcFunds' : 'stocks';
}
