/**
 * `node src/research/qualityGateCli.ts <priceDir> <readsDir> [--facts=<dir>] [--cost=0,10]`: the history test of James —
 * Quality Gate (docs/models/plans/10-quality-gate-8-step-ackman.md section 6), phase 5 of docs/models/MASTER_PLAN.md.
 * The gate is a FILTER on another model: "host model X, buying only stocks that pass the gate". Hosts: Combo 2 of 3,
 * Trend 200, the engine alone (the main models of the windows grid) and Everything together (plan 10's second host), each
 * with its fixed setup (3 stocks, idle money in QQQ). Per host: ungated, the plan's pre-registered gate as written
 * (5 of 7, unknown = no point), then the testable form fixed before the run (the same pass share over the items known
 * that day) at 4 / 5 / 6 of 7, and the size variant; the level is chosen on 2010-2019 only; the random-gate null; the
 * universe minus the 14 (Trend 200 only: the engine reads exist for the 14 only); leave-one-out; score history and item
 * hit rates; blocked buy signals; the Rule #131 columns. 0 and 10 bps per side (10 the headline). Prints markdown.
 *
 * Point-in-time data: items 7 (Trend 200) and 8 (dollar volume) from prices; item 1 from the dated CEO table
 * (analysis/models/qualityGate.ts); items 2, 3, 4 and 6 from SEC company facts with filing dates when `--facts` points
 * at a fetchFundamentalsPit.ts download (absent: those items are unknown on every day); item 5 never on history.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { PriceSeries } from '../backtest/data.ts';
import { PERIODS } from './lab.ts';
import { runPortfolio, type PortfolioInput, type PortfolioModel, type PortfolioOptions, type PortfolioResult } from './portfolioLab.ts';
import { OWNER_BAG, universeMinusList } from './portfolioCli.ts';
import { RESEARCH_UNIVERSE } from './fetchPrices.ts';
import { benchmarksFor, benchRows, reportTable } from './benchmarks.ts';
import { sweepGuard, mulberry32, quantile, NULL_SEEDS, NULL_SEED, type SweepSetup, type NullDistribution } from './guards.ts';
import { loadBag, CASH, pct, resultRowP2, RESULT_HEAD_P2 } from './phase2Common.ts';
import type { CompactRead } from './computeReads.ts';
import { qualityScore, priceItemsSeries, fundInputsFromPit, passesGate, gateSizeScale, QUALITY_DEFAULTS, GATE_PREREGISTERED, CEO_TABLE, type GateRule, type QualityScore } from '../analysis/models/qualityGate.ts';
import { fundamentalsAsOf, type CompanyFacts, type PitFundamentals } from '../fetch/sec/companyFacts.ts';
import { LABELS } from '../profile/labels.ts';

// ─────────────────────────────── hosts and gate settings ───────────────────────────────

export interface QgHost { readonly key: 'combo' | 'trend200' | 'engine' | 'best'; readonly name: string; readonly short: string; readonly m: PortfolioModel; readonly o: Partial<PortfolioOptions> }
export const QG_HOSTS: readonly QgHost[] = [
  { key: 'combo', name: 'Combo 2 of 3 (3, 200-day sell)', short: 'Combo 2/3', m: 'combo', o: { slots: 3, exit: 'trend', trendDays: 200 } },
  { key: 'trend200', name: 'Trend 200 (3)', short: 'Trend 200', m: 'trend', o: { slots: 3, trendDays: 200 } },
  { key: 'engine', name: 'Engine alone (3, 200-day sell)', short: 'Engine', m: 'engine', o: { slots: 3, exit: 'trend', trendDays: 200 } },
  { key: 'best', name: 'Everything together, shares (engine OR combo, 3, 200-day sell)', short: 'Everything', m: 'best', o: { slots: 3, exit: 'trend', trendDays: 200 } },
];
/** The testable form, fixed before the first run (phase 5): the plan's pass share over the items known that day. */
export const GATE_SCALED_DEFAULT: GateRule = { mode: 'scaled', mark: 5, outOf: 7 };
export const GATE_LEVELS: readonly GateRule[] = [4, 5, 6].map((mark) => ({ mode: 'scaled' as const, mark, outOf: 7 }));
export const gateName = (g: GateRule): string => (g.mode === 'strict' ? 'gate ' + g.mark + ' of ' + g.outOf + ' as written (unknown = no point)' : 'gate ' + g.mark + ' of ' + g.outOf + ' over the known items');
/**
 * The level chosen on 2010-2019 only for each host (this CLI at 10 bps; docs/models/results/phase5.md). Used by the
 * windows grid, the report page and the paper account (james.trend200.q6).
 */
