/**
 * Portfolio reader -- TWO separate tables on ONE sheet.
 *
 * Real structure, verified against myOptionsValueTracker.gs:63-104:
 *   - Options table: header row contains 'last trade Date' AND 'positions'
 *   - Stock table:   header row contains 'cost avg per stock' AND 'Ticker'
 *
 * Both are located by SCANNING for their header row, so rows inserted above
 * or between the tables do not break anything and column order is
 * irrelevant. Read in ONE API call: the whole sheet is fetched once and both
 * tables are found in memory.
 *
 * THE BLANK-ROW BUG, NOT REPRODUCED: the legacy options path stops at the
 * first blank ticker:
 *     if (!ticker) break;           // fullStockAnalysisV10_9.gs:10363
 *                                   // myOptionsValueTracker.gs:155
 * which silently truncates the table at the first spacer row. The stock path
 * was already fixed to a disclosed `continue` (:10305-10316).
 *
 * This is new code, so both tables behave correctly from the start: a blank
 * ticker with a real `type` hint is disclosed by name, a genuinely empty row
 * is counted, and the scan CONTINUES.
 */

import type { RunContext } from '../../core/context.ts';
import type { StepResult } from '../../core/result.ts';
import { ok, err, logDetail, reportSentence } from '../../core/result.ts';
import type { SheetsClient } from '../client.ts';
import { Tabs, a1 } from '../tabs.ts';
import { findHeaderRow, cell, toStringSafe, toUpperTicker, toNumber, toDate } from '../coerce.ts';
import type { SheetRow } from '../coerce.ts';
import { activeProfile } from '../../profile/active.ts';

/** Real header, verified 2026-09-08 and recorded at myOptionsValueTracker.gs:90-98. */
export const STOCK_REQUIRED = ['Ticker', 'cost avg per stock'] as const;
export const OPTIONS_REQUIRED = ['Ticker', 'positions', 'last trade Date', 'strike', 'PUT/CALL'] as const;

/**
 * The entry-date column. Note the spelling: "Purchase Data", not "Date".
 * That reads like a typo but IS the real header (fullStockAnalysisV10_9.gs:10138)
 * and must be matched exactly.
 */
/**
 * F-B7-4: the owner's options table now spells it "Purchase Date" (seen 2026-10-27), so the
 * entry date was read as missing. Either spelling is accepted; "Purchase Data" wins when both exist.
 * GENERIC_PLAN P2: the spellings come from profile `sheets.portfolio.headerAliases` (the entry naming a
 * "Purchase Date"/"Purchase Data" header; the first name wins); none = the template's "Purchase Date".
 */
export const PURCHASE_DATE_COLUMNS: readonly string[] = ((): readonly string[] => {
  const aliases = activeProfile().sheets.portfolio.headerAliases;
  const main = Object.keys(aliases).find((k) => [k, ...(aliases[k] ?? [])].some((n) => /^Purchase Dat[ae]$/.test(n)));
  return main ? [main, ...(aliases[main] ?? [])] : ['Purchase Date'];
})();
/** The first (winning) spelling: "Purchase Data" for the owner. */
export const PURCHASE_DATE_COLUMN: string = PURCHASE_DATE_COLUMNS[0] as string;

/**
 * Row 36 (owner decision 2026-10-31): the stock table has no purchase-date column, so a STOCK row with no usable
 * date is read as bought on this ASSUMED date ("bought over years and held long"). The holding is marked
 * `entryDateAssumed`, and every place that shows the stop basis says it is measured from an assumed date.
 * Options rows are unchanged: they have their own Purchase Date column.
 */
export const ASSUMED_STOCK_PURCHASE_DATE_ISO: string = activeProfile().sheets.portfolio.assumedPurchaseDate;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
/** '1 Jan 2020': the assumed date as the reports show it, derived from the one constant above. */
export const ASSUMED_STOCK_PURCHASE_DATE_LABEL = ((): string => {
  const [y, m, d] = ASSUMED_STOCK_PURCHASE_DATE_ISO.split('-').map(Number);
  return d + ' ' + MONTHS[(m as number) - 1] + ' ' + y;
})();
/** The plain basis sentence shown wherever an assumed-date stop is shown. */
export const ASSUMED_ENTRY_BASIS = 'measured from an assumed purchase date of ' + ASSUMED_STOCK_PURCHASE_DATE_LABEL + ' (no real date on file)';
/** A fresh Date for the assumed purchase date (UTC midnight, like the sheet's own dates read as days). */
export function assumedStockPurchaseDate(): Date { return new Date(ASSUMED_STOCK_PURCHASE_DATE_ISO + 'T00:00:00Z'); }

