/**
 * Owner 2026-11-05 (profile flag exit.weeklyStops, default OFF): the weekly-stop overlay of one Exit holding. Takes the
 * read the Exit pipeline already made (the daily since-entry / generic read) and re-decides the action from the
 * weekly chart and the owner's rules (analysis/weeklyStops.ts). Pure; the pipeline calls it only when the flag is on.
 */

import type { Chart } from '../../types/chart.ts';
import {
  coherentTargets, decideWeekly, oldStopBreach, weeklyRead, WEEKLY_STOPS,
  type CoherentTargets, type StaleBreach, type WeeklyAction, type WeeklyDecision, type WeeklyRead,
} from '../../analysis/weeklyStops.ts';
import { exitVotes, voteSummary, chartVoteInputs, type Dir, type ModelVote, type VoteSummary } from '../../analysis/exitVote.ts';

/** The comparison's five directions for the vote (from the stored analysis' ComparisonReport). */
export interface VoteDirections { readonly engine?: Dir; readonly schabacker?: Dir; readonly edwardsMagee?: Dir; readonly broker?: Dir; readonly turtle?: Dir }

const DIRS = new Set(['bullish', 'mixed', 'cautionary']);
const dirOf = (x: unknown): Dir => (typeof x === 'string' && DIRS.has(x) ? (x as Dir) : null);
/** The five directions from a ComparisonReport-shaped object (existingDirection, newDirection, ...); null when it is not one. */
export function directionsFromComparison(x: unknown): VoteDirections | null {
  if (x === null || typeof x !== 'object' || !('existingDirection' in x)) return null;
  const o = x as Record<string, unknown>;
  return {
    engine: dirOf(o['existingDirection']), schabacker: dirOf(o['schabackerDirection']), edwardsMagee: dirOf(o['edwardsMageeDirection']),
    broker: o['newModelUnavailable'] === true ? null : dirOf(o['newDirection']), turtle: dirOf(o['turtleDirection']),
  };
}

type Rec = Readonly<Record<string, unknown>>;

export interface WeeklyOverlay {
  readonly action: WeeklyAction;
  readonly headline: string;
  readonly lines: readonly string[];
  readonly weekly: WeeklyRead | null;
  readonly stale: StaleBreach | null;
  readonly targets: CoherentTargets;
  readonly reachedTarget: number | null;
  readonly decision: WeeklyDecision;
  readonly votes: readonly ModelVote[];
  readonly vote: VoteSummary;
}

export interface OverlayInput {
  readonly chart: Chart;
  /** The pipeline's read: since-entry (`chandelierSinceEntry`) or generic (`chandelierGeneric`). For an option, its `technical`. */
  readonly read: Rec;
  /** 'YYYY-MM-DD' the read was measured from (a real or assumed entry); null = generic lookback (800 bars). */
  readonly entryDay: string | null;
  /** Use the entry for the weekly anchor (a real purchase date); an assumed date is older than 26 weeks anyway. */
  readonly realEntry: boolean;
  readonly price: number;
  readonly fundScore: number | null;
  readonly cost: number | null;
  readonly taxRate: number;
  readonly nowMs: number;
  /** The comparison's directions (engine and the four book models); null = those models have no read. */
  readonly directions?: VoteDirections | null;
}

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export function entryIndexOf(chart: Chart, entryDay: string | null): number {
  if (!entryDay) return Math.max(0, chart.closes.length - 800);
  const t = Date.parse(entryDay.length === 10 ? entryDay + 'T00:00:00Z' : entryDay);
  const i = chart.dates.findIndex((d) => new Date(d).getTime() >= t);
  return i < 0 ? chart.closes.length - 1 : i;
}

