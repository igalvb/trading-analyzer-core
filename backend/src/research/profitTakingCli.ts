/**
 * `node src/research/profitTakingCli.ts <priceDir> <readsDir>`: the history test of James — Profit-Taking
 * (docs/models/plans/02-master-profit-taking.md section 6): the same entries, different exits. For 8 entry models the
 * row "own sell" is the control and each of James's five schedules (models/profitTaking.ts) is a variant, three
 * periods, after the 25% tax (each step pays its own tax), at 0 and 10 bps, against 📊 Hold QQQ and 📊 Hold the research list.
 * The schedule is chosen on 2010-2019 only (D4: A20 pre-registered); pass 2 varies the layers, the rest, the trigger
 * and where the cash goes on the combo and Trend 200 entries; the guards (stable neighbourhood, the exit's
 * random-signal null) and the robustness check on random bags and the universe minus the 14. Prints markdown.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadSeries, type PriceSeries } from '../backtest/data.ts';
import { PERIODS } from './lab.ts';
import { runPortfolio, type PortfolioInput, type PortfolioModel, type PortfolioOptions, type ProfitTakingOverlay, type PortfolioResult } from './portfolioLab.ts';
import { OWNER_BAG, randomBags, universeMinusList } from './portfolioCli.ts';
import { RESEARCH_UNIVERSE } from './fetchPrices.ts';
import type { CompactRead } from './computeReads.ts';
import { benchmarksFor, benchRows, reportTable, type Benchmarks, type PeriodOutcome } from './benchmarks.ts';
import { randomSignalNull, quantile, type NullDistribution } from './guards.ts';
import { runLiloPortfolio } from './liloCli.ts';
import { runLiloV2, LILO_V2_CHOSEN, CASH } from './liloV2Cli.ts';
import { EXIT_TAX_RATE } from '../portfolio/exitTax.ts';
import { layerTimeline, DEFAULT_LAYER_OPTIONS } from '../analysis/models/liloLayers.ts';
import { PT_SCHEDULES, PT_DEFAULT, newPtState, profitTakingFills, type PtSchedule, type PtState } from '../analysis/models/profitTaking.ts';
import { LABELS } from '../profile/labels.ts';

type Exit = 'own' | PtSchedule;
const EXITS: readonly Exit[] = ['own', ...PT_SCHEDULES];

export interface Outcome extends PeriodOutcome {
  readonly finalTaxed: number; readonly maxDrawdownPct: number; readonly trades: number;
  readonly cashShareByDay?: ReadonlyMap<string, number>;
  readonly pt?: PortfolioResult['profitTaking'];
}

/**
 * Hold a bag equally from the first open (those trading that day), with a schedule on each position at its LILO v2
 * layers (frozen the day before the first open; a stock with no anchor then is simply held). A step's cash goes to
 * QQQ at the next open ('qqq'), or stays in cash ('cash', and always for a bag of QQQ itself). `schedule` 'own' = plain holding.
 */
