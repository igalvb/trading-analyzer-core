/**
 * `node src/research/pairCli.ts <priceDir> [--cost=0,10]`: the history test of James — Pair Rotation
 * (docs/models/plans/06-pair-rotation.md section 6). Per pair: hold A, hold B, 50/50 (never and yearly rebalanced),
 * 📊 Hold QQQ and 📊 Hold the research list (both versions); the pre-registered default first (Z, n 20, k 2, unconfirmed,
 * cool-down 1, 100% swap, starting leg the cheaper one); pass 1 (signal x lookback x band x confirmed = 36), the sweep
 * guard against 50/50 chosen on the pair's stated in-sample window (MSTR/TSLA and MSTR/CLSK: 2020-2023; NVDA/AMD and
 * MU/MRVL: 2010-2019), pass 2 one knob at a time, the random-swap null (100 seeds), the Roth (0% tax) line, the
 * round-trip list and the split check, and Holm across the pairs. IBIT (from 2024-01-11) comes from the cached
 * legacy prices (`backend/legacy/historical_data`); the BTC filter and the mNAV gate need BTC-USD, which is not in the
 * research download: not run. Prints markdown (docs/models/results/phase2.md).
 */

import { loadSeries, PRICE_DIR, type PriceSeries } from '../backtest/data.ts';
import { PERIODS } from './lab.ts';
import type { PortfolioInput } from './portfolioLab.ts';
import { OWNER_BAG } from './portfolioCli.ts';
import { benchmarksFor, holdCurve, bestDays, bestDaysCheck, bestDaysCount } from './benchmarks.ts';
import { sweepGuard, randomSignalNull, nullVerdict, quantile, type SweepSetup } from './guards.ts';
import { runPair, hold5050Yearly, type PairSetup, type PairResult } from './pairLab.ts';
import { PAIR_DEFAULT, alignPair, type PairOptions } from '../analysis/models/pairRotation.ts';
import { holm } from './eventStudy.ts';
import { loadBag, CASH, pct } from './phase2Common.ts';
import { LABELS } from '../profile/labels.ts';

export const PAIR_DEFAULT_SETUP: PairSetup = { name: 'default: Z, n 20, k 2, unconfirmed', opts: PAIR_DEFAULT, sleeve: false };
export const pairSetupName = (o: PairOptions): string => o.signal + ', n ' + o.n + ', ' + (o.signal === 'Z' ? 'k ' : 'm ') + o.band + ', ' + (o.confirmed ? 'confirmed' : 'unconfirmed');
/**
 * MSTR/TSLA, the setup chosen on 2020-2023 (this CLI; docs/models/results/phase2.md). Used by the paper account and the
 * windows grid; the report page reads the same constant.
 */
export const PAIR_CHOSEN: PairSetup = { name: 'Z, n 20, k 2, unconfirmed', opts: PAIR_DEFAULT, sleeve: false };

interface PairCfg { readonly a: string; readonly b: string; readonly ins: number | null; readonly note: string }
const PAIR_CFG: readonly PairCfg[] = [
  { a: 'MSTR', b: 'TSLA', ins: 1, note: 'James\'s own trade. MSTR was a software company until it began buying BTC (2020-08), so 2010-2019 tests only the mechanics; the setup is chosen on 2020-2023 and judged on 2024-2026.' },
  { a: 'NVDA', b: 'AMD', ins: 0, note: 'Chosen on 2010-2019, judged on 2020-2023 and 2024-2026.' },
  { a: 'MU', b: 'MRVL', ins: 0, note: 'Chosen on 2010-2019, judged on 2020-2023 and 2024-2026.' },
  { a: 'MSTR', b: 'CLSK', ins: 1, note: '"I may roll in CLSK or some other miner." CLSK trades from 2016-11 in our data (Nasdaq from 2020): chosen on 2020-2023, judged on 2024-2026.' },
  { a: 'CLSK', b: 'IBIT', ins: null, note: 'IBIT exists only from 2024-01-11 (cached prices to 2026-08-21) and BTC-USD is not in the research download: the default only, on 2024-2026, descriptive (no choosing, no out-of-sample).' },
  { a: 'MSTR', b: 'IBIT', ins: null, note: 'MSTR against its own bitcoin: as CLSK/IBIT, the default only, 2024-2026, descriptive.' },
];

