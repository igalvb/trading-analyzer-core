/**
 * `node src/research/winnersCli.ts <priceDir> <readsDir>`: the rules that beat QQQ and the owner's list in all three
 * periods, checked for (1) the deepest fall along the way and (2) whether they also work on the 20 random bags.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadSeries, type PriceSeries } from '../backtest/data.ts';
import { PERIODS, holdLab } from './lab.ts';
import { runPortfolio, type PortfolioInput, type PortfolioModel, type PortfolioOptions } from './portfolioLab.ts';
import { benchmarksFor, joinName, JOIN_WHEN_LISTED_NOTE } from './benchmarks.ts';
import { OWNER_BAG, randomBags } from './portfolioCli.ts';
import type { CompactRead } from './computeReads.ts';

const CASH = 100_000;
const pct = (v: number): string => ((v / CASH - 1) * 100 >= 0 ? '+' : '') + ((v / CASH - 1) * 100).toFixed(0) + '%';
const RULES: Array<[string, PortfolioModel, PortfolioOptions]> = [
  ['Turtle+Schabacker+E&M 2 of 3, sell less 200d, 3 slots', 'combo', { slots: 3, cash: CASH, exit: 'trend', trendDays: 200 }],
  ['Turtle, sell less 200d, 3 slots', 'turtle', { slots: 3, cash: CASH, exit: 'trend', trendDays: 200 }],
  ['Trend, sell less 200d, 3 slots', 'trend', { slots: 3, cash: CASH, exit: 'trend', trendDays: 200 }],
  ['Engine + models (current), sell less 200d, 5 slots', 'current', { slots: 5, cash: CASH, exit: 'trend', trendDays: 200 }],
];

function main(): void {
  const [priceDir, readsDir] = process.argv.slice(2) as [string, string];
  const series = new Map<string, PriceSeries>(), reads = new Map<string, Map<string, CompactRead>>();
  for (const f of fs.readdirSync(readsDir).filter((x) => x.endsWith('.reads.json'))) {
    const t = f.replace('.reads.json', '');
    series.set(t, loadSeries(t, priceDir));
    reads.set(t, new Map((JSON.parse(fs.readFileSync(path.join(readsDir, f), 'utf8')) as CompactRead[]).map((r) => [r.d, r])));
  }
  const inp: PortfolioInput = { series, reads, qqq: loadSeries('QQQ', priceDir) };
  const owner = OWNER_BAG.filter((t) => series.has(t));
  const bags = randomBags([...series.keys()].filter((t) => t !== 'SPCX').sort(), 20, 12);
  const q = PERIODS.map((p) => holdLab(inp.qqq, p.start, p.end, CASH) as number);
  const bm = benchmarksFor(owner, inp, CASH);
  // QQQ's own deepest fall in each period
  const qdd = PERIODS.map((p) => { let pk = 0, dd = 0; inp.qqq.dates.forEach((d, i) => { if (d < p.start || d > p.end) return; const c = inp.qqq.closes[i] as number; pk = Math.max(pk, c); dd = Math.max(dd, (1 - c / pk) * 100); }); return dd; });
  const out = ['| Rule | ' + PERIODS.map((p) => p.name + ': your list (deepest fall)').join(' | ') + ' | ' + PERIODS.map((p) => p.name + ': random bags avg (bags beating QQQ)').join(' | ') + ' |', '|---|---|---|---|---|---|---|',
    '| Hold QQQ | ' + q.map((v, i) => pct(v) + ' (-' + qdd[i]!.toFixed(0) + '%)').join(' | ') + ' | ' + q.map(pct).join(' | ') + ' |',
    '| Hold your list equally | ' + bm.list.map((b) => pct(b.finalTaxed) + ' (-' + b.maxDrawdownPct.toFixed(0) + '%)').join(' | ') + ' | — | — | — |',
    '| ' + joinName('Hold your list equally') + ' | ' + bm.listJoin.map((b) => pct(b.finalTaxed) + ' (-' + b.maxDrawdownPct.toFixed(0) + '%)').join(' | ') + ' | — | — | — |'];
  for (const [name, m, o] of RULES) {
    const mine = PERIODS.map((p) => runPortfolio(m, owner, inp, p.start, p.end, o));
    const rnd = PERIODS.map((p, i) => { const r = bags.map((b) => runPortfolio(m, b, inp, p.start, p.end, o).finalTaxed); return pct(r.reduce((a, b) => a + b, 0) / r.length) + ' (' + r.filter((v) => v > q[i]!).length + ' of 20)'; });
    out.push('| ' + name + ' | ' + mine.map((r) => pct(r.finalTaxed) + ' (-' + r.maxDrawdownPct.toFixed(0) + '%)').join(' | ') + ' | ' + rnd.join(' | ') + ' |');
    process.stderr.write(name + '\n');
  }
  out.push('', JOIN_WHEN_LISTED_NOTE);
  process.stdout.write(out.join('\n') + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
