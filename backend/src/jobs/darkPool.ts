/**
 * The dark-pool file's three daily trigger handlers and their installers,
 * ported from darkPoolTrackerV1.gs:
 *   refreshDarkPoolTrackerV1 :279-287          installDarkPoolTrackerTriggerV1 :292-301          (~5:00)
 *   refreshEvaluativeIndexV1 :364-372          installEvaluativeIndexTriggerV1 :382-391          (~5:30)
 *   refreshRelativeStrengthRankingV1_ :475-492 installRelativeStrengthRankingTriggerV1 :507-516 (~5:45)
 *
 * Each handler is non-fatal: a failure is logged, and the sheet or cache keeps
 * its last good data.
 *
 * TRIGGERS -> WORKFLOW. Apps Script installed three time-driven triggers
 * (everyDays(1).atHour(5), plus nearMinute(30) and nearMinute(45)), each
 * installer first checking that no trigger for its handler existed. In this
 * backend the schedule is the nightly workflow's cron, which is declarative
 * and so idempotent by construction; DARK_POOL_DAILY_JOBS keeps each legacy
 * schedule as data, and runDarkPoolDailyJobs runs the three in legacy's
 * intended order (tracker -> Evaluative Index -> relative strength), each
 * under its own timeout, before the macro refresh (legacy's 6:00 trigger).
 * Apps Script only guaranteed "within the hour" for atHour(5); the order is
 * now guaranteed.
 */

import type { Clock, RunContext } from '../core/context.ts';
import { runStep } from '../core/runStep.ts';
import { reportSentence, type StepResult } from '../core/result.ts';
import { cacheSet } from '../storage/kv.ts';
import type { TabStore } from '../storage/tabStore.ts';
import type { TabFormatter } from '../sheets/formatOps.ts';
import { writeDarkPoolTrackerSheet } from '../sheets/writers/darkPoolTracker.ts';
import {
  buildDarkPoolTrackerReport, computeEvaluativeIndex, computeRelativeStrengthRanking, darkPoolUniverse,
  EVALUATIVE_INDEX_KEY, RELATIVE_STRENGTH_KEY, DARK_POOL_CACHE_TTL_HOURS,
  type DarkPoolDeps, type DarkPoolLog, type RelativeStrengthRanking,
} from '../analysis/darkPool.ts';

export interface DarkPoolJobDeps extends DarkPoolDeps {
  readonly store: TabStore;
  readonly formatter?: TabFormatter;
}

const nowOf = (d: { readonly clock?: Clock }): number => (d.clock ? d.clock.now() : Date.now());
const logOf = (d: { readonly log?: DarkPoolLog }): DarkPoolLog => d.log ?? ((): void => {});
const errMsg = (e: any): unknown => (e && e.message ? e.message : e);

/** refreshDarkPoolTrackerV1 (:279-287). */
export async function refreshDarkPoolTracker(deps: DarkPoolJobDeps): Promise<void> {
  const log = logOf(deps);
  try {
    const report = await buildDarkPoolTrackerReport(deps, log);
    await writeDarkPoolTrackerSheet(deps, report);
    log('refreshDarkPoolTrackerV1: sheet refreshed OK, Tier1 week ' + (report.t1Week || 'n/a') + ', Tier2 week ' + (report.t2Week || 'n/a') + '.');
  } catch (e) {
    log('refreshDarkPoolTrackerV1 failed (non-fatal, sheet keeps its last good data): ' + errMsg(e));
  }
}

/** refreshEvaluativeIndexV1 (:364-372): computed and cached 30 h. */
export async function refreshEvaluativeIndex(deps: DarkPoolDeps): Promise<void> {
  const log = logOf(deps);
  try {
    const result = await computeEvaluativeIndex(deps);
    await cacheSet(deps.kv, EVALUATIVE_INDEX_KEY, result, DARK_POOL_CACHE_TTL_HOURS, nowOf(deps));
    log('refreshEvaluativeIndexV1: %Strong=' + (result.pctStrong != null ? result.pctStrong.toFixed(1) + '%' : 'n/a') + ' (' + result.strong + '+/' + result.weak + '-, ' + result.unavailable + ' unavailable) -- ' + result.read);
  } catch (e) {
    log('refreshEvaluativeIndexV1 failed (non-fatal, cache keeps its last good data): ' + errMsg(e));
  }
}

