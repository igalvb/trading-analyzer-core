/**
 * James's models, phase 3 (docs/models/MASTER_PLAN.md section 5): the report pages "🔄 James — Multi-Year Cycle" and
 * "🪤 James — Market Maker Stages" in the Full Ticker Analysis (and the PDF), their rows in 🧮 All Models and their
 * lines in the Bottom Line. DISPLAY ONLY, computed after every score and decision is final: nothing here feeds a score,
 * the conviction, the verdict, the timing or a Buy report tier, and the reads stay out of the nightly Buy and Exit
 * reports (decision 8).
 *
 * These are James's models (InvestAnswers), not the owner's: every label says "James — ".
 */

import { cycleSignals, phaseAt, leaderScore, halvingMonth, halvingWindow, btcRegimeAt, btcIndexBefore, HALVING_FROZEN_2017, NEXT_HALVING_ESTIMATE, type CyclePhase, type BtcRegime } from './models/cycleRegime.ts';
import { marketMakerSeries, riskShares, MM_WINDOW, type MmOptions } from './models/marketMaker.ts';
import { wyckoffClassicSeries, type WyckoffEvent } from './models/wyckoffClassic.ts';
import { formatDateInTz } from '../core/dates.ts';
import { RESULTS, NO_HISTORY, type ResultsPack } from '../profile/results.ts';

export const JAMES_CYCLE_NAME = 'James — Multi-Year Cycle';
export const JAMES_MM_NAME = 'James — Market Maker Stages';
const DISCLAIMER = 'Shown for information only: nothing on this page changes any score, the conviction, the verdict or the Buy report tiers.';

/** The Multi-Year Cycle setup chosen on 2010-2019 (research/cycleCli.ts CYCLE_CHOSEN; a test keeps the two equal). */
export const CYCLE_PAGE = { x: 0.6, bottomTest: 'rsi', topTest: 'z', m: 2.0, gate: 'sma20', k: 3, p: 0.2, r: 0.5, startDry: 0.2 } as const;
/** The Market Maker setup used (research/marketMakerCli.ts MM_CHOSEN: the pre-registered default; the sweep's pick was not stable). */
export const MM_PAGE: MmOptions & { readonly risk: number; readonly slots: number; readonly timeStop: number } = { variant: 'V1', context: 'r097', stop: 1, risk: 0.01, slots: 5, timeStop: 20 };

/**
 * History of the research list, $100,000, after tax, 10 bps per side (docs/models/results/phase3.md): the profile's results pack
 * (GENERIC_PLAN P4, profile/results.ts); null = no pack, the pages say NO_HISTORY.
 */
export const JAMES3_HISTORY: ResultsPack['james3'] | null = RESULTS?.james3 ?? null;
/** The research run's basis (list, hold yardstick, tax), for the history headers. */
const BASIS = RESULTS?.basis ?? null;

export interface J3Bars { readonly dates: ReadonlyArray<Date | string>; readonly opens?: readonly number[]; readonly closes: readonly number[]; readonly highs: readonly number[]; readonly lows: readonly number[]; readonly volumes?: readonly number[] }
const ds = (d: Date | string | undefined, tz: string): string => (d == null ? '' : typeof d === 'string' ? d.slice(0, 10) : formatDateInTz(d, tz, 'yyyy-MM-dd'));

// ─────────────────────────────── 🔄 James — Multi-Year Cycle ───────────────────────────────

export interface BtcPanel {
  readonly day: string; readonly halvingMonth: number | null; readonly window: 'deploy' | 'harvest' | 'hold' | null;
  /** The regime on the BTC-USD bar before the stock's last day (T7); null without BTC-USD bars. */
  readonly regime: BtcRegime | null;
}
export interface CycleRead {
  readonly status: 'ok' | 'noData';
  readonly bars: '10y' | '2y';
  readonly close: number | null; readonly drawdown: number | null; readonly sma200w: number | null; readonly wrsi: number | null; readonly mayer: number | null; readonly wz52: number | null;
  readonly ret126: number | null; readonly qqqRet126: number | null;
  readonly phase: CyclePhase; readonly why: string;
  readonly leader: boolean | null;
  readonly btc: BtcPanel;
}

