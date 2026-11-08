/**
 * The Nightly's ledger part (docs/LEDGER.md phase 3), by profile `storage.ledger`:
 *
 *   off     nothing (no file read, no line logged)
 *   shadow  the holdings are read from the ledger too and compared with the sheet's: ONE line, "same holdings" or
 *           the differences (WARNING); then today's snapshot is appended to ledger/snapshots.jsonl
 *   on      the runs already read the ledger (app/nightlyApp.ts loadPortfolio); only the snapshot
 *
 * Profile `ledger.cryptoPrices` 'on' (ledger/cryptoPrices.ts): before the snapshot, the ledger's crypto is priced from
 * cryptoprices.cc (a fetched price wins over manualPrice; a coin not fetched keeps manualPrice); bitcoin (MARKET_COINS)
 * from Yahoo '<COIN>-USD' instead. holdings.json is not rewritten: the prices used are saved to ledger/prices.json
 * (the dashboard shows the same prices). 'off' (default) = no fetch at all, no prices.json written.
 *
 * The workflow commits the changed file to the `data` branch afterwards (.github/workflows/nightly.yml). Never throws:
 * the caller wraps it (a ledger problem never fails the night).
 */

import type { PortfolioResult } from '../sheets/readers/portfolio.ts';
import type { LedgerMode } from '../profile/schema.ts';
import { appendSnapshot, readLedgerJson, writeLedgerJson } from './store.ts';
import { compareHoldings, ledgerRefinements, toPortfolio } from './toPortfolio.ts';
import { buildSnapshot } from './snapshot.ts';
import { LEDGER_FILES, LEDGER_SCHEMA, type LedgerHoldings } from './schema.ts';
import { cryptoPriceSymbol } from './cryptoPrices.ts';

export interface LedgerNightDeps {
  readonly mode: LedgerMode;
  /** The data branch folder (ledger/store.ts dataBranchDir). */
  readonly root: string;
  /** Tonight's holdings as read from the sheet (shadow); null in 'on'. */
  readonly sheetPortfolio: PortfolioResult | null;
  /** 'YYYY-MM-DD', New York. */
  readonly today: string;
  /** Tonight's close of a market symbol (stocks; crypto as '<TICKER>-USD'); null when unknown. */
  readonly close: (ticker: string) => Promise<number | null>;
  /** USD -> ILS (Yahoo 'ILS=X'); null when unknown. */
  readonly fxUsdIls: () => Promise<number | null>;
  /** Profile ledger.cryptoPrices; absent = 'off'. */
  readonly cryptoPrices?: 'off' | 'on';
  /** API symbol -> USD price (ledger/cryptoPrices.ts fetchCryptoPrices; never throws). Called only when cryptoPrices is 'on'. */
  readonly fetchCrypto?: (symbols: readonly string[]) => Promise<ReadonlyMap<string, number>>;
  readonly info: (m: string) => void;
  readonly warn: (m: string) => void;
}

export interface LedgerNightResult {
  readonly differences: readonly string[] | null;
  readonly snapshot: 'added' | 'exists' | 'skipped';
}

