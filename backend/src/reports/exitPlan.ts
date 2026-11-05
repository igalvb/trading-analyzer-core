/**
 * Row 30 (owner 2026-10-27): the exit plan for a ticker the owner HOLDS, added to the Analyze PDF.
 *
 * The same Exit step the nightly runs (jobs/exit/exitReportStep.ts: pipeline -> adapter -> Exit sheet), limited to the
 * Portfolio rows of this one ticker and fed this run's own analysis (no second analysis). It is drawn into a scratch
 * in-memory workbook: the real Exit Report tab and Exit Target History are never written. The remembered targets are
 * read (a copy of Exit Target History seeds the scratch workbook), so the sell plan continues the nightly's plan.
 * Nothing here computes a number: the page shows the cells the Exit step wrote.
 */

import { textLog } from '../core/logger.ts';
import type { Services } from '../compose.ts';
import type { TickerArtifacts } from '../analysis/runTicker.ts';
import { toAnalysisChart } from '../analysis/runTicker.ts';
import { loadPortfolio, optionPricePerShare } from '../app/nightlyApp.ts';
import { toExitBundle } from '../app/analysisCache.ts';
import { exitReportJob } from '../jobs/exit/exitReportStep.ts';
import { computeOptionsPositionExitReadFixedLookback } from '../portfolio/positions/optionsFixedLookback.ts';
import { EXIT_SHEET_TAB, exitActionOf } from './exitSheet/exitSheet.ts';
import { EXIT_TARGET_HISTORY_SHEET } from '../stores/exitTargetHistory.ts';
import { ReportWorkbook, MemoryWorkbookBackend, type ReportSheet } from '../sheets/reportSheet.ts';
import type { PortfolioResult } from '../sheets/readers/portfolio.ts';
import type { Chart } from '../types/chart.ts';

export interface HeldExitPlan {
  /** The Exit Report page for this ticker's holdings (a scratch tab). */
  readonly sheet: ReportSheet;
  /** One action per holding row, in report order (e.g. ['HOLD'] or ['TRIM', 'HOLD'] for a stock and a call). */
  readonly actions: readonly string[];
}

/** The Portfolio rows of one ticker (stocks and options); null when it is not held. */
export function heldRows(p: PortfolioResult, ticker: string): PortfolioResult | null {
  const t = ticker.toUpperCase();
  const stocks = p.stocks.filter((h) => h.ticker.toUpperCase() === t);
  const options = p.options.filter((h) => h.ticker.toUpperCase() === t);
  if (!stocks.length && !options.length) return null;
  return { stocks, options, skippedCrypto: [], skippedOther: [], blankRowCount: 0 };
}

/**
 * The exit plan when `ticker` is on the Portfolio sheet, else null. Never throws: a failure is logged and the Analyze
 * PDF goes out without the page.
 */
export async function heldExitPlan(s: Services, ticker: string, art: TickerArtifacts | null): Promise<HeldExitPlan | null> {
  const log = textLog(s.ctx.log);
  try {
    const rows = heldRows(await loadPortfolio(s), ticker);
    if (!rows) return null;
    // A copy of the remembered targets, read only.
    const seed: Record<string, unknown[][]> = {};
    try {
      const real = await s.openWorkbook([EXIT_TARGET_HISTORY_SHEET]);
      const h = real.getSheetByName(EXIT_TARGET_HISTORY_SHEET);
      if (h) seed[EXIT_TARGET_HISTORY_SHEET] = h.grid();
    } catch (e) { log('exit plan: saved targets not read, the plan starts fresh: ' + String(e)); }
    const wb = await ReportWorkbook.open(new MemoryWorkbookBackend(structuredClone(seed) as never), ['*']);
    const getChart = async (t: string): Promise<Chart | null> => { const c = await s.fetchChart(t); return c ? toAnalysisChart(c as never) : null; };
    let built: { actions: string[] } | null = null;
    const job = exitReportJob({
      ctx: s.ctx,
      pipeline: {
        portfolio: rows,
        getChart: (_c, t) => getChart(t),
        getAnalysis: async (_c, t) => (art && art.result && t.toUpperCase() === ticker.toUpperCase() ? toExitBundle(art) : null),
        getOptionPremium: async (_c, h) => optionPricePerShare(h),
        analyzers: {
          optionsFixedLookback: (t, strike, expiryStr, prem, chart, opts) =>
            computeOptionsPositionExitReadFixedLookback(t, strike, expiryStr, prem as number, chart, undefined, s.clock.now(), opts) as never,
        },
      },
      openWorkbook: () => wb,
      onBuilt: (input) => { built = { actions: input.holdings.map((h) => exitActionOf(h)) }; },
    });
    await job();
    const sheet = wb.getSheetByName(EXIT_SHEET_TAB);
    const done = built as { actions: string[] } | null;
    if (!sheet || !done) return null;
    return { sheet, actions: done.actions };
  } catch (e) {
    log('exit plan for ' + ticker + ' not built (the PDF goes without it): ' + String(e));
    return null;
  }
}