export function buildCycleRead(b: J3Bars | null | undefined, use: '10y' | '2y', qqq: J3Bars | null, btc: J3Bars | null, tz = 'America/New_York', today?: string): CycleRead {
  const day = b && b.dates.length ? ds(b.dates[b.dates.length - 1], tz) : (today ?? '');
  const btcPanel = (): BtcPanel => {
    const h = day ? halvingMonth(day) : null;
    let regime: BtcRegime | null = null;
    if (btc && btc.closes.length > 260 && day) {
      const bb = { dates: btc.dates.map((d) => ds(d, 'UTC')), closes: btc.closes }, j = btcIndexBefore(bb, day);
      if (j >= 0) regime = btcRegimeAt(bb, cycleSignals(bb), j);
    }
    return { day, halvingMonth: h, window: halvingWindow(h, HALVING_FROZEN_2017), regime };
  };
  if (!b || b.closes.length < 30) return { status: 'noData', bars: use, close: null, drawdown: null, sma200w: null, wrsi: null, mayer: null, wz52: null, ret126: null, qqqRet126: null, phase: 'normal', why: '', leader: null, btc: btcPanel() };
  const bars = { dates: b.dates.map((d) => ds(d, tz)), closes: b.closes }, s = cycleSignals(bars), i = b.closes.length - 1;
  let qr: number | null = null;
  if (qqq && qqq.closes.length > 126) { const q = qqq.closes, k = q.length - 1; qr = (q[k] as number) / (q[k - 126] as number) - 1; }
  const o = { x: CYCLE_PAGE.x, bottomTest: CYCLE_PAGE.bottomTest, topTest: CYCLE_PAGE.topTest, m: CYCLE_PAGE.m } as const;
  const phase = phaseAt(s, i, o);
  const dd = s.dd[i] ?? null, wr = s.wrsi[i] ?? null, my = s.mayer[i] ?? null, wz = s.wz52[i] ?? null, z20 = s.z20[i] ?? null;
  const why = phase === 'deepBottom' ? Math.round((dd ?? 0) * 100) + '% under the 52-week high and weekly RSI ' + (wr ?? 0).toFixed(0) + ' (under 30)'
    : phase === 'nearTop' ? 'the weekly close is ' + (wz ?? 0).toFixed(1) + ' SD above its 52-week average (+3 or more)'
      : phase === 'pump' ? (my != null && my >= 2 ? 'Mayer multiple ' + my.toFixed(2) + ' (2.0 or more)' : '20-day z ' + (z20 ?? 0).toFixed(1) + ' (+2 or more)')
        : 'none of the zones';
  const sc = leaderScore(s, i, qr);
  return {
    status: 'ok', bars: use, close: b.closes[i] as number, drawdown: dd, sma200w: s.sma200w[i] ?? null, wrsi: wr, mayer: my, wz52: wz, ret126: s.ret126[i] ?? null, qqqRet126: qr,
    phase, why, leader: qr == null ? null : sc != null && sc > 0, btc: btcPanel(),
  };
}

const PHASE_WORD: Readonly<Record<CyclePhase, string>> = { deepBottom: 'Deep bottom — deploy zone', nearTop: 'Near top — harvest zone', pump: 'Pump — don\'t chase', normal: 'Normal — hold' };
const PHASE_READ: Readonly<Record<CyclePhase, string>> = { deepBottom: 'Deploy zone', nearTop: 'Harvest zone', pump: 'Don\'t chase', normal: 'Hold' };
const usd = (n: number | null): string => (n == null ? '—' : '$' + n.toFixed(2));
const pc = (x: number | null, dp = 1): string => (x == null ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(dp) + '%');
const windowWord = (w: BtcPanel['window']): string => (w === 'deploy' ? 'deploy window' : w === 'harvest' ? 'harvest window' : w === 'hold' ? 'hold (between the windows)' : '—');