export function weeklyOverlay(i: OverlayInput): WeeklyOverlay {
  const { chart, read: r } = i;
  const stale = oldStopBreach(chart, entryIndexOf(chart, i.entryDay));
  const weekly = weeklyRead(chart, { entryDay: i.realEntry ? i.entryDay : null, nowMs: i.nowMs, price: i.price });
  const stop = weekly ? weekly.stop : null;
  const n = chart.highs.length;
  const hi52 = n ? Math.max(...chart.highs.slice(Math.max(0, n - 252)).filter(fin)) : null;
  const candidates = [...((r.exitCandidates as number[] | undefined) ?? []), ...(hi52 != null ? [hi52] : [])];
  const t1 = fin(r.t1) ? r.t1 : null, t2 = fin(r.t2) ? r.t2 : null;
  const targets = coherentTargets(i.price, stop, t1, t2, candidates);
  const valid = (t: number | null): t is number => t != null && (stop == null || t > stop) && i.price >= t;
  const reachedTarget = valid(t2) ? t2 : valid(t1) ? t1 : null;
  const votes = exitVotes({ ...(i.directions ?? {}), ...chartVoteInputs(chart), price: i.price, liloT2: t2, weekly, fundScore: i.fundScore });
  const vote = voteSummary(votes);
  const decision = decideWeekly({
    price: i.price, weekly, stale, dailyNegative: !!r.thesisInvalidated, fundScore: i.fundScore, cost: i.cost, taxRate: i.taxRate,
    reachedTarget, targets, vote,
  });
  return { action: decision.action, headline: decision.headline, lines: decision.lines, weekly, stale, targets, reachedTarget, decision, votes, vote };
}

export interface OptionOverlayDecision { readonly actionClass: 'EXIT' | 'REVIEW' | 'TRIM' | 'HOLD'; readonly headline: string }

/**
 * Options under the flag (rule 4): the call follows the underlying's weekly decision. A call with more than 180 days
 * left (or a LEAPS) never exits on the underlying's daily stop; a shorter call exits on a FRESH daily break of the
 * underlying (10 trading days or less), and a stale break falls back to the weekly decision. The expiry rungs are the
 * pipeline's and come first.
 */
export function optionOverlayDecision(o: WeeklyOverlay, daysToExpiry: number | null, isLeaps: boolean, contracts: number | null): OptionOverlayDecision {
  // More than 180 days left = the weekly stop only. Any call (a LEAPS too) never exits on a STALE daily break.
  const long = daysToExpiry != null && daysToExpiry > WEEKLY_STOPS.optionWeeklyDays;
  const s = o.stale;
  if (!long && s && s.breached && !s.stale) {
    if (!o.vote.majority) {
      return { actionClass: 'REVIEW', headline: 'Review: a ' + (daysToExpiry ?? '?') + '-day call and the underlying broke its daily stop ' + s.tradingDaysSince + ' trading days ago (a fresh break), but the models do not agree on a sale: ' + o.vote.text + '.' };
    }
    return { actionClass: 'EXIT', headline: 'Exit: a ' + (daysToExpiry ?? '?') + '-day call and the underlying broke its daily stop ' + s.tradingDaysSince + ' trading days ago (a fresh break); a short-dated call cannot wait for the weekly chart. Model vote: ' + o.vote.text + '.' };
  }
  const body = o.headline.replace(/^(Exit|Review|Hold|Consider trimming): /, '');
  const who = long ? 'Long-dated call (' + daysToExpiry + ' days), follows the underlying\'s weekly stop: ' : (isLeaps ? 'LEAPS' : 'Call') + ' with ' + (daysToExpiry ?? '?') + ' days left, follows the underlying\'s weekly stop: ';
  if (o.action === 'EXIT') return { actionClass: 'EXIT', headline: 'Exit: ' + who + body };
  if (o.action === 'REVIEW') return { actionClass: 'REVIEW', headline: 'Review: ' + who + body };
  // No cost basis is passed for an option (the premium is not the underlying's cost), so a reached target is a trim as before.
  if (o.action === 'TRIM' || (o.action === 'HOLD' && o.reachedTarget != null)) {
    if (o.action === 'HOLD') {
      const t = '$' + (o.reachedTarget as number).toFixed(2);
      return typeof contracts === 'number' && contracts >= 2
        ? { actionClass: 'TRIM', headline: 'Consider trimming: the underlying stock reached its target ' + t + '.' }
        : { actionClass: 'TRIM', headline: 'The underlying stock reached its target ' + t + '. With one contract a partial exit is not possible: hold or exit.' };
    }
    return typeof contracts === 'number' && contracts >= 2
      ? { actionClass: 'TRIM', headline: 'Consider trimming: ' + who + body }
      : { actionClass: 'TRIM', headline: 'Consider trimming: ' + who + body + ' With one contract a partial exit is not possible: hold or exit.' };
  }
  return { actionClass: 'HOLD', headline: 'Hold: ' + who + body };
}
