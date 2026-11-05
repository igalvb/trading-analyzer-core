/**
 * `node src/research/portfolioCli.ts <priceDir> <readsDir> [bags=20] [slots=5]`: the portfolio lab over the owner's
 * bag and random bags of 12, three periods, vs holding QQQ and holding the bag equally (after the 25% tax).
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadSeries, type PriceSeries } from '../backtest/data.ts';
import { PERIODS, holdLab } from './lab.ts';
import { PORTFOLIO_MODELS, runPortfolio, holdBag, type PortfolioInput } from './portfolioLab.ts';
import type { CompactRead } from './computeReads.ts';
import { mulberry32 } from './guards.ts';
import { JAMES_EXTRA_TICKERS, MACRO_EXTRA_TICKERS } from './fetchPrices.ts';
import { activeProfile } from '../profile/active.ts';

const CASH = 100_000;
const LABEL: Record<string, string> = { engine: 'Engine alone', current: 'Engine + models (current)', schabacker: 'Schabacker', edwardsMagee: 'Edwards & Magee', broker: 'Broker Course', turtle: 'Turtle', wyckoff: 'Wyckoff', trend: 'Trend (150-day)', combo: 'Turtle + Schabacker + E&M (2 of 3)', best: 'Engine OR combo buys' };
const SCENARIO: Record<string, { label: string; opts: { exit?: 'model' | 'trend'; rebalanceDays?: number; marketFilter?: 'off' | 'noBuys' | 'exitAll'; confirmTrend?: boolean } }> = {
  base: { label: 'each model sells on its own rule', opts: {} },
  sellLess: { label: 'SELL LESS: a holding is sold only when its 150-day trend breaks', opts: { exit: 'trend' } },
  mktNoBuys: { label: 'SELL LESS + MARKET FILTER: no new stocks and spare money in cash (not QQQ) while QQQ is 3% under its 150-day average', opts: { exit: 'trend', marketFilter: 'noBuys' } },
  mktExit: { label: 'SELL LESS + STRICT MARKET FILTER: as above, and every stock is sold when the market turns down', opts: { exit: 'trend', marketFilter: 'exitAll' } },
  mktExitConfirm: { label: 'STRICT MARKET FILTER + the stock must be in its own uptrend to be bought', opts: { exit: 'trend', marketFilter: 'exitAll', confirmTrend: true } },
  fill: { label: 'FILL THE SLOTS: every week the slots go to the strongest stocks the model is not selling; sold when the trend breaks or it drops out of the top 5', opts: { exit: 'trend', rebalanceDays: 5 } },
};
/** The researched list (profile `lists.researchCore`; GENERIC_PLAN P2): fixed, no randomness. */
export const OWNER_BAG: readonly string[] = activeProfile().lists.researchCore;
const pct = (v: number): string => ((v / CASH - 1) * 100 >= 0 ? '+' : '') + ((v / CASH - 1) * 100).toFixed(1) + '%';

/**
 * G5(d) (master T5): never drawn into a random bag or the universe minus the list: the index funds and the VIX
 * ('_VIX' is its file-name spelling, which some CLIs read tickers from), and James's extra tickers (G0: crypto,
 * IBIT and the others kept out of RESEARCH_UNIVERSE).
 */
export const NOT_IN_BAGS: ReadonlySet<string> = new Set(['QQQ', 'SPY', '^VIX', '_VIX', ...JAMES_EXTRA_TICKERS, ...MACRO_EXTRA_TICKERS]);

/** Deterministic bags (mulberry32), so a rerun gives the same bags. QQQ, SPY, ^VIX (NOT_IN_BAGS) are never drawn. */
export function randomBags(universe: readonly string[], n: number, size: number, seed = 20261028): string[][] {
  const rnd = mulberry32(seed);
  const pool = universe.filter((t) => !NOT_IN_BAGS.has(t));
  return Array.from({ length: n }, () => [...pool].sort(() => rnd() - 0.5).slice(0, size).sort());
}

