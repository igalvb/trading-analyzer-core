/**
 * The approved nightly order (F-76) as DATA. Readable by the workflow generator and by tests.
 *
 *   dark pool tracker -> Evaluative Index -> RS ranking -> macro refresh -> option chains -> analysis -> summary -> Buy report
 *   -> Exit report -> options reads stored -> fundamentals history stored -> paper test -> live dry run
 *   (all after the US market close; the user's schedule is a UTC cron, see the workflow generator)
 *
 * dependsOn lists the earlier steps whose OUTPUT this step reads. It never blocks a step: a failed
 * dependency makes the later step run on the last stored data and be reported as "partly done".
 * The 17:00 My Options job is deliberately NOT in this chain (see SEPARATE_JOBS).
 */

import { activeProfile } from '../../profile/active.ts';
import type { Profile } from '../../profile/schema.ts';

export type NightlyStepId =
  | 'darkPool.tracker'
  | 'darkPool.evaluativeIndex'
  | 'darkPool.relativeStrength'
  | 'macro.refresh'
  | 'options.chains'
  | 'analysis.tickers'
  | 'analysis.summary'
  | 'buy.report'
  | 'exit.report'
  | 'options.reads'
  | 'fundamentals.history'
  | 'paper.trade'
  | 'live.dryRun';

export type NightlyStepKind = 'job' | 'tickers' | 'report';

export interface NightlyStepDef {
  readonly id: NightlyStepId;
  readonly label: string;
  readonly kind: NightlyStepKind;
  readonly dependsOn: readonly NightlyStepId[];
  /** Per attempt. For the 'tickers' step this is the whole-phase budget instead (per-ticker limits are options). */
  readonly timeoutMs: number;
  /** Extra attempts after the first (2 = 3 attempts in total). */
  readonly retries: number;
  /** Plain sentence for the report when the step failed. No raw errors. */
  readonly failedText: string;
  /** Plain sentence when the step worked but a step it depends on failed. Empty = never applies. */
  readonly staleText: string;
}

const MIN = 60_000;

