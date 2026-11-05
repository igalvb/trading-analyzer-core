/**
 * `npm run live-fee-report [-- --paper FILE] [--no-sheet] [--prices DIR --reads DIR] [--json]` (phase 1, decides D1).
 *
 *   --paper FILE         the paper test's saved state as JSON ({ state, trades }, as in '📝 Paper State'); without it
 *                        the state is read from the Sheet (unless --no-sheet)
 *   --prices / --reads   the research price and reads files (research/fetchPrices.ts, computeReads.ts): the
 *                        2010-2026 simulation is run now; without them the stored run (researchFees.ts) is used
 *   --json               print only the research table as JSON (to refresh researchFees.ts)
 * Settings (fees, fee filter, fractions, start money) from the environment, as the nightly (liveConfig.ts).
 * Exit: 0 printed, 1 nothing could be read.
 */

import { processLine } from '../core/logFile.ts';
import fs from 'node:fs';
import path from 'node:path';
import { STD_IO, type CliIo } from '../cli.ts';
import { loadSeries, type PriceSeries } from '../backtest/data.ts';
import { PERIODS } from '../research/lab.ts';
import { runPortfolio, type PortfolioInput, type PortfolioModel } from '../research/portfolioLab.ts';
import { benchmarksFor } from '../research/benchmarks.ts';
import { OWNER_BAG } from '../research/portfolioCli.ts';
import type { CompactRead } from '../research/computeReads.ts';
import type { StoredPaper } from '../paper/paperJob.ts';
import { liveConfigFromEnv, orderFee, type LiveConfig } from './liveConfig.ts';
import { SUPPORTED_ACCOUNTS } from './target.ts';
import { buildFeeReport, feeReportText, TRADING_DAYS_A_YEAR, type ResearchFeeTable, type ResearchFeeRow } from './feeReport.ts';
import { RESEARCH_FEES } from './researchFees.ts';

const CASH = 100_000;
const r1 = (v: number): number => Math.round(v * 10) / 10;

/** The research simulation of every supported account, without and with the fee per order at the $1,000 slot size. */
export function researchFeeTable(inp: PortfolioInput, bag: readonly string[], cfg: Pick<LiveConfig, 'startValue' | 'fees'>, today: string): ResearchFeeTable {
  const bench = benchmarksFor(bag, inp, CASH);
  const rows: ResearchFeeRow[] = SUPPORTED_ACCOUNTS.map((st) => {
    const slotValue = cfg.startValue / st.slots;
    // A typical order is one slot; the fee assumes a $100 share (at $1,000 the $1 minimum decides either way).
    const fee = orderFee(slotValue / 100, 100, cfg.fees), feeBps = (fee / slotValue) * 10_000;
    const opts = { slots: st.slots, cash: CASH, exit: st.sell === 'trend200' ? 'trend' as const : 'model' as const, trendDays: st.trendDays };
    let trades = 0, years = 0;
    const periods = PERIODS.map((p, k) => {
      const plain = runPortfolio(st.model as PortfolioModel, bag, inp, p.start, p.end, opts);
      const paid = runPortfolio(st.model as PortfolioModel, bag, inp, p.start, p.end, { ...opts, costBps: feeBps });
      const y = inp.qqq.dates.filter((d) => d >= p.start && d <= p.end).length / TRADING_DAYS_A_YEAR;
      trades += paid.trades; years += y;
      return {
        period: p.name, years: Math.round(y * 100) / 100, trades: paid.trades, afterTaxPct: r1((plain.finalTaxed / CASH - 1) * 100), afterFeesPct: r1((paid.finalTaxed / CASH - 1) * 100), fallPct: r1(paid.maxDrawdownPct),
        qqqPct: r1((bench.qqq[k]!.finalTaxed / CASH - 1) * 100), qqqFallPct: r1(bench.qqq[k]!.maxDrawdownPct), list14Pct: r1((bench.list[k]!.finalTaxed / CASH - 1) * 100), list14FallPct: r1(bench.list[k]!.maxDrawdownPct),
      };
    });
    const ordersPerYear = years ? (2 * trades) / years : 0;
    return { id: st.id, label: st.label, slots: st.slots, feeBps: r1(feeBps), ordersPerYear: r1(ordersPerYear), feeDragPctYear: Math.round(((ordersPerYear * fee) / cfg.startValue) * 10_000) / 100, periods };
  });
  return {
    generatedOn: today, startValue: cfg.startValue, rows,
    note: 'runPortfolio on the 14 researched stocks (research/portfolioCli.ts OWNER_BAG), $100,000 scaled; fees as ' + 'basis points of a $' + cfg.startValue + '/slots order; orders = stock trades x 2 (the QQQ counter-order)',
  };
}

function loadResearch(priceDir: string, readsDir: string): { inp: PortfolioInput; bag: string[] } {
  const series = new Map<string, PriceSeries>(), reads = new Map<string, Map<string, CompactRead>>();
  for (const t of OWNER_BAG) {
    const f = path.join(readsDir, t + '.reads.json');
    if (!fs.existsSync(f)) continue;
    series.set(t, loadSeries(t, priceDir));
    reads.set(t, new Map((JSON.parse(fs.readFileSync(f, 'utf8')) as CompactRead[]).map((r) => [r.d, r])));
  }
  return { inp: { series, reads, qqq: loadSeries('QQQ', priceDir) }, bag: OWNER_BAG.filter((t) => series.has(t)) };
}

export interface FeeReportCliDeps {
  /** Tests: the paper state instead of the Sheet. */
  readonly loadPaper?: () => Promise<StoredPaper | null>;
}

export async function liveFeeReportMain(argv: readonly string[], io: CliIo = STD_IO, deps: FeeReportCliDeps = {}): Promise<number> {
  const arg = (k: string): string | null => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? null) : null; };
  const cfg = liveConfigFromEnv(io.env ?? process.env);
  let research: ResearchFeeTable | null = RESEARCH_FEES;
  const prices = arg('--prices'), readsDir = arg('--reads');
  if (prices && readsDir) {
    const { inp, bag } = loadResearch(prices, readsDir);
    research = researchFeeTable(inp, bag, cfg, new Date().toISOString().slice(0, 10));
  }
  if (argv.includes('--json')) { io.out(JSON.stringify(research, null, 2) + '\n'); return research ? 0 : 1; }
  let paper: StoredPaper | null = null;
  const file = arg('--paper');
  try {
    if (file) paper = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredPaper;
    else if (deps.loadPaper) paper = await deps.loadPaper();
    else if (!argv.includes('--no-sheet')) {
      const { composeServices } = await import('../compose.ts');
      const { loadPaper } = await import('../paper/paperJob.ts');
      const { formatLine, LogLevel } = await import('../core/logger.ts');
      const s = await composeServices({ storage: 'sheets', env: io.env ?? process.env, mode: 'ticker', noAi: true, logLevel: LogLevel.WARNING, logSink: (l) => io.err(formatLine(l) + '\n') });
      paper = await loadPaper(s.tabStore);
    }
  } catch (e) { io.err('live fee report: the paper test could not be read (' + String(e) + '); research only\n'); }
  if (!paper && !research) { io.out('live fee report: nothing to report (no paper state, no research run)\n'); return 1; }
  io.out(feeReportText(buildFeeReport(paper, research, cfg), research).join('\n') + '\n');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  liveFeeReportMain(process.argv.slice(2)).then((c) => process.exit(c), (e) => { processLine('CRITICAL', 'live', 'the fee report stopped on an unexpected error (exit 1)', { detail: String(e) }); process.exit(1); });
}
