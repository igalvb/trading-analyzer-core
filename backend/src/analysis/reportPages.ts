/**
 * FL-17e: the per-ticker report pages the owner asked for (2026-10-28), DISPLAY ONLY.
 *
 *   🏛️ Wyckoff Model     the original-method read, plus the older engine read for reference
 *   📈 Trend Model       Trend 150 and Trend 200
 *   🧩 Combo Models      the Turtle + Schabacker + E&M 2-of-3 combo, and "Everything together"
 *   🪜 LILO Model        the staged Layer-In / Layer-Out ladder for this ticker today
 *   🧮 All Models        one row per model: today's read, why, how it trades in the simulation, its history
 *   📞 Options Decision  long calls only: BUY NOW / WAIT / DON'T BUY for the LEAPS and short-term picks
 *
 * Every value is one the run already computed (the decision, the tech plan, the confluence zone, the comparison,
 * the extra model reads, the options picks and the options snapshot). Nothing here feeds a score, the conviction,
 * the verdict, the timing or a Buy report tier, and nothing is fetched.
 */

import {
  EXTRA_MODEL_NAMES, ENGINE_WYCKOFF_NAME, EVERYTHING_NAME, EXTRA_MODELS_DISCLAIMER, ENGINE_BUY_MIN_CONVICTION,
  directionWord, engineSaysBuy, timingWords, type ExtraModelsReport, type ExtraModelRead, type ExtraModelId, type ExtraDirection,
} from './extraModels.ts';
import {
  computeStockEntryLadder, computeStockExitLadder, computeOptionsEntryLadder, ladderDisplayPercents, optionsLadderTimeDecayNote, type LadderRung,
} from './ladders.ts';
import { EXPIRY_WARNING_DAYS_LEAPS, EXPIRY_WARNING_DAYS_SHORT_TERM } from './optionsExitRead.ts';
import { tierOf, BUY_TIER1_MIN_CONVICTION } from '../jobs/buy/buyPipeline.ts';
import { OWN_BLOCK_FLOOR } from '../types/decision.ts';
import { formatDateInTz } from '../core/dates.ts';
import {
  IV_CHAIN_PCT_LABEL, IV_CHAIN_PCT_MEANING, PUT_CALL_LABEL, PUT_CALL_BANDS_TEXT, pickLabel, putCallText,
} from './options/labels.ts';
import type { ReportSheet } from '../sheets/reportSheet.ts';
import type { AtBuyLimit } from './atBuyLimit.ts';
import type { NextResistance, FixedT2Display } from './nextResistance.ts';
import { jamesAllModelsRows, type JamesReads } from './jamesPages.ts';
import { james2AllModelsRows, type James2Reads } from './jamesPhase2Pages.ts';
import { james3AllModelsRows, type James3Reads } from './jamesPhase3Pages.ts';
import { james5AllModelsRows, type James5Reads } from './jamesPhase5Pages.ts';
import { RESULTS, NO_HISTORY } from '../profile/results.ts';
import { james4AllModelsRows, optionsDecisionJamesLines, type James4Reads, type JamesLeapsRead } from './jamesPhase4Pages.ts';
import { readShortTermExit, WEEKLY_EXIT } from './options/weeklyExit.ts';
import { leapsExpiryComparisonLines, leapsExpiryComparisonOf, type LeapsExpiryComparison } from './options/leapsExpiryTable.ts';

export const PAGE_DISCLAIMER = 'Shown for information only: nothing on this page changes any score, the conviction, the verdict or the Buy report tiers.';

const usd = (n: number): string => '$' + n.toFixed(2);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

// ─────────────────────────────── inputs (loose: they arrive through the pipelines) ───────────────────────────────

export interface PageDecision { readonly action?: string | null; readonly finalConviction?: number | null }
export interface PageTechPlan {
  readonly timing?: string | null;
  readonly regime?: string | null;
  readonly stop?: number | null;
  readonly entryPrice?: number | null;
  readonly entryLow?: number | null;
  readonly entryHigh?: number | null;
  readonly t1?: { readonly price: number } | null;
  readonly t2?: { readonly price: number } | null;
  /** Expected trading days for the stock to reach T1 / T2 (entryPlan timeToPrice). */
  readonly t1Time?: { readonly baseDays?: number | null } | null;
  readonly t2Time?: { readonly baseDays?: number | null } | null;
}
export interface PageConfluence { readonly entryLow?: number | null; readonly entryHigh?: number | null; readonly entryCount?: unknown; /** The engine's sell zone starts here. */ readonly exitLow?: number | null }
/** The daily chart the short-term exit rule builds its weekly bars from (owner 2026-10-30). */
export interface PageChart { readonly dates: readonly (Date | number | string)[]; readonly closes: readonly number[]; readonly currentPrice?: number | null }
export interface PageFund { readonly score?: number | null }
export interface PageComparison {
  readonly existingDirection?: string | null; readonly newDirection?: string | null;
  readonly schabackerDirection?: string | null; readonly edwardsMageeDirection?: string | null; readonly turtleDirection?: string | null;
  readonly newHeadline?: string | null; readonly schabackerHeadline?: string | null; readonly edwardsMageeHeadline?: string | null; readonly turtleHeadline?: string | null;
  readonly verdict?: string | null;
}
export interface PageOptionsFlow { readonly available?: boolean; readonly leapsLean?: number | null; readonly ivRank?: number | null; readonly putCallOI?: number | null }

const isDir = (x: unknown): x is ExtraDirection => x === 'bullish' || x === 'mixed' || x === 'cautionary';

// ─────────────────────────────── the engine's buy reads ───────────────────────────────

/** Owner 4f (backtest/policy.ts HOLD_OFF_VERDICTS): the comparison verdicts that hold a Buy report buy off. */
export const HOLD_OFF_VERDICTS: readonly string[] = ['SPLIT', 'NO_CONSENSUS'];

export interface BuyRead { readonly buy: boolean | null; readonly why: string }

const convText = (d: PageDecision | null | undefined, tp: PageTechPlan | null | undefined): string =>
  'conviction ' + (num(d?.finalConviction) ?? 'not available') + ', timing: ' + timingWords(tp?.timing);

