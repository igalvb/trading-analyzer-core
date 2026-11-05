/**
 * `node src/research/cycleCli.ts <priceDir> [--cost=0,10]`: the history test of James — Multi-Year Cycle, Part A
 * (docs/models/plans/07-multi-year-cycle.md section 6) on the research list, three periods, after the 25% tax, against
 * 📊 Hold QQQ and 📊 Hold the research list (and "join when listed"): the calibration check, the pre-registered default first,
 * pass 1 (X x bottom test x turnaround x top test = 54), the T2 sweep guard chosen on 2010-2019 only, pass 2 one knob at
 * a time, the random-signal null (deploys and harvests on random days), the panic-sell comparison (rule 5), false
 * bottoms on the universe minus the 14, random bags, and the report columns. 2020-2023 is in-sample by construction
 * (James's META / TSLA / SOL examples sit in it), so 2024-2026 is the only clean out-of-sample period. Parts B and C
 * (BTC halving calendar and regime) and the money-market reference need BTC-USD, which is not in the research download:
 * not run on history. Prints markdown.
 */

import type { PriceSeries } from '../backtest/data.ts';
import { PERIODS } from './lab.ts';
import type { PortfolioInput } from './portfolioLab.ts';
import { OWNER_BAG, randomBags, universeMinusList } from './portfolioCli.ts';
import { RESEARCH_UNIVERSE } from './fetchPrices.ts';
import { benchmarksFor, benchRows, reportTable, type PeriodOutcome } from './benchmarks.ts';
import { sweepGuard, nullVerdict, randomSignalDays, mulberry32, quantile, NULL_SEED, type SweepSetup, type NullDistribution } from './guards.ts';
import { newCycleBook, cycleFill, cycleDecide, cycleValue, cycleEquity, loadFedFunds, CYCLE_DEFAULT, type CycleOptions, type CycleCtx } from './cycleLab.ts';
import { cycleSignals, isDeepBottom, type CycleSignals } from '../analysis/models/cycleRegime.ts';
import { loadBag, CASH, pct, resultRowP2, RESULT_HEAD_P2 } from './phase2Common.ts';
import { LABELS } from '../profile/labels.ts';

export interface CycleSetup { readonly name: string; readonly o: CycleOptions }
export const cycleName = (o: CycleOptions): string => 'X ' + Math.round(o.x * 100) + '%, ' + (o.bottomTest === '200w' ? 'under the 200-week average' : 'weekly RSI < 30') + ', '
  + ({ none: 'no turnaround gate', sma20: 'turnaround: close > 20-day average', w10: 'turnaround: weekly close > 10-week average' } as const)[o.gate] + ', ' + (o.topTest === 'mayer' ? 'Mayer >= ' + o.m.toFixed(1) : 'weekly z >= +3');
export const CYCLE_DEFAULT_SETUP: CycleSetup = { name: cycleName(CYCLE_DEFAULT), o: CYCLE_DEFAULT };
/**
 * The setup chosen on 2010-2019 only (this CLI, pass 1 + pass 2 at 10 bps; docs/models/results/phase3.md). Used by the
 * paper account, the windows grid and the report page.
 */
export const CYCLE_CHOSEN: CycleSetup = (() => {
  const o: CycleOptions = { ...CYCLE_DEFAULT, x: 0.6, bottomTest: 'rsi', gate: 'sma20', topTest: 'z', startDry: 0.2 };
  return { name: cycleName(o) + ' + start with 20% dry powder', o };
})();

const SIG = new WeakMap<PriceSeries, CycleSignals>();
export const signalsOf = (s: PriceSeries): CycleSignals => { let x = SIG.get(s); if (!x) { x = cycleSignals(s); SIG.set(s, x); } return x; };