export function formatCyclePage(ticker: string, r: CycleRead): string {
  const out = ['── ' + ticker + ' — ' + JAMES_CYCLE_NAME + ' ──', '', DISCLAIMER,
    'James\'s Rule #66 (InvestAnswers, "the most important rule"): deploy hard at deep bottoms, harvest cash near the tops of cycles, rotate at highs into the next leader, never panic-sell. He gives no numbers; these are the stand-ins chosen on 2010-2019.'];
  if (r.status !== 'ok') return [...out, '', 'No price data this run.'].join('\n');
  out.push('', '1. CYCLE POSITION' + (r.bars === '2y' ? ' (only the 2-year chart this run: the 200-week average needs the 10-year bars)' : ''),
    '  ' + Math.round((r.drawdown ?? 0) * 100) + '% under its 52-week closing high. 200-week average: ' + (r.sma200w == null ? 'too young (under 200 weeks of history)' : usd(r.sma200w) + ' (close ' + ((r.close as number) < r.sma200w ? 'below' : 'above') + ')') + '. Weekly RSI(14): ' + (r.wrsi == null ? '—' : r.wrsi.toFixed(0)) + '.',
    '  Mayer multiple (close / 200-day average): ' + (r.mayer == null ? '—' : r.mayer.toFixed(2)) + '. Weekly close vs its 52-week average: ' + (r.wz52 == null ? '—' : (r.wz52 >= 0 ? '+' : '') + r.wz52.toFixed(1) + ' SD') + '. 6-month return ' + pc(r.ret126) + (r.qqqRet126 != null ? ' (QQQ ' + pc(r.qqqRet126) + ')' : '') + '.');
  out.push('', '2. PHASE: ' + PHASE_WORD[r.phase].toUpperCase(), '  Rule that fired: ' + r.why + '.',
    '  Deep bottom = ' + Math.round(CYCLE_PAGE.x * 100) + '% or more under the 52-week high and weekly RSI under 30; near top = the weekly close 3 SD above its 52-week average; pump (don\'t chase) = Mayer 2.0 or more, or 20-day z +2 or more.');
  out.push('', '3. LEADER?', '  ' + (r.leader == null ? 'QQQ\'s prices were not available this run.' : r.leader ? 'Yes: within 25% of its high, 200-day trend up, 6-month return above QQQ\'s.' : 'No (a leader is within 25% of its high, has its 200-day trend up and a 6-month return above QQQ\'s).'));
  const b = r.btc, g = b.regime;
  out.push('', '4. BTC CYCLE (descriptive — fitted on past cycles, not tested out of sample)',
    '  Halving month ' + (b.halvingMonth ?? '—') + ' of 48 (next halving about ' + NEXT_HALVING_ESTIMATE + '): ' + windowWord(b.window) + ' (the frozen-from-2017 calendar: deploy from month 23 to month 6, harvest months 14-20).',
    g ? '  Regime on BTC-USD\'s ' + g.date + ' bar (the day before; BTC closes after the US market): ' + g.zone.toUpperCase() + ' — Mayer ' + (g.mayer == null ? '—' : g.mayer.toFixed(2)) + ', ' + (g.below200w == null ? '200-week average not available' : (g.below200w ? 'below' : 'above') + ' its 200-week average') + ', weekly RSI ' + (g.wrsi == null ? '—' : g.wrsi.toFixed(0)) + '; 50-week rule: ' + (g.riskOff ? 'risk-off (2 weeks under the 50-week average)' : 'not triggered') + '.'
      : '  BTC-USD prices were not available this run (the regime needs them).');
  const H = JAMES3_HISTORY;
  if (!H || !BASIS) out.push('', '5. HISTORY', '  ' + NO_HISTORY);
  else out.push('', '5. HISTORY (Part A on ' + BASIS.list + ' stocks, top 3 leaders, $100,000, after the ' + BASIS.tax + ' tax, 10 bps per side; 2010-19 / 2020-23 / 2024-26)',
    '  Setup chosen on 2010-2019 only (-60% and weekly RSI < 30, first tranche after a close above the 20-day average, harvest 20% at a weekly z of +3, rotate half, start with 20% dry powder): ' + H.cycle.chosen + ', deepest fall ' + H.cycle.fall + '.',
    '  2010-2019 is in-sample; 2020-2023 is in-sample by construction (James\'s dated deploy examples, the 2022-2023 lows, sit in it); 2024-2026 is the only clean out-of-sample period.',
    '  Pre-registered default (-50% and under the 200-week average, Mayer 2.0): ' + H.cycle.defaultRun + '. 📊 Hold QQQ ' + H.qqq + '; 📊 ' + BASIS.holdList + ' ' + H.list14 + '.',
    '  Verdict: ' + H.cycle.verdict + '. Rule 5: ' + H.cycle.panic + '. James\'s own hindsight "money market" sequence (bitcoin, then two stocks) is not shown: no BTC-USD history in the research download. It runs in the paper test as information.');
  return out.join('\n');
}

