/**
 * `node src/research/liloV2Cli.ts <priceDir> [readsDir] [--sweep] [--cost 0,10]`: the history test of James — LILO v2
 * (docs/models/plans/01-lilo-v2-original-layers.md section 6) on the research list, three periods, after the 25%
 * tax, against 📊 Hold QQQ and 📊 Hold the research list (and its "join when listed" variant), next to the current LILO (5
 * ladders, needs the reads folder), the pre-registered default first. With --sweep: stage 1 (the layers alone),
 * pass 1 (90 setups) and pass 2 (one knob at a time around the pick), the T2 sweep guard chosen on 2010-2019 only,
 * the random-signal null (100 seeds), 20 random bags and the universe minus the 14, and the report columns.
 * Prints markdown (the tables of docs/models/results/phase1.md).
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadSeries, type PriceSeries } from '../backtest/data.ts';
import { PERIODS } from './lab.ts';
import type { PortfolioInput } from './portfolioLab.ts';
import { OWNER_BAG, randomBags, universeMinusList } from './portfolioCli.ts';
import { RESEARCH_UNIVERSE } from './fetchPrices.ts';
import type { CompactRead } from './computeReads.ts';
import { benchmarksFor, benchRows, reportTable, type Benchmarks, type PeriodOutcome } from './benchmarks.ts';
import { sweepGuard, randomSignalNull, nullVerdict, quantile, type SweepSetup, type NullDistribution } from './guards.ts';
import { newLiloV2Book, liloV2Day, liloV2Value, LILO_V2_DEFAULT, LILO_V2_CHOSEN, LILO_V2_DEFAULT_SETUP, type LiloV2Bar, type LiloV2Options, type LiloV2Line, type LiloV2Setup } from './liloV2Book.ts';
import { layerTimeline, smaSeries, upCrosses, pickAnchor, DEFAULT_LAYER_OPTIONS, layerOptionsName, type LayerOptions, type LayerSet } from '../analysis/models/liloLayers.ts';
import { PT_SCHEDULES, type PtSchedule } from '../analysis/models/profitTaking.ts';
import { trendSeries, type TrendDay } from '../analysis/models/trendFollow.ts';
import { runLiloPortfolio } from './liloCli.ts';
import { LABELS } from '../profile/labels.ts';

export const CASH = 100_000;

export { LILO_V2_CHOSEN, LILO_V2_DEFAULT_SETUP, type LiloV2Setup };

export interface LiloV2Result extends PeriodOutcome {
  readonly finalTaxed: number; readonly maxDrawdownPct: number; readonly trades: number;
  readonly cashShareByDay: Map<string, number>;
  readonly buysByTicker: Map<string, number>;
}

const smaCache = new WeakMap<readonly number[], Array<number | null>>();
const sma200 = (s: PriceSeries): Array<number | null> => { let m = smaCache.get(s.closes); if (!m) { m = smaSeries(s.closes, 200); smaCache.set(s.closes, m); } return m; };
const trendCache = new WeakMap<PriceSeries, TrendDay[]>();
const trend200 = (s: PriceSeries): TrendDay[] => { let m = trendCache.get(s); if (!m) { m = trendSeries(s.closes, 200); trendCache.set(s, m); } return m; };

/** One run of James — LILO v2 over [start, end] on `bag` (series from `inp`), idle money in QQQ. */
export function runLiloV2(bag: readonly string[], inp: Pick<PortfolioInput, 'series' | 'qqq'>, start: string, end: string, setup: LiloV2Setup, costBps = 0,
  randomBuyDays?: ReadonlyMap<string, ReadonlySet<string>>): LiloV2Result {
  const o: LiloV2Options = { ...setup.book, costBps, reanchor: setup.layers.anchor === 'A2' ? 'whenFlat' : 'adopt' };
  const b = newLiloV2Book(CASH);
  const ser = (t: string): PriceSeries => (t === 'QQQ' ? inp.qqq : (inp.series.get(t) as PriceSeries));
  const idx = new Map<string, Map<string, number>>([...bag, 'QQQ'].map((t) => [t, new Map(ser(t).dates.map((d, i) => [d, i]))]));
  const tl = new Map(bag.map((t) => [t, layerTimeline(ser(t), setup.layers)]));
  const qTrend = trend200(inp.qqq);
  const days = inp.qqq.dates.filter((d) => d >= start && d <= end);
  let peak = CASH, dd = 0, trades = 0, idleOut = false;
  const cashShareByDay = new Map<string, number>(), buysByTicker = new Map<string, number>(), last = new Map<string, number>();
  const stopHit = (t: string, l: LiloV2Line, i: number): boolean => {
    const s = ser(t), c = s.closes[i] as number, m = sma200(s);
    if (o.stop === 'belowL0') return c < l.L0;
    if (o.stop === 'trend200') return m[i] != null && c < 0.97 * (m[i] as number);
    if (o.stop === 'below200x5') { for (let k = i - 4; k <= i; k++) if (k < 0 || m[k] == null || (s.closes[k] as number) >= (m[k] as number)) return false; return true; }
    return false;
  };
  for (let n = 0; n < days.length; n++) {
    const d = days[n] as string;
    const bars = new Map<string, LiloV2Bar>(), layers = new Map<string, LayerSet | null>(), at = new Map<string, number>();
    for (const t of bag) {
      const k = idx.get(t)!.get(d);
      if (k == null) continue;
      const s = ser(t);
      bars.set(t, { open: s.opens[k]!, high: s.highs[k]!, low: s.lows[k]!, close: s.closes[k]! });
      layers.set(t, tl.get(t)![k] ?? null); at.set(t, k); last.set(t, s.closes[k]!);
    }
    const qk = idx.get('QQQ')!.get(d)!;
    last.set('QQQ', inp.qqq.closes[qk]!);
    const qd = qTrend[qk]?.direction;
    if (qd === 'cautionary') idleOut = true; else if (qd === 'bullish') idleOut = false;
    const decide = n < days.length - 1;
    const rb = randomBuyDays ? new Set([...randomBuyDays].filter(([, ds]) => ds.has(d)).map(([t]) => t)) : null;
    const tr = liloV2Day(b, o, {
      bars, qqq: { open: inp.qqq.opens[qk]!, close: inp.qqq.closes[qk]! }, layers: decide ? layers : null, fill: true, idleOut,
      stopHit: (t, l) => stopHit(t, l, at.get(t) as number), randomBuy: randomBuyDays ? rb : null,
    });
    for (const x of tr) if (x.ticker !== 'QQQ') { trades++; if (x.side === 'BUY') buysByTicker.set(x.ticker, (buysByTicker.get(x.ticker) ?? 0) + 1); }
    const v = liloV2Value(b, (t) => last.get(t) ?? null);
    peak = Math.max(peak, v); dd = Math.max(dd, (1 - v / peak) * 100);
    cashShareByDay.set(d, v > 0 ? Math.min(1, Math.max(0, b.cash) / v) : 1);
  }
  return { finalTaxed: liloV2Value(b, (t) => last.get(t) ?? null), maxDrawdownPct: dd, trades, cashShareByDay, buysByTicker };
}

