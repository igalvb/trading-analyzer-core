/**
 * Made-up fixtures for the ledger tests (docs/LEDGER.md): a Portfolio tab with every block, and the words of its
 * block above the stock table in another language (a test layout; the core's default is English).
 */

import { DEFAULT_LEDGER_LAYOUT, type SheetLayout } from '../src/ledger/layout.ts';
import type { SheetRow } from '../src/sheets/coerce.ts';

export const TEST_LAYOUT: SheetLayout = {
  ...DEFAULT_LEDGER_LAYOUT,
  totals: { ...DEFAULT_LEDGER_LAYOUT.totals, realEstateIls: { label: 'Total inmuebles', at: 'left' } },
  funds: { track: 'Plan', provider: 'Proveedor', type: 'Tipo de ahorro', amount: 'Importe' },
  groups: { realEstate: ['inmueble'], pension: ['pensión'], funds: ['estudio'], cash: ['efectivo'] },
  notes: { value: ['valor'], debt: ['hipoteca'], million: ['millones'], thousand: ['mil'] },
  debtTo: 'realEstate',
  targets: [{ label: 'My ATH ratio', names: ['Ratio high', 'Price ratio high'] }],
  cryptoApiCells: { J2: 'ETH', J3: 'XRP' },
};

/** A made-up Portfolio tab with every block. Sheet totals agree with the rows unless `pension` is given. */
export function grid(o: { pension?: number } = {}): SheetRow[] {
  const fx = 3.5, portfolioUsd = 9210, portfolioIls = portfolioUsd * fx, pension = o.pension ?? 300_000, debt = 100_000, re = 1_500_000;
  const rows: SheetRow[] = [
    ['Total Portfolio Sum $', 'Total pension NIS', 'Total savings with assets'],
    [portfolioUsd, pension, portfolioIls + pension - debt + re],
    ['Total Portfolio Sum NIS', 'Total Savings NIS', 'DEBT in NIS'],
    [portfolioIls, portfolioIls + pension - debt, debt, '(until 2030)'],
    ['', '', '', '', '', re, 'Total inmuebles', '', 'USD to NIS'],
    ['sub-type', 'Aggregated Investment Value', '', '', '', '', '', '', fx],
    ['long', 2000], ['btc etf', 300], ['coins', 6010], ['Options', 900], [],
    ['', '', 'actualizado 1.2.2025'],
    ['Plan', 'Proveedor', 'Tipo de ahorro', 'Importe', '', '', '', 'My ATH ratio'],
    ['general', 'Fondo Ñ', 'fondo de estudio', 100_000, 'Ana', '', '', 1.5],
    ['-', 'Fondo B', 'pensión', 200_000, 'Ana', '', '', 0.01],
    ['valor 1.5 millones pero 0.5 hipoteca', 'Piso A', 'inmueble', 1_000_000],
    ['(quizá 0.4-0.6)', 'Piso B', 'inmueble', 500_000],
    [],
    [' Ticker', 'type', 'sub-type', 'amount', 'price per item', 'value of inverstment', ' cost avg per stock', 'URLS / comments'],
    ['AAPL', 'stock', 'long', 10, 200, 2000, 150],
    ['FBTC', 'stock', 'bitcoin etf', 5, 60, 300, 50],
    ['ETH', 'crypto', 'eth', 2, 3000, 6000, 1000, 'https://x.test/ETH/'],
    ['AAPL***', 'stock', 'long', 3, 200, 600, 190, ' temp'],
    ['TOTAL***', '', '', '', '', 600],
    ['DOGE', 'crypto', 'alts', 100, 0.1, 10, 0],
    [],
    ['OPEN positions'],
    ['Ticker', 'type', 'positions', 'last trade Date', 'strike', 'PUT/CALL', 'avg price - Premium paid', 'cost basis', 'current market value', 'URLS / comments', 'Purchase Date'],
    ['KO', 'options', 2, "JUN17'27", 60, 'CALL', 3.5, 700, 900, '', 46_100],
    ['CLOSED positions'],
    ['Ticker', 'type', 'positions', 'last trade Date', 'strike', 'PUT/CALL', 'avg price - Premium paid', 'cost basis', 'Sell Price', 'Sell Date'],
    ['MSFT', 'options', 1, "Mar19'27", 400, 'CALL', 20, 2000, 4500, '19:05:34 10/09/26'],
    ['KO', 'options', 1, "DEC17'27", 50, 'CALL', 2, 200, 3, 46_000],
  ];
  return rows;
}
