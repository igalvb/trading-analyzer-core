/**
 * Ledger migration, phase 1 (docs/LEDGER.md): the Portfolio tab grid (+ the Watchlist grid) -> LedgerHoldings,
 * LedgerAssets and LedgerWatchlist (ledger/schema.ts). PURE: the grids come in, the files' contents come out, with
 * the sheet's own totals (for the reconciliation, ledger/reconcile.ts) and a "needs owner check" list of every row it
 * could not map with certainty. Nothing is guessed silently: an uncertain value is kept as raw text in `note` and
 * listed.
 *
 *   stock table      parsed by sheets/readers/portfolio.ts parsePortfolio (the SAME rows the runs hold today), plus the
 *                    crypto rows it skips (kind 'crypto', the sheet's price as manualPrice) and the spot bitcoin ETFs
 *                    (types/bitcoinEtfs.ts) as kind 'btcFund'. Rows marked with '*' (left out by the runs and by the
 *                    sheet's totals) are not migrated; each is listed for the owner.
 *   options          the OPEN section, as parsePortfolio reads it (the runs' option positions).
 *   CLOSED section   one LedgerClosed per row; 'Sell Price' per share or per contract by the rule of
 *                    dashboard/data.ts parseClosed (10x or more above the per-share premium = the contract's total).
 *   above the table  the totals, the sub-type block and the pension / savings / property block, found by the words of
 *                    ledger/layout.ts (the user's own language). Currency: USD for the stock table, ILS for that block.
 *
 * Ids are stable across runs of the migration: kind + ticker (+ strike + expiry), or group + a slug of the name as
 * written (any script kept), with -2, -3... for repeats in sheet order.
 */

import { cell, findHeaderRow, toDate, toNumber, toStringSafe, toUpperTicker, type SheetRow } from '../sheets/coerce.ts';
import { parsePortfolio, STOCK_REQUIRED, PURCHASE_DATE_COLUMNS } from '../sheets/readers/portfolio.ts';
import { parseWatchlistRows } from '../sheets/readers/watchlist.ts';
import { BITCOIN_ETF_TICKERS } from '../types/bitcoinEtfs.ts';
import { LEDGER_SCHEMA, type LedgerTarget, type LedgerTargets, type LedgerAsset, type LedgerAssets, type LedgerClosed, type LedgerHoldings, type LedgerOption, type LedgerStock, type LedgerWatchlist } from './schema.ts';
import { DEFAULT_LEDGER_LAYOUT, TOTAL_KEYS, type SheetLayout, type TotalKey } from './layout.ts';

export interface OwnerCheck {
  /** 'Portfolio!A70' */
  readonly where: string;
  readonly item: string;
  readonly why: string;
  /** The row's cells as written (for the owner to recognise it). */
  readonly raw: string;
}

/** Where a crypto price comes from today (owner 2026-11-06: Apps Script time triggers fill these; a later job replaces them). */
export interface CryptoPriceCell {
  readonly id: string;
  readonly ticker: string;
  /** The price cell of the row, e.g. 'Portfolio!E63'. */
  readonly cell: string;
  /** The cell or function the price formula reads, e.g. 'Portfolio!J2' or 'GOOGLEFINANCE("BTCUSD")'; null = typed. */
  readonly source: string | null;
  readonly formula: string | null;
  readonly price: number | null;
  /** The coin symbol the sheet's script fetches into `source` (layout.cryptoApiCells), when known. */
  readonly apiSymbol: string | null;
}

export type SheetTotals = Readonly<Record<TotalKey, number | null>> & {
  /** The sub-type block's options row (open calls, USD). */
  readonly optionsUsd: number | null;
  /** The sub-type block's other rows summed: the stock table (stocks + bitcoin funds + crypto), USD. */
  readonly stockTableUsd: number | null;
};

