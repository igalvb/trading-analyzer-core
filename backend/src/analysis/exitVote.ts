/**
 * Owner 2026-11-05: "The exit strategy is a serious strategy. It must take into account ALL the models and engines."
 * Behind the profile flag exit.weeklyStops (default OFF). Pure. Each model the system already runs gives one read on a
 * held position -- SELL / HOLD / BUY, or n/a when it has no read -- with a plain why:
 *
 *   Engine, Schabacker, Edwards & Magee, Broker Course, Turtle  the comparison directions (cautionary = SELL,
 *                                                                bullish = BUY, mixed = HOLD)
 *   Combo 2-of-3                                                 2 of Turtle / Schabacker / E&M cautionary = SELL
 *   Wyckoff (original method)                                    its direction (distribution / markdown = SELL)
 *   Trend 150, Trend 200                                         close more than 3% under the average = SELL
 *   LILO v2                                                      its stop: close more than 3% under the 200-day average
 *   LILO                                                         its plan sells at T2 (price at or over T2 = SELL)
 *   Weekly chart                                                 weekly close under the weekly stop AND the 40-week average
 *   Fundamentals (own score)                                     under 43 (weak / avoid) = SELL, 70+ (own-worthy) = BUY
 *
 * The bar for an exit (on top of rules A-C in weeklyStops.ts): at least 5 models with a read, at least 2/3 of them say
 * SELL, the engine is one of them, and at least one trend model (Trend 150, Trend 200 or the weekly chart) is too.
 */

import { trendSeries, type TrendDay } from './models/trendFollow.ts';
import { wyckoffClassicSeries } from './models/wyckoffClassic.ts';
import type { WeeklyRead } from './weeklyStops.ts';

export type VoteRead = 'SELL' | 'HOLD' | 'BUY' | 'NA';
export type VoteModel = 'Engine' | 'Schabacker' | 'Edwards & Magee' | 'Broker Course' | 'Turtle' | 'Combo 2-of-3' | 'Wyckoff' | 'Trend 150' | 'Trend 200' | 'LILO v2' | 'LILO' | 'Weekly chart' | 'Fundamentals';
export interface ModelVote { readonly model: VoteModel; readonly read: VoteRead; readonly why: string }

export const EXIT_VOTE = { minReads: 5, sellShare: 2 / 3, ownWorthy: 70, weakBelow: 43, trendBand: 0.03 } as const;
const TREND_MODELS: readonly VoteModel[] = ['Trend 150', 'Trend 200', 'Weekly chart'];

export type Dir = 'bullish' | 'mixed' | 'cautionary' | null | undefined;
export interface VoteInputs {
  /** The comparison's five directions (absent / null = that model did not run). */
  readonly engine?: Dir; readonly schabacker?: Dir; readonly edwardsMagee?: Dir; readonly broker?: Dir; readonly turtle?: Dir;
  readonly wyckoff?: Dir;
  readonly trend150?: TrendDay | null;
  readonly trend200?: TrendDay | null;
  readonly price: number;
  /** The plan's T2 (LILO sells there). */
  readonly liloT2?: number | null;
  readonly weekly?: WeeklyRead | null;
  readonly fundScore?: number | null;
}

const usd = (n: number): string => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const READ_OF: Readonly<Record<string, VoteRead>> = { cautionary: 'SELL', bullish: 'BUY', mixed: 'HOLD' };
const dirVote = (model: VoteModel, d: Dir, what: string): ModelVote =>
  d ? { model, read: READ_OF[d]!, why: what + ' reads ' + d + '.' } : { model, read: 'NA', why: 'no read this run.' };

function trendVote(model: VoteModel, t: TrendDay | null | undefined, days: number, price: number): ModelVote {
  if (!t || t.sma == null || t.strength == null) return { model, read: 'NA', why: 'not enough history for the ' + days + '-day average.' };
  const pct = (t.strength * 100).toFixed(1);
  const where = 'price ' + usd(price) + ' is ' + (t.strength >= 0 ? pct + '% above' : Math.abs(+pct) + '% under') + ' the ' + days + '-day average ' + usd(t.sma);
  return { model, read: t.direction === 'cautionary' ? 'SELL' : t.direction === 'bullish' ? 'BUY' : 'HOLD', why: where + (t.direction === 'cautionary' ? ' (more than 3% under: sell).' : '.') };
}

