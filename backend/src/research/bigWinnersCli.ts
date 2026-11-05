/**
 * `node src/research/bigWinnersCli.ts <priceDir> [--cost=0,10]`: the history test of James — Winners & Layering
 * (docs/models/plans/09-winners-and-layering.md section 6) on the research list, three periods, after the 25% tax, against
 * 📊 Hold QQQ and 📊 Hold the research list (and "join when listed"): the pre-registered default first, the controls (compounding
 * hold, monthly buying, lump sum, dips in the bottom-N), pass 1 (N x ranking x dip x tie-break = 54), the T2 sweep
 * guard chosen on 2010-2019 only, pass 2 one knob at a time, the random-signal null, random bags and the universe minus
 * the 14, the report columns and the zone / cut statistics. The BTC sleeve needs BTC-USD (not in the research download)
 * and IBIT exists only from 2024: not run on history (the paper account runs it in IBIT). Prints markdown.
 */

import type { PriceSeries } from '../backtest/data.ts';
import { PERIODS } from './lab.ts';
import type { PortfolioInput } from './portfolioLab.ts';
import { OWNER_BAG, randomBags, universeMinusList } from './portfolioCli.ts';
import { RESEARCH_UNIVERSE } from './fetchPrices.ts';
import { benchmarksFor, benchRows, reportTable, type PeriodOutcome } from './benchmarks.ts';
import { sweepGuard, randomSignalNull, nullVerdict, type SweepSetup, type NullDistribution } from './guards.ts';
import { newWinnersBook, winnersDay, winnersDecide, winnersValue, winnersEquity, WINNERS_DEFAULT, type WinnersOptions, type WCtx } from './winnersBook.ts';
import type { Zone } from '../analysis/models/winners.ts';
import { trendSeries } from '../analysis/models/trendFollow.ts';
import { loadBag, CASH, pct, resultRowP2, RESULT_HEAD_P2 } from './phase2Common.ts';
import { LABELS } from '../profile/labels.ts';

export interface WinnersSetup { readonly name: string; readonly o: WinnersOptions }
export const winnersName = (o: WinnersOptions): string => 'N ' + o.n + ', ' + (o.ranking === '12m' ? '12-month' : o.ranking === '6mVsQqq' ? '6-month vs QQQ' : '3-year') + ', ' + ({ dd20: '-10% from the 20-day high', dd50: '-15% from the 50-day high', rsi35: 'RSI < 35' } as const)[o.dip] + ', ' + o.tieBreak;
export const WINNERS_DEFAULT_SETUP: WinnersSetup = { name: winnersName(WINNERS_DEFAULT), o: WINNERS_DEFAULT };
/**
 * The setup chosen on 2010-2019 only (this CLI, pass 1 + pass 2 at 10 bps; docs/models/results/phase2.md). Used by the
 * paper accounts and the windows grid; the report page reads the same constant.
 */
export const WINNERS_CHOSEN: WinnersSetup = {
  name: 'N 5, 6-month vs QQQ, -15% from the 50-day high, T-C + re-rank every 63 days',
  o: { ...WINNERS_DEFAULT, n: 5, ranking: '6mVsQqq', dip: 'dd50', tieBreak: 'T-C', rerankDays: 63 },
};

export interface WinnersResult extends PeriodOutcome {
  readonly finalTaxed: number; readonly maxDrawdownPct: number; readonly trades: number;
  readonly cashShareByDay: Map<string, number>; readonly buysByTicker: Map<string, number>;
  readonly adds: Record<Zone | 'start', { n: number; money: number }>; readonly cuts: number; readonly rewinners: number;
}

