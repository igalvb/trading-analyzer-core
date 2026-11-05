/**
 * `node src/research/labCli.ts <priceDir> <readsDir>`: every lab model on every stock alone, in each period, vs
 * holding the stock and holding QQQ (all after the 25% tax). Prints plain markdown tables.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadSeries, type PriceSeries } from '../backtest/data.ts';
import { LAB_MODELS, LAB_LABEL, PERIODS, runLab, holdLab, type LabModel } from './lab.ts';
import type { CompactRead } from './computeReads.ts';
import { benchmarksFor } from './benchmarks.ts';
import { OWNER_BAG } from './portfolioCli.ts';

const CASH = 100_000;
const pct = (v: number): string => ((v / CASH - 1) * 100 >= 0 ? '+' : '') + ((v / CASH - 1) * 100).toFixed(1) + '%';
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s[Math.floor((s.length - 1) / 2)]! + s[Math.ceil((s.length - 1) / 2)]!) / 2 : NaN; };

export function labReport(priceDir: string, readsDir: string, idleInQqq = false): string {
  const files = fs.readdirSync(readsDir).filter((f) => f.endsWith('.reads.json')).sort();
  const qqq = loadSeries('QQQ', priceDir);
  const out: string[] = [];
  const ownSeries = new Map(OWNER_BAG.filter((t) => fs.existsSync(path.join(priceDir, t + '.json'))).map((t) => [t, loadSeries(t, priceDir)]));
  const bm = benchmarksFor([...ownSeries.keys()], { series: ownSeries, reads: new Map(), qqq }, CASH);
  const allPeriods: Record<string, { beatQ: number; n: number }> = {};
  for (const [pi, p] of PERIODS.entries()) {
    const q = holdLab(qqq, p.start, p.end, CASH) as number;
    const rows: Record<string, { vals: number[]; beatHold: number; beatQ: number; beatQ20: number; buys: number; inv: number[] }> = {};
    const holds: number[] = [];
    let n = 0;
    for (const f of files) {
      const t = f.replace('.reads.json', '').replace(/^_/, '^');
      const s: PriceSeries = loadSeries(t, priceDir);
      const hold = holdLab(s, p.start, p.end, CASH);
      if (hold == null || !s.dates.some((d) => d <= p.start)) continue; // only stocks listed for the whole period
      const reads = new Map<string, CompactRead>((JSON.parse(fs.readFileSync(path.join(readsDir, f), 'utf8')) as CompactRead[]).map((r) => [r.d, r]));
      n++; holds.push(hold);
      for (const m of LAB_MODELS) {
        const r = runLab(m as LabModel, s, reads, p.start, p.end, CASH, idleInQqq ? qqq : undefined);
        const row = (rows[m] ??= { vals: [], beatHold: 0, beatQ: 0, beatQ20: 0, buys: 0, inv: [] });
        row.vals.push(r.finalTaxed); row.buys += r.buys; row.inv.push(r.investedPct);
        if (r.finalTaxed > hold) row.beatHold++;
        if (r.finalTaxed > q) row.beatQ++;
        if (r.finalTaxed > q + 0.2 * CASH) row.beatQ20++;
        const k = m + '|' + t;
        (allPeriods[k] ??= { beatQ: 0, n: 0 }).n++;
        if (r.finalTaxed > q) allPeriods[k]!.beatQ++;
      }
    }
    const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    out.push('', '### ' + p.name + ' (' + n + ' stocks listed the whole period; hold QQQ ' + pct(q) + ' (deepest fall -' + bm.qqq[pi]!.maxDrawdownPct.toFixed(0) + '%), hold your list equally ' + pct(bm.list[pi]!.finalTaxed) + ' (-' + bm.list[pi]!.maxDrawdownPct.toFixed(0) + '%), hold the stock: average ' + pct(avg(holds)) + ', median ' + pct(median(holds)) + ')', '',
      '| Model | Average | Median | Beat holding the stock | Beat holding QQQ | Beat QQQ by 20%+ of the start | Buys | In the stock |', '|---|---|---|---|---|---|---|---|');
    for (const m of LAB_MODELS) {
      const r = rows[m]!;
      out.push('| ' + LAB_LABEL[m as LabModel] + ' | ' + pct(avg(r.vals)) + ' | ' + pct(median(r.vals)) + ' | ' + r.beatHold + ' of ' + n + ' | ' + r.beatQ + ' of ' + n + ' | ' + r.beatQ20 + ' of ' + n + ' | ' + r.buys + ' | ' + avg(r.inv).toFixed(0) + '% |');
    }
  }
  const consistent = LAB_MODELS.map((m) => {
    const ks = Object.entries(allPeriods).filter(([k, v]) => k.startsWith(m + '|') && v.n === PERIODS.length);
    return '| ' + LAB_LABEL[m as LabModel] + ' | ' + ks.filter(([, v]) => v.beatQ === PERIODS.length).length + ' of ' + ks.length + ' |';
  });
  out.push('', '### Beat holding QQQ in ALL three periods (stocks listed in all three)', '', '| Model | Stocks |', '|---|---|', ...consistent);
  return out.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [priceDir, readsDir, mode] = process.argv.slice(2);
  const idle = mode === '--idle-qqq';
  process.stdout.write('Each model trading each stock ALONE, all money in, after the 25% tax' + (idle ? '; money not in the stock is held in QQQ (never in cash)' : '') + '.\n'
    + labReport(priceDir as string, readsDir as string, idle) + '\n');
}
