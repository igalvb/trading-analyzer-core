/**
 * Transactions and the FIFO portfolio summary of fullStockAnalysisV10_9.gs,
 * ported call-for-call onto ReportWorkbook (sheets/reportSheet.ts):
 *   TRANSACTIONS_SHEET_V7 :665, TRANSACTIONS_HEADERS_V7 :669,
 *   getOrCreateTransactionsSheetV7 :674-684, readTransactionsV7 :691-738,
 *   computeFifoGroupsV7_ :743-767, summarizeFifoGroupV7_ :769-781,
 *   findOptionsSnapshotContractV7_ :786-792, computePortfolioSummaryV7 :796-821,
 *   getHeldPositionsForTickerV7 :825-827
 *
 * Human-confirm-only (legacy 6.4.1): nothing here writes a transaction row;
 * only getOrCreateTransactionsSheet creates the empty, headed tab. The
 * workbook must have loaded the Transactions tab and '_OPTIONS_SNAPSHOT' at
 * open() (a tab that was not loaded reads as an error, as in the snapshot reader).
 *
 * Two deviations are opt-in or Sheets-specific, and the first is OFF by default:
 *  - `fromSerial` (F-B1): the Sheets API returns a date cell as a serial NUMBER
 *    (client.ts reads SERIAL_NUMBER), while Apps Script handed back a Date.
 *    Legacy `new Date(46000)` would read 1970. With `fromSerial` a numeric
 *    Date cell, and a numeric Expiry cell, are decoded first.
 *  - `sheetsParsedLabels` (F-B2, default true, like the snapshot reader): an
 *    expiry typed as "Aug 21, 2026" is rendered as the Date Sheets would have
 *    parsed it into. Pass false for the literal legacy behaviour.
 */

import type { ReportSheet, ReportWorkbook } from '../sheets/reportSheet.ts';
import type { TabCell } from '../storage/tabStore.ts';
import { fmtExpiry, readOptionsSnapshot } from '../reports/options/run.ts';

export const TRANSACTIONS_SHEET = '📒 Transactions';
export const TRANSACTIONS_HEADERS: readonly string[] = ['Date', 'Ticker', 'Asset Type', 'Action', 'Shares/Contracts', 'Price', 'Strike', 'Expiry', 'Notes'];

export interface ReadDeps {
  /** The script zone: the expiry label is printed in it. */
  readonly timeZone: string;
  readonly sheetsParsedLabels?: boolean;
  readonly fromSerial?: (serial: number) => Date;
}

export interface SummaryDeps extends ReadDeps {
  /** "Now" for the snapshot's age (legacy Date.now()). */
  readonly nowMs: number;
}

export interface Transaction {
  readonly date: Date;
  readonly dateStr: string;
  readonly ticker: string;
  readonly assetType: string;
  readonly action: string;
  readonly shares: number;
  readonly price: number;
  readonly strike: number | null;
  readonly expiry: string | null;
  readonly notes: TabCell;
  readonly rowNum: number;
}

export interface TransactionsRead {
  readonly transactions: Transaction[];
  readonly parseWarnings: string[];
}

export interface FifoLot {
  shares: number;
  readonly price: number;
  readonly date: string;
}

export interface FifoGroup {
  readonly ticker: string;
  readonly assetType: string;
  readonly strike: number | null;
  readonly expiry: string | null;
  readonly lots: FifoLot[];
  readonly warnings: string[];
}

export interface FifoSummary {
  readonly totalShares: number;
  readonly avgCost: number;
  readonly earliestLotDate: string;
}

export interface SnapshotMatch {
  readonly contract: Record<string, unknown>;
  readonly snapshotDate: string | undefined;
  readonly ageDays: number | null | undefined;
}

export interface StockPosition {
  readonly ticker: string;
  readonly assetType: 'STOCK';
  readonly shares: number;
  readonly avgCost: number;
  readonly earliestLotDate: string;
}

export interface OptionPosition {
  readonly ticker: string;
  readonly assetType: 'OPTION';
  readonly strike: number | null;
  readonly expiry: string | null;
  readonly contracts: number;
  readonly avgPremium: number;
  readonly earliestLotDate: string;
  readonly snapshot: SnapshotMatch | null;
}

export type Position = StockPosition | OptionPosition;

export interface PortfolioSummary {
  readonly positions: Position[];
  readonly warnings: string[];
}

