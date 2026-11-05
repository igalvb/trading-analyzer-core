/**
 * `node src/research/windowsCli.ts <priceDir> <readsDir>` (owner 2026-10-30: "the last 4 years were insane for
 * Nasdaq; exclude them"): every research model with a history runner, its fixed setup (no new tuning), on short
 * windows inside 2010-2021 only: each calendar year (12), each 2-year window (11), each 4-year window (9). $100,000
 * at the start of each window, 25% tax, 10 bps per side, against 📊 Hold QQQ and 📊 Hold the research list (plain and join
 * when listed). Each 1-year window is labelled good / flat / bad by QQQ's price return (> +15% / 0 to +15% / < 0).
 * Prints markdown (docs/models/results/windows-pre2022.md).
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadSeries, type PriceSeries } from '../backtest/data.ts';
import { runPortfolio, holdBag, type PortfolioInput, type PortfolioModel, type PortfolioOptions } from './portfolioLab.ts';
import { OWNER_BAG } from './portfolioCli.ts';
import { holdCurve } from './benchmarks.ts';
import { runLiloPortfolio } from './liloCli.ts';
import { runLiloV2, LILO_V2_CHOSEN, LILO_V2_DEFAULT_SETUP, CASH } from './liloV2Cli.ts';
import { quantile } from './guards.ts';
import type { CompactRead } from './computeReads.ts';
import { runMeanRev, MR_CHOSEN } from './meanRevCli.ts';
import { runPair } from './pairLab.ts';
import { PAIR_CHOSEN } from './pairCli.ts';
import { runWinners, WINNERS_CHOSEN } from './bigWinnersCli.ts';
import { runCycle, CYCLE_CHOSEN } from './cycleCli.ts';
import { runMarketMaker, MM_CHOSEN } from './marketMakerCli.ts';
import { runLeaps, LEAPS_FIRE_DEFAULT } from './leapsLab.ts';
import { QG_HOSTS, QG_CHOSEN, scoreBook, runGated } from './qualityGateCli.ts';
import { LABELS } from '../profile/labels.ts';

const COST = 10;
const T200: Partial<PortfolioOptions> = { exit: 'trend', trendDays: 200 };

interface Win { readonly name: string; readonly start: string; readonly end: string; readonly years: number }
export function windows(first = 2010, last = 2021, lens: readonly number[] = [1, 2, 4]): Win[] {
  const out: Win[] = [];
  for (const n of lens) for (let y = first; y + n - 1 <= last; y++)
    out.push({ name: n === 1 ? String(y) : y + '-' + String(y + n - 1).slice(2), start: y + '-01-01', end: (y + n - 1) + '-12-31', years: n });
  return out;
}

interface Out { readonly finalTaxed: number; readonly maxDrawdownPct: number }
interface Model { readonly name: string; readonly run: (w: Win) => Out }

function models(bag: readonly string[], inp: PortfolioInput): Model[] {
  const pf = (name: string, m: PortfolioModel, o: Partial<PortfolioOptions>): Model => ({ name, run: (w) => runPortfolio(m, bag, inp, w.start, w.end, { slots: 3, cash: CASH, costBps: COST, ...o }) });
  return [
    pf('Engine alone (3, 200-day sell)', 'engine', { slots: 3, ...T200 }),
    pf('Engine + models, current rule (5, 200-day sell)', 'current', { slots: 5, ...T200 }),
    pf('Broker Course (2, 200-day sell)', 'broker', { slots: 2, ...T200 }),
    pf('Schabacker (3, 200-day sell)', 'schabacker', { slots: 3, ...T200 }),
    pf('Edwards & Magee (5, own sell)', 'edwardsMagee', { slots: 5 }),
    pf('Turtle (3, 200-day sell)', 'turtle', { slots: 3, ...T200 }),
    pf('Wyckoff (2, own sell)', 'wyckoff', { slots: 2 }),
    pf('Trend 150 (3)', 'trend', { slots: 3, trendDays: 150 }),
    pf('Trend 200 (3)', 'trend', { slots: 3, trendDays: 200 }),
    pf('Combo 2 of 3 (3, 200-day sell)', 'combo', { slots: 3, ...T200 }),
    pf('Everything together, shares (engine OR combo, 3, 200-day sell)', 'best', { slots: 3, ...T200 }),
    { name: 'LILO current (5 ladders)', run: (w) => runLiloPortfolio(bag, inp, w.start, w.end, 5, COST) },
    { name: 'James LILO v2, chosen (A3, U2 c=0.35, no layer-out, 200-day stop)', run: (w) => runLiloV2(bag, inp, w.start, w.end, LILO_V2_CHOSEN, COST) },
    { name: 'James LILO v2, pre-registered default (A1-63, U1 k=5, A20)', run: (w) => runLiloV2(bag, inp, w.start, w.end, LILO_V2_DEFAULT_SETUP, COST) },
    pf('Combo + James Profit-Taking A20', 'combo', { slots: 3, ...T200, profitTaking: { schedule: 'A20' } }),
  ];
}

/**
 * James's models, phase 2 (docs/models/results/phase2.md), each with its setup chosen on 2010-2019 (Pair Rotation on
 * MSTR/TSLA: chosen on 2020-2023 as its plan states). Grid only. The pair runs only on windows where both MSTR and TSLA
 * trade on the first day (null = "no data").
 */