/** One run over [start, end]. `addDays`: the random-signal null's add days (they replace the winner / dip / spacing tests). */
export function runWinners(bag: readonly string[], inp: Pick<PortfolioInput, 'series' | 'qqq'>, start: string, end: string, s: WinnersSetup, costBps = 0,
  addDays?: ReadonlyMap<string, ReadonlySet<string>>): WinnersResult {
  const o = { ...s.o, costBps };
  const b = newWinnersBook(CASH);
  const live = bag.filter((t) => inp.series.has(t));
  const ser = (t: string): PriceSeries => (t === 'QQQ' ? inp.qqq : (inp.series.get(t) as PriceSeries));
  const idx = new Map([...live, 'QQQ'].map((t) => [t, new Map(ser(t).dates.map((d, i) => [d, i]))]));
  const days = inp.qqq.dates.filter((d) => d >= start && d <= end);
  const q200 = trendSeries(inp.qqq.closes, 200);
  let peak = CASH, dd = 0, trades = 0, cuts = 0, idleOut = o.idle === 'cash';
  const last = new Map<string, number>(), cashShareByDay = new Map<string, number>(), buysByTicker = new Map<string, number>();
  const adds: WinnersResult['adds'] = { High: { n: 0, money: 0 }, Middle: { n: 0, money: 0 }, Deep: { n: 0, money: 0 }, start: { n: 0, money: 0 } };
  const cutSet = new Set<string>(), rewin = new Set<string>();
  for (let n = 0; n < days.length; n++) {
    const d = days[n] as string, qk = idx.get('QQQ')!.get(d)!;
    const opens = new Map<string, number>(), stocks = new Map<string, WCtx>();
    for (const t of live) { const k = idx.get(t)!.get(d); if (k == null) continue; const x = ser(t); opens.set(t, x.opens[k] as number); last.set(t, x.closes[k] as number); stocks.set(t, { closes: x.closes, highs: x.highs, i: k, date: d }); }
    last.set('QQQ', inp.qqq.closes[qk] as number);
    const tr = winnersDay(b, o, { opens, qqqOpen: inp.qqq.opens[qk] as number, fill: true, idleOut });
    for (const x of tr) if (x.ticker !== 'QQQ') {
      trades++;
      if (x.side === 'BUY') { buysByTicker.set(x.ticker, (buysByTicker.get(x.ticker) ?? 0) + 1); const z = x.zone && x.zone !== 'sleeve' ? x.zone : 'High'; adds[z].n++; adds[z].money += x.shares * x.price; }
      else { cuts++; cutSet.add(x.ticker); }
    }
    if (n < days.length - 1) {
      if (o.idle === 'qqqTrend') { const qd = q200[qk]?.direction; if (qd === 'cautionary') idleOut = true; else if (qd === 'bullish') idleOut = false; }
      const rd = addDays ? new Set([...addDays].filter(([, ds]) => ds.has(d)).map(([t]) => t)) : null;
      winnersDecide(b, o, { stocks, qqq: { closes: inp.qqq.closes, highs: inp.qqq.highs, i: qk, date: d }, randomAdd: rd }, (t) => last.get(t) ?? null);
      for (const t of b.rank.slice(0, o.n)) if (cutSet.has(t)) rewin.add(t);
    }
    const eq = winnersEquity(b, (t) => last.get(t) ?? null);
    peak = Math.max(peak, eq); dd = Math.max(dd, (1 - eq / peak) * 100);
    cashShareByDay.set(d, eq > 0 ? Math.min(1, Math.max(0, b.cash) / eq) : 1);
  }
  return { finalTaxed: winnersValue(b, (t) => last.get(t) ?? null), maxDrawdownPct: dd, trades, cashShareByDay, buysByTicker, adds, cuts, rewinners: rewin.size };
}

export function winnersNull(bag: readonly string[], inp: Pick<PortfolioInput, 'series' | 'qqq'>, start: string, end: string, s: WinnersSetup, costBps: number, r: WinnersResult, seeds = 100): NullDistribution {
  const days = inp.qqq.dates.filter((d) => d >= start && d <= end).slice(0, -1);
  const daysOf = (t: string): string[] => { const has = new Set(inp.series.get(t)?.dates ?? []); return days.filter((d) => has.has(d)); };
  return randomSignalNull(r.buysByTicker, daysOf, (addDays) => runWinners(bag, inp, start, end, s, costBps, addDays).finalTaxed, seeds);
}

