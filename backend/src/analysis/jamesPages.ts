/**
 * James's models, phase 1 (docs/models/MASTER_PLAN.md section 5): the report pages "🪜 James — LILO v2" and
 * "💰 James — Profit-Taking" in the Full Ticker Analysis (and the PDF), their rows in 🧮 All Models and their lines in
 * the Bottom Line. DISPLAY ONLY: computed after every score and decision is final, from the dated 10-year daily bars
 * (G0b; the 2-year chart when that fetch fails, said on the page). Nothing here feeds a score, the conviction, the
 * verdict, the timing or a Buy report tier, and the new reads stay out of the nightly Buy and Exit reports (decision 8).
 *
 * These are James's models (InvestAnswers), not the owner's: every label says "James — ".
 */

import { layersAt, layerOf, bandWords, smaSeries, snipeLayers, layerOptionsName, DEFAULT_LAYER_OPTIONS, BUY_ZONE_TOP, LAYER_MULTIPLIERS, type LayerOptions } from './models/liloLayers.ts';
import { scheduleLevels, sheetTable, PT_SCHEDULES, PT_SPEC, type PtSchedule } from './models/profitTaking.ts';
import { formatDateInTz } from '../core/dates.ts';
import { EXIT_TAX_PCT } from '../portfolio/exitTax.ts';
import { RESULTS, NO_HISTORY, type ResultsPack } from '../profile/results.ts';

export const JAMES_LILO_V2_NAME = 'James — LILO v2';
export const JAMES_PT_NAME = 'James — Profit-Taking';
export const JAMES_DISCLAIMER = 'Shown for information only: nothing on this page changes any score, the conviction, the verdict or the Buy report tiers.';

/**
 * The LILO v2 setup chosen on 2010-2019 only (research/liloV2Cli.ts LILO_V2_CHOSEN; a test keeps the two equal):
 * anchor A3 (the latest 200-day up-cross), u = 0.35 x L0 (U2), snipe buys at the next 2 layers under the close up to
 * layer 8, 4 equal tranches, no layer-out, a stop 3% under the 200-day average, 5 stocks at a time.
 */
export const LILO_V2_PAGE: { readonly layers: LayerOptions; readonly depth: number; readonly maxBuyLayer: number; readonly schedule: PtSchedule | 'none'; readonly stop: 'trend200' | 'none' } = {
  layers: { anchor: 'A3', minAge: 63, unit: 'U2', k: 0.35 }, depth: 2, maxBuyLayer: 8, schedule: 'none', stop: 'trend200',
};
/** James — Profit-Taking: the schedule chosen on 2010-2019 (research/profitTakingCli.ts) on G1's default anchor layers (plan 02 P1). */
export const PT_PAGE: { readonly layers: LayerOptions; readonly schedule: PtSchedule } = { layers: DEFAULT_LAYER_OPTIONS, schedule: 'A20' };

/**
 * History of the research list, $100,000, after tax, 10 bps per side (docs/models/results/phase1.md): the profile's
 * results pack (GENERIC_PLAN P4, profile/results.ts); null = no pack, the pages say NO_HISTORY.
 */
export const JAMES_HISTORY: ResultsPack['james'] | null = RESULTS?.james ?? null;
/** The research run's basis (list, hold yardstick, tax), for the history headers. */
const BASIS = RESULTS?.basis ?? null;

// ─────────────────────────────── the read ───────────────────────────────

export interface JamesBars {
  readonly dates: ReadonlyArray<Date | string>;
  readonly closes: readonly number[];
  readonly highs: readonly number[];
  readonly lows: readonly number[];
}

/** One stock's layers today (plain JSON: it travels with the run's ExtraModelsReport to the Bottom Line). */
export interface JamesLayersRead {
  readonly status: 'ok' | 'noAnchor' | 'noData';
  /** '10y' = the G0b dated 10-year bars; '2y' = the run's chart (the 10-year fetch failed). */
  readonly bars: '10y' | '2y';
  readonly rule: string;
  readonly anchorDate: string | null;
  readonly L0: number | null;
  readonly u: number | null;
  readonly levels: readonly number[];
  readonly close: number | null;
  /** -1 under L0, k between L_k and L_k+1, 10 above L10; null without layers. */
  readonly band: number | null;
  /** The 200-day average today, for the stop line. */
  readonly sma200: number | null;
}
export interface JamesReads { readonly liloV2: JamesLayersRead; readonly profitTaking: JamesLayersRead }

