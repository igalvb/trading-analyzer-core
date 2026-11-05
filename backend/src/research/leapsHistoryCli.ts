/**
 * `node src/research/leapsHistoryCli.ts <priceDir> [readsDir] [--cost=0,10]`: the history test of James — LEAPS
 * (model 3, docs/models/plans/03-james-leaps-method.md section 6) and the approximate LEAPS backtester of James —
 * Option Fair Value (model 4, plan 04 sections 6.1-6.3), on the research list, three periods, after the 25% tax, against
 * 📊 Hold QQQ and 📊 Hold the research list (and "join when listed"):
 *   1. calibration: the market fire-sale episodes on our QQQ data; James's GOOG point (Jan 2022 $1000 for $190);
 *   2. 6.1 EXACT (shares): the pre-registered default first; the stock-mode sweep chosen on 2010-2019 with the T2
 *      guards and the random-signal null; the universe minus the 14; the market episodes trade by trade;
 *   3. 6.2 APPROXIMATE (synthetic LEAPS, model 4f): H1 controls (engine pick on Trend 200 and on Everything together),
 *      H2 James's pick on Everything together, H3 the fire-sale accounts at 0.60 / 0.75 / 0.85 and every exit, H4 the
 *      delta cap; each main row across the k x h band (k 0.9-1.4 x RV252, half-spread 1-5%); the Multi-Year Cycle's
 *      LEAPS twin (plan 07 section 8);
 *   4. model 4 6.1: the overextension guard on the engine's buy signals (z >= +2 vs not, +20 / +45 days, Holm);
 *   5. the Rule #131 report columns and the best-days check.
 * Every synthetic-LEAPS figure is APPROXIMATE (no option history exists). Prints markdown.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { PriceSeries } from '../backtest/data.ts';
import { PERIODS } from './lab.ts';
import { runPortfolio, type PortfolioInput, type PortfolioModel, type PortfolioOptions } from './portfolioLab.ts';
import { OWNER_BAG, universeMinusList } from './portfolioCli.ts';
import { RESEARCH_UNIVERSE } from './fetchPrices.ts';
import { benchmarksFor, benchRows, reportTable, bestDays, bestDaysCount, type PeriodOutcome } from './benchmarks.ts';
import { sweepGuard, nullVerdict, randomSignalDays, mulberry32, quantile, NULL_SEED, type SweepSetup, type NullDistribution } from './guards.ts';
import { loadBag, CASH, pct, resultRowP2, RESULT_HEAD_P2 } from './phase2Common.ts';
import type { CompactRead } from './computeReads.ts';
import { runLeaps, LEAPS_FIRE_DEFAULT, type LeapsRunOptions, type LeapsResult } from './leapsLab.ts';
import { marketFireSale, episodesOf, FIRE_SALE_DEFAULT, zSeries, type FireSaleOptions } from '../analysis/options/fireSale.ts';
import { rv252Series, SIM, rateOn } from './optionsSim.ts';
import { bsCall, impliedVol } from '../analysis/options/blackScholes.ts';
import { breakEvenOf } from '../analysis/options/leapsPick.ts';
import { runCycle, CYCLE_CHOSEN } from './cycleCli.ts';
import { forwardReturn, nonOverlapping, holm } from './eventStudy.ts';
import { LABELS } from '../profile/labels.ts';

type Inp = { series: ReadonlyMap<string, PriceSeries>; qqq: PriceSeries };

/** The stock-mode setup knobs of 6.1 (plan 03: drop x turnaround x form x window = 54 nominal; with no turnaround the form and window do nothing, so 30 distinct). */
export interface StockSetup { readonly name: string; readonly fire: FireSaleOptions }
export function stockSweep(): Array<{ setup: StockSetup; knobs: Record<string, number> }> {
  const out: Array<{ setup: StockSetup; knobs: Record<string, number> }> = [];
  [0.3, 0.4, 0.5].forEach((drop, di) => {
    out.push({ setup: { name: 'drop ' + drop * 100 + '%, no turnaround', fire: { ...FIRE_SALE_DEFAULT, stockDrop: drop, turnaround: 'none' } }, knobs: { drop: di, turn: 0, form: 0, win: 1 } });
    (['a', 'b', 'c'] as const).forEach((form, fi) => [10, 20, 40].forEach((window, wi) =>
      out.push({ setup: { name: 'drop ' + drop * 100 + '%, turnaround ' + form + ' within ' + window + ' days', fire: { ...FIRE_SALE_DEFAULT, stockDrop: drop, turnaround: form, window } }, knobs: { drop: di, turn: 1, form: fi, win: wi } })));
  });
  return out;
}
export const STOCK_DEFAULT_NAME = 'drop 40%, turnaround a within 20 days';