export function holdWithSchedule(bag: readonly string[], inp: Pick<PortfolioInput, 'series' | 'qqq'>, start: string, end: string, exit: Exit, costBps = 0, cashTo: 'qqq' | 'cash' = 'qqq'): Outcome {
  const c = costBps / 10_000;
  const ser = (t: string): PriceSeries => (t === 'QQQ' ? inp.qqq : (inp.series.get(t) as PriceSeries));
  const days = inp.qqq.dates.filter((d) => d >= start && d <= end);
  const first = days[0] as string;
  const live = bag.filter((t) => ser(t) && (ser(t).dates[0] as string) <= first);
  const idx = new Map([...live, 'QQQ'].map((t) => [t, new Map(ser(t).dates.map((d, i) => [d, i]))]));
  const parkQqq = cashTo === 'qqq' && !live.includes('QQQ');
  let cash = CASH, peak = CASH, dd = 0, trades = 0, qqq = { shares: 0, cost: 0 }, sold = false;
  const pos = new Map<string, { shares: number; cost: number; pt: PtState | null }>();
  const last = new Map<string, number>();
  const cashShareByDay = new Map<string, number>();
  const taxedValue = (shares: number, cost: number, px: number): number => shares * px - Math.max(0, shares * px - cost) * EXIT_TAX_RATE;
  for (const d of days) {
    if (d === first) {
      for (const t of live) {
        const k = idx.get(t)!.get(d); if (k == null) continue;
        const px = ser(t).opens[k] as number, n = Math.floor(CASH / live.length / (px * (1 + c)));
        if (n <= 0) continue;
        cash -= n * px * (1 + c); trades++;
        const levels = exit === 'own' || k < 1 ? null : layerTimeline(ser(t), DEFAULT_LAYER_OPTIONS)[k - 1]?.levels ?? null;
        pos.set(t, { shares: n, cost: n * px * (1 + c), pt: levels ? newPtState(exit as PtSchedule, levels, n) : null });
      }
    } else if (parkQqq && sold) {
      const k = idx.get('QQQ')!.get(d)!, px = inp.qqq.opens[k] as number, n = Math.floor(cash / (px * (1 + c)));
      if (n > 0) { cash -= n * px * (1 + c); qqq.shares += n; qqq.cost += n * px * (1 + c); }
      sold = false;
    }
    for (const [t, p] of pos) {
      const k = idx.get(t)!.get(d); if (k == null) continue;
      const s = ser(t);
      last.set(t, s.closes[k] as number);
      if (!p.pt || !p.shares) continue;
      for (const f of profitTakingFills(p.pt, { open: s.opens[k] as number, high: s.highs[k] as number, close: s.closes[k] as number }, p.shares, 'intraday', p.cost / p.shares)) {
        const n = Math.min(f.shares, p.shares), px = f.price as number, part = (p.cost * n) / p.shares, fee = n * px * c;
        cash += n * px - fee - Math.max(0, n * px - fee - part) * EXIT_TAX_RATE; p.shares -= n; p.cost -= part; trades++; sold = true;
      }
    }
    const qk = idx.get('QQQ')!.get(d)!; last.set('QQQ', inp.qqq.closes[qk] as number);
    let v = cash + (qqq.shares ? taxedValue(qqq.shares, qqq.cost, last.get('QQQ')!) : 0), raw = cash + qqq.shares * last.get('QQQ')!;
    for (const [t, p] of pos) if (p.shares) { v += taxedValue(p.shares, p.cost, last.get(t) ?? p.cost / p.shares); raw += p.shares * (last.get(t) ?? 0); }
    peak = Math.max(peak, raw); dd = Math.max(dd, (1 - raw / peak) * 100);
    cashShareByDay.set(d, raw > 0 ? cash / raw : 1);
    if (d === days[days.length - 1]) return { finalTaxed: v, maxDrawdownPct: dd, trades, cashShareByDay };
  }
  return { finalTaxed: cash, maxDrawdownPct: dd, trades, cashShareByDay };
}

/** The entry models of the matrix (plan 02 section 6). */
interface Entry { readonly id: string; readonly name: string; readonly run: (exit: Exit, p: { start: string; end: string }, cost: number, extra?: Partial<ProfitTakingOverlay>, bag?: readonly string[], inp?: PortfolioInput) => Outcome; readonly portfolio?: { model: PortfolioModel; opts: Omit<PortfolioOptions, 'cash'> } }