/** Engine alone: conviction >= 70 or timing BUY_NOW (paper/paperLab.ts 'engine', research/lab.ts tier1). */
export function engineAloneRead(d: PageDecision | null | undefined, tp: PageTechPlan | null | undefined): BuyRead {
  const b = engineSaysBuy({ finalConviction: d?.finalConviction ?? null, timing: tp?.timing ?? null });
  if (b == null) return { buy: null, why: 'The engine gave no decision this run.' };
  return { buy: b, why: cap(convText(d, tp)) + (b ? '.' : ' (it buys at conviction ' + ENGINE_BUY_MIN_CONVICTION + '+ or timing buy now).') };
}

/** The Buy report's tier 1 (jobs/buy/buyPipeline.ts tierOf: not blocked by the fundamentals floor, BUY_NOW or conviction >= 70). */
export function isTier1Buy(d: PageDecision | null | undefined, tp: PageTechPlan | null | undefined, fund: PageFund | null | undefined): boolean {
  const own = num(fund?.score);
  return tierOf({ decision: !!d && num(d.finalConviction) != null, blocked: own != null && own <= OWN_BLOCK_FLOOR, buyNow: tp?.timing === 'BUY_NOW', conviction: num(d?.finalConviction) }) === 1;
}

/** Engine + models (the current Buy report rule, backtest/policy.ts buyCheck): tier 1 AND the 5-model verdict is not SPLIT / NO_CONSENSUS. */
export function engineWithModelsRead(d: PageDecision | null | undefined, tp: PageTechPlan | null | undefined, fund: PageFund | null | undefined, cmp: PageComparison | null | undefined): BuyRead {
  if (!d || num(d.finalConviction) == null) return { buy: null, why: 'The engine gave no decision this run.' };
  const own = num(fund?.score);
  if (own != null && own <= OWN_BLOCK_FLOOR) return { buy: false, why: 'Blocked: the fundamentals score (' + own + ') is at or under ' + OWN_BLOCK_FLOOR + '.' };
  if (!isTier1Buy(d, tp, fund)) return { buy: false, why: 'Not a tier-1 buy (' + convText(d, tp) + '; it needs conviction ' + BUY_TIER1_MIN_CONVICTION + '+ or timing buy now).' };
  const v = cmp?.verdict ?? null;
  if (v == null) return { buy: false, why: 'Tier-1 buy, but the 5-model agreement could not be checked (no comparison this run).' };
  if (HOLD_OFF_VERDICTS.includes(v)) return { buy: false, why: 'Tier-1 buy, held off: the 5 models do not agree (' + (v === 'SPLIT' ? 'split 2 against 2' : 'no majority') + ').' };
  return { buy: true, why: 'Tier-1 buy (' + convText(d, tp) + ') and the 5 models agree (' + (v === 'ALL_AGREE' ? 'all agree' : 'majority') + ').' };
}

// ─────────────────────────────── 🏛️ Wyckoff / 📈 Trend / 🧩 Combo ───────────────────────────────

const modelOf = (r: ExtraModelsReport | null | undefined, id: ExtraModelId): ExtraModelRead | null => (r ? r.models.find((m) => m.id === id) ?? null : null);
const NO_READS = 'No reads — the price data was not available.';

function section(out: string[], n: number, m: ExtraModelRead | null, name: string): void {
  out.push('', n + '. ' + name.toUpperCase() + ': ' + directionWord(m ? m.direction : null));
  for (const d of m ? m.detail : ['Not available this run.']) out.push('  - ' + d);
}

export function formatWyckoffPage(r: ExtraModelsReport | null | undefined, ticker: string): string {
  if (!r) return NO_READS;
  const out = ['── ' + (r.ticker || ticker) + ' — Wyckoff Model ──', '', EXTRA_MODELS_DISCLAIMER];
  section(out, 1, modelOf(r, 'WYCKOFF_CLASSIC'), EXTRA_MODEL_NAMES.WYCKOFF_CLASSIC);
  out.push('', '2. ' + ENGINE_WYCKOFF_NAME.toUpperCase() + ' — FOR REFERENCE: ' + (r.engineWyckoff.found ? 'Found' : 'None'));
  out.push('  - ' + r.engineWyckoff.summary);
  out.push('  - The older Wyckoff read of the main engine, kept for reference; it is not the original method above and is not scored.');
  return out.join('\n');
}

export function formatTrendPage(r: ExtraModelsReport | null | undefined, ticker: string): string {
  if (!r) return NO_READS;
  const out = ['── ' + (r.ticker || ticker) + ' — Trend Model ──', '', EXTRA_MODELS_DISCLAIMER];
  section(out, 1, modelOf(r, 'TREND_150'), EXTRA_MODEL_NAMES.TREND_150);
  section(out, 2, modelOf(r, 'TREND_200'), EXTRA_MODEL_NAMES.TREND_200);
  out.push('', 'In the simulation: buy when the read is bullish; sell when the close is more than 3% under the average (the read turns cautionary).');
  return out.join('\n');
}

export function formatComboPage(r: ExtraModelsReport | null | undefined, ticker: string): string {
  if (!r) return NO_READS;
  const out = ['── ' + (r.ticker || ticker) + ' — Combo Models ──', '', EXTRA_MODELS_DISCLAIMER];
  section(out, 1, modelOf(r, 'COMBO_TSE'), EXTRA_MODEL_NAMES.COMBO_TSE);
  out.push('  - In the simulation: sold when the close is more than 3% under the 200-day average.');
  const e = r.everything;
  out.push('', '2. ' + EVERYTHING_NAME.toUpperCase() + ': ' + (e ? (e.buy == null ? 'Not available' : e.buy ? 'Buy' : 'No buy') : 'Not available'));
  for (const d of e ? e.detail : ['Not available this run.']) out.push('  - ' + d);
  return out.join('\n');
}

// ─────────────────────────────── 🪜 LILO ───────────────────────────────

/** research/liloBook.ts LILO_ORDER_DAYS (kept here so the report does not load the research code). */
export const LILO_ORDER_DAYS = 20;

export interface LiloRead {
  /** true = LILO places a ladder today (tier-1 buy read with a ladder); false = no ladder; null = no decision. */
  readonly placed: boolean | null;
  readonly why: string;
  readonly entryRungs: readonly LadderRung[];
  readonly entryPercents: readonly number[];
  readonly exitRungs: readonly LadderRung[];
  readonly exitPercents: readonly number[];
  readonly entryLow: number | null;
  readonly entryHigh: number | null;
  readonly entryCount: number | null;
  readonly stop: number | null;
}