const SHARES: LeapsRunOptions = { ...LEAPS_FIRE_DEFAULT, instrument: 'shares' };
const ret = (v: number): string => pct(v);
const exitName: Record<LeapsRunOptions['exit'], string> = { roll60: 'X1 sell at 60 days, re-buy if the 200-day trend holds', roll30: 'X2 roll at 30 days', expiry: 'X3 hold to expiry and exercise', expiryClose: 'X3c sell to close in expiry week when extrinsic > $0.05' };

function main(): void {
  const args = process.argv.slice(2);
  const [priceDir, readsDir] = args.filter((a) => !a.startsWith('--')) as [string, string | undefined];
  const costArg = args.find((a) => a.startsWith('--cost'));
  const costs = costArg ? (costArg.split('=')[1] ?? '0,10').split(',').map(Number) : [0, 10];
  const H = costs.includes(10) ? 10 : costs[costs.length - 1]!;
  const series = loadBag(priceDir, OWNER_BAG);
  const bag = OWNER_BAG.filter((t) => series.has(t));
  const qqq = loadBag(priceDir, ['QQQ']).get('QQQ')!;
  const reads = new Map<string, Map<string, CompactRead>>();
  if (readsDir) for (const t of bag) { const f = path.join(readsDir, t + '.reads.json'); if (fs.existsSync(f)) reads.set(t, new Map((JSON.parse(fs.readFileSync(f, 'utf8')) as CompactRead[]).map((r) => [r.d, r]))); }
  const inp: PortfolioInput = { series, reads, qqq };
  const runAll = (o: LeapsRunOptions, cost: number, b: readonly string[] = bag, x: Inp = inp): LeapsResult[] => PERIODS.map((p) => runLeaps(b, x, p.start, p.end, { ...o, costBps: cost }));
  const out: string[] = ['# James — LEAPS and James — Option Fair Value: history test', '',
    'The 14: ' + bag.join(', ') + '. $100,000, decide at the close, fill at the next open, 25% tax on every gain, values after the tax on what is still held (calls at the mid). 6.1 is EXACT (shares). 6.2 is APPROXIMATE: no option history exists, so every call is priced by Black-Scholes (G2) at k x the stock\'s 1-year realized volatility (floor 15%), the previous month\'s Fed funds rate, the computed January third Friday, a strike solved for the target delta, buying at mid x (1 + h) and selling at mid x (1 - h). Synthetic LEAPS only after 252 bars of a stock\'s history (the share runs use the same rule).'];

  // ── 1. calibration ──
  const mk = marketFireSale(qqq.closes);
  out.push('', '## 1. Calibration', '', '### Market fire-sale episodes on our QQQ data (QQQ >= 20% under its 52-week closing high; an episode ends 60 trading days after its last such close)', '', '| Episode | First close | Last close in the zone | Closes in the zone | Deepest |', '|---|---|---|---|---|');
  for (const e of episodesOf(mk)) {
    let n = 0, deep = 0; for (let i = e.start; i <= e.lastOn; i++) if (mk[i]!.on) { n++; deep = Math.max(deep, mk[i]!.dd); }
    out.push('| ' + e.id + ' | ' + qqq.dates[e.start] + ' | ' + qqq.dates[e.lastOn] + ' | ' + n + ' | -' + Math.round(deep * 100) + '% |');
  }
  const g = series.get('GOOGL'), gi = g ? g.dates.indexOf('2020-03-23') : -1;
  if (g && gi >= 0) {
    const rv = rv252Series(g)[gi] as number, rv60 = ((): number => { const c = g.closes.slice(gi - 60, gi + 1); const r = c.slice(1).map((x, k) => Math.log(x / (c[k] as number))); const m = r.reduce((a, b) => a + b, 0) / r.length; return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(252); })();
    const T = 672 / 365, iv = impliedVol(190, { S: 1000, K: 1000, T, r: 0.01 }) as number, be = breakEvenOf(1000, 1000, 190, 672);
    out.push('', '### James\'s GOOG point (the only LEAPS buy with a full price: Jan 2022 $1000 call for $190, stock about $1000, about 672 days, rate about 1%)', '',
      '- Break-even $' + be.breakEven + ' (+' + (be.bem * 100).toFixed(1) + '%), per year +' + ((be.bemYear as number) * 100).toFixed(1) + '% (passes the 12% gate); implied volatility ' + (iv * 100).toFixed(1) + '%.',
      '- Our GOOGL on 2020-03-23: RV252 ' + (rv * 100).toFixed(1) + '% -> $' + bsCall({ S: 1000, K: 1000, T, sigma: rv, r: 0.01 }).toFixed(0) + '; RV60 ' + (rv60 * 100).toFixed(1) + '% -> $' + bsCall({ S: 1000, K: 1000, T, sigma: rv60, r: 0.01 }).toFixed(0) + '. k on RV252 that reproduces $190: ' + (iv / rv).toFixed(2) + ' (the backtester uses k = 1.0 with the band 0.9-1.4; Fed funds that month ' + (rateOn('2020-03-23') * 100).toFixed(2) + '%).',
      '- One point only; the G3 nightly snapshots (from phase 0) are the real calibration once 60 nights exist.');
  }

  // ── 2. 6.1 exact, shares ──
  out.push('', '## 2. 6.1 EXACT — the timing in shares (5 slots, idle money in QQQ, the armed trend-200 sell)');
  for (const cost of costs) {
    const bench = benchmarksFor(bag, inp, CASH, { costBps: cost });
    const def = runAll(SHARES, cost);
    out.push('', '### ' + cost + ' bps per side' + (cost === H ? ' (headline)' : ''), '', ...RESULT_HEAD_P2, ...benchRows(bench, CASH, 1, ['', '', 'fall', ''], LABELS.holdResearchCore),
      resultRowP2('**James — LEAPS timing in shares, pre-registered default** (market fire sale 20%, no turnaround, one buy per stock per episode; OR stock fire sale 40% + a -2 SD close, then a close above the 20-day average within 20 days)', def, bench),
      resultRowP2('market fire sale only', runAll({ ...SHARES, stock: false }, cost), bench),
      resultRowP2('stock fire sale only', runAll({ ...SHARES, market: false }, cost), bench),
      resultRowP2('market fire sale WITH a turnaround (QQQ back above its 20-day average)', runAll({ ...SHARES, fire: { ...FIRE_SALE_DEFAULT, marketTurnaround: true } }, cost), bench),
      resultRowP2('stock fire sale WITHOUT a turnaround', runAll({ ...SHARES, fire: { ...FIRE_SALE_DEFAULT, turnaround: 'none' } }, cost), bench),
      resultRowP2('market threshold 15% (reported, never chosen)', runAll({ ...SHARES, fire: { ...FIRE_SALE_DEFAULT, marketDrop: 0.15 } }, cost), bench),
      resultRowP2('market threshold 25% (reported, never chosen)', runAll({ ...SHARES, fire: { ...FIRE_SALE_DEFAULT, marketDrop: 0.25 } }, cost), bench));
    out.push('', 'Buys per period (default): ' + def.map((r) => r.entries.length).join(' / ') + '.');
  }
  // the stock-mode sweep, chosen on 2010-2019
  const sw = stockSweep();
  const benchH = benchmarksFor(bag, inp, CASH, { costBps: H }), qqqH = benchH.qqq.map((x) => x.finalTaxed);
  const res = new Map(sw.map((s) => [s.setup.name, runAll({ ...SHARES, market: false, fire: s.setup.fire }, H)]));
  const gd = sweepGuard(sw.map((s) => ({ name: s.setup.name, knobs: s.knobs, finals: res.get(s.setup.name)!.map((x) => x.finalTaxed) }) as SweepSetup), STOCK_DEFAULT_NAME, qqqH);
  out.push('', '### Stock-mode sweep (stock fire sale only, ' + sw.length + ' distinct setups of the plan\'s 54 — with no turnaround the form and window do nothing — at ' + H + ' bps), sorted by 2010-2019', '', ...RESULT_HEAD_P2);
  for (const s of [...sw].sort((a, b) => res.get(b.setup.name)![0]!.finalTaxed - res.get(a.setup.name)![0]!.finalTaxed)) out.push(resultRowP2(s.setup.name + (s.setup.name === STOCK_DEFAULT_NAME ? ' **(default)**' : ''), res.get(s.setup.name)!, benchH));
  out.push('', '#### Sweep guard (T2), chosen on 2010-2019 only', '',
    '- Pre-registered default: ' + gd.defaultSetup.name + ' — ' + gd.defaultSetup.finals.map(pct).join(' / '), '- Best in 2010-2019: ' + gd.picked.name + ' — ' + gd.picked.finals.map(pct).join(' / '),
    '- Stable neighbourhood: ' + gd.neighboursBeatingQqq + ' of ' + gd.neighbours + ' one-step neighbours beat QQQ in 2010-2019 -> ' + (gd.stable ? 'stable, the pick is used' : 'NOT stable, the pre-registered default is used'),
    '- **Chosen: ' + gd.chosen.name + '**',
    ...gd.periods.map((x, k) => (x ? '- ' + PERIODS[k]!.name + ' (out-of-sample): the chosen setup is at the ' + x.percentile.toFixed(0) + 'th percentile of the sweep; ' + x.beatingQqqPct.toFixed(0) + '% of the setups beat QQQ; median ' + pct(x.median) + ', interquartile ' + pct(x.q1) + ' to ' + pct(x.q3) : '')).filter(Boolean));
  const chosenStock = sw.find((s) => s.setup.name === gd.chosen.name)!.setup;
  const chosenOpts: LeapsRunOptions = { ...SHARES, market: false, fire: chosenStock.fire };
  const fh = res.get(chosenStock.name)!;
  // random-signal null: the same buys per stock on random days, same exits
  const daysIn = (s: string, e: string): string[] => qqq.dates.filter((d) => d >= s && d <= e).slice(0, -1);
  const nulls: NullDistribution[] = PERIODS.map((p, k) => {
    const days = daysIn(p.start, p.end);
    const pools = new Map(bag.map((t) => { const s = series.get(t)!, have = new Set(s.dates), i0 = s.dates[252]; return [t, i0 ? days.filter((d) => d >= i0 && have.has(d)) : []] as const; }));
    const daysOf = (t: string): string[] => pools.get(t) ?? [];
    const vs = Array.from({ length: 100 }, (_, j) => runLeaps(bag, inp, p.start, p.end, { ...chosenOpts, costBps: H, buyDays: randomSignalDays(fh[k]!.buysByTicker, daysOf, mulberry32(NULL_SEED + j)) }).finalTaxed);
    return { values: vs, median: quantile(vs, 0.5), p95: quantile(vs, 0.95) };
  });
  const nv = nullVerdict({ model: fh[0]!.finalTaxed, nul: nulls[0]! }, [1, 2].map((k) => ({ model: fh[k]!.finalTaxed, nul: nulls[k]! })));
  out.push('', '#### Random-signal null (T2e, 100 seeds: the same number of buys per stock on random days, the same exits, ' + H + ' bps)', '', '| Period | Model | Null median | Null 95th percentile |', '|---|---|---|---|',
    ...PERIODS.map((p, k) => '| ' + p.name + ' | ' + pct(fh[k]!.finalTaxed) + ' | ' + pct(nulls[k]!.median) + ' | ' + pct(nulls[k]!.p95) + ' |'),
    '', 'Verdict: ' + (nv.beatsP95InSample ? 'beats' : 'does NOT beat') + ' the null\'s 95th percentile in 2010-2019; above its median later: ' + nv.aboveMedianOutOfSample.map((x, i) => PERIODS[i + 1]!.name + ' ' + (x ? 'yes' : 'no')).join(', ') + ' -> **' + (nv.passes ? 'passes' : 'fails') + '**.');
  // the universe minus the 14
  const uni = loadBag(priceDir, RESEARCH_UNIVERSE), minus = universeMinusList([...uni.keys()].sort());
  const uinp = { series: uni, qqq };
  const ub = benchmarksFor(minus, { series: uni, reads: new Map(), qqq }, CASH, { costBps: H });
  out.push('', '#### The universe minus the 14 (' + minus.length + ' survivors; deep losers included: ' + ['INTC', 'WBA', 'BA', 'PYPL', 'F'].filter((t) => uni.has(t)).join(', ') + '; delisted names absent), ' + H + ' bps', '', ...RESULT_HEAD_P2, ...benchRows(ub, CASH, 1, ['', '', 'fall', ''], 'Hold the universe minus the 14 equally'),
    resultRowP2('chosen stock-mode setup', runAll(chosenOpts, H, minus, uinp), ub), resultRowP2('pre-registered default (market OR stock)', runAll(SHARES, H, minus, uinp), ub));
  // market mode, descriptive
  out.push('', '### Market mode, trade by trade (descriptive; four events are anecdote, not proof): every stock of the 14 bought in each episode, 5 slots, deepest fall first', '', '| Episode | Wait | Day decided | Stock | Its fall | Stock 1 year later | 2 years later |', '|---|---|---|---|---|---|---|');
  for (const wait of [false, true]) {
    const r = runLeaps(bag, inp, '2010-01-01', PERIODS[2]!.end, { ...SHARES, stock: false, fire: { ...FIRE_SALE_DEFAULT, marketTurnaround: wait }, costBps: H });
    for (const e of r.entries.filter((x) => x.kind === 'market')) {
      const s = series.get(e.t)!, k = s.dates.indexOf(e.day);
      const f = (hh: number): string => (k + hh < s.closes.length ? pct(CASH * ((s.closes[k + hh] as number) / (s.opens[k + 1] as number))) : '—');
      out.push('| ' + e.episode + ' | ' + (wait ? 'QQQ turnaround' : 'none (default)') + ' | ' + e.day + ' | ' + e.t + ' | ' + e.why.replace('market fire sale: ', '') + ' | ' + f(252) + ' | ' + f(504) + ' |');
    }
  }

  // ── 3. 6.2 approximate ──
  out.push('', '## 3. 6.2 APPROXIMATE — synthetic LEAPS (model 4f), ' + H + ' bps on the stock legs, k = 1.0, h = 3% unless stated', '',
    '**Every number in this section is approximate.** Limits: no volatility skew or term structure (deep-ITM flattered), crash IV only through RV, no real spreads or open interest (thin names look tradable), no dividends, European formula, listings unknown, the 14 chosen with hindsight, survivors only.');
  const LEAPS = LEAPS_FIRE_DEFAULT;
  const twinWant = (model: PortfolioModel, po: Partial<PortfolioOptions>, p: { start: string; end: string }): Map<string, Set<string>> => {
    const m = new Map<string, Set<string>>();
    runPortfolio(model, bag, inp, p.start, p.end, { slots: 3, cash: CASH, costBps: H, ...po, onDecide: (d, w) => m.set(d, new Set(w)) });
    return m;
  };
  const twinRuns = (model: PortfolioModel, po: Partial<PortfolioOptions>, o: Partial<LeapsRunOptions>): LeapsResult[] => PERIODS.map((p) => runLeaps(bag, inp, p.start, p.end, { ...LEAPS, entry: 'twin', slots: (po.slots ?? 3), want: twinWant(model, po, p), costBps: H, ...o }));
  const T200: Partial<PortfolioOptions> = { exit: 'trend', trendDays: 200 };
  const haveReads = reads.size > 0;
  const rows: Array<{ name: string; r: LeapsResult[] }> = [];
  const add = (name: string, r: LeapsResult[]): void => { rows.push({ name, r }); };
  add('H1 control: LEAPS twin of Trend 200 (3), the engine\'s pick (furthest January <= 32 months, >= 180 days, delta 0.75), X1', twinRuns('trend', { slots: 3, trendDays: 200 }, { pick: 'engine', exit: 'roll60', beGate: null }));
  if (haveReads) {
    add('H1 control: LEAPS twin of Everything together (3, 200-day sell), the engine\'s pick, X1', twinRuns('best', { slots: 3, ...T200 }, { pick: 'engine', exit: 'roll60', beGate: null }));
    for (const dl of [0.6, 0.75, 0.85]) for (const ex of ['roll60', 'expiry'] as const) add('H2: twin of Everything together, James\'s pick (January ~19 months, delta ' + dl.toFixed(2) + ', break-even gate), ' + exitName[ex], twinRuns('best', { slots: 3, ...T200 }, { pick: 'james', delta: dl, exit: ex }));
  }
  for (const dl of [0.6, 0.75, 0.85]) for (const ex of ['roll60', 'roll30', 'expiry', 'expiryClose'] as const) add('H3: fire sale (default), James\'s pick delta ' + dl.toFixed(2) + ', ' + exitName[ex], runAll({ ...LEAPS, delta: dl, exit: ex }, H));
  add('H3: fire sale, 0.75, X3 + X4 spike trim (a third at z >= +2, once per 60 days)', runAll({ ...LEAPS, trim: true }, H));
  add('H3: fire sale, 0.75, X3 + X5 thesis stop (a close under the fire-sale low)', runAll({ ...LEAPS, thesisStop: true }, H));
  add('H3: fire sale, 0.75, X1 + X4 + X5', runAll({ ...LEAPS, exit: 'roll60', trim: true, thesisStop: true }, H));
  add('**H4: fire sale, 0.75, X3, delta-capped at 1.0 x equity (the headline account, decision 4)**', runAll({ ...LEAPS, deltaCap: 1 }, H));
  add('H4: fire sale, 0.75, X1, delta-capped at 1.0 x equity', runAll({ ...LEAPS, exit: 'roll60', deltaCap: 1 }, H));
  // the Multi-Year Cycle's LEAPS twin (plan 07 section 8)
  const cycWant = (p: { start: string; end: string }): Map<string, Set<string>> => { const m = new Map<string, Set<string>>(); runCycle(bag, inp, p.start, p.end, CYCLE_CHOSEN, H, null, (d, w) => m.set(d, new Set(w))); return m; };
  const cycTwin = PERIODS.map((p) => runLeaps(bag, inp, p.start, p.end, { ...LEAPS, entry: 'twin', slots: 5, want: cycWant(p), exit: 'roll60', costBps: H }));
  add('James — Multi-Year Cycle, LEAPS twin (the chosen cycle setup\'s holdings, James\'s pick 0.75, X1)', cycTwin);
  const cycShares = PERIODS.map((p) => runCycle(bag, inp, p.start, p.end, CYCLE_CHOSEN, H));
  out.push('', '| Row | 2010-2019 | 2020-2023 | 2024-2026 | Beats QQQ | Beats the 14 (plain / join) | Deepest fall | Trades | Exercised / expired worthless | Avg / peak delta exposure | Time in LEAPS |', '|---|---|---|---|---|---|---|---|---|---|---|',
    ...benchRows(benchH, CASH, 1, ['', '', 'fall', '', '', '', ''], LABELS.holdResearchCore),
    resultRowP2('Same timing in shares (6.1 default, exact)', runAll(SHARES, H), benchH) + ' — | — | — |',
    resultRowP2('James — Multi-Year Cycle in shares (phase 3 chosen, exact)', cycShares, benchH) + ' — | — | — |',
    ...rows.map((x) => resultRowP2(x.name, x.r, benchH) + ' ' + x.r.map((y) => y.exercises + '/' + y.expiredWorthless).join(' · ') + ' | ' + x.r.map((y) => y.avgExposure.toFixed(1) + '/' + y.peakExposure.toFixed(1)).join(' · ') + ' | ' + x.r.map((y) => y.daysInLeapsPct.toFixed(0) + '%').join(' · ') + ' |'));
  if (!haveReads) out.push('', 'No reads folder given: the Everything-together twins (H1 / H2) were not run.');
  // the band
  const band = (name: string, o: LeapsRunOptions | ((k: number, h: number) => LeapsResult[])): void => {
    out.push('', '#### Band: ' + name, '', '| k \\ h | ' + SIM.hs.map((h) => (h * 100).toFixed(0) + '%').join(' | ') + ' |', '|---|' + SIM.hs.map(() => '---|').join(''));
    let allBeat = true;
    for (const k of SIM.ks) {
      const cells = SIM.hs.map((h) => {
        const r = typeof o === 'function' ? o(k, h) : runAll({ ...o, sim: { ...o.sim, k, h } }, H);
        const beat = [1, 2].every((p) => r[p]!.finalTaxed > benchH.qqq[p]!.finalTaxed && r[p]!.finalTaxed > benchH.list[p]!.finalTaxed && r[p]!.finalTaxed > benchH.listJoin[p]!.finalTaxed);
        if (!beat) allBeat = false;
        return r.map((x) => ret(x.finalTaxed)).join(' / ') + ' (fall -' + Math.max(...r.map((x) => x.maxDrawdownPct)).toFixed(0) + '%)' + (beat ? ' ✅' : '');
      });
      out.push('| ' + k.toFixed(1) + ' x RV252 | ' + cells.join(' | ') + ' |');
    }
    out.push('', '✅ = beats 📊 Hold QQQ and both 📊 ' + LABELS.holdList + ' in BOTH 2020-2023 and 2024-2026. Acceptance 4 (plan 03): ' + (allBeat ? '**holds across the whole band**' : '**does not hold across the whole band -> "not distinguishable from the approximation"**') + '.');
  };
  band('H4 headline — fire sale, 0.75, X3, delta-capped', { ...LEAPS, deltaCap: 1 });
  band('H3 main uncapped — fire sale, 0.75, X3', LEAPS);
  if (haveReads) {
    const want = PERIODS.map((p) => twinWant('best', { slots: 3, ...T200 }, p));
    const tw = (o: Partial<LeapsRunOptions>) => (k: number, h: number): LeapsResult[] => PERIODS.map((p, i) => runLeaps(bag, inp, p.start, p.end, { ...LEAPS, entry: 'twin', slots: 3, want: want[i]!, costBps: H, ...o, sim: { k, h, floor: SIM.floor } }));
    band('H2 — Everything together twin, James\'s pick 0.75, X1', tw({ pick: 'james', exit: 'roll60' }));
    band('H1 — Everything together twin, the engine\'s pick, X1 (the control of james.leaps.twin.best)', tw({ pick: 'engine', exit: 'roll60', beGate: null }));
    // James's pick vs the engine's on the same stocks, per band cell
    let wins = 0, cells = 0;
    for (const k of SIM.ks) for (const h of SIM.hs) { const a = tw({ pick: 'james', exit: 'roll60' })(k, h), b = tw({ pick: 'engine', exit: 'roll60', beGate: null })(k, h); for (const p of [1, 2]) { cells++; if (a[p]!.finalTaxed > b[p]!.finalTaxed) wins++; } }
    out.push('', 'James\'s pick vs the engine\'s pick on the same stocks (Everything together, X1): James\'s is ahead in ' + wins + ' of ' + cells + ' out-of-sample band cells (2 periods x 12).');
  }

  // ── 4. model 4 6.1: the overextension guard ──
  if (haveReads) {
    out.push('', '## 4. Model 4, 6.1 EXACT — the overextension guard on the engine\'s buy signals (z >= +2 at the entry vs not; one signal per stock per window; Holm across the two horizons; the primary test is +20 days in 2010-2019)', '', '| Period | Horizon | Signals z >= +2 | Mean | Signals z < +2 | Mean | Difference | p (z >= +2 worse) | Holm |', '|---|---|---|---|---|---|---|---|---|');
    for (const p of PERIODS) {
      const rowsP: Array<{ h: number; a: number[]; b: number[] }> = [];
      for (const hz of [20, 45]) {
        const a: number[] = [], b: number[] = [];
        for (const t of bag) {
          const s = series.get(t)!, rd = reads.get(t); if (!rd) continue;
          const z = zSeries(s.closes, 20).z;
          const idxHi: number[] = [], idxLo: number[] = [];
          s.dates.forEach((d, k) => { if (d < p.start || d > p.end) return; const r = rd.get(d); if (!r || r.ok !== 1 || r.c == null || !(r.tm === 'BUY_NOW' || r.c >= 70)) return; ((z[k] ?? 0) >= 2 ? idxHi : idxLo).push(k); });
          for (const k of nonOverlapping(idxHi, hz)) { const f = forwardReturn(s, k, hz); if (f != null) a.push(f); }
          for (const k of nonOverlapping(idxLo, hz)) { const f = forwardReturn(s, k, hz); if (f != null) b.push(f); }
        }
        rowsP.push({ h: hz, a, b });
      }
      const ps = rowsP.map((x) => permP(x.a, x.b));
      const adj = holm(ps);
      rowsP.forEach((x, i) => { const ma = mean(x.a), mb = mean(x.b); out.push('| ' + p.name + ' | +' + x.h + ' days | ' + x.a.length + ' | ' + pp(ma) + ' | ' + x.b.length + ' | ' + pp(mb) + ' | ' + pp(ma - mb) + ' | ' + ps[i]!.toFixed(3) + ' | ' + adj[i]!.toFixed(3) + ' |'); });
    }
    out.push('', 'p = the share of 2000 random relabellings (seeded) whose z >= +2 group mean is at most the observed one (one-sided: "worse"). The earnings guard is not tested on history: past earnings dates are not in the research data.');
  }

  // ── 5. report columns ──
  const main = rows.find((x) => x.name.startsWith('**H4'))!;
  const unc = rows.find((x) => x.name.startsWith('H3: fire sale (default), James\'s pick delta 0.75, X3 hold'))!;
  out.push('', '## 5. Report columns (' + H + ' bps; LEAPS rows approximate)', ...reportTable(benchH, [
    { name: 'James — LEAPS timing in shares (6.1 default, exact)', outcomes: runAll(SHARES, H) as PeriodOutcome[] },
    { name: 'James — LEAPS fire sale 0.75, X3, capped (approximate)', outcomes: main.r },
    { name: 'James — LEAPS fire sale 0.75, X3, uncapped (approximate)', outcomes: unc.r },
  ], qqq, CASH, LABELS.holdResearchCore));
  out.push('', 'Best days spent WITHOUT any LEAPS (the capped headline account): ' + PERIODS.map((p, k) => { const bd = bestDays(qqq, p.start, p.end, bestDaysCount(p.start, p.end)); const m = main.r[k]!.noLeapsByDay; return p.name + ' ' + bd.filter((d) => (m.get(d) ?? 1) === 1).length + ' of ' + bd.length; }).join(', ') + '.');
  process.stdout.write(out.join('\n') + '\n');
}

const mean = (x: readonly number[]): number => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
const pp = (v: number): string => (Number.isNaN(v) ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%');
/** One-sided permutation p that group a's mean is below group b's. */
function permP(a: readonly number[], b: readonly number[], draws = 2000): number {
  if (!a.length || !b.length) return 1;
  const obs = mean(a) - mean(b), all = [...a, ...b], rnd = mulberry32(NULL_SEED);
  let atMost = 0;
  for (let d = 0; d < draws; d++) {
    const xs = [...all];
    for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [xs[i], xs[j]] = [xs[j]!, xs[i]!]; }
    if (mean(xs.slice(0, a.length)) - mean(xs.slice(a.length)) <= obs) atMost++;
  }
  return (atMost + 1) / (draws + 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