// ─────────────────────────────── 🪤 James — Market Maker Stages ───────────────────────────────

export interface MmRead {
  readonly status: 'ok' | 'noData';
  readonly stage: 0 | 1 | 2 | 3 | 4;
  readonly close: number | null;
  readonly grabLow: number | null; readonly grabDate: string | null;
  readonly rangeLow: number | null; readonly rangeHigh: number | null;
  readonly sweepLow: number | null; readonly stop: number | null; readonly target1: number | null; readonly target2: number | null;
  readonly sma200: number | null; readonly rising: boolean | null; readonly gapTo200: number | null;
  readonly lastSpring: string | null; readonly lastSignal: string | null; readonly sinceSignal: number | null;
  /** For $100,000 at 1% risk (a signal tonight): shares and dollars. */
  readonly size: { readonly shares: number; readonly dollars: number } | null;
  readonly events: ReadonlyArray<{ readonly date: string; readonly event: WyckoffEvent }>;
}

export function buildMmRead(b: J3Bars | null | undefined, tz = 'America/New_York'): MmRead {
  const none: MmRead = { status: 'noData', stage: 0, close: null, grabLow: null, grabDate: null, rangeLow: null, rangeHigh: null, sweepLow: null, stop: null, target1: null, target2: null, sma200: null, rising: null, gapTo200: null, lastSpring: null, lastSignal: null, sinceSignal: null, size: null, events: [] };
  if (!b || b.closes.length < 30 || !b.volumes || b.volumes.length !== b.closes.length) return none;
  const bars = { opens: b.opens ?? b.closes, highs: b.highs, lows: b.lows, closes: b.closes, volumes: b.volumes };
  const m = marketMakerSeries(bars, MM_PAGE), wy = wyckoffClassicSeries(bars), i = b.closes.length - 1, x = m[i]!;
  const date = (k: number | null): string | null => (k == null ? null : ds(b.dates[k], tz));
  let lastSpring: number | null = null, lastSignal: number | null = null;
  for (let k = 0; k <= i; k++) { if (m[k]!.sweep) lastSpring = k; if (m[k]!.signal) lastSignal = k; }
  const c = b.closes[i] as number, sma = x.context.sma200;
  const events = wy.map((w, k) => ({ k, e: w.event })).filter((y): y is { k: number; e: WyckoffEvent } => y.e != null).slice(-6).map((y) => ({ date: date(y.k) as string, event: y.e }));
  const size = x.signal && x.stop != null ? (() => { const n = riskShares(100_000, c, x.stop as number, { risk: MM_PAGE.risk, slotShare: 1 / MM_PAGE.slots, cash: 100_000 }); return { shares: n, dollars: n * c }; })() : null;
  return {
    status: 'ok', stage: x.stage, close: c, grabLow: x.grabLow, grabDate: date(x.grabDay), rangeLow: x.rangeLow, rangeHigh: x.rangeHigh,
    sweepLow: x.sweepLow, stop: x.stop, target1: x.target1, target2: x.target2, sma200: sma, rising: x.context.rising, gapTo200: sma != null ? c / sma - 1 : null,
    lastSpring: date(lastSpring), lastSignal: date(lastSignal), sinceSignal: x.sinceSignal, size, events,
  };
}