interface GridModel { readonly name: string; readonly run: (w: Win) => Out | null }
function phase2Models(bag: readonly string[], inp: PortfolioInput): GridModel[] {
  const m = inp.series.get('MSTR'), t = inp.series.get('TSLA');
  return [
    { name: 'James Mean Reversion, chosen', run: (w) => runMeanRev(bag, inp, w.start, w.end, MR_CHOSEN, COST) },
    { name: 'James Pair Rotation MSTR/TSLA, chosen', run: (w) => (m && t && (t.dates[0] as string) <= w.start ? runPair(m, t, w.start, w.end, PAIR_CHOSEN, COST) : null) },
    { name: 'James Winners & Layering, chosen', run: (w) => runWinners(bag, inp, w.start, w.end, WINNERS_CHOSEN, COST) },
  ];
}

/** James's models, phase 3 (docs/models/results/phase3.md), each with its setup chosen on 2010-2019. Grid only. */
function phase3Models(bag: readonly string[], inp: PortfolioInput): GridModel[] {
  return [
    { name: 'James Multi-Year Cycle, chosen', run: (w) => runCycle(bag, inp, w.start, w.end, CYCLE_CHOSEN, COST) },
    { name: 'James Market Maker Stages, chosen', run: (w) => runMarketMaker(bag, inp, w.start, w.end, MM_CHOSEN.o, COST) },
  ];
}

/**
 * James's models, phase 4 (docs/models/results/phase4.md), fixed in advance (nothing chosen on returns): James — LEAPS
 * timing in SHARES (exact) and the delta-capped hold-to-expiry LEAPS account priced by the synthetic backtester
 * (APPROXIMATE: Black-Scholes at 1.0 x RV252, half-spread 3%). Grid only.
 */
function phase4Models(bag: readonly string[], inp: PortfolioInput): GridModel[] {
  return [
    { name: 'James LEAPS timing in shares, default', run: (w) => runLeaps(bag, inp, w.start, w.end, { ...LEAPS_FIRE_DEFAULT, instrument: 'shares', costBps: COST }) },
    { name: 'James LEAPS fire sale 0.75, to expiry, delta-capped (approximate)', run: (w) => runLeaps(bag, inp, w.start, w.end, { ...LEAPS_FIRE_DEFAULT, deltaCap: 1, costBps: COST }) },
  ];
}

/**
 * James's models, phase 5 (docs/models/results/phase5.md): James — Quality Gate as a filter on the main hosts, each
 * host buying only stocks that pass the gate at the level chosen on 2010-2019 (QG_CHOSEN; the history score has the
 * team table and the two price items: no SEC point-in-time data in this download). Grid only.
 */