export function winnersPass1(): Array<{ setup: WinnersSetup; knobs: Record<string, number> }> {
  const out: Array<{ setup: WinnersSetup; knobs: Record<string, number> }> = [];
  [3, 4, 5].forEach((n, ni) => (['12m', '6mVsQqq'] as const).forEach((ranking, ri) => (['dd20', 'dd50', 'rsi35'] as const).forEach((dip, di) => (['T-A', 'T-B', 'T-C'] as const).forEach((tieBreak, ti) => {
    const o: WinnersOptions = { ...WINNERS_DEFAULT, n, ranking, dip, tieBreak };
    out.push({ setup: { name: winnersName(o), o }, knobs: { n: ni, ranking: ri, dip: di, tie: ti } });
  }))));
  return out;
}
export function winnersPass2(base: WinnersSetup): WinnersSetup[] {
  const v = (name: string, x: Partial<WinnersOptions>): WinnersSetup => ({ name: base.name + ' + ' + name, o: { ...base.o, ...x } });
  const sz = base.o.sizes;
  return [
    v('High 1%', { sizes: { ...sz, High: 0.01 } }), v('High 2%', { sizes: { ...sz, High: 0.02 } }), v('Middle 3%', { sizes: { ...sz, Middle: 0.03 } }), v('Middle 5%', { sizes: { ...sz, Middle: 0.05 } }),
    v('Deep 5%', { sizes: { ...sz, Deep: 0.05 } }), v('Deep 10%', { sizes: { ...sz, Deep: 0.10 } }), v('30% trailing stop (grip check)', { grip: 'trail30' }),
    v('cap 20%', { cap: 0.20 }), v('cap 30%', { cap: 0.30 }), v('idle cash', { idle: 'cash' }), v('idle QQQ while its trend is up', { idle: 'qqqTrend' }),
    v('zones 10 / 30', { zones: { ...base.o.zones, hi: 0.10, deep: 0.30 } }), v('zones 20 / 50', { zones: { ...base.o.zones, hi: 0.20, deep: 0.50 } }), v('no "extended" rule', { zones: { ...base.o.zones, extendedOn: false } }),
    v('spacing 10 days', { spacingDays: 10 }), v('spacing 3%', { spacingPct: 0.03 }), v('spacing 10%', { spacingPct: 0.10 }),
    v('cost stop -25%', { costStop: 0.25 }), v('faster horse on', { fasterHorse: true }), v('re-rank every 5 days', { rerankDays: 5 }), v('re-rank every 63 days', { rerankDays: 63 }),
  ];
}