export function pairPass1(): Array<{ setup: PairSetup; knobs: Record<string, number> }> {
  const out: Array<{ setup: PairSetup; knobs: Record<string, number> }> = [];
  (['Z', 'ATR'] as const).forEach((sg, si) => [10, 20, 50].forEach((n, ni) => [1.5, 2, 2.5].forEach((band, bi) => [false, true].forEach((confirmed, ci) => {
    const opts: PairOptions = { ...PAIR_DEFAULT, signal: sg, n, band, confirmed };
    out.push({ setup: { name: pairSetupName(opts), opts, sleeve: false }, knobs: { signal: si, n: ni, band: bi, confirmed: ci } });
  }))));
  return out;
}
export function pairPass2(base: PairSetup): PairSetup[] {
  const v = (name: string, o: Partial<PairOptions>, sleeve = base.sleeve): PairSetup => ({ name: base.name + ' + ' + name, opts: { ...base.opts, ...o }, sleeve });
  return [v('cool-down 0', { coolDown: 0 }), v('cool-down 5', { coolDown: 5 }), v('50% core + 50% swap sleeve', {}, true), v('start in A', { start: 'A' }), v('start in B', { start: 'B' })];
}

function main(): void {
  const args = process.argv.slice(2);
  const [priceDir] = args.filter((a) => !a.startsWith('--')) as [string];
  const costArg = args.find((a) => a.startsWith('--cost'));
  const costs = costArg ? (costArg.split('=')[1] ?? '0,10').split(',').map(Number) : [0, 10];
  const H = costs.includes(10) ? 10 : costs[costs.length - 1]!;
  const series = loadBag(priceDir, [...OWNER_BAG, 'QQQ']);
  try { series.set('IBIT', loadSeries('IBIT', PRICE_DIR)); } catch { /* none */ }
  const qqq = series.get('QQQ')!;
  const bag = OWNER_BAG.filter((t) => series.has(t));
  const inp: PortfolioInput = { series, reads: new Map(), qqq };
  const out: string[] = ['# James — Pair Rotation: history test', '', '$100,000, always 100% in one leg (or 50% core + 50% swap sleeve), decide at the close, swap at the next open, 25% tax on each sold leg\'s gain (Roth 0% beside), values after tax. Daily bars only (James traded the 5-minute chart with extended hours). The BTC trend filter and the mNAV gate (ARBCloud stand-in) need BTC-USD, not in the research download: not run.'];
  const primaryP: Array<{ pair: string; p: number; passesOther: boolean }> = [];
  const benchBy = new Map(costs.map((c) => [c, benchmarksFor(bag, inp, CASH, { costBps: c })]));
  for (const cfg of PAIR_CFG) {
    const A = series.get(cfg.a), B = series.get(cfg.b);
    if (!A || !B) { out.push('', '## ' + cfg.a + ' / ' + cfg.b, '', 'No price data.'); continue; }
    const al = alignPair(A, B);
    const pers = PERIODS.map((p) => ({ ...p, start: p.start < al.dates[0]! ? al.dates[0]! : p.start, end: p.end > al.dates[al.dates.length - 1]! ? al.dates[al.dates.length - 1]! : p.end }))
      .map((p) => ({ ...p, ok: p.start <= p.end && al.dates.some((d) => d >= p.start && d <= p.end) }));
    const name = cfg.a + ' / ' + cfg.b;
    const runP = (s: PairSetup, cost: number, tax?: number): Array<PairResult | null> => pers.map((p) => (p.ok ? runPair(A, B, p.start, p.end, s, cost, tax) : null));
    const days = (p: typeof pers[number]): string[] => al.dates.filter((d) => d >= p.start && d <= p.end);
    const yard = (cost: number) => ({
      a: pers.map((p) => (p.ok ? holdCurve([A], days(p), CASH, { costBps: cost }) : null)), b: pers.map((p) => (p.ok ? holdCurve([B], days(p), CASH, { costBps: cost }) : null)),
      ab: pers.map((p) => (p.ok ? holdCurve([A, B], days(p), CASH, { costBps: cost }) : null)), aby: pers.map((p) => (p.ok ? hold5050Yearly(A, B, p.start, p.end, cost) : null)),
      q: pers.map((p) => (p.ok ? holdCurve([qqq], qqq.dates.filter((d) => d >= p.start && d <= p.end), CASH, { costBps: cost }) : null)),
    });
    const cell = (x: { finalTaxed: number } | null): string => (x ? pct(x.finalTaxed) : '—');
    const fall = (xs: Array<{ maxDrawdownPct: number } | null>): string => { const v = xs.filter((x): x is { maxDrawdownPct: number } => !!x); return v.length ? '-' + Math.max(...v.map((x) => x.maxDrawdownPct)).toFixed(0) + '%' : '—'; };
    const head = ['| Row | ' + pers.map((p, k) => PERIODS[k]!.name + (cfg.ins === k ? ' (in-sample)' : '') + (p.ok && (p.start !== PERIODS[k]!.start || p.end !== PERIODS[k]!.end) ? ' [' + p.start + ' to ' + p.end + ']' : '')).join(' | ') + ' | Beats 50/50 | Deepest fall | Swaps a year |', '|---|---|---|---|---|---|---|'];
    const row = (n: string, r: Array<PairResult | null>, y: ReturnType<typeof yard>): string => '| ' + n + ' | ' + r.map(cell).join(' | ') + ' | ' + r.filter((x, k) => x && y.ab[k] && x.finalTaxed > y.ab[k]!.finalTaxed).length + ' of ' + r.filter(Boolean).length + ' | ' + fall(r) + ' | '
      + r.map((x) => (x && x.years > 0 ? (x.swaps / x.years).toFixed(1) : '—')).join(' / ') + ' |';
    const yRows = (y: ReturnType<typeof yard>, l14: Array<{ finalTaxed: number; maxDrawdownPct: number }>, l14j: Array<{ finalTaxed: number; maxDrawdownPct: number }>): string[] => [
      '| **Hold ' + cfg.a + '** | ' + y.a.map(cell).join(' | ') + ' | — | ' + fall(y.a) + ' | — |', '| **Hold ' + cfg.b + '** | ' + y.b.map(cell).join(' | ') + ' | — | ' + fall(y.b) + ' | — |',
      '| **50/50, never rebalanced** | ' + y.ab.map(cell).join(' | ') + ' | — | ' + fall(y.ab) + ' | — |', '| **50/50, rebalanced yearly** | ' + y.aby.map(cell).join(' | ') + ' | — | ' + fall(y.aby) + ' | — |',
      '| **Hold QQQ** | ' + y.q.map(cell).join(' | ') + ' | — | ' + fall(y.q) + ' | — |',
      '| **' + LABELS.holdResearchCore + '** (whole period) | ' + l14.map(cell).join(' | ') + ' | — | ' + fall(l14) + ' | — |', '| **' + LABELS.holdResearchCore + ' (join when listed)** (whole period) | ' + l14j.map(cell).join(' | ') + ' | — | ' + fall(l14j) + ' | — |'];
    out.push('', '## ' + name, '', cfg.note);
    for (const cost of costs) {
      const y = yard(cost), bb = benchBy.get(cost)!;
      out.push('', '### ' + cost + ' bps per side' + (cost === H ? ' (headline)' : ''), '', ...head, ...yRows(y, bb.list, bb.listJoin), row('**James — Pair Rotation, pre-registered default** (Z, n 20, k 2, unconfirmed, cool-down 1, 100% swap)', runP(PAIR_DEFAULT_SETUP, cost), y));
    }
    if (cfg.ins == null) {
      const r = runP(PAIR_DEFAULT_SETUP, H)[2];
      if (r) out.push('', 'Default, 2024-2026: ' + r.swaps + ' swaps; ' + cfg.a + '-equivalent shares ' + (r.aEquivPct >= 0 ? '+' : '') + r.aEquivPct.toFixed(0) + '%, ' + cfg.b + '-equivalent ' + (r.bEquivPct >= 0 ? '+' : '') + r.bEquivPct.toFixed(0) + '%; Roth (0% tax) ' + pct(runPair(A, B, pers[2]!.start, pers[2]!.end, PAIR_DEFAULT_SETUP, H, 0).finalTaxed) + '.');
      continue;
    }
    // pass 1 and the sweep guard against 50/50 on the stated in-sample window
    const ins = cfg.ins;
    const yH = yard(H), fifty = yH.ab.map((x) => x?.finalTaxed ?? CASH);
    const p1 = pairPass1();
    const res = new Map(p1.map((s) => [s.setup.name, runP(s.setup, H)]));
    const fin = (r: Array<PairResult | null>): number[] => r.map((x) => x?.finalTaxed ?? CASH);
    const g = sweepGuard(p1.map((s) => ({ name: s.setup.name, knobs: s.knobs, finals: fin(res.get(s.setup.name)!) }) as SweepSetup), pairSetupName(PAIR_DEFAULT), fifty, { inSample: ins });
    out.push('', '### Pass 1 — 36 setups at ' + H + ' bps (signal x lookback x band x confirmed), sorted by ' + PERIODS[ins]!.name, '', ...head);
    for (const s of [...p1].sort((a, b) => fin(res.get(b.setup.name)!)[ins]! - fin(res.get(a.setup.name)!)[ins]!)) out.push(row(s.setup.name + (s.setup.name === pairSetupName(PAIR_DEFAULT) ? ' **(default)**' : ''), res.get(s.setup.name)!, yH));
    out.push('', '#### Sweep guard (T2, against 50/50), chosen on ' + PERIODS[ins]!.name + ' only', '',
      '- Pre-registered default: ' + g.defaultSetup.name + ' — ' + g.defaultSetup.finals.map(pct).join(' / '), '- Best in ' + PERIODS[ins]!.name + ': ' + g.picked.name + ' — ' + g.picked.finals.map(pct).join(' / '),
      '- Stable neighbourhood: ' + g.neighboursBeatingQqq + ' of ' + g.neighbours + ' one-step neighbours beat 50/50 in ' + PERIODS[ins]!.name + ' -> ' + (g.stable ? 'stable, the pick is used' : 'NOT stable, the pre-registered default is used'),
      '- **Chosen: ' + g.chosen.name + '**',
      ...g.periods.map((x, k) => (x && k > ins ? '- ' + PERIODS[k]!.name + ' (out-of-sample): the chosen setup is at the ' + x.percentile.toFixed(0) + 'th percentile of the sweep; ' + x.beatingQqqPct.toFixed(0) + '% of the 36 setups beat 50/50; median ' + pct(x.median) + ', interquartile ' + pct(x.q1) + ' to ' + pct(x.q3) : '')).filter(Boolean));
    let chosen = p1.find((s) => s.setup.name === g.chosen.name)!.setup;
    const base = res.get(chosen.name)!;
    out.push('', '#### Pass 2 — one knob at a time around the pass-1 choice (' + H + ' bps)', '', ...head, row(chosen.name + ' (pass-1 choice)', base, yH));
    let best: { s: PairSetup; r: Array<PairResult | null> } | null = null;
    for (const s of pairPass2(chosen)) { const r = runP(s, H); out.push(row(s.name, r, yH)); if (fin(r)[ins]! > (best ? fin(best.r)[ins]! : fin(base)[ins]!)) best = { s, r }; }
    if (best && fin(base)[ins]! > fifty[ins]!) { out.push('', 'Pass 2 adopts: **' + best.s.name + '**.'); chosen = best.s; } else out.push('', 'Pass 2 adopts nothing.');
    if (cfg.a === 'MSTR' && cfg.b === 'TSLA' && chosen.name !== PAIR_CHOSEN.name) out.push('', '> WARNING: this run chose ' + chosen.name + ', not PAIR_CHOSEN (' + PAIR_CHOSEN.name + '); update the constant, the report page and the paper account.');
    // the chosen setup in full
    out.push('', '#### The chosen setup: **' + chosen.name + '**', '', ...head);
    for (const c of costs) out.push(row('at ' + c + ' bps', runP(chosen, c), yard(c)));
    out.push(row('Roth (0% tax), ' + H + ' bps', runP(chosen, H, 0), yH));
    const hind = [...p1].sort((a, b) => fin(res.get(b.setup.name)!).reduce((x, y) => x + y, 0) - fin(res.get(a.setup.name)!).reduce((x, y) => x + y, 0))[0]!;
    out.push(row('picked with hindsight (never used): ' + hind.setup.name, res.get(hind.setup.name)!, yH));
    const ch = runP(chosen, H), roth = runP(chosen, H, 0), bb = benchBy.get(H)!;
    out.push('', '| Period | After tax | Roth (0% tax) | vs hold ' + cfg.a + ' | vs hold ' + cfg.b + ' | vs 50/50 | vs 📊 QQQ | vs 📊 ' + LABELS.list + ' (plain / join) | Deepest fall | Swaps / yr | Tax paid | ' + cfg.a + '-equiv. shares | ' + cfg.b + '-equiv. shares | Best QQQ days mostly in cash |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    const dpp = (a: number, b: number): string => { const x = (a - b) / 1000; return (x >= 0 ? '+' : '') + x.toFixed(0) + 'k'; };
    pers.forEach((p, k) => {
      const r = ch[k]; if (!r) return;
      const bd = bestDaysCheck(bestDays(qqq, p.start, p.end, bestDaysCount(p.start, p.end)), r.cashShareByDay);
      out.push('| ' + PERIODS[k]!.name + (k === ins ? ' (in-sample)' : k > ins ? ' (out-of-sample)' : ' (before; mechanics only)') + ' | ' + pct(r.finalTaxed) + ' | ' + pct(roth[k]!.finalTaxed) + ' | ' + dpp(r.finalTaxed, yH.a[k]!.finalTaxed) + ' | ' + dpp(r.finalTaxed, yH.b[k]!.finalTaxed) + ' | ' + dpp(r.finalTaxed, yH.ab[k]!.finalTaxed)
        + ' | ' + dpp(r.finalTaxed, yH.q[k]!.finalTaxed) + ' | ' + dpp(r.finalTaxed, bb.list[k]!.finalTaxed) + ' / ' + dpp(r.finalTaxed, bb.listJoin[k]!.finalTaxed) + ' | -' + r.maxDrawdownPct.toFixed(0) + '% | ' + (r.years ? (r.swaps / r.years).toFixed(1) : '—') + ' | $' + Math.round(r.taxPaid / 1000) + 'k | '
        + (r.aEquivPct >= 0 ? '+' : '') + r.aEquivPct.toFixed(0) + '% | ' + (r.bEquivPct >= 0 ? '+' : '') + r.bEquivPct.toFixed(0) + '% | ' + (bd ? bd.missed + ' of ' + bd.n : '—') + ' |');
    });
    // random-swap null
    const nulls = pers.map((p, k) => {
      const r = ch[k]; if (!r) return null;
      const dd = al.dates.filter((d) => d >= p.start && d <= p.end).slice(0, -1);
      return randomSignalNull(r.buysByTicker, () => dd, (sd) => runPair(A, B, p.start, p.end, chosen, H, undefined, sd.get('PAIR')).finalTaxed);
    });
    const later = pers.map((_, k) => k).filter((k) => k > ins && ch[k]);
    const nv = nullVerdict({ model: ch[ins]!.finalTaxed, nul: nulls[ins]! }, later.map((k) => ({ model: ch[k]!.finalTaxed, nul: nulls[k]! })));
    out.push('', '#### Random-swap null (100 seeds: the same number of swaps on random days, ' + H + ' bps)', '', '| Period | Model | Null median | Null 95th percentile |', '|---|---|---|---|',
      ...pers.map((p, k) => (nulls[k] ? '| ' + PERIODS[k]!.name + ' | ' + pct(ch[k]!.finalTaxed) + ' | ' + pct(nulls[k]!.median) + ' | ' + pct(nulls[k]!.p95) + ' |' : '')).filter(Boolean),
      '', 'Verdict: ' + (nv.beatsP95InSample ? 'beats' : 'does NOT beat') + ' the null\'s 95th percentile in ' + PERIODS[ins]!.name + '; above its median out-of-sample: ' + nv.aboveMedianOutOfSample.map((x, i) => PERIODS[later[i]!]!.name + ' ' + (x ? 'yes' : 'no')).join(', ') + ' -> **' + (nv.passes ? 'passes' : 'fails') + '**.');
    // the primary out-of-sample comparison for Holm: the share of null seeds at or above the model (the worst later period)
    const pOut = Math.max(...later.map((k) => (nulls[k]!.values.filter((v) => v >= ch[k]!.finalTaxed).length + 1) / (nulls[k]!.values.length + 1)));
    const other = later.every((k) => ch[k]!.finalTaxed > yH.ab[k]!.finalTaxed) && nv.passes && g.stable;
    primaryP.push({ pair: name, p: pOut, passesOther: other });
    // round trips (MSTR / TSLA), split check
    if (cfg.a === 'MSTR' && cfg.b === 'TSLA') {
      for (const k of [1, 2]) {
        const r = ch[k]!;
        out.push('', '#### Round trips back into the starting leg, ' + PERIODS[k]!.name + ' (' + r.swaps + ' swaps; starting leg ' + (r.swapsList.length ? (r.swapsList[0]!.into === cfg.a ? cfg.b : cfg.a) : '—') + ')', '', '| Out on | Into | R1 (A/B at the swap out) | R2 (swap back) | Share gain | Worst fall of the leg held |', '|---|---|---|---|---|---|',
          ...r.roundTrips.map((t) => '| ' + t.from + ' | ' + t.out + ' | ' + t.R1.toFixed(3) + ' | ' + t.R2.toFixed(3) + ' | ' + (t.shareGain >= 0 ? '+' : '') + (t.shareGain * 100).toFixed(1) + '% | ' + (t.worst * 100).toFixed(0) + '% |'));
        if (!r.roundTrips.length) out.push('| — | — | — | — | — | — |');
      }
      const lr = al.dates.map((_, j) => Math.log((A.closes[al.ia[j]!] as number) / (B.closes[al.ib[j]!] as number)));
      const moves = lr.slice(1).map((x, j) => Math.abs(x - lr[j]!)), p99 = quantile(moves, 0.99);
      out.push('', '**Split check** (|daily move of ln R| on the split days vs its 99th percentile ' + p99.toFixed(3) + '): ' + ['2020-08-31', '2022-08-25', '2024-08-08'].map((d) => { const j = al.dates.indexOf(d); return d + ' ' + (j > 0 ? moves[j - 1]!.toFixed(3) : '—'); }).join(', ') + ' — ' + (['2020-08-31', '2022-08-25', '2024-08-08'].every((d) => { const j = al.dates.indexOf(d); return j > 0 && moves[j - 1]! < p99; }) ? 'no jump.' : 'CHECK.'));
    }
  }
  const adj = holm(primaryP.map((x) => x.p));
  out.push('', '## Across the pairs: Holm correction (one primary out-of-sample test per pair)', '', 'p = the share of the random-swap null at or above the chosen setup in its out-of-sample period (the larger of the two for NVDA/AMD and MU/MRVL). A pair passes only if its Holm-adjusted p < 0.05 AND it beat 50/50 in every later period, passed the null and its neighbourhood was stable.', '',
    '| Pair | p | Holm-adjusted p | Other conditions | Passes |', '|---|---|---|---|---|', ...primaryP.map((x, i) => '| ' + x.pair + ' | ' + x.p.toFixed(3) + ' | ' + adj[i]!.toFixed(3) + ' | ' + (x.passesOther ? 'yes' : 'no') + ' | ' + (adj[i]! < 0.05 && x.passesOther ? '**yes**' : 'no') + ' |'),
    '', 'With ' + primaryP.length + ' pairs at a 5% level, about ' + (primaryP.length * 0.05).toFixed(1) + ' would pass by chance alone before the correction.');
  process.stdout.write(out.join('\n') + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
