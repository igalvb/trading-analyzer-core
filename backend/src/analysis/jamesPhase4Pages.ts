/**
 * James's models, phase 4 (docs/models/MASTER_PLAN.md section 5): the report pages "🎯 James — LEAPS" (model 3) and
 * "⚖️ James — Option Fair Value" (model 4) in the Full Ticker Analysis (and the PDF), right after 📞 Options Decision;
 * a short block on 📞 Options Decision; their rows in 🧮 All Models and their lines in the Bottom Line. DISPLAY ONLY,
 * computed after every score and decision is final: nothing here feeds a score, the conviction, the verdict, the timing,
 * the engine's option picks or a Buy report tier, and the reads stay out of the nightly Buy and Exit reports
 * (decision 8). Long calls only.
 *
 * These are James's models (InvestAnswers), not the owner's: every label says "James — ".
 */

import { jamesLeapsPicks, JAMES_LEAPS, type JamesCall, type JamesPick, type JamesContract } from './options/leapsPick.ts';
import { marketFireSale, stockFireSale, zSeries, FIRE_SALE_DEFAULT } from './options/fireSale.ts';
import { fairValueOf, atmIvOf, scenarioGrid, shortCallGuard, FAIR_VALUE, type FairValue } from './options/fairValue.ts';
import { realizedVol } from './options/blackScholes.ts';
import { formatDateInTz } from '../core/dates.ts';
import { RESULTS, NO_HISTORY, type ResultsPack } from '../profile/results.ts';

export const JAMES_LEAPS_NAME = 'James — LEAPS';
export const JAMES_FAIR_NAME = 'James — Option Fair Value';
const DISCLAIMER = 'Shown for information only: nothing on this page changes any score, the conviction, the verdict, the engine\'s option picks or the Buy report tiers. Long calls only.';

/**
 * History of the research list, $100,000, after tax, 10 bps per side (docs/models/results/phase4.md): the profile's results pack
 * (GENERIC_PLAN P4, profile/results.ts); null = no pack, the pages say NO_HISTORY.
 */
export const JAMES4_HISTORY: ResultsPack['james4'] | null = RESULTS?.james4 ?? null;
/** The research run's basis (list, hold yardstick, tax), for the history headers. */
const BASIS = RESULTS?.basis ?? null;

export interface JBars { readonly dates: ReadonlyArray<Date | string>; readonly closes: readonly number[] }
const ds = (d: Date | string | undefined, tz: string): string => (d == null ? '' : typeof d === 'string' ? d.slice(0, 10) : formatDateInTz(d, tz, 'yyyy-MM-dd'));
const usd = (n: number | null | undefined): string => (n == null ? '—' : '$' + n.toFixed(2));
const pc = (x: number | null | undefined, dp = 1): string => (x == null ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(dp) + '%');
const expTxt = (u: number): string => new Date(u * 1000).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', year: 'numeric' }).replace(' ', '-');
const isoDay = (u: number): string => new Date(u * 1000).toISOString().slice(0, 10);

// ─────────────────────────────── 🎯 James — LEAPS ───────────────────────────────

export type JamesLeapsVerdict = 'BUY (market fire sale, gates pass)' | 'BUY (stock fire sale and turnaround, gates pass)' | 'WAIT FOR TURNAROUND' | 'WAIT FOR A FIRE SALE' | 'NO LIQUID CONTRACT' | 'NO CHAIN';

export interface JamesLeapsRead {
  readonly status: 'ok' | 'noData';
  readonly day: string;
  readonly verdict: JamesLeapsVerdict;
  readonly market: { readonly dd: number | null; readonly on: boolean; readonly episodeStart: string | null };
  readonly stock: { readonly dd: number | null; readonly z: number | null; readonly signal: boolean; readonly armedSince: string | null; readonly buy: boolean; readonly why: string | null };
  /** The three side-by-side picks (null = the options did not run). */
  readonly picks: readonly JamesPick[] | null;
  readonly spot: number | null;
  /** For the main (0.75) contract: one slot of $20,000 — contracts, delta exposure / slot, cash to exercise one contract, the checklist start. */
  readonly main: { readonly contracts: number; readonly exposurePerSlot: number; readonly exerciseCash: number; readonly checklistFrom: string } | null;
}