function phase5Models(bag: readonly string[], inp: PortfolioInput): GridModel[] {
  const book = scoreBook(inp.series);
  return QG_HOSTS.map((h) => ({ name: 'James Quality Gate on ' + h.name, run: (w: Win) => runGated(h, bag, inp, w.start, w.end, COST, book, QG_CHOSEN[h.key]) }));
}

const pp = (v: number): string => (v >= 0 ? '+' : '') + v.toFixed(0) + '%';
const ret = (o: Out): number => (o.finalTaxed / CASH - 1) * 100;

function main(): void {
  if (process.argv.includes('--grid')) { grid(); return; }
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
  const ws = windows();
  const bagSeries = bag.map((t) => series.get(t)!);
  // yardsticks and the year labels
  const bench = ws.map((w) => {
    const days = inp.qqq.dates.filter((d) => d >= w.start && d <= w.end);
    const q = holdCurve([inp.qqq], days, CASH, { costBps: COST });
    const l = { ...holdCurve(bagSeries, days, CASH, { costBps: COST }), finalTaxed: holdBag(bag, inp, w.start, w.end, CASH, COST) };
    const j = holdCurve(bagSeries, days, CASH, { costBps: COST, join: true });
    const i0 = inp.qqq.dates.indexOf(days[0]!), i1 = inp.qqq.dates.indexOf(days[days.length - 1]!);
    const qRaw = ((inp.qqq.closes[i1] as number) / (inp.qqq.opens[i0] as number) - 1) * 100;
    const listed = bag.filter((t) => (series.get(t)!.dates[0] as string) <= days[0]!).length;
    const joins = bag.filter((t) => { const f = series.get(t)!.dates[0] as string; return f > days[0]! && f <= days[days.length - 1]!; });
    return { q, l, j, qRaw, label: qRaw > 15 ? 'good' : qRaw < 0 ? 'bad' : 'flat', listed, joins };
  });
  const ms = models(bag, inp);
  const res = ms.map((m) => { const r = ws.map((w) => m.run(w)); process.stderr.write(m.name + '\n'); return r; });

  const lens = [1, 2, 4];
  const ix = (n: number): number[] => ws.map((w, i) => (w.years === n ? i : -1)).filter((i) => i >= 0);
  const beatsBoth = (r: Out, k: number): boolean => r.finalTaxed > bench[k]!.q.finalTaxed && r.finalTaxed > bench[k]!.l.finalTaxed && r.finalTaxed > bench[k]!.j.finalTaxed;
  const exQ = (r: Out, k: number): number => ret(r) - ret(bench[k]!.q);
  const exL = (r: Out, k: number): number => ret(r) - ret(bench[k]!.l);
  const med = (xs: number[]): string => pp(quantile(xs, 0.5));

  const out: string[] = [
    '# All models on short windows, 2010-2021 only (2022-2026 left out)', '',
    'Owner 2026-10-30: "the last 4 years were insane for Nasdaq; exclude them". Every model with a history runner, with the setup already chosen (no new tuning), on every calendar year 2010-2021 (12 windows), every 2-year window (11) and every 4-year window (9); nothing after 2021-12-31 is used. Each window starts fresh with $100,000; decide at the close, fill at the next open; 25% tax on every sale\'s gain and on what is still held at the window\'s end; 10 bps per side (the yardsticks pay it once at the entry). Data: research prices (daily OHLC from 2007) and the saved engine reads 2009-2026. Rerun: `node src/research/windowsCli.ts <priceDir> <readsDir>`.', '',
    'The 14: ' + bag.join(', ') + '. Not all traded in 2010-2021: TSLA from 2010-06-29, CLSK from 2016-11-16, BE from 2018-07-25, PLTR from 2020-09-30, ALAB never. 📊 ' + LABELS.holdList + ' (plain) splits the money over the stocks trading on the window\'s first day; "join when listed" gives a later listing its share, waiting in cash until its first day. The models trade a stock once it is listed.', '',
    '**Beats both** = after tax, above 📊 Hold QQQ AND above both 📊 ' + LABELS.holdList + ' variants in that window. Excess = model return minus yardstick return, in percentage points of the starting $100,000 (after tax). Year label by QQQ\'s price return (first open to last close): good > +15%, bad < 0%, flat in between.', '',
    '## Year labels (QQQ)', '', '| Year | QQQ price return | Label |', '|---|---|---|',
    ...ix(1).map((k) => '| ' + ws[k]!.name + ' | ' + pp(bench[k]!.qRaw) + ' | ' + bench[k]!.label + ' |'),
    '', 'Good: ' + ix(1).filter((k) => bench[k]!.label === 'good').map((k) => ws[k]!.name).join(', ') + '. Flat: ' + ix(1).filter((k) => bench[k]!.label === 'flat').map((k) => ws[k]!.name).join(', ') + '. Bad: ' + ix(1).filter((k) => bench[k]!.label === 'bad').map((k) => ws[k]!.name).join(', ') + '. (2020 is good on the year despite the Feb-Mar crash; 2015 and 2016 are the chop years.)',
    '', '## (a) Summary', '',
    '| Model | Beats both: 1-yr / 2-yr / 4-yr | Median excess vs QQQ: 1 / 2 / 4 yr | Median excess vs ' + LABELS.list + ': 1 / 2 / 4 yr | Worst window (return, vs QQQ) | Deepest fall (any window) |', '|---|---|---|---|---|---|',
  ];
  const yardRow = (name: string, get: (k: number) => Out): string => {
    const all = ws.map((_, k) => get(k));
    const worst = all.reduce((a, r, k) => (ret(r) < ret(all[a]!) ? k : a), 0);
    return '| 📊 ' + name + ' | — | ' + lens.map((n) => med(ix(n).map((k) => ret(get(k)) - ret(bench[k]!.q)))).join(' / ') + ' | ' + lens.map((n) => med(ix(n).map((k) => ret(get(k)) - ret(bench[k]!.l)))).join(' / ')
      + ' | ' + ws[worst]!.name + ': ' + pp(ret(all[worst]!)) + ' (' + pp(exQ(all[worst]!, worst)) + ') | -' + Math.max(...all.map((r) => r.maxDrawdownPct)).toFixed(0) + '% |';
  };
  out.push(yardRow('Hold QQQ', (k) => bench[k]!.q), yardRow(LABELS.holdList, (k) => bench[k]!.l), yardRow(LABELS.holdList + ' (join when listed)', (k) => bench[k]!.j));
  ms.forEach((m, mi) => {
    const r = res[mi]!;
    const worst = r.reduce((a, x, k) => (ret(x) < ret(r[a]!) ? k : a), 0);
    out.push('| ' + m.name + ' | ' + lens.map((n) => ix(n).filter((k) => beatsBoth(r[k]!, k)).length + '/' + ix(n).length).join(' / ') + ' | ' + lens.map((n) => med(ix(n).map((k) => exQ(r[k]!, k)))).join(' / ')
      + ' | ' + lens.map((n) => med(ix(n).map((k) => exL(r[k]!, k)))).join(' / ') + ' | ' + ws[worst]!.name + ': ' + pp(ret(r[worst]!)) + ' (' + pp(exQ(r[worst]!, worst)) + ') | -' + Math.max(...r.map((x) => x.maxDrawdownPct)).toFixed(0) + '% |');
  });

  // (b) good vs bad years
  const groups = ['good', 'flat', 'bad'] as const;
  const gi = (g: string): number[] => ix(1).filter((k) => bench[k]!.label === g);
  out.push('', '## (b) Good years vs bad years (1-year windows)', '',
    groups.map((g) => g[0]!.toUpperCase() + g.slice(1) + ' (' + gi(g).length + '): ' + gi(g).map((k) => ws[k]!.name).join(', ')).join('. ') + '. Cells: beats both (count) · median excess vs QQQ · median excess vs ' + LABELS.list + '.', '',
    '| Model | ' + groups.map((g) => g + ' years').join(' | ') + ' |', '|---|---|---|---|',
    '| 📊 Hold QQQ, median return | ' + groups.map((g) => med(gi(g).map((k) => ret(bench[k]!.q)))).join(' | ') + ' |',
    '| 📊 ' + LABELS.holdList + ', median return | ' + groups.map((g) => med(gi(g).map((k) => ret(bench[k]!.l)))).join(' | ') + ' |',
    ...ms.map((m, mi) => '| ' + m.name + ' | ' + groups.map((g) => { const ks = gi(g), r = res[mi]!; return ks.filter((k) => beatsBoth(r[k]!, k)).length + '/' + ks.length + ' · ' + med(ks.map((k) => exQ(r[k]!, k))) + ' · ' + med(ks.map((k) => exL(r[k]!, k))); }).join(' | ') + ' |'));

  // (c) per-window tables
  out.push('', '## (c) Every window', '', 'Return after tax (deepest fall in the window). ✅ = beats both yardsticks.');
  for (const n of lens) {
    const ks = ix(n);
    out.push('', '### ' + n + '-year windows', '', '| Row | ' + ks.map((k) => ws[k]!.name + (n === 1 ? ' (' + bench[k]!.label + ')' : '')).join(' | ') + ' |', '|---|' + ks.map(() => '---|').join(''),
      '| 📊 Hold QQQ | ' + ks.map((k) => pp(ret(bench[k]!.q)) + ' (-' + bench[k]!.q.maxDrawdownPct.toFixed(0) + '%)').join(' | ') + ' |',
      '| 📊 ' + LABELS.holdList + ' | ' + ks.map((k) => pp(ret(bench[k]!.l)) + ' (-' + bench[k]!.l.maxDrawdownPct.toFixed(0) + '%)').join(' | ') + ' |',
      '| 📊 ' + LABELS.holdList + ' (join when listed) | ' + ks.map((k) => pp(ret(bench[k]!.j)) + ' (-' + bench[k]!.j.maxDrawdownPct.toFixed(0) + '%)').join(' | ') + ' |',
      '| Stocks of the 14 trading on day 1 (+ joining later) | ' + ks.map((k) => bench[k]!.listed + (bench[k]!.joins.length ? ' (+' + bench[k]!.joins.join(', ') + ')' : '')).join(' | ') + ' |',
      ...ms.map((m, mi) => '| ' + m.name + ' | ' + ks.map((k) => { const r = res[mi]![k]!; return (beatsBoth(r, k) ? '✅ ' : '') + pp(ret(r)) + ' (-' + r.maxDrawdownPct.toFixed(0) + '%)'; }).join(' | ') + ' |'));
  }
  process.stdout.write(out.join('\n') + '\n');
}