export interface FromSheetInput {
  readonly portfolio: readonly SheetRow[];
  readonly watchlist: readonly SheetRow[];
  /** 'YYYY-MM-DD': `updated` of every file, and `asOf` when the sheet gives none. */
  readonly today: string;
  readonly layout?: SheetLayout;
  /** The same grid read as formulas (valueRenderOption FORMULA), for the crypto price sources; optional. */
  readonly formulas?: readonly SheetRow[] | null;
  /** The tab's name in the `where` addresses (default 'Portfolio'). */
  readonly tab?: string;
}

export interface FromSheetResult {
  readonly holdings: LedgerHoldings;
  readonly assets: LedgerAssets;
  readonly watchlist: LedgerWatchlist;
  readonly needsOwnerCheck: readonly OwnerCheck[];
  readonly totals: SheetTotals;
  /** The sheet's own price per unit of each stock-table holding (by id), for the reconciliation. */
  readonly sheetPrice: Readonly<Record<string, number | null>>;
  readonly cryptoPriceCells: readonly CryptoPriceCell[];
  /** Cells the sheet's crypto script fills that no holding row reads (cell -> symbol). */
  readonly unusedCryptoApiCells: Readonly<Record<string, string>>;
  /** ledger/targets.json: the values the owner typed under the layout's target labels. */
  readonly targets: LedgerTargets;
  /**
   * The sheet's separate debt line and where the migration put it, for the reconciliation: `attachedTo` = the property
   * whose mortgage it became (and `added`, the text appended to that property's note), else `cashItem` = the negative
   * cash item made for it; `cellNote` = the note written next to the amount. (added / cashItem / cellNote: additive.)
   */
  readonly sheetDebt: { readonly amount: number; readonly attachedTo: string | null; readonly added?: string; readonly cashItem?: string; readonly cellNote?: string } | null;
}

// ── small helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

/** 0-based column -> 'A', 'B', ... 'AA'. */
export function columnName(i: number): string {
  let s = '', n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
const trim = (v: unknown): string => toStringSafe(v as SheetRow[number]).trim();
const num = (v: unknown): number | null => toNumber(v as SheetRow[number]);
/**
 * The calendar day of a Date read from a sheet cell: sheets/coerce.ts toDate gives UTC midnight for a serial number or
 * an ISO / M/D/YYYY text, and LOCAL midnight for other text ("JUN17'27"). A Date at local midnight is that local day;
 * any other is its UTC day -- right in every time zone, not only New York's.
 */
export function calendarDay(d: Date | null | undefined): string | null {
  if (!d || Number.isNaN(d.getTime())) return null;
  const local = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
  const p = (n: number): string => String(n).padStart(2, '0');
  return local ? d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) : d.toISOString().slice(0, 10);
}
/** A date cell as 'YYYY-MM-DD' (like dashboard/data.ts dayOf); null when it is not a date. */
export function dayOf(v: unknown): string | null {
  if (v === '' || v == null) return null;
  if (typeof v === 'number' && (v < 20_000 || v > 80_000)) return null;
  return calendarDay(toDate(v as SheetRow[number]));
}
const iso = calendarDay;
const rawRow = (row: SheetRow | undefined): string => (row ?? []).map((c) => trim(c)).filter((c) => c !== '').join(' | ');
/** A slug that keeps every script's letters (Hebrew names stay readable): lower case, runs of other characters -> '-'. */
export function slug(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}.]+/gu, '-').replace(/^-+|-+$/g, '') || 'item';
}
/** Unique ids in order: the second 'stock:abc' becomes 'stock:abc-2'. */
function idMaker(): (base: string) => string {
  const seen = new Map<string, number>();
  return (base) => { const n = (seen.get(base) ?? 0) + 1; seen.set(base, n); return n === 1 ? base : base + '-' + n; };
}
const r2 = (x: number): number => Math.round(x * 100) / 100;

/** First header cell (trimmed) that contains `word` (lower case), as a column index. */
function columnContaining(cols: Readonly<Record<string, number>>, word: string): number | null {
  for (const [h, i] of Object.entries(cols)) if (h.toLowerCase().includes(word)) return i;
  return null;
}

// ── the totals above the tables ───────────────────────────────────────────────────────────────────────────────────

