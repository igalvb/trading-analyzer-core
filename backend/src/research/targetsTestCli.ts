/**
 * Fix plan 2026-10-30 B1/D2, research only: today's exit-target rule (T1 = the BIGGEST confluence cluster) against
 * the variant (T1 = the NEAREST valid cluster at least 1 ATR above the entry, T2 the next one, excluded methods
 * skipped; techPlan/entryPlan.ts ExitTargetOptions.nearestTargets, default off).
 *
 *   node src/research/targetsTestCli.ts [--fixed-t2] <priceDir> <baseReadsDir> <nearReadsDir> <section> [costBps...]
 *
 * `--fixed-t2` (fix plan B1 option B part 2): the variant directory holds reads computed with `computeReads --fixed-t2`
 * (today's T1; T2 skips the methods the confluence excluded) and the tables call the variant "fixed T2".
 *
 * The two reads directories hold the research list computed with today's code by computeReads.ts, without and
 * with `--nearest-targets`. Sections (run in parallel, each prints markdown):
 *   changes    how often T1, T2, R:R, conviction, entry timing, the T1 time estimate and the Buy tier differ
 *   portfolio  the portfolio setups that use the engine (engine alone, engine + models, everything together)
 *   lilo       LILO (it buys and sells at the read's T1 / T2)
 *   lab        engine alone / engine + models trading each stock alone (a third sold at each target)
 * Every simulation: 2010-2019 / 2020-2023 / 2024-2026, after the 25% tax, against Hold QQQ and Hold the research list
 * (research/benchmarks.ts), with each costBps given (default 0 and 10).
 *
 * Sweep guard (research/guards.ts T1/T2): nothing is tuned here. The variant has one pre-registered form (1 ATR, the
 * existing 7% cluster width), the setups are the fixed ones from docs/V13_BACKTEST_RESULTS.md; 2010-2019 is the
 * in-sample period and 2020+ only checks.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadSeries, type PriceSeries } from '../backtest/data.ts';
import { PERIODS, runLab, holdLab, type LabModel } from './lab.ts';
import { runPortfolio, type PortfolioInput, type PortfolioModel, type PortfolioOptions } from './portfolioLab.ts';
import { OWNER_BAG } from './portfolioCli.ts';
import { runLiloPortfolio } from './liloCli.ts';
import { benchmarksFor, type Bench } from './benchmarks.ts';
import { tierOf } from '../jobs/buy/buyPipeline.ts';
import type { CompactRead } from './computeReads.ts';
import { LABELS } from '../profile/labels.ts';

const CASH = 100_000;
const pct = (v: number): string => ((v / CASH - 1) * 100 >= 0 ? '+' : '') + ((v / CASH - 1) * 100).toFixed(0) + '%';
const fall = (x: number): string => '-' + x.toFixed(0) + '%';
/** The variant's deepest fall minus today's, in points: positive = deeper. */
const deeper = (x: number): string => (Math.abs(x) < 0.05 ? 'same' : x > 0 ? x.toFixed(1) + ' deeper' : (-x).toFixed(1) + ' shallower');

type Reads = Map<string, Map<string, CompactRead>>;

function loadReads(dir: string): Reads {
  const out: Reads = new Map();
  for (const t of OWNER_BAG) {
    const f = path.join(dir, t + '.reads.json');
    if (fs.existsSync(f)) out.set(t, new Map((JSON.parse(fs.readFileSync(f, 'utf8')) as CompactRead[]).map((r) => [r.d, r])));
  }
  return out;
}

const tierOfRead = (r: CompactRead): 1 | 2 | 3 => tierOf({ decision: r.ok === 1 && r.c != null, blocked: false, buyNow: r.tm === 'BUY_NOW', conviction: r.c });
const differs = (a: number | null | undefined, b: number | null | undefined): boolean => (a == null) !== (b == null) || (a != null && b != null && Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(a)));
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s[Math.floor((s.length - 1) / 2)]! + s[Math.ceil((s.length - 1) / 2)]!) / 2 : NaN; };