/** G5(d) (master T5): the research universe minus the owner's list (and minus NOT_IN_BAGS), the survivors-only wider check. */
export function universeMinusList(universe: readonly string[], list: readonly string[] = OWNER_BAG): string[] {
  const own = new Set(list);
  return universe.filter((t) => !own.has(t) && !NOT_IN_BAGS.has(t));
}

function main(): void {
  const [priceDir, readsDir, nb, ns, sc, ms] = process.argv.slice(2) as [string, string, string?, string?, string?, string?];
  const scenario = SCENARIO[sc ?? 'base'] ?? SCENARIO.base!;
  const models = (ms ? ms.split(',') : [...PORTFOLIO_MODELS]) as Array<(typeof PORTFOLIO_MODELS)[number]>;
  const series = new Map<string, PriceSeries>();
  const reads = new Map<string, Map<string, CompactRead>>();
  for (const f of fs.readdirSync(readsDir).filter((x) => x.endsWith('.reads.json'))) {
    const t = f.replace('.reads.json', '').replace(/^_/, '^');
    series.set(t, loadSeries(t, priceDir));
    reads.set(t, new Map((JSON.parse(fs.readFileSync(path.join(readsDir, f), 'utf8')) as CompactRead[]).map((r) => [r.d, r])));
  }
  const inp: PortfolioInput = { series, reads, qqq: loadSeries('QQQ', priceDir) };
  const slots = Number(ns ?? 5);
  const owner = OWNER_BAG.filter((t) => reads.has(t));
  const bags = randomBags([...reads.keys()].sort(), Number(nb ?? 20), 12);
  const out: string[] = ['Scenario: ' + scenario.label + '.', 'One $100,000 account, ' + slots + ' slots, empty slots in QQQ, after the 25% tax. Your bag (with saved history): ' + owner.join(', ') + '. Plus ' + bags.length + ' random bags of 12 from ' + reads.size + ' stocks.'];
  for (const p of PERIODS) {
    const q = holdLab(inp.qqq, p.start, p.end, CASH) as number;
    out.push('', '### ' + p.name + ' — hold QQQ ' + pct(q), '', '| Model | Your bag | Random bags: average | Random bags: worst | Bags beating QQQ | Bags beating QQQ by 20%+ | Trades (your bag) | Stocks held, average |', '|---|---|---|---|---|---|---|---|');
    for (const m of models) {
      const mine = runPortfolio(m, owner, inp, p.start, p.end, { slots, cash: CASH, ...scenario.opts });
      const rs = bags.map((b) => runPortfolio(m, b, inp, p.start, p.end, { slots, cash: CASH, ...scenario.opts }).finalTaxed);
      const avg = rs.reduce((a, b) => a + b, 0) / rs.length;
      out.push('| ' + LABEL[m] + ' | ' + pct(mine.finalTaxed) + ' | ' + pct(avg) + ' | ' + pct(Math.min(...rs)) + ' | ' + rs.filter((v) => v > q).length + ' of ' + rs.length + ' | ' + rs.filter((v) => v > q + 0.2 * CASH).length + ' of ' + rs.length + ' | ' + mine.trades + ' | ' + mine.avgStocksHeld.toFixed(1) + ' |');
      process.stderr.write(p.name + ' ' + m + ' done\n');
    }
    const hb = bags.map((b) => holdBag(b, inp, p.start, p.end, CASH));
    out.push('| Hold the bag equally | ' + pct(holdBag(owner, inp, p.start, p.end, CASH)) + ' | ' + pct(hb.reduce((a, b) => a + b, 0) / hb.length) + ' | ' + pct(Math.min(...hb)) + ' | ' + hb.filter((v) => v > q).length + ' of ' + hb.length + ' | ' + hb.filter((v) => v > q + 0.2 * CASH).length + ' of ' + hb.length + ' | — | — |');
  }
  process.stdout.write(out.join('\n') + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
