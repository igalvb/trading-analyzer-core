/**
 * James — Quality Gate (docs/models/plans/10-quality-gate-8-step-ackman.md): James's 8-step checklist (written for
 * Solana tokens, 2023-12-10) and Ackman's 4 points (2026-06-01), mapped to stock facts [PROPOSED, plan 10 section 2.2],
 * one point per item. Used only as a GATE on another model's buys (a buy is acted on only when the score passes),
 * never as a model of its own, and display only in the reports (no score, conviction, verdict or tier change; not
 * merged into the OWN fundamentals score).
 *
 * Items: 1 Team (founder CEO, or CEO >= 5 years: the dated CEO table, user data), 2 Adoption (revenue +20% a year, trailing 4
 * quarters), 3 Dilution (diluted shares <= +3% a year), 4 Product-market fit (gross margin >= 40%, or up 4 quarters
 * running — the second form needs a quarterly history the gate does not keep, so only the level is used), 5 Use-case
 * analog (the owner's call; never on history), 6 Relative value (price-to-sales <= 1.5 x the peer median), 7 Chart (the
 * 200-day trend reads up), 8 Tradability (20-day average dollar volume >= $50M). Ackman's Context: a manual flag, shown,
 * never scored.
 *
 * Every item is 'pass', 'fail' or 'unknown' (data missing: counts as no point, and the page says "unknown", not
 * "fails"). History scores are out of 7 (item 5 is unknowable in the past).
 */

import fs from 'node:fs';
import path from 'node:path';
import { trendSeries } from './trendFollow.ts';
import type { PitFundamentals } from '../../fetch/sec/companyFacts.ts';
import { activeProfile } from '../../profile/active.ts';
import { defaultResultsDir } from '../../profile/results.ts';

export type ItemState = 'pass' | 'fail' | 'unknown';
export interface QualityItem {
  readonly n: number; readonly name: string; readonly state: ItemState;
  /** What was measured ("revenue +38% a year"), or why it is unknown. */
  readonly value: string; readonly threshold: string; readonly source: string;
  /** True when the value is point-in-time (knowable on that day); false for today's numbers. */
  readonly pit: boolean;
}
export interface QualityScore {
  readonly points: number;
  /** Items with a pass or fail (not unknown), and the items scored (8 live, 7 on history). */
  readonly known: number; readonly outOf: number;
  readonly items: readonly QualityItem[];
}

/** [PROPOSED] thresholds (plan 10 section 2.2; James gives none). */
export interface QualityOptions {
  readonly tenureYears: number; readonly revenueGrowth: number; readonly dilution: number; readonly grossMargin: number;
  readonly psMultiple: number; readonly dollarVolume: number; readonly trendDays: number; readonly volumeDays: number;
}
export const QUALITY_DEFAULTS: QualityOptions = { tenureYears: 5, revenueGrowth: 0.20, dilution: 0.03, grossMargin: 0.40, psMultiple: 1.5, dollarVolume: 50e6, trendDays: 200, volumeDays: 20 };

/**
 * The gate (plan 10 section 2.2): a buy passes when the score reaches `mark` of `outOf`.
 * 'strict' (the plan as written): points >= mark, an unknown item counts as no point.
 * 'scaled' (phase 5, fixed before any run because 4 of the 7 history items have no data here): the same pass share
 * over the items that ARE known that day, points / known >= mark / outOf (a score with nothing known never passes).
 * Size variant: the buy's slot is scaled by min(1, (points / known) / (mark / outOf)) instead (the rest stays in QQQ).
 */
export interface GateRule { readonly mode: 'strict' | 'scaled'; readonly mark: number; readonly outOf: number }
/** Plan 10's pre-registered history gate: 5 of 7 (6 of 8 live with item 5 unknowable on history). */
export const GATE_PREREGISTERED: GateRule = { mode: 'strict', mark: 5, outOf: 7 };