export const QG_CHOSEN: Readonly<Record<QgHost['key'], GateRule>> = {
  combo: GATE_LEVELS[0]!, trend200: GATE_LEVELS[0]!, engine: GATE_LEVELS[0]!, best: GATE_SCALED_DEFAULT,
};

// ─────────────────────────────── the score timeline ───────────────────────────────

/** Per ticker, per day: the history score (out of 7). */
export type ScoreBook = ReadonlyMap<string, ReadonlyMap<string, QualityScore>>;

function loadFacts(dir: string | undefined, tickers: readonly string[]): Map<string, CompanyFacts> {
  const m = new Map<string, CompanyFacts>();
  if (!dir) return m;
  for (const t of tickers) {
    const f = path.join(dir, t + '.facts.json');
    if (fs.existsSync(f)) m.set(t, (JSON.parse(fs.readFileSync(f, 'utf8')) as { facts: CompanyFacts }).facts);
  }
  return m;
}

/**
 * The history score of every stock on every bar (point-in-time). With `facts`, items 2-4 come from the first filings
 * dated on or before each day, and item 6 compares the stock's price-to-sales with the median over `peers` (the
 * research universe minus QQQ / SPY / ^VIX: plan 10's default peer group) that day.
 */
export function scoreBook(series: ReadonlyMap<string, PriceSeries>, facts: ReadonlyMap<string, CompanyFacts> = new Map(), peers: ReadonlyMap<string, PriceSeries> = new Map()): ScoreBook {
  const missing = facts.size ? 'no SEC filing for this stock yet' : 'no SEC point-in-time data in this run';
  // point-in-time filings, recomputed only on days a new filing appears
  const pitOf = new Map<string, Map<string, PitFundamentals | null>>();
  const pitSeries = (t: string, s: PriceSeries): Map<string, PitFundamentals | null> => {
    let m = pitOf.get(t); if (m) return m;
    m = new Map(); pitOf.set(t, m);
    const f = facts.get(t);
    if (!f) return m;
    const filings = [...new Set(Object.values(f).flatMap((es) => es.map((e) => e.filed)))].sort();
    let cur: PitFundamentals | null = null, k = 0;
    for (const d of s.dates) {
      let moved = false;
      while (k < filings.length && (filings[k] as string) <= d) { k++; moved = true; }
      if (moved || (cur == null && k > 0)) cur = fundamentalsAsOf(f, d);
      m.set(d, cur);
    }
    return m;
  };
  const psOn = (t: string, s: PriceSeries, i: number): number | null => {
    const f = pitSeries(t, s).get(s.dates[i] as string);
    return f && f.dilutedShares != null && f.revenueTtm != null && f.revenueTtm > 0 ? ((s.closes[i] as number) * f.dilutedShares) / f.revenueTtm : null;
  };
  const peerMedian = new Map<string, number | null>();
  if (facts.size) {
    const idx = [...peers].filter(([t]) => facts.has(t)).map(([t, s]) => ({ t, s, at: new Map(s.dates.map((d, i) => [d, i])) }));
    const days = new Set<string>(); for (const s of series.values()) for (const d of s.dates) days.add(d);
    for (const d of days) {
      const xs = idx.flatMap((p) => { const i = p.at.get(d); const v = i == null ? null : psOn(p.t, p.s, i); return v == null ? [] : [v]; });
      peerMedian.set(d, xs.length >= 3 ? quantile(xs, 0.5) : null);
    }
  }
  const out = new Map<string, Map<string, QualityScore>>();
  for (const [t, s] of series) {
    const prices = priceItemsSeries(s, QUALITY_DEFAULTS), pit = pitSeries(t, s), m = new Map<string, QualityScore>();
    s.dates.forEach((d, i) => {
      const fund = fundInputsFromPit(pit.get(d) ?? null, s.closes[i] as number, peerMedian.get(d) ?? null, missing);
      m.set(d, qualityScore({ ticker: t, day: d, prices, i, fund, history: true }));
    });
    out.set(t, m);
  }
  return out;
}

