/**
 * Fixtures for the FL-7f tests: charts cut from the real historical_data fixtures (classes measured once: AQZA@260
 * thesis AVOID, AQZA@300 stop breached, DECK@1200 T1, HQZA@2000 T2, IBIT@400 HOLD, AQZB@260) and the Portfolio grids.
 */
import { loadRawFixture, buildChart, type OracleChart } from './fixtures.ts';
export const TZ = 'America/New_York';
export const NOW = Date.parse('2026-10-23T15:00:00Z');
const SPECS: Record<string, readonly [string, number]> = {
  AQZA: ['AQZA', 300], AVD: ['AQZA', 260], DECK: ['DECK', 1200], HQZA: ['HQZA', 2000], IBIT: ['IBIT', 400], AQZB: ['AQZB', 260], SHORT: ['AQZA', 25],
  AKX: ['AQZA', 300], AKH: ['AQZA', 300], AKT: ['AQZA', 300], AKO: ['AQZA', 300], AKF: ['AQZA', 300], AKD: ['AQZA', 300], AKS: ['AQZA', 300], ZER: ['AQZA', 300], ALT: ['AQZB', 260],
};
let memo: Record<string, OracleChart> | null = null;
export function charts(): Record<string, OracleChart> {
  if (!memo) {
    const built = new Map<string, OracleChart>();
    memo = {};
    for (const [t, [src, bars]] of Object.entries(SPECS)) {
      const k = src + '@' + bars;
      if (!built.has(k)) built.set(k, buildChart(loadRawFixture(src), bars));
      memo[t] = built.get(k)!;
    }
  }
  return memo;
}
export const dateAt = (t: string, i: number): string => charts()[t].dates[i].toISOString().slice(0, 10);
export const STOCK_HDR = ['Ticker', 'type', 'amount', 'cost avg per stock', 'Purchase Data', 'notes'];
export const OPT_HDR = ['Ticker', 'positions', 'last trade Date', 'strike', 'PUT/CALL', 'current market value', 'avg price - Premium paid', 'Purchase Data'];
export function stockRows(): unknown[][] {
  return [
    ['aqza', 'stock', '10', '$48.10', '', ''], ['AVD', 'Stock', 5, 20, '', ''], ['DECK', 'stock', 3, '1,000.5', '', ''], ['HQZA', 'stock', '$7', 12, '', ''], ['IBIT', 'stock', 100, '30', '', ''],
    ['AKX', 'stock', 2, 50, dateAt('AQZA', 90), ''], ['AKH', 'stock', 2, 50, dateAt('AQZA', 290), ''], ['AKT', 'stock', 2, 50, dateAt('AQZA', 240), ''], ['ALT', 'stock', 2, 50, dateAt('AQZB', 250), ''],
    ['AKO', 'stock', 2, 50, '1990-01-01', ''], ['AKF', 'stock', 2, 50, '2099-01-01', ''], ['AKD', 'stock', 2, 50, new Date(Date.UTC(2007, 4, 14)), ''], ['AKS', 'stock', 2, 50, 39215, ''],
    ['NOC', 'stock', 1, 'n/a', '', ''], ['ZER', 'stock', 1, 0, '', ''], ['GONE', 'stock', 1, 10, '', ''], ['BTC', 'crypto', 0.5, 60000, '', ''],
    ['', 'stock-TBD', '', '', '', ''], ['', '', '', '', '', 'spare note'], ['', '', '', '', '', ''], ['TOTAL EARNINGS***', '', '', '', '', ''], ['AQZA***', 'stock', 10, 40, '', ''],
    ['XYZ', 'etf', 1, 1, '', ''], ['QQQ', '', 1, 1, '', ''], ['aqza', 'stock', 4, '55', '', ''],
  ];
}
export function optionRows(): unknown[][] {
  const J = 'Jan 15 2027';
  return [
    ['AQZA', 2, J, 50, 'CALL', 100, 5.5, ''], ['AVD', 1, J, 30, 'CALL', 100, 3, ''], ['DECK', 1, J, 900, 'CALL', 100, '$12.25', ''], ['DECK', 3, J, 900, 'CALL', 100, 12, ''],
    ['HQZA', 1, J, 10, 'CALL', 100, 2, ''], ['HQZA', 2, J, 10, 'CALL', 100, 2, ''], ['IBIT', 1, J, 50, 'CALL', 100, 2, ''], ['IBIT', 1, 'Nov 20 2026', 50, 'CALL', 100, 2, ''],
    ['IBIT', 1, 'Mar 19 2026', 50, 'CALL', 100, 2, ''], ['IBIT', 1, 'garbage', 50, 'CALL', 100, 2, ''], ['IBIT', 1, '', 50, 'CALL', 100, 2, ''], ['IBIT', 1, J, '', 'CALL', 100, 2, ''],
    ['GONE', 1, J, 10, 'CALL', 100, '', ''],
    ['AQZA', 2, J, 50, 'CALL', 100, 5.5, dateAt('AQZA', 90)], ['AQZA', 1, "Jan 15 '27", 50, 'CALL', 100, 5.5, dateAt('AQZA', 240)], ['AQZA', 1, J, 50, 'CALL', 100, 5.5, dateAt('AQZA', 290)],
    ['IBIT', 1, J, 50, 'CALL', 100, 2, '1990-01-01'], ['AQZA', 1, 'garbage', 50, 'CALL', 100, 2, dateAt('AQZA', 90)], ['AQZA', 1, J, 50, 'CALL', 100, 2, new Date(Date.UTC(2007, 4, 14))],
    ['AQZA', 1, new Date(Date.UTC(2027, 0, 15)), 50, 'CALL', 100, 2, ''], ['AQZA', 1, '2027-01-15', 50, 'CALL', 100, 2, ''],
    ['', '', '', '', '', '', '', ''], ['AQZA', 1, J, 50, 'CALL', 100, 2, ''],
  ];
}
export const fullGrid = (): unknown[][] => [['My Portfolio'], [''], STOCK_HDR, ...stockRows(), [''], ['Options'], OPT_HDR, ...optionRows()];
const smallStocks = (): unknown[][] => [['aqza', 'stock', 10, 48.1, '', ''], ['IBIT', 'stock', 100, 30, '', '']];
export const GRIDS: Record<string, () => unknown[][]> = {
  full: fullGrid,
  small: () => [STOCK_HDR, ...smallStocks()],
  stockOnly: () => [STOCK_HDR, ...smallStocks()],
  optionsOnly: () => [OPT_HDR, ...optionRows().slice(0, 8)],
  junk: () => [['nothing here'], [1, 2, 3]],
  emptyTables: () => [STOCK_HDR, OPT_HDR],
  missingColumn: () => [['Ticker', 'type', 'cost avg per stock'], ['AQZA', 'stock', 5], [''], OPT_HDR, ...optionRows().slice(0, 2)],
  optionsFirst: () => [OPT_HDR, ...optionRows().slice(0, 3), [''], STOCK_HDR, ...smallStocks()],
};
