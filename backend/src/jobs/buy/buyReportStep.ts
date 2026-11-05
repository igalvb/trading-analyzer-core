/**
 * FL-9d/9m: Buy pipeline -> adapter -> Buy sheet -> one flush, as a NightlyJob. It is the nightly step `buy.report`
 * (steps.ts, right after analysis.summary). The workbook is opened FIRST and handed to the pipeline factory, so the
 * Decision History reader/writer shares the same ReportWorkbook as the Buy sheet and is flushed with it.
 * Same failure contract as exitReportJob.
 */
import { orElse, orElseAsync } from '../../core/guard.ts';
import { textLog } from '../../core/logger.ts';
import type { RunContext } from '../../core/context.ts';
import { buildBuySheet } from '../../reports/buySheet/buySheet.ts';
import type { BuySheetDeps, BuySheetResult } from '../../reports/buySheet/buySheet.ts';
import type { BuyReportInput } from '../../reports/buySheet/types.ts';
import type { ReportWorkbook } from '../../sheets/reportSheet.ts';
import type { JobOutcome, NightlyJob } from '../nightly/nightly.ts';
import { toBuyReportInput } from './buyReportAdapter.ts';
import type { BuyAdapterOptions } from './buyReportAdapter.ts';
import { DAILY_AUTOMATION_REJECTED_LOG, normalizeNightlyHistoryPolicy } from '../history/historyPolicy.ts';
import { runBuyPipeline } from './buyPipeline.ts';
import type { BuyPipelineDeps, BuyPipelineOptions } from './buyPipeline.ts';

export const BUY_REPORT_STEP_KEY = 'buy.report' as const;

export interface BuyReportJobDeps {
  readonly ctx: RunContext;
  /** A factory receives the opened workbook (F4); a plain object is still accepted. */
  readonly pipeline: BuyPipelineDeps | ((ss: ReportWorkbook) => BuyPipelineDeps);
  readonly openWorkbook: () => Promise<ReportWorkbook> | ReportWorkbook;
  readonly options?: BuyPipelineOptions;
  readonly adapter?: BuyAdapterOptions;
  readonly sheet?: BuySheetDeps;
  /** Row 29: the nightly digest keeps what the sheet was built from (read only; a throw here is logged, never fails the step). */
  readonly onBuilt?: (input: BuyReportInput, result: BuySheetResult, workbook: ReportWorkbook) => void;
  /** Extra display lines (options sentiment: the shadow reads, the market line). A throw is logged; the report is built without them. */
  readonly decorate?: (input: BuyReportInput) => Promise<BuyReportInput> | BuyReportInput;
}

export function buyReportJob(d: BuyReportJobDeps): NightlyJob {
  return async (): Promise<JobOutcome> => {
    const { ctx } = d;
    const ss = await d.openWorkbook();
    const pipeline = typeof d.pipeline === 'function' ? d.pipeline(ss) : d.pipeline;
    const hp = normalizeNightlyHistoryPolicy(d.options?.historyPolicy);
    if (hp.rejected) ctx.log.error(DAILY_AUTOMATION_REJECTED_LOG);
    const run = await runBuyPipeline(pipeline, hp.rejected ? { ...(d.options ?? {}), historyPolicy: hp.policy } : d.options);
    let input = toBuyReportInput(run, { runAt: new Date(ctx.clock.now()), ...(d.adapter ?? {}) });
    if (d.decorate) { const deco = d.decorate, plain = input; input = await orElseAsync(ctx.log, 'buy report: extra display lines (skipped)', async () => deco(plain), plain); }
    const res = buildBuySheet(ss, input, { log: textLog(ctx.log), ...(d.sheet ?? {}) });
    await ss.flush();
    if (d.onBuilt) { const hook = d.onBuilt, built = input; orElse(ctx.log, 'buy report: onBuilt hook', () => hook(built, res, ss), undefined); }

    const { failed, degraded, total } = run.counts;
    const partial = res.degraded.length + (run.portfolioOk ? 0 : 1);
    ctx.log.info('buy report written', { key: BUY_REPORT_STEP_KEY, rows: res.rowCount, total, failed, degraded, sections: partial });
    if (!failed && !degraded && !partial) return { state: 'ok' };
    const bits: string[] = [];
    if (failed) bits.push(failed + ' of ' + total + ' stocks could not be analysed and are listed without a decision');
    if (degraded) bits.push(degraded + ' gave partial results');
    if (partial) bits.push(partial + ' ' + (partial === 1 ? 'section is' : 'sections are') + ' incomplete');
    return { state: 'degraded', reason: 'The Buy report was updated, but ' + bits.join(', and ') + '.' };
  };
}