export const gateOf = (book: ScoreBook, g: GateRule) => (t: string, d: string): boolean => { const s = book.get(t)?.get(d); return !!s && passesGate(s, g); };
export const sizeOf = (book: ScoreBook, g: GateRule) => (t: string, d: string): number => { const s = book.get(t)?.get(d); return s ? gateSizeScale(s, g) : 0; };

/** One host on one window with a gate setting (null = ungated). */
export function runGated(h: QgHost, bag: readonly string[], inp: PortfolioInput, start: string, end: string, cost: number, book: ScoreBook | null, g: GateRule | null, size = false): PortfolioResult {
  const o: PortfolioOptions = { slots: 3, cash: CASH, costBps: cost, ...h.o };
  if (!book || !g) return runPortfolio(h.m, bag, inp, start, end, o);
  const sz = sizeOf(book, g);
  return runPortfolio(h.m, bag, inp, start, end, size ? { ...o, gate: (t, d) => sz(t, d) > 0, sizeScale: sz } : { ...o, gate: gateOf(book, g) });
}

/** The random-gate null: each stock blocked for whole calendar quarters at random, with the real gate's share of blocked buy-signal days. */
function randomGateNull(h: QgHost, bag: readonly string[], inp: PortfolioInput, start: string, end: string, cost: number, blockShare: number, seeds = NULL_SEEDS): NullDistribution {
  const values: number[] = [];
  for (let k = 0; k < seeds; k++) {
    const rnd = mulberry32(NULL_SEED + k), memo = new Map<string, boolean>();
    const gate = (t: string, d: string): boolean => {
      const key = t + '|' + d.slice(0, 4) + 'Q' + Math.floor((Number(d.slice(5, 7)) - 1) / 3);
      let v = memo.get(key); if (v == null) { v = rnd() >= blockShare; memo.set(key, v); }
      return v;
    };
    values.push(runPortfolio(h.m, bag, inp, start, end, { slots: 3, cash: CASH, costBps: cost, ...h.o, gate }).finalTaxed);
  }
  return { values, median: quantile(values, 0.5), p95: quantile(values, 0.95) };
}

const blockShareOf = (r: PortfolioResult): number => {
  const g = r.gateStats; if (!g) return 0;
  const sig = [...g.signalDaysByTicker.values()].reduce((a, b) => a + b, 0), bl = [...g.blockedByTicker.values()].reduce((a, b) => a + b, 0);
  return sig ? bl / sig : 0;
};

/**
 * Plan 10's selection rule (section 6): the pre-registered level stays unless another level beats it in 2010-2019
 * AND its neighbouring levels improve on the ungated host with the same sign.
 */
export function chooseLevel(finals2010: readonly number[], ungated2010: number, defaultIdx: number): number {
  let best = defaultIdx;
  finals2010.forEach((v, i) => { if (v > (finals2010[best] as number)) best = i; });
  if (best === defaultIdx) return defaultIdx;
  const sign = Math.sign((finals2010[best] as number) - ungated2010);
  const nb = [best - 1, best + 1].filter((i) => i >= 0 && i < finals2010.length && i !== best);
  return nb.every((i) => Math.sign((finals2010[i] as number) - ungated2010) === sign) ? best : defaultIdx;
}

