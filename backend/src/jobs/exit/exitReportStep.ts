/**
 * FL-9d: nightly step `exit.report` = Exit pipeline -> adapter -> Exit sheet -> one flush.
 * Returns a NightlyJob (the shape runNightly's runJob wraps in runStep with the step's timeout, retries and failedText).
 * A sheet-build or flush failure THROWS so the step retries and, if it keeps failing, is reported as failed with the
 * catalog failedText. Partial results return state 'degraded' with a plain counted sentence (no raw errors).
 */
import { orElse, orElseAsync } from '../../core/guard.ts';
import { textLog } from '../../core/logger.ts';
import type { RunContext } from '../../core/context.ts';
import { runStep } from '../../core/runStep.ts';
import { reportSentence } from '../../core/result.ts';
import type { BullPhaseAdvisory } from '../../reports/exit/exitReport.ts';
import { buildExitSheet } from '../../reports/exitSheet/exitSheet.ts';
import type { ExitSheetDeps, ExitSheetResult } from '../../reports/exitSheet/exitSheet.ts';
import type { BusinessAlertsView, ExitReportInput } from '../../reports/exitSheet/types.ts';
import type { ReportWorkbook } from '../../sheets/reportSheet.ts';
import type { JobOutcome, NightlyJob } from '../nightly/nightly.ts';
import { toExitReportInput } from './exitReportAdapter.ts';
import type { ExitAdapterOptions } from './exitReportAdapter.ts';
import { runExitPipeline } from './exitPipeline.ts';
import { buildSellPlans, type SellPlansResult } from './sellPlans.ts';
import { appendAnchors, readLatestAnchors } from '../../stores/exitTargetHistory.ts';
import { formatDateInTz } from '../../core/dates.ts';
import { REPORT_TIME_ZONE } from '../../reports/messages/catalog.ts';
import type { ExitPipelineDeps, ExitPipelineOptions, ExitPipelineResult } from './exitPipeline.ts';

export const EXIT_REPORT_STEP_KEY = 'exit.report' as const;
const UNAVAILABLE_BUSINESS_ALERTS: BusinessAlertsView = { mode: 'shadow', intro: [], market: { alert: false, text: '' }, holdings: [], unavailable: true };

export interface ExitReportJobDeps {
  readonly ctx: RunContext;
  readonly pipeline: ExitPipelineDeps;
  /** Opened AFTER the pipeline finishes, so the workbook is not held open during the slow part. */
  readonly openWorkbook: () => Promise<ReportWorkbook> | ReportWorkbook;
  readonly options?: ExitPipelineOptions;
  readonly adapter?: Pick<ExitAdapterOptions, 'stockTableUnreadable' | 'optionsTableUnreadable'>;
  /** Diversification / market-phase check. A throw becomes "this section could not be built" in the report. */
  readonly loadAdvisory?: (ctx: RunContext, run: ExitPipelineResult) => Promise<BullPhaseAdvisory | null>;
  readonly sheet?: ExitSheetDeps;
  /** F-X2: remember targets and the sell plan in the Exit Target History tab. Default true; false = plans without memory. */
  readonly rememberTargets?: boolean;
  /** Row 29/30: the digest and the Analyze exit plan keep what the sheet was built from (a throw here is logged, never fails the step). */
  readonly onBuilt?: (input: ExitReportInput, result: ExitSheetResult, workbook: ReportWorkbook) => void;
  /** Extra display lines (options sentiment: the market line). A throw is logged; the report is built without them. */
  readonly decorate?: (input: ExitReportInput) => Promise<ExitReportInput> | ExitReportInput;
  /**
   * Owner 2026-11-07 (profile exit.businessAlerts shadow / on; absent = off): the business alerts section
   * (businessAlerts.ts runBusinessAlerts). Display, run log and Telegram only: never read by a verdict. A throw is
   * logged and the section says it could not be built; the report and the step outcome are otherwise unchanged.
   */
  readonly businessAlerts?: (ctx: RunContext, run: ExitPipelineResult) => Promise<BusinessAlertsView>;
}