export function exitVotes(i: VoteInputs): ModelVote[] {
  const v: ModelVote[] = [
    dirVote('Engine', i.engine, 'the engine'),
    dirVote('Schabacker', i.schabacker, 'Schabacker'),
    dirVote('Edwards & Magee', i.edwardsMagee, 'Edwards & Magee'),
    dirVote('Broker Course', i.broker, 'the Broker Course'),
    dirVote('Turtle', i.turtle, 'Turtle'),
  ];
  const three = [i.turtle, i.schabacker, i.edwardsMagee].filter((d): d is 'bullish' | 'mixed' | 'cautionary' => !!d);
  if (three.length < 2) v.push({ model: 'Combo 2-of-3', read: 'NA', why: 'fewer than 2 of Turtle / Schabacker / E&M ran.' });
  else {
    const c = three.filter((d) => d === 'cautionary').length, b = three.filter((d) => d === 'bullish').length;
    v.push({ model: 'Combo 2-of-3', read: c >= 2 ? 'SELL' : b >= 2 ? 'BUY' : 'HOLD', why: c + ' of 3 cautionary, ' + b + ' bullish.' });
  }
  v.push(dirVote('Wyckoff', i.wyckoff, 'Wyckoff (original method)'));
  v.push(trendVote('Trend 150', i.trend150, 150, i.price));
  v.push(trendVote('Trend 200', i.trend200, 200, i.price));
  const t2 = i.trend200;
  v.push(!t2 || t2.strength == null ? { model: 'LILO v2', read: 'NA', why: 'not enough history for its 200-day stop.' }
    : t2.strength < -EXIT_VOTE.trendBand ? { model: 'LILO v2', read: 'SELL', why: 'its stop: the price is more than 3% under the 200-day average.' }
      : { model: 'LILO v2', read: 'HOLD', why: 'its stop (3% under the 200-day average) is not hit.' });
  v.push(i.liloT2 == null ? { model: 'LILO', read: 'NA', why: 'no plan T2 this run.' }
    : i.price >= i.liloT2 ? { model: 'LILO', read: 'SELL', why: 'the price reached its T2 ' + usd(i.liloT2) + ' (a profit sale).' }
      : { model: 'LILO', read: 'HOLD', why: 'its sale is at T2 ' + usd(i.liloT2) + ', not reached.' });
  const w = i.weekly;
  v.push(!w ? { model: 'Weekly chart', read: 'NA', why: 'too little weekly history.' }
    : w.trendBroken ? { model: 'Weekly chart', read: 'SELL', why: 'weekly close ' + usd(w.weekClose) + ' under the weekly stop ' + usd(w.stop) + ' and the 40-week average.' }
      : { model: 'Weekly chart', read: 'HOLD', why: 'weekly trend not broken (weekly stop ' + usd(w.stop) + (w.ma40 != null ? ', 40-week average ' + usd(w.ma40) : '') + ').' });
  const f = i.fundScore;
  v.push(f == null ? { model: 'Fundamentals', read: 'NA', why: 'no own score this run.' }
    : { model: 'Fundamentals', read: f < EXIT_VOTE.weakBelow ? 'SELL' : f >= EXIT_VOTE.ownWorthy ? 'BUY' : 'HOLD', why: 'own score ' + f + (f < EXIT_VOTE.weakBelow ? ' (weak).' : f >= EXIT_VOTE.ownWorthy ? ' (own-worthy).' : ' (between weak and own-worthy).') });
  return v;
}

export interface VoteSummary {
  readonly sells: number;
  readonly reads: number;
  readonly total: number;
  readonly engineSells: boolean;
  readonly trendSells: boolean;
  /** The exit bar is met. */
  readonly majority: boolean;
  /** "3 of 11 models say sell (2 buy, 6 hold; 2 with no read)". */
  readonly text: string;
}

export function voteSummary(votes: readonly ModelVote[]): VoteSummary {
  const reads = votes.filter((v) => v.read !== 'NA');
  const sells = reads.filter((v) => v.read === 'SELL').length, buys = reads.filter((v) => v.read === 'BUY').length;
  const engineSells = votes.some((v) => v.model === 'Engine' && v.read === 'SELL');
  const trendSells = votes.some((v) => TREND_MODELS.includes(v.model) && v.read === 'SELL');
  const majority = reads.length >= EXIT_VOTE.minReads && sells >= Math.ceil(reads.length * EXIT_VOTE.sellShare) && engineSells && trendSells;
  const na = votes.length - reads.length;
  return {
    sells, reads: reads.length, total: votes.length, engineSells, trendSells, majority,
    text: sells + ' of ' + reads.length + ' models say sell (' + buys + ' buy, ' + (reads.length - sells - buys) + ' hold' + (na ? '; ' + na + ' with no read' : '') + ')',
  };
}

/** Why the vote bar is not met (empty when it is). */
export function voteShortfall(s: VoteSummary): string {
  const bits: string[] = [];
  if (s.reads < EXIT_VOTE.minReads) bits.push('only ' + s.reads + ' models have a read (needs ' + EXIT_VOTE.minReads + ')');
  else if (s.sells < Math.ceil(s.reads * EXIT_VOTE.sellShare)) bits.push('an exit needs ' + Math.ceil(s.reads * EXIT_VOTE.sellShare) + ' of ' + s.reads + ' (2/3)');
  if (!s.engineSells) bits.push('the engine does not say sell');
  if (!s.trendSells) bits.push('no trend model says sell');
  return bits.join(', ');
}

/** The chart-only reads (Trend 150 / 200, Wyckoff) at the last bar. */
export function chartVoteInputs(chart: { readonly opens: readonly number[]; readonly highs: readonly number[]; readonly lows: readonly number[]; readonly closes: readonly number[]; readonly volumes: readonly number[] }):
  { trend150: TrendDay | null; trend200: TrendDay | null; wyckoff: Dir } {
  const t150 = trendSeries(chart.closes, 150), t200 = trendSeries(chart.closes, 200);
  const wy = chart.closes.length ? wyckoffClassicSeries(chart) : [];
  return { trend150: t150[t150.length - 1] ?? null, trend200: t200[t200.length - 1] ?? null, wyckoff: wy[wy.length - 1]?.direction ?? null };
}