const MM_READ: Readonly<Record<MmRead['stage'], string>> = { 0: 'No setup', 1: 'Stage 1', 2: 'Stage 2', 3: 'Buy signal', 4: 'In trade window' };

export function formatMmPage(ticker: string, r: MmRead): string {
  const out = ['── ' + ticker + ' — ' + JAMES_MM_NAME + ' ──', '', DISCLAIMER,
    'James\'s "Market Maker game in stages" (InvestAnswers, 2025-10-12): 1) wait for the liquidity grab, 2) let the range form and recover, 3) watch for the second liquidity sweep — the fakeout, 4) then eye longs; the 200-day average is "solid support in a bull market"; "never more than 1%". Built on the 🏛️ Wyckoff model (the spring).'];
  if (r.status !== 'ok') return [...out, '', 'No price data this run.'].join('\n');
  const stageLine = r.stage === 0 ? 'No setup' + (r.lastSpring ? ' (last spring ' + r.lastSpring + ')' : '')
    : r.stage === 1 ? 'Stage 1: liquidity grab on ' + r.grabDate + ' (low ' + usd(r.grabLow) + ')'
      : r.stage === 2 ? 'Stage 2: range ' + usd(r.rangeLow) + '–' + usd(r.rangeHigh) + ' forming'
        : r.stage === 3 ? 'Stage 3: second sweep today — buy signal for tomorrow\'s open'
          : 'Stage 4: in the trade window (day ' + r.sinceSignal + ' of ' + MM_WINDOW + ')';
  out.push('', '1. TODAY: ' + stageLine.toUpperCase());
  out.push('', '2. THE 200-DAY CONTEXT', '  200-day simple average ' + usd(r.sma200) + (r.rising == null ? '' : r.rising ? ', rising over 20 days' : ', not rising') + '; the close is ' + pc(r.gapTo200) + ' from it.',
    '  A buy needs the 200-day rising and the sweep low at least 0.97 x it.');
  out.push('', '3. FOR A $100,000 ACCOUNT AT 1% RISK');
  if (r.stage === 3 && r.size) out.push('  ' + r.size.shares + ' shares (' + usd(r.size.dollars) + '); stop ' + usd(r.stop) + ' (the sweep low ' + usd(r.sweepLow) + ' minus 1 ATR); target 1 ' + usd(r.target1) + ' (the range middle), target 2 ' + usd(r.target2) + ' (the range top); half at each, or out after ' + MM_PAGE.timeStop + ' days.');
  else out.push('  No signal tonight. On a signal: shares = 1% of the account / (entry - stop), at most 1/' + MM_PAGE.slots + ' of the account; stop 1 ATR under the sweep low; half at the range middle, half at the range top; out after ' + MM_PAGE.timeStop + ' days.');
  out.push('', '4. THE WYCKOFF EVENTS IT IS BUILT ON (the last six, as on the 🏛️ Wyckoff page)', '  ' + (r.events.length ? r.events.map((e) => e.date + ' ' + e.event).join(' · ') : 'None in this chart.'));
  const H = JAMES3_HISTORY;
  if (!H || !BASIS) out.push('', '5. HISTORY', '  ' + NO_HISTORY);
  else out.push('', '5. HISTORY (' + BASIS.list + ' stocks, $100,000, after the ' + BASIS.tax + ' tax, 10 bps per side; 2010-19 / 2020-23 / 2024-26)',
    '  Pre-registered default (V1 Wyckoff spring, rising 200-day, 1% risk, 5 slots, idle money in QQQ): ' + H.mm.chosen + ', deepest fall ' + H.mm.fall + '. 📊 Hold QQQ ' + H.qqq + '; 📊 ' + BASIS.holdList + ' ' + H.list14 + '.',
    '  Verdict: ' + H.mm.verdict + '.', '  James times his entries on 5-minute bars; this is the daily form. It runs in the paper test as information.');
  return out.join('\n');
}