function entries(bag: readonly string[], inp: PortfolioInput): Entry[] {
  const pf = (id: string, name: string, model: PortfolioModel, opts: Omit<PortfolioOptions, 'cash'>): Entry => ({
    id, name, portfolio: { model, opts },
    run: (exit, p, cost, extra, b = bag, i = inp) => {
      const r = runPortfolio(model, b, i, p.start, p.end, { ...opts, cash: CASH, costBps: cost, ...(exit === 'own' ? {} : { profitTaking: { schedule: exit, ...extra } }) });
      return { ...r, ...(r.profitTaking ? { pt: r.profitTaking } : {}) };
    },
  });
  return [
    { id: 'hold14', name: LABELS.holdResearchCore + ' (the rest held)', run: (exit, p, cost, _x, b = bag, i = inp) => holdWithSchedule(b, i, p.start, p.end, exit, cost) },
    { id: 'holdQqq', name: 'Hold QQQ (QQQ\'s own layers, the cash waits in cash)', run: (exit, p, cost) => holdWithSchedule(['QQQ'], inp, p.start, p.end, exit, cost, 'cash') },
    {
      id: 'liloV2', name: 'James — LILO v2 (its 2010-2019 pick, ' + LILO_V2_CHOSEN.name + ')',
      run: (exit, p, cost) => runLiloV2(bag, inp, p.start, p.end, { ...LILO_V2_CHOSEN, book: { ...LILO_V2_CHOSEN.book, schedule: exit === 'own' ? 'none' : exit } }, cost),
    },
    { id: 'lilo', name: 'Current LILO, 5 ladders (own = T1 / T2)', run: (exit, p, cost) => ({ ...runLiloPortfolio(bag, inp, p.start, p.end, 5, cost, exit === 'own' ? undefined : { schedule: exit }) }) },
    pf('combo', 'Combo 2 of 3, 3 slots, 200-day sell', 'combo', { slots: 3, exit: 'trend', trendDays: 200 }),
    pf('trend200', 'Trend 200, 3 slots', 'trend', { slots: 3, trendDays: 200 }),
    pf('engine', 'Engine alone, 3 slots, 200-day sell', 'engine', { slots: 3, exit: 'trend', trendDays: 200 }),
    pf('turtle', 'Turtle, 3 slots, 200-day sell', 'turtle', { slots: 3, exit: 'trend', trendDays: 200 }),
  ];
}

const pct = (v: number): string => ((v / CASH - 1) * 100 >= 0 ? '+' : '') + ((v / CASH - 1) * 100).toFixed(0) + '%';
const money = (v: number): string => (v < 0 ? '-' : '') + '$' + Math.round(Math.abs(v) / 1000) + 'k';
const HEAD = ['| Entry model | Exit | 2010-2019 (in-sample) | 2020-2023 | 2024-2026 | Beats QQQ | Beats the 14 (plain / join) | Deepest fall | Stock trades | Left on the table, sheet / after tax (positions helped) |', '|---|---|---|---|---|---|---|---|---|---|'];
function row(e: string, exit: string, r: readonly Outcome[], b: Benchmarks): string {
  const v = r.map((x) => x.finalTaxed), j = b.listJoin ?? b.list;
  const pts = r.map((x) => x.pt).filter((x): x is NonNullable<Outcome['pt']> => !!x);
  const left = pts.length ? money(pts.reduce((a, x) => a + x.leftOnTableSheet, 0)) + ' / ' + money(pts.reduce((a, x) => a + x.leftOnTableReal, 0)) + ' (' + pts.reduce((a, x) => a + x.helped, 0) + ' of ' + pts.reduce((a, x) => a + x.positions, 0) + ')' : '—';
  return '| ' + e + ' | ' + exit + ' | ' + v.map(pct).join(' | ') + ' | ' + v.filter((x, i) => x > b.qqq[i]!.finalTaxed).length + ' of 3 | ' + v.filter((x, i) => x > b.list[i]!.finalTaxed).length + ' / ' + v.filter((x, i) => x > j[i]!.finalTaxed).length
    + ' of 3 | -' + Math.max(...r.map((x) => x.maxDrawdownPct)).toFixed(0) + '% | ' + r.reduce((a, x) => a + x.trades, 0) + ' | ' + left + ' |';
}

/** Plan 02 acceptance 2, in one period: better after tax, or a fall cut by 10+ points while keeping 90%+ of the gain. */
export function improves(s: Outcome, own: Outcome): boolean {
  if (s.finalTaxed > own.finalTaxed) return true;
  const gain = own.finalTaxed - CASH, sg = s.finalTaxed - CASH;
  return own.maxDrawdownPct - s.maxDrawdownPct >= 10 && gain > 0 && sg >= 0.9 * gain;
}

