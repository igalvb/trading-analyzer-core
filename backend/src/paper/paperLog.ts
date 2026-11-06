/**
 * The paper test's full record (owner 2026-10-28: "log for the entire year all the actions, all that happens ... so
 * we can do later the analysis and understand what happened, why it happened"). Three append-only tabs, one block
 * of rows per night, never rewritten:
 *   📒 Paper Log     every order decided at the close and every fill at the open, with the reason and what every
 *                    model said about that stock that night
 *   🔎 Paper Reads   every stock of the test, every night: price, the engine, every model, the trends, LILO's ladder
 *   📈 Paper Values  every account and yardstick, every night: value after tax, return, cash, what it holds
 * A night already written (a retried run) is not written again.
 */

import type { TabStore, TabCell } from '../storage/tabStore.ts';
import type { EngineRead } from '../backtest/engineRun.ts';
import type { PriceSeries } from '../backtest/data.ts';
import { trendSeries } from '../analysis/models/trendFollow.ts';
import { wyckoffClassicSeries } from '../analysis/models/wyckoffClassic.ts';
import { STRATEGIES, STRATEGY_LABEL, heldList, pctOf, type PaperState, type PaperTrade } from './paperTrading.ts';
import { PAPER_OWNER_LIST, LAB_SETUPS, LAB_LABEL, LILO_ID, LEAPS_IDS, ALL_ID, ALL_SHARES, JAMES_SHARE_SETUPS, JAMES_IDS, JAMES_LILO_V2_ID, JAMES_GROUP, JAMES_LEAPS_IDS, JAMES_LEAPS_GROUP, OPTIONS_OFF_SETUPS, labHeld, labAccount, type LabSetup } from './paperLab.ts';
import { layersAt, layerOf, bandWords } from '../analysis/models/liloLayers.ts';
import { LILO_V2_CHOSEN } from '../research/liloV2Book.ts';
import { LABELS } from '../profile/labels.ts';
import { CLAUDE_ID, CLAUDE_GROUP } from './paperClaude.ts';

export const LOG_TAB = '📒 Paper Log';
export const READS_TAB = '🔎 Paper Reads';
export const VALUES_TAB = '📈 Paper Values';

export const LOG_HEADER = ['Day', 'When', 'Account', 'Action', 'Stock / contract', 'Shares / contracts', 'Price', 'Value', 'Tax', 'Why', 'What the models said about this stock that night'];
export const READS_HEADER = ['Day', 'Stock', 'Close', 'Conviction', 'Timing', 'Models verdict', 'Engine', 'Broker Course', 'Schabacker', 'Edwards & Magee', 'Turtle',
  'Wyckoff (original)', 'Trend 150', 'Trend 200', 'Above 200-day avg', 'Stop', 'LILO buy zone', 'T1', 'T2', 'James — LILO v2 layer (anchor, L0, u, band)'];
export const VALUES_HEADER = ['Day', 'Account', 'Group', 'Value after tax', 'Return', 'Holds'];

export interface StockNight {
  readonly read: EngineRead | null;
  readonly close: number | null;
  readonly wyckoff: string | null;
  readonly trend150: string | null;
  readonly trend200: string | null;
  readonly above200: number | null;
  /** James — LILO v2's layers tonight (the paper account's setup, on the 10-year bars when given): "anchor 2023-01-13, L0 $168.99, u $59.15, between layer 7 and 8". */
  readonly james?: string | null;
}

/** James — LILO v2's layer line for the reads tab (LILO_V2_CHOSEN's layers on the bars up to `day`). */
export function jamesLayerText(day: string, s: PriceSeries | undefined): string | null {
  const i = s ? s.dates.lastIndexOf(day) : -1;
  if (!s || i < 0) return null;
  const ls = layersAt(s, i, LILO_V2_CHOSEN.layers);
  if (!ls) return 'no anchor';
  return 'anchor ' + ls.anchorDate + ', L0 $' + ls.L0.toFixed(2) + ', u $' + ls.u.toFixed(2) + ', ' + bandWords(layerOf(s.closes[i] as number, ls.levels));
}

