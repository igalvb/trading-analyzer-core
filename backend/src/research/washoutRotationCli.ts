/**
 * `node src/research/washoutRotationCli.ts <priceDir> <readsDir> [--today=T1,T2,...]` (research only, owner
 * 2026-11-07): the washout buys and the in-list rotation of research/washoutRotationLab.ts on the research list,
 * against 📊 Hold QQQ, 📊 Hold the list, Trend 150, Trend 200 and Combo 2 of 3 (research/portfolioLab.ts, the setups of
 * research/windowsCli.ts). Prints the markdown of docs/RESEARCH_WASHOUT_ROTATION_2026-11-07.md (sections 1-5).
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadSeries, type PriceSeries } from '../backtest/data.ts';
import { runPortfolio, holdBag, type PortfolioInput, type PortfolioModel, type PortfolioOptions } from './portfolioLab.ts';
import { OWNER_BAG } from './portfolioCli.ts';
import { holdCurve } from './benchmarks.ts';
import { PERIODS } from './lab.ts';
import { windows } from './windowsCli.ts';
import type { CompactRead } from './computeReads.ts';
import { LABELS } from '../profile/labels.ts';
import { run, signalStats, indOf, washoutAt, tiersAt, normalise, closeForZ, qualified, WASHOUTS, type Rule, type RunResult, type Speed, type WashoutKey } from './washoutRotationLab.ts';

const CASH = 100_000, COST = 10;
interface Out { readonly finalTaxed: number; readonly maxDrawdownPct: number }
interface Row { readonly name: string; readonly ref?: boolean; readonly run: (s: string, e: string) => Out; readonly lab?: Rule }

const pp = (v: number): string => (v >= 0 ? '+' : '') + v.toFixed(0) + '%';
const ret = (o: Out): number => (o.finalTaxed / CASH - 1) * 100;
const pct1 = (v: number): string => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%' : '—');
const median = (x: readonly number[]): number => { const a = [...x].sort((p, q) => p - q); const n = a.length; return n ? (n % 2 ? a[(n - 1) / 2]! : (a[n / 2 - 1]! + a[n / 2]!) / 2) : NaN; };

function main(): void {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const [priceDir, readsDir] = args as [string, string];
  const today = (process.argv.find((a) => a.startsWith('--today='))?.slice(8) ?? '').split(',').filter(Boolean);
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
  const fullStart = PERIODS[0]!.start, fullEnd = PERIODS[PERIODS.length - 1]!.end;

  const pf = (m: PortfolioModel, o: Partial<PortfolioOptions>) => (s: string, e: string): Out => runPortfolio(m, bag, inp, s, e, { slots: 3, cash: CASH, costBps: COST, ...o });
  const L = (name: string, r: Rule): Row => ({ name, lab: r, run: (s, e) => run(r, lab, s, e, { cash: CASH, costBps: COST }) });
  const rot = (speed: Speed, trims: boolean, washout: boolean): Rule => ({ kind: 'rotation', speed, trims, washout });
  const wsh = (signal: WashoutKey, exit: 'C' | 'D'): Rule => ({ kind: 'washout', signal, exit });
  const rows: Row[] = [
    { name: 'Trend 150 (3)', ref: true, run: pf('trend', { trendDays: 150 }) },
    { name: 'Trend 200 (3)', ref: true, run: pf('trend', { trendDays: 200 }) },
    { name: 'Combo 2 of 3 (3, 200-day sell)', ref: true, run: pf('combo', { exit: 'trend', trendDays: 200 }) },
    L('**W1C** washout, weekly-40 + falling-150 exit (primary)', wsh('W1', 'C')),
    L('W1D washout, never sell on price', wsh('W1', 'D')),
    L('W2C (2.0 SD, 15% off), exit C', wsh('W2', 'C')),
    L('W3C (W1 without the 150-day filter), exit C', wsh('W3', 'C')),
    L('R rotation, long speed', rot('R', false, false)),
    L('RB rotation, rebound speed', rot('RB', false, false)),
    L('RS rotation, short speed', rot('RS', false, false)),
    L('RS-w rotation, short speed weekly', rot('RSw', false, false)),
    L('RW = R + W1 buys', rot('R', false, true)),
    L('RBW = RB + W1 buys', rot('RB', false, true)),
    L('RSW = RS + W1 buys', rot('RS', false, true)),
    L('R, trims allowed', rot('R', true, false)),
    L('RB, trims allowed', rot('RB', true, false)),
    L('RS, trims allowed', rot('RS', true, false)),
    L('RS-w, trims allowed', rot('RSw', true, false)),
    L('RW, trims allowed', rot('R', true, true)),
    L('RBW, trims allowed', rot('RB', true, true)),
    L('RSW, trims allowed', rot('RS', true, true)),
  ];

  const bench = (s: string, e: string) => {
    const days = qqq.dates.filter((d) => d >= s && d <= e);
    return {
      q: holdCurve([qqq], days, CASH, { costBps: COST }),
      l: { ...holdCurve(bagSeries, days, CASH, { costBps: COST }), finalTaxed: holdBag(bag, inp, s, e, CASH, COST) },
      j: holdCurve(bagSeries, days, CASH, { costBps: COST, join: true }),
    };
  };
  const ws = windows(2010, 2021, [1, 2, 4]);
  const pb = PERIODS.map((p) => bench(p.start, p.end)), wb = ws.map((w) => bench(w.start, w.end));
  const beats = (o: Out, b: ReturnType<typeof bench>): boolean => o.finalTaxed > b.q.finalTaxed && o.finalTaxed > b.l.finalTaxed && o.finalTaxed > b.j.finalTaxed;

  const res = rows.map((r) => {
    const per = PERIODS.map((p) => r.run(p.start, p.end));
    const win = ws.map((w) => r.run(w.start, w.end));
    const full = r.lab ? run(r.lab, lab, fullStart, fullEnd, { cash: CASH, costBps: COST }) : null;
    process.stderr.write(r.name + '\n');
    return { per, win, full };
  });
  const fb = bench(fullStart, fullEnd);

  const out: string[] = [];
  const cnt = (ri: number, n: number): string => { const ks = ws.map((w, k) => (w.years === n ? k : -1)).filter((k) => k >= 0); return ks.filter((k) => beats(res[ri]!.win[k]!, wb[k]!)).length + '/' + ks.length; };
  const stats = (f: RunResult | null): string[] => (f ? [
    (f.taxPaid / f.finalPreTax * 100).toFixed(1) + '%',
    (f.stockSold / f.avgEquity / f.years * 100).toFixed(0) + '%',
    f.holdDays.length ? median(f.holdDays).toFixed(0) : '—',
  ] : ['—', '—', '—']);
  out.push('## 1. Main table', '',
    'After the 25% tax and 10 bps per side, $100,000 at the start of each period. Periods: ' + PERIODS.map((p) => p.name + ' (' + p.start + ' to ' + p.end + ')').join(', ') + '. ✅ = above 📊 Hold QQQ and both 📊 ' + LABELS.holdList + ' variants in that period. "4-yr windows" = of the 9 four-year windows 2010-13 ... 2018-21 (fresh $100,000 each), how many it beat both. Deepest fall = the largest fall from a high in any of the three periods (before tax). Tax paid, turnover and holding days come from one continuous run ' + fullStart + ' to ' + fullEnd + ': tax paid on sales along the way as a % of the final pre-tax value; turnover = stock sold a year / average account value; median holding days = calendar days from a position\'s first buy to its full sale (or to the end, still held).', '',
    '| Row | 2010-19 | 2020-23 | 2024-26 | 4-yr windows beating both | Deepest fall | Tax paid on the way | Turnover / yr | Median holding days |', '|---|---|---|---|---|---|---|---|---|');
  const benchRow = (name: string, k: 'q' | 'l' | 'j'): string => '| 📊 ' + name + ' | ' + pb.map((b) => pp(ret(b[k]))).join(' | ') + ' | — | -' + Math.max(...pb.map((b) => b[k].maxDrawdownPct)).toFixed(0) + '% | 0% | 0% | whole period |';
  out.push(benchRow('Hold QQQ', 'q'), benchRow(LABELS.holdList, 'l'), benchRow(LABELS.holdList + ' (join when listed)', 'j'));
  rows.forEach((r, ri) => {
    const x = res[ri]!;
    out.push('| ' + r.name + ' | ' + x.per.map((o, k) => (beats(o, pb[k]!) ? '✅ ' : '') + pp(ret(o))).join(' | ') + ' | ' + cnt(ri, 4) + ' | -' + Math.max(...x.per.map((o) => o.maxDrawdownPct)).toFixed(0) + '% | ' + stats(x.full).join(' | ') + ' |');
  });
  out.push('', 'Continuous run ' + fullStart + ' to ' + fullEnd + ' (one $100,000 account, after tax): 📊 Hold QQQ ' + pp(ret(fb.q)) + ', 📊 ' + LABELS.holdList + ' ' + pp(ret(fb.l)) + ', join when listed ' + pp(ret(fb.j)) + '; '
    + rows.map((r, ri) => (res[ri]!.full ? r.name.replace(/\*\*/g, '') + ' ' + pp(ret(res[ri]!.full!)) : null)).filter(Boolean).join('; ') + '.');

  out.push('', '### Windows 2010-2021 (beats both: 1-yr / 2-yr / 4-yr)', '', '| Row | 1-yr (12) | 2-yr (11) | 4-yr (9) | Median 4-yr excess vs QQQ | Median 4-yr excess vs ' + LABELS.list + ' |', '|---|---|---|---|---|---|');
  const k4 = ws.map((w, k) => (w.years === 4 ? k : -1)).filter((k) => k >= 0);
  rows.forEach((r, ri) => out.push('| ' + r.name + ' | ' + cnt(ri, 1) + ' | ' + cnt(ri, 2) + ' | ' + cnt(ri, 4) + ' | ' + pp(median(k4.map((k) => ret(res[ri]!.win[k]!) - ret(wb[k]!.q)))) + ' | ' + pp(median(k4.map((k) => ret(res[ri]!.win[k]!) - ret(wb[k]!.l)))) + ' |'));

  // 2. signal stats
  out.push('', '## 2. Signal statistics (' + LABELS.list + ', every new signal ' + fullStart + ' to ' + fullEnd + ')', '',
    'A new signal = a signal day with no signal in the 20 bars before. Entry at the next open; forward return to the close 10 / 20 / 40 bars after the signal (before tax and costs). Hit rate = 20-bar return above 0. Kept falling = a close within the next 40 bars at least 15% under the entry. Signals per year = for the whole list (all stocks together).', '',
    '| Signal | Period | Signals | Signals / yr | Hit rate (20d > 0) | Avg 10d | Avg 20d | Avg 40d | Kept falling (-15% more) |', '|---|---|---|---|---|---|---|---|---|');
  for (const key of Object.keys(WASHOUTS) as WashoutKey[]) for (const p of [{ name: 'all', start: fullStart, end: fullEnd }, ...PERIODS]) {
    const st = signalStats(bagSeries, WASHOUTS[key], p.start, p.end);
    out.push('| ' + key + ' | ' + p.name + ' | ' + st.n + ' | ' + (st.n / st.years).toFixed(1) + ' | ' + pct1(st.hit20) + ' | ' + pct1(st.r10) + ' | ' + pct1(st.r20) + ' | ' + pct1(st.r40) + ' | ' + pct1(st.keptFalling) + ' |');
  }

  // 3. today
  const q = indOf(qqq);
  if (today.length) {
    out.push('', '## 3. Did W1 / W2 / W3 fire? (last bar in the price history: ' + lastBar + ')', '',
      '| Ticker | Close | z vs 20-day avg | Off 252-day high | 150-day avg vs 20 bars ago | W1 | W2 | W3 | Close that fires W1 next bar (2.5 SD and 20% off) | Close that fires W2 next bar |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const t of today) {
      const s = series.get(t) ?? (fs.existsSync(path.join(priceDir, t + '.json')) ? loadSeries(t, priceDir) : null);
      if (!s) { out.push('| ' + t + ' | no data |||||||||'); continue; }
      const ind = indOf(s), i = s.dates.length - 1;
      const yn = (k: WashoutKey): string => (washoutAt(ind, i, WASHOUTS[k]) ? 'YES' : 'no');
      const r150 = ind.dir150[i] === 1 ? 'rising' : ind.dir150[i] === -1 ? 'falling' : 'flat';
      const fire = (sd: number, off: number): string => '$' + Math.min(closeForZ(s, i, sd), (1 - off) * ind.hi252[i]!).toFixed(2);
      out.push('| ' + t + ' | ' + s.closes[i]!.toFixed(2) + ' | ' + ind.z[i]!.toFixed(2) + ' | ' + pct1(s.closes[i]! / ind.hi252[i]! - 1) + ' | ' + r150 + ' | ' + yn('W1') + ' | ' + yn('W2') + ' | ' + yn('W3') + ' | ' + fire(2.5, 0.2) + (ind.dir150[i] === 1 ? '' : ' (and the 150-day filter fails)') + ' | ' + fire(2.0, 0.15) + ' |');
    }
  }

  // 4. weights today
  out.push('', '## 4. Rotation weights at the last bar (' + lastBar + ')', '', 'The untouched tier weights the measure gives today (top third 2x, middle 1x, bottom 0.5x, normalised; RB/RS: a stock whose 150-day average was not rising 3 months ago is bottom third). The ±5-point step and the no-trim rule then move an account toward these over several months.', '',
    '| Ticker | 150-day avg rising 3 months ago | R tier | R weight | RB tier | RB weight | RS tier | RS weight |', '|---|---|---|---|---|---|---|---|');
  const atLast = (t: string) => { const ind = indOf(series.get(t)!); const i = ind.idx.get(lastBar); return i == null ? null : { ind, i }; };
  const tw = (['R', 'RB', 'RS'] as Speed[]).map((sp) => { const tg = tiersAt(sp, bag, atLast, q); return { tier: tg.tier, w: normalise(tg.tier) }; });
  for (const t of bag) {
    const x = atLast(t), ql = x ? qualified(x.ind, x.i) : null;
    out.push('| ' + t + ' | ' + (ql == null ? 'not enough history' : ql ? 'yes' : 'no') + ' | ' + tw.map((m) => (m.tier.has(t) ? m.tier.get(t) + 'x | ' + (m.w.get(t)! * 100).toFixed(1) + '%' : '— | 0%')).join(' | ') + ' |');
  }

  // 5. full exits of the best rotation row
  const rotIdx = rows.map((r, ri) => ri).filter((ri) => rows[ri]!.lab?.kind === 'rotation' && !(rows[ri]!.lab as { trims: boolean }).trims);
  const score = (ri: number): number[] => [k4.filter((k) => beats(res[ri]!.win[k]!, wb[k]!)).length, ret(res[ri]!.per[0]!)];
  const best = rotIdx.reduce((a, b) => { const [x1, x2] = score(a), [y1, y2] = score(b); return y1 > x1 || (y1 === x1 && y2 > x2) ? b : a; });
  const f = res[best]!.full!;
  out.push('', '## 5. Full exits of the best rotation row: ' + rows[best]!.name + ' (continuous run ' + fullStart + ' to ' + fullEnd + ')', '',
    'Best = most 4-year windows beating both, then the 2010-19 return (tax-rule rows only). Next-12-month return = the stock\'s close 252 bars after the exit fill / the exit fill price.', '',
    '| Ticker | Exit date (fill at the open) | Exit price | Next-12-month return of the stock | QQQ, same 12 months |', '|---|---|---|---|---|');
  const after: Array<[number, number]> = [];
  for (const e of f.exits) {
    const s = series.get(e.t)!, i = s.dates.indexOf(e.date), qi = qqq.dates.indexOf(e.date);
    const ok = i + 252 < s.dates.length && qi + 252 < qqq.dates.length;
    const r = ok ? s.closes[i + 252]! / e.price - 1 : NaN, rq = ok ? qqq.closes[qi + 252]! / qqq.opens[qi]! - 1 : NaN;
    if (ok) after.push([r, rq]);
    out.push('| ' + e.t + ' | ' + e.date + ' | ' + e.price.toFixed(2) + ' | ' + (ok ? pct1(r) : 'under 12 months of data') + ' | ' + (ok ? pct1(rq) : '—') + ' |');
  }
  if (!f.exits.length) out.push('| (none) | | | | |');
  out.push('', f.exits.length + ' full exits; ' + after.length + ' with 12 months after: median next-12-month return of the sold stock ' + pct1(median(after.map((x) => x[0])))
    + ' (QQQ ' + pct1(median(after.map((x) => x[1]))) + '); the sold stock did worse than QQQ in ' + after.filter((x) => x[0] < x[1]).length + ' of ' + after.length + ', and fell in ' + after.filter((x) => x[0] < 0).length + ' of ' + after.length + '.');
  process.stdout.write(out.join('\n') + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