function findCell(rows: readonly SheetRow[], label: string): { r: number; c: number } | null {
  return findCells(rows, label)[0] ?? null;
}
function findCells(rows: readonly SheetRow[], label: string): Array<{ r: number; c: number }> {
  const want = label.trim(), out: Array<{ r: number; c: number }> = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] ?? [];
    for (let c = 0; c < row.length; c++) if (trim(row[c]) === want) out.push({ r, c });
  }
  return out;
}
/** The number a label points at: the first place the label appears with a number where `at` says (a label can repeat). */
function labelled(rows: readonly SheetRow[], t: { readonly label: string; readonly at: 'below' | 'left' | 'right' }): { value: number | null; r: number; c: number } | null {
  for (const at of findCells(rows, t.label)) {
    const r = t.at === 'below' ? at.r + 1 : at.r, c = t.at === 'left' ? at.c - 1 : t.at === 'right' ? at.c + 1 : at.c;
    const value = c >= 0 ? num(rows[r]?.[c]) : null;
    if (value != null) return { value, r, c };
  }
  return null;
}

function readTotals(rows: readonly SheetRow[], layout: SheetLayout): SheetTotals {
  const out: Record<string, number | null> = {};
  for (const k of TOTAL_KEYS) {
    const t = layout.totals[k];
    out[k] = t ? labelled(rows, t)?.value ?? null : null;
  }
  let optionsUsd: number | null = null, stockTableUsd: number | null = null;
  const st = layout.subTypes;
  const head = st ? findHeaderRow(rows as SheetRow[], st.header) : null;
  if (st && head) {
    const lc = head.columns[st.header[0]] as number, vc = head.columns[st.header[1]] as number;
    for (let r = head.rowIndex + 1; r < rows.length; r++) {
      const label = trim(rows[r]?.[lc]);
      if (label === '') break;
      const v = num(rows[r]?.[vc]);
      if (label === st.optionsLabel) optionsUsd = v;
      else if (v != null) stockTableUsd = (stockTableUsd ?? 0) + v;
    }
  }
  return { ...(out as Record<TotalKey, number | null>), optionsUsd, stockTableUsd: stockTableUsd == null ? null : r2(stockTableUsd) };
}

// ── property notes ────────────────────────────────────────────────────────────────────────────────────────────────

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A number in a note with its unit: "3.3 million" -> 3_300_000; unit null when none was written. */
function amountsIn(note: string, layout: SheetLayout): Array<{ readonly at: number; readonly end: number; readonly n: number; readonly unit: number | null }> {
  const units = [...layout.notes.million.map((w) => [w, 1e6] as const), ...layout.notes.thousand.map((w) => [w, 1e3] as const)].sort((a, b) => b[0].length - a[0].length);
  const unitRe = units.map(([w]) => escapeRe(w)).join('|');
  const re = new RegExp('(\\d+(?:[.,]\\d+)?)(?:\\s*(' + (unitRe || '(?!)') + ')(?![\\p{L}]))?', 'giu');
  const out: Array<{ at: number; end: number; n: number; unit: number | null }> = [];
  for (const m of note.matchAll(re)) {
    const u = m[2] ? units.find(([w]) => w.toLowerCase() === (m[2] as string).toLowerCase())?.[1] ?? null : null;
    out.push({ at: m.index ?? 0, end: (m.index ?? 0) + m[0].length, n: Number((m[1] as string).replace(',', '.')), unit: u });
  }
  return out;
}

export interface PropertyNote {
  readonly value: number | null;
  readonly debt: number | null;
  /** The note gives a range ("2.6-3.0"): not a value the migration may pick. */
  readonly range: boolean;
}