const dateText = (d: Date | string | undefined, tz: string): string | null => (d == null ? null : typeof d === 'string' ? d.slice(0, 10) : formatDateInTz(d, tz, 'yyyy-MM-dd'));

export function buildJamesLayersRead(b: JamesBars | null | undefined, o: LayerOptions, src: '10y' | '2y', timeZone = 'America/New_York'): JamesLayersRead {
  const rule = layerOptionsName(o);
  const none = (status: JamesLayersRead['status'], close: number | null = null, sma200: number | null = null): JamesLayersRead => ({ status, bars: src, rule, anchorDate: null, L0: null, u: null, levels: [], close, band: null, sma200 });
  if (!b || !b.closes.length) return none('noData');
  const i = b.closes.length - 1, close = b.closes[i] as number;
  const sma = smaSeries(b.closes, 200)[i] ?? null;
  const ls = layersAt({ closes: b.closes, highs: b.highs, lows: b.lows }, i, o);
  if (!ls) return none('noAnchor', close, sma);
  return { status: 'ok', bars: src, rule, anchorDate: dateText(b.dates[ls.anchorIndex], timeZone), L0: ls.L0, u: ls.u, levels: [...ls.levels], close, band: layerOf(close, ls.levels), sma200: sma };
}

/** Both pages' reads from one set of bars. */
export function buildJamesReads(b: JamesBars | null | undefined, src: '10y' | '2y', timeZone = 'America/New_York'): JamesReads {
  return { liloV2: buildJamesLayersRead(b, LILO_V2_PAGE.layers, src, timeZone), profitTaking: buildJamesLayersRead(b, PT_PAGE.layers, src, timeZone) };
}

/** Defensive reader (the read arrives as `unknown` through the pipelines and the analysis cache). */
export function readJamesReads(x: unknown): JamesReads | null {
  const one = (y: unknown): JamesLayersRead | null => {
    if (!y || typeof y !== 'object') return null;
    const r = y as Record<string, unknown>;
    if (r['status'] !== 'ok' && r['status'] !== 'noAnchor' && r['status'] !== 'noData') return null;
    const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      status: r['status'], bars: r['bars'] === '2y' ? '2y' : '10y', rule: typeof r['rule'] === 'string' ? r['rule'] : '', anchorDate: typeof r['anchorDate'] === 'string' ? r['anchorDate'] : null,
      L0: n(r['L0']), u: n(r['u']), levels: Array.isArray(r['levels']) ? (r['levels'] as unknown[]).filter((v): v is number => typeof v === 'number') : [], close: n(r['close']), band: n(r['band']), sma200: n(r['sma200']),
    };
  };
  if (!x || typeof x !== 'object') return null;
  const a = one((x as Record<string, unknown>)['liloV2']), b = one((x as Record<string, unknown>)['profitTaking']);
  return a && b ? { liloV2: a, profitTaking: b } : null;
}

// ─────────────────────────────── words ───────────────────────────────

const usd = (n: number): string => '$' + n.toFixed(2);
const away = (p: number, close: number): string => { const x = (p / close - 1) * 100; return (x >= 0 ? '+' : '') + x.toFixed(1) + '% from today'; };
const NO_ANCHOR = 'No anchor (the price has not closed up through its 200-day average with enough history)';

/** "In the buy zone (between layer 2 and 3)" / "In the sell zone (above layer 10)" / "No anchor". */
export function todayWords(r: JamesLayersRead): string {
  if (r.status === 'noData') return 'Not available (no price data this run)';
  if (r.status === 'noAnchor' || r.band == null) return NO_ANCHOR;
  if (r.band < 0) return 'Under layer 0 (below the anchor close)';
  return (r.band >= 6 ? 'In the sell zone (' : 'In the buy zone (') + bandWords(r.band).replace(/ \((buy|sell) zone\)| \(top of the buy zone\)/, '') + ')';
}
const shortRead = (r: JamesLayersRead): string => (r.status !== 'ok' || r.band == null ? (r.status === 'noData' ? 'Not available' : 'No anchor') : r.band < 0 ? 'Under layer 0' : r.band >= 6 ? 'In sell zone' : 'In buy zone');