export function buildJamesLeapsRead(stock: JBars | null | undefined, qqq: JBars | null | undefined, chain: { calls: readonly JamesCall[]; spot: number | null } | null, nowMs: number, optionsRun: boolean, tz = 'America/New_York'): JamesLeapsRead {
  const day = stock && stock.dates.length ? ds(stock.dates[stock.dates.length - 1], tz) : formatDateInTz(new Date(nowMs), tz, 'yyyy-MM-dd');
  const empty = { status: 'noData' as const, day, verdict: (optionsRun ? 'WAIT FOR A FIRE SALE' : 'NO CHAIN') as JamesLeapsVerdict, market: { dd: null, on: false, episodeStart: null }, stock: { dd: null, z: null, signal: false, armedSince: null, buy: false, why: null }, picks: null, spot: null, main: null };
  if (!stock || stock.closes.length < 30) return empty;
  const sd = stockFireSale(stock.closes)[stock.closes.length - 1]!, z = zSeries(stock.closes.slice(-40), 20).z.at(-1) ?? null;
  let market: JamesLeapsRead['market'] = { dd: null, on: false, episodeStart: null };
  if (qqq && qqq.closes.length > 30) { const m = marketFireSale(qqq.closes), x = m[m.length - 1]!; market = { dd: x.dd, on: x.on, episodeStart: x.episodeStart != null ? ds(qqq.dates[x.episodeStart], tz) : null }; }
  const spot = chain?.spot ?? (stock.closes[stock.closes.length - 1] as number);
  const picks = chain && chain.calls.length ? jamesLeapsPicks(chain.calls, spot, Math.floor(nowMs / 1000), day) : null;
  const m75 = picks?.find((p) => p.targetDelta === JAMES_LEAPS.mainDelta) ?? null, c = m75?.contract ?? m75?.nearest ?? null;
  const slot = 20_000, n = c && c.ask > 0 ? Math.max(Math.floor(slot / (c.ask * 100)), c.ask * 100 <= 1.5 * slot ? 1 : 0) : 0;
  const main = c ? { contracts: n, exposurePerSlot: (n * 100 * c.delta * spot) / slot, exerciseCash: c.strike * 100, checklistFrom: isoDay(c.expUnix - 7 * 86_400) } : null;
  const overext = z != null && z >= 2;
  const anyPass = !!picks && picks.some((p) => p.contract);
  const verdict: JamesLeapsVerdict = !optionsRun || !chain ? 'NO CHAIN'
    : (market.on || sd.buy) && !overext ? (anyPass && m75?.contract ? (market.on ? 'BUY (market fire sale, gates pass)' : 'BUY (stock fire sale and turnaround, gates pass)') : 'NO LIQUID CONTRACT')
      : sd.armedSince != null ? 'WAIT FOR TURNAROUND' : 'WAIT FOR A FIRE SALE';
  return {
    status: 'ok', day, verdict, market,
    stock: { dd: sd.dd, z, signal: sd.signal, armedSince: sd.armedSince != null ? ds(stock.dates[sd.armedSince], tz) : null, buy: sd.buy, why: sd.why },
    picks, spot, main,
  };
}

const gateText = (c: JamesContract): string => (c.passes ? '✓' : '✗ ' + c.gates.filter((g) => !g.ok).map((g) => g.name).join(', '));
function contractRow(p: JamesPick): string {
  const c = p.contract ?? p.nearest;
  if (!c) return '  ' + p.targetDelta.toFixed(2) + '   — ' + (p.reason ?? 'no contract');
  return '  ' + p.targetDelta.toFixed(2) + '   $' + c.strike + '  ' + usd(c.bid) + '/' + usd(c.ask) + '  ' + usd(c.breakEven) + ' (' + pc(c.bem) + ')  ' + pc(c.bemYear) + '  ' + pc(c.timeValuePct)
    + '  ' + (c.spread == null ? '—' : (c.spread * 100).toFixed(1) + '%') + '  ' + (c.oi ?? 0).toLocaleString('en-US') + '  ' + gateText(c) + (p.contract && p.nearest && p.contract !== p.nearest ? ' (stepped from $' + p.nearest.strike + ')' : '') + (c.deltaSource === 'black-scholes' ? ' (delta from Black-Scholes)' : '');
}