/** "value 3.3 million but 1.3 mortgage" -> value 3_300_000, debt 1_300_000 (a debt without a unit takes the value's). */
export function parsePropertyNote(note: string, layout: SheetLayout = DEFAULT_LEDGER_LAYOUT): PropertyNote {
  const text = note.trim();
  const range = /\d(?:[.,]\d+)?\s*[-–]\s*\d/.test(text);
  const amounts = amountsIn(text, layout);
  const lower = text.toLowerCase();
  const wordAt = (words: readonly string[]): number[] => words.flatMap((w) => { const out: number[] = []; let i = lower.indexOf(w.toLowerCase()); while (i >= 0) { out.push(i); i = lower.indexOf(w.toLowerCase(), i + 1); } return out; });
  const valueWords = wordAt(layout.notes.value), debtWords = wordAt(layout.notes.debt);
  const valueAmt = valueWords.length ? amounts.find((a) => a.at > (valueWords[0] as number)) ?? null : null;
  // A debt amount sits right before or right after its word ("1.3 mortgage" / "mortgage 1.3").
  let debtAmt: (typeof amounts)[number] | null = null;
  for (const w of debtWords) {
    const before = [...amounts].reverse().find((a) => a.end <= w && w - a.end <= 3 && a !== valueAmt);
    const after = amounts.find((a) => a.at >= w && a.at - w <= 12 && a !== valueAmt);
    debtAmt = before ?? after ?? null;
    if (debtAmt) break;
  }
  const unit = valueAmt?.unit ?? null;
  const money = (a: (typeof amounts)[number] | null): number | null => (a ? Math.round(a.n * (a.unit ?? unit ?? 1)) : null);
  return { value: money(valueAmt), debt: money(debtAmt), range };
}

// ── the conversion ────────────────────────────────────────────────────────────────────────────────────────────────

