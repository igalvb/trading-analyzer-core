/**
 * James's models, phase 2 (docs/models/MASTER_PLAN.md section 5): the report pages "↩️ James — Mean Reversion",
 * "🔁 James — Pair Rotation" and "🏆 James — Winners & Layering" in the Full Ticker Analysis (and the PDF), their rows
 * in 🧮 All Models and their lines in the Bottom Line. DISPLAY ONLY, computed after every score and decision is final:
 * nothing here feeds a score, the conviction, the verdict, the timing or a Buy report tier, and the reads stay out of
 * the nightly Buy and Exit reports (decision 8).
 *
 * These are James's models (InvestAnswers), not the owner's: every label says "James — ".
 */

import { zSeries, bandAt, adxSeries, entrySignals, type MrEntry } from './models/meanReversion.ts';
import { trendSeries } from './models/trendFollow.ts';
import { alignPair, ratioBars, pairStateSeries, pairsOf, PAIR_DEFAULT, type PairOptions } from './models/pairRotation.ts';
import { zoneOf, dipFires, sma200Series, rsiSeries, closesUnder200, type DipRule, type TieBreak, type Zone } from './models/winners.ts';
import { formatDateInTz } from '../core/dates.ts';
import { RESULTS, NO_HISTORY, type ResultsPack } from '../profile/results.ts';

export const JAMES_MR_NAME = 'James — Mean Reversion ±2 SD';
export const JAMES_PAIR_NAME = 'James — Pair Rotation';
export const JAMES_WINNERS_NAME = 'James — Winners & Layering';
const DISCLAIMER = 'Shown for information only: nothing on this page changes any score, the conviction, the verdict or the Buy report tiers.';

/** The Mean Reversion setup chosen on 2010-2019 (research/meanRevCli.ts MR_CHOSEN; a test keeps the two equal). */
export const MR_PAGE: { readonly entry: MrEntry; readonly n: number; readonly k: number; readonly target: 'X1' | 'X2'; readonly timeStop: number; readonly filter: 'F0' | 'F1' | 'F2' | 'F3'; readonly slots: number } =
  { entry: 'E1', n: 10, k: 2.5, target: 'X2', timeStop: 20, filter: 'F3', slots: 5 };
/** The Pair Rotation setup used on MSTR/TSLA (research/pairCli.ts PAIR_CHOSEN: the pre-registered default; the 2020-2023 pick was not stable). */
export const PAIR_PAGE: PairOptions = PAIR_DEFAULT;
/** The Winners & Layering setup chosen on 2010-2019 (research/bigWinnersCli.ts WINNERS_CHOSEN). */
export const WINNERS_PAGE: { readonly n: number; readonly ranking: '6mVsQqq' | '12m'; readonly dip: DipRule; readonly tieBreak: TieBreak; readonly rerankDays: number; readonly sizes: Readonly<Record<Zone, number>>; readonly cutAfter: number } =
  { n: 5, ranking: '6mVsQqq', dip: 'dd50', tieBreak: 'T-C', rerankDays: 63, sizes: { High: 0.015, Middle: 0.04, Deep: 0.08 }, cutAfter: 5 };

/**
 * History of the research list, $100,000, after tax, 10 bps per side (docs/models/results/phase2.md): the profile's results pack
 * (GENERIC_PLAN P4, profile/results.ts); null = no pack, the pages say NO_HISTORY.
 */
export const JAMES2_HISTORY: ResultsPack['james2'] | null = RESULTS?.james2 ?? null;
/** The research run's basis (list, hold yardstick, tax), for the history headers. */
const BASIS = RESULTS?.basis ?? null;

// ─────────────────────────────── reads (plain JSON) ───────────────────────────────

export interface J2Bars { readonly dates: ReadonlyArray<Date | string>; readonly opens?: readonly number[]; readonly closes: readonly number[]; readonly highs: readonly number[]; readonly lows: readonly number[] }
const ds = (d: Date | string | undefined, tz: string): string => (d == null ? '' : typeof d === 'string' ? d.slice(0, 10) : formatDateInTz(d, tz, 'yyyy-MM-dd'));