/** The ladder from the run's own values: the confluence zone (as the dashboard and the Buy report), T1/T2 and the stop. */
export function buildLiloRead(conf: PageConfluence | null | undefined, tp: PageTechPlan | null | undefined, d: PageDecision | null | undefined): LiloRead {
  const entryLow = num(conf?.entryLow), entryHigh = num(conf?.entryHigh);
  const count = conf?.entryCount;
  let entryRungs: LadderRung[] = [];
  let exitRungs: LadderRung[] = [];
  try { entryRungs = conf && entryLow != null && entryHigh != null ? computeStockEntryLadder({ entryCount: count, entryLow, entryHigh }) : []; } catch { entryRungs = []; }
  try { exitRungs = tp ? computeStockExitLadder({ t1: tp.t1 ?? null, t2: tp.t2 ?? null }) : []; } catch { exitRungs = []; }
  const eng = engineSaysBuy({ finalConviction: d?.finalConviction ?? null, timing: tp?.timing ?? null });
  let placed: boolean | null, why: string;
  if (eng == null) { placed = null; why = 'The engine gave no decision this run, so LILO places no ladder.'; }
  else if (!eng) { placed = false; why = 'Not a tier-1 buy read today (' + convText(d, tp) + '); LILO only places a ladder on a tier-1 buy (conviction ' + ENGINE_BUY_MIN_CONVICTION + '+ or timing buy now).'; }
  else if (!entryRungs.length) { placed = false; why = 'A tier-1 buy read, but no price-level methods agreed on a buy zone today, so there are no buy rungs.'; }
  else { placed = true; why = 'A tier-1 buy read (' + convText(d, tp) + ') with a buy zone: LILO places the ladder.'; }
  return {
    placed, why, entryRungs, entryPercents: ladderDisplayPercents(entryRungs), exitRungs, exitPercents: ladderDisplayPercents(exitRungs),
    entryLow, entryHigh, entryCount: Number.isInteger(count) ? (count as number) : null, stop: num(tp?.stop),
  };
}

export function liloSummary(l: LiloRead): string {
  return (l.placed ? 'Ladder placed' : 'No ladder') + ' — ' + l.why;
}

export function formatLiloPage(ticker: string, l: LiloRead, opts: { readonly leapsCall?: unknown; readonly optionsRun?: boolean; readonly atBuyLimit?: AtBuyLimit | null; readonly nextResistance?: NextResistance | null; readonly fixedT2?: FixedT2Display | null } = {}): string {
  const out = ['── ' + ticker + ' — LILO Model (Layer In, Layer Out) ──', '', PAGE_DISCLAIMER];
  out.push('', '1. TODAY: ' + (l.placed ? 'LADDER PLACED' : 'NO LADDER'));
  out.push('  ' + l.why);
  out.push('', '2. BUY ZONE');
  out.push(l.entryLow != null && l.entryHigh != null
    ? '  ' + usd(l.entryLow) + ' to ' + usd(l.entryHigh) + ' (' + (l.entryCount ?? 0) + ' price-level method' + (l.entryCount === 1 ? '' : 's') + ' agree)'
    : '  No buy zone this run.');
  // E1 (option A, label only): the price is already inside/below the zone, above the stop
  if (opts.atBuyLimit) out.push('  ' + opts.atBuyLimit.text);
  out.push('', '3. BUY RUNGS (limit buys)');
  if (!l.entryRungs.length) out.push('  None — no price-level methods agreed on a buy zone today.');
  l.entryRungs.forEach((r, i) => out.push('  Rung ' + r.rung + ': buy ' + l.entryPercents[i] + '% of the position at ' + usd(r.price)));
  out.push('', '4. SELL RUNGS (limit sells)');
  if (!l.exitRungs.length) out.push('  None — no targets this run.');
  l.exitRungs.forEach((r, i) => out.push('  ' + (r.rung === 1 ? 'T1' : 'T2') + ': sell ' + l.exitPercents[i] + '% of the position at ' + usd(r.price)));
  // B1 option B (display only): the sell rungs stay at T1 / T2
  if (opts.fixedT2 && l.exitRungs.some((r) => r.rung === 2)) out.push('  ' + opts.fixedT2.text + ' (shown only; the T2 rung stays as above)');
  if (opts.nextResistance) out.push('  ' + opts.nextResistance.text + ' (shown only; the sell rungs stay at T1 / T2)');
  out.push('', '5. STOP');
  out.push(l.stop != null ? '  ' + usd(l.stop) + ' — if the price falls to it, sell what was bought.' : '  No stop this run.');
  out.push('', '6. OPTIONS LADDER (the same call, bought in steps)');
  if (opts.optionsRun === false) out.push('  Options data was not run for this report.');
  const leaps = opts.leapsCall as { found?: boolean; contract?: { strike?: number; expUnix?: number } } | null | undefined;
  if (leaps && leaps.found && leaps.contract && num(leaps.contract.strike) != null) out.push('  Contract: the LEAPS pick, the $' + leaps.contract.strike + ' call (see 📞 Options Decision).');
  if (!l.entryRungs.length) out.push('  No rungs today.');
  l.entryRungs.forEach((r, i) => out.push('  Rung ' + r.rung + ': buy ' + l.entryPercents[i] + '% of the contracts when the stock reaches ' + usd(r.price)));
  out.push('  ' + optionsLadderTimeDecayNote());
  out.push('', '7. THE RULES');
  out.push('  - LILO only applies on a tier-1 buy read: conviction ' + ENGINE_BUY_MIN_CONVICTION + ' or more, or timing buy now, with a buy zone.');
  out.push('  - The buy rungs wait as limit buys for ' + LILO_ORDER_DAYS + ' trading days; rungs not filled by then are cancelled.');
  out.push('  - T1 and T2 wait as limit sells; the stop protects the position.');
  out.push('  - When every rung is done, what is left is sold at the close.');
  out.push('  - In the simulation, up to 5 ladders run at a time.');
  return out.join('\n');
}

// ─────────────────────────────── 📞 Options Decision ───────────────────────────────

export type OptionsVerdict = 'BUY NOW' | 'WAIT' | "DON'T BUY";