export function fromSheet(input: FromSheetInput): FromSheetResult {
  const layout = input.layout ?? DEFAULT_LEDGER_LAYOUT;
  const tab = input.tab ?? 'Portfolio';
  const rows = input.portfolio as SheetRow[];
  const where = (r: number, c: number): string => tab + '!' + columnName(c) + (r + 1);
  const checks: OwnerCheck[] = [];
  const check = (r: number, c: number, item: string, why: string): void => { checks.push({ where: where(r, c), item, why, raw: rawRow(rows[r]) }); };
  const sheetPrice: Record<string, number | null> = {};
  const cryptoPriceCells: CryptoPriceCell[] = [];

  // Stocks and crypto: the runs' own parse decides which rows are holdings.
  const parsed = parsePortfolio(rows);
  const held = new Map(parsed.stocks.map((s) => [s.rowNumber, s]));
  const stocks: LedgerStock[] = [];
  const stockId = idMaker();
  const head = findHeaderRow(rows, STOCK_REQUIRED);
  if (head) {
    const cols = head.columns;
    const priceCol = cols['price per item'] ?? columnContaining(cols, 'price');
    const valueCol = cols['value of inverstment'] ?? cols['value of investment'] ?? columnContaining(cols, 'value');
    const noteCol = columnContaining(cols, 'comment');
    const subCol = cols['sub-type'] ?? cols['subtype'] ?? null;
    const tickerCol = cols['Ticker'] as number;
    const freeCoins: string[] = [];
    for (let r = head.rowIndex + 1; r < rows.length; r++) {
      const row = rows[r] ?? [];
      const ticker = toUpperTicker(cell(row, cols, 'Ticker'));
      if (ticker === '') continue;
      const type = trim(cell(row, cols, 'type')).toLowerCase();
      const qty = num(cell(row, cols, 'amount'));
      const avg = num(cell(row, cols, 'cost avg per stock'));
      const price = priceCol != null ? num(row[priceCol]) : null;
      const note = noteCol != null ? trim(row[noteCol]) : '';
      const subText = subCol != null ? trim(row[subCol]).slice(0, 40) : '';
      const sub = subText ? { subType: subText } : {};
      const h = held.get(r + 1);
      if (h) {
        const kind = BITCOIN_ETF_TICKERS.includes(ticker) ? 'btcFund' : 'stock';
        const id = stockId(kind + ':' + slug(ticker));
        if (h.shares == null) check(r, tickerCol, ticker, 'no amount: migrated with quantity 0');
        stocks.push({ id, ticker, kind, qty: h.shares ?? 0, avgCost: h.avgCost, currency: 'USD', bought: h.entryDateAssumed ? null : iso(h.entryDate), ...(note ? { note } : {}), ...sub });
        sheetPrice[id] = price ?? (valueCol != null && qty ? (num(row[valueCol]) ?? 0) / qty : null);
        continue;
      }
      const marked = ticker.includes('*') || ticker.startsWith('TOTAL');
      if (type === 'crypto' && !marked) {
        const id = stockId('crypto:' + slug(ticker));
        if (qty == null) check(r, tickerCol, ticker, 'no amount: migrated with quantity 0');
        if (price == null) check(r, priceCol ?? tickerCol, ticker, 'no price in the sheet: manualPrice left empty');
        if (avg === 0) freeCoins.push(ticker);
        const pc = priceCol ?? tickerCol;
        const formula = input.formulas ? trim(input.formulas[r]?.[pc]) : '';
        const source = formula.startsWith('=') ? formulaSource(formula, tab) : null;
        const apiCell = source && source.startsWith(tab + '!') ? source.slice(tab.length + 1) : null;
        const apiSymbol = apiCell ? layout.cryptoApiCells[apiCell] ?? null : null;
        // The symbol the sheet's script fetched, kept when it is not simply the ticker (ledger/cryptoPrices.ts).
        const priceSymbol = apiSymbol && apiSymbol !== ticker.replace(/\.+$/, '') ? { priceSymbol: apiSymbol } : {};
        stocks.push({ id, ticker, kind: 'crypto', qty: qty ?? 0, avgCost: avg, currency: 'USD', bought: null, manualPrice: price, ...(note ? { note } : {}), ...sub, ...priceSymbol });
        sheetPrice[id] = price;
        cryptoPriceCells.push({ id, ticker, cell: where(r, pc), source, formula: formula.startsWith('=') ? formula : null, price, apiSymbol });
        continue;
      }
      // Anything else that holds a quantity is a position the runs (and the sheet's totals) leave out: the owner decides.
      if (!ticker.startsWith('TOTAL') && qty != null && qty !== 0) {
        check(r, tickerCol, ticker + ' x ' + qty + (avg != null ? ' at ' + avg : ''),
          (ticker.includes('*') ? "marked with '*': the runs and the sheet's totals leave it out" : 'type "' + (type || '(blank)') + '": not a stock or crypto row')
          + '; NOT migrated' + (note ? ' (comment: "' + note + '")' : '') + '. Say if it is a real holding.');
      }
    }
    if (freeCoins.length) {
      checks.push({ where: tab + '!' + columnName(cols['cost avg per stock'] as number) + ' (stock table)', item: freeCoins.join(', '), why: 'average cost 0 (free coins, or not known?): migrated as 0', raw: '' });
    }
  }

  // Open options, as the runs read them.
  const options: LedgerOption[] = [];
  const optId = idMaker();
  for (const o of parsed.options) {
    const expiry = iso(o.expiry);
    if (!expiry) check(o.rowNumber - 1, 0, o.ticker, 'the expiry is not a date: migrated with no expiry');
    if (o.strike == null) check(o.rowNumber - 1, 0, o.ticker, 'no strike: migrated with strike 0');
    const id = optId(o.side + ':' + slug(o.ticker) + ':' + (o.strike ?? 0) + ':' + (expiry ?? 'none'));
    options.push({ id, ticker: o.ticker, side: o.side, contracts: o.contracts ?? 0, strike: o.strike ?? 0, expiry: expiry ?? '', avgPremium: o.avgPremium, bought: iso(o.entryDate), currentValue: o.currentValue ?? null });
  }

  const closed = readClosed(rows, check);
  const { items: assets, sheetDebt } = readAssets(rows, input.today, layout, check, checks, tab);
  const totals = readTotals(rows, layout);
  const read = new Set(cryptoPriceCells.map((c) => c.source));
  const unusedCryptoApiCells = Object.fromEntries(Object.entries(layout.cryptoApiCells).filter(([c]) => !read.has(tab + '!' + c)));
  const targets: LedgerTarget[] = [];
  const targetId = idMaker();
  for (const t of layout.targets) {
    const at = findCell(rows, t.label);
    if (!at) { checks.push({ where: tab, item: t.label, why: 'target label not found: nothing migrated for it', raw: '' }); continue; }
    t.names.forEach((name, k) => {
      const v = num(rows[at.r + 1 + k]?.[at.c]);
      if (v == null) { check(at.r + 1 + k, at.c, name, 'no number under the label "' + t.label + '": not migrated'); return; }
      targets.push({ id: targetId('target:' + slug(name)), name, value: v, note: 'typed under "' + t.label + '" (' + where(at.r + 1 + k, at.c) + ')' });
    });
  }

  return {
    holdings: { schema: LEDGER_SCHEMA, updated: input.today, stocks, options, closed },
    assets: { schema: LEDGER_SCHEMA, updated: input.today, items: assets },
    watchlist: { schema: LEDGER_SCHEMA, updated: input.today, tickers: parseWatchlistRows(input.watchlist as SheetRow[]) },
    needsOwnerCheck: checks, totals, sheetPrice, cryptoPriceCells, unusedCryptoApiCells,
    targets: { schema: LEDGER_SCHEMA, updated: input.today, items: targets }, sheetDebt,
  };
}

