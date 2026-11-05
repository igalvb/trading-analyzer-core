/**
 * Row 36 (owner decision 2026-10-31): a STOCK row with no purchase date is read as bought on the assumed 2020-01-01,
 * treated like a real date (a breached stop is EXIT, not a low-confidence REVIEW), and every place that shows the
 * basis says "measured from an assumed purchase date of 1 Jan 2020 (no real date on file)".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../src/core/context.ts';
import { Logger } from '../src/core/logger.ts';
import type { Chart } from '../src/types/chart.ts';
import {
  parsePortfolio, ASSUMED_STOCK_PURCHASE_DATE_ISO, ASSUMED_STOCK_PURCHASE_DATE_LABEL, ASSUMED_ENTRY_BASIS,
  type PortfolioResult, type StockHolding,
} from '../src/sheets/readers/portfolio.ts';
import { runExitPipeline, sinceEntryDateStr, classifyStockAction, stockTrailingStop, type ExitPipelineDeps } from '../src/jobs/exit/exitPipeline.ts';
import { exitReportJob } from '../src/jobs/exit/exitReportStep.ts';
import { EXIT_SHEET_TAB } from '../src/reports/exitSheet/exitSheet.ts';
import { ReportWorkbook, MemoryWorkbookBackend } from '../src/sheets/reportSheet.ts';
import { exitFactsFor } from '../src/ai.ts';
import { computePositionExitRead, computePositionExitReadFixedLookback } from '../src/analysis/exitRead.ts';
import { toPortfolioSummary } from '../src/app/portfolio.ts';

const PHRASE = 'measured from an assumed purchase date of 1 Jan 2020 (no real date on file)';
const NOW = Date.parse('2026-10-30T20:00:00Z');

function mkCtx() {
  const log = new Logger({ sink: () => {}, scope: 'exit', now: () => new Date(0) });
  return createContext({ mode: 'test', runId: 'r36', logger: log, clock: { now: () => NOW }, sleep: async () => {}, random: () => 0 });
}

/** ~2 years of business-day bars from 2024-11-01: a long climb, then a sharp fall well below a 3-ATR trailing stop. */
function fallingChart(ticker: string): Chart {
  const dates: Date[] = []; const opens: number[] = []; const highs: number[] = []; const lows: number[] = []; const closes: number[] = []; const volumes: number[] = [];
  const d = new Date('2024-11-01T14:30:00Z');
  let i = 0;
  while (d.getTime() <= NOW) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) {
      const n = i++;
      const c = n < 420 ? 100 + n * 0.5 : 310 - (n - 420) * 3;
      dates.push(new Date(d)); opens.push(c); highs.push(c + 1); lows.push(c - 1); closes.push(c); volumes.push(1_000_000);
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const last = closes[closes.length - 1]!;
  return { ticker, dates, opens, highs, lows, closes, volumes, splits: [], ipoDate: null, currentPrice: last, prevClose: last, currency: 'USD' } as unknown as Chart;
}

const pf = (stocks: StockHolding[]): PortfolioResult => ({ stocks, options: [], skippedCrypto: [], skippedOther: [], blankRowCount: 0 });

test('the assumed date is one constant and the label/basis are derived from it', () => {
  assert.equal(ASSUMED_STOCK_PURCHASE_DATE_ISO, '2020-01-01');
  assert.equal(ASSUMED_STOCK_PURCHASE_DATE_LABEL, '1 Jan 2020');
  assert.equal(ASSUMED_ENTRY_BASIS, PHRASE);
});

test('a stock row with no purchase-date column gets the assumed date; options rows are unchanged', () => {
  const r = parsePortfolio([
    ['Ticker', 'type', 'amount', 'cost avg per stock'],
    ['TSLA', 'stock', 10, '$250.00'],
    [],
    ['Ticker', 'positions', 'last trade Date', 'strike', 'PUT/CALL', 'avg price - Premium paid'],
    ['AMD', 2, '2027-01-15', 150, 'CALL', 3],
  ]);
  assert.equal(r.stocks[0]!.entryDate!.toISOString().slice(0, 10), '2020-01-01');
  assert.equal(r.stocks[0]!.entryDateAssumed, true);
  assert.equal(r.options[0]!.entryDate, null, 'options keep their own Purchase Date column; nothing assumed');
});

test('a real purchase date is kept and not marked assumed; a blank cell is assumed', () => {
  const r = parsePortfolio([
    ['Ticker', 'type', 'amount', 'cost avg per stock', 'Purchase Data'],
    ['TSLA', 'stock', 10, '$250.00', '2025-03-14'],
    ['NVDA', 'stock', 5, '$100.00', ''],
  ]);
  assert.equal(r.stocks[0]!.entryDate!.toISOString().slice(0, 10), '2025-03-14');
  assert.equal(r.stocks[0]!.entryDateAssumed, undefined);
  assert.equal(r.stocks[1]!.entryDateAssumed, true);
  // The nightly / Buy projection does not present the assumed date as a real lot date.
  const s = toPortfolioSummary(r);
  assert.equal(s.positions.find((p) => p.ticker === 'NVDA')!.earliestLotDate, '');
  assert.equal(s.positions.find((p) => p.ticker === 'TSLA')!.earliestLotDate, '2025-03-14');
});