export function formatJamesLeapsPage(ticker: string, r: JamesLeapsRead): string {
  const out = ['── ' + ticker + ' — ' + JAMES_LEAPS_NAME + ' (January, in the money, fire sale; display only) ──', '', DISCLAIMER,
    'James\'s LEAPS practice (InvestAnswers): a January call about 22 months out (his GOOG buy; members\' logs 16-20 months), in the money or about at the money, bought in a fire sale — "during the C19 DIP" for the March 2020 crash, with no turnaround wait; "I need to see the turnaround" for a weak single stock (COIN) — after a break-even check ("the length of time, the cost, and return"). Holding to expiry and exercising is inferred from his expiry post to members. Every threshold below is a stand-in fixed in advance (plan 03); James gives none.'];
  if (r.status !== 'ok') return [...out, '', 'METHOD VERDICT: ' + r.verdict, 'No price data this run.'].join('\n');
  out.push('', 'METHOD VERDICT: ' + r.verdict);
  const m = r.market;
  out.push('  Market: ' + (m.dd == null ? 'QQQ\'s prices were not available this run.' : 'QQQ is ' + (m.dd * 100).toFixed(1) + '% below its 52-week closing high (market fire sale = ' + FIRE_SALE_DEFAULT.marketDrop * 100 + '%+' + (m.on ? '; ON — episode from ' + m.episodeStart + ', one buy per stock per episode' : '') + '; James bought GOOG during the March 2020 dip, so no turnaround is needed for a market fire sale).'));
  const s = r.stock;
  out.push('  ' + ticker + ': ' + ((s.dd ?? 0) * 100).toFixed(1) + '% below its 52-week high (stock fire sale = ' + FIRE_SALE_DEFAULT.stockDrop * 100 + '%+ and a -2 SD close in the last 20 days, then a turnaround: a close back above the 20-day average within ' + FIRE_SALE_DEFAULT.window + ' days)'
    + (s.armedSince ? '; ARMED since ' + s.armedSince + ', waiting for the turnaround' : '') + (s.buy ? '; ' + s.why : '') + '.',
    '  z today ' + (s.z == null ? '—' : (s.z >= 0 ? '+' : '') + s.z.toFixed(1)) + ' (no new call at +2 or more).');
  if (r.main) out.push('  Delta exposure if the 0.75 contract were bought with one $20,000 slot (' + r.main.contracts + ' contract' + (r.main.contracts === 1 ? '' : 's') + '): ' + r.main.exposurePerSlot.toFixed(1) + ' x the slot\'s value.');
  if (!r.picks) out.push('', 'CONTRACTS: the options analysis did not run this report (no chain).');
  else {
    const e = r.picks.find((p) => p.expUnix != null)?.expUnix ?? null;
    out.push('', 'CONTRACTS IF BOUGHT TONIGHT' + (e ? ' (' + expTxt(e) + ' — the January closest to ' + JAMES_LEAPS.targetMonths + ' months within ' + JAMES_LEAPS.minMonths + '-' + JAMES_LEAPS.maxMonths + ' months; a January 16-22 months out exists only for decisions made March-September)' : ''),
      '  Delta  Strike  Bid/ask  Break-even  Per year  Time value  Spread  OI  Gates (break-even <= ' + JAMES_LEAPS.beGate * 100 + '%/yr, bid > 0, spread <= ' + JAMES_LEAPS.maxSpread * 100 + '%, OI >= ' + JAMES_LEAPS.minOi + ')',
      ...r.picks.map(contractRow), '  (Fair value and IV vs realized: see the ⚖️ ' + JAMES_FAIR_NAME + ' page.)');
  }
  if (r.main) {
    const c = r.picks?.find((p) => p.targetDelta === JAMES_LEAPS.mainDelta)?.contract ?? r.picks?.find((p) => p.targetDelta === JAMES_LEAPS.mainDelta)?.nearest;
    if (c) out.push('', 'EXIT VARIANTS (owner decision 5; both run in the paper test): (a) hold to ' + isoDay(c.expUnix) + ' and exercise — inferred from James\'s expiry post (cash needed for 1 contract at $' + c.strike + ': $' + r.main.exerciseCash.toLocaleString('en-US') + '; the expiry checklist starts ' + r.main.checklistFrom + ': ITM by $0.01+ exercises automatically, have the cash or sell to close early, act early on expiry day); (b) sell at 60 days to expiry (our paper rule). Trim a third on a +2 SD spike (variant).');
  }
  const H = JAMES4_HISTORY;
  if (!H || !BASIS) out.push('', 'HISTORY', '  ' + NO_HISTORY);
  else out.push('', 'HISTORY (' + BASIS.list + ', $100,000, after the ' + BASIS.tax + ' tax, 10 bps per side; 2010-19 / 2020-23 / 2024-26; nothing chosen on the LEAPS layer)',
    '  The timing in shares (exact): ' + H.shares + ', deepest fall ' + H.sharesFall + '.',
    '  LEAPS (APPROXIMATE: Black-Scholes on the stock\'s own 1-year volatility, 3% half-spread; no option history exists): delta 0.75 to expiry, capped at 1 x equity ' + H.leapsCap + ' (fall ' + H.leapsCapFall + '); uncapped ' + H.leapsUncapped + ' (fall ' + H.leapsUncappedFall + ').',
    '  📊 Hold QQQ ' + H.qqq + '; 📊 ' + BASIS.holdList + ' ' + H.list14 + '. Verdict: ' + H.verdict + '.',
    '  PAPER TEST: the "E James LEAPS" accounts (fire sale 0.60 / 0.75 / 0.85, to expiry or the 60-day roll, the capped headline, spike trim, fair-value filter; James\'s pick on Everything together; the Multi-Year Cycle\'s LEAPS twin), each against 📊 QQQ since it joined.');
  return out.join('\n');
}