/** '=IFERROR(Portfolio!J2, 0)' -> 'Portfolio!J2'; '=IFERROR(GoogleFinance("BTCUSD"), 0)' -> 'GOOGLEFINANCE("BTCUSD")'. */
export function formulaSource(formula: string, tab: string): string {
  const fn = /GOOGLEFINANCE\s*\(([^)]*)\)/i.exec(formula);
  if (fn) return 'GOOGLEFINANCE(' + (fn[1] as string).trim() + ')';
  const ref = /(?:('?[^'!(),=]+'?)!)?\$?([A-Z]{1,3})\$?(\d+)/.exec(formula.replace(/^=\s*IFERROR\s*\(/i, ''));
  if (ref) return (ref[1] ? ref[1].replace(/^'|'$/g, '') : tab) + '!' + ref[2] + ref[3];
  return formula;
}

/** dashboard/data.ts parseClosed's rule: a Sell Price 10x or more above the per-share premium is the contract's total. */
export function closedProceeds(qty: number | null, sell: number | null, premium: number | null, option: boolean): number | null {
  if (qty == null || sell == null) return null;
  if (!option) return qty * sell;
  const perContract = premium != null && premium > 0 && sell >= premium * 10;
  return qty * sell * (perContract ? 1 : 100);
}

function readClosed(rows: SheetRow[], check: (r: number, c: number, item: string, why: string) => void): LedgerClosed[] {
  const head = findHeaderRow(rows, ['Ticker', 'Sell Price']);
  if (!head) return [];
  const cols = head.columns, out: LedgerClosed[] = [], id = idMaker();
  for (let r = head.rowIndex + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const ticker = toUpperTicker(cell(row, cols, 'Ticker'));
    if (!ticker || ticker.includes('*') || ticker.startsWith('TOTAL') || ticker === 'TICKER') continue;
    const qty = num(cell(row, cols, 'positions') ?? cell(row, cols, 'amount')), sell = num(cell(row, cols, 'Sell Price'));
    if (qty == null && sell == null) continue;
    const type = trim(cell(row, cols, 'type')).toLowerCase();
    const strike = num(cell(row, cols, 'strike'));
    const option = /option|call|put/.test(type) || strike != null;
    const side = trim(cell(row, cols, 'PUT/CALL')).toLowerCase() === 'put' ? 'put' : 'call';
    const kind: LedgerClosed['kind'] = option ? side : type === 'crypto' ? 'crypto' : BITCOIN_ETF_TICKERS.includes(ticker) ? 'btcFund' : 'stock';
    const premium = num(cell(row, cols, 'avg price - Premium paid'));
    const basis = cols['cost basis'] !== undefined ? num(cell(row, cols, 'cost basis')) : null;
    const cost = basis ?? (qty != null && premium != null ? qty * premium * (option ? 100 : 1) : null);
    const expiry = dayOf(cell(row, cols, 'last trade Date'));
    const soldCell = cell(row, cols, 'Sell Date');
    const sold = dayOf(soldCell);
    let bought: string | null = null;
    for (const name of [...PURCHASE_DATE_COLUMNS, 'Purchase Date', 'Purchase Data']) if (cols[name] !== undefined) { bought = dayOf(cell(row, cols, name)); break; }
    const sc = cols['Sell Date'] as number;
    if (typeof soldCell === 'string' && soldCell.trim() !== '' && !/^\d{4}-\d{2}-\d{2}/.test(soldCell.trim())) {
      check(r, sc, ticker, 'the sell date is text ("' + soldCell.trim() + '"), read as ' + (sold ?? 'no date') + ' (month/day/year): check the day');
    }
    if (option && premium != null && sell != null) {
      const perContract = premium > 0 && sell >= premium * 10;
      if (perContract) check(r, cols['Sell Price'] as number, ticker, 'Sell Price ' + sell + ' read as the total for the contract(s) (it is 10x or more the premium ' + premium + ')');
    }
    out.push({
      id: id('closed:' + kind + ':' + slug(ticker) + (option ? ':' + (strike ?? 0) + ':' + (expiry ?? 'none') : '') + ':' + (sold ?? 'none')),
      ticker, kind, qty: qty ?? 0, ...(option ? { strike, expiry } : {}), cost: cost == null ? null : r2(cost),
      proceeds: (() => { const p = closedProceeds(qty, sell, premium, option); return p == null ? null : r2(p); })(), currency: 'USD', bought, sold,
    });
  }
  return out;
}