/** The random-signal null of one period for a run (same buys per stock on random decision days, same exits). */
export function liloV2Null(bag: readonly string[], inp: Pick<PortfolioInput, 'series' | 'qqq'>, start: string, end: string, setup: LiloV2Setup, costBps: number, r: LiloV2Result, seeds = 100): NullDistribution {
  const days = inp.qqq.dates.filter((d) => d >= start && d <= end).slice(0, -1);
  const daysOf = (t: string): string[] => { const has = new Set(inp.series.get(t)?.dates ?? []); return days.filter((d) => has.has(d)); };
  return randomSignalNull(r.buysByTicker, daysOf, (buyDays) => runLiloV2(bag, inp, start, end, setup, costBps, buyDays).finalTaxed, seeds);
}

// ─────────────────────────────── the sweep (plan 01 section 6) ───────────────────────────────

const ANCHORS: ReadonlyArray<Pick<LayerOptions, 'anchor' | 'minAge'>> = [{ anchor: 'A1', minAge: 63 }, { anchor: 'A2', minAge: 63 }, { anchor: 'A3', minAge: 63 }];
const UNITS: ReadonlyArray<Pick<LayerOptions, 'unit' | 'k'>> = [{ unit: 'U1', k: 5 }, { unit: 'U2', k: 0.30 }, { unit: 'U2', k: 0.35 }, { unit: 'U3', k: 7.5 }, { unit: 'U4', k: 5 }];
const EXITS: ReadonlyArray<PtSchedule | 'none'> = [...PT_SCHEDULES, 'none'];