/**
 * `node src/research/windowsCli.ts --grid <priceDir> <readsDir> [lastDay]` (owner 2026-10-30): the same models on
 * every 1-, 2- and 4-year window 2007-2026 (2026 to the last price day), plus the one 3-year window 2007-09, in the
 * compact layout of docs/models/results/windows-2007-2026.md: rows = windows, columns = the yardsticks then the
 * models, "+X%" after tax, ✅ = above Hold QQQ and both Hold the research list variants. A model runs only on windows that start
 * on or after MODEL_FIRST_START (prices begin 2007-01-03; every model needs ~200 trading days before a window).
 */
export const MODEL_FIRST_START = '2008-01-01';
/** Grid column order (owner) -> the model's full name in models(). */
const GRID_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['Combo 2/3', 'Combo 2 of 3 (3, 200-day sell)'], ['Turtle', 'Turtle (3, 200-day sell)'], ['Trend 200', 'Trend 200 (3)'],
  ['Engine', 'Engine alone (3, 200-day sell)'], ['Everything', 'Everything together, shares (engine OR combo, 3, 200-day sell)'],
  ['LILO v2', 'James LILO v2, chosen (A3, U2 c=0.35, no layer-out, 200-day stop)'], ['Schab.', 'Schabacker (3, 200-day sell)'],
  ['Trend 150', 'Trend 150 (3)'], ['Eng+mod', 'Engine + models, current rule (5, 200-day sell)'], ['Combo+PT', 'Combo + James Profit-Taking A20'],
  ['Broker', 'Broker Course (2, 200-day sell)'], ['E&M', 'Edwards & Magee (5, own sell)'], ['Wyckoff', 'Wyckoff (2, own sell)'], ['LILO', 'LILO current (5 ladders)'],
  // James's models, phase 2
  ['MR ±2SD', 'James Mean Reversion, chosen'], ['Pair M/T', 'James Pair Rotation MSTR/TSLA, chosen'], ['Winners', 'James Winners & Layering, chosen'],
  // James's models, phase 3
  ['Cycle', 'James Multi-Year Cycle, chosen'], ['MM stages', 'James Market Maker Stages, chosen'],
  // James's models, phase 4 (the second column is approximate: synthetic LEAPS)
  ['LEAPS sh', 'James LEAPS timing in shares, default'], ['≈LEAPS cap', 'James LEAPS fire sale 0.75, to expiry, delta-capped (approximate)'],
  // James's models, phase 5 (the quality gate as a filter on four hosts)
  ['QG Combo', 'James Quality Gate on Combo 2 of 3 (3, 200-day sell)'], ['QG T200', 'James Quality Gate on Trend 200 (3)'],
  ['QG Engine', 'James Quality Gate on Engine alone (3, 200-day sell)'], ['QG Every', 'James Quality Gate on Everything together, shares (engine OR combo, 3, 200-day sell)'],
];