// ─────────────────────────────── reads, 🧮 All Models, Bottom Line ───────────────────────────────

export interface James3Reads { readonly cycle: CycleRead; readonly mm: MmRead }

/** Defensive reader (the read arrives as `unknown` through the pipelines and the analysis cache). */
export function readJames3Reads(x: unknown): James3Reads | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>, c = o['cycle'] as Record<string, unknown> | undefined, m = o['mm'] as Record<string, unknown> | undefined;
  if (!c || !m || typeof c !== 'object' || typeof m !== 'object') return null;
  if ((c['status'] !== 'ok' && c['status'] !== 'noData') || (m['status'] !== 'ok' && m['status'] !== 'noData') || !c['btc'] || typeof c['btc'] !== 'object') return null;
  return x as James3Reads;
}

export interface James3RowText { readonly key: 'CYCLE' | 'MARKET_MAKER'; readonly model: string; readonly read: string; readonly why: string }

export function james3AllModelsRows(j: James3Reads | null): James3RowText[] {
  const notRun = 'This model did not run.';
  if (!j) return [{ key: 'CYCLE', model: JAMES_CYCLE_NAME + ' (Rule #66)', read: 'Not available', why: notRun }, { key: 'MARKET_MAKER', model: JAMES_MM_NAME + ' (Wyckoff spring variant)', read: 'Not available', why: notRun }];
  const c = j.cycle, m = j.mm;
  return [
    { key: 'CYCLE', model: JAMES_CYCLE_NAME + ' (Rule #66)', read: c.status === 'ok' ? PHASE_READ[c.phase] : 'Not available', why: c.status === 'ok' ? Math.round((c.drawdown ?? 0) * 100) + '% under its 52-week high; ' + c.why + '.' : notRun },
    { key: 'MARKET_MAKER', model: JAMES_MM_NAME + ' (Wyckoff spring variant)', read: m.status === 'ok' ? MM_READ[m.stage] : 'Not available', why: m.status === 'ok' ? (m.lastSpring ? 'Last spring ' + m.lastSpring + '.' : 'No spring in this chart.') : notRun },
  ];
}

export function james3BottomLines(j: James3Reads): Array<[string, string]> {
  const c = j.cycle, m = j.mm;
  const a = c.status !== 'ok' ? 'Not available' : PHASE_READ[c.phase] + ': ' + Math.round((c.drawdown ?? 0) * 100) + '% under its 52-week high, '
    + (c.sma200w == null ? 'too young for a 200-week average' : ((c.close as number) < c.sma200w ? 'below' : 'above') + ' its 200-week average') + '; BTC halving month ' + (c.btc.halvingMonth ?? '—') + ' (' + windowWord(c.btc.window) + ')';
  const b = m.status !== 'ok' ? 'Not available' : MM_READ[m.stage] + (m.stage === 0 ? (m.lastSpring ? ' (last spring ' + m.lastSpring + ')' : ' (no spring in this chart)') : '');
  return [['🔄 ' + JAMES_CYCLE_NAME, a], ['🪤 ' + JAMES_MM_NAME, b]];
}