/** The short block on 📞 Options Decision (after the existing blocks; those stay word for word). */
export function optionsDecisionJamesLines(r: JamesLeapsRead | null, n: number): string[] {
  if (!r) return [];
  const c = r.picks?.find((p) => p.targetDelta === JAMES_LEAPS.mainDelta);
  const k = c?.contract ?? c?.nearest ?? null;
  return ['', n + '. JAMES — LEAPS (model 3, display only): ' + r.verdict + (k ? ' — ' + expTxt(k.expUnix) + ' $' + k.strike + ' call (delta ' + k.delta.toFixed(2) + ') ' + (k.passes ? 'passes' : 'fails') + ' the break-even (' + pc(k.bemYear) + '/yr) and liquidity gates' : '') + '. Details on 🎯 ' + JAMES_LEAPS_NAME + '.'];
}

// ─────────────────────────────── ⚖️ James — Option Fair Value ───────────────────────────────

export interface FairRow { readonly label: string; readonly contract: { strike: number; expUnix: number; bid: number | null; ask: number | null; iv: number | null; delta: number | null }; readonly fv: FairValue }
export interface FairValueRead {
  readonly status: 'ok' | 'noData';
  readonly spot: number | null;
  readonly rv20: number | null; readonly rv60: number | null; readonly rv252: number | null; readonly rate: number;
  readonly rows: readonly FairRow[];
  readonly grid: Array<{ label: string; values: number[] }> | null;
  readonly guard: { ok: boolean; reasons: readonly string[] } | null;
}

interface PickLike { found?: boolean; contract?: { strike?: number; expUnix?: number; bid?: number; ask?: number; iv?: number; delta?: number } }
const pickC = (p: unknown): FairRow['contract'] | null => {
  const x = p as PickLike | null | undefined;
  const c = x && x.found ? x.contract : null;
  return c && typeof c.strike === 'number' && typeof c.expUnix === 'number' ? { strike: c.strike, expUnix: c.expUnix, bid: c.bid ?? null, ask: c.ask ?? null, iv: c.iv ?? null, delta: c.delta ?? null } : null;
};

export function buildFairValueRead(stock: JBars | null | undefined, engineLeaps: unknown, shortTerm: unknown, jl: JamesLeapsRead | null, chain: { calls: readonly JamesCall[]; spot: number | null } | null, nowMs: number, rate: number): FairValueRead {
  const closes = stock?.closes ?? [];
  const spot = chain?.spot ?? (closes.length ? (closes[closes.length - 1] as number) : null);
  const rv20 = realizedVol(closes, 20), rv60 = realizedVol(closes, 60), rv252 = realizedVol(closes, 252);
  const nowUnix = Math.floor(nowMs / 1000), vols = { rv20, rv60, rv252 };
  const rows: FairRow[] = [];
  const add = (label: string, c: FairRow['contract'] | null): void => {
    if (!c || spot == null) return;
    rows.push({ label, contract: c, fv: fairValueOf(c, spot, nowUnix, vols, rate, chain ? atmIvOf(chain.calls, c.expUnix, spot) : null) });
  };
  add('Engine LEAPS pick', pickC(engineLeaps));
  const j = jl?.picks?.find((p) => p.targetDelta === JAMES_LEAPS.mainDelta), jc = j?.contract ?? j?.nearest ?? null;
  add('James — LEAPS 0.75', jc ? { strike: jc.strike, expUnix: jc.expUnix, bid: jc.bid, ask: jc.ask, iv: jc.iv, delta: jc.delta } : null);
  add('Short-term pick', pickC(shortTerm));
  const main = rows.find((r) => r.label === 'James — LEAPS 0.75') ?? rows[0];
  const sig = main ? (main.fv.iv ?? main.fv.refVol) : null;
  const grid = main && sig && spot != null ? scenarioGrid(main.contract, spot, nowUnix, sig, rate) : null;
  const z = closes.length >= 20 ? zSeries(closes.slice(-40), 20).z.at(-1) ?? null : null;
  const guard = rows.some((r) => r.label === 'Short-term pick') ? shortCallGuard({ z, tradingDaysToEarnings: null }) : null;
  return { status: spot == null ? 'noData' : 'ok', spot, rv20, rv60, rv252, rate, rows, grid, guard };
}

