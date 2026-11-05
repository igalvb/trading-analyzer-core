/**
 * `node src/research/trendCombosCli.ts <priceDir> <readsDir> [htmlOut]` (owner 2026-10-30): three new research combos,
 * fixed rules written down before the run (no tuning), each with the same slots and sell as Combo 2/3 (3 stocks,
 * sell when the stock's 200-day trend breaks, ranked by distance above the 200-day average, idle money in QQQ):
 *   A "2 of 4": buy when at least 2 of Turtle, Schabacker, E&M, Trend 200 read bullish.
 *   B "Combo + trend filter": Combo 2/3's buy AND the close above a rising 200-day average (Trend 200 bullish).
 *   C "Trend 200 + 1 confirm": Trend 200 bullish AND at least 1 of Turtle / Schabacker / E&M bullish.
 * Same windows, yardsticks, tax and costs as `windowsCli.ts --grid`. Only the buy signal changes (via the lab's
 * `buyDays` option); Combo 2/3 and Trend 200 are rerun the same way and checked against the stock runs.
 * Prints markdown (docs/models/results/trend-combos.md); writes the HTML table for the PNG when htmlOut is given.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadSeries, type PriceSeries } from '../backtest/data.ts';
import { runPortfolio, holdBag, type PortfolioInput, type PortfolioOptions } from './portfolioLab.ts';
import { OWNER_BAG } from './portfolioCli.ts';
import { holdCurve } from './benchmarks.ts';
import { CASH } from './liloV2Cli.ts';
import { quantile } from './guards.ts';
import { trendSeries } from '../analysis/models/trendFollow.ts';
import { windows, MODEL_FIRST_START } from './windowsCli.ts';
import type { CompactRead } from './computeReads.ts';
import { LABELS } from '../profile/labels.ts';

const COST = 10;
const BASE: PortfolioOptions = { slots: 3, cash: CASH, costBps: COST, exit: 'trend', trendDays: 200 };
const DIR = { schabacker: 2, edwardsMagee: 3, turtle: 4 } as const;
type Out = { readonly finalTaxed: number; readonly maxDrawdownPct: number };
const pp = (v: number): string => (v >= 0 ? '+' : '') + v.toFixed(0) + '%';
const pp1 = (v: number): string => (v >= 0 ? '+' : '') + v.toFixed(1) + ' pts';
const ret = (o: Out): number => (o.finalTaxed / CASH - 1) * 100;

function main(): void {
  const [priceDir, readsDir, htmlOut] = process.argv.slice(2) as [string, string, string | undefined];
  const series = new Map<string, PriceSeries>(), reads = new Map<string, Map<string, CompactRead>>();
  for (const t of OWNER_BAG) {
    const f = path.join(readsDir, t + '.reads.json');
    if (!fs.existsSync(f)) continue;
    series.set(t, loadSeries(t, priceDir));
    reads.set(t, new Map((JSON.parse(fs.readFileSync(f, 'utf8')) as CompactRead[]).map((r) => [r.d, r])));
  }
  const bag = OWNER_BAG.filter((t) => series.has(t));
  const inp: PortfolioInput = { series, reads, qqq: loadSeries('QQQ', priceDir) };

  // the buy days of each rule, per stock (decided at the close)
  type Rule = (b: { turtle: boolean; schab: boolean; em: boolean; t200: boolean }) => boolean;
  const rules: Record<string, Rule> = {
    combo: (b) => [b.turtle, b.schab, b.em].filter(Boolean).length >= 2,
    trend200: (b) => b.t200,
    A: (b) => [b.turtle, b.schab, b.em, b.t200].filter(Boolean).length >= 2,
    B: (b) => [b.turtle, b.schab, b.em].filter(Boolean).length >= 2 && b.t200,
    C: (b) => b.t200 && (b.turtle || b.schab || b.em),
  };
  const buyDays: Record<string, Map<string, Set<string>>> = {};
  for (const k of Object.keys(rules)) buyDays[k] = new Map(bag.map((t) => [t, new Set<string>()]));
  for (const t of bag) {
    const s = series.get(t)!, tr = trendSeries(s.closes, 200), rd = reads.get(t)!;
    s.dates.forEach((d, i) => {
      const r = rd.get(d);
      const b = { turtle: r?.dir[DIR.turtle] === 'b', schab: r?.dir[DIR.schabacker] === 'b', em: r?.dir[DIR.edwardsMagee] === 'b', t200: tr[i]!.direction === 'bullish' };
      for (const [k, f] of Object.entries(rules)) if (f(b)) buyDays[k]!.get(t)!.add(d);
    });
  }

  const cols = [
    { short: 'Combo 2/3', key: 'combo' }, { short: 'Trend 200', key: 'trend200' },
    { short: 'A: 2 of 4', key: 'A' }, { short: 'B: Combo + trend', key: 'B' }, { short: 'C: Trend 200 + 1', key: 'C' },
  ] as const;
  const lastDay = inp.qqq.dates[inp.qqq.dates.length - 1] as string, lastYear = Number(lastDay.slice(0, 4));
  const ws = [...windows(2007, lastYear, [1, 2, 4]), ...windows(2007, 2009, [3])];
  const bagSeries = bag.map((t) => series.get(t)!);
  let checked = 0;
  const rows = ws.map((w) => {
    const days = inp.qqq.dates.filter((d) => d >= w.start && d <= w.end);
    const q = holdCurve([inp.qqq], days, CASH, { costBps: COST });
    const l = { ...holdCurve(bagSeries, days, CASH, { costBps: COST }), finalTaxed: holdBag(bag, inp, w.start, w.end, CASH, COST) };
    const j = holdCurve(bagSeries, days, CASH, { costBps: COST, join: true });
    const i0 = inp.qqq.dates.indexOf(days[0]!), i1 = inp.qqq.dates.indexOf(days[days.length - 1]!);
    const qRaw = ((inp.qqq.closes[i1] as number) / (inp.qqq.opens[i0] as number) - 1) * 100;
    const run = w.start >= MODEL_FIRST_START;
    const res = cols.map((c) => (run ? runPortfolio('combo', bag, inp, w.start, w.end, { ...BASE, buyDays: buyDays[c.key] }) : null));
    if (run) {
      // the rebuilt Combo 2/3 and Trend 200 must match the lab's own runs exactly
      const ref = [runPortfolio('combo', bag, inp, w.start, w.end, BASE), runPortfolio('trend', bag, inp, w.start, w.end, { slots: 3, cash: CASH, costBps: COST, trendDays: 200 })];
      ref.forEach((r, k) => { if (Math.abs(r.finalTaxed - res[k]!.finalTaxed) > 0.01) throw new Error(w.name + ' ' + cols[k]!.short + ' mismatch ' + r.finalTaxed + ' vs ' + res[k]!.finalTaxed); });
      checked += 2;
    }
    process.stderr.write(w.name + '\n');
    const partial = w.end > lastDay;
    return { w, q, l, j, qRaw, label: qRaw > 15 ? 'good' : qRaw < 0 ? 'bad' : 'flat', res, partial, lastDay: days[days.length - 1]! };
  });
  type Row = (typeof rows)[number];
  const beats = (r: Row, o: Out): boolean => o.finalTaxed > r.q.finalTaxed && o.finalTaxed > r.l.finalTaxed && o.finalTaxed > r.j.finalTaxed;
  const name = (r: Row): string => r.w.name + (r.partial ? ' (to ' + r.lastDay.slice(5) + ')' : '') + (r.w.years === 1 ? ' — ' + r.label + ' (QQQ ' + pp(r.qRaw) + ')' : '');
  const y14 = (r: Row): string => pp(ret(r.l)) + (Math.round(ret(r.j)) !== Math.round(ret(r.l)) ? ' (join ' + pp(ret(r.j)) + ')' : '');
  const groups = [{ title: '1-year windows', ys: [1] }, { title: '2-year windows', ys: [2] }, { title: '3- and 4-year windows', ys: [3, 4] }];
  const dd = (xs: Array<Out | null>): string => { const v = xs.filter((x): x is Out => !!x); return v.length ? '-' + Math.max(...v.map((x) => x.maxDrawdownPct)).toFixed(0) + '%' : 'no data'; };

  const out: string[] = [
    '# Three trend combos on every window, 2007 to 2026 (to date)', '',
    'Owner 2026-10-30: three new research combos with fixed rules, written down before the run (no tuning). Each one holds up to 3 stocks, sells a stock when its 200-day trend breaks (close more than 3% under the 200-day average), ranks buy candidates by how far above the 200-day average they are, and keeps idle money in QQQ: the same slots, sell and idle rule as Combo 2/3. Only the buy rule differs:', '',
    '- **A, "2 of 4"**: buy when at least 2 of Turtle, Schabacker, Edwards & Magee and Trend 200 read bullish.',
    '- **B, "Combo + trend filter"**: Combo 2/3 reads bullish (2 of Turtle / Schabacker / E&M) AND the close is above a rising 200-day average (that is Trend 200 bullish: above the average, and the average higher than 20 days ago).',
    '- **C, "Trend 200 + 1 confirm"**: Trend 200 bullish AND at least 1 of Turtle / Schabacker / E&M bullish.', '',
    'Same windows and rules as windows-2007-2026.md: every calendar year 2007-2026 (2026 to ' + lastDay + '), every 2-year window, the 3-year window 2007-09 and every 4-year window; $100,000 at the start of each window, decide at the close and fill at the next open, 25% tax on every sale\'s gain and on what is still held at the end, 10 bps per side. Models need ~200 trading days of history, so windows starting in 2007 are "no data". Production models are unchanged; the combos are research only.', '',
    '**Check:** Combo 2/3 and Trend 200 were rebuilt the same way (only their buy days passed in) and match the lab\'s own runs to the cent in all ' + (checked / 2) + ' windows they run, so the columns are like for like with windows-2007-2026.md. Rerun: `node src/research/trendCombosCli.ts <priceDir> <readsDir>`.', '',
    '**Cells:** return after tax. **✅** = beat 📊 Hold QQQ AND both versions of 📊 ' + LABELS.holdList + ' (plain, and join when listed) in that window. **Deepest fall** = largest fall from a high (before tax) in any window of the table.', '',
    '## All windows', '',
    '| Window | QQQ | ' + LABELS.List + ' | ' + cols.map((c) => c.short).join(' | ') + ' |', '|---|---|---|' + cols.map(() => '---|').join(''),
  ];
  for (const g of groups) {
    out.push('| **' + g.title + '** |' + ' |'.repeat(2 + cols.length));
    for (const r of rows.filter((x) => g.ys.includes(x.w.years)).sort((a, b) => a.w.years - b.w.years))
      out.push('| ' + name(r) + ' | ' + pp(ret(r.q)) + ' | ' + y14(r) + ' | ' + r.res.map((o) => (o ? (beats(r, o) ? '✅ ' : '') + pp(ret(o)) : 'no data')).join(' | ') + ' |');
  }
  out.push('| Deepest fall | ' + dd(rows.map((r) => r.q)) + ' | ' + dd(rows.map((r) => r.l)) + ' | ' + cols.map((_, ci) => dd(rows.map((r) => r.res[ci]!))).join(' | ') + ' |');

  // head-to-head
  const runnable = rows.filter((r) => r.res[0]);
  const n = runnable.length;
  out.push('', '## Head to head', '', 'Over the ' + n + ' windows the models can run (19 one-year, 18 two-year, 16 four-year; the 2007-start windows have no data). "Beats" = higher return after tax in that window; a tie (2020: all five made +226%) is not a win. Excess = combo return minus the other\'s return, in percentage points of the starting $100,000 (after tax).', '',
    '| Combo | Beats Combo 2/3 | Beats Trend 200 | Beats both yardsticks (✅) | Median excess vs Combo 2/3 | Median excess vs Trend 200 | Deepest fall |', '|---|---|---|---|---|---|---|');
  out.push('| Combo 2/3 (reference) | — | ' + runnable.filter((r) => r.res[0]!.finalTaxed > r.res[1]!.finalTaxed).length + '/' + n + ' | ' + runnable.filter((r) => beats(r, r.res[0]!)).length + '/' + n + ' | — | ' + pp1(quantile(runnable.map((r) => ret(r.res[0]!) - ret(r.res[1]!)), 0.5)) + ' | ' + dd(rows.map((r) => r.res[0]!)) + ' |');
  out.push('| Trend 200 (reference) | ' + runnable.filter((r) => r.res[1]!.finalTaxed > r.res[0]!.finalTaxed).length + '/' + n + ' | — | ' + runnable.filter((r) => beats(r, r.res[1]!)).length + '/' + n + ' | ' + pp1(quantile(runnable.map((r) => ret(r.res[1]!) - ret(r.res[0]!)), 0.5)) + ' | — | ' + dd(rows.map((r) => r.res[1]!)) + ' |');
  const verdicts: string[] = [];
  for (const ci of [2, 3, 4]) {
    const vs = (k: number): { wins: number; med: number } => ({ wins: runnable.filter((r) => r.res[ci]!.finalTaxed > r.res[k]!.finalTaxed).length, med: quantile(runnable.map((r) => ret(r.res[ci]!) - ret(r.res[k]!)), 0.5) });
    const c2 = vs(0), t2 = vs(1);
    out.push('| ' + cols[ci]!.short + ' | ' + c2.wins + '/' + n + ' | ' + t2.wins + '/' + n + ' | ' + runnable.filter((r) => beats(r, r.res[ci]!)).length + '/' + n + ' | ' + pp1(c2.med) + ' | ' + pp1(t2.med) + ' | ' + dd(rows.map((r) => r.res[ci]!)) + ' |');
    const yes = (x: { wins: number; med: number }): string => (x.wins > n / 2 && x.med > 0 ? 'yes' : 'no');
    verdicts.push('- **' + cols[ci]!.short + '**: beats Combo 2/3: ' + yes(c2) + '; beats Trend 200: ' + yes(t2));
  }
  out.push('', 'Yes = wins more than half the windows AND a higher median (median excess above 0).', '', ...verdicts);
  process.stdout.write(out.join('\n') + '\n');

  if (htmlOut) {
    const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const cell = (r: Row, o: Out | null): string => (o ? '<td class="' + (beats(r, o) ? 'win' : '') + '">' + (beats(r, o) ? '✅ ' : '') + pp(ret(o)) + '</td>' : '<td class="na">—</td>');
    const ncol = 3 + cols.length;
    const h: string[] = ['<!doctype html><meta charset="utf-8"><style>',
      'body{font-family:Arial,sans-serif;background:#fff;margin:16px}h2{margin:0 0 6px}p{margin:0 0 10px;color:#444;font-size:13px}',
      'table{border-collapse:collapse;font-size:12px}td,th{border:1px solid #ccc;padding:3px 6px;text-align:right;white-space:nowrap}',
      'thead th{background:#263238;color:#fff}tbody th{text-align:left;background:#f5f5f5}',
      '.win{background:#c8e6c9;font-weight:bold;color:#1b5e20}.na{color:#aaa;text-align:center}.yard{background:#e3f2fd;font-weight:bold}',
      'tr.grp td{background:#455a64;color:#fff;text-align:left;font-weight:bold}tr.dd th,tr.dd td{border-top:2px solid #263238;font-weight:bold}</style>',
      '<h2>Three trend combos vs Combo 2/3, Trend 200, QQQ and ' + LABELS.list + ' — 2007–2026</h2>',
      '<p>$100k per window, after 25% tax and trading costs. <b style="background:#c8e6c9;color:#1b5e20">Green ✅</b> = beat both QQQ and ' + LABELS.list + '. — = no data (prices start 2007). A = 2 of 4 (Turtle, Schabacker, E&amp;M, Trend 200); B = Combo 2/3 + close above a rising 200-day average; C = Trend 200 + 1 of Turtle/Schabacker/E&amp;M.</p>',
      '<table><thead><tr><th>Window</th><th>QQQ</th><th>' + LABELS.List + '</th>' + cols.map((c) => '<th>' + esc(c.short) + '</th>').join('') + '</tr></thead><tbody>'];
    for (const g of groups) {
      h.push('<tr class="grp"><td colspan="' + ncol + '">' + g.title + '</td></tr>');
      for (const r of rows.filter((x) => g.ys.includes(x.w.years)).sort((a, b) => a.w.years - b.w.years))
        h.push('<tr><th>' + esc(r.w.name + (r.partial ? ' (to ' + r.lastDay.slice(5) + ')' : '')) + '</th><td class="yard">' + pp(ret(r.q)) + '</td><td class="yard">' + pp(ret(r.l)) + '</td>' + r.res.map((o) => cell(r, o)).join('') + '</tr>');
    }
    h.push('<tr class="dd"><th>Deepest fall</th><td class="yard">' + dd(rows.map((r) => r.q)) + '</td><td class="yard">' + dd(rows.map((r) => r.l)) + '</td>' + cols.map((_, ci) => '<td>' + dd(rows.map((r) => r.res[ci]!)) + '</td>').join('') + '</tr>');
    h.push('</tbody></table>');
    fs.writeFileSync(htmlOut, h.join(''));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