// ─────────────────────────────── main ───────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const [priceDir, readsDir] = args.filter((a) => !a.startsWith('--')) as [string, string];
  const costArg = args.find((a) => a.startsWith('--cost'));
  const costs = costArg ? (costArg.split('=')[1] ?? '0,10').split(',').map(Number) : [0, 10];
  const H = costs.includes(10) ? 10 : costs[costs.length - 1]!;
  const factsDir = args.find((a) => a.startsWith('--facts='))?.slice(8);
  const series = loadBag(priceDir, OWNER_BAG);
  const bag = OWNER_BAG.filter((t) => series.has(t));
  const qqq = loadBag(priceDir, ['QQQ']).get('QQQ')!;
  const reads = new Map<string, Map<string, CompactRead>>();
  for (const t of bag) { const f = path.join(readsDir, t + '.reads.json'); if (fs.existsSync(f)) reads.set(t, new Map((JSON.parse(fs.readFileSync(f, 'utf8')) as CompactRead[]).map((r) => [r.d, r]))); }
  const inp: PortfolioInput = { series, reads, qqq };
  const uni = loadBag(priceDir, RESEARCH_UNIVERSE), minus = universeMinusList([...uni.keys()].sort());
  const peers = new Map([...uni].filter(([t]) => !['QQQ', 'SPY', '^VIX', '_VIX'].includes(t)));
  const facts = loadFacts(factsDir, [...peers.keys()]);
  const book = scoreBook(series, facts, peers);
  const out: string[] = ['# James — Quality Gate: history test', '',
    'The 14: ' + bag.join(', ') + '. $100,000, decide at the close, fill at the next open, 25% tax on every gain, values after the tax on what is still held, idle money in QQQ. The gate only removes buys of the host model (a held stock is never sold for a score drop).', '',
    '**Point-in-time data in this run:** prices (items 7 and 8, every day); the dated CEO table for the 14 (item 1; built 2026-10-31 from public records as recalled, owner to check); '
      + (facts.size ? 'SEC company facts with filing dates for ' + facts.size + ' companies (items 2, 3, 4, 6).' : '**no SEC company facts** (`--facts` not given or empty): items 2 (revenue growth), 3 (dilution), 4 (gross margin) and 6 (price-to-sales vs peers) are **unknown on every day**.')
      + ' Item 5 (use-case analog) is never scored on history. So a history score has at most ' + (facts.size ? 7 : 3) + ' known items of 7.'];

  // ── score history and item hit rates (2010 to the end) ──
  const hist = (t: string): QualityScore[] => [...(book.get(t)?.entries() ?? [])].filter(([d]) => d >= '2010-01-01').map(([, s]) => s);
  out.push('', '## 1. Score history (2010 to 2026-10-27, every trading day the stock traded)', '', 'Share of days at each score (points / known items). Plan 10 acceptance 4: a stock on one score more than 80% of the time makes the gate a fixed include / exclude list in disguise.', '',
    '| Stock | Days | Scores (share of days) | Most common | Passes 5 of 7 over the known items | Item 1 Team | Item 7 Chart | Item 8 Tradability |', '|---|---|---|---|---|---|---|---|');
  let fixedCount = 0;
  for (const t of bag) {
    const xs = hist(t); if (!xs.length) continue;
    const cnt = new Map<string, number>();
    for (const s of xs) { const k = s.points + '/' + s.known; cnt.set(k, (cnt.get(k) ?? 0) + 1); }
    const sorted = [...cnt].sort((a, b) => b[1] - a[1]);
    const top = sorted[0]!; if (top[1] / xs.length > 0.8) fixedCount++;
    const item = (n: number): string => { const k = xs.filter((s) => s.items.find((x) => x.n === n)!.state !== 'unknown'); return k.length ? Math.round((k.filter((s) => s.items.find((x) => x.n === n)!.state === 'pass').length / k.length) * 100) + '%' : 'unknown'; };
    out.push('| ' + t + ' | ' + xs.length + ' | ' + sorted.map(([k, n]) => k + ' ' + Math.round((n / xs.length) * 100) + '%').join(', ') + ' | ' + top[0] + ' (' + Math.round((top[1] / xs.length) * 100) + '%) | '
      + Math.round((xs.filter((s) => passesGate(s, GATE_SCALED_DEFAULT)).length / xs.length) * 100) + '% | ' + item(1) + ' | ' + item(7) + ' | ' + item(8) + ' |');
  }
  out.push('', fixedCount + ' of ' + bag.length + ' stocks sit on one score more than 80% of the days. Item columns: share of days with the point, among the days the item was known.');
  out.push('', 'CEO table used for item 1 (founder, or CEO 5+ years): ' + bag.map((t) => t + ' ' + (CEO_TABLE[t] ?? []).map((c) => c.name.split(' ').slice(-1)[0] + ' ' + c.from.slice(0, 4) + (c.founder ? ' (founder)' : '')).join(', ')).join('; ') + '.');

  // ── the hosts, gated and ungated ──
  const settings: Array<{ name: string; g: GateRule | null; size?: boolean }> = [
    { name: 'ungated (the host as in the windows grid)', g: null },
    { name: '**pre-registered: ' + gateName(GATE_PREREGISTERED) + '**', g: GATE_PREREGISTERED },
    ...GATE_LEVELS.map((g) => ({ name: gateName(g) + (g.mark === GATE_SCALED_DEFAULT.mark ? ' **(the testable default, fixed before the run)**' : ''), g })),
    { name: 'size variant: slot x min(1, pass share / (5/7)), the rest in QQQ', g: GATE_SCALED_DEFAULT, size: true },
  ];
  const runs = new Map<string, PortfolioResult[]>();
  const key = (h: QgHost, si: number, cost: number): string => h.key + '|' + si + '|' + cost;
  for (const cost of costs) for (const h of QG_HOSTS) settings.forEach((st, si) => runs.set(key(h, si, cost), PERIODS.map((p) => runGated(h, bag, inp, p.start, p.end, cost, book, st.g, st.size))));
  process.stderr.write('hosts done\n');
  const chosen = new Map<string, number>();
  out.push('', '## 2. The hosts, ungated and gated (the 14)');
  for (const cost of costs) {
    const bench = benchmarksFor(bag, inp, CASH, { costBps: cost });
    out.push('', '### ' + cost + ' bps per side' + (cost === H ? ' (headline)' : ''), '', RESULT_HEAD_P2[0] + ' Buy-signal days blocked (2010-19 / 20-23 / 24-26) |', RESULT_HEAD_P2[1] + '---|', ...benchRows(bench, CASH, 1, ['', '', 'fall', '', ''], LABELS.holdResearchCore));
    for (const h of QG_HOSTS) settings.forEach((st, si) => {
      const r = runs.get(key(h, si, cost))!;
      out.push(resultRowP2(h.name + ' — ' + st.name, r, bench) + ' ' + (st.g ? r.map((x) => Math.round(blockShareOf(x) * 100) + '%').join(' / ') : '—') + ' |');
    });
  }
  // selection on 2010-2019 at the headline cost
  out.push('', '### Choice of the level on 2010-2019 only (' + H + ' bps; plan 10 section 6: the default 5 of 7 stays unless another level beats it in 2010-2019 and its neighbouring levels improve on the ungated host with the same sign)', '');
  const qqqFinals = benchmarksFor(bag, inp, CASH, { costBps: H }).qqq.map((b) => b.finalTaxed);
  for (const h of QG_HOSTS) {
    const ung = runs.get(key(h, 0, H))!, levels = GATE_LEVELS.map((_, i) => runs.get(key(h, 2 + i, H))!);
    const ci = chooseLevel(levels.map((r) => r[0]!.finalTaxed), ung[0]!.finalTaxed, 1);
    chosen.set(h.key, ci);
    const sw: SweepSetup[] = GATE_LEVELS.map((g, i) => ({ name: gateName(g), knobs: { level: i }, finals: levels[i]!.map((x) => x.finalTaxed) }));
    const gd = sweepGuard(sw, gateName(GATE_SCALED_DEFAULT), qqqFinals);
    out.push('- **' + h.name + '**: 2010-2019 ' + GATE_LEVELS.map((g, i) => g.mark + '/7 ' + pct(levels[i]![0]!.finalTaxed)).join(', ') + ' (ungated ' + pct(ung[0]!.finalTaxed) + ') -> **chosen ' + gateName(GATE_LEVELS[ci]!) + '**'
      + '; out of sample ' + levels[ci]!.slice(1).map((x, k) => PERIODS[k + 1]!.name + ' ' + pct(x.finalTaxed) + ' vs ungated ' + pct(ung[k + 1]!.finalTaxed)).join(', ')
      + '. Sweep guard (3 levels): ' + gd.periods.map((p, k) => (p ? PERIODS[k]!.name + ' percentile ' + p.percentile.toFixed(0) + ', ' + p.beatingQqqPct.toFixed(0) + '% beat QQQ, median ' + pct(p.median) : null)).filter(Boolean).join('; ') + '.');
  }

  out.push('', 'QG_CHOSEN in the code (used by the windows grid, the report page and the paper account) matches these choices: ' + (QG_HOSTS.every((h) => QG_CHOSEN[h.key].mark === GATE_LEVELS[chosen.get(h.key)!]!.mark) ? 'yes' : '**NO — update QG_CHOSEN**') + '.');

  // ── random-gate null ──
  out.push('', '## 3. Random-gate null (plan 10 section 6; ' + H + ' bps, ' + NULL_SEEDS + ' seeds): each stock blocked for whole calendar quarters at random, with the chosen gate\'s own share of blocked buy-signal days in that period', '',
    '| Host | Period | Gated (chosen) | Ungated | Share blocked | Null median | Null 95th percentile | Gated above the null median? |', '|---|---|---|---|---|---|---|---|');
  const nullOk = new Map<string, boolean[]>();
  for (const h of QG_HOSTS) {
    const ci = chosen.get(h.key)!, r = runs.get(key(h, 2 + ci, H))!, ung = runs.get(key(h, 0, H))!;
    const ok: boolean[] = [];
    PERIODS.forEach((p, k) => {
      const share = blockShareOf(r[k]!);
      const nul = randomGateNull(h, bag, inp, p.start, p.end, H, share);
      ok.push(r[k]!.finalTaxed > nul.median);
      out.push('| ' + h.short + ' | ' + p.name + ' | ' + pct(r[k]!.finalTaxed) + ' | ' + pct(ung[k]!.finalTaxed) + ' | ' + Math.round(share * 100) + '% | ' + pct(nul.median) + ' | ' + pct(nul.p95) + ' | ' + (r[k]!.finalTaxed > nul.median ? 'yes' : 'no') + (k === 0 ? (r[k]!.finalTaxed > nul.p95 ? ' (above the 95th)' : ' (not above the 95th)') : '') + ' |');
    });
    nullOk.set(h.key, ok);
    process.stderr.write('null ' + h.key + '\n');
  }

  // ── blocked buy signals per stock ──
  out.push('', '## 4. Blocked buy signals per stock (the chosen gate, ' + H + ' bps): blocked days / buy-signal days while not held', '', '| Stock | ' + QG_HOSTS.map((h) => PERIODS.map((p) => h.short + ' ' + p.name).join(' | ')).join(' | ') + ' |', '|---|' + QG_HOSTS.flatMap(() => PERIODS.map(() => '---|')).join(''));
  for (const t of bag) {
    out.push('| ' + t + ' | ' + QG_HOSTS.map((h) => runs.get(key(h, 2 + chosen.get(h.key)!, H))!.map((r) => { const b = r.gateStats!.blockedByTicker.get(t) ?? 0, s = r.gateStats!.signalDaysByTicker.get(t) ?? 0; return s ? b + ' / ' + s : '—'; }).join(' | ')).join(' | ') + ' |');
  }
  out.push('', '"What the blocked trades would have returned" is the difference between the gated and ungated rows of section 2 (the account-level answer); per-trade counterfactuals are not separable in a slot portfolio.');

  // ── leave-one-out ──
  out.push('', '## 5. Leave-one-out (' + H + ' bps): gated (chosen) minus ungated, percentage points of the $100,000, with each stock removed in turn', '', '| Stock removed | ' + QG_HOSTS.map((h) => PERIODS.map((p) => h.short + ' ' + p.name).join(' | ')).join(' | ') + ' |', '|---|' + QG_HOSTS.flatMap(() => PERIODS.map(() => '---|')).join(''));
  const pp = (x: number): string => (x >= 0 ? '+' : '') + x.toFixed(0);
  const looWins = new Map<string, number[]>(QG_HOSTS.map((h) => [h.key, PERIODS.map(() => 0)]));
  for (const t of ['(none)', ...bag]) {
    const b = bag.filter((x) => x !== t);
    out.push('| ' + t + ' | ' + QG_HOSTS.map((h) => PERIODS.map((p, k) => {
      const gR = runGated(h, b, inp, p.start, p.end, H, book, GATE_LEVELS[chosen.get(h.key)!]!), uR = runGated(h, b, inp, p.start, p.end, H, null, null);
      const d = ((gR.finalTaxed - uR.finalTaxed) / CASH) * 100;
      if (t !== '(none)' && d > 0) looWins.get(h.key)![k]!++;
      return pp(d);
    }).join(' | ')).join(' | ') + ' |');
  }
  out.push('', 'Removals where the gate still helped (of ' + bag.length + '): ' + QG_HOSTS.map((h) => h.short + ' ' + looWins.get(h.key)!.join(' / ')).join('; ') + '.');
  process.stderr.write('leave-one-out done\n');

  // ── the universe minus the 14 (Trend 200 only) ──
  const uInp: PortfolioInput = { series: new Map(minus.map((t) => [t, uni.get(t)!])), reads: new Map(), qqq };
  const uBook = scoreBook(uInp.series, facts, peers);
  const tH = QG_HOSTS.find((h) => h.key === 'trend200')!;
  const uBench = benchmarksFor(minus, uInp, CASH, { costBps: H });
  out.push('', '## 6. The universe minus the 14 (' + minus.length + ' survivors, no delisted names: an upper bound; deep losers included: INTC, BA, PYPL, F), Trend 200 only (the engine reads exist for the 14 only), ' + H + ' bps', '',
    'Here item 1 is unknown too (the CEO table covers the 14 only): the known items are 7 and 8' + (facts.size ? ' plus the SEC items' : '') + '.', '', RESULT_HEAD_P2[0] + ' Buy-signal days blocked |', RESULT_HEAD_P2[1] + '---|', ...benchRows(uBench, CASH, 1, ['', '', 'fall', '', ''], 'Hold the universe minus the 14 equally'));
  const uRows: Array<[string, PortfolioResult[]]> = [
    ['Trend 200 (3), ungated', PERIODS.map((p) => runGated(tH, minus, uInp, p.start, p.end, H, null, null))],
    ['Trend 200 (3), ' + gateName(GATE_PREREGISTERED), PERIODS.map((p) => runGated(tH, minus, uInp, p.start, p.end, H, uBook, GATE_PREREGISTERED))],
    ['Trend 200 (3), ' + gateName(GATE_LEVELS[chosen.get('trend200')!]!) + ' (chosen on the 14)', PERIODS.map((p) => runGated(tH, minus, uInp, p.start, p.end, H, uBook, GATE_LEVELS[chosen.get('trend200')!]!))],
  ];
  for (const [n, r] of uRows) out.push(resultRowP2(n, r, uBench) + ' ' + (r[0]!.gateStats ? r.map((x) => Math.round(blockShareOf(x) * 100) + '%').join(' / ') : '—') + ' |');

  // ── Rule #131 columns ──
  const benchH = benchmarksFor(bag, inp, CASH, { costBps: H });
  out.push('', '## 7. Report columns (' + H + ' bps)', ...reportTable(benchH, QG_HOSTS.flatMap((h) => [
    { name: h.name + ', ungated', outcomes: runs.get(key(h, 0, H))! },
    { name: h.name + ', ' + gateName(GATE_LEVELS[chosen.get(h.key)!]!), outcomes: runs.get(key(h, 2 + chosen.get(h.key)!, H))! },
  ]), qqq, CASH, LABELS.holdResearchCore));

  // ── acceptance ──
  out.push('', '## 8. Acceptance (plan 10 section 10, on the level chosen on 2010-2019, ' + H + ' bps)', '');
  for (const h of QG_HOSTS) {
    const ci = chosen.get(h.key)!, r = runs.get(key(h, 2 + ci, H))!, ung = runs.get(key(h, 0, H))!;
    const beatsUngated = [1, 2].map((k) => r[k]!.finalTaxed > ung[k]!.finalTaxed);
    const fallOk = Math.max(r[1]!.maxDrawdownPct, r[2]!.maxDrawdownPct) <= Math.max(ung[1]!.maxDrawdownPct, ung[2]!.maxDrawdownPct) + 1e-9;
    const beatsYard = [1, 2].map((k) => r[k]!.finalTaxed > benchH.qqq[k]!.finalTaxed && r[k]!.finalTaxed > benchH.list[k]!.finalTaxed && r[k]!.finalTaxed > benchH.listJoin[k]!.finalTaxed);
    const nul = nullOk.get(h.key)!;
    out.push('- **' + h.name + '** (' + gateName(GATE_LEVELS[ci]!) + '): beats the ungated host out of sample ' + beatsUngated.map((x) => (x ? 'yes' : 'no')).join(' / ') + '; deepest fall no worse: ' + (fallOk ? 'yes' : 'no')
      + '; beats Hold QQQ and both ' + LABELS.holdList + ' versions: ' + beatsYard.map((x) => (x ? 'yes' : 'no')).join(' / ') + '; above the random-gate null median: ' + nul.slice(1).map((x) => (x ? 'yes' : 'no')).join(' / ')
      + ' -> **' + (beatsUngated.every(Boolean) && fallOk && beatsYard.every(Boolean) && nul.slice(1).every(Boolean) ? 'passes rule 1' : 'fails rule 1') + '**.');
  }
  out.push('- Rule 4 (the score varies): ' + fixedCount + ' of ' + bag.length + ' stocks sit on one score more than 80% of the days.');
  process.stdout.write(out.join('\n') + '\n');
}

/** Exported for the windows grid: the score book of the owner's list from prices only (the data this phase has). */
export function priceOnlyBook(series: ReadonlyMap<string, PriceSeries>): ScoreBook { return scoreBook(series); }

if (import.meta.url === `file://${process.argv[1]}`) main();