test('sinceEntryDateStr: an assumed date older than the history starts at the first bar; a real date is passed as is', () => {
  const ch = fallingChart('X');
  assert.equal(sinceEntryDateStr('2020-01-01', true, ch), ch.dates[0]!.toISOString());
  assert.equal(sinceEntryDateStr('2020-01-01', false, ch), '2020-01-01');
  assert.equal(sinceEntryDateStr('2025-06-02', true, ch), '2025-06-02');
});

test('classifyStockAction: a breached stop on the assumed date is EXIT with the plain basis', () => {
  const d = classifyStockAction({ stopBreached: true, chandelierSinceEntry: 90 }, true, true);
  assert.equal(d.actionClass, 'EXIT');
  assert.ok(d.headline.includes(PHRASE), d.headline);
  assert.equal(classifyStockAction({ stopBreached: true, chandelierSinceEntry: 90 }, true).headline.includes('measured from your purchase date'), true);
});

test('pipeline + Exit sheet: an assumed-date holding below its stop reads EXIT (not REVIEW) and every basis says so', async () => {
  const holdings = parsePortfolio([
    ['Ticker', 'type', 'amount', 'cost avg per stock'],
    ['TSLA', 'stock', 10, '$150.00'],
  ]).stocks;
  // The real reads, with the thesis forced intact so the stop decides (a steep fall also turns the technical read negative).
  const deps: ExitPipelineDeps = {
    portfolio: pf(holdings), getChart: async (_c, t) => fallingChart(t),
    analyzers: {
      stockSinceEntry: (t, c, d, ch, o) => ({ ...computePositionExitRead(t, c, d, ch, o), thesisInvalidated: false }),
      stockFixedLookback: (t, c, ch, o) => ({ ...computePositionExitReadFixedLookback(t, c, ch, undefined, o), thesisInvalidated: false }),
    },
  };
  const run = await runExitPipeline(mkCtx(), deps);
  const h = run.holdings[0]!;
  assert.equal(h.kind, 'STOCK');
  assert.equal(h.confidence, 'ASSUMED');
  assert.equal(h.entryDateFallback, null, 'the since-entry read was used, not the generic lookback');
  assert.equal(h.stopBreached, true);
  assert.equal(h.actionClass, 'EXIT');
  if (h.kind === 'STOCK') { assert.equal(h.entryDate, '2020-01-01'); assert.equal(h.entryDateAssumed, true); }

  // The same holding without any date (old behaviour) is the low-confidence REVIEW.
  const generic = await runExitPipeline(mkCtx(), { ...deps, portfolio: pf([{ ...holdings[0]!, entryDate: null, entryDateAssumed: undefined }]) });
  assert.equal(generic.holdings[0]!.actionClass, 'REVIEW');
  assert.ok(h.headline.includes(PHRASE), h.headline);

  const wb = await ReportWorkbook.open(new MemoryWorkbookBackend({} as never), ['*']);
  await exitReportJob({ ctx: mkCtx(), pipeline: deps, openWorkbook: () => wb, rememberTargets: false })();
  const text = wb.getSheetByName(EXIT_SHEET_TAB)!.grid().flat().map(String).join('\n');
  assert.ok(text.includes('Trailing stop'));
  const count = text.split(PHRASE).length - 1;
  assert.ok(count >= 3, 'the stop row, the entry-date row, the confidence and the data-health line name the assumed basis (found ' + count + ')');
  assert.ok(!text.includes('no purchase date is on file, so this is a low-confidence read'));
  assert.ok(!text.includes('generic lookback because there is no entry date on file'));
});

test('AI exit facts: the trailing stop uses the assumed date and carries the plain basis', () => {
  const [h] = parsePortfolio([['Ticker', 'type', 'amount', 'cost avg per stock'], ['TSLA', 'stock', 10, '$150.00']]).stocks;
  const ch = fallingChart('TSLA');
  const stop = stockTrailingStop('TSLA', 150, h!.entryDate, ch, {}, true);
  assert.equal(typeof stop, 'number');
  const facts = exitFactsFor(h!, 100, stop, ['TSLA']);
  assert.equal(facts.trailingStopBasis, PHRASE);
  const real = exitFactsFor({ ...h!, entryDateAssumed: undefined }, 100, stop, ['TSLA']);
  assert.equal(real.trailingStopBasis, undefined);
});
