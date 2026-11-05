/** The per-model comparison table (owner request 2026-10-27): every strategy per stock, after tax, all money in. */

import { START_CASH, type TestOutcome } from './run.ts';
import { EXIT_TAX_PCT } from '../portfolio/exitTax.ts';
import { BOOK_MODELS, MODEL_LABEL, type BookModel, type FollowResult } from './perModel.ts';

export interface PerModelRow {
  readonly ticker: string;
  /** Final value after tax, by strategy column. */
  readonly values: Readonly<Record<string, number>>;
  readonly buys: Readonly<Record<string, number>>;
}

export const STRATEGY_COLUMNS: readonly string[] = ['Engine alone', 'Engine + models (current)', ...BOOK_MODELS.map((m) => MODEL_LABEL[m]), 'Hold the stock', 'Hold QQQ'];
const SYSTEMS = STRATEGY_COLUMNS.slice(0, 6);

export function perModelRow(ticker: string, engine: TestOutcome, combined: TestOutcome, models: Readonly<Record<BookModel, FollowResult>>): PerModelRow {
  const bench = (name: string): number => combined.benchmarks.find((b) => b.name === name)?.taxed ?? NaN;
  const buysOf = (o: TestOutcome): number => o.taxed.trades.filter((t) => t.side === 'BUY').length;
  const values: Record<string, number> = { 'Engine alone': engine.taxed.finalEquityAfterLiquidationTax, 'Engine + models (current)': combined.taxed.finalEquityAfterLiquidationTax };
  const buys: Record<string, number> = { 'Engine alone': buysOf(engine), 'Engine + models (current)': buysOf(combined) };
  for (const m of BOOK_MODELS) { values[MODEL_LABEL[m]] = models[m].finalTaxed; buys[MODEL_LABEL[m]] = models[m].buys; }
  values['Hold the stock'] = bench('Buy and hold ' + ticker);
  values['Hold QQQ'] = bench('Buy and hold QQQ');
  return { ticker, values, buys };
}

const pct = (v: number): string => (Number.isNaN(v) ? '—' : ((v / START_CASH - 1) * 100 >= 0 ? '+' : '') + ((v / START_CASH - 1) * 100).toFixed(1) + '%');

export function perModelReport(rows: readonly PerModelRow[]): string {
  const head = '| Stock | ' + STRATEGY_COLUMNS.join(' | ') + ' |';
  const sep = '|' + '---|'.repeat(STRATEGY_COLUMNS.length + 1);
  const body = rows.map((r) => {
    const best = Math.max(...STRATEGY_COLUMNS.map((c) => r.values[c] ?? -Infinity));
    return '| ' + r.ticker + ' | ' + STRATEGY_COLUMNS.map((c) => pct(r.values[c] as number) + (r.values[c] === best ? ' ✅' : '')).join(' | ') + ' |';
  });
  const count = (f: (r: PerModelRow, c: string) => boolean): string[] => SYSTEMS.map((c) => rows.filter((r) => f(r, c)).length + ' of ' + rows.length);
  const avg = STRATEGY_COLUMNS.map((c) => pct(rows.reduce((a, r) => a + (r.values[c] as number), 0) / rows.length));
  const dash = ['—', '—'];
  const summary = [
    '| Strategy | ' + STRATEGY_COLUMNS.join(' | ') + ' |', '|' + '---|'.repeat(STRATEGY_COLUMNS.length + 1),
    '| Average result | ' + avg.join(' | ') + ' |',
    '| Beat holding the stock | ' + [...count((r, c) => (r.values[c] as number) > (r.values['Hold the stock'] as number)), ...dash].join(' | ') + ' |',
    '| Beat holding QQQ | ' + [...count((r, c) => (r.values[c] as number) > (r.values['Hold QQQ'] as number)), ...dash].join(' | ') + ' |',
    '| Best of all 8 | ' + count((r, c) => (r.values[c] as number) === Math.max(...STRATEGY_COLUMNS.map((x) => r.values[x] as number))).concat(STRATEGY_COLUMNS.slice(6).map((c) => rows.filter((r) => r.values[c] === Math.max(...STRATEGY_COLUMNS.map((x) => r.values[x] as number))).length + ' of ' + rows.length)).join(' | ') + ' |',
    '| Buys, all stocks | ' + [...SYSTEMS.map((c) => String(rows.reduce((a, r) => a + (r.buys[c] ?? 0), 0))), '13', '13'].join(' | ') + ' |',
  ];
  return ['Each stock alone, $100,000, all money in each trade, after the ' + EXIT_TAX_PCT + ' tax. ✅ = best for that stock.', '', head, sep, ...body, '', ...summary].join('\n');
}