export interface MeanRevRead {
  readonly status: 'ok' | 'noData';
  readonly close: number | null;
  readonly z10: number | null; readonly z20: number | null; readonly z50: number | null;
  readonly sma20: number | null; readonly lower: number | null; readonly upper: number | null;
  readonly state: 'Buy zone' | 'Confirmed buy' | 'Trim zone' | 'Normal';
  readonly trendUp: boolean | null; readonly adx: number | null;
  /** The chosen setup's own signal tonight (z_10 <= -2.5). */
  readonly chosenSignal: boolean;
  /** The last year's 20-day -2 SD closes (one per 20 days) with the return 10 and 20 days later. */
  readonly recent: ReadonlyArray<{ readonly date: string; readonly z: number; readonly after10: number | null; readonly after20: number | null }>;
}

export function buildMeanRevRead(b: J2Bars | null | undefined, tz = 'America/New_York'): MeanRevRead {
  const none: MeanRevRead = { status: 'noData', close: null, z10: null, z20: null, z50: null, sma20: null, lower: null, upper: null, state: 'Normal', trendUp: null, adx: null, chosenSignal: false, recent: [] };
  if (!b || b.closes.length < 20) return none;
  const c = b.closes, i = c.length - 1, z10 = zSeries(c, 10), z20 = zSeries(c, 20), z50 = zSeries(c, 50), band = bandAt(c, i, 20);
  const e2 = entrySignals(b, z20, 'E2', 2);
  const zi = z20[i] ?? null;
  const state: MeanRevRead['state'] = zi == null ? 'Normal' : zi <= -2 ? 'Buy zone' : zi >= 2 ? 'Trim zone' : e2[i] ? 'Confirmed buy' : 'Normal';
  const t200 = trendSeries(c, 200)[i];
  const sig = entrySignals(b, zSeries(c, MR_PAGE.n), MR_PAGE.entry, MR_PAGE.k);
  const recent: Array<{ date: string; z: number; after10: number | null; after20: number | null }> = [];
  let lastK = -1e9;
  for (let k = Math.max(0, i - 251); k <= i; k++) {
    const z = z20[k];
    if (z == null || z > -2 || k - lastK < 20) continue;
    lastK = k;
    recent.push({ date: ds(b.dates[k], tz), z, after10: k + 10 <= i ? (c[k + 10] as number) / (c[k] as number) - 1 : null, after20: k + 20 <= i ? (c[k + 20] as number) / (c[k] as number) - 1 : null });
  }
  return {
    status: 'ok', close: c[i] as number, z10: z10[i] ?? null, z20: zi, z50: z50[i] ?? null, sma20: band?.sma ?? null, lower: band ? band.sma - 2 * band.sd : null, upper: band ? band.sma + 2 * band.sd : null,
    state, trendUp: t200?.sma != null ? t200.direction === 'bullish' : null, adx: adxSeries(b)[i] ?? null, chosenSignal: !!sig[i], recent,
  };
}

export interface PairLegRead {
  readonly a: string; readonly b: string; readonly status: 'ok' | 'noPartner';
  readonly R: number | null; readonly z: number | null;
  /** The ATR band (EMA 20 ± 2 ATR) for reference. */
  readonly lower: number | null; readonly middle: number | null; readonly upper: number | null;
  readonly hold: string | null;
  readonly swaps: ReadonlyArray<{ readonly date: string; readonly into: string; readonly R: number }>;
}
export interface PairRead { readonly status: 'ok' | 'notPair'; readonly pairs: readonly PairLegRead[] }