export interface Swept { readonly setup: LiloV2Setup; readonly knobs: Record<string, number> }
/** Pass 1: 3 anchors x 5 units x 6 layer-outs = 90 setups; the rest at the default. */
export function pass1(): Swept[] {
  const out: Swept[] = [];
  ANCHORS.forEach((a, ai) => UNITS.forEach((u, ui) => EXITS.forEach((e, ei) => {
    const layers: LayerOptions = { ...a, ...u };
    out.push({ setup: { name: layerOptionsName(layers) + ', ' + e, layers, book: { ...LILO_V2_DEFAULT, schedule: e } }, knobs: { anchor: ai, unit: ui, exit: ei } });
  })));
  return out;
}

/** Pass 2: one knob at a time around `base`. */
export function pass2(base: LiloV2Setup): LiloV2Setup[] {
  const v = (name: string, book: Partial<LiloV2Options>, layers: Partial<LayerOptions> = {}): LiloV2Setup => ({ name: base.name + ' + ' + name, layers: { ...base.layers, ...layers }, book: { ...base.book, ...book } });
  const out = [
    v('snipe 1 layer', { depth: 1 }), v('highest buy L5', { maxBuyLayer: 5 }), v('highest buy L7', { maxBuyLayer: 7 }), v('first buy at the anchor', { firstBuy: true }),
    v('stop below L0', { stop: 'belowL0' }), v('stop 3% under the 200-day', { stop: 'trend200' }), v('stop 5 closes under the 200-day', { stop: 'below200x5' }),
    v('3 stocks', { slots: 3 }), v('14 stocks', { slots: 14 }), v('2 tranches', { tranches: 2 }), v('6 tranches', { tranches: 6 }), v('lower layer, bigger buy', { weights: 'lowerBigger' }),
    v('idle cash', { idle: 'cash' }), v('idle QQQ while its trend is up', { idle: 'qqqTrend' }),
  ];
  if (base.layers.anchor === 'A1') out.push(v('anchor age 42', {}, { minAge: 42 }), v('anchor age 84', {}, { minAge: 84 }));
  if (base.layers.unit === 'U1') out.push(v('U1 k=4', {}, { k: 4 }), v('U1 k=6', {}, { k: 6 }));
  return out;
}

// ─────────────────────────────── output helpers ───────────────────────────────

export const pct = (v: number): string => ((v / CASH - 1) * 100 >= 0 ? '+' : '') + ((v / CASH - 1) * 100).toFixed(0) + '%';
const fall = (r: ReadonlyArray<{ maxDrawdownPct: number }>): string => '-' + Math.max(...r.map((x) => x.maxDrawdownPct)).toFixed(0) + '%';

export function resultRow(name: string, r: readonly LiloV2Result[], b: Benchmarks): string {
  const v = r.map((x) => x.finalTaxed);
  const lists = [b.list, b.listJoin ?? b.list];
  return '| ' + name + ' | ' + v.map(pct).join(' | ') + ' | ' + v.filter((x, i) => x > b.qqq[i]!.finalTaxed).length + ' of 3 | '
    + v.filter((x, i) => x > lists[0]![i]!.finalTaxed).length + ' / ' + v.filter((x, i) => x > lists[1]![i]!.finalTaxed).length + ' of 3 | ' + fall(r) + ' | ' + r.reduce((a, x) => a + x.trades, 0) + ' |';
}
export const RESULT_HEAD = ['| Row | 2010-2019 (in-sample) | 2020-2023 | 2024-2026 | Beats QQQ | Beats the 14 (plain / join when listed) | Deepest fall | Stock trades |', '|---|---|---|---|---|---|---|---|'];

