/**
 * `node src/research/longHistoryAbCli.ts <priceDir> <reads2y> <readsFull>` (docs/LONG_HISTORY_PLAN.md A/B): the real
 * engine's daily reads with the 2-year chart window (production today; computeReads.ts) next to the same reads with
 * the full history from 2007 (computeReads.ts --full-history), for the research list, 2010 to the last price day.
 *
 * 1. How many ticker-days the reads change: the engine direction, each model's direction, the Buy tier
 *    (jobs/buy/buyPipeline.ts tierOf), the conviction, the timing.
 * 2. The portfolio results after the 25% tax (10 bps a side) for the same rule sets on both reads (the engine's exit
 *    read sees the same window as the reads), next to Hold QQQ and holding the list, each with its deepest fall.
 * Research only: no live code path changes; the live default stays the 2-year window.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadSeries, type PriceSeries } from '../backtest/data.ts';
import { PERIODS } from './lab.ts';
import { runPortfolio, type PortfolioInput, type PortfolioModel, type PortfolioOptions, type PortfolioResult } from './portfolioLab.ts';
import { OWNER_BAG } from './portfolioCli.ts';
import type { CompactRead } from './computeReads.ts';
import { benchmarksFor, type Bench } from './benchmarks.ts';
import { tierOf } from '../jobs/buy/buyPipeline.ts';
import { LABELS } from '../profile/labels.ts';

const CASH = 100_000;
const COST = 10;
const FROM = PERIODS[0]!.start;
const MODEL_NAMES = ['Engine', 'Broker Course', 'Schabacker', 'Edwards & Magee', 'Turtle'];

export const AB_RUNS: ReadonlyArray<{ readonly name: string; readonly m: PortfolioModel; readonly o: Omit<PortfolioOptions, 'cash'> }> = [
  { name: 'Engine + models (current), own sell rule, 5 slots', m: 'current', o: { slots: 5 } },
  { name: 'Engine alone, own sell rule, 5 slots', m: 'engine', o: { slots: 5 } },
  { name: 'Combo 2/3 (Turtle + Schabacker + E&M), 3 slots, 200-day sell', m: 'combo', o: { slots: 3, exit: 'trend', trendDays: 200 } },
];

const tier = (r: CompactRead): number => tierOf({ decision: r.ok === 1 && r.c != null, blocked: false, buyNow: r.tm === 'BUY_NOW', conviction: r.c });
const pp = (v: number): string => (v >= 0 ? '+' : '') + v.toFixed(0) + '%';
const ret = (x: { finalTaxed: number }): number => (x.finalTaxed / CASH - 1) * 100;
const fl = (v: number): string => '-' + v.toFixed(0) + '%';
const pctOf = (n: number, d: number): string => n + ' (' + (d ? (n / d * 100).toFixed(1) : '0.0') + '%)';

function loadReads(dir: string, t: string): Map<string, CompactRead> | null {
  const f = path.join(dir, t + '.reads.json');
  return fs.existsSync(f) ? new Map((JSON.parse(fs.readFileSync(f, 'utf8')) as CompactRead[]).map((r) => [r.d, r])) : null;
}

export interface ChangeCounts { days: number; engineDir: number; anyDir: number; perModel: number[]; tier: number; tier1: number; conviction: number; conviction5: number; timing: number }

export function countChanges(a: ReadonlyMap<string, CompactRead>, b: ReadonlyMap<string, CompactRead>, from: string, to: string): ChangeCounts {
  const c: ChangeCounts = { days: 0, engineDir: 0, anyDir: 0, perModel: MODEL_NAMES.map(() => 0), tier: 0, tier1: 0, conviction: 0, conviction5: 0, timing: 0 };
  for (const [d, x] of a) {
    const y = b.get(d);
    if (!y || d < from || d > to) continue;
    c.days++;
    if (x.dir[0] !== y.dir[0]) c.engineDir++;
    if (x.dir !== y.dir) c.anyDir++;
    for (let k = 0; k < MODEL_NAMES.length; k++) if (x.dir[k] !== y.dir[k]) c.perModel[k]!++;
    const ta = tier(x), tb = tier(y);
    if (ta !== tb) c.tier++;
    if ((ta === 1) !== (tb === 1)) c.tier1++;
    if (x.c !== y.c) c.conviction++;
    if (x.c != null && y.c != null && Math.abs(x.c - y.c) >= 5) c.conviction5++;
    if (x.tm !== y.tm) c.timing++;
  }
  return c;
}

function main(): void {
  const [priceDir, dirA, dirB] = process.argv.slice(2) as [string, string, string];
  if (!priceDir || !dirA || !dirB) throw new Error('usage: longHistoryAbCli <priceDir> <reads2y> <readsFull>');
  const series = new Map<string, PriceSeries>();
  const readsA = new Map<string, Map<string, CompactRead>>(), readsB = new Map<string, Map<string, CompactRead>>();
  for (const t of OWNER_BAG) {
    const a = loadReads(dirA, t), b = loadReads(dirB, t);
    if (!a || !b) continue;
    series.set(t, loadSeries(t, priceDir)); readsA.set(t, a); readsB.set(t, b);
  }
  const bag = OWNER_BAG.filter((t) => series.has(t));
  const qqq = loadSeries('QQQ', priceDir);
  const last = PERIODS[PERIODS.length - 1]!.end;
  const out: string[] = [];
  out.push('List: ' + bag.length + ' stocks (' + bag.join(', ') + '). Days ' + FROM + ' to ' + last + '; a ticker-day counts once both reads exist.', '');

  // 1. Changes
  out.push('### 1. Ticker-days whose read changes (2-year window vs full history)', '');
  out.push('| Period | Ticker-days | Engine direction | Any of the 5 directions | Buy tier (1/2/3) | In or out of tier 1 | Conviction (any) | Conviction by 5+ points | Entry timing |', '|---|---|---|---|---|---|---|---|---|');
  const sum = (from: string, to: string): ChangeCounts => {
    const tot = countChanges(new Map(), new Map(), from, to);
    for (const t of bag) {
      const c = countChanges(readsA.get(t)!, readsB.get(t)!, from, to);
      for (const k of ['days', 'engineDir', 'anyDir', 'tier', 'tier1', 'conviction', 'conviction5', 'timing'] as const) tot[k] += c[k];
      c.perModel.forEach((v, i) => { tot.perModel[i]! += v; });
    }
    return tot;
  };
  const rows: Array<[string, ChangeCounts]> = [...PERIODS.map((p) => [p.name, sum(p.start, p.end)] as [string, ChangeCounts]), ['**All**', sum(FROM, last)]];
  for (const [n, c] of rows) out.push('| ' + n + ' | ' + c.days + ' | ' + [c.engineDir, c.anyDir, c.tier, c.tier1, c.conviction, c.conviction5, c.timing].map((v) => pctOf(v, c.days)).join(' | ') + ' |');
  out.push('', '| Model direction | ' + PERIODS.map((p) => p.name).join(' | ') + ' | All |', '|---|---|---|---|---|');
  MODEL_NAMES.forEach((m, k) => out.push('| ' + m + ' | ' + rows.map(([, c]) => pctOf(c.perModel[k]!, c.days)).join(' | ') + ' |'));
  out.push('', '| Ticker | Ticker-days | Engine direction | Buy tier | Conviction by 5+ points |', '|---|---|---|---|---|');
  for (const t of bag) {
    const c = countChanges(readsA.get(t)!, readsB.get(t)!, FROM, last);
    out.push('| ' + t + ' | ' + c.days + ' | ' + pctOf(c.engineDir, c.days) + ' | ' + pctOf(c.tier, c.days) + ' | ' + pctOf(c.conviction5, c.days) + ' |');
  }

  // 2. Portfolios
  const inpA: PortfolioInput = { series, reads: readsA, qqq }, inpB: PortfolioInput = { series, reads: readsB, qqq };
  const b = benchmarksFor(bag, inpA, CASH, { costBps: COST });
  const fall = (xs: ReadonlyArray<{ maxDrawdownPct: number }>): number => Math.max(...xs.map((x) => x.maxDrawdownPct));
  out.push('', '### 2. Portfolio after the 25% tax ($100,000, 10 bps a side; deepest fall = largest fall from a high, before tax)', '');
  out.push('| Row | Chart | ' + PERIODS.map((p) => p.name).join(' | ') + ' | ' + PERIODS.map((p) => 'Fall ' + p.name).join(' | ') + ' | Trades |', '|---|---|---|---|---|---|---|---|---|');
  const yard = (n: string, x: Bench[]): string => '| 📊 ' + n + ' | — | ' + x.map((y) => pp(ret(y))).join(' | ') + ' | ' + x.map((y) => fl(y.maxDrawdownPct)).join(' | ') + ' | — |';
  out.push(yard('Hold QQQ', b.qqq), yard(LABELS.holdList, b.list), yard(LABELS.holdList + ' (join when listed)', b.listJoin));
  for (const r of AB_RUNS) {
    for (const [lab, inp, bars] of [['2 years', inpA, undefined], ['full history', inpB, Infinity]] as const) {
      const res: PortfolioResult[] = PERIODS.map((p) => runPortfolio(r.m, bag, inp, p.start, p.end, { cash: CASH, costBps: COST, ...r.o, ...(bars ? { chartBars: bars } : {}) }));
      out.push('| ' + r.name + ' | ' + lab + ' | ' + res.map((x) => pp(ret(x))).join(' | ') + ' | ' + res.map((x) => fl(x.maxDrawdownPct)).join(' | ') + ' | ' + res.reduce((a, x) => a + x.trades, 0) + ' |');
      process.stderr.write(r.name + ' / ' + lab + ' done (deepest ' + fl(fall(res)) + ')\n');
    }
  }
  process.stdout.write(out.join('\n') + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
