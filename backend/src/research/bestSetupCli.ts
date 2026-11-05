/**
 * `node src/research/bestSetupCli.ts <priceDir> <readsDir> [model,...]`: for each model on the owner's list, every
 * setup (1, 2, 3, 5 positions or free play; own sell rule or the 200-day break) -- one line per setup with the three
 * periods, after tax, the deepest fall, and whether it beats QQQ / the list. The best setup per model is marked.
 * Picking the best setup per model uses the past: the live paper test is the check that it holds.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadSeries, type PriceSeries } from '../backtest/data.ts';
import { PERIODS, holdLab } from './lab.ts';
import { runPortfolio, holdBag, type PortfolioInput, type PortfolioOptions } from './portfolioLab.ts';
import { OWNER_BAG } from './portfolioCli.ts';
import { FREE_MODELS } from './freePlayCli.ts';
import { benchmarksFor, benchRows, reportTable, type PeriodOutcome } from './benchmarks.ts';
import type { CompactRead } from './computeReads.ts';

const CASH = 100_000;
const pct = (v: number): string => ((v / CASH - 1) * 100 >= 0 ? '+' : '') + ((v / CASH - 1) * 100).toFixed(0) + '%';
const SIZES: Array<[string, Partial<PortfolioOptions>]> = [['1 stock', { slots: 1 }], ['2 stocks', { slots: 2 }], ['3 stocks', { slots: 3 }], ['5 stocks', { slots: 5 }], ['as many as it likes', { free: true }]];
const EXITS: Array<[string, Partial<PortfolioOptions>]> = [['own sell rule', {}], ['200-day break', { exit: 'trend', trendDays: 200 }]];

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
  const out: string[] = ['| Model | Setup | ' + PERIODS.map((p) => p.name).join(' | ') + ' | Beats QQQ | Beats the list | Deepest fall |', '|---|---|---|---|---|---|---|---|',
    ...benchRows(bench, CASH, 2, ['', '', 'fall'])];
  const report: Array<{ name: string; outcomes: PeriodOutcome[] }> = [];
  for (const [label, m, extra] of FREE_MODELS.filter(([l]) => !only || only.split(',').includes(l))) {
    const lines: Array<{ score: number; text: string; name: string; outcomes: PeriodOutcome[] }> = [];
    for (const [sn, so] of SIZES) for (const [en, eo] of EXITS) {
      if (m === 'trend' && en !== 'own sell rule') continue;
      const o: PortfolioOptions = { slots: bag.length, cash: CASH, ...so, ...eo, ...extra };
      const r = PERIODS.map((p) => runPortfolio(m, bag, inp, p.start, p.end, o));
      const v = r.map((x) => x.finalTaxed);
      const bq = v.filter((x, i) => x > q[i]!).length, bl = v.filter((x, i) => x > hb[i]!).length;
      const worst = Math.min(...v.map((x, i) => (x - q[i]!) / CASH * 100));
      lines.push({ name: label + ', ' + sn + ', ' + en, outcomes: r, score: bq * 1000 + bl * 100 + worst / 100, text: label + ' | ' + sn + ', ' + en + ' | ' + v.map(pct).join(' | ') + ' | ' + bq + ' of 3 | ' + bl + ' of 3 | -' + Math.max(...r.map((x) => x.maxDrawdownPct)).toFixed(0) + '%' });
    }
    lines.sort((a, b) => b.score - a.score);
    out.push(...lines.map((l, k) => '| ' + (k === 0 ? '⭐ ' : '') + l.text + ' |'));
    report.push(...lines.map((l, k) => ({ name: (k === 0 ? '⭐ ' : '') + l.name, outcomes: l.outcomes })));
    process.stderr.write(label + '\n');
  }
  out.push(...reportTable(bench, report, inp.qqq, CASH));
  process.stdout.write(out.join('\n') + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
