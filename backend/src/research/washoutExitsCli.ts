/**
 * `node src/research/washoutExitsCli.ts <priceDir> <readsDir> [--end=YYYY-MM-DD] [--signals=D1,D2] [--today=T1,T2,...]`
 * (research only, owner 2026-11-07 b): the rarer exits X1-X4 of research/washoutRotationLab.ts on R and RW, against
 * 📊 Hold QQQ and 📊 Hold the list, plus the W1/W2/W3 signals on the given days and the rotation weights at the last
 * bar. Prints the markdown of "Rarer exits (2026-11-07 b)" in docs/RESEARCH_WASHOUT_ROTATION_2026-11-07.md.
 * --end moves the end of the 2024-26 period and of the continuous run (default: the last QQQ bar); the price-only rules
 * need no engine reads.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadSeries, type PriceSeries } from '../backtest/data.ts';
import { holdBag, type PortfolioInput } from './portfolioLab.ts';
import { OWNER_BAG } from './portfolioCli.ts';
import { holdCurve } from './benchmarks.ts';
import { PERIODS } from './lab.ts';
import { windows } from './windowsCli.ts';
import type { CompactRead } from './computeReads.ts';
import { LABELS } from '../profile/labels.ts';
import { run, indOf, washoutAt, tiersAt, normalise, qualified, bottomThirdRet, closeForZ, WASHOUTS, X1_FALL_BARS, type Rule, type RunResult, type ExitRule, type WashoutKey, type Ind } from './washoutRotationLab.ts';

const CASH = 100_000, COST = 10;
const pp = (v: number): string => (v >= 0 ? '+' : '') + v.toFixed(0) + '%';
const pct1 = (v: number): string => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%' : '—');
const median = (x: readonly number[]): number => { const a = [...x].sort((p, q) => p - q); const n = a.length; return n ? (n % 2 ? a[(n - 1) / 2]! : (a[n / 2 - 1]! + a[n / 2]!) / 2) : NaN; };
const opt = (k: string): string | undefined => process.argv.find((a) => a.startsWith('--' + k + '='))?.slice(k.length + 3);

function main(): void {
  const [priceDir, readsDir] = process.argv.slice(2).filter((a) => !a.startsWith('--')) as [string, string];
  const series = new Map<string, PriceSeries>(), reads = new Map<string, Map<string, CompactRead>>();
  for (const t of OWNER_BAG) {
    if (!fs.existsSync(path.join(priceDir, t + '.json'))) continue;
    series.set(t, loadSeries(t, priceDir));
    const f = path.join(readsDir, t + '.reads.json');
    reads.set(t, fs.existsSync(f) ? new Map((JSON.parse(fs.readFileSync(f, 'utf8')) as CompactRead[]).map((r) => [r.d, r])) : new Map());
  }
  const bag = OWNER_BAG.filter((t) => series.has(t));
  const qqq = loadSeries('QQQ', priceDir);
  const inp: PortfolioInput = { series, reads, qqq };
  const lab = { series, qqq, bag };
  const bagSeries = bag.map((t) => series.get(t)!);
  const lastBar = qqq.dates[qqq.dates.length - 1]!;
  const end = opt('end') ?? lastBar;
  const periods = PERIODS.map((p, k) => (k === PERIODS.length - 1 ? { ...p, end } : p));
  const fullStart = periods[0]!.start;

  const exitNames: Record<ExitRule, string> = {
    base: 'old exit (150-day falling 2 months + bottom third 3 rebalances)',
    X1: 'X1 (150-day falling 6+ months + weekly close under 40-week)',
    X2: 'X2 (X1, only lots in profit)',
    X3: 'X3 (no exits)',
    X4: 'X4 (12-month return bottom third 4 quarters + 150-day falling)',
  };
  const rows: Array<{ name: string; rule: Rule }> = [];
  for (const w of [false, true]) for (const x of ['base', 'X1', 'X2', 'X3', 'X4'] as ExitRule[]) rows.push({ name: (w ? 'RW' : 'R') + ', ' + exitNames[x], rule: { kind: 'rotation', speed: 'R', trims: false, washout: w, exit: x } });

  const bench = (s: string, e: string) => {
    const days = qqq.dates.filter((d) => d >= s && d <= e);
    return {
      q: holdCurve([qqq], days, CASH, { costBps: COST }),
      l: { ...holdCurve(bagSeries, days, CASH, { costBps: COST }), finalTaxed: holdBag(bag, inp, s, e, CASH, COST) },
      j: holdCurve(bagSeries, days, CASH, { costBps: COST, join: true }),
    };
  };
  type B = ReturnType<typeof bench>;
  const ret = (o: { finalTaxed: number }): number => (o.finalTaxed / CASH - 1) * 100;
  const beats = (o: { finalTaxed: number }, b: B): boolean => o.finalTaxed > b.q.finalTaxed && o.finalTaxed > b.l.finalTaxed && o.finalTaxed > b.j.finalTaxed;
  const ws = windows(2010, 2021, [4]);
  const pb = periods.map((p) => bench(p.start, p.end)), wb = ws.map((w) => bench(w.start, w.end)), fb = bench(fullStart, end);
  const res = rows.map((r) => {
    const o = { cash: CASH, costBps: COST };
    const x = { per: periods.map((p) => run(r.rule, lab, p.start, p.end, o)), win: ws.map((w) => run(r.rule, lab, w.start, w.end, o)), full: run(r.rule, lab, fullStart, end, o) };
    process.stderr.write(r.name + '\n');
    return x;
  });

  const next12 = (f: RunResult): Array<[number, number]> => f.exits.flatMap((e) => {
    const s = series.get(e.t)!, i = s.dates.indexOf(e.date), qi = qqq.dates.indexOf(e.date);
    return i + 252 < s.dates.length && qi + 252 < qqq.dates.length ? [[s.closes[i + 252]! / e.price - 1, qqq.closes[qi + 252]! / qqq.opens[qi]! - 1] as [number, number]] : [];
  });

  const out: string[] = [];
  out.push('### B1. Main table, rarer exits', '',
    'After the 25% tax and 10 bps per side, $100,000 at the start of each period. Periods: ' + periods.map((p) => p.name + ' (' + p.start + ' to ' + p.end + ')').join(', ') + '. ✅ = above 📊 Hold QQQ and both 📊 ' + LABELS.holdList + ' variants. 4-yr windows: the 9 windows 2010-13 ... 2018-21. Deepest fall: the largest in the three periods (before tax). Tax paid, turnover, holding days and exits: one continuous run ' + fullStart + ' to ' + end + '. Exits with 12 months after: median next-12-month return of the sold stock vs QQQ over the same 12 months, and how many of them did worse than QQQ.', '',
    '| Row | 2010-19 | 2020-23 | 2024-26 | 4-yr windows beating both | Deepest fall | Tax paid on the way | Turnover / yr | Median holding days | Exits (continuous) | Sold stock next 12m (median) | QQQ same 12m (median) | Sold stock worse than QQQ |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  const benchRow = (name: string, k: 'q' | 'l' | 'j'): string => '| 📊 ' + name + ' | ' + pb.map((b) => pp(ret(b[k]))).join(' | ') + ' | — | -' + Math.max(...pb.map((b) => b[k].maxDrawdownPct)).toFixed(0) + '% | 0% | 0% | whole period | 0 | — | — | — |';
  out.push(benchRow('Hold QQQ', 'q'), benchRow(LABELS.holdList, 'l'), benchRow(LABELS.holdList + ' (join when listed)', 'j'));
  rows.forEach((r, ri) => {
    const x = res[ri]!, f = x.full, a = next12(f), part = f.exits.filter((e) => e.partial).length;
    out.push('| ' + r.name + ' | ' + x.per.map((o, k) => (beats(o, pb[k]!) ? '✅ ' : '') + pp(ret(o))).join(' | ') + ' | ' + ws.filter((_, k) => beats(x.win[k]!, wb[k]!)).length + '/' + ws.length
      + ' | -' + Math.max(...x.per.map((o) => o.maxDrawdownPct)).toFixed(0) + '% | ' + (f.taxPaid / f.finalPreTax * 100).toFixed(1) + '% | ' + (f.stockSold / f.avgEquity / f.years * 100).toFixed(0) + '% | '
      + (f.holdDays.length ? median(f.holdDays).toFixed(0) : '—') + ' | ' + f.exits.length + (part ? ' (' + part + ' partial)' : '') + ' | '
      + (a.length ? pct1(median(a.map((y) => y[0]))) + ' (' + a.length + ')' : '—') + ' | ' + (a.length ? pct1(median(a.map((y) => y[1]))) : '—') + ' | ' + (a.length ? a.filter((y) => y[0] < y[1]).length + ' of ' + a.length : '—') + ' |');
  });
  out.push('', 'Continuous run ' + fullStart + ' to ' + end + ' (after tax): 📊 Hold QQQ ' + pp(ret(fb.q)) + ', 📊 ' + LABELS.holdList + ' ' + pp(ret(fb.l)) + ', join when listed ' + pp(ret(fb.j)) + '; ' + rows.map((r, ri) => r.name + ' ' + pp(ret(res[ri]!.full))).join('; ') + '.');

  // exits of the RW variants
  out.push('', '### B2. Every exit of RW under X1, X2 and X4 (continuous run ' + fullStart + ' to ' + end + ')', '',
    '| Rule | Ticker | Exit date (fill at the open) | Exit price | Sold stock next 12 months | QQQ same 12 months |', '|---|---|---|---|---|---|');
  rows.forEach((r, ri) => {
    const ex = (r.rule as { exit: ExitRule; washout: boolean });
    if (!ex.washout || !['X1', 'X2', 'X4'].includes(ex.exit)) return;
    const f = res[ri]!.full;
    if (!f.exits.length) out.push('| ' + ex.exit + ' | (none) | | | | |');
    for (const e of f.exits) {
      const s = series.get(e.t)!, i = s.dates.indexOf(e.date), qi = qqq.dates.indexOf(e.date), ok = i + 252 < s.dates.length && qi + 252 < qqq.dates.length;
      out.push('| ' + ex.exit + ' | ' + e.t + (e.partial ? ' (lots in profit only)' : '') + ' | ' + e.date + ' | ' + e.price.toFixed(2) + ' | ' + (ok ? pct1(s.closes[i + 252]! / e.price - 1) : 'under 12 months of data') + ' | ' + (ok ? pct1(qqq.closes[qi + 252]! / qqq.opens[qi]! - 1) : '—') + ' |');
    }
  });

  // signals on the given days
  const sigDays = (opt('signals') ?? lastBar).split(',').filter(Boolean);
  const today = (opt('today') ?? '').split(',').filter(Boolean);
  out.push('', '### B3. Did W1 / W2 / W3 fire? (real bars of ' + sigDays.join(' and ') + ')', '',
    '| Day | Ticker | Close | Day change | z vs 20-day avg | Off 252-day high | 150-day avg vs 20 bars ago | W1 | W2 | W3 | Close that fires W1 next bar | Close that fires W2 next bar |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const d of sigDays) for (const t of today) {
    const s = series.get(t); if (!s) { out.push('| ' + d + ' | ' + t + ' | no data |||||||||'); continue; }
    const ind = indOf(s), i = ind.idx.get(d); if (i == null) { out.push('| ' + d + ' | ' + t + ' | no bar |||||||||'); continue; }
    const yn = (k: WashoutKey): string => (washoutAt(ind, i, WASHOUTS[k]) ? 'YES' : 'no');
    const r150 = ind.dir150[i] === 1 ? 'rising' : ind.dir150[i] === -1 ? 'falling' : 'flat';
    const fire = (sd: number, off: number): string => '$' + Math.min(closeForZ(s, i, sd), (1 - off) * ind.hi252[i]!).toFixed(2);
    out.push('| ' + d + ' | ' + t + ' | ' + s.closes[i]!.toFixed(2) + ' | ' + pct1(s.closes[i]! / s.closes[i - 1]! - 1) + ' | ' + ind.z[i]!.toFixed(2) + ' | ' + pct1(s.closes[i]! / ind.hi252[i]! - 1) + ' | ' + r150 + ' | ' + yn('W1') + ' | ' + yn('W2') + ' | ' + yn('W3') + ' | ' + fire(2.5, 0.2) + ' | ' + fire(2.0, 0.15) + ' |');
  }

  // weights and exit status at the last bar
  const q = indOf(qqq);
  const atLast = (t: string): { ind: Ind; i: number } | null => { const ind = indOf(series.get(t)!); const i = ind.idx.get(lastBar); return i == null ? null : { ind, i }; };
  const tw = (['R', 'RB', 'RS'] as const).map((sp) => { const tg = tiersAt(sp, bag, atLast, q); return { tier: tg.tier, w: normalise(tg.tier) }; });
  const bottom = bottomThirdRet(bag, atLast);
  out.push('', '### B4. Rotation weights and exit status at the last bar (' + lastBar + ')', '',
    'Untouched tier weights (top third 2x, middle 1x, bottom 0.5x, normalised). "150-day falling" = bars in a row with the 150-day average under its value 20 bars earlier (X1 needs ' + X1_FALL_BARS + '). "Under 40-week" = the last close under the average of the last 40 weekly closes. X4 bottom third = the 252-bar return in the bottom third today (X4 needs 4 quarter ends in a row).', '',
    '| Ticker | 150-day avg rising 3 months ago | R tier | R weight | RB tier | RB weight | RS tier | RS weight | 150-day falling (bars) | Under 40-week | 12-month return | X4 bottom third today |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const t of bag) {
    const x = atLast(t), ql = x ? qualified(x.ind, x.i) : null;
    const w40 = x ? x.ind.w40[x.ind.weeksDone[x.i]! - 1] : null;
    const extra = x ? [String(x.ind.fallRun[x.i]), w40 == null ? '—' : x.ind.s.closes[x.i]! < w40 ? 'yes' : 'no', x.i >= 252 ? pct1(x.ind.s.closes[x.i]! / x.ind.s.closes[x.i - 252]! - 1) : '—', bottom.has(t) ? 'yes' : 'no'] : ['—', '—', '—', '—'];
    out.push('| ' + t + ' | ' + (ql == null ? 'not enough history' : ql ? 'yes' : 'no') + ' | ' + tw.map((m) => (m.tier.has(t) ? m.tier.get(t) + 'x | ' + (m.w.get(t)! * 100).toFixed(1) + '%' : '— | 0%')).join(' | ') + ' | ' + extra.join(' | ') + ' |');
  }
  process.stdout.write(out.join('\n') + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