/** `own` = this ticker's bars; `partner(t)` = the other leg's bars (null when the fetch failed). */
export function buildPairRead(ticker: string, own: J2Bars | null | undefined, partner: (t: string) => J2Bars | null, tz = 'America/New_York'): PairRead {
  const ps = pairsOf(ticker);
  if (!ps.length) return { status: 'notPair', pairs: [] };
  const leg = (x: J2Bars): { dates: string[]; opens: readonly number[]; highs: readonly number[]; lows: readonly number[]; closes: readonly number[] } => ({ dates: x.dates.map((d) => ds(d, tz)), opens: x.opens ?? x.closes, highs: x.highs, lows: x.lows, closes: x.closes });
  return {
    status: 'ok',
    pairs: ps.map(([a, b]) => {
      const other = a === ticker ? b : a, ob = partner(other);
      if (!own || !ob) return { a, b, status: 'noPartner', R: null, z: null, lower: null, middle: null, upper: null, hold: null, swaps: [] };
      const A = leg(a === ticker ? own : ob), B = leg(a === ticker ? ob : own), al = alignPair(A, B), rb = ratioBars(A, B, al);
      const st = pairStateSeries(rb, PAIR_PAGE), atr = pairStateSeries(rb, { ...PAIR_DEFAULT, signal: 'ATR' });
      const i = st.length - 1, x = st[i];
      const swaps = st.map((y, j) => ({ y, j })).filter(({ y }) => y.swap).slice(-6).map(({ y, j }) => ({ date: al.dates[j]!, into: y.hold === 'A' ? a : b, R: y.R }));
      return { a, b, status: 'ok', R: x?.R ?? null, z: x?.z ?? null, lower: atr[i]?.lower ?? null, middle: atr[i]?.middle ?? null, upper: atr[i]?.upper ?? null, hold: x?.hold === 'A' ? a : x?.hold === 'B' ? b : null, swaps };
    }),
  };
}

/** The list ranking stored by the nightly paper job (paperLab.ts lab.winnersRank). */
export interface WinnersRank { readonly day: string; readonly n: number; readonly list: ReadonlyArray<{ readonly t: string; readonly score: number }> }
export interface WinnersRead {
  readonly status: 'ok' | 'noData';
  readonly close: number | null; readonly drawdown: number | null; readonly zone: Zone | null; readonly extended: boolean; readonly sizeZone: Zone | null;
  readonly sma200: number | null; readonly under200: number; readonly dip: boolean;
  readonly rank: { readonly place: number; readonly of: number; readonly top: readonly string[]; readonly day: string } | null;
  /** ADD / HOLD / CUT for a holder; NOT A WINNER outside the top N; null without the rank. */
  readonly today: 'ADD' | 'HOLD' | 'NOT A WINNER' | null;
}
export function buildWinnersRead(ticker: string, b: J2Bars | null | undefined, rank: WinnersRank | null): WinnersRead {
  if (!b || b.closes.length < 2) return { status: 'noData', close: null, drawdown: null, zone: null, extended: false, sizeZone: null, sma200: null, under200: 0, dip: false, rank: null, today: null };
  const c = b.closes, i = c.length - 1, sma = sma200Series(c), z = zoneOf(b, i, sma[i] ?? null);
  const dip = dipFires(b, i, WINNERS_PAGE.dip, WINNERS_PAGE.dip === 'rsi35' ? rsiSeries(c) : undefined);
  const place = rank ? rank.list.findIndex((x) => x.t === ticker) : -1;
  const r = rank && place >= 0 ? { place: place + 1, of: rank.list.length, top: rank.list.slice(0, rank.n).map((x) => x.t), day: rank.day } : null;
  const winner = !!r && r.place <= (rank as WinnersRank).n;
  return {
    status: 'ok', close: c[i] as number, drawdown: z.drawdown, zone: z.zone, extended: z.extended, sizeZone: z.sizeZone, sma200: sma[i] ?? null, under200: closesUnder200(c, sma, i), dip,
    rank: r, today: !rank ? null : !winner ? 'NOT A WINNER' : dip ? 'ADD' : 'HOLD',
  };
}

