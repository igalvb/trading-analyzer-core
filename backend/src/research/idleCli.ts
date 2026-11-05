/**
 * `node src/research/idleCli.ts <priceDir> <readsDir> [label,...]` (owner 2026-10-28: idle money should not always
 * be in QQQ, "especially when the trend is against you"). Each model on the owner's list with its best setup
 * (bestSetupCli), one line per idle rule: always QQQ, always cash, QQQ only while QQQ's 150- or 200-day trend is up.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadSeries, type PriceSeries } from '../backtest/data.ts';
import { PERIODS, holdLab } from './lab.ts';
import { runPortfolio, holdBag, type PortfolioInput, type PortfolioOptions } from './portfolioLab.ts';
import { OWNER_BAG } from './portfolioCli.ts';
import { FREE_MODELS } from './freePlayCli.ts';
import type { CompactRead } from './computeReads.ts';
import { benchmarksFor, benchRows, reportTable, type PeriodOutcome } from './benchmarks.ts';

const CASH = 100_000;
const pct = (v: number): string => ((v / CASH - 1) * 100 >= 0 ? '+' : '') + ((v / CASH - 1) * 100).toFixed(0) + '%';
const T200: Partial<PortfolioOptions> = { exit: 'trend', trendDays: 200 };
/** Each model's best setup from bestSetupCli (2026-10-28 run). */
export const BEST_SETUP: Readonly<Record<string, [string, Partial<PortfolioOptions>]>> = {
  'Engine alone': ['3 stocks, 200-day break', { slots: 3, ...T200 }],
  'Engine + models (current)': ['5 stocks, 200-day break', { slots: 5, ...T200 }],
  'Schabacker': ['3 stocks, 200-day break', { slots: 3, ...T200 }],
  'Edwards & Magee': ['5 stocks, own sell rule', { slots: 5 }],
  'Broker Course': ['2 stocks, 200-day break', { slots: 2, ...T200 }],
  'Turtle': ['3 stocks, 200-day break', { slots: 3, ...T200 }],
  'Wyckoff': ['2 stocks, own sell rule', { slots: 2 }],
  'Trend 150': ['3 stocks, own sell rule', { slots: 3 }],
  'Trend 200': ['3 stocks, own sell rule', { slots: 3 }],
  'Turtle+Schabacker+E&M 2 of 3': ['3 stocks, 200-day break', { slots: 3, ...T200 }],
};
const IDLE: Array<[string, Partial<PortfolioOptions>]> = [
  ['always QQQ', { idle: 'qqq' }], ['always cash', { idle: 'cash' }],
  ['QQQ while its 150-day trend is up', { idle: 'qqqTrend', idleDays: 150 }], ['QQQ while its 200-day trend is up', { idle: 'qqqTrend', idleDays: 200 }],
];

function main(): void {
  const [priceDir, readsDir, only] = process.argv.slice(2) as [string, string, string?];
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
  const bench = benchmarksFor(bag, inp, CASH);
  const out: string[] = ['| Model | Setup | Idle money | ' + PERIODS.map((p) => p.name).join(' | ') + ' | Beats QQQ | Beats the list | Deepest fall |', '|---|---|---|---|---|---|---|---|---|',
    ...benchRows(bench, CASH, 3, ['', '', 'fall'])];
  const report: Array<{ name: string; outcomes: PeriodOutcome[] }> = [];
  for (const [label, m, extra] of FREE_MODELS.filter(([l]) => !only || only.split(',').includes(l))) {
    const [sn, so] = BEST_SETUP[label] as [string, Partial<PortfolioOptions>];
    for (const [iname, io] of IDLE) {
      const o: PortfolioOptions = { slots: bag.length, cash: CASH, ...so, ...extra, ...io };
      const r = PERIODS.map((p) => runPortfolio(m, bag, inp, p.start, p.end, o));
      const v = r.map((x) => x.finalTaxed);
      const bq = v.filter((x, i) => x > q[i]!).length, bl = v.filter((x, i) => x > hb[i]!).length;
      report.push({ name: label + ', ' + sn + ', idle money ' + iname, outcomes: r });
      out.push('| ' + label + ' | ' + sn + ' | ' + iname + ' | ' + v.map(pct).join(' | ') + ' | ' + bq + ' of 3 | ' + bl + ' of 3 | -' + Math.max(...r.map((x) => x.maxDrawdownPct)).toFixed(0) + '% |');
    }
    process.stderr.write(label + '\n');
  }
  out.push(...reportTable(bench, report, inp.qqq, CASH));
  process.stdout.write(out.join('\n') + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