const barsLine = (r: JamesLayersRead): string => (r.bars === '10y' ? 'Built on 10 years of daily bars.' : 'Built on the run\'s 2 years of bars (the 10-year fetch failed this run), so an anchor older than about 14 months may be missed.');
const unitWords = (r: JamesLayersRead, o: LayerOptions): string => 'Layer unit u = ' + (r.u != null ? usd(r.u) : '—') + ' (' + (o.unit === 'U1' ? o.k + ' x the 50-day standard deviation of the close at the anchor' : o.unit === 'U2' ? o.k + ' x the anchor close' : o.unit === 'U3' ? o.k + ' x the 20-day average true range at the anchor' : o.k + ' x the standard deviation of the 63 closes after the anchor') + ') — estimated: the original indicator\'s unit is not public.';
const anchorWords = (o: LayerOptions): string => (o.anchor === 'A1' ? 'the latest up-cross at least ' + o.minAge + ' trading days old' : 'the latest up-cross');

function stopLine(r: JamesLayersRead): string {
  if (LILO_V2_PAGE.stop === 'none') return 'None (James gives no stop).';
  const base = 'A close more than 3% under the 200-day average sells everything at the next open (chosen on 2010-2019; James\'s files give no stop).';
  if (r.sma200 == null || r.close == null) return base + ' Not enough history for the 200-day average today.';
  const x = (r.close / r.sma200 - 1) * 100;
  return base + ' Today the 200-day average is ' + usd(r.sma200) + ' and the close is ' + Math.abs(x).toFixed(1) + '% ' + (x >= 0 ? 'above' : 'below') + ' it — ' + (r.close < 0.97 * r.sma200 ? 'a holder would sell.' : 'no stop.');
}

// ─────────────────────────────── 🪜 James — LILO v2 ───────────────────────────────

export function formatLiloV2Page(ticker: string, r: JamesLayersRead): string {
  const o = LILO_V2_PAGE.layers;
  const out = ['── ' + ticker + ' — ' + JAMES_LILO_V2_NAME + ' (the original layers) ──', '', JAMES_DISCLAIMER,
    'James\'s model (InvestAnswers, his IA-LILO-Model indicator), rebuilt from his posts and screenshots. It is not this app\'s own 🪜 LILO Model; the two run side by side.'];
  out.push('', '1. TODAY: ' + todayWords(r).toUpperCase());
  if (r.close != null) out.push('  Close ' + usd(r.close) + '.');
  out.push('', '2. THE ANCHOR');
  if (r.status === 'ok') {
    out.push('  ' + r.anchorDate + ': the close ' + usd(r.L0 as number) + ' crossed up through the 200-day average (layer 0). Rule: ' + anchorWords(o) + ' (' + r.rule + ').');
    out.push('  ' + unitWords(r, o));
  } else out.push('  ' + (r.status === 'noData' ? 'No price data this run.' : 'No usable anchor: no close up through the 200-day average in the bars available.'));
  out.push('  ' + barsLine(r));
  out.push('', '3. THE 11 LAYERS (layer k = layer 0 + u x 0, .382, .618, .809, 1, 1.272, 1.618, 2.618, 4.236, 5.854, 6.854)');
  if (r.status !== 'ok' || r.close == null) out.push('  None today.');
  else {
    for (let k = 10; k >= 0; k--) {
      out.push('  Layer ' + k + ': ' + usd(r.levels[k] as number) + ' (' + (k <= BUY_ZONE_TOP ? 'buy zone' : 'sell zone') + ', ' + away(r.levels[k] as number, r.close) + ')');
      if (r.band === k) out.push('    ◀ today ' + usd(r.close) + ' is ' + bandWords(k));
    }
    if (r.band === -1) out.push('    ◀ today ' + usd(r.close) + ' (under layer 0)');
  }
  out.push('', '4. ORDERS IT WOULD HAVE TONIGHT');
  if (r.status !== 'ok' || r.close == null) out.push('  None (no anchor).');
  else {
    const sn = snipeLayers(r.levels, r.close, [], LILO_V2_PAGE);
    out.push('  Snipe buys (resting limit buys at the next ' + LILO_V2_PAGE.depth + ' layers under the close, up to layer ' + LILO_V2_PAGE.maxBuyLayer + ', each a quarter of the stock\'s budget): '
      + (sn.length ? sn.map((k) => 'layer ' + k + ' at ' + usd(r.levels[k] as number)).join(', ') : 'none (no layer under the close)') + '.');
    out.push('  Layer-out: ' + (LILO_V2_PAGE.schedule === 'none' ? 'none in the setup chosen on 2010-2019 (it holds what it buys until the stop). James\'s own sell schedules at layers 6-10 are on 💰 James — Profit-Taking.'
      : PT_SPEC[LILO_V2_PAGE.schedule].name + ' at ' + scheduleLevels(r.levels, LILO_V2_PAGE.schedule).map(usd).join(', ') + '.'));
  }
  out.push('', '5. STOP', '  ' + stopLine(r));
  out.push('', '6. HOW IT DIFFERS FROM 🪜 LILO MODEL',
    '  - Anchor: the close of a 200-day up-cross, not the engine\'s confluence buy zone of tonight.',
    '  - Layers: 11 fixed golden-ratio levels above the anchor (' + LAYER_MULTIPLIERS.map((m) => m.toFixed(3)).join(', ') + ' x u), not equal rungs inside a zone; buys wait as limit orders at the layers with no expiry.',
    '  - Selling: James\'s schedules at layers 6-10 (the chosen setup: none, with the 200-day stop), not half at T1 and half at T2.');
  const H = JAMES_HISTORY;
  if (!H || !BASIS) out.push('', '7. HISTORY', '  ' + NO_HISTORY);
  else out.push('', '7. HISTORY (' + BASIS.list + ' stocks, $100,000, after the ' + BASIS.tax + ' tax, 10 bps per side; 2010-19 / 2020-23 / 2024-26)',
    '  Setup chosen on 2010-2019 only (' + anchorWords(o) + ', u = ' + o.k + ' x layer 0, no layer-out, the 200-day stop): ' + H.liloV2.chosen + ' (2010-2019 in-sample; the later two out-of-sample), deepest fall ' + H.liloV2.fall + '.',
    '  Pre-registered default (A1-63, U1 k=5, James\'s A20 schedule): ' + H.liloV2.defaultRun + '.',
    '  📊 Hold QQQ ' + H.qqq + '; 📊 ' + BASIS.holdList + ' ' + H.list14 + '.',
    '  Verdict: ' + H.liloV2.verdict + '. It runs in the paper test as information (account "James — LILO v2").');
  return out.join('\n');
}