export interface James2Reads { readonly meanRev: MeanRevRead; readonly pair: PairRead; readonly winners: WinnersRead }

/** Defensive reader (the read arrives as `unknown` through the pipelines and the analysis cache). */
export function readJames2Reads(x: unknown): James2Reads | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>, m = o['meanRev'] as Record<string, unknown> | undefined, p = o['pair'] as Record<string, unknown> | undefined, w = o['winners'] as Record<string, unknown> | undefined;
  if (!m || !p || !w || typeof m !== 'object' || typeof p !== 'object' || typeof w !== 'object') return null;
  if ((m['status'] !== 'ok' && m['status'] !== 'noData') || (p['status'] !== 'ok' && p['status'] !== 'notPair') || (w['status'] !== 'ok' && w['status'] !== 'noData')) return null;
  return x as James2Reads;
}

// ─────────────────────────────── words ───────────────────────────────

const usd = (n: number | null): string => (n == null ? '—' : '$' + n.toFixed(2));
const sd = (z: number | null): string => (z == null ? '—' : (z >= 0 ? '+' : '') + z.toFixed(2) + ' SD');
const pc = (x: number | null): string => (x == null ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%');

export function formatMeanRevPage(ticker: string, r: MeanRevRead): string {
  const out = ['── ' + ticker + ' — ' + JAMES_MR_NAME + ' ──', '', DISCLAIMER,
    'James\'s Mean Reversion tool (InvestAnswers, IADSS): a move to +2 or -2 standard deviations from the average is "overextended". His settings are not public; this is a daily-bar stand-in (he uses the 4-hour chart).'];
  if (r.status !== 'ok') return [...out, '', 'No price data this run.'].join('\n');
  out.push('', '1. TODAY: ' + r.state.toUpperCase());
  out.push('  Close ' + usd(r.close) + ' is ' + (r.z20 == null ? '—' : Math.abs(r.z20).toFixed(1) + ' SD ' + (r.z20 >= 0 ? 'above' : 'below')) + ' its 20-day average (' + usd(r.sma20) + ').');
  out.push('  z: 10-day ' + sd(r.z10) + ', 20-day ' + sd(r.z20) + ', 50-day ' + sd(r.z50) + '.');
  out.push('', '2. THE BAND (20 days, ±2 SD, the same as the Bollinger band)', '  Lower ' + usd(r.lower) + ' · average ' + usd(r.sma20) + ' · upper ' + usd(r.upper) + '.');
  out.push('', '3. STATES', '  Buy zone = a close at or under -2 SD; Confirmed buy = the first close back above the lower band; Trim zone = at or over +2 SD (James sells calls there; long-only: trim); Normal = anything else.');
  out.push('', '4. FILTERS', '  Above a rising 200-day average: ' + (r.trendUp == null ? 'not enough history' : r.trendUp ? 'yes' : 'no') + '. ADX(14): ' + (r.adx == null ? '—' : r.adx.toFixed(1) + (r.adx < 25 ? ' (range-bound, under 25)' : ' (trending)')) + '.',
    '  The setup chosen on 2010-2019 buys a close at or under -' + MR_PAGE.k + ' SD of the ' + MR_PAGE.n + '-day average while QQQ is not in a down trend, and sells at +' + MR_PAGE.k + ' SD or after ' + MR_PAGE.timeStop + ' days: tonight ' + (r.chosenSignal ? 'it WOULD BUY (if QQQ is not down)' : 'no signal') + '.');
  out.push('', '5. THE LAST YEAR\'S -2 SD CLOSES (one per 20 days)');
  if (!r.recent.length) out.push('  None.');
  for (const x of r.recent) out.push('  ' + x.date + ' at ' + sd(x.z) + ': 10 days later ' + pc(x.after10) + ', 20 days later ' + pc(x.after20) + '.');
  const H = JAMES2_HISTORY;
  if (!H || !BASIS) out.push('', '6. HISTORY', '  ' + NO_HISTORY);
  else out.push('', '6. HISTORY (' + BASIS.list + ' stocks, 5 slots, $100,000, after the ' + BASIS.tax + ' tax, 10 bps per side; 2010-19 / 2020-23 / 2024-26)',
    '  Setup chosen on 2010-2019 only (E1, n ' + MR_PAGE.n + ', k ' + MR_PAGE.k + ', exit at +k, ' + MR_PAGE.timeStop + '-day time stop, QQQ not down): ' + H.meanRev.chosen + ', deepest fall ' + H.meanRev.fall + '.',
    '  Pre-registered default (E2 confirmed, n 20, k 2, exit at the average): ' + H.meanRev.defaultRun + '.', '  📊 Hold QQQ ' + H.qqq + '; 📊 ' + BASIS.holdList + ' ' + H.list14 + '.',
    '  Verdict: ' + H.meanRev.verdict + '. The claim: ' + H.meanRev.claim + '. It runs in the paper test as information (account "James — Mean Reversion").');
  return out.join('\n');
}

export function formatPairPage(ticker: string, r: PairRead): string {
  const out = ['── ' + ticker + ' — ' + JAMES_PAIR_NAME + ' ──', '', DISCLAIMER,
    'James\'s pair trade (InvestAnswers, 2024-07-31): one pot swapped between two stocks when their price ratio is stretched. Long only: always in one leg, never short. His settings are not public; daily-bar stand-in (he used the 5-minute chart).'];
  if (r.status === 'notPair') return [...out, '', 'Not part of a configured pair.'].join('\n');
  r.pairs.forEach((p, k) => {
    out.push('', (k + 1) + '. ' + p.a + ' / ' + p.b);
    if (p.status !== 'ok') { out.push('  The other leg\'s prices were not available this run.'); return; }
    out.push('  Ratio ' + p.a + '/' + p.b + ' = ' + (p.R as number).toFixed(4) + ' (split-adjusted closes); z of the ratio over 20 days ' + sd(p.z) + '.',
      '  ATR band (20-day EMA ± 2 x the ratio\'s ATR): lower ' + (p.lower?.toFixed(4) ?? '—') + ' · middle ' + (p.middle?.toFixed(4) ?? '—') + ' · upper ' + (p.upper?.toFixed(4) ?? '—') + '.',
      '  The model would hold: ' + (p.hold ?? '—') + (p.z != null && p.z >= PAIR_PAGE.band ? ' — ' + p.a + ' is ' + p.z.toFixed(1) + ' SD rich against ' + p.b + '.' : p.z != null && p.z <= -PAIR_PAGE.band ? ' — ' + p.a + ' is ' + Math.abs(p.z).toFixed(1) + ' SD cheap against ' + p.b + '.' : ' (no stretch tonight; it keeps the leg it holds).'),
      '  Last swaps on these bars: ' + (p.swaps.length ? p.swaps.map((s) => s.date + ' into ' + s.into + ' at ' + s.R.toFixed(4)).join('; ') : 'none') + '.');
  });
  out.push('', 'FILTERS', '  James watches the BTC chart and MSTR\'s premium to its bitcoin (ARBCloud). Not modelled yet: BTC-USD history is not in the research download.');
  const H = JAMES2_HISTORY;
  if (!H || !BASIS) { out.push('', 'HISTORY', '  ' + NO_HISTORY); return out.join('\n'); }
  out.push('', 'HISTORY ($100,000, after the ' + BASIS.tax + ' tax, 10 bps per side; 2010-19 / 2020-23 / 2024-26; the setup each pair\'s sweep guard kept: z of the ratio, 20 days, ±2 SD, the pre-registered default)');
  for (const p of r.pairs) {
    const h = H.pair[p.a + '/' + p.b];
    if (h) out.push('  ' + p.a + ' / ' + p.b + ': ' + h.run + ' (50/50 held: ' + h.fiftyFifty + '), deepest fall ' + h.fall + '; in a Roth (no tax) ' + h.roth + '. ' + h.when + '.');
  }
  out.push('  Verdict: ' + H.pairVerdict + '. James\'s own pair runs in the paper test as information (account "James — Pair ...").');
  return out.join('\n');
}

export function formatWinnersPage(ticker: string, r: WinnersRead): string {
  const out = ['── ' + ticker + ' — ' + JAMES_WINNERS_NAME + ' ──', '', DISCLAIMER,
    'James\'s wealth rules (InvestAnswers): buy dips in the few big winners; the price decides how hard you layer (only 1-2% at high prices); cut your losers; keep a firm grip on your winners (no profit target).'];
  if (r.status !== 'ok') return [...out, '', 'No price data this run.'].join('\n');
  const z = r.sizeZone as Zone;
  out.push('', '1. TODAY: ' + (r.today == null ? 'RANK NOT AVAILABLE' : r.today === 'ADD' ? 'ADD (' + z + ' zone, ' + (WINNERS_PAGE.sizes[z] * 100).toFixed(1) + '% of the account)' : r.today),
    '  ' + (r.today == null ? 'The list ranking comes from the nightly paper test; it has not run yet (or this stock is not on the list). Sections 3-4 still apply.'
      : r.today === 'NOT A WINNER' ? 'Not in the top ' + WINNERS_PAGE.n + ' of the list.' : r.today === 'ADD' ? 'A top-' + WINNERS_PAGE.n + ' winner and the dip has fired.' : 'A top-' + WINNERS_PAGE.n + ' winner, no dip tonight: hold (no profit target).'));
  out.push('', '2. WINNER RANK (6-month return minus QQQ\'s, re-ranked every ' + WINNERS_PAGE.rerankDays + ' trading days; the nightly paper test\'s list)');
  out.push(r.rank ? '  #' + r.rank.place + ' of ' + r.rank.of + ' on ' + r.rank.day + '. Top ' + WINNERS_PAGE.n + ': ' + r.rank.top.join(', ') + '.' : '  Rank not available.');
  out.push('', '3. PRICE ZONE', '  ' + (((r.drawdown ?? 0) * 100).toFixed(1)) + '% under the 52-week high -> ' + r.zone + ' zone' + (r.extended ? ' (extended: over 95% of the 52-week high or 20% above the 200-day average, so High-zone size)' : '') + '.',
    '  Add sizes: High 1.5% (James: "nibble 1-2%" at high prices), Middle 4%, Deep 8% of the account; at most 25% in one stock.',
    '  The dip (15% under the 50-day high): ' + (r.dip ? 'fired' : 'not fired') + '.');
  out.push('', '4. CUT CHECK', '  ' + r.under200 + ' close(s) in a row under the 200-day average (' + usd(r.sma200) + '). The tie-break chosen on 2010-2019 is T-C: no trend cut; a holding is cut only for a "faster horse" (out of the top ' + 2 * WINNERS_PAGE.n + ' for 63 days and 10% behind QQQ over 6 months).');
  out.push('', '5. BTC SLEEVE', '  The paper account "James — Winners & Layering + BTC sleeve" keeps 2.5% in IBIT (topped up, never sold; MSTR held counts). Not tested on history (no BTC-USD in the research download). No advice on your own bitcoin.');
  const H = JAMES2_HISTORY;
  if (!H || !BASIS) out.push('', '6. HISTORY', '  ' + NO_HISTORY);
  else out.push('', '6. HISTORY (' + BASIS.list + ' stocks, $100,000, after the ' + BASIS.tax + ' tax, 10 bps per side; 2010-19 / 2020-23 / 2024-26)',
    '  Setup chosen on 2010-2019 only (top 5 by 6-month return vs QQQ, dip 15% under the 50-day high, T-C, re-rank every 63 days): ' + H.winners.chosen + ', deepest fall ' + H.winners.fall + '.',
    '  Pre-registered default (top 4 by 12-month return, dip 10% under the 20-day high, T-A): ' + H.winners.defaultRun + '.', '  📊 Hold QQQ ' + H.qqq + '; 📊 ' + BASIS.holdList + ' ' + H.list14 + '.',
    '  Verdict: ' + H.winners.verdict + '. It runs in the paper test as information.');
  return out.join('\n');
}

// ─────────────────────────────── 🧮 All Models / Bottom Line ───────────────────────────────

export interface James2RowText { readonly key: 'MEAN_REV' | 'PAIR' | 'WINNERS'; readonly model: string; readonly read: string; readonly why: string }

export function james2AllModelsRows(j: James2Reads | null): James2RowText[] {
  const notRun = 'This model did not run.';
  if (!j) return [{ key: 'MEAN_REV', model: JAMES_MR_NAME, read: 'Not available', why: notRun }, { key: 'PAIR', model: JAMES_PAIR_NAME, read: 'Not available', why: notRun }, { key: 'WINNERS', model: JAMES_WINNERS_NAME, read: 'Not available', why: notRun }];
  const m = j.meanRev, p = j.pair, w = j.winners, p0 = p.pairs.find((x) => x.status === 'ok');
  return [
    { key: 'MEAN_REV', model: JAMES_MR_NAME, read: m.status === 'ok' ? m.state : 'Not available', why: m.status === 'ok' ? 'z ' + sd(m.z20) + ' from the 20-day average; above a rising 200-day: ' + (m.trendUp ? 'yes' : 'no') + '.' : notRun },
    { key: 'PAIR', model: JAMES_PAIR_NAME, read: p.status === 'notPair' ? 'Not a pair stock' : p0 ? 'Hold ' + p0.hold : 'Not available', why: p.status === 'notPair' ? 'Not one of the configured pairs.' : p0 ? p0.a + '/' + p0.b + ' ratio ' + sd(p0.z) + ' from its 20-day average.' : 'The other leg\'s prices were not available.' },
    { key: 'WINNERS', model: JAMES_WINNERS_NAME, read: w.status !== 'ok' ? 'Not available' : w.today ?? 'Rank not available', why: w.status !== 'ok' ? notRun : (w.rank ? 'Rank #' + w.rank.place + ' of ' + w.rank.of + '; ' : '') + w.zone + ' zone (' + ((w.drawdown ?? 0) * 100).toFixed(0) + '% under the 52-week high); dip ' + (w.dip ? 'fired' : 'not fired') + '.' },
  ];
}

export function james2BottomLines(j: James2Reads): Array<[string, string]> {
  const m = j.meanRev, p = j.pair, w = j.winners, p0 = p.pairs.find((x) => x.status === 'ok');
  const a = m.status !== 'ok' ? 'Not available' : m.state + ': close is ' + (m.z20 == null ? '—' : Math.abs(m.z20).toFixed(1) + ' SD ' + (m.z20 >= 0 ? 'above' : 'below')) + ' its 20-day average';
  const b = p.status === 'notPair' ? 'Not part of a configured pair' : p0 ? 'Hold ' + p0.hold + ' (' + p0.a + '/' + p0.b + ' ' + sd(p0.z) + ' from its 20-day mean)' : 'The other leg\'s prices were not available';
  const c = w.status !== 'ok' ? 'Not available' : (w.rank ? 'Winner #' + w.rank.place + ' of ' + w.rank.of + ' · ' : 'Rank not available · ') + w.zone + ' zone (' + (-(w.drawdown ?? 0) * 100).toFixed(0) + '% from the 52-week high) · dip ' + (w.dip ? 'fired' : 'not triggered') + (w.today ? ' → ' + w.today : '');
  return [['↩️ ' + JAMES_MR_NAME, a], ['🔁 ' + JAMES_PAIR_NAME, b], ['🏆 ' + JAMES_WINNERS_NAME, c]];
}