function purchaseDate(row: SheetRow | undefined, cols: Readonly<Record<string, number>>): Date | null {
  for (const name of PURCHASE_DATE_COLUMNS) {
    if (cols[name] !== undefined) return toDate(cell(row, cols, name));
  }
  return null;
}

/**
 * F-B7-3: the end of the open-options table. The owner keeps a "CLOSED positions" section (its own
 * label row and header row) below the open options. Legacy stopped at the first blank row, which
 * happened to keep that section out; this reader skips blank rows, so it must stop here instead,
 * or a sold option is reported as held.
 */
export function endsOpenOptions(ticker: string): boolean {
  const { exact, contains } = END_MARKERS;
  return exact.includes(ticker) || contains.some((c) => ticker.includes(c));
}
/** Profile `sheets.portfolio.endMarkers` (GENERIC_PLAN P2). Owner: exactly 'TICKER', or containing 'CLOSED'. */
const END_MARKERS = activeProfile().sheets.portfolio.endMarkers;

export const PORTFOLIO_RANGE = a1(Tabs.PORTFOLIO, 'A:Z');

export interface StockHolding {
  readonly ticker: string;
  readonly shares: number | null;
  readonly avgCost: number | null;
  readonly entryDate: Date | null;
  readonly rowNumber: number;
  /** Row 36: true when the row had no usable purchase date and entryDate is the assumed 2020-01-01. */
  readonly entryDateAssumed?: boolean;
}

export interface OptionHolding {
  readonly ticker: string;
  readonly contracts: number | null;
  readonly strike: number | null;
  readonly expiry: Date | null;
  readonly side: 'call' | 'put';
  readonly avgPremium: number | null;
  readonly entryDate: Date | null;
  readonly rowNumber: number;
  /** The row's "current market value" (all contracts, written by My Options); null when absent or "N/A". */
  readonly currentValue?: number | null;
}

export interface SkippedRow {
  readonly rowNumber: number;
  readonly ticker: string;
  readonly reason: string;
}

export interface PortfolioResult {
  readonly stocks: StockHolding[];
  readonly options: OptionHolding[];
  readonly skippedCrypto: string[];
  readonly skippedOther: SkippedRow[];
  readonly blankRowCount: number;
}