/** Stage 1: the layer engine alone on the 14, 2010-2026: anchors per decade, how often each sell layer is reached, days to L6 / L10. */
export function stage1(bag: readonly string[], inp: Pick<PortfolioInput, 'series'>): string[] {
  const out = ['| Stock | Anchors used 2010-2019 (A1-63 / A2 / A3) | Up-crosses 2010-2026 | Anchors (A1-63, U1 k=5) reaching L6 / L8 / L10 | Median days anchor -> L6 / L10 |', '|---|---|---|---|---|'];
  for (const t of bag) {
    const s = inp.series.get(t); if (!s) continue;
    const i0 = s.dates.findIndex((d) => d >= '2010-01-01'), i1 = s.dates.reduce((a, d, i) => (d <= '2019-12-31' ? i : a), -1), iEnd = s.dates.length - 1;
    const used = (rule: 'A1' | 'A2' | 'A3'): number => { const c = upCrosses(s.closes), set = new Set<number>(); if (i0 < 0 || i1 < i0) return 0; for (let i = i0; i <= i1; i++) { const a = pickAnchor(c, i, rule, 63); if (a >= 0) set.add(a); } return set.size; };
    const crosses = upCrosses(s.closes).filter((i) => (s.dates[i] as string) >= '2010-01-01');
    const tl = layerTimeline(s, DEFAULT_LAYER_OPTIONS);
    const anchors = new Map<number, LayerSet>();
    for (let i = Math.max(0, i0); i <= iEnd; i++) { const ls = tl[i]; if (ls && !anchors.has(ls.anchorIndex)) anchors.set(ls.anchorIndex, ls); }
    const reach = [6, 8, 10].map(() => 0), d6: number[] = [], d10: number[] = [];
    for (const ls of anchors.values()) {
      // while the anchor is in force (A1: from 63 bars after its cross until the next anchor takes over, or the end)
      const from = tl.findIndex((x) => x?.anchorIndex === ls.anchorIndex);
      let endI = iEnd; for (let i = from + 1; i <= iEnd; i++) if (tl[i]?.anchorIndex !== ls.anchorIndex) { endI = i - 1; break; }
      [6, 8, 10].forEach((k, j) => { for (let i = from; i <= endI; i++) if ((s.highs[i] as number) >= (ls.levels[k] as number)) { reach[j]!++; if (k === 6) d6.push(i - ls.anchorIndex); if (k === 10) d10.push(i - ls.anchorIndex); break; } });
    }
    out.push('| ' + t + ' | ' + used('A1') + ' / ' + used('A2') + ' / ' + used('A3') + ' | ' + crosses.length + ' | ' + reach.join(' / ') + ' of ' + anchors.size + ' | '
      + (d6.length ? quantile(d6, 0.5).toFixed(0) : '—') + ' / ' + (d10.length ? quantile(d10, 0.5).toFixed(0) : '—') + ' |');
  }
  return out;
}

function loadBag(priceDir: string, tickers: readonly string[]): Map<string, PriceSeries> {
  const m = new Map<string, PriceSeries>();
  for (const t of tickers) { try { m.set(t, loadSeries(t, priceDir)); } catch { /* not downloaded */ } }
  return m;
}