// ─────────────────────────────── 💰 James — Profit-Taking ───────────────────────────────

const sh = (n: number): string => (Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : n.toFixed(1));

export function formatProfitTakingPage(ticker: string, r: JamesLayersRead): string {
  const out = ['── ' + ticker + ' — ' + JAMES_PT_NAME + ' (layers 6-10) ──', '', JAMES_DISCLAIMER,
    'This is an exit plan for shares you already own. It does not say buy.',
    'James\'s Master Profit-Taking template (InvestAnswers, 2023-10-12 and 2023-12-03): sell in steps at the LILO layers 6-10.'];
  out.push('', '1. THE SELL LAYERS TODAY');
  if (r.status !== 'ok' || r.close == null) {
    out.push('  ' + (r.status === 'noData' ? 'No price data this run.' : NO_ANCHOR + ', so there are no sell layers today.'), '  ' + barsLine(r));
  } else {
    out.push('  From the James — LILO v2 layers: anchor ' + r.anchorDate + ' at ' + usd(r.L0 as number) + ', ' + r.rule + '. ' + unitWords(r, PT_PAGE.layers));
    const c = scheduleLevels(r.levels, 'C');
    c.forEach((p, k) => out.push('  ' + (k < 5 ? 'Layer ' + (6 + k) : 'Layer 10 x 1.2^' + (k - 4) + ' (staggered schedule only)') + ': ' + usd(p) + ' (' + away(p, r.close as number) + ')' + (p <= (r.close as number) ? ' — already reached' : '')));
    out.push('  ' + barsLine(r));
    out.push('', '2. THE FIVE SCHEDULES for a holder of 100 shares (James\'s sheet with the member-found fix: value if held = the last layer x the shares; cost = today\'s close; before tax)');
    for (const id of PT_SCHEDULES) {
      const t = sheetTable(r.close, 100, scheduleLevels(r.levels, id), id);
      out.push('  ' + id + ' — ' + PT_SPEC[id].name + (id === PT_PAGE.schedule ? ' [chosen]' : ''));
      t.columns.forEach((x, k) => out.push('    ' + (k < 5 ? 'Layer ' + (6 + k) : 'x1.2^' + (k - 4)) + ' ' + usd(x.price) + ': sell ' + sh(x.sold) + ', left ' + sh(x.remaining) + ', cash so far ' + usd(x.cash) + ', the rest worth ' + usd(x.valueRemaining) + ', total ' + usd(x.total)));
      out.push('    Value if held to the last step: ' + usd(t.hodl) + '; money left on the table: ' + usd(t.leftOnTable) + '.');
    }
  }
  const H = JAMES_HISTORY;
  if (!H || !BASIS) out.push('', '3. WHICH SCHEDULE WAS CHOSEN', '  ' + NO_HISTORY);
  else out.push('', '3. WHICH SCHEDULE WAS CHOSEN (on 2010-2019 only; history on ' + BASIS.list + ', after the ' + BASIS.tax + ' tax, 10 bps per side)',
    '  ' + H.profitTaking.line + '.', '  ' + H.profitTaking.detail + '.', '  Verdict: ' + H.profitTaking.verdict + '. It runs in the paper test as information (accounts "James — Profit-Taking ...").');
  out.push('', '4. NOTE', '  Every sale is a taxable event (' + EXIT_TAX_PCT + ' of the gain here). The layers depend on the estimated unit u; layers already under today\'s close count as reached.');
  return out.join('\n');
}