export interface CycleResult extends PeriodOutcome {
  readonly finalTaxed: number; readonly maxDrawdownPct: number; readonly trades: number;
  readonly cashShareByDay: Map<string, number>;
  readonly deploysByTicker: Map<string, number>; readonly harvestsByTicker: Map<string, number>;
  readonly deploys: number; readonly harvests: number; readonly rotations: number; readonly dryPct: number;
  /** panic variants: stop sales within 10% of the stock's 52-week closing low. */
  readonly panicSales: number; readonly panicNearLow: number;
}

let FED: ((d: string) => number) | null = null;
const fed = (d: string): number => (FED ??= loadFedFunds())(d);

/** One run over [start, end]. `rnd`: the null's random deploy / harvest days per ticker. */
export function runCycle(bag: readonly string[], inp: Pick<PortfolioInput, 'series' | 'qqq'>, start: string, end: string, s: CycleSetup, costBps = 0,
  rnd?: { deploy: ReadonlyMap<string, ReadonlySet<string>>; harvest: ReadonlyMap<string, ReadonlySet<string>> } | null,
  /** James — LEAPS (phase 4): the cycle's LEAPS twin reads the stocks held or being bought after each close's decisions. */
  onDecide?: (day: string, want: readonly string[]) => void): CycleResult {
  const o: CycleOptions = { ...s.o, costBps };
  const b = newCycleBook(CASH);
  const live = bag.filter((t) => inp.series.has(t));
  const ser = (t: string): PriceSeries => (t === 'QQQ' ? inp.qqq : (inp.series.get(t) as PriceSeries));
  const idx = new Map([...live, 'QQQ'].map((t) => [t, new Map(ser(t).dates.map((d, i) => [d, i]))]));
  const sigs = new Map(live.map((t) => [t, signalsOf(ser(t))]));
  const qs = signalsOf(inp.qqq);
  const days = inp.qqq.dates.filter((d) => d >= start && d <= end);
  let peak = CASH, dd = 0, trades = 0, deploys = 0, harvests = 0, rotations = 0, drySum = 0, panicSales = 0, panicNearLow = 0;
  const last = new Map<string, number>(), cashShareByDay = new Map<string, number>(), deploysByTicker = new Map<string, number>(), harvestsByTicker = new Map<string, number>();
  for (let n = 0; n < days.length; n++) {
    const d = days[n] as string, qk = idx.get('QQQ')!.get(d)!;
    const opens = new Map<string, number>(), stocks = new Map<string, { s: CycleSignals; i: number; close: number }>();
    for (const t of live) { const k = idx.get(t)!.get(d); if (k == null) continue; const x = ser(t); opens.set(t, x.opens[k] as number); last.set(t, x.closes[k] as number); stocks.set(t, { s: sigs.get(t)!, i: k, close: x.closes[k] as number }); }
    last.set('QQQ', inp.qqq.closes[qk] as number);
    if (n > 0) {
      for (const x of cycleFill(b, o, opens, inp.qqq.opens[qk] as number, o.idle === 'cash' ? fed(d) : 0)) {
        if (x.ticker === 'QQQ') continue;
        trades++;
        if (x.kind === 'harvest') { harvests++; harvestsByTicker.set(x.ticker, (harvestsByTicker.get(x.ticker) ?? 0) + 1); }
        if (x.kind === 'rotate' && x.side === 'BUY') rotations++;
        if (x.kind === 'panic') { panicSales++; const a = stocks.get(x.ticker); if (a) { let lo = Infinity; for (let k = Math.max(0, a.i - 251); k <= a.i; k++) lo = Math.min(lo, a.s.close[k] as number); if (x.price <= lo * 1.1) panicNearLow++; } }
      }
    }
    if (n < days.length - 1) {
      const before = b.deploys.length, had = new Set(b.deploys.map((x) => x.t));
      const ctx: CycleCtx = { day: d, stocks, qqqRet126: qs.ret126[qk] ?? null, qqqClose: inp.qqq.closes[qk] as number,
        ...(rnd ? { randomDeploy: new Set([...rnd.deploy].filter(([, ds]) => ds.has(d)).map(([t]) => t)), randomHarvest: new Set([...rnd.harvest].filter(([, ds]) => ds.has(d)).map(([t]) => t)) } : {}) };
      cycleDecide(b, o, ctx);
      for (const x of b.deploys) if (!had.has(x.t)) { deploys++; deploysByTicker.set(x.t, (deploysByTicker.get(x.t) ?? 0) + 1); }
      void before;
      if (onDecide) onDecide(d, [...new Set([...Object.keys(b.pos), ...b.orders.filter((y) => y.side === 'BUY' && y.t !== 'QQQ').map((y) => y.t)])]);
    }
    const closeOf = (t: string): number | null => last.get(t) ?? null;
    const eq = cycleEquity(b, closeOf);
    peak = Math.max(peak, eq); dd = Math.max(dd, (1 - eq / peak) * 100);
    const share = eq > 0 ? Math.min(1, Math.max(0, b.cash) / eq) : 1;
    cashShareByDay.set(d, share); drySum += share;
  }
  return { finalTaxed: cycleValue(b, (t) => last.get(t) ?? null), maxDrawdownPct: dd, trades, cashShareByDay, deploysByTicker, harvestsByTicker, deploys, harvests, rotations, dryPct: days.length ? (drySum / days.length) * 100 : 0, panicSales, panicNearLow };
}