const groupOf = (type: string, layout: SheetLayout): LedgerAsset['group'] | null => {
  const t = type.toLowerCase();
  for (const g of ['realEstate', 'pension', 'funds', 'cash'] as const) if (layout.groups[g].some((w) => t.includes(w.toLowerCase()))) return g;
  return null;
};

/** 'as of 1.3.2024' (day first) -> '2024-03-01'. */
export function dayFirstDate(text: string): string | null {
  const m = /(\d{1,2})[./](\d{1,2})[./](\d{4})/.exec(text);
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]), y = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function readAssets(rows: SheetRow[], today: string, layout: SheetLayout, check: (r: number, c: number, item: string, why: string) => void, checks: OwnerCheck[], tab: string): { items: LedgerAsset[]; sheetDebt: FromSheetResult['sheetDebt'] } {
  const out: LedgerAsset[] = [];
  let sheetDebt: FromSheetResult['sheetDebt'] = null;
  const id = idMaker();
  const f = layout.funds;
  const head = f ? findHeaderRow(rows, [f.track, f.provider, f.type, f.amount]) : null;
  if (f && head) {
    const c = { track: head.columns[f.track] as number, provider: head.columns[f.provider] as number, type: head.columns[f.type] as number, amount: head.columns[f.amount] as number };
    const holderCol = trim(rows[head.rowIndex]?.[c.amount + 1]) === '' ? c.amount + 1 : null;
    // The block's "as of" date: a day-first date in the rows just above the header.
    let asOf: string | null = null;
    for (let r = head.rowIndex - 1; r >= Math.max(0, head.rowIndex - 3) && !asOf; r--) for (const v of rows[r] ?? []) { asOf ??= dayFirstDate(trim(v)); }
    if (!asOf) checks.push({ where: tab + '!' + columnName(c.track) + (head.rowIndex + 1), item: 'pension / savings / property block', why: 'no "as of" date above the block: the values are dated today (' + today + ')', raw: '' });
    const date = asOf ?? today;
    const stockHead = findHeaderRow(rows, STOCK_REQUIRED);
    for (let r = head.rowIndex + 1; r < rows.length; r++) {
      if (stockHead && r >= stockHead.rowIndex) break;
      const row = rows[r] ?? [];
      const track = trim(row[c.track]), provider = trim(row[c.provider]), type = trim(row[c.type]);
      const amountCell = row[c.amount];
      if (track === '' && provider === '' && type === '' && trim(amountCell) === '') break;
      const amount = num(amountCell);
      const holder = holderCol != null ? trim(row[holderCol]) : '';
      let group = groupOf(type, layout);
      const label = provider || track || type;
      if (amount == null) { check(r, c.amount, label, 'no amount: NOT migrated'); continue; }
      if (!group) { group = 'funds'; check(r, c.type, label, 'savings type "' + type + '" not recognised: put under funds'); }
      const common = { currency: 'ILS' as const, asOf: date, ...(holder ? { person: holder } : {}), ...(type ? { savingsType: type } : {}) };
      if (group === 'realEstate') {
        // The property's name sits in the provider column; the track column holds the owner's note about its value.
        const name = provider || track;
        const note = provider ? track : '';
        const p = note ? parsePropertyNote(note, layout) : { value: null, debt: null, range: false };
        const tol = Math.max(1, Math.abs(amount) * 0.01);
        let value = amount, debt: number | null = null;
        if (p.value != null && p.debt != null && !p.range && Math.abs(p.value - p.debt - amount) <= tol) { value = p.value; debt = p.debt; }
        else if (p.value != null && p.debt == null && !p.range && Math.abs(p.value - amount) <= tol) value = p.value;
        else if (note) check(r, c.track, name, 'the note "' + note + '" ' + (p.range ? 'gives a range' : 'does not match the amount ' + amount) + ': migrated at the amount ' + amount + ' (no mortgage taken from the note); the note is kept');
        out.push({ id: id('realEstate:' + slug(name)), group, name, value, ...(debt != null ? { debt } : {}), ...common, ...(note ? { note } : {}) });
        continue;
      }
      const name = track && track !== '-' ? provider + ' - ' + track : provider || track;
      out.push({ id: id(group + ':' + slug(name) + (holder ? '-' + slug(holder) : '')), group, name, ...(provider ? { provider } : {}), value: amount, ...common });
    }
  }
  // The sheet's debt line (no item of its own): a negative cash item, for the owner to place.
  const debt = layout.totals.debtIls;
  const at = debt ? labelled(rows, debt) : null;
  if (debt && at) {
    const vr = at.r, vc = at.c, v = at.value;
    if (v != null && v !== 0) {
      const note = trim(rows[vr]?.[vc + 1]);
      const amount = Math.abs(v);
      const free = out.map((a, i) => [a, i] as const).filter(([a]) => a.group === 'realEstate' && (a.debt == null || a.debt === 0));
      if (layout.debtTo === 'realEstate' && free.length === 1) {
        const [a, i] = free[0] as readonly [LedgerAsset, number];
        const text = debt.label + ' ' + amount + (note ? ' ' + note : '');
        out[i] = { ...a, debt: amount, note: a.note ? a.note + '; ' + text : text };
        sheetDebt = { amount, attachedTo: a.id, added: text, ...(note ? { cellNote: note } : {}) };
        check(vr, vc, debt.label + ' ' + v, 'the sheet\'s separate debt line, migrated as the mortgage (debt) of "' + a.name + '", the one property without one' + (note ? ' (note "' + note + '")' : '') + ': confirm');
      } else {
        const cashItem = id('cash:' + slug(debt.label));
        out.push({ id: cashItem, group: 'cash', name: debt.label, value: -amount, currency: 'ILS', asOf: today, ...(note ? { note } : {}) });
        sheetDebt = { amount, attachedTo: null, cashItem, ...(note ? { cellNote: note } : {}) };
        check(vr, vc, debt.label + ' ' + v, 'a debt with no item of its own: migrated as a NEGATIVE cash item' + (note ? ' (note "' + note + '")' : '') + '; say which loan it is and where it belongs');
      }
    }
  }
  return { items: out, sheetDebt };
}