export function formatFairValuePage(ticker: string, r: FairValueRead): string {
  const out = ['── ' + ticker + ' — ' + JAMES_FAIR_NAME + ' (James\'s Black-Scholes model; long calls only) ──', '', DISCLAIMER,
    'James\'s Black-Scholes sheets (2021-2023) as code: fair value, time value ("speculative premium"), greeks. James: "I use different sources to calculate volatility depending on where the stock is" — here 1-year realized for LEAPS, 60-day for short-term calls (plan 04 defaults).'];
  if (r.status !== 'ok') return [...out, '', 'No price data this run.'].join('\n');
  out.push('', 'Realized volatility: 20-day ' + pc(r.rv20, 0).replace('+', '') + ', 60-day ' + pc(r.rv60, 0).replace('+', '') + ', 1-year ' + pc(r.rv252, 0).replace('+', '') + '. Rate ' + (r.rate * 100).toFixed(2) + '% (the previous month\'s Fed funds).');
  if (!r.rows.length) { out.push('', 'No option contract this run (the options analysis did not run, or no pick was found).'); return out.join('\n'); }
  for (const x of r.rows) {
    const f = x.fv, c = x.contract;
    out.push('', x.label.toUpperCase() + ': ' + expTxt(c.expUnix) + ' $' + c.strike + ' call (' + Math.round(f.dte) + ' days)',
      '  Market (mid) ' + usd(f.mid) + '; fair at RV252 / RV60 ' + usd(f.fairRv252) + ' / ' + usd(f.fairRv60) + '; rich vs ' + f.refName + ' ' + pc(f.rich) + (f.richFlag ? '  ⚠ above +' + FAIR_VALUE.rich * 100 + '%' : ''),
      '  IV (chain) / ATM IV ' + pc(f.iv, 0).replace('+', '') + ' / ' + pc(f.atmIv, 0).replace('+', '') + '; IV ÷ realized ' + (f.ivr == null ? '—' : f.ivr.toFixed(2)) + (f.ivrFlag ? '  ⚠ above ' + FAIR_VALUE.ivr : '') + (f.impliedFromMid != null ? '; the mid implies ' + (f.impliedFromMid * 100).toFixed(0) + '%' : ''),
      '  Intrinsic / time value ' + usd(f.intrinsic) + ' / ' + usd(f.timeValue) + '; time value ' + pc(f.tvPct).replace('+', '') + ' of the price, ' + usd(f.tvPerDay) + ' a day; yearly time cost per delta ' + pc(f.yearlyTimeCostPerDelta).replace('+', ''),
      '  Break-even ' + usd(f.breakEven) + ' (' + pc(f.moveNeeded) + (f.dte >= 365 ? ', ' + pc(f.moveNeededPerYear) + '/yr' : ' by expiry') + ')',
      f.greeks ? '  Greeks (per day, per vol point): delta ' + f.greeks.delta.toFixed(2) + ', gamma ' + f.greeks.gamma.toFixed(4) + ', theta ' + f.greeks.thetaPerDay.toFixed(3) + ', vega ' + f.greeks.vegaPerPoint.toFixed(3) : '  Greeks: not available');
  }
  out.push('', 'IV RANK: collecting — the 📉 IV History tab stores one night per ticker from phase 0; a true rank over time needs 252 nights (the 📞 Options Decision page\'s figure is a percentile within today\'s chain, not over time).');
  if (r.guard) out.push('SHORT-TERM GUARD: ' + (r.guard.ok ? 'clear on the price (z under +2); earnings: unknown on this page' : '⚠ ' + r.guard.reasons.join('; ')) + ' (the guard is shown only; on history, entries at z >= +2 were not worse — see results/phase4.md).');
  if (r.grid && r.spot != null) {
    const main = r.rows.find((x) => x.label === 'James — LEAPS 0.75') ?? r.rows[0]!;
    out.push('', 'WHAT THE CALL IS WORTH (' + main.label + ', at today\'s IV)', '  Stock      -20%     -10%     today    +10%     +20%');
    for (const g of r.grid) out.push('  ' + g.label.padEnd(10) + ' ' + g.values.map((v) => usd(v).padEnd(8)).join(' ') + (g.label === 'at expiry' ? ' (intrinsic only)' : ''));
  }
  return out.join('\n');
}