// ─────────────────────────────── 🧮 All Models / Bottom Line ───────────────────────────────

export interface JamesRowText { readonly key: 'LILO_V2' | 'PROFIT_TAKING'; readonly model: string; readonly read: string; readonly why: string }

/** The next sell step of the chosen schedule from today's close (null when none is left or there are no layers). */
export function nextSellStep(r: JamesLayersRead): { layer: string; price: number } | null {
  if (r.status !== 'ok' || r.close == null) return null;
  const lv = scheduleLevels(r.levels, PT_PAGE.schedule);
  const k = lv.findIndex((p) => p > (r.close as number));
  return k < 0 ? null : { layer: k < 5 ? 'layer ' + (6 + k) : 'layer 10 x 1.2^' + (k - 4), price: lv[k] as number };
}

export function jamesAllModelsRows(j: JamesReads | null): JamesRowText[] {
  const notRun = 'This model did not run.';
  if (!j) return [{ key: 'LILO_V2', model: JAMES_LILO_V2_NAME, read: 'Not available', why: notRun }, { key: 'PROFIT_TAKING', model: JAMES_PT_NAME + ' (layers 6-10)', read: 'Not available', why: notRun }];
  const l = j.liloV2, p = j.profitTaking, ns = nextSellStep(p);
  return [
    { key: 'LILO_V2', model: JAMES_LILO_V2_NAME, read: shortRead(l), why: l.status === 'ok' ? 'Anchor ' + l.anchorDate + ' at ' + usd(l.L0 as number) + '; today ' + bandWords(l.band as number) + '. Layers estimated (u not public).' : todayWords(l) + '.' },
    {
      key: 'PROFIT_TAKING', model: JAMES_PT_NAME + ' (layers 6-10)',
      read: p.status !== 'ok' ? shortRead(p) : ns ? 'Next sell ' + ns.layer.replace('layer ', 'L') + ' at ' + usd(ns.price) + ' (' + away(ns.price, p.close as number).replace(' from today', '') + ')' : 'Above every step',
      why: PT_SPEC[PT_PAGE.schedule].name + '; an exit plan for shares already held, not a buy.',
    },
  ];
}

/** The Bottom Line's two lines ([label, text]). */
export function jamesBottomLines(j: JamesReads): Array<[string, string]> {
  const l = j.liloV2, p = j.profitTaking;
  let a: string;
  if (l.status !== 'ok' || l.close == null) a = todayWords(l);
  else {
    const sn = snipeLayers(l.levels, l.close, [], LILO_V2_PAGE)[0];
    a = (l.band != null && l.band >= 0 ? 'Layer ' + Math.min(l.band, 10) + ' of 10 (' + (l.band >= 6 ? 'sell zone' : 'buy zone') + ')' : 'Under layer 0') + '; anchor ' + l.anchorDate + ' at ' + usd(l.L0 as number)
      + (sn != null ? '; next buy ' + usd(l.levels[sn] as number) + ' (L' + sn + ')' : '') + (l.sma200 != null ? '; stop: a close under ' + usd(0.97 * l.sma200) + ' (3% under the 200-day)' : '');
  }
  const ns = nextSellStep(p);
  const b = p.status !== 'ok' || p.close == null ? todayWords(p)
    : ns ? 'Next sell step: ' + ns.layer + ' at ' + usd(ns.price) + ' (' + away(ns.price, p.close).replace(' from today', '') + '), schedule ' + PT_PAGE.schedule + ' sells ' + (PT_SPEC[PT_PAGE.schedule].share * 100).toFixed(0) + '% of ' + (PT_SPEC[PT_PAGE.schedule].of === 'current' ? 'what you hold' : 'the first position')
      : 'Above every sell step of schedule ' + PT_PAGE.schedule;
  return [['🪜 ' + JAMES_LILO_V2_NAME, a], ['💰 ' + JAMES_PT_NAME, b]];
}
