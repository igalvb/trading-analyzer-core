/**
 * `node src/research/deepFallsCli.ts <priceDir> <readsDir>` (row 42, "cut the deep falls on the stock side"): the
 * pre-registered fall-cutting overlays of docs/models/results/deep-falls.md (research/fallOverlay.ts) on Combo 2/3 and
 * Trend 200. Per host and overlay, the setting is chosen on 2010-2019 only (highest Calmar), then judged out of sample
 * (2020-2023, 2024-2026) by the pass rule, and run on every 1-, 2- and 4-year window 2008-2026 like
 * windows-2007-2026.md. $100,000, the profile tax (EXIT_TAX_RATE), 10 bps per side. Prints the markdown of section 2.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadSeries, type PriceSeries } from '../backtest/data.ts';
import { PERIODS } from './lab.ts';
import { runPortfolio, holdBag, type PortfolioInput, type PortfolioModel, type PortfolioOptions, type PortfolioResult } from './portfolioLab.ts';
import { OWNER_BAG } from './portfolioCli.ts';
import { LABELS } from '../profile/labels.ts';
import { benchmarksFor, holdCurve, type Bench } from './benchmarks.ts';
import { windows, MODEL_FIRST_START } from './windowsCli.ts';
import { FALL_CANDIDATES, chooseByCalmar, passRule, type FallOverlay } from './fallOverlay.ts';
import type { CompactRead } from './computeReads.ts';

const CASH = 100_000;
const COST = 10;

export interface DfHost { readonly key: 'combo' | 'trend200'; readonly short: string; readonly m: PortfolioModel; readonly o: Partial<PortfolioOptions> }
export const DF_HOSTS: readonly DfHost[] = [
  { key: 'combo', short: 'Combo 2/3', m: 'combo', o: { slots: 3, exit: 'trend', trendDays: 200 } },
  { key: 'trend200', short: 'Trend 200', m: 'trend', o: { slots: 3, trendDays: 200 } },
];

export function runHost(h: DfHost, bag: readonly string[], inp: PortfolioInput, start: string, end: string, ov?: FallOverlay): PortfolioResult {
  return runPortfolio(h.m, bag, inp, start, end, { slots: 3, cash: CASH, costBps: COST, ...h.o, ...(ov ? { fallOverlay: ov } : {}) });
}

const pp = (v: number): string => (v >= 0 ? '+' : '') + v.toFixed(0) + '%';
const ret = (x: { finalTaxed: number }): number => (x.finalTaxed / CASH - 1) * 100;
const fall = (xs: ReadonlyArray<{ maxDrawdownPct: number }>): number => Math.max(...xs.map((x) => x.maxDrawdownPct));
const fl = (v: number): string => '-' + v.toFixed(0) + '%';
const yes = (b: boolean): string => (b ? 'yes' : 'no');

function main(): void {
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
  const b = benchmarksFor(bag, inp, CASH, { costBps: COST });
  const yardMax = PERIODS.map((_, k) => Math.max(b.qqq[k]!.finalTaxed, b.list[k]!.finalTaxed, b.listJoin[k]!.finalTaxed));
  const yrs = (Date.parse(PERIODS[0]!.end) - Date.parse(PERIODS[0]!.start)) / (365.25 * 864e5);
  const calmar = (r: PortfolioResult): number => ((r.finalTaxed / CASH) ** (1 / yrs) - 1) * 100 / r.maxDrawdownPct;
  const yardRows = (cols: number): string[] => [
    ['📊 Hold QQQ', b.qqq], ['📊 ' + LABELS.holdList, b.list], ['📊 ' + LABELS.holdList + ' (join when listed)', b.listJoin],
  ].map(([n, x]) => '| ' + n + ' | ' + (x as Bench[]).map((y) => pp(ret(y))).join(' | ') + ' | ' + fl(fall(x as Bench[])) + ' |' + ' — |'.repeat(cols));

  const out: string[] = [];
  interface Chosen { host: DfHost; name: string; ov: FallOverlay; r: PortfolioResult[] }
  const chosen: Chosen[] = [];
  const hostRuns = new Map<string, PortfolioResult[]>();
  const all: Array<{ host: DfHost; name: string; family: string; r: PortfolioResult[]; chosen: boolean }> = [];
  for (const h of DF_HOSTS) {
    hostRuns.set(h.key, PERIODS.map((p) => runHost(h, bag, inp, p.start, p.end)));
    for (const fam of ['MKT', 'DD', 'VOL', 'CAP', 'ATR'] as const) {
      const cs = FALL_CANDIDATES.filter((c) => c.family === fam);
      const runs = cs.map((c) => PERIODS.map((p) => runHost(h, bag, inp, p.start, p.end, c.ov)));
      const pick = chooseByCalmar(runs.map((r) => r[0]!), CASH, yrs);
      cs.forEach((c, i) => all.push({ host: h, name: c.name, family: fam, r: runs[i]!, chosen: i === pick }));
      chosen.push({ host: h, name: cs[pick]!.name, ov: cs[pick]!.ov, r: runs[pick]! });
    }
    process.stderr.write(h.short + ' done\n');
  }

  // ── (a) the choice, 2010-2019 only ──
  out.push('### 2a. The choice on 2010-2019 (in-sample only)', '', 'Calmar = growth a year after tax / deepest fall, 2010-2019. **Bold** = chosen (highest Calmar per host and overlay).', '',
    '| Host | Setting | 2010-2019 | Deepest fall 2010-2019 | Calmar | Book scaled (share of days) | Rescales / stops / trims |', '|---|---|---|---|---|---|---|',
    ...[['📊 Hold QQQ', b.qqq[0]!], ['📊 ' + LABELS.holdList, b.list[0]!], ['📊 ' + LABELS.holdList + ' (join when listed)', b.listJoin[0]!]].map(([n, x]) => { const y = x as Bench; return '| ' + n + ' | — | ' + pp(ret(y)) + ' | ' + fl(y.maxDrawdownPct) + ' | ' + (((y.finalTaxed / CASH) ** (1 / yrs) - 1) * 100 / y.maxDrawdownPct).toFixed(3) + ' | — | — |'; }));
  for (const h of DF_HOSTS) {
    const hr = hostRuns.get(h.key)![0]!;
    out.push('| ' + h.short + ' | none (host) | ' + pp(ret(hr)) + ' | ' + fl(hr.maxDrawdownPct) + ' | ' + calmar(hr).toFixed(3) + ' | — | — |');
    for (const a of all.filter((x) => x.host === h)) {
      const r = a.r[0]!, s = r.fallStats!, nm = a.chosen ? '**' + a.name + '**' : a.name;
      out.push('| ' + h.short + ' | ' + nm + ' | ' + pp(ret(r)) + ' | ' + fl(r.maxDrawdownPct) + ' | ' + calmar(r).toFixed(3) + ' | ' + s.scaledDaysPct.toFixed(0) + '% | ' + s.rescales + ' / ' + s.stops + ' / ' + s.trims + ' |');
    }
  }

  // ── (b) the chosen candidates out of sample, the pass rule ──
  out.push('', '### 2b. The chosen candidates out of sample, and the pass rule', '',
    'Deepest fall = the largest of the three periods. Pass: (1) fall at least 15 points shallower than the host, (2) each out-of-sample return at least 90% of the host\'s, (3) above Hold QQQ and both ' + LABELS.holdList + ' in 2020-2023 and 2024-2026.', '',
    '| Row | 2010-2019 (in-sample) | 2020-2023 | 2024-2026 | Deepest fall | (1) 15 pts shallower | (2) return kept | (3) beats yardsticks | **Pass** |', '|---|---|---|---|---|---|---|---|---|',
    ...yardRows(4));
  const verdicts: Array<{ name: string; pass: boolean }> = [];
  for (const h of DF_HOSTS) {
    const hr = hostRuns.get(h.key)!;
    const hostBeats = [1, 2].every((k) => hr[k]!.finalTaxed > yardMax[k]!);
    out.push('| **' + h.short + '** (host) | ' + hr.map((x) => pp(ret(x))).join(' | ') + ' | ' + fl(fall(hr)) + ' | — | — | ' + yes(hostBeats) + ' | — |');
    for (const c of chosen.filter((x) => x.host === h)) {
      const v = passRule({ cand: { finals: c.r.map((x) => x.finalTaxed), fall: fall(c.r) }, host: { finals: hr.map((x) => x.finalTaxed), fall: fall(hr) }, yardMax, cash: CASH });
      verdicts.push({ name: h.short + ' + ' + c.name, pass: v.pass });
      out.push('| ' + h.short + ' + ' + c.name + ' | ' + c.r.map((x) => pp(ret(x))).join(' | ') + ' | ' + fl(fall(c.r)) + ' | ' + yes(v.shallower) + ' | ' + yes(v.kept) + ' | ' + yes(v.beats) + ' | **' + (v.pass ? 'PASS' : 'no') + '** |');
    }
  }

  // ── (c) every candidate on all three periods (for the overfitting check; the choice did not see 2020-2026) ──
  out.push('', '### 2c. All 30 runs on the three periods (not used for the choice)', '',
    '| Host | Setting | 2010-2019 | 2020-2023 | 2024-2026 | Deepest fall | Fall per period |', '|---|---|---|---|---|---|---|',
    ...[['📊 Hold QQQ', b.qqq], ['📊 ' + LABELS.holdList, b.list], ['📊 ' + LABELS.holdList + ' (join when listed)', b.listJoin]].map(([n, x]) => '| ' + n + ' | — | ' + (x as Bench[]).map((y) => pp(ret(y))).join(' | ') + ' | ' + fl(fall(x as Bench[])) + ' | ' + (x as Bench[]).map((y) => fl(y.maxDrawdownPct)).join(' / ') + ' |'));
  for (const h of DF_HOSTS) {
    const hr = hostRuns.get(h.key)!;
    out.push('| ' + h.short + ' | none (host) | ' + hr.map((x) => pp(ret(x))).join(' | ') + ' | ' + fl(fall(hr)) + ' | ' + hr.map((x) => fl(x.maxDrawdownPct)).join(' / ') + ' |');
    for (const a of all.filter((x) => x.host === h)) out.push('| ' + h.short + ' | ' + (a.chosen ? '**' + a.name + '**' : a.name) + ' | ' + a.r.map((x) => pp(ret(x))).join(' | ') + ' | ' + fl(fall(a.r)) + ' | ' + a.r.map((x) => fl(x.maxDrawdownPct)).join(' / ') + ' |');
  }

  // ── (d) the windows grid ──
  const lastDay = inp.qqq.dates[inp.qqq.dates.length - 1] as string, lastYear = Number(lastDay.slice(0, 4));
  const ws = windows(2008, lastYear, [1, 2, 4]).filter((w) => w.start >= MODEL_FIRST_START);
  const bagSeries = bag.map((t) => series.get(t)!);
  const cols: Array<{ short: string; run: (s: string, e: string) => PortfolioResult }> = [];
  for (const h of DF_HOSTS) {
    cols.push({ short: h.short, run: (s, e) => runHost(h, bag, inp, s, e) });
    for (const c of chosen.filter((x) => x.host === h)) cols.push({ short: h.short + ' + ' + c.name, run: (s, e) => runHost(h, bag, inp, s, e, c.ov) });
  }
  const rows = ws.map((w) => {
    const days = inp.qqq.dates.filter((d) => d >= w.start && d <= w.end);
    const q = holdCurve([inp.qqq], days, CASH, { costBps: COST });
    const l = { ...holdCurve(bagSeries, days, CASH, { costBps: COST }), finalTaxed: holdBag(bag, inp, w.start, w.end, CASH, COST) };
    const j = holdCurve(bagSeries, days, CASH, { costBps: COST, join: true });
    return { w, q, l, j, res: cols.map((c) => c.run(w.start, w.end)) };
  });
  const beats = (r: (typeof rows)[number], o: { finalTaxed: number }): boolean => o.finalTaxed > r.q.finalTaxed && o.finalTaxed > r.l.finalTaxed && o.finalTaxed > r.j.finalTaxed;
  const lens = [1, 2, 4];
  out.push('', '### 2d. Every 1-, 2- and 4-year window, 2008-2026 (as windows-2007-2026.md)', '',
    '✅ = above Hold QQQ AND both ' + LABELS.holdList + ' versions in that window. Deepest fall = the largest fall in any window of that length (windows from 2008 only, so Hold QQQ shows -49%, not the -54% of the 2007-start windows).', '',
    '| Row | ✅ 1-yr | ✅ 2-yr | ✅ 4-yr | Deepest fall 1-yr | 2-yr | 4-yr |', '|---|---|---|---|---|---|---|');
  const ddOf = (n: number, get: (r: (typeof rows)[number]) => { maxDrawdownPct: number }): string => fl(Math.max(...rows.filter((r) => r.w.years === n).map((r) => get(r).maxDrawdownPct)));
  out.push('| 📊 Hold QQQ | — | — | — | ' + lens.map((n) => ddOf(n, (r) => r.q)).join(' | ') + ' |');
  out.push('| 📊 ' + LABELS.holdList + ' | — | — | — | ' + lens.map((n) => ddOf(n, (r) => r.l)).join(' | ') + ' |');
  out.push('| 📊 ' + LABELS.holdList + ' (join when listed) | — | — | — | ' + lens.map((n) => ddOf(n, (r) => r.j)).join(' | ') + ' |');
  cols.forEach((c, ci) => out.push('| ' + c.short + ' | ' + lens.map((n) => { const rs = rows.filter((r) => r.w.years === n); return rs.filter((r) => beats(r, r.res[ci]!)).length + '/' + rs.length; }).join(' | ')
    + ' | ' + lens.map((n) => ddOf(n, (r) => r.res[ci]!)).join(' | ') + ' |'));
  for (const n of lens) {
    const rs = rows.filter((r) => r.w.years === n);
    out.push('', '#### ' + n + '-year windows', '', '| Window | QQQ | ' + LABELS.List + ' | ' + cols.map((c) => c.short).join(' | ') + ' |', '|---|---|---|' + cols.map(() => '---|').join(''));
    for (const r of rs) {
      const y14 = pp(ret(r.l)) + (Math.round(ret(r.j)) !== Math.round(ret(r.l)) ? ' (join ' + pp(ret(r.j)) + ')' : '');
      out.push('| ' + r.w.name + (r.w.end > lastDay ? ' (to ' + lastDay.slice(5) + ')' : '') + ' | ' + pp(ret(r.q)) + ' | ' + y14 + ' | ' + r.res.map((o) => (beats(r, o) ? '✅ ' : '') + pp(ret(o))).join(' | ') + ' |');
    }
    out.push('| Deepest fall | ' + fl(Math.max(...rs.map((r) => r.q.maxDrawdownPct))) + ' | ' + fl(Math.max(...rs.map((r) => r.l.maxDrawdownPct))) + ' | ' + cols.map((_, ci) => fl(Math.max(...rs.map((r) => r.res[ci]!.maxDrawdownPct)))).join(' | ') + ' |');
  }
  out.push('', '**Passed:** ' + (verdicts.filter((v) => v.pass).map((v) => v.name).join(', ') || 'none') + '.');
  process.stdout.write(out.join('\n') + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