export async function runLedgerNight(d: LedgerNightDeps): Promise<LedgerNightResult> {
  if (d.mode === 'off') return { differences: null, snapshot: 'skipped' };
  const held = readLedgerJson(d.root, 'holdings');
  if (!held) {
    d.warn('ledger (' + d.mode + '): no ' + LEDGER_FILES.holdings + ' on the data branch folder; nothing compared or saved');
    return { differences: null, snapshot: 'skipped' };
  }
  let differences: string[] | null = null;
  if (d.mode === 'shadow' && d.sheetPortfolio) {
    differences = compareHoldings(d.sheetPortfolio, toPortfolio(held));
    const counts = d.sheetPortfolio.stocks.length + ' stock(s), ' + d.sheetPortfolio.options.length + ' option(s), ' + d.sheetPortfolio.skippedCrypto.length + ' crypto';
    if (!differences.length) d.info('ledger shadow: the ledger holds the same holdings as the sheet (' + counts + ')');
    else d.warn('ledger shadow: ' + differences.length + ' difference(s) between the sheet and the ledger: ' + differences.join(' | '));
    const refined = ledgerRefinements(d.sheetPortfolio, toPortfolio(held));
    if (refined.length) d.info('ledger shadow: ' + refined.length + ' holding(s) with a corrected cost or a real buy date in the ledger (from the statements; not a difference): ' + refined.join(' | '));
  }
  const priced = d.cryptoPrices === 'on' && d.fetchCrypto ? await withCryptoPrices(held, d.fetchCrypto, d.close, d.info) : null;
  const holdings = priced?.holdings ?? held;
  const assets = readLedgerJson(d.root, 'assets');
  const prices = new Map<string, number | null>();
  for (const s of holdings.stocks) {
    if (s.manualPrice != null) continue;
    const t = s.kind === 'crypto' ? s.ticker.replace(/\.+$/, '') + '-USD' : s.ticker;
    if (!prices.has(t)) prices.set(t, await d.close(t));
  }
  const fx = await d.fxUsdIls();
  const { snapshot, missing } = buildSnapshot({ date: d.today, holdings, assets, price: (t) => prices.get(t) ?? null, fxUsdIls: fx });
  const added = appendSnapshot(d.root, snapshot);
  if (priced) writeLedgerJson(d.root, 'prices', { schema: LEDGER_SCHEMA, date: d.today, prices: priced.prices });
  const line = 'ledger snapshot ' + d.today + ': ' + (added === 'added' ? 'appended' : 'already saved today (kept)') + ', total $' + snapshot.totalUsd.toLocaleString('en-US')
    + (fx ? ' at USD/ILS ' + fx : ' (no USD/ILS rate)') + (missing.length ? '; left out: ' + missing.join(', ') : '');
  if (missing.length) d.warn(line); else d.info(line);
  return { differences, snapshot: added };
}

/** Coins priced from their Yahoo market quote '<COIN>-USD', not from cryptoprices.cc (owner 2026-11-06: bitcoin). */
export const MARKET_COINS: readonly string[] = ['BTC'];

/**
 * The holdings with each crypto's price of the night as its manualPrice (for the snapshot only), and those prices by
 * holding id (ledger/prices.json). A coin with no price of the night keeps its manualPrice.
 */
async function withCryptoPrices(h: LedgerHoldings, fetchCrypto: NonNullable<LedgerNightDeps['fetchCrypto']>, close: LedgerNightDeps['close'], info: (m: string) => void): Promise<{ holdings: LedgerHoldings; prices: Record<string, number> }> {
  const coins = h.stocks.filter((s) => s.kind === 'crypto');
  const prices: Record<string, number> = {};
  if (!coins.length) return { holdings: h, prices };
  const market = (sym: string): boolean => MARKET_COINS.includes(sym.toUpperCase());
  const symbols = [...new Set(coins.map(cryptoPriceSymbol))];
  const away = symbols.filter((sym) => !market(sym));
  const fetched = new Map<string, number>(away.length ? await fetchCrypto(away) : []);
  for (const sym of symbols.filter(market)) { const p = await close(sym.toUpperCase() + '-USD'); if (p != null) fetched.set(sym, p); }
  const stocks = h.stocks.map((s) => {
    if (s.kind !== 'crypto') return s;
    const p = fetched.get(cryptoPriceSymbol(s));
    if (p == null || !(p > 0) || !Number.isFinite(p)) return s;
    prices[s.id] = p;
    return { ...s, manualPrice: p };
  });
  const n = Object.keys(prices).length;
  info('ledger crypto prices: ' + n + ' of ' + coins.length + ' coin(s) priced tonight (' + MARKET_COINS.join(', ') + ' from Yahoo, the rest from cryptoprices.cc)' + (n < coins.length ? '; the others at their manual price' : '') + '; saved to ' + LEDGER_FILES.prices);
  return { holdings: { ...h, stocks }, prices };
}