export function passesGate(s: Pick<QualityScore, 'points' | 'known'>, g: GateRule): boolean {
  if (g.mode === 'strict') return s.points >= g.mark;
  return s.known > 0 && s.points / s.known >= g.mark / g.outOf - 1e-9;
}
/** The size variant's scale for one buy (0 when nothing is known). */
export function gateSizeScale(s: Pick<QualityScore, 'points' | 'known'>, g: GateRule): number {
  if (s.known <= 0) return 0;
  return Math.min(1, s.points / s.known / (g.mark / g.outOf));
}

// ---------------------------------------------------------------------------------------------------------------
// Item 1 — Team / People: the CEO table

/** One CEO term. `founder`: a founder (or co-founder) leads the company as CEO or executive chairman. */
export interface CeoTerm { readonly from: string; readonly to?: string; readonly name: string; readonly founder: boolean; readonly note?: string }
/**
 * The CEO table: the dated CEO terms of the researched stocks (plan 10 section 3: "filled once at build time ... and
 * checked by the owner"). Dates are facts known on each day, so a tenure on a past day is point-in-time; the founder
 * flag is a fixed fact. A day with no term (an interim gap) fails the item; a stock with no entry is "unknown".
 *
 * GENERIC_PLAN P9: the table is one user's research (entered for that user's list), so it is DATA in the user's
 * results folder, not code: `<RESULTS_DIR or src/owner/results>/<profile.results>.ceo.json` = { source, terms }.
 * No results pack, or no CEO file next to it = an empty table (every stock's Team item is then "unknown").
 */
export interface CeoTable {
  /** The item's source line on the pages ("CEO table (built ..., not yet verified)"). */
  readonly source: string;
  /** Ticker (upper case) -> its CEO terms, oldest first. */
  readonly terms: Readonly<Record<string, readonly CeoTerm[]>>;
}
export const NO_CEO_TABLE: CeoTable = { source: 'CEO table (none)', terms: {} };

export function loadCeoTable(name: string | null, dir: string = process.env.RESULTS_DIR || defaultResultsDir()): CeoTable {
  if (!name) return NO_CEO_TABLE;
  const file = path.join(dir, name + '.ceo.json');
  if (!fs.existsSync(file)) return NO_CEO_TABLE;
  const v = JSON.parse(fs.readFileSync(file, 'utf8')) as CeoTable;
  const ok = !!v && typeof v.source === 'string' && !!v.terms && typeof v.terms === 'object'
    && Object.values(v.terms).every((ts) => Array.isArray(ts) && ts.every((t) => t && typeof t.from === 'string' && typeof t.name === 'string' && typeof t.founder === 'boolean' && (t.to === undefined || typeof t.to === 'string')));
  if (!ok) throw new Error('The CEO file ' + name + '.ceo.json is not valid (needs source and terms: ticker -> [{ from, to?, name, founder }]).');
  return v;
}

/** This run's CEO table (the active profile's results pack). */
export const CEO: CeoTable = loadCeoTable(activeProfile().results);
/** This run's CEO terms by ticker. */
export const CEO_TABLE: CeoTable['terms'] = CEO.terms;

const YEAR_MS = 365.25 * 86_400_000;
export function teamItem(ticker: string, day: string, o: QualityOptions = QUALITY_DEFAULTS, table: CeoTable = CEO): QualityItem {
  const base = { n: 1, name: 'Team / People', threshold: 'founder CEO, or CEO ' + o.tenureYears + '+ years', source: table.source, pit: true } as const;
  const terms = table.terms[ticker.toUpperCase()];
  if (!terms) return { ...base, state: 'unknown', value: 'no CEO entry for this stock' };
  const t = terms.find((x) => x.from <= day && (!x.to || day < x.to));
  if (!t) return { ...base, state: 'fail', value: 'no CEO in office (interim gap)' };
  const yrs = (Date.parse(day + 'T00:00:00Z') - Date.parse(t.from + 'T00:00:00Z')) / YEAR_MS;
  const pass = t.founder || yrs >= o.tenureYears;
  return { ...base, state: pass ? 'pass' : 'fail', value: t.name + (t.founder ? ' (founder)' : '') + ', CEO since ' + t.from.slice(0, 4) + ' (' + yrs.toFixed(1) + ' years)' };
}