/** getOrCreateTransactionsSheetV7 (:674-684): never touches existing rows. */
export function getOrCreateTransactionsSheet(ss: ReportWorkbook): ReportSheet {
  let sh = ss.getSheetByName(TRANSACTIONS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(TRANSACTIONS_SHEET);
    sh.getRange(1, 1, 1, TRANSACTIONS_HEADERS.length).setValues([TRANSACTIONS_HEADERS]).setFontWeight('bold').setBackground('#37474f').setFontColor('#fff');
    sh.setColumnWidths(1, TRANSACTIONS_HEADERS.length, 110);
    sh.setColumnWidth(9, 250);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** readTransactionsV7 (:691-738): malformed rows are skipped and reported, not dropped silently. */
export function readTransactions(ss: ReportWorkbook, deps: ReadDeps): TransactionsRead {
  const sh = ss.getSheetByName(TRANSACTIONS_SHEET);
  if (!sh) return { transactions: [], parseWarnings: [] };
  const data = sh.getDataRange().getValues();
  const transactions: Transaction[] = [], parseWarnings: string[] = [];
  const parsed = deps.sheetsParsedLabels ?? true;
  for (let r = 1; r < data.length; r++) {
    const row = data[r], rowNum = r + 1;
    const isBlank = row.every((c) => c === '' || c == null);
    if (isBlank) continue;
    const rawDate = row[0];
    const date = rawDate instanceof Date ? rawDate
      : (typeof rawDate === 'number' && deps.fromSerial) ? deps.fromSerial(rawDate) : new Date(rawDate as string | number);
    const ticker = String(row[1] || '').toUpperCase().trim();
    const assetType = String(row[2] || 'STOCK').toUpperCase().trim();
    const action = String(row[3] || '').toUpperCase().trim();
    const shares = parseFloat(String(row[4]));
    const price = parseFloat(String(row[5]));
    const strike = (row[6] !== '' && row[6] != null) ? parseFloat(String(row[6])) : null;
    // P0-2 (legacy): the expiry is canonicalised through fmtExpiryV7_ so a BUY typed as
    // text and a SELL that Sheets turned into a Date share one key.
    const rawExpiry = row[7];
    const expiry = (rawExpiry !== '' && rawExpiry != null)
      ? fmtExpiry((typeof rawExpiry === 'number' && deps.fromSerial) ? deps.fromSerial(rawExpiry) : rawExpiry, deps.timeZone, parsed) : null;
    const notes = row[8] || '';

    const problems: string[] = [];
    if (isNaN(date.getTime())) problems.push('Date is not a valid date (got "' + rawDate + '")');
    if (!ticker) problems.push('Ticker is empty');
    if (assetType !== 'STOCK' && assetType !== 'OPTION') problems.push('Asset Type must be STOCK or OPTION (got "' + row[2] + '")');
    if (action !== 'BUY' && action !== 'SELL') problems.push('Action must be BUY or SELL (got "' + row[3] + '")');
    if (isNaN(shares) || shares <= 0) problems.push('Shares/Contracts must be a positive number (got "' + row[4] + '")');
    if (isNaN(price) || price < 0) problems.push('Price must be a non-negative number (got "' + row[5] + '")');
    if (assetType === 'OPTION' && (strike == null || isNaN(strike))) problems.push('OPTION rows need a numeric Strike');
    if (assetType === 'OPTION' && !expiry) problems.push('OPTION rows need an Expiry');

    if (problems.length) {
      parseWarnings.push('Row ' + rowNum + ' (' + (ticker || '?') + '): ' + problems.join('; ') + ' — this row is EXCLUDED from the portfolio summary until fixed.');
      continue;
    }
    transactions.push({ date, dateStr: date.toISOString().slice(0, 10), ticker, assetType, action, shares, price, strike, expiry, notes, rowNum });
  }
  return { transactions, parseWarnings };
}

/** computeFifoGroupsV7_ (:743-767): groupKeyFn decides what counts as "the same position". */
export function computeFifoGroups(transactions: readonly Transaction[], groupKeyFn: (tx: Transaction) => string): Record<string, FifoGroup> {
  const groups: Record<string, FifoGroup> = {};
  const sorted = transactions.slice().sort((a, b) => a.date.getTime() - b.date.getTime());
  sorted.forEach((tx) => {
    const key = groupKeyFn(tx);
    if (!groups[key]) groups[key] = { ticker: tx.ticker, assetType: tx.assetType, strike: tx.strike, expiry: tx.expiry, lots: [], warnings: [] };
    const g = groups[key];
    if (tx.action === 'BUY') {
      g.lots.push({ shares: tx.shares, price: tx.price, date: tx.dateStr });
    } else { // SELL
      let remaining = tx.shares;
      while (remaining > 1e-6 && g.lots.length > 0) {
        const lot = g.lots[0];
        const consumed = Math.min(lot.shares, remaining);
        lot.shares -= consumed;
        remaining -= consumed;
        if (lot.shares <= 1e-6) g.lots.shift();
      }
      if (remaining > 1e-6) {
        g.warnings.push('SELL of ' + tx.shares + ' on ' + tx.dateStr + ' exceeds the ' + (tx.shares - remaining).toFixed(4) + ' shares/contracts available at that point (short by ' + remaining.toFixed(4) + ') — check ' + TRANSACTIONS_SHEET + ' row ' + tx.rowNum + '.');
      }
    }
  });
  return groups;
}

/** summarizeFifoGroupV7_ (:769-781): null for a fully closed position. */
export function summarizeFifoGroup(g: FifoGroup): FifoSummary | null {
  const totalShares = g.lots.reduce((s, l) => s + l.shares, 0);
  if (totalShares <= 1e-6) return null;
  const totalCost = g.lots.reduce((s, l) => s + l.shares * l.price, 0);
  return { totalShares, avgCost: totalCost / totalShares, earliestLotDate: g.lots[0].date };
}

/** findOptionsSnapshotContractV7_ (:786-792). The `typeof readOptionsSnapshotV7` guard is always true once ported. */
export function findOptionsSnapshotContract(ss: ReportWorkbook, ticker: string, strike: number | null, expiry: string | null, deps: SummaryDeps): SnapshotMatch | null {
  const snap = readOptionsSnapshot(ss, ticker, deps.nowMs, deps.timeZone);
  if (!snap || snap.mismatch || !snap.contracts) return null;
  const match = snap.contracts.find((c) => Math.abs(((c.strike as number) || 0) - (strike as number)) < 0.01 && fmtExpiry(c.expiryStr, deps.timeZone, false) === expiry);
  if (!match) return null;
  return { contract: match as Record<string, unknown>, snapshotDate: snap.timestamp, ageDays: snap.ageDays };
}

/** computePortfolioSummaryV7 (:796-821): every open STOCK and OPTION position, parse and over-sell warnings. */
export function computePortfolioSummary(ss: ReportWorkbook, deps: SummaryDeps): PortfolioSummary {
  const { transactions, parseWarnings } = readTransactions(ss, deps);
  const stockTx = transactions.filter((t) => t.assetType === 'STOCK');
  const optionTx = transactions.filter((t) => t.assetType === 'OPTION');

  const stockGroups = computeFifoGroups(stockTx, (tx) => tx.ticker);
  const optionGroups = computeFifoGroups(optionTx, (tx) => tx.ticker + '|' + tx.strike + '|' + tx.expiry);

  const positions: Position[] = [], warnings = parseWarnings.slice();
  Object.keys(stockGroups).forEach((key) => {
    const g = stockGroups[key];
    warnings.push(...g.warnings);
    const s = summarizeFifoGroup(g);
    if (s) positions.push({ ticker: g.ticker, assetType: 'STOCK', shares: s.totalShares, avgCost: s.avgCost, earliestLotDate: s.earliestLotDate });
  });
  Object.keys(optionGroups).forEach((key) => {
    const g = optionGroups[key];
    warnings.push(...g.warnings);
    const s = summarizeFifoGroup(g);
    if (s) {
      const snap = findOptionsSnapshotContract(ss, g.ticker, g.strike, g.expiry, deps);
      positions.push({ ticker: g.ticker, assetType: 'OPTION', strike: g.strike, expiry: g.expiry, contracts: s.totalShares, avgPremium: s.avgCost, earliestLotDate: s.earliestLotDate, snapshot: snap });
    }
  });
  return { positions, warnings };
}

/** getHeldPositionsForTickerV7 (:825-827): read-only, never writes. */
export function getHeldPositionsForTicker(portfolioResult: { readonly positions?: readonly Position[] }, ticker: string): Position[] {
  return (portfolioResult.positions || []).filter((p) => p.ticker === ticker.toUpperCase());
}