/** Tonight's view of one stock, from its read and its price history up to `day` (`long`: the 10-year bars, for James's layers). */
export function stockNight(day: string, read: EngineRead | null, s: PriceSeries | undefined, long?: PriceSeries): StockNight {
  const i = s ? s.dates.lastIndexOf(day) : -1;
  const james = jamesLayerText(day, long ?? s);
  if (!s || i < 0) return { read, close: read?.close ?? null, wyckoff: null, trend150: null, trend200: null, above200: null, james };
  const closes = s.closes.slice(0, i + 1);
  const t150 = trendSeries(closes, 150)[i], t200 = trendSeries(closes, 200)[i];
  const w = wyckoffClassicSeries({ opens: s.opens.slice(0, i + 1), highs: s.highs.slice(0, i + 1), lows: s.lows.slice(0, i + 1), closes, volumes: s.volumes.slice(0, i + 1) })[i];
  return {
    read, close: s.closes[i] as number, wyckoff: w ? w.direction + (w.phase ? ' (phase ' + w.phase + ')' : '') : null,
    trend150: t150?.sma != null ? t150.direction : 'too young', trend200: t200?.sma != null ? t200.direction : 'too young',
    above200: t200?.strength ?? null, james,
  };
}

const dir = (r: EngineRead | null, k: string): string => r?.directions?.[k] ?? '—';
const pctTxt = (x: number | null): string => (x == null ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%');

/** One line: what every model said about the stock. */
export function modelsLine(n: StockNight | undefined): string {
  if (!n) return '';
  const r = n.read;
  return [
    'conviction ' + (r?.finalConviction ?? '—') + (r?.timing ? ' ' + r.timing : ''), 'verdict ' + (r?.verdict ?? '—'),
    'engine ' + dir(r, 'engine'), 'broker ' + dir(r, 'broker'), 'Schabacker ' + dir(r, 'schabacker'), 'E&M ' + dir(r, 'edwardsMagee'), 'Turtle ' + dir(r, 'turtle'),
    'Wyckoff ' + (n.wyckoff ?? '—'), 'trend150 ' + (n.trend150 ?? '—'), 'trend200 ' + (n.trend200 ?? '—'), '200-day ' + pctTxt(n.above200),
  ].join(' · ');
}

const labelOf = (id: string): string => STRATEGY_LABEL[id as keyof typeof STRATEGY_LABEL] ?? LAB_LABEL[id] ?? id;
/** "AMD $100 call 2028-01-21" -> AMD; a plain ticker stays. */
const stockOfLabel = (x: string): string => x.split(' ')[0] as string;

const NAME: Readonly<Record<string, string>> = { schabacker: 'Schabacker', edwardsMagee: 'Edwards & Magee', broker: 'Broker Course', turtle: 'Turtle', wyckoff: 'Wyckoff' };
/** Why a research account buys, in words. */
function buyWhy(st: LabSetup): string {
  switch (st.model) {
    case 'engine': return 'the engine says buy (conviction 70+ or buy now)' + (st.optionsOff ? ', scored with options off' : '');
    case 'current': return 'the engine says buy and the 5 models do not disagree';
    case 'combo': return '2 of Turtle, Schabacker, Edwards & Magee read bullish';
    case 'best': return 'the engine says buy, or 2 of Turtle, Schabacker, Edwards & Magee read bullish';
    case 'trend': return 'above its rising ' + st.trendDays + '-day average';
    default: return (NAME[st.model] ?? st.model) + ' reads bullish';
  }
}
function sellWhy(st: LabSetup): string {
  if (st.sell === 'trend200') return 'closed 3% under its 200-day average (a stock too young for one: the model\'s own sell)';
  if (st.model === 'trend') return 'closed 3% under its ' + st.trendDays + '-day average';
  return (NAME[st.model] ?? st.model) + ' reads cautionary';
}

/** Tonight's rows for the action log: the fills at today's open, then the orders decided at today's close. */
export function logRows(state: PaperState, day: string, trades: readonly PaperTrade[], nights: ReadonlyMap<string, StockNight>): TabCell[][] {
  const rows: TabCell[][] = [];
  const ctx = (t: string): string => (t === 'QQQ' ? '' : modelsLine(nights.get(stockOfLabel(t))));
  for (const t of trades) {
    rows.push([day, 'filled', labelOf(t.strategy), t.side === 'BUY' ? 'BOUGHT' : 'SOLD', t.ticker, t.shares, Math.round(t.price * 100) / 100, Math.round(t.value), Math.round(t.tax), t.why, ctx(t.ticker)]);
  }
  const decided = (account: string, action: string, ticker: string, qty: TabCell, why: string): void => { rows.push([day, 'decided at the close', labelOf(account), action, ticker, qty, '', '', '', why, ticker === 'QQQ' ? '' : ctx(ticker)]); };
  for (const id of STRATEGIES) {
    const a = state.accounts[id];
    for (const o of a.pendingSells) if (o.signalDay === day) decided(id, 'WILL SELL', o.ticker, o.shares, o.why);
    for (const o of a.pendingBuys) if (o.signalDay === day) decided(id, 'WILL BUY', o.ticker, '$' + Math.round(o.dollars), o.why);
  }
  const lab = state.lab;
  if (lab) {
    for (const st of [...LAB_SETUPS, ALL_SHARES, ...JAMES_SHARE_SETUPS, ...OPTIONS_OFF_SETUPS]) {
      const a = labAccount(lab, st.id);
      if (!a) continue;
      const pt = st.profitTaking ? '; then James\'s ' + st.profitTaking + ' schedule sells in steps at its layers 6-10' : '';
      for (const t of a.toSell) decided(st.id, 'WILL SELL', t, a.pos[t]?.shares ?? '', sellWhy(st));
      const q = (t: string): string => (a.gate?.[t] ? '; James — Quality Gate lets it through: ' + a.gate[t]!.line : '');
      for (const t of a.toBuy) decided(st.id, 'WILL BUY', t, '1/' + st.slots + ' of the account', buyWhy(st) + '; a free place and the best ranked of the buys' + pt + q(t));
      // James — Quality Gate: a buy signal the gate blocked tonight (the score line says why)
      for (const [t, g] of Object.entries(a.gate ?? {})) if (!g.pass) decided(st.id, 'NOT BOUGHT', t, '', buyWhy(st) + ', but James — Quality Gate blocks it: ' + g.line);
    }
    // James's models, phase 2: tonight's decisions for the next open
    if (lab.meanRev) {
      for (const [t, why] of Object.entries(lab.meanRev.toSell)) decided('james.meanRev', 'WILL SELL', t, lab.meanRev.pos[t]?.shares ?? '', why);
      for (const y of lab.meanRev.toBuy) decided('james.meanRev', 'WILL BUY', y.t, '1/5 of the account', y.why);
    }
    for (const [id, k] of Object.entries(lab.pair ?? {})) if (k.toHold && k.toHold !== k.hold) decided(id, 'WILL SWAP', (k.hold ?? 'cash') + ' -> ' + k.toHold, k.pot.shares || '', 'James — Pair Rotation: hold ' + k.toHold + ' from the next open');
    for (const [id, b] of Object.entries(lab.winners ?? {})) {
      for (const [t, why] of Object.entries(b.toSell)) decided(id, 'WILL SELL', t, b.pos[t]?.shares ?? '', why);
      for (const y of b.toAdd) decided(id, 'WILL BUY', y.t, (y.share * 100).toFixed(1) + '% of the account', y.why);
    }
    // James's models, phase 3: tonight's decisions for the next open
    for (const y of lab.cycle?.orders ?? []) decided('james.cycle', y.side === 'BUY' ? 'WILL BUY' : 'WILL SELL', y.t, y.side === 'BUY' ? '$' + Math.round(y.money ?? 0) : y.shares ?? 'all', 'James — Multi-Year Cycle: ' + y.why);
    for (const y of lab.cycleBtc?.orders ?? []) decided('james.cycleBtc', y.side === 'BUY' ? 'WILL BUY' : 'WILL SELL', y.t, y.side === 'BUY' ? (y.rotate ? 'the harvest money' : '$' + Math.round(y.money ?? 0)) : y.shares ?? '', 'James — BTC cycle sleeve: ' + y.why);
    if (lab.marketMaker) {
      const k = lab.marketMaker;
      for (const [t, why] of Object.entries(k.toSell)) decided('james.marketMaker', 'WILL SELL', t, k.pos[t]?.shares ?? '', why);
      for (const [t, x] of Object.entries(k.toTrim ?? {})) decided('james.marketMaker', 'WILL SELL', t, Math.floor((k.pos[t]?.shares ?? 0) * x.frac), x.why);
      for (const y of k.toBuy) decided('james.marketMaker', 'WILL BUY', y.t, y.share != null ? (y.share * 100).toFixed(1) + '% of the account (1% at risk)' : '1/5 of the account', y.why);
    }
    // James — LILO v2: tonight's resting snipe orders, stop sales and market buys
    for (const [t, l] of Object.entries(lab.liloV2?.lines ?? {})) {
      if (l.sellAll) decided(JAMES_LILO_V2_ID, 'WILL SELL', t, l.shares, l.sellAll);
      if (l.marketBuy) decided(JAMES_LILO_V2_ID, 'WILL BUY', t, '$' + Math.round(l.marketBuy), 'one tranche at the open');
      if (l.orders.length) decided(JAMES_LILO_V2_ID, 'RESTING ORDERS', t, l.orders.reduce((s, r) => s + r.shares, 0),
        'snipe buys ' + l.orders.map((r) => 'L' + r.layer + ' $' + r.price.toFixed(2) + ' (' + r.shares + ')').join(', ') + '; anchor L0 $' + l.L0.toFixed(2) + ', u $' + l.u.toFixed(2) + ' (estimated)');
    }
    for (const [id, a] of Object.entries(lab.leaps ?? {})) for (const t of a.shareSells ?? []) decided(id, 'WILL SELL', t + ' (exercised shares)', a.shares?.[t]?.shares ?? '', 'the 200-day trend broke');
    for (const [id, a] of Object.entries(lab.leaps ?? {})) for (const o of a.orders) if (o.nights === 0) decided(id, o.side === 'BUY' ? 'WILL BUY' : 'WILL SELL', o.ticker + ' $' + o.strike + ' call ' + new Date(o.expUnix * 1000).toISOString().slice(0, 10), o.contracts, o.why);
    // 🤖 Claude, free choice: tonight's rejected orders and call orders waiting for a quote (its fills are above, with the Reason)
    for (const x of lab.claude?.notes ?? []) if (x.day === day) rows.push([day, x.action === 'WAITING' ? 'waiting for a quote' : 'not filled', labelOf(CLAUDE_ID), x.action, x.ticker, x.qty, '', '', '', x.why, ctx(x.ticker)]);
    for (const [t, l] of Object.entries(lab.lilo?.lines ?? {})) if (l.age === 0 && !l.funded) decided(LILO_ID, 'LADDER PLACED', t, l.buyRungs.reduce((s, r) => s + r.shares, 0), 'buy rungs ' + l.buyRungs.map((r) => '$' + r.price.toFixed(2)).join(', ') + '; targets ' + l.sellRungs.map((r) => '$' + r.price.toFixed(2)).join(', ') + '; stop ' + (l.stop != null ? '$' + l.stop.toFixed(2) : '—'));
  }
  return rows;
}

/** Tonight's rows for the reads tab: one per stock. */
export function readsRows(day: string, nights: ReadonlyMap<string, StockNight>): TabCell[][] {
  return [...nights].sort(([a], [b]) => a.localeCompare(b)).map(([t, n]) => {
    const r = n.read, z = r?.lilo;
    return [day, t, n.close, r?.finalConviction ?? '', r?.timing ?? '', r?.verdict ?? '', dir(r, 'engine'), dir(r, 'broker'), dir(r, 'schabacker'), dir(r, 'edwardsMagee'), dir(r, 'turtle'),
      n.wyckoff ?? '', n.trend150 ?? '', n.trend200 ?? '', pctTxt(n.above200), r?.stop ?? '', z && z.entryLow != null && z.entryHigh != null ? '$' + z.entryLow.toFixed(2) + ' to $' + z.entryHigh.toFixed(2) : '', z?.t1 ?? '', z?.t2 ?? '', n.james ?? ''] as TabCell[];
  });
}

/** Tonight's rows for the values tab: every account and yardstick. */
export function valuesRows(state: PaperState, day: string): TabCell[][] {
  const m = state.marks[state.marks.length - 1];
  if (!m || m.day !== day) return [];
  const rows: TabCell[][] = [];
  const add = (id: string, name: string, group: string, holds: string): void => { const v = m.values[id]; if (v != null) rows.push([day, name, group, Math.round(v), pctOf(v), holds]); };
  for (const id of STRATEGIES) add(id, STRATEGY_LABEL[id], 'A original', heldList(state, id).join(', ') || 'cash');
  const lab = state.lab;
  for (const st of [...LAB_SETUPS, ...OPTIONS_OFF_SETUPS]) add(st.id, st.label, 'B your list', lab ? labHeld(lab, st.id).join(', ') || 'cash' : '');
  add(LILO_ID, LAB_LABEL[LILO_ID] as string, 'B your list', lab ? labHeld(lab, LILO_ID).join(', ') || 'cash' : '');
  for (const id of LEAPS_IDS) add(id, LAB_LABEL[id] as string, 'C LEAPS', lab ? labHeld(lab, id).join(', ') || 'cash' : '');
  add(ALL_ID, LAB_LABEL[ALL_ID] as string, 'D everything', lab ? labHeld(lab, ALL_ID).join(', ') || 'cash' : '');
  for (const id of JAMES_IDS) add(id, LAB_LABEL[id] as string, JAMES_GROUP, lab ? labHeld(lab, id).join(', ') || 'cash' : '');
  for (const id of JAMES_LEAPS_IDS) add(id, LAB_LABEL[id] as string, JAMES_LEAPS_GROUP, lab ? labHeld(lab, id).join(', ') || 'cash' : '');
  add(CLAUDE_ID, LAB_LABEL[CLAUDE_ID] as string, CLAUDE_GROUP, lab ? labHeld(lab, CLAUDE_ID).join(', ') || 'cash' : '');
  add('qqq', 'Hold QQQ', '📊 yardstick', 'QQQ');
  add('lab.list14', LABELS.holdResearchCore, '📊 yardstick', '');
  add('lab.list', LABELS.holdCoreShort, '📊 yardstick', '');
  add('basket', 'Hold the 4 + watchlist equally', '📊 yardstick', '');
  return rows;
}

/** Appends `rows` under `header` unless the tab already has rows for `day` (column A). */
export async function appendNight(store: TabStore, tab: string, header: readonly TabCell[], day: string, rows: readonly TabCell[][], refreshHeader = false): Promise<number> {
  await store.ensure(tab);
  const have = (await store.read(tab, 1)) ?? [];
  if (!have.length) { await store.write(tab, 1, [header]); have.push([header[0] as TabCell]); }
  // `refreshHeader` (🔎 Paper Reads, whose header gained the James layer column in phase 1): row 1 is rewritten with the night
  else if (refreshHeader && !have.some((r) => String(r[0]) === day)) await store.write(tab, 1, [header]);
  if (have.some((r) => String(r[0]) === day)) return 0;
  if (rows.length) await store.write(tab, have.length + 1, rows);
  return rows.length;
}