/** Every step the nightly knows, in order (NIGHTLY_STEPS is this run's: the profile's features applied). */
export const ALL_NIGHTLY_STEPS: readonly NightlyStepDef[] = [
  {
    id: 'darkPool.tracker', label: 'Dark Pool Tracker refresh', kind: 'job', dependsOn: [], timeoutMs: 20 * MIN, retries: 2,
    failedText: 'The Dark Pool Tracker tab was not refreshed tonight and still shows its last good data.', staleText: '',
  },
  {
    id: 'darkPool.evaluativeIndex', label: 'Evaluative Index refresh', kind: 'job', dependsOn: [], timeoutMs: 15 * MIN, retries: 2,
    failedText: 'The Evaluative Index was not refreshed tonight; reports use its last stored value.', staleText: '',
  },
  {
    id: 'darkPool.relativeStrength', label: 'Relative Strength Ranking refresh', kind: 'job', dependsOn: [], timeoutMs: 15 * MIN, retries: 2,
    failedText: 'The relative-strength ranking was not refreshed tonight; reports use its last stored ranking.', staleText: '',
  },
  {
    id: 'macro.refresh', label: 'Market-wide data refresh', kind: 'job', dependsOn: [], timeoutMs: 15 * MIN, retries: 2,
    failedText: 'The market-wide data was not refreshed tonight; the analysis used the last stored values.', staleText: '',
  },
  {
    // Options sentiment plan A-1 (docs/OPTIONS_SENTIMENT_PLAN.md): every nightly stock's Cboe chain (plus the paper list,
    // SPY and QQQ), once each, into the run-wide memo; the per-stock reads and the market read (part B). Never fails the
    // night: a stock with no chain is recorded "no chain". Shadow phase: nothing it reads is applied to a score yet.
    id: 'options.chains', label: 'Option chains and options reads', kind: 'job', dependsOn: [], timeoutMs: 10 * MIN, retries: 2,
    failedText: 'The option chains were not read tonight; nothing that depends on them changed (the reads are not applied yet).', staleText: '',
  },
  {
    id: 'analysis.tickers', label: 'Stock analysis (portfolio and watchlist)', kind: 'tickers',
    dependsOn: ['darkPool.evaluativeIndex', 'darkPool.relativeStrength', 'macro.refresh'], timeoutMs: 3 * 60 * MIN, retries: 2,
    failedText: 'No stock could be analysed tonight.',
    staleText: 'The analysis ran, but some market-wide inputs were not refreshed tonight, so they come from earlier data.',
  },
  {
    id: 'analysis.summary', label: 'Watchlist summary and decision changes', kind: 'job', dependsOn: ['analysis.tickers'], timeoutMs: 10 * MIN, retries: 2,
    failedText: 'The watchlist summary and the list of decision changes were not produced tonight.', staleText: '',
  },
  {
    id: 'buy.report', label: 'Buy report', kind: 'report', dependsOn: ['analysis.tickers'], timeoutMs: 10 * MIN, retries: 2,
    failedText: 'The Buy report was not updated tonight and still shows its last version.',
    staleText: 'The Buy report was built, but it relies on inputs that were not refreshed tonight.',
  },
  {
    id: 'exit.report', label: 'Exit Strategy report', kind: 'report', dependsOn: ['darkPool.evaluativeIndex', 'analysis.tickers'], timeoutMs: 10 * MIN, retries: 2,
    failedText: 'The Exit Strategy report was not updated tonight and still shows its last version.',
    staleText: 'The Exit Strategy report was built, but it relies on inputs that were not refreshed tonight.',
  },
  {
    // Options sentiment plan A-3 / A-8: tonight's per-stock reads with the "if applied" shadow columns (📈 Options Reads,
    // 📦 Options Read Snapshots). Needs the analysis for the shadow columns; writes nothing a report reads.
    id: 'options.reads', label: 'Options reads stored' + (activeProfile().options.applied ? '' : ' (not yet applied)'), kind: 'job', dependsOn: ['options.chains', 'analysis.tickers'], timeoutMs: 5 * MIN, retries: 2,
    failedText: 'Tonight\'s options reads were not stored; the reports are unchanged (the reads are not applied yet).', staleText: '',
  },
  {
    // Requirement K (owner 2026-11-04, backlog row 39): the fundamentals each analysis already fetched, appended to
    // 💾 Fundamentals History when a value changed. No provider call, no score change; its job never throws.
    id: 'fundamentals.history', label: 'Fundamentals history stored', kind: 'job', dependsOn: ['analysis.tickers'], timeoutMs: 5 * MIN, retries: 2,
    failedText: 'Tonight\'s fundamentals were not added to the Fundamentals History tab; the reports are unchanged.', staleText: '',
  },
  {
    id: 'paper.trade', label: 'Paper trading (1-year test)', kind: 'job', dependsOn: ['analysis.tickers', 'buy.report', 'exit.report'], timeoutMs: 20 * MIN, retries: 2,
    failedText: 'The paper test did not run tonight; it continues from its last saved day on the next run.', staleText: '',
  },
  {
    // The live broker bot, phase 1 (docs/live-broker/phases/1-planner-dry-run.md): a plan only, no broker. Its job
    // never throws (live/liveJob.ts), so a failure cannot touch the steps before it.
    id: 'live.dryRun', label: 'Live bot dry run (no broker)', kind: 'job', dependsOn: ['paper.trade'], timeoutMs: 5 * MIN, retries: 2,
    failedText: 'The live bot dry run did not run tonight; nothing is traded in this phase (no broker is connected).', staleText: '',
  },
];

/**
 * GENERIC_PLAN P2 (C20, C21): the steps a profile's features keep. `features.paper` off drops the paper test,
 * `features.liveBot` off drops the live dry run; nothing else changes (a kept step's dependsOn loses only the
 * dropped steps).
 */
export function nightlyStepsFor(f: Pick<Profile['features'], 'paper' | 'liveBot'>): readonly NightlyStepDef[] {
  const off = new Set<NightlyStepId>([...(f.paper ? [] : ['paper.trade' as const]), ...(f.liveBot ? [] : ['live.dryRun' as const])]);
  if (!off.size) return ALL_NIGHTLY_STEPS;
  return ALL_NIGHTLY_STEPS.filter((s) => !off.has(s.id)).map((s) => (s.dependsOn.some((d) => off.has(d)) ? { ...s, dependsOn: s.dependsOn.filter((d) => !off.has(d)) } : s));
}

/** This run's nightly steps (the profile's features applied). */
export const NIGHTLY_STEPS: readonly NightlyStepDef[] = nightlyStepsFor(activeProfile().features);

export const NIGHTLY_ORDER: readonly NightlyStepId[] = NIGHTLY_STEPS.map((s) => s.id);

export function stepDef(id: NightlyStepId): NightlyStepDef {
  const d = ALL_NIGHTLY_STEPS.find((s) => s.id === id);
  if (!d) throw new Error('unknown nightly step ' + id);
  return d;
}

/** Jobs that are scheduled on their own and are NOT part of the nightly chain. */
export const SEPARATE_JOBS = [
  {
    id: 'myOptions.refresh', label: 'My Options value refresh', inNightlyChain: false,
    atHour: 17, timeZone: 'America/New_York', handler: 'refreshMyOptionsValue',
    note: 'Own workflow around 17:00 (see MY_OPTIONS_DAILY_JOB); never run from the nightly chain.',
  },
] as const;
