/**
 * `node src/research/freePlayCli.ts <priceDir> <readsDir>`: FREE PLAY on the research list (owner
 * 2026-10-28): each model alone, $100,000, holds as many of the 14 as it wants, equal shares, QQQ when it holds
 * nothing; its own sell rule, or sell only when the 200-day trend breaks. Per period: result after tax, deepest
 * fall, stocks held on average, trades. Against holding QQQ and holding the list equally.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadSeries, type PriceSeries } from '../backtest/data.ts';
import { PERIODS, holdLab } from './lab.ts';
import { runPortfolio, holdBag, type PortfolioInput, type PortfolioModel, type PortfolioOptions } from './portfolioLab.ts';
import { OWNER_BAG } from './portfolioCli.ts';
import { benchmarksFor, benchRows, reportTable, type PeriodOutcome } from './benchmarks.ts';
import type { CompactRead } from './computeReads.ts';

const CASH = 100_000;
export const FREE_MODELS: Array<[string, PortfolioModel, Partial<PortfolioOptions>]> = [
  ['Engine alone', 'engine', {}], ['Engine + models (current)', 'current', {}], ['Schabacker', 'schabacker', {}], ['Edwards & Magee', 'edwardsMagee', {}],
  ['Broker Course', 'broker', {}], ['Turtle', 'turtle', {}], ['Wyckoff', 'wyckoff', {}], ['Trend 150', 'trend', { trendDays: 150 }], ['Trend 200', 'trend', { trendDays: 200 }],
  ['Turtle+Schabacker+E&M 2 of 3', 'combo', {}],
];
const pct = (v: number): string => ((v / CASH - 1) * 100 >= 0 ? '+' : '') + ((v / CASH - 1) * 100).toFixed(0) + '%';

function main(): void {
  const [priceDir, readsDir] = process.argv.slice(2) as [string, string];
  const series = new Map<string, PriceSeries>(), reads = new Map<string, Map<string, CompactRead>>();
  for (const t of OWNER_BAG) {
    const f = path.join(readsDir, t + '.reads.json');
    if (!fs.existsSync(f)) continue;
    series.set(t, loadSeries(t, priceDir));
    reads.set(t, new Map((JSON.parse(fs.readFileSync(f, 'utf8')) as CompactRead[]).map((r) => [r.d, r])));
  }
  const bag = OWNER_BAG.filter((t) => series.has(t));
  const inp: PortfolioInput = { series, reads, qqq: loadSeries('QQQ', priceDir) };
  const q = PERIODS.map((p) => holdLab(inp.qqq, p.start, p.end, CASH) as number);
  const hb = PERIODS.map((p) => holdBag(bag, inp, p.start, p.end, CASH));
  const out: string[] = ['FREE PLAY on your list (' + bag.join(', ') + '): each model alone, $100,000, as many stocks as it wants (equal shares), QQQ when it holds none, after the 25% tax.', ''];
  out.push('| Model | Sell rule | ' + PERIODS.map((p) => p.name).join(' | ') + ' | Beats QQQ | Beats your list | Deepest fall | Stocks held (avg) | Trades |', '|---|---|---|---|---|---|---|---|---|---|');
  const bench = benchmarksFor(bag, inp, CASH);
  out.push(...benchRows(bench, CASH, 2, ['', '', 'fall', '', '']));
  const rows: Array<{ line: string; key: number; name: string; outcomes: PeriodOutcome[] }> = [];
  for (const [label, m, extra] of FREE_MODELS) {
    for (const [rn, ro] of [['own', {}], ['200-day break', { exit: 'trend' as const, trendDays: 200 }]] as Array<[string, Partial<PortfolioOptions>]>) {
      if (m === 'trend' && rn !== 'own') continue; // the Trend model's own sell rule IS the trend break
      const o: PortfolioOptions = { slots: bag.length, cash: CASH, free: true, ...ro, ...extra };
      const r = PERIODS.map((p) => runPortfolio(m, bag, inp, p.start, p.end, o));
      const v = r.map((x) => x.finalTaxed);
      const bq = v.filter((x, i) => x > q[i]!).length, bl = v.filter((x, i) => x > hb[i]!).length;
      rows.push({ name: label + ', ' + rn, outcomes: r, key: bq * 10 + bl + Math.min(...v.map((x, i) => x - q[i]!)) / 1e9, line: '| ' + label + ' | ' + rn + ' | ' + v.map(pct).join(' | ') + ' | ' + bq + ' of 3 | ' + bl + ' of 3 | -' + Math.max(...r.map((x) => x.maxDrawdownPct)).toFixed(0) + '% | ' + (r.reduce((a, x) => a + x.avgStocksHeld, 0) / r.length).toFixed(1) + ' | ' + r.reduce((a, x) => a + x.trades, 0) + ' |' });
      process.stderr.write(label + ' ' + rn + '\n');
    }
  }
  rows.sort((a, b) => b.key - a.key);
  out.push(...rows.map((r) => r.line));
  out.push(...reportTable(bench, rows, inp.qqq, CASH));
  process.stdout.write(out.join('\n') + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