/** T2(e): the same number of deployments and harvests per stock on random days, the same rules otherwise, 100 seeds. */
export function cycleNull(bag: readonly string[], inp: Pick<PortfolioInput, 'series' | 'qqq'>, start: string, end: string, s: CycleSetup, costBps: number, r: CycleResult, seeds = 100): NullDistribution {
  const days = inp.qqq.dates.filter((d) => d >= start && d <= end).slice(0, -1);
  const daysOf = (t: string): string[] => { const has = new Set(inp.series.get(t)?.dates ?? []); return days.filter((d) => has.has(d)); };
  const values = Array.from({ length: seeds }, (_, k) => {
    const rd = mulberry32(NULL_SEED + k), rh = mulberry32(NULL_SEED + 10_000 + k);
    return runCycle(bag, inp, start, end, s, costBps, { deploy: randomSignalDays(r.deploysByTicker, daysOf, rd), harvest: randomSignalDays(r.harvestsByTicker, daysOf, rh) }).finalTaxed;
  });
  return { values, median: quantile(values, 0.5), p95: quantile(values, 0.95) };
}

/** Pass 1: X (40 / 50 / 60%) x bottom test (200-week, weekly RSI) x turnaround (none, 20-day, 10-week) x top (Mayer 2.0 / 2.4, weekly z) = 54. */
export function cyclePass1(): Array<{ setup: CycleSetup; knobs: Record<string, number> }> {
  const out: Array<{ setup: CycleSetup; knobs: Record<string, number> }> = [];
  [0.4, 0.5, 0.6].forEach((x, xi) => (['200w', 'rsi'] as const).forEach((bottomTest, bi) => (['none', 'sma20', 'w10'] as const).forEach((gate, gi) =>
    ([['mayer', 2.0], ['mayer', 2.4], ['z', 2.0]] as const).forEach(([topTest, m], ti) => {
      const o: CycleOptions = { ...CYCLE_DEFAULT, x, bottomTest, gate, topTest, m };
      out.push({ setup: { name: cycleName(o), o }, knobs: { x: xi, bottom: bi, gate: gi, top: ti } });
    }))));
  return out;
}
export function cyclePass2(base: CycleSetup): CycleSetup[] {
  const v = (name: string, x: Partial<CycleOptions>): CycleSetup => ({ name: base.name + ' + ' + name, o: { ...base.o, ...x } });
  return [
    v('lump deploy (1 tranche)', { tranches: 1 }), v('3 bottoms at once', { kb: 3 }), v('harvest 10%', { p: 0.1 }), v('harvest 25%', { p: 0.25 }),
    v('rotate 0%', { r: 0 }), v('rotate 100%', { r: 1 }), v('full rotation on', { fullRotation: true }), v('K = 1 (one money-market stock)', { k: 1 }),
    v('dry powder in QQQ', { idle: 'qqq' }), v('start with 20% dry powder', { startDry: 0.2 }),
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
  const runAll = (s: CycleSetup, cost: number): CycleResult[] => PERIODS.map((p) => runCycle(bag, inp, p.start, p.end, s, cost));
  const out: string[] = ['# James — Multi-Year Cycle (Part A): history test', '',
    'The 14: ' + bag.join(', ') + '. $100,000, after the 25% tax, dry powder in cash earning the Fed funds rate (the prior month\'s, `legacy/historical_data/fedfunds.csv`). The 200-week average needs 200 weeks of history (from about 2011 for stocks listed in 2007; PLTR from 2024-09; ALAB never): younger stocks use the weekly-RSI test. **2020-2023 is in-sample by construction** (James\'s META / TSLA examples sit in it); 2024-2026 is the only clean out-of-sample period.'];
  // calibration (plan 07 2b): META Nov 2022, TSLA Jan 2023
  const uni = loadBag(priceDir, RESEARCH_UNIVERSE);
  out.push('', '## Calibration check (the default rule: -50% from the 52-week high and under the 200-week average)', '', '| Stock | Month | Days in the deep-bottom zone | First day | Deepest close vs the 52-week high |', '|---|---|---|---|---|');
  for (const [t, mo] of [['META', '2022-11'], ['TSLA', '2023-01'], ['TSLA', '2022-12']] as const) {
    const s = uni.get(t) ?? series.get(t);
    if (!s) { out.push('| ' + t + ' | ' + mo + ' | no prices | — | — |'); continue; }
    const sg = signalsOf(s), ks = s.dates.map((d, i) => [d, i] as const).filter(([d]) => d.startsWith(mo)).map(([, i]) => i), hit = ks.filter((i) => isDeepBottom(sg, i, CYCLE_DEFAULT));
    out.push('| ' + t + ' | ' + mo + ' | ' + hit.length + ' of ' + ks.length + ' | ' + (hit.length ? s.dates[hit[0]!] : '—') + ' | -' + Math.round(Math.max(...ks.map((i) => sg.dd[i] ?? 0)) * 100) + '% |');
  }
  out.push('', 'SOL-USD (James\'s third example) is not in the research download.');
  for (const cost of costs) {
    const bench = benchmarksFor(bag, inp, CASH, { costBps: cost });
    out.push('', '## ' + cost + ' bps per side' + (cost === H ? ' (headline)' : ''), '', ...RESULT_HEAD_P2, ...benchRows(bench, CASH, 1, ['', '', 'fall', ''], LABELS.holdResearchCore),
      resultRowP2('**James — Multi-Year Cycle, pre-registered default** (' + CYCLE_DEFAULT_SETUP.name + ', 3 tranches, 1 bottom at a time, harvest 20%, rotate 50%, top 3 leaders, dry powder in cash)', runAll(CYCLE_DEFAULT_SETUP, cost), bench));
  }
  const p1 = cyclePass1();
  const res = new Map<number, Map<string, CycleResult[]>>();
  for (const c of costs) { const m = new Map<string, CycleResult[]>(); for (const s of p1) m.set(s.setup.name, runAll(s.setup, c)); res.set(c, m); process.stderr.write('cycle pass 1 at ' + c + ' bps\n'); }
  const benchH = benchmarksFor(bag, inp, CASH, { costBps: H }), qqqH = benchH.qqq.map((x) => x.finalTaxed), rh = res.get(H)!;
  const g = sweepGuard(p1.map((s) => ({ name: s.setup.name, knobs: s.knobs, finals: rh.get(s.setup.name)!.map((x) => x.finalTaxed) }) as SweepSetup), CYCLE_DEFAULT_SETUP.name, qqqH);
  const counts = (r: readonly CycleResult[]): string => r.map((x) => x.deploys + '/' + x.harvests + '/' + x.rotations).join(' · ');
  out.push('', '## Pass 1 — 54 setups at ' + H + ' bps (X x bottom test x turnaround x top test), sorted by 2010-2019', '', ...RESULT_HEAD_P2.map((l, i) => l + (i === 0 ? ' Deploys / harvests / rotations per period |' : '---|')));
  for (const s of [...p1].sort((a, b) => rh.get(b.setup.name)![0]!.finalTaxed - rh.get(a.setup.name)![0]!.finalTaxed)) out.push(resultRowP2(s.setup.name + (s.setup.name === CYCLE_DEFAULT_SETUP.name ? ' **(default)**' : ''), rh.get(s.setup.name)!, benchH) + ' ' + counts(rh.get(s.setup.name)!) + ' |');
  out.push('', '### Sweep guard (T2), chosen on 2010-2019 only', '',
    '- Pre-registered default: ' + g.defaultSetup.name + ' — ' + g.defaultSetup.finals.map(pct).join(' / '), '- Best in 2010-2019: ' + g.picked.name + ' — ' + g.picked.finals.map(pct).join(' / '),
    '- Stable neighbourhood: ' + g.neighboursBeatingQqq + ' of ' + g.neighbours + ' one-step neighbours beat QQQ in 2010-2019 -> ' + (g.stable ? 'stable, the pick is used' : 'NOT stable, the pre-registered default is used'),
    '- **Chosen: ' + g.chosen.name + '**',
    ...g.periods.map((x, k) => (x ? '- ' + PERIODS[k]!.name + (k === 1 ? ' (in-sample by construction)' : ' (out-of-sample)') + ': the chosen setup is at the ' + x.percentile.toFixed(0) + 'th percentile of the sweep; ' + x.beatingQqqPct.toFixed(0) + '% of the 54 setups beat QQQ; median ' + pct(x.median) + ', interquartile ' + pct(x.q1) + ' to ' + pct(x.q3) : '')).filter(Boolean));
  let chosen = p1.find((s) => s.setup.name === g.chosen.name)!.setup;
  const base = rh.get(chosen.name)!;
  out.push('', '## Pass 2 — one knob at a time around the pass-1 choice (' + H + ' bps)', '', ...RESULT_HEAD_P2, resultRowP2(chosen.name + ' (pass-1 choice)', base, benchH));
  let best: { s: CycleSetup; r: CycleResult[] } | null = null;
  for (const s of cyclePass2(chosen)) { const r = runAll(s, H); out.push(resultRowP2(s.name, r, benchH)); if (r[0]!.finalTaxed > (best ? best.r[0]!.finalTaxed : base[0]!.finalTaxed)) best = { s, r }; }
  if (best && base[0]!.finalTaxed > qqqH[0]!) { out.push('', 'Pass 2 adopts: **' + best.s.name + '** (better in 2010-2019; its neighbour, the pass-1 choice, beats QQQ there).'); chosen = best.s; }
  else out.push('', 'Pass 2 adopts nothing (no knob beats the pass-1 choice in 2010-2019, or the choice does not beat QQQ there).');
  if (chosen.name !== CYCLE_CHOSEN.name) out.push('', '> WARNING: this run chose ' + chosen.name + ', not CYCLE_CHOSEN (' + CYCLE_CHOSEN.name + '); update the constant, the report page and the paper account.');
  const final = new Map(costs.map((c) => [c, runAll(chosen, c)]));
  out.push('', '## The chosen setup: **' + chosen.name + '**', '', '| Row | 2010-2019 (in-sample) | 2020-2023 (in-sample by construction) | 2024-2026 (out-of-sample) | Deepest fall | Deploys | Harvests | Rotations | Time in dry powder |', '|---|---|---|---|---|---|---|---|---|');
  for (const c of costs) { const r = final.get(c)!; out.push('| at ' + c + ' bps | ' + r.map((x) => pct(x.finalTaxed)).join(' | ') + ' | -' + Math.max(...r.map((x) => x.maxDrawdownPct)).toFixed(0) + '% | ' + r.map((x) => x.deploys).join(' / ') + ' | ' + r.map((x) => x.harvests).join(' / ') + ' | ' + r.map((x) => x.rotations).join(' / ') + ' | ' + r.map((x) => x.dryPct.toFixed(0) + '%').join(' / ') + ' |'); }
  out.push('', ...RESULT_HEAD_P2, ...benchRows(benchH, CASH, 1, ['', '', 'fall', ''], LABELS.holdResearchCore), resultRowP2('James — Multi-Year Cycle, chosen (' + H + ' bps)', final.get(H)!, benchH));
  const hind = [...p1].sort((a, b) => rh.get(b.setup.name)!.reduce((x, y) => x + y.finalTaxed, 0) - rh.get(a.setup.name)!.reduce((x, y) => x + y.finalTaxed, 0))[0]!;
  out.push(resultRowP2('picked with hindsight (best over all three periods, never used): ' + hind.setup.name, rh.get(hind.setup.name)!, benchH));
  // rule 5: panic-sell avoidance
  const fh = final.get(H)!;
  out.push('', '### Rule 5 — what not panic-selling was worth (' + H + ' bps)', '', '| Period | As is (no panic selling) | With a 30% trailing stop | With the Trend 200 sell | Benefit vs the stop | Benefit vs Trend 200 | Stop sales within 10% of a 52-week low |', '|---|---|---|---|---|---|---|');
  const tr = runAll({ name: chosen.name + ' + 30% trailing stop', o: { ...chosen.o, panic: 'trail30' } }, H), t2 = runAll({ name: chosen.name + ' + Trend 200 sell', o: { ...chosen.o, panic: 'trend200' } }, H);
  PERIODS.forEach((p, k) => out.push('| ' + p.name + ' | ' + pct(fh[k]!.finalTaxed) + ' (fall -' + fh[k]!.maxDrawdownPct.toFixed(0) + '%) | ' + pct(tr[k]!.finalTaxed) + ' (fall -' + tr[k]!.maxDrawdownPct.toFixed(0) + '%) | ' + pct(t2[k]!.finalTaxed) + ' (fall -' + t2[k]!.maxDrawdownPct.toFixed(0) + '%) | '
    + pts((fh[k]!.finalTaxed - tr[k]!.finalTaxed) / CASH * 100) + ' | ' + pts((fh[k]!.finalTaxed - t2[k]!.finalTaxed) / CASH * 100) + ' | ' + tr[k]!.panicNearLow + ' of ' + tr[k]!.panicSales + ' |'));
  // random-signal null
  const nulls = PERIODS.map((p, k) => cycleNull(bag, inp, p.start, p.end, chosen, H, fh[k]!));
  const nv = nullVerdict({ model: fh[0]!.finalTaxed, nul: nulls[0]! }, [1, 2].map((k) => ({ model: fh[k]!.finalTaxed, nul: nulls[k]! })));
  out.push('', '### Random-signal null (T2e, 100 seeds: the same deployments and harvests per stock on random days, the same rules otherwise, ' + H + ' bps)', '', '| Period | Model | Null median | Null 95th percentile |', '|---|---|---|---|',
    ...PERIODS.map((p, k) => '| ' + p.name + ' | ' + pct(fh[k]!.finalTaxed) + ' | ' + pct(nulls[k]!.median) + ' | ' + pct(nulls[k]!.p95) + ' |'),
    '', 'Verdict: ' + (nv.beatsP95InSample ? 'beats' : 'does NOT beat') + ' the null\'s 95th percentile in 2010-2019; above its median later: ' + nv.aboveMedianOutOfSample.map((x, i) => PERIODS[i + 1]!.name + ' ' + (x ? 'yes' : 'no')).join(', ') + ' -> **' + (nv.passes ? 'passes' : 'fails') + '**.');
  // false bottoms on the universe minus the 14
  const minus = universeMinusList([...uni.keys()].sort());
  out.push('', '### False bottoms (the universe minus the 14; every first day in the chosen setup\'s deep-bottom zone after 2010, one per stay; survivors only, so a lower bound on the damage)', '', '| Stock | Signal day | Drawdown | 1 year later | 3 years later |', '|---|---|---|---|---|');
  const fb: Array<{ r1: number | null; r3: number | null }> = [];
  for (const t of minus) {
    const s = uni.get(t)!, sg = signalsOf(s);
    let inZ = false;
    for (let i = 0; i < s.dates.length; i++) {
      const z = isDeepBottom(sg, i, chosen.o);
      if (z && !inZ && (s.dates[i] as string) >= '2010-01-01') {
        const r1 = i + 252 < s.dates.length ? (s.closes[i + 252] as number) / (s.closes[i] as number) - 1 : null, r3 = i + 756 < s.dates.length ? (s.closes[i + 756] as number) / (s.closes[i] as number) - 1 : null;
        fb.push({ r1, r3 });
        out.push('| ' + t + ' | ' + s.dates[i] + ' | -' + Math.round((sg.dd[i] ?? 0) * 100) + '% | ' + (r1 == null ? '—' : pp(r1 * 100)) + ' | ' + (r3 == null ? '—' : pp(r3 * 100)) + ' |');
      }
      inZ = z;
    }
  }
  const neg = (xs: Array<number | null>): string => { const v = xs.filter((x): x is number => x != null); return v.filter((x) => x < 0).length + ' of ' + v.length; };
  out.push('', 'Signals: ' + fb.length + '; lower 1 year later: ' + neg(fb.map((x) => x.r1)) + '; lower 3 years later: ' + neg(fb.map((x) => x.r3)) + '. Deep losers in the universe: ' + ['INTC', 'WBA', 'BA', 'PYPL', 'F'].filter((t) => uni.has(t)).join(', ') + ' (WBA not downloaded); delisted names are absent.');
  // robustness
  const uinp = { series: uni, qqq: inp.qqq };
  const bags = randomBags([...uni.keys()].sort(), 20, 12);
  out.push('', '### Robustness (T5): 20 random bags of 12 (survivors only) and the universe minus the 14 (' + H + ' bps)', '', '| Period | QQQ | Bags beating QQQ | Bag average | Universe minus the 14 |', '|---|---|---|---|---|');
  PERIODS.forEach((p, k) => {
    const vs = bags.map((bg) => runCycle(bg.filter((t) => uni.has(t)), uinp, p.start, p.end, chosen, H).finalTaxed);
    out.push('| ' + p.name + ' | ' + pct(qqqH[k]!) + ' | ' + vs.filter((v) => v > qqqH[k]!).length + ' of ' + vs.length + ' | ' + pct(vs.reduce((a, b) => a + b, 0) / vs.length) + ' | ' + pct(runCycle(minus, uinp, p.start, p.end, chosen, H).finalTaxed) + ' |');
  });
  out.push('', '### Report columns (' + H + ' bps)', ...reportTable(benchH, [{ name: 'James — Multi-Year Cycle, chosen (' + chosen.name + ')', outcomes: fh }, { name: 'James — Multi-Year Cycle, pre-registered default', outcomes: runAll(CYCLE_DEFAULT_SETUP, H) }], inp.qqq, CASH, LABELS.holdResearchCore));
  process.stdout.write(out.join('\n') + '\n');
}
const pp = (v: number): string => (v >= 0 ? '+' : '') + v.toFixed(0) + '%';
const pts = (v: number): string => (v >= 0 ? '+' : '') + v.toFixed(0) + ' points';

if (import.meta.url === `file://${process.argv[1]}`) main();