export interface OptionsVerdictInput {
  /** The run looked for a contract (options analysis ran). */
  readonly optionsRun: boolean;
  /** A contract was found. */
  readonly found: boolean;
  readonly timing: string | null | undefined;
  readonly regime: string | null | undefined;
  /** The decision is a buy (the Buy report's tier 1). */
  readonly isBuy: boolean;
  readonly conviction?: number | null;
}

/**
 * The options verdict, only from what the run decided. DON'T BUY first (no options data, no contract, timing AVOID,
 * the regime blocks new entries, not a buy), then WAIT (timing WAIT_PULLBACK), then BUY NOW (a buy with timing BUY_NOW).
 */
export function optionsVerdict(i: OptionsVerdictInput): { verdict: OptionsVerdict; reason: string } {
  if (!i.optionsRun) return { verdict: "DON'T BUY", reason: 'Options data was not run for this report, so there is no contract to buy.' };
  if (!i.found) return { verdict: "DON'T BUY", reason: 'No contract was found.' };
  if (i.timing === 'AVOID') return { verdict: "DON'T BUY", reason: 'The stock timing says avoid.' };
  if (i.regime != null && i.regime !== 'TREND_UP') {
    const r = i.regime === 'TREND_DOWN' ? 'the stock is in a downtrend' : i.regime === 'HIGH_VOL' ? 'the stock is too volatile right now' : 'the stock has no clear trend';
    return { verdict: "DON'T BUY", reason: 'No new entries: ' + r + '.' };
  }
  if (!i.isBuy) return { verdict: "DON'T BUY", reason: 'The engine does not say buy (conviction ' + (i.conviction ?? 'not available') + ', timing: ' + timingWords(i.timing) + '; a buy needs conviction ' + BUY_TIER1_MIN_CONVICTION + '+ or timing buy now).' };
  if (i.timing === 'WAIT_PULLBACK') return { verdict: 'WAIT', reason: 'The stock is a buy, but the timing says wait for a pullback.' };
  if (i.timing === 'BUY_NOW') return { verdict: 'BUY NOW', reason: 'The stock is a buy and the timing says buy now.' };
  return { verdict: "DON'T BUY", reason: 'The stock timing is not available.' };
}

interface Contract { readonly strike: number; readonly expUnix: number; readonly delta: number; readonly iv?: number | null; readonly bid?: number | null; readonly ask?: number | null; readonly symbol?: string }
interface OptPick { readonly found?: boolean; readonly reason?: string; readonly contract?: Contract; readonly allCandidates?: readonly Contract[] }

const pickOf = (x: unknown): OptPick | null => (x && typeof x === 'object' ? (x as OptPick) : null);
const expiryDate = (expUnix: number): string => formatDateInTz(new Date(expUnix * 1000), 'UTC', 'yyyy-MM-dd');