function main(): void {
  const args = process.argv.slice(2);
  const [priceDir, readsDir] = args.filter((a) => !a.startsWith('--')) as [string, string?];
  const sweep = args.includes('--sweep');
  const costArg = args.find((a) => a.startsWith('--cost'));
  const costs = costArg ? (costArg.split('=')[1] ?? '0,10').split(',').map(Number) : [0, 10];
  const headline = costs.includes(10) ? 10 : costs[costs.length - 1]!;
  const series = loadBag(priceDir, OWNER_BAG);
  const bag = OWNER_BAG.filter((t) => series.has(t));
  const reads = new Map<string, Map<string, CompactRead>>();
  if (readsDir) for (const t of bag) { const f = path.join(readsDir, t + '.reads.json'); if (fs.existsSync(f)) reads.set(t, new Map((JSON.parse(fs.readFileSync(f, 'utf8')) as CompactRead[]).map((r) => [r.d, r]))); }
  const inp: PortfolioInput = { series, reads, qqq: loadSeries('QQQ', priceDir) };
  const out: string[] = ['# James — LILO v2: history test', '', 'The 14: ' + bag.join(', ') + '. $100,000, after the 25% tax, idle money in QQQ.'];
  const runAll = (s: LiloV2Setup, cost: number): LiloV2Result[] => PERIODS.map((p) => runLiloV2(bag, inp, p.start, p.end, s, cost));
  for (const cost of costs) {
    const bench = benchmarksFor(bag, inp, CASH, { costBps: cost });
    out.push('', '## ' + cost + ' bps per side' + (cost === headline ? ' (headline)' : ''), '', ...RESULT_HEAD, ...benchRows(bench, CASH, 1, ['', '', 'fall', ''], LABELS.holdResearchCore));
    if (reads.size) {
      const cur = PERIODS.map((p) => runLiloPortfolio(bag, inp, p.start, p.end, 5, cost));
      out.push(resultRow('Current LILO, 5 ladders (`liloBook.ts`)', cur.map((x) => ({ ...x, buysByTicker: new Map() })), bench));
    }
    out.push(resultRow('**James — LILO v2, pre-registered default** (A1-63, U1 k=5, snipe 2, up to L8, A20, 5 stocks, 4 tranches, no stop, idle QQQ)', runAll(LILO_V2_DEFAULT_SETUP, cost), bench));
  }
  if (!sweep) { process.stdout.write(out.join('\n') + '\n'); return; }

  out.push('', '## Stage 1 — the layer engine alone (default layers)', '', ...stage1(bag, inp));
  const p1 = pass1();
  const results = new Map<number, Map<string, LiloV2Result[]>>();
  for (const cost of costs) {
    const m = new Map<string, LiloV2Result[]>();
    for (const s of p1) { m.set(s.setup.name, runAll(s.setup, cost)); }
    results.set(cost, m);
    process.stderr.write('pass 1 at ' + cost + ' bps done\n');
  }
  const benchH = benchmarksFor(bag, inp, CASH, { costBps: headline });
  const qqqH = benchH.qqq.map((x) => x.finalTaxed);
  const rh = results.get(headline)!;
  const setups: SweepSetup[] = p1.map((s) => ({ name: s.setup.name, knobs: s.knobs, finals: rh.get(s.setup.name)!.map((x) => x.finalTaxed) }));
  const defaultName = p1.find((s) => s.knobs.anchor === 0 && s.knobs.unit === 0 && s.knobs.exit === 0)!.setup.name;
  const g = sweepGuard(setups, defaultName, qqqH);
  out.push('', '## Pass 1 — 90 setups at ' + headline + ' bps (anchor x unit x layer-out), sorted by 2010-2019', '', ...RESULT_HEAD);
  for (const s of [...p1].sort((a, b) => rh.get(b.setup.name)![0]!.finalTaxed - rh.get(a.setup.name)![0]!.finalTaxed)) out.push(resultRow(s.setup.name + (s.setup.name === defaultName ? ' **(default)**' : ''), rh.get(s.setup.name)!, benchH));
  out.push('', '### Sweep guard (T2), chosen on 2010-2019 only', '',
    '- Pre-registered default: ' + g.defaultSetup.name + ' — ' + g.defaultSetup.finals.map(pct).join(' / '),
    '- Best in 2010-2019: ' + g.picked.name + ' — ' + g.picked.finals.map(pct).join(' / '),
    '- Stable neighbourhood: ' + g.neighboursBeatingQqq + ' of ' + g.neighbours + ' one-step neighbours beat QQQ in 2010-2019 -> ' + (g.stable ? 'stable, the pick is used' : 'NOT stable, the pre-registered default is used'),
    '- **Chosen: ' + g.chosen.name + '**',
    ...g.periods.map((x, k) => (x ? '- ' + PERIODS[k]!.name + ' (out-of-sample): the chosen setup is at the ' + x.percentile.toFixed(0) + 'th percentile of the sweep; ' + x.beatingQqqPct.toFixed(0) + '% of the 90 setups beat QQQ; median ' + pct(x.median) + ', interquartile ' + pct(x.q1) + ' to ' + pct(x.q3) : '')).filter(Boolean));
  let chosen = p1.find((s) => s.setup.name === g.chosen.name)!.setup;

  // pass 2: one knob at a time around the pass-1 choice (adopted only when it beats it in 2010-2019 and the choice itself beats QQQ there)
  const base = rh.get(chosen.name)!;
  out.push('', '## Pass 2 — one knob at a time around the pass-1 choice (' + headline + ' bps)', '', ...RESULT_HEAD, resultRow(chosen.name + ' (pass-1 choice)', base, benchH));
  let best: { s: LiloV2Setup; r: LiloV2Result[] } | null = null;
  for (const s of pass2(chosen)) {
    const r = runAll(s, headline);
    out.push(resultRow(s.name, r, benchH));
    if (r[0]!.finalTaxed > (best ? best.r[0]!.finalTaxed : base[0]!.finalTaxed)) best = { s, r };
  }
  if (best && base[0]!.finalTaxed > qqqH[0]!) { out.push('', 'Pass 2 adopts: **' + best.s.name + '** (better in 2010-2019; its neighbour, the pass-1 choice, beats QQQ there).'); chosen = best.s; }
  else out.push('', 'Pass 2 adopts nothing (no knob beats the pass-1 choice in 2010-2019, or the choice does not beat QQQ there).');

  if (chosen.name !== LILO_V2_CHOSEN.name) out.push('', '> WARNING: this run chose ' + chosen.name + ', not LILO_V2_CHOSEN (' + LILO_V2_CHOSEN.name + '); update the constant, the report page and the paper account.');
  // the chosen setup at both costs, the null, the bags, the universe minus the 14, the report columns
  const final = new Map(costs.map((c) => [c, runAll(chosen, c)]));
  out.push('', '## The chosen setup: **' + chosen.name + '**', '', ...RESULT_HEAD);
  for (const c of costs) out.push(resultRow('at ' + c + ' bps', final.get(c)!, benchmarksFor(bag, inp, CASH, { costBps: c })));
  const hind = [...p1].sort((a, b) => rh.get(b.setup.name)!.reduce((x, y) => x + y.finalTaxed, 0) - rh.get(a.setup.name)!.reduce((x, y) => x + y.finalTaxed, 0))[0]!;
  out.push(resultRow('picked with hindsight (best over all three periods, never used): ' + hind.setup.name, rh.get(hind.setup.name)!, benchH));

  const fh = final.get(headline)!;
  const nulls = PERIODS.map((p, k) => liloV2Null(bag, inp, p.start, p.end, chosen, headline, fh[k]!));
  const nv = nullVerdict({ model: fh[0]!.finalTaxed, nul: nulls[0]! }, [1, 2].map((k) => ({ model: fh[k]!.finalTaxed, nul: nulls[k]! })));
  out.push('', '### Random-signal null (T2e, 100 seeds, the same buys per stock on random days, same exits, ' + headline + ' bps)', '', '| Period | Model | Null median | Null 95th percentile |', '|---|---|---|---|',
    ...PERIODS.map((p, k) => '| ' + p.name + ' | ' + pct(fh[k]!.finalTaxed) + ' | ' + pct(nulls[k]!.median) + ' | ' + pct(nulls[k]!.p95) + ' |'),
    '', 'Verdict: ' + (nv.beatsP95InSample ? 'beats' : 'does NOT beat') + ' the null\'s 95th percentile in 2010-2019; above its median out-of-sample: ' + nv.aboveMedianOutOfSample.map((x, i) => PERIODS[i + 1]!.name + ' ' + (x ? 'yes' : 'no')).join(', ') + ' -> **' + (nv.passes ? 'passes' : 'fails') + '**.');

  const uni = loadBag(priceDir, RESEARCH_UNIVERSE);
  const uinp = { series: uni, qqq: inp.qqq };
  const bags = randomBags([...uni.keys()].sort(), 20, 12);
  out.push('', '### Robustness (T5): 20 random bags of 12 from the research universe (survivors only, no delisted names), and the universe minus the 14', '', '| Period | QQQ | Bags beating QQQ | Bag average | Universe minus the 14 |', '|---|---|---|---|---|');
  const minus = universeMinusList([...uni.keys()].sort());
  PERIODS.forEach((p, k) => {
    const vs = bags.map((bg) => runLiloV2(bg.filter((t) => uni.has(t)), uinp, p.start, p.end, chosen, headline).finalTaxed);
    const um = runLiloV2(minus, uinp, p.start, p.end, chosen, headline).finalTaxed;
    out.push('| ' + p.name + ' | ' + pct(qqqH[k]!) + ' | ' + vs.filter((v) => v > qqqH[k]!).length + ' of ' + vs.length + ' | ' + pct(vs.reduce((a, b) => a + b, 0) / vs.length) + ' | ' + pct(um) + ' |');
  });
  out.push('', 'The universe (' + uni.size + ' stocks) holds only stocks still listed today; deep losers included: ' + ['INTC', 'WBA', 'BA', 'PYPL', 'F'].filter((t) => uni.has(t)).join(', ') + ' (WBA could not be fetched); delisted names are absent, so these results are an upper bound.');

  const rep = [{ name: 'James — LILO v2, chosen (' + chosen.name + ')', outcomes: fh }, { name: 'James — LILO v2, pre-registered default', outcomes: runAll(LILO_V2_DEFAULT_SETUP, headline) }];
  out.push('', '### Report columns (' + headline + ' bps)', ...reportTable(benchH, rep, inp.qqq, CASH, LABELS.holdResearchCore));
  process.stdout.write(out.join('\n') + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