export function describeExitOutcome(failed: number, degraded: number, total: number): JobOutcome {
  if (!failed && !degraded) return { state: 'ok' };
  const bits: string[] = [];
  if (failed) bits.push(failed + ' of ' + total + ' holdings could not be read and show no verdict');
  if (degraded) bits.push(degraded + ' ' + (degraded === 1 ? 'check ran' : 'checks ran') + ' with partial data');
  return { state: 'degraded', reason: 'The Exit Strategy report was updated, but ' + bits.join(', and ') + '.' };
}

export function exitReportJob(d: ExitReportJobDeps): NightlyJob {
  return async (): Promise<JobOutcome> => {
    const { ctx } = d;
    const run = await runExitPipeline(ctx, d.pipeline, d.options);

    let advisory: BullPhaseAdvisory | null = null;
    let advisoryUnavailable: 'SECTION_UNAVAILABLE' | undefined;
    if (d.loadAdvisory) {
      const loader = d.loadAdvisory;
      const r = await runStep(ctx, {
        key: 'exit.advisory', label: 'Diversification and market-phase check', retry: 'never',
        onFailure: reportSentence('The diversification and market-phase check could not be built.'),
      }, () => loader(ctx, run));
      if (r.ok) advisory = r.value;
      else advisoryUnavailable = 'SECTION_UNAVAILABLE';
    }

    let business: BusinessAlertsView | null = null;
    if (d.businessAlerts) {
      const biz = d.businessAlerts;
      business = await orElseAsync(ctx.log, 'exit report: business alerts (section shown as not built)', () => biz(ctx, run), UNAVAILABLE_BUSINESS_ALERTS);
    }

    const ss = await d.openWorkbook();
    // F-X2: the sell plans, continued from the remembered plan. A history tab that cannot be read or written costs
    // the memory only: the plans are still shown (fresh), the report says the saved targets were not available.
    const today = formatDateInTz(new Date(run.startedAtMs), REPORT_TIME_ZONE, 'yyyy-MM-dd');
    let plans: SellPlansResult;
    let memoryUnavailable = false;
    try {
      const anchors = d.rememberTargets === false ? null : readLatestAnchors(ss);
      plans = buildSellPlans(run.holdings, anchors, today);
      appendAnchors(ss, plans.append);
    } catch (e) {
      ctx.log.warning('exit target history unavailable, sell plans shown without memory', { detail: String((e as Error)?.stack ?? e) });
      plans = buildSellPlans(run.holdings, null, today);
      memoryUnavailable = true;
    }
    if (plans.append.length) ctx.log.info('exit target history: rows appended', { rows: plans.append.length, why: plans.append.map((a) => a.key + ':' + a.why) });
    let input = toExitReportInput(run, {
      ...(d.adapter ?? {}), advisory, ...(advisoryUnavailable ? { advisoryUnavailable } : {}),
      sellPlans: plans.byHolding, ...(memoryUnavailable ? { targetMemoryUnavailable: true } : {}),
      ...(business ? { businessAlerts: business } : {}),
    });
    if (d.decorate) { const deco = d.decorate, plain = input; input = await orElseAsync(ctx.log, 'exit report: extra display lines (skipped)', async () => deco(plain), plain); }
    const res = buildExitSheet(ss, input, { log: textLog(ctx.log), ...(d.sheet ?? {}) });
    await ss.flush();
    if (d.onBuilt) { const hook = d.onBuilt, built = input; orElse(ctx.log, 'exit report: onBuilt hook', () => hook(built, res, ss), undefined); }

    const failed = run.holdings.filter((h) => h.status === 'FAILED').length;
    const degraded = run.holdings.filter((h) => h.status === 'DEGRADED').length + run.portfolioQuality.length + res.degraded.length + (advisoryUnavailable ? 1 : 0);
    ctx.log.info('exit report written', { key: EXIT_REPORT_STEP_KEY, rows: res.rowCount, holdings: run.holdings.length, failed, degraded });
    return describeExitOutcome(failed, degraded, run.holdings.length);
  };
}