function main(): void {
  const args = process.argv.slice(2);
  const [priceDir] = args.filter((a) => !a.startsWith('--')) as [string];
  const costArg = args.find((a) => a.startsWith('--cost'));
  const costs = costArg ? (costArg.split('=')[1] ?? '0,10').split(',').map(Number) : [0, 10];
  const H = costs.includes(10) ? 10 : costs[costs.length - 1]!;
  const series = loadBag(priceDir, OWNER_BAG);
  const bag = OWNER_BAG.filter((t) => series.has(t));
  const inp: PortfolioInput = { series, reads: new Map(), qqq: loadBag(priceDir, ['QQQ']).get('QQQ')! };
  const runAll = (s: WinnersSetup, cost: number): WinnersResult[] => PERIODS.map((p) => runWinners(bag, inp, p.start, p.end, s, cost));
  const out: string[] = ['# James — Winners & Layering: history test', '', 'The 14: ' + bag.join(', ') + '. $100,000, after the 25% tax, idle money in QQQ, no BTC sleeve (BTC-USD is not in the research download; IBIT only from 2024). Ranking needs 252 bars (prices from 2007).'];
  const controls = (base: WinnersSetup): WinnersSetup[] => [
    { name: 'control: compounding hold (top ' + base.o.n + ' at the start, weekly 200-day / -35% sells, no adds)', o: { ...base.o, mode: 'compound' } },
    { name: 'control: equal monthly buying of the top ' + base.o.n + ' (4% a month, no zones or dips, 200-day cut)', o: { ...base.o, mode: 'monthly' } },
    { name: 'control: lump sum, the top ' + base.o.n + ' at the start, held', o: { ...base.o, mode: 'lump' } },
    { name: 'control: the same rules on the bottom ' + base.o.n + ' ranked', o: { ...base.o, mode: 'bottom' } },
  ];
  for (const cost of costs) {
    const bench = benchmarksFor(bag, inp, CASH, { costBps: cost });
    out.push('', '## ' + cost + ' bps per side' + (cost === H ? ' (headline)' : ''), '', ...RESULT_HEAD_P2, ...benchRows(bench, CASH, 1, ['', '', 'fall', ''], LABELS.holdResearchCore),
      resultRowP2('**James — Winners & Layering, pre-registered default** (' + WINNERS_DEFAULT_SETUP.name + ', zones 1.5 / 4 / 8%, cap 25%, cut after 5 closes under the 200-day)', runAll(WINNERS_DEFAULT_SETUP, cost), bench),
      ...controls(WINNERS_DEFAULT_SETUP).map((c) => resultRowP2(c.name, runAll(c, cost), bench)));
  }
  const p1 = winnersPass1();
  const res = new Map<number, Map<string, WinnersResult[]>>();
  for (const c of costs) { const m = new Map<string, WinnersResult[]>(); for (const s of p1) m.set(s.setup.name, runAll(s.setup, c)); res.set(c, m); process.stderr.write('winners pass 1 at ' + c + ' bps\n'); }
  const benchH = benchmarksFor(bag, inp, CASH, { costBps: H }), qqqH = benchH.qqq.map((x) => x.finalTaxed), rh = res.get(H)!;
  const g = sweepGuard(p1.map((s) => ({ name: s.setup.name, knobs: s.knobs, finals: rh.get(s.setup.name)!.map((x) => x.finalTaxed) }) as SweepSetup), WINNERS_DEFAULT_SETUP.name, qqqH);
  out.push('', '## Pass 1 — 54 setups at ' + H + ' bps (N x ranking x dip x tie-break), sorted by 2010-2019', '', ...RESULT_HEAD_P2);
  for (const s of [...p1].sort((a, b) => rh.get(b.setup.name)![0]!.finalTaxed - rh.get(a.setup.name)![0]!.finalTaxed)) out.push(resultRowP2(s.setup.name + (s.setup.name === WINNERS_DEFAULT_SETUP.name ? ' **(default)**' : ''), rh.get(s.setup.name)!, benchH));
  out.push('', '### The three tie-breaks side by side (owner decision 6; N 4, 12-month, -10% from the 20-day high)', '', ...RESULT_HEAD_P2,
    ...(['T-A', 'T-B', 'T-C'] as const).map((tb) => { const nm = winnersName({ ...WINNERS_DEFAULT, tieBreak: tb }); return resultRowP2(nm, rh.get(nm)!, benchH); }));
  out.push('', '### Sweep guard (T2), chosen on 2010-2019 only', '',
    '- Pre-registered default: ' + g.defaultSetup.name + ' — ' + g.defaultSetup.finals.map(pct).join(' / '), '- Best in 2010-2019: ' + g.picked.name + ' — ' + g.picked.finals.map(pct).join(' / '),
    '- Stable neighbourhood: ' + g.neighboursBeatingQqq + ' of ' + g.neighbours + ' one-step neighbours beat QQQ in 2010-2019 -> ' + (g.stable ? 'stable, the pick is used' : 'NOT stable, the pre-registered default is used'),
    '- **Chosen: ' + g.chosen.name + '**',
    ...g.periods.map((x, k) => (x ? '- ' + PERIODS[k]!.name + ' (out-of-sample): the chosen setup is at the ' + x.percentile.toFixed(0) + 'th percentile of the sweep; ' + x.beatingQqqPct.toFixed(0) + '% of the 54 setups beat QQQ; median ' + pct(x.median) + ', interquartile ' + pct(x.q1) + ' to ' + pct(x.q3) : '')).filter(Boolean));
  let chosen = p1.find((s) => s.setup.name === g.chosen.name)!.setup;
  const base = rh.get(chosen.name)!;
  out.push('', '## Pass 2 — one knob at a time around the pass-1 choice (' + H + ' bps)', '', ...RESULT_HEAD_P2, resultRowP2(chosen.name + ' (pass-1 choice)', base, benchH));
  let best: { s: WinnersSetup; r: WinnersResult[] } | null = null;
  for (const s of winnersPass2(chosen)) { const r = runAll(s, H); out.push(resultRowP2(s.name, r, benchH)); if (r[0]!.finalTaxed > (best ? best.r[0]!.finalTaxed : base[0]!.finalTaxed)) best = { s, r }; }
  if (best && base[0]!.finalTaxed > qqqH[0]!) { out.push('', 'Pass 2 adopts: **' + best.s.name + '** (better in 2010-2019; its neighbour, the pass-1 choice, beats QQQ there).'); chosen = best.s; }
  else out.push('', 'Pass 2 adopts nothing (no knob beats the pass-1 choice in 2010-2019, or the choice does not beat QQQ there).');
  if (chosen.name !== WINNERS_CHOSEN.name) out.push('', '> WARNING: this run chose ' + chosen.name + ', not WINNERS_CHOSEN (' + WINNERS_CHOSEN.name + '); update the constant, the report page and the paper accounts.');
  const final = new Map(costs.map((c) => [c, runAll(chosen, c)]));
  out.push('', '## The chosen setup: **' + chosen.name + '**', '', ...RESULT_HEAD_P2);
  for (const c of costs) out.push(resultRowP2('at ' + c + ' bps', final.get(c)!, benchmarksFor(bag, inp, CASH, { costBps: c })));
  const hind = [...p1].sort((a, b) => rh.get(b.setup.name)!.reduce((x, y) => x + y.finalTaxed, 0) - rh.get(a.setup.name)!.reduce((x, y) => x + y.finalTaxed, 0))[0]!;
  out.push(resultRowP2('picked with hindsight (best over all three periods, never used): ' + hind.setup.name, rh.get(hind.setup.name)!, benchH));
  out.push('', '### Its controls (' + H + ' bps)', '', ...RESULT_HEAD_P2, resultRowP2('the chosen setup', final.get(H)!, benchH), ...controls(chosen).map((c) => resultRowP2(c.name, runAll(c, H), benchH)));
  const fh = final.get(H)!;
  out.push('', '### Adds by zone, cuts (chosen setup, ' + H + ' bps)', '', '| Period | Adds High / Middle / Deep (count) | Money added High / Middle / Deep | Cuts | Cut stocks that were top-N winners again later |', '|---|---|---|---|---|',
    ...PERIODS.map((p, k) => { const a = fh[k]!.adds, tot = a.High.money + a.Middle.money + a.Deep.money || 1; return '| ' + p.name + ' | ' + a.High.n + ' / ' + a.Middle.n + ' / ' + a.Deep.n + ' | ' + [a.High, a.Middle, a.Deep].map((x) => Math.round((x.money / tot) * 100) + '%').join(' / ') + ' | ' + fh[k]!.cuts + ' | ' + fh[k]!.rewinners + ' |'; }));
  const nulls = PERIODS.map((p, k) => winnersNull(bag, inp, p.start, p.end, chosen, H, fh[k]!));
  const nv = nullVerdict({ model: fh[0]!.finalTaxed, nul: nulls[0]! }, [1, 2].map((k) => ({ model: fh[k]!.finalTaxed, nul: nulls[k]! })));
  out.push('', '### Random-signal null (T2e, 100 seeds: the same adds per stock on random days, sized by zone, same cuts, ' + H + ' bps)', '', '| Period | Model | Null median | Null 95th percentile |', '|---|---|---|---|',
    ...PERIODS.map((p, k) => '| ' + p.name + ' | ' + pct(fh[k]!.finalTaxed) + ' | ' + pct(nulls[k]!.median) + ' | ' + pct(nulls[k]!.p95) + ' |'),
    '', 'Verdict: ' + (nv.beatsP95InSample ? 'beats' : 'does NOT beat') + ' the null\'s 95th percentile in 2010-2019; above its median out-of-sample: ' + nv.aboveMedianOutOfSample.map((x, i) => PERIODS[i + 1]!.name + ' ' + (x ? 'yes' : 'no')).join(', ') + ' -> **' + (nv.passes ? 'passes' : 'fails') + '**.');
  const uni = loadBag(priceDir, RESEARCH_UNIVERSE), uinp = { series: uni, qqq: inp.qqq };
  const bags = randomBags([...uni.keys()].sort(), 20, 12), minus = universeMinusList([...uni.keys()].sort());
  out.push('', '### Robustness (T5): 20 random bags of 12 (survivors only, no delisted names) and the universe minus the 14', '', '| Period | QQQ | Bags beating QQQ | Bag average | Universe minus the 14 |', '|---|---|---|---|---|');
  PERIODS.forEach((p, k) => {
    const vs = bags.map((bg) => runWinners(bg.filter((t) => uni.has(t)), uinp, p.start, p.end, chosen, H).finalTaxed);
    out.push('| ' + p.name + ' | ' + pct(qqqH[k]!) + ' | ' + vs.filter((v) => v > qqqH[k]!).length + ' of ' + vs.length + ' | ' + pct(vs.reduce((a, b) => a + b, 0) / vs.length) + ' | ' + pct(runWinners(minus, uinp, p.start, p.end, chosen, H).finalTaxed) + ' |');
  });
  out.push('', 'The universe (' + uni.size + ' stocks) holds only stocks still listed today; deep losers included: ' + ['INTC', 'WBA', 'BA', 'PYPL', 'F'].filter((t) => uni.has(t)).join(', ') + '; delisted names are absent, so these results are an upper bound.');
  out.push('', '### Report columns (' + H + ' bps)', ...reportTable(benchH, [{ name: 'James — Winners & Layering, chosen (' + chosen.name + ')', outcomes: fh }, { name: 'James — Winners & Layering, pre-registered default', outcomes: runAll(WINNERS_DEFAULT_SETUP, H) }], inp.qqq, CASH, LABELS.holdResearchCore));
  process.stdout.write(out.join('\n') + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
