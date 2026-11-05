/**
 * `node src/research/ownerListCli.ts <priceDir> <readsDir> [slots=5]`: the owner's fixed list (no randomness) --
 * every model under every rule set, each period, vs holding QQQ and holding the list equally, after the 25% tax.
 * One row per model + rule set, sorted by how many periods beat QQQ and by the worst margin.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadSeries, type PriceSeries } from '../backtest/data.ts';
import { PERIODS, holdLab } from './lab.ts';
import { runPortfolio, holdBag, type PortfolioInput, type PortfolioModel, type PortfolioOptions } from './portfolioLab.ts';
import { OWNER_BAG } from './portfolioCli.ts';
import type { CompactRead } from './computeReads.ts';
import { benchmarksFor, reportTable, joinName, type PeriodOutcome } from './benchmarks.ts';

const CASH = 100_000;
const MODELS: Array<[PortfolioModel, string]> = [
  ['engine', 'Engine alone'], ['current', 'Engine + models (current)'], ['schabacker', 'Schabacker'], ['edwardsMagee', 'Edwards & Magee'],
  ['broker', 'Broker Course'], ['turtle', 'Turtle'], ['wyckoff', 'Wyckoff'], ['trend', 'Trend'], ['combo', 'Turtle+Schabacker+E&M 2 of 3'], ['best', 'Engine OR combo buys'],
];
export const RULE_SETS: Array<[string, Omit<PortfolioOptions, 'slots' | 'cash'>]> = [
  ['own sell rule', {}],
  ['sell less (150d)', { exit: 'trend', trendDays: 150 }],
  ['sell less (200d)', { exit: 'trend', trendDays: 200 }],
  ['sell less (150d) + market filter, no buys (QQQ 200d)', { exit: 'trend', trendDays: 150, marketFilter: 'noBuys', marketDays: 200 }],
  ['sell less (150d) + market filter, sell all (QQQ 200d)', { exit: 'trend', trendDays: 150, marketFilter: 'exitAll', marketDays: 200 }],
];
const pct = (v: number): string => ((v / CASH - 1) * 100 >= 0 ? '+' : '') + ((v / CASH - 1) * 100).toFixed(1) + '%';

function main(): void {
  const [priceDir, readsDir, ns] = process.argv.slice(2) as [string, string, string?];
  const slots = Number(ns ?? 5);
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
  const rows: Array<{ name: string; vals: number[]; beats: number; worst: number; trades: number; outcomes: PeriodOutcome[] }> = [];
  for (const [m, label] of MODELS) for (const [rn, ro] of RULE_SETS) {
    if (m === 'best' && !ro.exit) continue; // 'best' has no sell rule of its own
    const r = PERIODS.map((p) => runPortfolio(m, bag, inp, p.start, p.end, { slots, cash: CASH, ...ro }));
    const vals = r.map((x) => x.finalTaxed);
    rows.push({ outcomes: r, name: label + ' | ' + rn, vals, beats: vals.filter((v, i) => v > q[i]!).length, worst: Math.min(...vals.map((v, i) => (v - q[i]!) / CASH * 100)), trades: r.reduce((a, x) => a + x.trades, 0) });
    process.stderr.write(label + ' | ' + rn + '\n');
  }
  rows.sort((a, b) => b.beats - a.beats || b.worst - a.worst);
  const bench = benchmarksFor(bag, inp, CASH);
  const out = [
    'Your list (' + bag.length + '): ' + bag.join(', ') + '. One $100,000 account, ' + slots + ' slots, empty slots in QQQ (cash while the market filter says down), after the 25% tax. A stock joins a period only once it trades.',
    '',
    '| Model \\| rule set | ' + PERIODS.map((p) => p.name).join(' | ') + ' | Periods beating QQQ | Worst gap vs QQQ (points) | Trades |',
    '|---|---|---|---|---|---|---|',
    '| **Hold QQQ** | ' + q.map(pct).join(' | ') + ' | — | — | — |',
    '| **Hold your list equally** | ' + hb.map(pct).join(' | ') + ' | ' + hb.filter((v, i) => v > q[i]!).length + ' | ' + Math.min(...hb.map((v, i) => (v - q[i]!) / CASH * 100)).toFixed(0) + ' | — |',
    '| **' + joinName('Hold your list equally') + '** | ' + bench.listJoin.map((b) => pct(b.finalTaxed)).join(' | ') + ' | ' + bench.listJoin.filter((b, i) => b.finalTaxed > q[i]!).length + ' | ' + Math.min(...bench.listJoin.map((b, i) => (b.finalTaxed - q[i]!) / CASH * 100)).toFixed(0) + ' | — |',
    ...rows.map((r) => '| ' + r.name + ' | ' + r.vals.map(pct).join(' | ') + ' | ' + r.beats + ' of 3 | ' + r.worst.toFixed(0) + ' | ' + r.trades + ' |'),
  ];
  out.push(...reportTable(bench, rows.map((r) => ({ name: r.name.replace(' | ', ', '), outcomes: r.outcomes })), inp.qqq, CASH));
  process.stdout.write(out.join('\n') + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