function grid(): void {
  const [priceDir, readsDir] = process.argv.slice(2).filter((a) => !a.startsWith('--')) as [string, string];
  const series = new Map<string, PriceSeries>(), reads = new Map<string, Map<string, CompactRead>>();
  for (const t of OWNER_BAG) {
    const f = path.join(readsDir, t + '.reads.json');
    if (!fs.existsSync(f)) continue;
    series.set(t, loadSeries(t, priceDir));
    reads.set(t, new Map((JSON.parse(fs.readFileSync(f, 'utf8')) as CompactRead[]).map((r) => [r.d, r])));
  }
  const bag = OWNER_BAG.filter((t) => series.has(t));
  const inp: PortfolioInput = { series, reads, qqq: loadSeries('QQQ', priceDir) };
  const lastDay = inp.qqq.dates[inp.qqq.dates.length - 1] as string, lastYear = Number(lastDay.slice(0, 4));
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
  let ws = [...windows(2007, lastYear, [1, 2, 4]), ...windows(2007, 2009, [3])];
  if (only) ws = ws.filter((w) => only.split(',').includes(w.name));
  const bagSeries = bag.map((t) => series.get(t)!);
  const all: GridModel[] = [...models(bag, inp), ...phase2Models(bag, inp), ...phase3Models(bag, inp), ...phase4Models(bag, inp), ...phase5Models(bag, inp)];
  // --cols=a,b: only these columns (by short name), to add new columns without re-running the others
  const onlyCols = process.argv.find((a) => a.startsWith('--cols='))?.slice(7).split(',');
  const cols = GRID_COLUMNS.filter(([short]) => !onlyCols || onlyCols.includes(short)).map(([short, full]) => ({ short, m: all.find((x) => x.name === full)! }));
  const rows = ws.map((w) => {
    const days = inp.qqq.dates.filter((d) => d >= w.start && d <= w.end);
    const q = holdCurve([inp.qqq], days, CASH, { costBps: COST });
    const l = { ...holdCurve(bagSeries, days, CASH, { costBps: COST }), finalTaxed: holdBag(bag, inp, w.start, w.end, CASH, COST) };
    const j = holdCurve(bagSeries, days, CASH, { costBps: COST, join: true });
    const i0 = inp.qqq.dates.indexOf(days[0]!), i1 = inp.qqq.dates.indexOf(days[days.length - 1]!);
    const qRaw = ((inp.qqq.closes[i1] as number) / (inp.qqq.opens[i0] as number) - 1) * 100;
    const listed = bag.filter((t) => (series.get(t)!.dates[0] as string) <= days[0]!);
    const joins = bag.filter((t) => { const f = series.get(t)!.dates[0] as string; return f > days[0]! && f <= days[days.length - 1]!; });
    const res = cols.map((c) => (w.start >= MODEL_FIRST_START ? c.m.run(w) : null));
    process.stderr.write(w.name + '\n');
    const partial = w.end > lastDay; // the window runs past the last price day (2026 to date)
    return { w, q, l, j, qRaw, label: qRaw > 15 ? 'good' : qRaw < 0 ? 'bad' : 'flat', listed, joins, res, partial, lastDay: days[days.length - 1]! };
  });
  const out: string[] = [];
  // times each model beat both yardsticks, over the windows it could run (1-, 2- and 4-year)
  out.push('## Times each model beat both yardsticks', '', '| Model | ✅ 1-yr | ✅ 2-yr | ✅ 4-yr |', '|---|---|---|---|');
  cols.forEach((c, ci) => out.push('| ' + c.short + ' | ' + [1, 2, 4].map((n) => {
    const rs = rows.filter((r) => r.w.years === n && r.res[ci]);
    return rs.filter((r) => { const o = r.res[ci]!; return o.finalTaxed > r.q.finalTaxed && o.finalTaxed > r.l.finalTaxed && o.finalTaxed > r.j.finalTaxed; }).length + '/' + rs.length;
  }).join(' | ') + ' |'));
  for (const n of [1, 2, 3, 4]) {
    const rs = rows.filter((r) => r.w.years === n);
    if (!rs.length) continue;
    out.push('', '### ' + n + '-year windows', '', '| Window | QQQ | ' + LABELS.List + ' | ' + cols.map((c) => c.short).join(' | ') + ' |', '|---|---|---|' + cols.map(() => '---|').join(''));
    for (const r of rs) {
      const beats = (o: Out): boolean => o.finalTaxed > r.q.finalTaxed && o.finalTaxed > r.l.finalTaxed && o.finalTaxed > r.j.finalTaxed;
      const name = r.w.name + (r.partial ? ' (to ' + r.lastDay.slice(5) + ')' : '') + (n === 1 ? ' — ' + r.label + ' (QQQ ' + pp(r.qRaw) + ')' : '');
      const y14 = pp(ret(r.l)) + (Math.round(ret(r.j)) !== Math.round(ret(r.l)) ? ' (join ' + pp(ret(r.j)) + ')' : '');
      out.push('| ' + name + ' | ' + pp(ret(r.q)) + ' | ' + y14 + ' | ' + r.res.map((o, ci) => (o ? (beats(o) ? '✅ ' : '') + pp(ret(o)) + (cols[ci]!.short === 'LILO' && r.w.start < '2009-01-01' ? '†' : '') : 'no data')).join(' | ') + ' |');
    }
    const dd = (xs: Array<Out | null>): string => { const v = xs.filter((x): x is Out => !!x); return v.length ? '-' + Math.max(...v.map((x) => x.maxDrawdownPct)).toFixed(0) + '%' : 'no data'; };
    out.push('| Deepest fall | ' + dd(rs.map((r) => r.q)) + ' | ' + dd(rs.map((r) => r.l)) + ' | ' + cols.map((_, ci) => dd(rs.map((r) => r.res[ci]!))).join(' | ') + ' |');
    out.push('', 'Stocks of the 14 trading on day 1 (+ joining later): ' + rs.map((r) => r.w.name + ' ' + r.listed.length + (r.joins.length ? ' (+' + r.joins.join(', ') + ')' : '')).join(' · ') + '.');
  }
  process.stdout.write(out.join('\n') + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