function main(): void {
  const [priceDir, readsDir] = process.argv.slice(2) as [string, string];
  const series = new Map<string, PriceSeries>(), reads = new Map<string, Map<string, CompactRead>>();
  for (const f of fs.readdirSync(readsDir).filter((x) => x.endsWith('.reads.json'))) {
    const t = f.replace('.reads.json', '').replace(/^_/, '^');
    try { series.set(t, loadSeries(t, priceDir)); } catch { continue; }
    reads.set(t, new Map((JSON.parse(fs.readFileSync(path.join(readsDir, f), 'utf8')) as CompactRead[]).map((r) => [r.d, r])));
  }
  for (const t of RESEARCH_UNIVERSE) if (!series.has(t)) { try { series.set(t, loadSeries(t, priceDir)); } catch { /* not downloaded */ } }
  const inp: PortfolioInput = { series, reads, qqq: loadSeries('QQQ', priceDir) };
  const bag = OWNER_BAG.filter((t) => series.has(t) && reads.has(t));
  const ents = entries(bag, inp);
  const costs = [0, 10], headline = 10;
  const out: string[] = ['# James — Profit-Taking: history test', '', 'Same entries, different exits. The 14: ' + bag.join(', ') + '. $100,000, after the 25% tax (every step pays its own), anchor layers (G1 A1-63, U1 k=5) frozen at the first buy, the rest on the entry model\'s own sell, a step\'s cash into QQQ at the next open, resting limit sells at the layers.'];
  const res = new Map<number, Map<string, Map<Exit, Outcome[]>>>();
  for (const cost of costs) {
    const bench = benchmarksFor(bag, inp, CASH, { costBps: cost });
    const m = new Map<string, Map<Exit, Outcome[]>>();
    out.push('', '## Pass 1 at ' + cost + ' bps per side' + (cost === headline ? ' (headline)' : ''), '', ...HEAD,
      ...benchRows(bench, CASH, 2, ['', '', 'fall', '', ''], LABELS.holdResearchCore));
    for (const e of ents) {
      const byExit = new Map<Exit, Outcome[]>();
      for (const x of EXITS) {
        const r = e.id === 'hold14' && x === 'own' ? bench.list.map((y) => ({ ...y, trades: 14 })) : PERIODS.map((p) => e.run(x, p, cost));
        byExit.set(x, r);
        out.push(row(e.name, x === 'own' ? (e.id === 'hold14' || e.id === 'holdQqq' ? 'hold (no sells)' : e.id === 'liloV2' ? 'no layer-out' : 'own sell') + ' (control)' : x + (x === PT_DEFAULT ? ' (pre-registered)' : ''), r, bench));
      }
      m.set(e.id, byExit);
      process.stderr.write(cost + ' bps ' + e.id + '\n');
    }
    res.set(cost, m);
  }

  // D4: the schedule that works on the most entry models in 2010-2019 (ties: the smaller deepest fall), else A20
  const rh = res.get(headline)!;
  const benchH = benchmarksFor(bag, inp, CASH, { costBps: headline });
  const works = (x: PtSchedule, k: number): string[] => ents.filter((e) => improves(rh.get(e.id)!.get(x)![k]!, rh.get(e.id)!.get('own')![k]!)).map((e) => e.id);
  const tally = PT_SCHEDULES.map((x) => ({ x, n: works(x, 0).length, fall: Math.max(...ents.map((e) => rh.get(e.id)!.get(x)![0]!.maxDrawdownPct)) })).sort((a, b) => b.n - a.n || a.fall - b.fall);
  out.push('', '## Choosing the schedule on 2010-2019 only (D4)', '', '| Schedule | Entry models it works on in 2010-2019 (better after tax, or the fall cut 10+ points keeping 90% of the gain) |', '|---|---|',
    ...tally.map((t) => '| ' + t.x + ' | ' + t.n + ' of ' + ents.length + (t.n ? ' (' + works(t.x, 0).join(', ') + ')' : '') + ' |'));
  const top = tally[0]!;
  // T2(d): the neighbouring schedule (A10 <-> A20, B10 <-> B20, C <-> A10) must not flip the sign of the 2010-2019 result on most entry models
  const nb: Record<PtSchedule, PtSchedule> = { A20: 'A10', A10: 'A20', B20: 'B10', B10: 'B20', C: 'A10' };
  const sign = (x: PtSchedule, e: string): number => Math.sign(rh.get(e)!.get(x)![0]!.finalTaxed - rh.get(e)!.get('own')![0]!.finalTaxed);
  const sameSign = ents.filter((e) => sign(top.x, e.id) === sign(nb[top.x], e.id)).length;
  const stable = sameSign * 2 >= ents.length;
  out.push('', '- Most entry models in 2010-2019: **' + top.x + '** (' + top.n + ' of ' + ents.length + '). Neighbour ' + nb[top.x] + ' has the same sign on ' + sameSign + ' of ' + ents.length + ' -> ' + (stable ? 'stable' : 'NOT stable') + '.');

  // the exit's random-signal null (the same number of partial sells of the same size on random days in the same positions)
  const pfEnts = ents.filter((e) => e.portfolio);
  const nullOf = (e: Entry, x: PtSchedule, k: number): { model: number; nul: NullDistribution } => {
    const p = PERIODS[k]!, r = rh.get(e.id)!.get(x)![k]!;
    const pt = r.pt!;
    const nul = randomSignalNull(pt.sellsByTicker, (t) => pt.heldDaysByTicker.get(t) ?? [], (randomSells) => e.run(x, p, headline, { randomSells }).finalTaxed);
    return { model: r.finalTaxed, nul };
  };
  const nulls = new Map(pfEnts.map((e) => [e.id, PERIODS.map((_, k) => nullOf(e, top.x, k))]));
  const nullPass = pfEnts.filter((e) => nulls.get(e.id)![0]!.model > nulls.get(e.id)![0]!.nul.p95).length;
  out.push('', '### The exit\'s random-signal null for ' + top.x + ' (100 seeds, ' + headline + ' bps)', '', '| Entry | Period | Schedule | Null median | Null 95th percentile |', '|---|---|---|---|---|',
    ...pfEnts.flatMap((e) => PERIODS.map((p, k) => { const n = nulls.get(e.id)![k]!; return '| ' + e.name + ' | ' + p.name + ' | ' + pct(n.model) + ' | ' + pct(n.nul.median) + ' | ' + pct(n.nul.p95) + ' |'; })),
    '', 'Above the null\'s 95th percentile in 2010-2019 on ' + nullPass + ' of ' + pfEnts.length + ' entry models.');
  const chosen: PtSchedule = top.n > 0 && stable && nullPass * 2 > pfEnts.length ? top.x : PT_DEFAULT;
  out.push('', '**Chosen schedule: ' + chosen + '**' + (chosen === PT_DEFAULT && top.x !== PT_DEFAULT ? ' (the pre-registered A20 stays: ' + top.x + ' did not pass the guards)' : chosen === PT_DEFAULT ? ' (the pre-registered default' + (top.n ? '' : '; no schedule works on any entry model in 2010-2019') + ')' : '') + '.');

  // out-of-sample standing of the chosen schedule (T2c)
  out.push('', '### Out-of-sample standing of ' + chosen + ' (' + headline + ' bps)', '', '| Entry model | 2020-2023: rank among the 6 exits / beats own sell | 2024-2026: rank / beats own sell |', '|---|---|---|');
  for (const e of ents) {
    const cells = [1, 2].map((k) => {
      const vals = EXITS.map((x) => rh.get(e.id)!.get(x)![k]!.finalTaxed), mine = rh.get(e.id)!.get(chosen)![k]!.finalTaxed;
      return (vals.filter((v) => v > mine).length + 1) + ' of 6 / ' + (improves(rh.get(e.id)!.get(chosen)![k]!, rh.get(e.id)!.get('own')![k]!) ? 'yes' : 'no');
    });
    out.push('| ' + e.name + ' | ' + cells.join(' | ') + ' |');
  }
  for (const k of [1, 2]) {
    const cellsAll = ents.flatMap((e) => PT_SCHEDULES.map((x) => improves(rh.get(e.id)!.get(x)![k]!, rh.get(e.id)!.get('own')![k]!)));
    const diffs = ents.map((e) => (rh.get(e.id)!.get(chosen)![k]!.finalTaxed - rh.get(e.id)!.get('own')![k]!.finalTaxed) / CASH * 100);
    out.push('', '- ' + PERIODS[k]!.name + ': ' + cellsAll.filter(Boolean).length + ' of ' + cellsAll.length + ' (entry x schedule) cells beat their own sell; ' + chosen + ' minus own sell across the entry models: median ' + quantile(diffs, 0.5).toFixed(0) + ' points, interquartile ' + quantile(diffs, 0.25).toFixed(0) + ' to ' + quantile(diffs, 0.75).toFixed(0) + ' points.');
  }

  // pass 2 on the combo and Trend 200 entries, one knob at a time around the chosen schedule
  const knobs: Array<[string, Partial<ProfitTakingOverlay>]> = [
    ['entry layers', { layers: 'entry' }], ['percent layers (x1.25 / 1.5 / 2 / 2.5 / 3)', { layers: 'percent' }], ['rest held to the end', { rest: 'hold' }], ['rest on the 200-day sell', { rest: 'trend200' }],
    ['close trigger, next-open sale', { trigger: 'close' }], ['cash waits in cash', { cashTo: 'cash' }], ['cash to the faster horse', { cashTo: 'fasterHorse' }],
  ];
  out.push('', '## Pass 2 — ' + chosen + ' on the combo and Trend 200 entries, one knob at a time (' + headline + ' bps)', '', ...HEAD);
  const adopt: Array<[string, Partial<ProfitTakingOverlay>]> = [];
  for (const [kn, extra] of knobs) {
    let better = 0;
    for (const e of ents.filter((x) => x.id === 'combo' || x.id === 'trend200')) {
      const r = PERIODS.map((p) => e.run(chosen, p, headline, extra));
      out.push(row(e.name, chosen + ' + ' + kn, r, benchH));
      if (r[0]!.finalTaxed > rh.get(e.id)!.get(chosen)![0]!.finalTaxed) better++;
    }
    if (better === 2) adopt.push([kn, extra]);
  }
  out.push('', adopt.length ? 'Better in 2010-2019 on both entries (shown, exploratory): ' + adopt.map((a) => a[0]).join(', ') + '. Pass 2 is reported, not adopted: the paper accounts keep the plan defaults (anchor layers, rest on the own sell, cash to QQQ, intraday).' : 'No knob is better in 2010-2019 on both entries; the plan defaults stay.');

  // robustness: the chosen schedule and the runner-up on random bags and the universe minus the 14 (combo, Trend 200)
  const runnerUp = tally.find((t) => t.x !== chosen)!.x;
  const bags = randomBags([...reads.keys()].sort(), 20, 12);
  const minus = universeMinusList([...reads.keys()].sort());
  out.push('', '## Robustness (T5): 20 random bags of 12 and the universe minus the 14 (' + headline + ' bps; survivors only, no delisted names: an upper bound)', '',
    '| Entry | Exit | Period | Bags beating QQQ | Bags beating their own sell | Bag average | Universe minus the 14 (own sell -> schedule) |', '|---|---|---|---|---|---|---|');
  for (const e of ents.filter((x) => x.id === 'combo' || x.id === 'trend200')) for (const x of [chosen, runnerUp]) PERIODS.forEach((p, k) => {
    const q = benchH.qqq[k]!.finalTaxed;
    const own = bags.map((b) => e.run('own', p, headline, undefined, b).finalTaxed), sch = bags.map((b) => e.run(x, p, headline, undefined, b).finalTaxed);
    out.push('| ' + e.name + ' | ' + x + ' | ' + p.name + ' | ' + sch.filter((v) => v > q).length + ' of 20 | ' + sch.filter((v, i) => v > own[i]!).length + ' of 20 | ' + pct(sch.reduce((a, b) => a + b, 0) / 20)
      + ' | ' + pct(e.run('own', p, headline, undefined, minus).finalTaxed) + ' -> ' + pct(e.run(x, p, headline, undefined, minus).finalTaxed) + ' |');
  });

  out.push('', '### Report columns (' + headline + ' bps)', ...reportTable(benchH, ents.flatMap((e) => [{ name: e.name + ', own', outcomes: rh.get(e.id)!.get('own')! }, { name: e.name + ', ' + chosen, outcomes: rh.get(e.id)!.get(chosen)! }]), inp.qqq, CASH, LABELS.holdResearchCore));
  process.stdout.write(out.join('\n') + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