// ---------------------------------------------------------------------------------------------------------------
// Items 2, 3, 4, 6 from the filings (point-in-time) or today's numbers (live, marked "current")

const pc = (x: number, dp = 0): string => (x >= 0 ? '+' : '') + (x * 100).toFixed(dp) + '%';
function numItem(n: number, name: string, v: number | null, pass: (v: number) => boolean, fmt: (v: number) => string, threshold: string, source: string, pit: boolean, why: string): QualityItem {
  return v == null ? { n, name, state: 'unknown', value: why, threshold, source, pit } : { n, name, state: pass(v) ? 'pass' : 'fail', value: fmt(v), threshold, source, pit };
}

/** The filings' items, from point-in-time facts (`pit`) or from today's merged fundamentals (`live`, not point-in-time). */
export interface FundInputs {
  readonly revenueGrowth: number | null; readonly grossMargin: number | null; readonly dilution: number | null;
  /** price-to-sales of the stock and the peer median that day (item 6). */
  readonly ps: number | null; readonly peerMedianPs: number | null;
  readonly source: string; readonly pit: boolean;
  /** Why a missing value is missing ("no SEC data in this run"). */
  readonly missing: string;
}
export function fundInputsFromPit(f: PitFundamentals | null, price: number | null, peerMedianPs: number | null, missing: string): FundInputs {
  const ps = f && price != null && f.dilutedShares != null && f.revenueTtm != null && f.revenueTtm > 0 ? (price * f.dilutedShares) / f.revenueTtm : null;
  return { revenueGrowth: f?.revenueGrowth ?? null, grossMargin: f?.grossMargin ?? null, dilution: f?.dilution ?? null, ps, peerMedianPs, source: f?.filed ? 'SEC, filed ' + f.filed : 'SEC', pit: true, missing };
}

