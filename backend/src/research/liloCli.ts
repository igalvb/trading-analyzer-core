/**
 * `node src/research/liloCli.ts <priceDir> <readsDir>`: LILO across the research list (liloBook.ts), with
 * 1, 2, 3, 5 or 14 ladders at a time, three periods, after tax, vs holding QQQ and holding the list.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadSeries, type PriceSeries } from '../backtest/data.ts';
import { PERIODS, holdLab } from './lab.ts';
import { holdBag, type PortfolioInput } from './portfolioLab.ts';
import { OWNER_BAG } from './portfolioCli.ts';
import { newLiloBook, liloDay, liloValue, type LiloBar, type LiloSignal, type LiloDayOptions } from './liloBook.ts';
import { layerTimeline, DEFAULT_LAYER_OPTIONS, type LayerOptions } from '../analysis/models/liloLayers.ts';
import type { PtSchedule } from '../analysis/models/profitTaking.ts';
import type { CompactRead } from './computeReads.ts';
import { benchmarksFor, benchRows, reportTable, type PeriodOutcome } from './benchmarks.ts';

const CASH = 100_000;
const pct = (v: number): string => ((v / CASH - 1) * 100 >= 0 ? '+' : '') + ((v / CASH - 1) * 100).toFixed(0) + '%';

/** The research read as a LILO buy signal: tier 1 with a ladder. */
export function liloSignalOf(r: CompactRead | undefined): LiloSignal | null {
  if (!r || r.ok !== 1 || r.c == null || !(r.tm === 'BUY_NOW' || r.c >= 70) || !r.lz || r.lz[0] == null || r.lz[1] == null) return null;
  return { rank: r.c + (r.tm === 'BUY_NOW' ? 1000 : 0), entryLow: r.lz[0], entryHigh: r.lz[1], entryCount: r.lz[2] ?? 1, t1: r.lz[3], t2: r.lz[4], stop: r.st };
}

/**
 * `pt` (plan 02, James — Profit-Taking): the current LILO's entries with the schedule at the LILO v2 layers in place of
 * T1 / T2 (liloDay's `profitTaking` option). Absent: today's results exactly.
 */
export function runLiloPortfolio(bag: readonly string[], inp: PortfolioInput, start: string, end: string, slots: number, costBps = 0,
  pt?: { readonly schedule: PtSchedule; readonly layerOptions?: LayerOptions }): { finalTaxed: number; maxDrawdownPct: number; trades: number; cashShareByDay: Map<string, number> } {
  const b = newLiloBook(CASH);
  const idx = new Map<string, Map<string, number>>([...bag, 'QQQ'].map((t) => { const s = t === 'QQQ' ? inp.qqq : (inp.series.get(t) as PriceSeries); return [t, new Map(s.dates.map((d, i) => [d, i]))]; }));
  const ser = (t: string): PriceSeries => (t === 'QQQ' ? inp.qqq : (inp.series.get(t) as PriceSeries));
  const days = inp.qqq.dates.filter((d) => d >= start && d <= end);
  let peak = CASH, dd = 0, trades = 0;
  const cashShareByDay = new Map<string, number>();
  const last = new Map<string, number>();
  for (let i = 0; i < days.length; i++) {
    const d = days[i] as string;
    const bars = new Map<string, LiloBar>();
    for (const t of bag) { const k = idx.get(t)!.get(d); if (k != null) { const s = ser(t); bars.set(t, { open: s.opens[k]!, high: s.highs[k]!, low: s.lows[k]!, close: s.closes[k]! }); last.set(t, s.closes[k]!); } }
    const qk = idx.get('QQQ')!.get(d)!;
    last.set('QQQ', inp.qqq.closes[qk]!);
    let signals: Map<string, LiloSignal> | null = null;
    if (i < days.length - 1) {
      signals = new Map();
      for (const t of bag) { const s = liloSignalOf(inp.reads.get(t)?.get(d)); if (s && bars.has(t)) signals.set(t, s); }
    }
    const opts: LiloDayOptions = pt ? { profitTaking: { schedule: pt.schedule, layersOf: (t) => { const k = idx.get(t)?.get(d); return k == null ? null : layerTimeline(ser(t), pt.layerOptions ?? DEFAULT_LAYER_OPTIONS)[k]?.levels ?? null; } } } : {};
    trades += liloDay(b, slots, bars, { open: inp.qqq.opens[qk]!, close: inp.qqq.closes[qk]! }, signals, true, costBps, opts).filter((x) => x.ticker !== 'QQQ').length;
    const v = liloValue(b, (t) => last.get(t) ?? null);
    peak = Math.max(peak, v); dd = Math.max(dd, (1 - v / peak) * 100);
    cashShareByDay.set(d, v > 0 ? Math.min(1, Math.max(0, b.cash) / v) : 1);
  }
  return { finalTaxed: liloValue(b, (t) => last.get(t) ?? null), maxDrawdownPct: dd, trades, cashShareByDay };
}

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
  const bench = benchmarksFor(bag, inp, CASH);
  const out = ['| LILO setup | ' + PERIODS.map((p) => p.name).join(' | ') + ' | Beats QQQ | Beats the list | Deepest fall | Stock trades |', '|---|---|---|---|---|---|---|---|',
    ...benchRows(bench, CASH, 1, ['', '', 'fall', ''])];
  const report: Array<{ name: string; outcomes: PeriodOutcome[] }> = [];
  for (const slots of [1, 2, 3, 5, 14]) {
    const r = PERIODS.map((p) => runLiloPortfolio(bag, inp, p.start, p.end, slots));
    const v = r.map((x) => x.finalTaxed);
    report.push({ name: 'LILO, ' + slots + (slots === 1 ? ' ladder' : ' ladders') + ' at a time', outcomes: r });
    out.push('| ' + slots + (slots === 1 ? ' ladder' : ' ladders') + ' at a time | ' + v.map(pct).join(' | ') + ' | ' + v.filter((x, i) => x > q[i]!).length + ' of 3 | ' + v.filter((x, i) => x > hb[i]!).length + ' of 3 | -' + Math.max(...r.map((x) => x.maxDrawdownPct)).toFixed(0) + '% | ' + r.reduce((a, x) => a + x.trades, 0) + ' |');
    process.stderr.write(slots + '\n');
  }
  out.push(...reportTable(bench, report, inp.qqq, CASH));
  process.stdout.write(out.join('\n') + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