/** Pure parser, so every edge case below is unit-testable without the network. */
export function parsePortfolio(rows: SheetRow[]): PortfolioResult {
  const stocks: StockHolding[] = [];
  const options: OptionHolding[] = [];
  const skippedCrypto: string[] = [];
  const skippedOther: SkippedRow[] = [];
  let blankRowCount = 0;

  // ── Stock / crypto table ──────────────────────────────────────────────
  const stockHeader = findHeaderRow(rows, STOCK_REQUIRED);
  if (stockHeader) {
    const cols = stockHeader.columns;
    for (let r = stockHeader.rowIndex + 1; r < rows.length; r++) {
      const row = rows[r];
      const rowNumber = r + 1; // 1-based, as the user sees it
      const rawTicker = toStringSafe(cell(row, cols, 'Ticker'));
      const ticker = toUpperTicker(rawTicker);

      if (ticker === '') {
        // A blank Ticker with a real `type` value is a real row the user
        // meant something by -- name it. A genuinely empty spacer row is
        // just counted, to avoid one note per blank line on a large sheet.
        const typeHint = toStringSafe(cell(row, cols, 'type'));
        if (typeHint !== '') {
          skippedOther.push({ rowNumber, ticker: '', reason: `blank Ticker, type="${typeHint}"` });
        } else {
          blankRowCount++;
        }
        continue; // NOT break -- see the header comment
      }

      if (ticker.includes('*') || ticker.startsWith('TOTAL')) {
        skippedOther.push({ rowNumber, ticker: rawTicker, reason: '"*"/TOTAL marker, not a real position' });
        continue;
      }

      const type = toStringSafe(cell(row, cols, 'type')).toLowerCase();

      // F-B7-5: a market symbol never holds a space ("BTC stock" was fetched as "BTC STOCK" and failed).
      if (type === 'stock' && /\s/.test(ticker)) {
        skippedOther.push({ rowNumber, ticker: rawTicker, reason: 'the ticker has a space, so it is not a market symbol (check the Ticker cell)' });
        continue;
      }

      // Anything that is not explicitly stock or crypto is not a position.
      if (type !== 'stock' && type !== 'crypto') {
        skippedOther.push({ rowNumber, ticker, reason: `type="${type || '(blank)'}" — not a stock or crypto row` });
        continue;
      }

      // Crypto is skipped by design. Note this keys off the sheet's own
      // `type` column, never off what a ticker "looks like" -- so the spot
      // Bitcoin ETFs (GBTC, BTC, FBTC, BITB, IBIT), which are ordinary
      // exchange-traded securities typed `stock`, are analysed normally.
      if (type === 'crypto') {
        skippedCrypto.push(ticker);
        continue;
      }

      const realDate = purchaseDate(row, cols);
      const usable = realDate != null && !Number.isNaN(realDate.getTime());
      stocks.push({
        ticker,
        shares: toNumber(cell(row, cols, 'amount')),
        avgCost: toNumber(cell(row, cols, 'cost avg per stock')),
        entryDate: usable ? realDate : assumedStockPurchaseDate(),
        rowNumber,
        ...(usable ? {} : { entryDateAssumed: true }),
      });
    }
  }

  // ── Options table ─────────────────────────────────────────────────────
  const optHeader = findHeaderRow(rows, OPTIONS_REQUIRED);
  if (optHeader) {
    const cols = optHeader.columns;
    for (let r = optHeader.rowIndex + 1; r < rows.length; r++) {
      const row = rows[r];
      const rowNumber = r + 1;
      const ticker = toUpperTicker(cell(row, cols, 'Ticker'));

      if (ticker === '') {
        blankRowCount++;
        continue; // NOT break -- the legacy bug, deliberately not reproduced
      }
      if (ticker.includes('*') || ticker.startsWith('TOTAL')) {
        skippedOther.push({ rowNumber, ticker, reason: '"*"/TOTAL marker, not a real position' });
        continue;
      }
      if (endsOpenOptions(ticker)) {
        skippedOther.push({ rowNumber, ticker, reason: 'end of the open options; the rows below are closed positions' });
        break;
      }

      const sideRaw = toStringSafe(cell(row, cols, 'PUT/CALL')).toLowerCase();
      options.push({
        ticker,
        contracts: toNumber(cell(row, cols, 'positions')),
        strike: toNumber(cell(row, cols, 'strike')),
        expiry: toDate(cell(row, cols, 'last trade Date')),
        side: sideRaw === 'put' ? 'put' : 'call',
        avgPremium: toNumber(cell(row, cols, 'avg price - Premium paid')),
        entryDate: purchaseDate(row, cols),
        rowNumber,
        currentValue: toNumber(cell(row, cols, 'current market value')),
      });
    }
  }

  return { stocks, options, skippedCrypto, skippedOther, blankRowCount };
}

export async function readPortfolio(ctx: RunContext, sheets: SheetsClient): Promise<StepResult<PortfolioResult>> {
  const read = await sheets.batchGet(ctx, [PORTFOLIO_RANGE]);
  if (!read.ok) return read;

  const rows = read.value[0] ?? [];

  // A missing table is structural, not transient -- retrying cannot help.
  const stockHeader = findHeaderRow(rows, STOCK_REQUIRED);
  const optHeader = findHeaderRow(rows, OPTIONS_REQUIRED);
  if (!stockHeader && !optHeader) {
    const detail = logDetail(
      `neither table header found on "${Tabs.PORTFOLIO}"; expected a row containing ${STOCK_REQUIRED.join(' + ')} or ${OPTIONS_REQUIRED.join(' + ')}`,
    );
    ctx.log.error('Portfolio tables not found', { detail: String(detail) });
    return err({
      kind: 'permanent',
      detail,
      disclosure: reportSentence('The Portfolio sheet could not be read — its expected column headers were not found.'),
      attempts: 1,
    });
  }

  const result = parsePortfolio(rows);

  ctx.log.info(
    `Portfolio: ${result.stocks.length} stock holding(s), ${result.options.length} option position(s)`,
    {
      skippedCrypto: result.skippedCrypto.length,
      skippedOther: result.skippedOther.length,
      blankRows: result.blankRowCount,
    },
  );
  for (const s of result.skippedOther) {
    ctx.log.debug(`skipped row ${s.rowNumber}${s.ticker ? ` (${s.ticker})` : ''}: ${s.reason}`);
  }

  return ok(result);
}