// ─────────────────────────────── reads, 🧮 All Models, Bottom Line ───────────────────────────────

export interface James4Reads { readonly leaps: JamesLeapsRead; readonly fair: FairValueRead }

export function readJames4Reads(x: unknown): James4Reads | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>, l = o['leaps'] as Record<string, unknown> | undefined, f = o['fair'] as Record<string, unknown> | undefined;
  if (!l || !f || typeof l !== 'object' || typeof f !== 'object' || typeof l['verdict'] !== 'string' || !Array.isArray(f['rows'])) return null;
  return x as James4Reads;
}

export interface James4RowText { readonly key: 'JAMES_LEAPS' | 'JAMES_FAIR_VALUE'; readonly model: string; readonly read: string; readonly why: string }
const fairWord = (r: FairValueRead): string => {
  const f = r.rows.find((x) => x.label === 'James — LEAPS 0.75')?.fv ?? r.rows[0]?.fv;
  if (!f) return 'Not available';
  return f.richFlag ? 'Rich ' + pc(f.rich, 0) : f.ivrFlag ? 'IV high vs realized' : 'Fair';
};
const leapsRead = (v: JamesLeapsVerdict): string => (v.startsWith('BUY') ? 'Buy' : v === 'WAIT FOR TURNAROUND' ? 'Wait for turnaround' : v === 'WAIT FOR A FIRE SALE' ? 'Wait for a fire sale' : v === 'NO LIQUID CONTRACT' ? 'No liquid contract' : 'No chain');

export function james4AllModelsRows(j: James4Reads | null): James4RowText[] {
  const notRun = 'This model did not run.';
  if (!j) return [{ key: 'JAMES_LEAPS', model: JAMES_LEAPS_NAME + ' (fire sale, January, delta 0.75)', read: 'Not available', why: notRun }, { key: 'JAMES_FAIR_VALUE', model: JAMES_FAIR_NAME + ' (Black-Scholes, tool)', read: 'Not available', why: notRun }];
  const l = j.leaps, f = j.fair;
  const k = l.picks?.find((p) => p.targetDelta === JAMES_LEAPS.mainDelta)?.contract ?? null;
  return [
    { key: 'JAMES_LEAPS', model: JAMES_LEAPS_NAME + ' (fire sale, January, delta 0.75)', read: leapsRead(l.verdict), why: l.status !== 'ok' ? notRun : 'QQQ ' + ((l.market.dd ?? 0) * 100).toFixed(0) + '% and the stock ' + ((l.stock.dd ?? 0) * 100).toFixed(0) + '% under their 52-week highs' + (k ? '; ' + expTxt(k.expUnix) + ' $' + k.strike + ' passes the gates' : '') + '.' },
    { key: 'JAMES_FAIR_VALUE', model: JAMES_FAIR_NAME + ' (Black-Scholes, tool)', read: fairWord(f), why: f.rows.length ? f.rows.map((x) => x.label + ' ' + pc(x.fv.rich, 0) + ' vs ' + x.fv.refName).join('; ') + '.' : 'No option contract this run.' },
  ];
}

export function james4BottomLines(j: James4Reads): Array<[string, string]> {
  const out: Array<[string, string]> = [['🎯 ' + JAMES_LEAPS_NAME, j.leaps.verdict]];
  const f = j.fair.rows.filter((x) => x.fv.richFlag || x.fv.ivrFlag);
  if (f.length) out.push(['⚖️ ' + JAMES_FAIR_NAME, f.map((x) => x.label + ': ' + (x.fv.richFlag ? 'rich ' + pc(x.fv.rich, 0) + ' vs ' + x.fv.refName : 'IV ' + (x.fv.ivr ?? 0).toFixed(2) + ' x realized')).join('; ')]);
  return out;
}