function fundItems(f: FundInputs | null, o: QualityOptions): QualityItem[] {
  const why = f?.missing ?? 'no fundamentals in this run';
  const src = f?.source ?? '—', pit = f?.pit ?? true;
  const rel = f && f.ps != null && f.peerMedianPs != null && f.peerMedianPs > 0 ? f.ps / f.peerMedianPs : null;
  return [
    numItem(2, 'Adoption', f?.revenueGrowth ?? null, (v) => v >= o.revenueGrowth, (v) => 'revenue ' + pc(v) + ' a year (trailing 4 quarters)', 'revenue growth ' + pc(o.revenueGrowth) + '+', src, pit, why),
    numItem(3, 'Dilution', f?.dilution ?? null, (v) => v <= o.dilution, (v) => 'diluted shares ' + pc(v, 1) + ' a year', 'share growth ' + pc(o.dilution) + ' or less', src, pit, why),
    numItem(4, 'Product-market fit', f?.grossMargin ?? null, (v) => v >= o.grossMargin, (v) => 'gross margin ' + (v * 100).toFixed(0) + '%', 'gross margin ' + (o.grossMargin * 100).toFixed(0) + '%+', src, pit, why),
    numItem(6, 'Relative value', rel, (v) => v <= o.psMultiple, (v) => 'price-to-sales ' + v.toFixed(2) + 'x the peer median', o.psMultiple + 'x the peer median or less', src === '—' ? src : 'prices + ' + src, pit, f?.ps != null && f.peerMedianPs == null ? 'no peer median that day' : why),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Items 7 and 8 from prices (point-in-time)

/** Bars the price items read (any OHLCV series; volumes in shares). */
export interface QualityBars { readonly closes: readonly number[]; readonly volumes?: readonly number[] }
/** Per bar: the 200-day trend's direction and the 20-day average dollar volume (null before enough bars). */
export interface PriceItemsSeries { readonly trendUp: ReadonlyArray<boolean | null>; readonly dollarVolume: ReadonlyArray<number | null> }
export function priceItemsSeries(b: QualityBars, o: QualityOptions = QUALITY_DEFAULTS): PriceItemsSeries {
  const tr = trendSeries(b.closes, o.trendDays);
  const trendUp = tr.map((x) => (x.sma == null ? null : x.direction === 'bullish'));
  const dollarVolume: Array<number | null> = [];
  let sum = 0;
  const v = b.volumes ?? [];
  for (let i = 0; i < b.closes.length; i++) {
    sum += (b.closes[i] as number) * (v[i] ?? 0);
    if (i >= o.volumeDays) sum -= (b.closes[i - o.volumeDays] as number) * (v[i - o.volumeDays] ?? 0);
    dollarVolume.push(i >= o.volumeDays - 1 && v.length > i ? sum / o.volumeDays : null);
  }
  return { trendUp, dollarVolume };
}
const money = (x: number): string => (x >= 1e9 ? '$' + (x / 1e9).toFixed(1) + 'B' : '$' + Math.round(x / 1e6) + 'M');
function priceItems(p: PriceItemsSeries, i: number, o: QualityOptions): QualityItem[] {
  const up = i >= 0 ? p.trendUp[i] ?? null : null, dv = i >= 0 ? p.dollarVolume[i] ?? null : null;
  return [
    { n: 7, name: 'Chart', state: up == null ? 'unknown' : up ? 'pass' : 'fail', value: up == null ? 'under ' + o.trendDays + ' bars of history' : up ? 'Trend ' + o.trendDays + ' up (close above a rising ' + o.trendDays + '-day average)' : 'Trend ' + o.trendDays + ' not up', threshold: 'Trend ' + o.trendDays + ' up', source: 'prices', pit: true },
    { n: 8, name: 'Tradability', state: dv == null ? 'unknown' : dv >= o.dollarVolume ? 'pass' : 'fail', value: dv == null ? 'no volume data' : money(dv) + ' average daily dollar volume (' + o.volumeDays + ' days)', threshold: money(o.dollarVolume) + '+ a day', source: 'prices', pit: true },
  ];
}

const useCaseItem = (answer: boolean | null | undefined): QualityItem => ({
  n: 5, name: 'Use-case analog', state: answer == null ? 'unknown' : answer ? 'pass' : 'fail',
  value: answer == null ? 'not scored — your call ("this looks like a past winner")' : answer ? 'yes (your call)' : 'no (your call)', threshold: 'your call', source: 'manual', pit: false,
});

/**
 * The score of one stock on one bar. `history`: out of 7 (item 5 left out); live: out of 8 with the owner's item-5
 * answer (absent = unknown).
 */
export function qualityScore(inp: { readonly ticker: string; readonly day: string; readonly prices: PriceItemsSeries; readonly i: number; readonly fund: FundInputs | null; readonly history: boolean; readonly useCase?: boolean | null; readonly ceo?: CeoTable }, o: QualityOptions = QUALITY_DEFAULTS): QualityScore {
  const items = [teamItem(inp.ticker, inp.day, o, inp.ceo), ...fundItems(inp.fund, o), ...(inp.history ? [] : [useCaseItem(inp.useCase)]), ...priceItems(inp.prices, inp.i, o)].sort((a, b) => a.n - b.n);
  return { points: items.filter((x) => x.state === 'pass').length, known: items.filter((x) => x.state !== 'unknown').length, outOf: inp.history ? 7 : 8, items };
}

/** One letter per item for compact history storage: p / f / u, items in order (7 on history). */
export const scoreCode = (s: QualityScore): string => s.items.map((x) => x.state[0]).join('');