/**
 * refreshRelativeStrengthRankingV1_ (:475-492): every watchlist ticker's
 * ranking, cached as one map (30 h). F-56: the map is far over Apps Script's
 * 9 KB property limit, so legacy's cacheSet silently failed and the ranking
 * was never available; the Sheet-backed store has no 9 KB cap. It is close
 * to a Sheets cell's 50,000 characters, though (about 41-48k measured on the
 * 111-ticker watchlist): over that, SheetPropertyStore refuses it (F-57) and
 * the ranking is again unavailable that day.
 */
export async function refreshRelativeStrengthRanking(deps: DarkPoolDeps): Promise<void> {
  const log = logOf(deps);
  try {
    const tickers = darkPoolUniverse();
    const map: Record<string, RelativeStrengthRanking> = {};
    let computed = 0, nulls = 0;
    for (const t of tickers) {
      const r = await computeRelativeStrengthRanking(deps, t);
      if (r) { map[t] = r; computed++; } else { nulls++; }
    }
    await cacheSet(deps.kv, RELATIVE_STRENGTH_KEY, map, DARK_POOL_CACHE_TTL_HOURS, nowOf(deps));
    log('refreshRelativeStrengthRankingV1_: ' + computed + '/' + tickers.length + ' tickers ranked (' + nulls + ' insufficient data).');
  } catch (e) {
    log('refreshRelativeStrengthRankingV1_ failed (non-fatal, cache keeps its last good data): ' + errMsg(e));
  }
}

export interface DailyJob {
  readonly key: string;
  readonly label: string;
  /** Legacy's handler and installer names. */
  readonly handler: string;
  readonly installer: string;
  /** Legacy schedule: ScriptApp.newTrigger(handler).timeBased().everyDays(1).atHour(atHour)[.nearMinute(m)]. */
  readonly everyDays: 1;
  readonly atHour: number;
  readonly nearMinute: number | null;
  readonly timeoutMs: number;
  readonly onFailure: string;
  readonly run: (deps: DarkPoolJobDeps) => Promise<void>;
}

export const DARK_POOL_DAILY_JOBS: readonly DailyJob[] = [
  {
    key: 'darkPool.tracker', label: 'Dark Pool Tracker refresh', handler: 'refreshDarkPoolTrackerV1', installer: 'installDarkPoolTrackerTriggerV1',
    everyDays: 1, atHour: 5, nearMinute: null, timeoutMs: 20 * 60_000,
    onFailure: 'The Dark Pool Tracker tab was not refreshed; it still shows its last good data.', run: refreshDarkPoolTracker,
  },
  {
    key: 'darkPool.evaluativeIndex', label: 'Evaluative Index refresh', handler: 'refreshEvaluativeIndexV1', installer: 'installEvaluativeIndexTriggerV1',
    everyDays: 1, atHour: 5, nearMinute: 30, timeoutMs: 15 * 60_000,
    onFailure: 'The Evaluative Index was not refreshed; reports use the last cached value until it expires.', run: refreshEvaluativeIndex,
  },
  {
    key: 'darkPool.relativeStrength', label: 'Relative Strength Ranking refresh', handler: 'refreshRelativeStrengthRankingV1_', installer: 'installRelativeStrengthRankingTriggerV1',
    everyDays: 1, atHour: 5, nearMinute: 45, timeoutMs: 15 * 60_000,
    onFailure: 'The relative-strength ranking was not refreshed; reports use the last cached ranking until it expires.', run: refreshRelativeStrengthRanking,
  },
];

/** The three daily jobs in order, each under its own timeout (the nightly workflow's dark-pool step). */
export async function runDarkPoolDailyJobs(ctx: RunContext, deps: DarkPoolJobDeps): Promise<Array<StepResult<void>>> {
  const results: Array<StepResult<void>> = [];
  for (const job of DARK_POOL_DAILY_JOBS) {
    results.push(await runStep(ctx, { key: job.key, label: job.label, onFailure: reportSentence(job.onFailure), retry: 'never', timeoutMs: job.timeoutMs }, () => job.run(deps)));
  }
  return results;
}