/** Section "changes": per period and overall, how many recorded reads change. */
function changes(base: Reads, near: Reads): string[] {
  const rows: string[] = [];
  const spans = [...PERIODS, { name: 'All (2010-2026)', start: '2010-01-01', end: '2026-10-27' }];
  rows.push('| Reads | Days with a read | T1 differs | T2 differs | R:R to T1 differs | R:R under 1.0 (gate) current → variant | Conviction differs | Mean conviction change when it differs | Entry timing differs | T1 time estimate differs | Buy tier differs | Tier 1 days current → variant | Engine direction differs | 5-voice verdict differs |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  const t1Dist: { cur: number[]; var: number[] } = { cur: [], var: [] }, rr: { cur: number[]; var: number[] } = { cur: [], var: [] };
  const trans = new Map<string, number>();
  for (const sp of spans) {
    let n = 0, t1 = 0, t2 = 0, rrd = 0, rrLowB = 0, rrLowN = 0, cd = 0, cSum = 0, tm = 0, t1d = 0, tier = 0, tier1B = 0, tier1N = 0, dir = 0, v = 0;
    for (const t of OWNER_BAG) {
      const b = base.get(t), nn = near.get(t);
      if (!b || !nn) continue;
      for (const [d, rb] of b) {
        if (d < sp.start || d > sp.end) continue;
        const rn = nn.get(d);
        if (!rn || rb.ok !== 1 || rn.ok !== 1) continue;
        n++;
        if (differs(rb.lz?.[3], rn.lz?.[3])) t1++;
        if (differs(rb.lz?.[4], rn.lz?.[4])) t2++;
        if (differs(rb.rr, rn.rr)) rrd++;
        if (rb.rr != null && rb.rr < 1) rrLowB++;
        if (rn.rr != null && rn.rr < 1) rrLowN++;
        if (rb.c !== rn.c) { cd++; cSum += (rn.c ?? 0) - (rb.c ?? 0); }
        if (rb.tm !== rn.tm) tm++;
        if (differs(rb.t1d, rn.t1d)) t1d++;
        const tb = tierOfRead(rb), tn = tierOfRead(rn);
        if (tb !== tn) tier++;
        if (tb === 1) tier1B++;
        if (tn === 1) tier1N++;
        if (rb.dir[0] !== rn.dir[0]) dir++;
        if (rb.v !== rn.v) v++;
        if (sp.name.startsWith('All')) {
          if (tb !== tn) trans.set(tb + '→' + tn, (trans.get(tb + '→' + tn) ?? 0) + 1);
          if (rb.cl && rb.lz?.[3] != null) t1Dist.cur.push((rb.lz[3] / rb.cl - 1) * 100);
          if (rn.cl && rn.lz?.[3] != null) t1Dist.var.push((rn.lz[3] / rn.cl - 1) * 100);
          if (rb.rr != null) rr.cur.push(rb.rr);
          if (rn.rr != null) rr.var.push(rn.rr);
        }
      }
    }
    const p = (k: number): string => k + ' (' + (n ? ((k / n) * 100).toFixed(1) : '0') + '%)';
    rows.push('| ' + sp.name + ' | ' + n + ' | ' + p(t1) + ' | ' + p(t2) + ' | ' + p(rrd) + ' | ' + rrLowB + ' → ' + rrLowN + ' | ' + p(cd) + ' | ' + (cd ? (cSum / cd).toFixed(1) : '—') + ' | ' + p(tm) + ' | ' + p(t1d) + ' | ' + p(tier) + ' | ' + tier1B + ' → ' + tier1N + ' | ' + p(dir) + ' | ' + p(v) + ' |');
  }
  rows.push('', 'Buy tier moves (all days): ' + ([...trans].sort().map(([k, x]) => 'tier ' + k + ': ' + x).join(', ') || 'none') + '.',
    '', 'T1 above the day\'s close, median: current +' + median(t1Dist.cur).toFixed(1) + '%, variant +' + median(t1Dist.var).toFixed(1) + '%. R:R to T1 at the entry, median: current ' + median(rr.cur).toFixed(2) + ', variant ' + median(rr.var).toFixed(2) + '.');
  // the latest read of each stock, side by side
  rows.push('', '| Stock (last read) | Close | T1 current → variant | T2 current → variant | R:R current → variant | Conviction current → variant | Tier current → variant |', '|---|---|---|---|---|---|---|');
  const $ = (x: number | null | undefined): string => (x == null ? '—' : '$' + x.toFixed(2));
  for (const t of OWNER_BAG) {
    const b = base.get(t), nn = near.get(t);
    if (!b || !nn) continue;
    const d = [...b.keys()].sort().pop() as string, rb = b.get(d)!, rn = nn.get(d);
    if (!rn || rb.ok !== 1 || rn.ok !== 1) continue;
    const up = (x: number | null | undefined): string => (x == null || !rb.cl ? '' : ' (+' + ((x / rb.cl - 1) * 100).toFixed(0) + '%)');
    rows.push('| ' + t + ' ' + d + ' | ' + $(rb.cl) + ' | ' + $(rb.lz?.[3]) + up(rb.lz?.[3]) + ' → ' + $(rn.lz?.[3]) + up(rn.lz?.[3]) + ' | ' + $(rb.lz?.[4]) + ' → ' + $(rn.lz?.[4]) + ' | '
      + (rb.rr?.toFixed(2) ?? '—') + ' → ' + (rn.rr?.toFixed(2) ?? '—') + ' | ' + rb.c + ' → ' + rn.c + ' | ' + tierOfRead(rb) + ' → ' + tierOfRead(rn) + ' |');
  }
  return rows;
}

interface Outcome { readonly finals: number[]; readonly falls: number[]; readonly trades?: number }

/** The rules' labels in the tables (main switches them for `--fixed-t2`). */
const LABEL = { cur: 'current (biggest cluster)', variant: 'variant (nearest cluster)', diff: 'variant − current (points)' };

function table(title: string, bench: { qqq: Bench[]; list: Bench[]; listJoin: Bench[] }, rows: Array<{ name: string; cur: Outcome; nearest: Outcome }>): string[] {
  const out = ['', '#### ' + title, '', '| Setup | Rule | ' + PERIODS.map((p) => p.name).join(' | ') + ' | Deepest fall | Trades |', '|---|---|---|---|---|---|---|'];
  const bRow = (name: string, x: Bench[]): string => '| **' + name + '** | — | ' + x.map((y) => pct(y.finalTaxed)).join(' | ') + ' | ' + fall(Math.max(...x.map((y) => y.maxDrawdownPct))) + ' | — |';
  out.push(bRow('Hold QQQ', bench.qqq), bRow(LABELS.holdList, bench.list), bRow(LABELS.holdList + ' (join when listed)', bench.listJoin));
  for (const r of rows) {
    for (const [rule, o] of [[LABEL.cur, r.cur], [LABEL.variant, r.nearest]] as Array<[string, Outcome]>) {
      out.push('| ' + r.name + ' | ' + rule + ' | ' + o.finals.map(pct).join(' | ') + ' | ' + fall(Math.max(...o.falls)) + ' | ' + (o.trades ?? '—') + ' |');
    }
    out.push('| ' + r.name + ' | ' + LABEL.diff + ' | ' + r.nearest.finals.map((v, i) => { const x = ((v - r.cur.finals[i]!) / CASH) * 100; return (x >= 0 ? '+' : '') + x.toFixed(1); }).join(' | ')
      + ' | ' + deeper(Math.max(...r.nearest.falls) - Math.max(...r.cur.falls)) + ' | |');
  }
  return out;
}

const PORTFOLIO_SETUPS: Array<[string, PortfolioModel, Omit<PortfolioOptions, 'cash'>]> = [
  ['Engine alone, 3 stocks, 200-day break', 'engine', { slots: 3, exit: 'trend', trendDays: 200 }],
  ['Engine alone, 5 stocks, own sell rule', 'engine', { slots: 5 }],
  ['Engine + models (current), 5 stocks, 200-day break', 'current', { slots: 5, exit: 'trend', trendDays: 200 }],
  ['Engine + models (current), 5 stocks, own sell rule', 'current', { slots: 5 }],
  ['Everything together (engine OR 2 of 3), 3 stocks, 200-day break', 'best', { slots: 3, exit: 'trend', trendDays: 200 }],
];

function main(): void {
  const argv = process.argv.slice(2);
  const fixedT2 = argv.includes('--fixed-t2');
  if (fixedT2) Object.assign(LABEL, { cur: 'current T2', variant: 'fixed T2 (excluded methods skipped)', diff: 'fixed − current (points)' });
  const [priceDir, baseDir, nearDir, section, ...costArgs] = argv.filter((a) => a !== '--fixed-t2') as [string, string, string, string, ...string[]];
  const costs = costArgs.length ? costArgs.map(Number) : [0, 10];
  const base = loadReads(baseDir), near = loadReads(nearDir);
  const series = new Map<string, PriceSeries>();
  for (const t of OWNER_BAG) if (base.has(t)) series.set(t, loadSeries(t, priceDir));
  const bag = OWNER_BAG.filter((t) => series.has(t) && near.has(t));
  const qqq = loadSeries('QQQ', priceDir);
  const inpB: PortfolioInput = { series, reads: base, qqq }, inpN: PortfolioInput = { series, reads: near, qqq };
  const out: string[] = [];
  if (section === 'changes') out.push(...changes(base, near));
  for (const cost of section === 'changes' ? [] : costs) {
    const bench = benchmarksFor(bag, inpB, CASH, { costBps: cost });
    const label = 'costBps ' + cost;
    if (section === 'portfolio') {
      const rows = PORTFOLIO_SETUPS.map(([name, m, o]) => {
        const run = (inp: PortfolioInput): Outcome => { const r = PERIODS.map((p) => runPortfolio(m, bag, inp, p.start, p.end, { cash: CASH, costBps: cost, ...o })); return { finals: r.map((x) => x.finalTaxed), falls: r.map((x) => x.maxDrawdownPct), trades: r.reduce((a, x) => a + x.trades, 0) }; };
        process.stderr.write(name + ' ' + label + '\n');
        return { name, cur: run(inpB), nearest: run(inpN) };
      });
      out.push(...table('Portfolio on ' + LABELS.list + ', ' + label, bench, rows));
    } else if (section === 'lilo') {
      const rows = [3, 5].map((slots) => {
        const run = (inp: PortfolioInput): Outcome => { const r = PERIODS.map((p) => runLiloPortfolio(bag, inp, p.start, p.end, slots, cost)); return { finals: r.map((x) => x.finalTaxed), falls: r.map((x) => x.maxDrawdownPct), trades: r.reduce((a, x) => a + x.trades, 0) }; };
        return { name: 'LILO, ' + slots + ' ladders at a time', cur: run(inpB), nearest: run(inpN) };
      });
      out.push(...table('LILO on ' + LABELS.list + ', ' + label, bench, rows));
    } else if (section.startsWith('lab')) {
      // each stock alone, money not in the stock in QQQ (owner 2026-10-28); stocks listed the whole period
      const models = (section.split(':')[1] ?? 'engine,current').split(',') as LabModel[];
      const rows = models.map((m) => {
        const run = (reads: Reads, variant: boolean): Outcome => {
          const finals: number[] = [], falls: number[] = [];
          for (const p of PERIODS) {
            const vals: number[] = [], dds: number[] = [];
            for (const t of bag) {
              const s = series.get(t)!;
              if (holdLab(s, p.start, p.end, CASH) == null || !s.dates.some((d) => d <= p.start)) continue;
              const r = runLab(m, s, reads.get(t)!, p.start, p.end, CASH, qqq, { costBps: cost, ...(variant ? (fixedT2 ? { fixedT2: true } : { nearestTargets: true }) : {}) });
              vals.push(r.finalTaxed); dds.push(r.maxDrawdownPct);
            }
            finals.push(vals.reduce((a, b) => a + b, 0) / vals.length); falls.push(median(dds));
            process.stderr.write(m + ' ' + p.name + ' ' + label + (variant ? ' variant' : ' current') + '\n');
          }
          return { finals, falls };
        };
        return { name: (m === 'engine' ? 'Engine alone' : 'Engine + models (current)') + ', each stock alone (average; fall = median of the stocks)', cur: run(base, false), nearest: run(near, true) };
      });
      out.push(...table('Each stock alone (spare money in QQQ), ' + label, bench, rows));
    }
  }
  process.stdout.write(out.join('\n') + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