/** Calendar days from today (in the report's zone) to the expiry date. */
export function daysToExpiry(expUnix: number, nowMs: number, timeZone: string): number {
  const today = formatDateInTz(new Date(nowMs), timeZone, 'yyyy-MM-dd');
  return Math.round((Date.parse(expiryDate(expUnix) + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86_400_000);
}

function contractLines(c: Contract, nowMs: number, timeZone: string): string[] {
  const ask = num(c.ask), bid = num(c.bid);
  return [
    '  Contract: $' + c.strike + ' call, expires ' + expiryDate(c.expUnix) + ' (' + daysToExpiry(c.expUnix, nowMs, timeZone) + ' days away)',
    '  Delta ' + (num(c.delta) != null ? c.delta.toFixed(2) : 'not available') + '  ·  IV ' + (num(c.iv) ? ((c.iv as number) * 100).toFixed(1) + '%' : 'not available')
      + '  ·  Bid/ask ' + (bid != null ? usd(bid) : '—') + ' / ' + (ask != null ? usd(ask) : '—'),
    '  Breakeven at expiry: ' + (ask != null && ask > 0 ? usd(c.strike + ask) + ' (strike + ask)' : 'not available (no ask price)'),
  ];
}

/** Calendar days a target needs (its expected trading days x 7/5), or null when the run has no estimate. */
const calendarDaysTo = (tt: { readonly baseDays?: number | null } | null | undefined): number | null => {
  const d = num(tt?.baseDays);
  return d != null ? Math.ceil(d * 7 / 5) : null;
};

/** What the short-term exit rule reads today besides the tech plan (owner 2026-10-30). */
export interface ShortTermExitContext {
  readonly chart?: PageChart | null;
  /** The engine's sell zone (confluence exitLow). */
  readonly sellZoneLow?: number | null;
  readonly nowMs?: number;
  /** The chart's last bar is today's unfinished session bar. */
  readonly liveBar?: boolean;
}

/**
 * Owner decision 2026-10-30 (replaces the D3 "+50% on the call's price or the 30-day exit" plan): the short-term call
 * exits on the WEEKLY chart (options/weeklyExit.ts), with today's reading under each trigger. A new pick measures its
 * gain from today's price (the entry). The hard limit stays 30 days before expiry.
 */
export function shortTermExitPlanLines(tp: PageTechPlan | null | undefined, daysLeft: number | null, ctx: ShortTermExitContext = {}): string[] {
  const t1 = num(tp?.t1?.price), stop = num(tp?.stop), zone = num(ctx.sellZoneLow);
  const holdDays = daysLeft != null ? daysLeft - EXPIRY_WARNING_DAYS_SHORT_TERM : null;
  const d1 = calendarDaysTo(tp?.t1Time);
  const price = num(ctx.chart?.currentPrice) ?? num(ctx.chart?.closes?.[ctx.chart.closes.length - 1]);
  const r = readShortTermExit({
    dates: ctx.chart?.dates ?? null, closes: ctx.chart?.closes ?? null, price, refIsToday: true, stop, t1, sellZoneLow: zone, daysLeft,
    ...(ctx.nowMs != null ? { nowMs: ctx.nowMs } : {}), ...(ctx.liveBar ? { liveBar: true } : {}),
  });
  const today = (i: number): string => '      Today: ' + r.triggers[i]!.reading;
  const lvl = [zone != null ? 'the engine\'s sell zone (from ' + usd(zone) + ')' : 'the engine\'s sell zone (none this run)',
    t1 != null ? 'T1 (stock at ' + usd(t1) + (d1 != null ? ', expected in about ' + d1 + ' days' : '') + ')' : 'T1 (none this run)'].join(' or ');
  return [
    '  - Read on the WEEKLY chart (owner rule 2026-10-30, for swings of weeks to years). ' + r.weekLine,
    '  - Reference price: today\'s price' + (price != null ? ' ' + usd(price) : '') + ' (a new pick: today\'s price is the entry; "up" means up from it).',
    '  - Sell when ANY of these happens:',
    '    1. Out of steam after a gain: the stock is up since the reference price AND at least ' + WEEKLY_EXIT.minSigns + ' of: the weekly MACD crosses below its signal;'
      + ' the weekly RSI falls back under ' + WEEKLY_EXIT.rsiBack + ' after being above ' + WEEKLY_EXIT.rsiHigh + ' within the last ' + WEEKLY_EXIT.rsiLookbackWeeks + ' weeks;'
      + ' the last weekly close is below the ' + WEEKLY_EXIT.dailyAvgDays + '-day average.',
    today(0),
    '    2. The stock reached ' + lvl + ' AND weekly momentum is weakening (the weekly MACD histogram fell 2 weeks in a row).',
    today(1),
    '    3. The stock closed below the engine\'s stop' + (stop != null ? ' (' + usd(stop) + ')' : ' (no stop this run)') + '.',
    today(2),
    '    4. Hard limit: sell everything ' + EXPIRY_WARNING_DAYS_SHORT_TERM + ' days before expiry, whatever the price'
      + (holdDays != null ? ' (that leaves about ' + Math.max(0, holdDays) + ' days to hold this call).' : '.'),
    today(3),
    '  - Keep while the weekly trend is up: the weekly close above the ' + WEEKLY_EXIT.weeklyAvgWeeks + '-week average and the weekly MACD above its signal.',
    '      Today: ' + r.keepReading,
  ];
}

function exitPlanLines(leaps: boolean, tp: PageTechPlan | null | undefined, daysLeft: number | null, ctx: ShortTermExitContext): string[] {
  const t1 = num(tp?.t1?.price), t2 = num(tp?.t2?.price), stop = num(tp?.stop);
  const t = (n: string, p: number | null): string => n + (p != null ? ' (stock at ' + usd(p) + ')' : ' (no target this run)');
  return leaps ? [
    '  - Sell about a third at ' + t('T1', t1) + ', a third at ' + t('T2', t2) + ', and keep the rest on the trailing stop' + (stop != null ? ' (today ' + usd(stop) + ' on the stock)' : '') + '.',
    '  - Sell everything ' + EXPIRY_WARNING_DAYS_LEAPS + ' days before expiry, whatever the price.',
  ] : shortTermExitPlanLines(tp, daysLeft, ctx);
}

export interface OptionsDecisionInput {
  readonly ticker: string;
  /** undefined / null = the options analysis did not run (a stock-only run). */
  readonly leapsCall: unknown;
  readonly shortTermCall: unknown;
  readonly decision: PageDecision | null | undefined;
  readonly techPlan: PageTechPlan | null | undefined;
  readonly fund: PageFund | null | undefined;
  readonly confluence: PageConfluence | null | undefined;
  readonly flow: PageOptionsFlow | null | undefined;
  readonly nowMs: number;
  readonly timeZone: string;
  /** E1 (option A, label only): the price is at the buy limit. The verdict is unchanged; the "Why" line says so. */
  readonly atBuyLimit?: AtBuyLimit | null;
  /** B1 option B (display only): the nearest valid resistance above the entry, one line under each exit plan. */
  readonly nextResistance?: NextResistance | null;
  /** B1 option B part 2 (display only): T2 with the excluded methods skipped, under the LEAPS exit plan, when it differs. */
  readonly fixedT2?: FixedT2Display | null;
  /** The daily chart for the short-term call's weekly exit rule (owner 2026-10-30); absent = readings not available. */
  readonly chart?: PageChart | null;
  /** The chart's last bar is today's unfinished session bar. */
  readonly liveBar?: boolean;
  /** Owner 2026-10-30: the LEAPS expiry comparison; absent = the one attached to the LEAPS pick by the options run, if any. */
  readonly leapsExpiries?: LeapsExpiryComparison | null;
  /** James — LEAPS (phase 4, display only): its short block after the others; absent = not shown. */
  readonly jamesLeaps?: JamesLeapsRead | null;
}

type Pick2 = Pick<OptionsDecisionInput, 'decision' | 'techPlan' | 'fund'>;

/** One pick's verdict (BUY NOW / WAIT / DON'T BUY) from the run's own decision. */
export function pickVerdict(pickArg: unknown, inp: Pick2, optionsRun: boolean): { verdict: OptionsVerdict; reason: string } {
  const p = pickOf(pickArg);
  return optionsVerdict({
    optionsRun, found: !!(p && p.found && p.contract), timing: inp.techPlan?.timing, regime: inp.techPlan?.regime,
    isBuy: isTier1Buy(inp.decision, inp.techPlan, inp.fund), conviction: num(inp.decision?.finalConviction),
  });
}

export function formatOptionsDecisionPage(inp: OptionsDecisionInput): string {
  const optionsRun = inp.leapsCall != null || inp.shortTermCall != null;
  const out = ['── ' + inp.ticker + ' — Options Decision (long calls only) ──', '', PAGE_DISCLAIMER,
    'Only buying calls: no puts, no selling options.'];
  if (!optionsRun) {
    out.push('', "VERDICT: DON'T BUY — options data was not run for this report (the stock-only analysis does not look at option chains). Run the Full Ticker Analysis to get a call to consider.");
  }
  const entryLadder = (() => { try { const c = inp.confluence; return c && num(c.entryLow) != null && num(c.entryHigh) != null ? computeOptionsEntryLadder({ entryCount: c.entryCount, entryLow: c.entryLow as number, entryHigh: c.entryHigh as number }) : []; } catch { return []; } })();
  const pcts = ladderDisplayPercents(entryLadder);
  let n = 0;
  for (const [label, arg, leaps] of [[pickLabel(true, 0.75, { deltaWords: 'aiming at delta' }), inp.leapsCall, true], [pickLabel(false, 0.50, { upper: true, deltaWords: 'aiming at delta' }), inp.shortTermCall, false]] as const) {
    if (!optionsRun) break;
    const p = pickOf(arg);
    const v = pickVerdict(arg, inp, true);
    out.push('', (++n) + '. ' + label + ': ' + v.verdict);
    // E1: the call's verdict stays as the rule decided it; the stock itself is at the buy limit (no "wait for a pullback").
    const why = inp.atBuyLimit
      ? (v.reason === 'The stock is a buy, but the timing says wait for a pullback.' ? 'The stock is a buy and the timing is still WAIT by rule.' : v.reason)
        + ' The stock itself is ' + inp.atBuyLimit.text
      : v.reason;
    out.push('  Why: ' + why);
    if (!p || !p.found || !p.contract) {
      if (p && p.reason) out.push('  What happened: ' + plainReason(p.reason) + '.');
      continue;
    }
    out.push(...contractLines(p.contract, inp.nowMs, inp.timeZone));
    if (v.verdict === 'WAIT') {
      if (entryLadder.length) {
        out.push('  Buy the same call in steps when the stock reaches:');
        entryLadder.forEach((r, i) => out.push('    - ' + usd(r.price) + ' (' + pcts[i] + '% of the contracts)'));
      } else if (num(inp.techPlan?.entryHigh) != null) {
        out.push('  Buy when the stock pulls back to ' + usd(inp.techPlan!.entryHigh as number) + ' or lower.');
      }
      out.push('  ' + optionsLadderTimeDecayNote());
    }
    const alts = (p.allCandidates ?? []).filter((c) => !(c.strike === p.contract!.strike && c.expUnix === p.contract!.expUnix)).slice(0, 3);
    if (alts.length) {
      out.push('  Next best (same expiry, delta closest to the aim):');
      for (const c of alts) {
        const ask = num(c.ask);
        out.push('    - $' + c.strike + ' call, delta ' + (num(c.delta) != null ? c.delta.toFixed(2) : '—') + ', bid/ask ' + (num(c.bid) != null ? usd(c.bid as number) : '—') + ' / ' + (ask != null ? usd(ask) : '—')
          + (ask != null && ask > 0 ? ', breakeven ' + usd(c.strike + ask) : ''));
      }
    }
    out.push('  Exit plan:');
    out.push(...exitPlanLines(leaps, inp.techPlan, daysToExpiry(p.contract.expUnix, inp.nowMs, inp.timeZone), { chart: inp.chart ?? null, sellZoneLow: num(inp.confluence?.exitLow), nowMs: inp.nowMs, ...(inp.liveBar ? { liveBar: true } : {}) }));
    if (leaps && inp.fixedT2) out.push('  - ' + inp.fixedT2.text + ' (shown only; the plan above sells at T2).');
    if (inp.nextResistance) out.push('  - ' + inp.nextResistance.text + ' (shown only; the plan above stays at T1 / T2).');
  }
  const expTable = inp.leapsExpiries !== undefined ? inp.leapsExpiries : leapsExpiryComparisonOf(inp.leapsCall);
  if (optionsRun && expTable) {
    const lp = pickOf(inp.leapsCall);
    out.push('', ...leapsExpiryComparisonLines(expTable, lp && lp.found && lp.contract ? lp.contract : null));
  }
  out.push('', (optionsRun ? (++n) + '. ' : '') + 'OPTIONS FLOW (from the saved options snapshot)');
  const f = inp.flow;
  if (!f || !f.available) out.push('  No options snapshot this run.');
  else {
    const lean = num(f.leapsLean);
    out.push('  Long-dated (LEAPS) lean: ' + (lean == null ? 'not available' : lean.toFixed(2) + (lean >= 0.5 ? ' — big money is building long-dated calls' : lean <= -0.5 ? ' — long-dated money is hedged' : ' — no strong lean')));
    out.push('  ' + IV_CHAIN_PCT_LABEL + ': ' + (num(f.ivRank) != null ? f.ivRank + ' — ' + IV_CHAIN_PCT_MEANING : 'not available'));
    out.push('  ' + PUT_CALL_LABEL + ': ' + putCallText(num(f.putCallOI)));
    out.push('    Bands: ' + PUT_CALL_BANDS_TEXT + '.');
  }
  if (inp.jamesLeaps) out.push(...optionsDecisionJamesLines(inp.jamesLeaps, ++n));
  out.push('', 'How the verdict is decided: DON\'T BUY when there is no contract, the timing says avoid, the stock is not in an uptrend (no new entries), or the engine does not say buy (conviction ' + BUY_TIER1_MIN_CONVICTION + '+ or timing buy now, not blocked by weak fundamentals); WAIT when the timing says wait for a pullback; BUY NOW when it is a buy and the timing says buy now.');
  return out.join('\n');
}

/** A pick's not-found reason in plain words (the raw reason is technical; reports/messages/reportText.ts notFoundText in spirit). */
function plainReason(raw: string): string {
  if (/no chain data/i.test(raw)) return 'the option chain did not come back';
  if (/no call contracts/i.test(raw)) return 'the chain has no calls';
  if (/no expiry with/i.test(raw)) return raw.replace(/ for \S+$/, '') + ' (a shorter call would be sold by the ' + EXPIRY_WARNING_DAYS_SHORT_TERM + '-day exit almost as soon as it is bought)';
  if (/delta/i.test(raw)) return 'the chain has no usable delta values';
  return 'nothing suitable at the chosen expiry';
}

// ─────────────────────────────── 🧮 All Models ───────────────────────────────

/**
 * How each model trades in the simulation (engine text). Its history (2010-19 / 2020-23 / 2024-26, after tax) is the
 * profile's results pack (GENERIC_PLAN P4, profile/results.ts `models`); no pack = '—' in the column and NO_HISTORY
 * as the note.
 */
export const MODEL_TRADES: Readonly<Record<string, string>> = {
  ENGINE: '3 stocks, sells below the 200-day average',
  ENGINE_MODELS: '5 stocks, sells below the 200-day average',
  BROKER: '2 stocks, sells below the 200-day average',
  SCHABACKER: '3 stocks, sells below the 200-day average',
  EDWARDS_MAGEE: '5 stocks, sells when it turns cautionary',
  TURTLE: '3 stocks, sells below the 200-day average',
  WYCKOFF_CLASSIC: '2 stocks, sells when it turns cautionary',
  WYCKOFF_ENGINE: 'not traded in the simulation',
  TREND_150: '3 stocks, sells 3% under the 150-day average',
  TREND_200: '3 stocks, sells 3% under the 200-day average',
  COMBO_TSE: '3 stocks, sells below the 200-day average',
  EVERYTHING: '3 stocks, half shares half LEAPS, sells below the 200-day average',
  LILO: '5 ladders at a time',
  // James's models, phase 1 (docs/models/results/phase1.md; 10 bps per side; chosen on 2010-2019, the later two out-of-sample)
  LILO_V2: 'snipe buys at layers 0-8 of the 200-day anchor, no layer-out, 200-day stop, 5 stocks',
  // James's models, phase 2 (docs/models/results/phase2.md)
  MEAN_REV: 'buys a close 2.5 SD under its 10-day average while QQQ is not down, sells at +2.5 SD or after 20 days, 5 stocks',
  PAIR: '100% in one leg of the pair, swapped when the ratio is 2 SD from its 20-day average',
  WINNERS: 'adds on dips in the top 5 by 6-month strength vs QQQ, 1.5 / 4 / 8% by zone, no trend cut',
  // James's models, phase 3 (docs/models/results/phase3.md)
  CYCLE: 'top 3 leaders; dry powder deployed at -60% with weekly RSI < 30, 20% harvested at a weekly z of +3, half rotated',
  MARKET_MAKER: 'buys the Wyckoff spring near a rising 200-day average at 1% risk (no signal on daily bars since 2010; idle money in QQQ)',
  // James's models, phase 4 (docs/models/results/phase4.md; the LEAPS figures are approximate)
  JAMES_LEAPS: 'January LEAPS ~19 months, delta 0.75, bought in a fire sale (QQQ -20%, or a stock -40% then a turnaround), held to expiry, delta capped at 1 x equity, 5 slots',
  JAMES_FAIR_VALUE: 'a tool: fair value, time value and IV vs realized for each pick (not traded on its own)',
  // James's models, phase 5 (docs/models/results/phase5.md): the gate as a filter on Trend 200 (the paper account's host)
  QUALITY_GATE: 'a filter: Trend 200 (3 stocks) buys only stocks scoring 4 of 7 of the items known that day (team, chart, dollar volume on history)',
  PROFIT_TAKING: 'an exit: A20 sells 20% of what is held at each of layers 6-10 (on the Combo 2 of 3, 3 stocks)',
  HOLD_QQQ: '',
  HOLD_LIST: '',
};
export const MODEL_SIMULATION: Readonly<Record<string, { readonly trades: string; readonly history: string }>> =
  Object.fromEntries(Object.entries(MODEL_TRADES).map(([k, trades]) => [k, { trades, history: RESULTS?.models[k] ?? '—' }]));
export const SIMULATION_NOTE = RESULTS
  ? 'History = the simulation on ' + RESULTS.basis.list + ' stocks with $100,000; picking the best setup used the past, the live paper test is the real check.'
  : NO_HISTORY;

export interface AllModelsRow {
  readonly key: string;
  readonly model: string;
  readonly read: string;
  readonly why: string;
  readonly trades: string;
  readonly history: string;
}

export const ALL_MODELS_HEADER: readonly string[] = ['Model', "Today's read", 'Why', 'How it trades in the simulation', 'History (2010-19 / 2020-23 / 2024-26, after tax)'];

export interface AllModelsInput {
  readonly decision: PageDecision | null | undefined;
  readonly techPlan: PageTechPlan | null | undefined;
  readonly fund: PageFund | null | undefined;
  readonly comparison: PageComparison | null | undefined;
  readonly extra: ExtraModelsReport | null | undefined;
  readonly lilo: LiloRead | null | undefined;
  /** James's models (phase 1): given (or null = did not run), their two rows follow LILO; absent = not shown. */
  readonly james?: JamesReads | null;
  /** James's models (phase 2): given (or null = did not run), their three rows follow phase 1's; absent = not shown. */
  readonly james2?: James2Reads | null;
  /** James's models (phase 3): given (or null = did not run), their two rows follow phase 2's; absent = not shown. */
  readonly james3?: James3Reads | null;
  /** James's models (phase 4): given (or null = did not run), their two rows follow phase 3's; absent = not shown. */
  readonly james4?: James4Reads | null;
  /** James's models (phase 5): given (or null = did not run), its row follows phase 4's; absent = not shown. */
  readonly james5?: James5Reads | null;
}

/** The first sentence of a model's own headline, kept short. */
function shortWhy(h: string | null | undefined, fallback: string): string {
  if (!h) return fallback;
  const first = h.split(/(?<=[.!?])\s/)[0] ?? h;
  return first.length > 160 ? first.slice(0, 157).replace(/\s+\S*$/, '') + '…' : first;
}

const buyWord = (b: boolean | null): string => (b == null ? 'Not available' : b ? 'Buy' : 'No buy');
const dirWord = (d: unknown): string => (isDir(d) ? directionWord(d) : 'Not available');

export function allModelsRows(i: AllModelsInput): AllModelsRow[] {
  const S = MODEL_SIMULATION;
  const row = (key: string, model: string, read: string, why: string): AllModelsRow => ({ key, model, read, why, trades: S[key]!.trades, history: S[key]!.history });
  const c = i.comparison ?? null;
  const notRun = 'This model did not run.';
  const eng = engineAloneRead(i.decision, i.techPlan);
  const em = engineWithModelsRead(i.decision, i.techPlan, i.fund, c);
  const x = (id: ExtraModelId): ExtraModelRead | null => modelOf(i.extra, id);
  const xr = (key: ExtraModelId, name: string): AllModelsRow => { const m = x(key); return row(key, name, directionWord(m ? m.direction : null), m ? cap(m.summary.replace(/^(Bullish|Mixed|Cautionary) — /, '')) : notRun); };
  const ev = i.extra?.everything;
  return [
    row('ENGINE', 'Engine alone', buyWord(eng.buy), eng.why),
    row('ENGINE_MODELS', 'Engine + models (current Buy report rule)', buyWord(em.buy), em.why),
    row('BROKER', 'Broker Course', dirWord(c?.newDirection), c?.newDirection ? shortWhy(c.newHeadline, 'See the Broker Model page.') : notRun),
    row('SCHABACKER', 'Schabacker', dirWord(c?.schabackerDirection), c?.schabackerDirection ? shortWhy(c.schabackerHeadline, 'See the Schabacker Model page.') : notRun),
    row('EDWARDS_MAGEE', 'Edwards & Magee', dirWord(c?.edwardsMageeDirection), c?.edwardsMageeDirection ? shortWhy(c.edwardsMageeHeadline, 'See the Edwards & Magee Model page.') : notRun),
    row('TURTLE', 'Turtle', dirWord(c?.turtleDirection), c?.turtleDirection ? shortWhy(c.turtleHeadline, 'See the Turtle Model page.') : notRun),
    xr('WYCKOFF_CLASSIC', 'Wyckoff (original method)'),
    row('WYCKOFF_ENGINE', 'Wyckoff (older engine read)', i.extra ? (i.extra.engineWyckoff.found ? 'Reference only' : 'None') : 'Not available', i.extra ? i.extra.engineWyckoff.summary : notRun),
    xr('TREND_150', 'Trend 150'),
    xr('TREND_200', 'Trend 200'),
    xr('COMBO_TSE', 'Combo (Turtle + Schabacker + E&M, 2 of 3)'),
    row('EVERYTHING', 'Everything together (engine or combo)', ev ? buyWord(ev.buy) : 'Not available', ev ? cap(ev.summary.replace(/^(Buy|No buy) — /, '')) : notRun),
    row('LILO', 'LILO (staged ladder)', i.lilo ? (i.lilo.placed ? 'Ladder placed' : 'No ladder') : 'Not available', i.lilo ? i.lilo.why : notRun),
    ...(i.james === undefined ? [] : jamesAllModelsRows(i.james).map((j) => row(j.key, j.model, j.read, j.why))),
    ...(i.james2 === undefined ? [] : james2AllModelsRows(i.james2).map((j) => row(j.key, j.model, j.read, j.why))),
    ...(i.james3 === undefined ? [] : james3AllModelsRows(i.james3).map((j) => row(j.key, j.model, j.read, j.why))),
    ...(i.james4 === undefined ? [] : james4AllModelsRows(i.james4).map((j) => row(j.key, j.model, j.read, j.why))),
    ...(i.james5 === undefined ? [] : james5AllModelsRows(i.james5).map((j) => row(j.key, j.model, j.read, j.why))),
  ];
}

/** The yardstick rows under the table (from the results pack; none without one). */
export const REFERENCE_ROWS: ReadonlyArray<readonly [string, string]> = RESULTS ? [
  ['📊 Hold QQQ', MODEL_SIMULATION.HOLD_QQQ!.history],
  ['📊 Hold ' + RESULTS.basis.list + ' equally', MODEL_SIMULATION.HOLD_LIST!.history],
] : [];

export function formatAllModelsPage(ticker: string, rows: readonly AllModelsRow[]): string {
  const out = ['── ' + ticker + ' — All Models ──', '', PAGE_DISCLAIMER, ''];
  out.push(ALL_MODELS_HEADER.join(' | '));
  for (const r of rows) out.push([r.model, r.read, r.why, r.trades, r.history].join(' | '));
  for (const [l, h] of REFERENCE_ROWS) out.push([l, '', '', '', h].join(' | '));
  out.push('', SIMULATION_NOTE);
  return out.join('\n');
}

const READ_BG: Readonly<Record<string, string>> = { Bullish: '#e8f5e9', Buy: '#e8f5e9', 'Ladder placed': '#e8f5e9', Mixed: '#fffde7', Cautionary: '#ffebee', 'No buy': '#ffebee', 'No ladder': '#f5f5f5', 'In buy zone': '#e8f5e9', 'In sell zone': '#fff3e0', 'No anchor': '#f5f5f5', 'Buy zone': '#e8f5e9', 'Confirmed buy': '#e8f5e9', 'Trim zone': '#fff3e0', ADD: '#e8f5e9', 'NOT A WINNER': '#f5f5f5', 'Not a pair stock': '#f5f5f5', 'Deploy zone': '#e8f5e9', 'Harvest zone': '#fff3e0', "Don't chase": '#ffebee', 'Buy signal': '#e8f5e9', 'In trade window': '#e3f2fd', 'No setup': '#f5f5f5', 'Wait for a fire sale': '#f5f5f5', 'Wait for turnaround': '#fffde7', 'No liquid contract': '#ffebee', 'No chain': '#f5f5f5', Fair: '#e8f5e9', 'IV high vs realized': '#fff3e0' };
/** James — Quality Gate's read starts with its score ("5 / 8 — passes"), so its colour goes by the word after the dash. */
const readBg = (read: string): string | undefined => READ_BG[read] ?? (/ — passes$/.test(read) ? '#e8f5e9' : / — would block$/.test(read) ? '#ffebee' : undefined);

/** The All Models tab as a real table (one row per model), in the Bottom Line's sheet style. */
export function writeAllModelsSheet(sh: ReportSheet, ticker: string, rows: readonly AllModelsRow[], color: string): void {
  sh.clearContents(); sh.clearFormats();
  sh.setTabColor(color);
  let r = 1;
  sh.getRange(r, 1, 1, 5).merge().setValue('🧮 ALL MODELS — ' + ticker).setBackground('#1a237e').setFontColor('#fff').setFontSize(13).setFontWeight('bold'); r++;
  sh.getRange(r, 1, 1, 5).merge().setValue(PAGE_DISCLAIMER).setFontStyle('italic').setFontColor('#666').setWrap(true); r += 2;
  sh.getRange(r, 1, 1, 5).setValues([[...ALL_MODELS_HEADER]]).setFontWeight('bold').setBackground('#616161').setFontColor('#fff').setWrap(true); r++;
  for (const x of rows) {
    sh.getRange(r, 1, 1, 5).setValues([[x.model, x.read, x.why, x.trades, x.history]]).setWrap(true);
    sh.getRange(r, 1).setFontWeight('bold');
    const bg = readBg(x.read);
    if (bg) sh.getRange(r, 2).setBackground(bg).setFontWeight('bold');
    r++;
  }
  for (const [l, h] of REFERENCE_ROWS) { sh.getRange(r, 1, 1, 5).setValues([[l, '', '', '', h]]).setBackground('#eceff1').setWrap(true); sh.getRange(r, 1).setFontWeight('bold'); r++; }
  r++;
  sh.getRange(r, 1, 1, 5).merge().setValue(SIMULATION_NOTE).setFontStyle('italic').setFontColor('#666').setWrap(true);
  sh.setColumnWidth(1, 200); sh.setColumnWidth(2, 100); sh.setColumnWidth(3, 380); sh.setColumnWidth(4, 220); sh.setColumnWidth(5, 220);
}
