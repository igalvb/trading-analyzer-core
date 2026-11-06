/**
 * Research accounts in the 1-year paper test (owner 2026-10-28: "put all of them to the test"). Every model of the
 * strategy lab with its best setup on the owner's list (the 14 researched stocks plus SPCX and IBIT) (bestSetupCli, docs/V13_BACKTEST_RESULTS.md), traded
 * forward with the same rules as `research/portfolioLab.ts` `runPortfolio`: at most N stocks, each buy sized to 1/N
 * of the account (funded from QQQ), spare money held in QQQ, decide at the close, fill at the next open, 25% tax on
 * every sale's gain (QQQ included). The difference to the lab: the reads are the live nightly's (fundamentals and
 * market-wide data included). Nothing here computes a score.
 */

import type { EngineRead, ExitReadResult } from '../backtest/engineRun.ts';
import type { PriceSeries } from '../backtest/data.ts';
import { EXIT_TAX_RATE } from '../portfolio/exitTax.ts';
import { activeProfile } from '../profile/active.ts';
import { LABELS } from '../profile/labels.ts';
import { trendSeries, type TrendDay } from '../analysis/models/trendFollow.ts';
import { wyckoffClassicSeries } from '../analysis/models/wyckoffClassic.ts';
import type { PaperTrade } from './paperTrading.ts';
import { leapsNight, leapsValue, leapsHeld, newLeapsAccount, type LeapsAccount, type LeapsPick, type LeapsQuote } from './paperLeaps.ts';
import { newLiloBook, liloDay, liloValue, liloHeld, type LiloBook, type LiloBar, type LiloSignal } from '../research/liloBook.ts';
import { newLiloV2Book, liloV2Day, liloV2Value, liloV2Held, LILO_V2_CHOSEN, type LiloV2Book } from '../research/liloV2Book.ts';
import { layersAt, smaSeries, DEFAULT_LAYER_OPTIONS, type LayerSet } from '../analysis/models/liloLayers.ts';
import { newPtState, profitTakingFills, type PtSchedule, type PtState } from '../analysis/models/profitTaking.ts';
import { newSignalBook, signalDay, signalValue, signalHeld, type SignalBook } from '../research/signalBook.ts';
import { MR_CHOSEN, mrExit, mrFilter, signalsOf, zOf, atrOf } from '../research/meanRevCli.ts';
import { newPairBook, pairDay, pairValue, pairHeld, pairStates, type PairBook } from '../research/pairLab.ts';
import { PAIR_CHOSEN } from '../research/pairCli.ts';
import { newWinnersBook, winnersDay, winnersDecide, winnersValue, winnersHeld, rankTonight, type WinnersBook, type WCtx } from '../research/winnersBook.ts';
import { WINNERS_CHOSEN } from '../research/bigWinnersCli.ts';
import type { WinnersRank } from '../analysis/jamesPhase2Pages.ts';
import { newCycleBook, cycleFill, cycleDecide, cycleValue, cycleHeld, leadersTonight, newBtcSleeveBook, btcSleeveFill, btcSleeveDecide, btcSleeveValue, btcSleeveHeld, BTC_SLEEVE_DEFAULT, type CycleBook, type BtcSleeveBook, type CycleCtx } from '../research/cycleLab.ts';
import { CYCLE_CHOSEN } from '../research/cycleCli.ts';
import { qualityScore, priceItemsSeries, passesGate, type GateRule, type PriceItemsSeries } from '../analysis/models/qualityGate.ts';
import { cycleSignals, btcIndexBefore, btcRegimeAt, halvingMonth, halvingWindow, HALVING_FROZEN_2017, type CycleSignals } from '../analysis/models/cycleRegime.ts';
import { MM_CHOSEN, mmOf, mmExit, mmShare } from '../research/marketMakerCli.ts';
import { marketFireSale, stockFireSale, zSeries } from '../analysis/options/fireSale.ts';
import { fairValueOf, FAIR_VALUE } from '../analysis/options/fairValue.ts';
import { realizedVol } from '../analysis/options/blackScholes.ts';
import { rateOn } from '../research/optionsSim.ts';
import { CLAUDE_ID, CLAUDE_LABEL, claudeDay, claudeValue, claudeHeld, newClaudeBook, type ClaudeBook, type ClaudeNight } from './paperClaude.ts';

/**
 * James's models, phase 4 (docs/models/MASTER_PLAN.md section 5; plans 03 and 04, group "E James LEAPS"): James —
 * LEAPS accounts, long calls only, each $100,000, joining on the first night they run and judged against "📊 QQQ since
 * this account joined" (G8). The contract is James's pick (analysis/options/leapsPick.ts: the January nearest 19
 * months within 13-26, delta 0.60 / 0.75 / 0.85, break-even <= 12% a year, bid > 0, spread <= 10%, OI >= 100), from
 * the chains the night already fetched. Mode F buys in a fire sale (analysis/options/fireSale.ts: QQQ >= 20% under its
 * 52-week high, one buy per stock per episode, no turnaround; or a stock 40%+ under its high with a -2 SD close, then
 * a close back above its 20-day average), deepest fall first, 5 slots, idle money in QQQ, one contract up to 1.5 x a
 * slot. The 11 engine twins and "Everything together, LEAPS half" are not changed (the control).
 */
export const JAMES_LEAPS_GROUP = 'E James LEAPS';
export interface JamesLeapsSetup {
  readonly id: string; readonly label: string;
  readonly entry: 'fire' | 'twin.best' | 'twin.cycle';
  readonly delta: number; readonly exit: 'roll60' | 'expiry'; readonly slots: number;
  readonly cap?: boolean; readonly trim?: boolean; readonly fair?: boolean;
}
export const JAMES_LEAPS_SETUPS: readonly JamesLeapsSetup[] = [
  { id: 'james.leaps.fire.d75', label: 'James — LEAPS fire sale 0.75 (to expiry)', entry: 'fire', delta: 0.75, exit: 'expiry', slots: 5 },
  { id: 'james.leaps.fire.d75.roll', label: 'James — LEAPS fire sale 0.75 (60-day roll)', entry: 'fire', delta: 0.75, exit: 'roll60', slots: 5 },
  { id: 'james.leaps.fire.d75.cap', label: 'James — LEAPS fire sale 0.75 (delta ≤ 1× equity; headline)', entry: 'fire', delta: 0.75, exit: 'expiry', slots: 5, cap: true },
  { id: 'james.leaps.fire.d60', label: 'James — LEAPS fire sale 0.60 (to expiry)', entry: 'fire', delta: 0.60, exit: 'expiry', slots: 5 },
  { id: 'james.leaps.fire.d85', label: 'James — LEAPS fire sale 0.85 (to expiry)', entry: 'fire', delta: 0.85, exit: 'expiry', slots: 5 },
  { id: 'james.leaps.fire.d75.trim', label: 'James — LEAPS fire sale 0.75 + spike trim', entry: 'fire', delta: 0.75, exit: 'expiry', slots: 5, trim: true },
  { id: 'james.leaps.fire.d75.fair', label: 'James — LEAPS fire sale 0.75 + fair-value filter (James — Option Fair Value)', entry: 'fire', delta: 0.75, exit: 'expiry', slots: 5, fair: true },
  { id: 'james.leaps.twin.best', label: 'James — LEAPS pick on Everything together (vs the engine\'s pick, all.leaps)', entry: 'twin.best', delta: 0.75, exit: 'roll60', slots: 3 },
  { id: 'james.leaps.cycle', label: 'James — Multi-Year Cycle, LEAPS twin (James\'s pick 0.75)', entry: 'twin.cycle', delta: 0.75, exit: 'roll60', slots: 5 },
];
export const JAMES_LEAPS_IDS: readonly string[] = JAMES_LEAPS_SETUPS.map((x) => x.id);
const JAMES_LEAPS_LABEL: Readonly<Record<string, string>> = Object.fromEntries(JAMES_LEAPS_SETUPS.map((x) => [x.id, x.label]));
/** James's pick for one stock at one delta tonight (paperJob.ts, from the chain already fetched), with what the log and the filter need. */
export type JamesNightPick = LeapsPick & { readonly delta: number; readonly iv: number | null; readonly why: string };

/**
 * James's models, phase 3 (docs/models/MASTER_PLAN.md section 5, group "J James's models"), shares only (the LEAPS
 * twin james.leaps.cycle waits for model 3, phase 4), joining on the first night they run and judged against
 * "📊 QQQ since this account joined" (G8): James — Multi-Year Cycle (Part A, the setup chosen on 2010-2019, on the list;
 * IBIT is the buyable bitcoin and its cycle reads come from BTC-USD's bar of the day before, master T7; dry powder waits
 * in cash, no interest in the paper test), James — BTC cycle sleeve (Parts B + C on 50% in IBIT with the
 * frozen-from-2017 halving windows; descriptive, never judged) and James — Market Maker Stages (the chosen setup on the
 * list, 1% risk, idle QQQ). Run as information: neither passed its plan's acceptance on history.
 */
export const JAMES_CYCLE_ID = 'james.cycle';
export const JAMES_CYCLE_BTC_ID = 'james.cycleBtc';
export const JAMES_MM_ID = 'james.marketMaker';
export const JAMES3_IDS: readonly string[] = [JAMES_CYCLE_ID, JAMES_CYCLE_BTC_ID, JAMES_MM_ID];
const JAMES3_LABEL: Readonly<Record<string, string>> = {
  [JAMES_CYCLE_ID]: 'James — Multi-Year Cycle (list, top 3 leaders, deploy at deep bottoms, harvest near tops)',
  [JAMES_CYCLE_BTC_ID]: 'James — BTC cycle sleeve (halving + regime, 50% IBIT; descriptive)',
  [JAMES_MM_ID]: 'James — Market Maker Stages (list, 1% risk)',
};

/**
 * James's models, phase 2 (docs/models/MASTER_PLAN.md section 5, group "J James's models"), each with the setup chosen
 * in docs/models/results/phase2.md, shares only (no LEAPS twin in phase 2), joining on the first night they run and
 * judged against "📊 QQQ since this account joined" (G8): James — Mean Reversion (signal book, 5 slots, the list),
 * James — Pair MSTR/TSLA (100% swap), James — Winners & Layering on the list, and the same plus the 2.5% BTC-insurance
 * sleeve in IBIT (topped up, never sold; MSTR counted; IBIT out of the ranking). Run as information: none passed its
 * plan's acceptance on history.
 */
export const JAMES_MR_ID = 'james.meanRev';
export const JAMES_PAIR_ID = 'james.pair.mstrTsla';
export const JAMES_WINNERS_ID = 'james.winners';
export const JAMES_WINNERS_BTC_ID = 'james.winners.btc';
export const JAMES2_IDS: readonly string[] = [JAMES_MR_ID, JAMES_PAIR_ID, JAMES_WINNERS_ID, JAMES_WINNERS_BTC_ID];
const JAMES2_LABEL: Readonly<Record<string, string>> = {
  [JAMES_MR_ID]: 'James — Mean Reversion ±2 SD (list, 5 slots, buy at -2.5 SD of 10 days, sell at +2.5 SD)',
  [JAMES_PAIR_ID]: 'James — Pair MSTR/TSLA (100% swap)',
  [JAMES_WINNERS_ID]: 'James — Winners & Layering (list, top 5, adds by price zone)',
  [JAMES_WINNERS_BTC_ID]: 'James — Winners & Layering + BTC sleeve (2.5% IBIT)',
};
/** The sleeve of james.winners.btc (plan 09 decision 7 default): 2.5% in IBIT, top-up only, MSTR counts. */
export const JAMES_BTC_SLEEVE = { ticker: 'IBIT', target: 0.025, countsAlso: ['MSTR'] } as const;

/**
 * James's models, phase 1 (docs/models/MASTER_PLAN.md section 5, group "J James's models"): James — LILO v2 with the
 * setup chosen on 2010-2019 (research/liloV2Book.ts LILO_V2_CHOSEN) on the list, and James — Profit-Taking with the
 * schedule chosen on 2010-2019 (A20) on the combo's entries and on the 14 held equally. Shares only (the plans
 * propose no LEAPS twin). Layers from G1 on the dated 10-year bars (G0b, `input.long`). They join on the first night
 * they run and are judged against "📊 QQQ since this account joined" (G8). The other accounts are unchanged.
 */
export const JAMES_LILO_V2_ID = 'james.liloV2';
export const JAMES_LILO_V2_LABEL = 'James — LILO v2 (list, 5 stocks, snipe buys at the layers, 200-day stop)';
export const JAMES_PT_SCHEDULE: PtSchedule = 'A20';
export const JAMES_PT_LIST14_ID = 'james.pt.list14';
export const JAMES_PT_LIST14_LABEL = 'James — Profit-Taking A20 on ' + LABELS.list + ' held equally';
export const JAMES_GROUP = "J James's models";

/** LILO's account (research/liloBook.ts): its best setup on the list, 5 ladders at a time (liloCli, 2026-10-28). */
export const LILO_ID = 'lab.lilo';
export const LILO_SLOTS = 5;
export const LILO_LABEL = 'LILO (list, 5 ladders)';

/** The user's list (profile `lists.core`; GENERIC_PLAN P2). */
export const PAPER_OWNER_LIST: readonly string[] = activeProfile().lists.core;
/** The list the research was run on (profile `lists.researchCore`; owner 2026-10-28: always compare with holding them). */
export const PAPER_RESEARCH_14: readonly string[] = activeProfile().lists.researchCore;
/** The stocks of the list that are not in the researched ones, for labels. */
export const PAPER_ADDED: readonly string[] = PAPER_OWNER_LIST.filter((t) => !PAPER_RESEARCH_14.includes(t));

export type LabModelId = 'engine' | 'current' | 'schabacker' | 'edwardsMagee' | 'broker' | 'turtle' | 'wyckoff' | 'trend' | 'combo' | 'best';
export interface LabSetup {
  readonly id: string; readonly label: string; readonly model: LabModelId; readonly slots: number;
  /** 'own' = the model's own sell; 'trend200' = sell only when the stock's 200-day trend breaks. */
  readonly sell: 'own' | 'trend200';
  /** Trend length for the Trend model and the ranking of the price-only models. */
  readonly trendDays: number;
  /** Starting money when not the full account (Everything together: half in shares). */
  readonly cash?: number;
  /** James — Profit-Taking: this schedule sells each position in steps at its LILO v2 layers 6-10 (frozen at the buy). */
  readonly profitTaking?: PtSchedule;
  /** James — Quality Gate: a buy is made only when the stock's score passes this rule that night (buys only). */
  readonly quality?: GateRule;
  /** Options sentiment P2: decide on the night's scores with options OFF (EngineRead.optionsOff) — the twin account. */
  readonly optionsOff?: boolean;
}
/** Each model's best setup (bestSetupCli, 2026-10-28). */
export const LAB_SETUPS: readonly LabSetup[] = [
  { id: 'lab.engine', label: 'Engine alone (list, 3 stocks, 200-day sell)', model: 'engine', slots: 3, sell: 'trend200', trendDays: 200 },
  { id: 'lab.current', label: 'Engine + models (list, 5 stocks, 200-day sell)', model: 'current', slots: 5, sell: 'trend200', trendDays: 200 },
  { id: 'lab.schabacker', label: 'Schabacker (list, 3 stocks, 200-day sell)', model: 'schabacker', slots: 3, sell: 'trend200', trendDays: 200 },
  { id: 'lab.edwardsMagee', label: 'Edwards & Magee (list, 5 stocks, own sell)', model: 'edwardsMagee', slots: 5, sell: 'own', trendDays: 150 },
  { id: 'lab.broker', label: 'Broker Course (list, 2 stocks, 200-day sell)', model: 'broker', slots: 2, sell: 'trend200', trendDays: 200 },
  { id: 'lab.turtle', label: 'Turtle (list, 3 stocks, 200-day sell)', model: 'turtle', slots: 3, sell: 'trend200', trendDays: 200 },
  { id: 'lab.wyckoff', label: 'Wyckoff (list, 2 stocks, own sell)', model: 'wyckoff', slots: 2, sell: 'own', trendDays: 150 },
  { id: 'lab.trend150', label: 'Trend 150 (list, 3 stocks)', model: 'trend', slots: 3, sell: 'own', trendDays: 150 },
  { id: 'lab.trend200', label: 'Trend 200 (list, 3 stocks)', model: 'trend', slots: 3, sell: 'own', trendDays: 200 },
  { id: 'lab.combo', label: 'Turtle+Schabacker+E&M 2 of 3 (list, 3 stocks, 200-day sell)', model: 'combo', slots: 3, sell: 'trend200', trendDays: 200 },
];
/**
 * Everything together (owner 2026-10-28, "group D"): all the analysis at once on the owner's list, in shares AND LEAPS.
 * Buys when the engine says buy OR 2 of Turtle / Schabacker / Edwards & Magee read bullish (research model 'best':
 * 3 stocks + 200-day sell, +994 / +136 / +400% on the 14, deepest fall -55%), ranked by the engine's conviction,
 * at most 3 stocks; each position is half shares, half a LEAPS call on the same stock (the $100,000 is split in two).
 */
export const ALL_ID = 'all';
export const ALL_SHARES: LabSetup = { id: 'all.shares', label: 'Everything together, shares half', model: 'best', slots: 3, sell: 'trend200', trendDays: 200, cash: 50_000 };
export const ALL_LEAPS_ID = 'all.leaps';
export const ALL_LABEL = 'Everything together (' + PAPER_OWNER_LIST.length + ' stocks + LEAPS, 3 positions)';
const STOCK_SETUPS: readonly LabSetup[] = [...LAB_SETUPS, ALL_SHARES];
/** James — Profit-Taking on the combo's entries (the same rules as lab.combo, the schedule on top). No LEAPS twin. */
export const JAMES_PT_SETUPS: readonly LabSetup[] = [
  { id: 'james.pt.combo', label: 'James — Profit-Taking A20 on Combo 2 of 3 (list, 3 stocks, 200-day sell)', model: 'combo', slots: 3, sell: 'trend200', trendDays: 200, profitTaking: JAMES_PT_SCHEDULE },
];
/**
 * James's models, phase 5 (docs/models/results/phase5.md): James — Quality Gate on Trend 200 — the same rules as
 * lab.trend200, buying only stocks whose score passes the level chosen on 2010-2019 for Trend 200 (4 of 7 of the items
 * known that night: the CEO table, Trend 200 up, $50M+ average daily dollar volume — the items the history test could
 * see, so the forward account tests the same rule). The gate's value = this account minus lab.trend200.
 */
export const JAMES_QG_ID = 'james.trend200.q6';
export const JAMES_QG_RULE: GateRule = { mode: 'scaled', mark: 4, outOf: 7 };
export const JAMES_QG_SETUPS: readonly LabSetup[] = [
  { id: JAMES_QG_ID, label: 'James — Quality Gate on Trend 200 (list, 3 stocks; buys only stocks scoring 4 of 7 of the known items)', model: 'trend', slots: 3, sell: 'own', trendDays: 200, quality: JAMES_QG_RULE },
];
/**
 * Options sentiment P2 (A-9, section 5 T2): "Engine, options off", the twin of lab.engine (same rules: the list, 3
 * stocks, 200-day sell) deciding on the SAME night's analysis with options OFF (EngineRead.optionsOff). It joins on
 * the first night the read is applied (profile `options.applied`; that day is kept as lab.optionsLive, the go-live date)
 * and is judged against "📊 QQQ since this account joined" (G8). The options effect = lab.engine minus this account
 * from that day. No LEAPS twin. Never runs while the read is in shadow, so the other accounts are untouched.
 */
export const OPTIONS_OFF_ID = 'lab.engine.optionsOff';
export const OPTIONS_OFF_SETUPS: readonly LabSetup[] = [
  { id: OPTIONS_OFF_ID, label: 'Engine, options off (list, 3 stocks, 200-day sell)', model: 'engine', slots: 3, sell: 'trend200', trendDays: 200, optionsOff: true },
];
/** James's share accounts run by the lab's own loop (lab.james). */
export const JAMES_SHARE_SETUPS: readonly LabSetup[] = [...JAMES_PT_SETUPS, ...JAMES_QG_SETUPS];
/** Every James account id, in report order. */
export const JAMES_IDS: readonly string[] = [JAMES_LILO_V2_ID, ...JAMES_PT_SETUPS.map((s) => s.id), JAMES_PT_LIST14_ID, ...JAMES2_IDS, ...JAMES3_IDS, JAMES_QG_ID];

/** The LEAPS twin of each setup (paperLeaps.ts). */
export const leapsId = (setupId: string): string => 'leaps.' + setupId.slice('lab.'.length);
export const LEAPS_IDS: readonly string[] = LAB_SETUPS.map((s) => leapsId(s.id));
export const LAB_LABEL: Readonly<Record<string, string>> = {
  ...Object.fromEntries([...LAB_SETUPS, ...OPTIONS_OFF_SETUPS].map((s) => [s.id, s.label])), [LILO_ID]: LILO_LABEL,
  ...Object.fromEntries(LAB_SETUPS.map((s) => [leapsId(s.id), s.label.replace(' (list', ' LEAPS (list')])),
  [ALL_ID]: ALL_LABEL, [ALL_SHARES.id]: ALL_SHARES.label, [ALL_LEAPS_ID]: 'Everything together, LEAPS half',
  [JAMES_LILO_V2_ID]: JAMES_LILO_V2_LABEL, ...Object.fromEntries(JAMES_SHARE_SETUPS.map((s) => [s.id, s.label])), [JAMES_PT_LIST14_ID]: JAMES_PT_LIST14_LABEL, ...JAMES2_LABEL, ...JAMES3_LABEL,
  ...JAMES_LEAPS_LABEL, [CLAUDE_ID]: CLAUDE_LABEL,
};

/** `pt`: James — Profit-Taking's schedule on this position (accounts with `profitTaking` only). */
export interface LabPos { shares: number; cost: number; entryDate: string; pt?: PtState }
export interface LabAccount {
  cash: number; pos: Record<string, LabPos>; toSell: string[]; toBuy: string[]; taxPaid: number;
  /** James — Quality Gate: tonight's buy signals and their score line (blocked or let through), for the 📒 Paper Log. */
  gate?: Record<string, { pass: boolean; line: string }>;
}
export interface LabBench { cash: number; shares: Record<string, number>; cost: Record<string, number> }
export interface LabState {
  /** The first day these accounts decided on (they joined the test then). */
  readonly joined: string;
  accounts: Record<string, LabAccount>;
  /** Hold the list equally, bought at the accounts' first open; null until then. */
  listBench: LabBench | null;
  /** Hold the 14 researched stocks equally (the list without SPCX and IBIT); absent in a state saved before it joined. */
  list14Bench?: LabBench | null;
  /** LILO's book; absent in a state saved before LILO joined. */
  lilo?: LiloBook;
  /** The LEAPS twins; absent in a state saved before they joined. */
  leaps?: Record<string, LeapsAccount>;
  /** James — LILO v2's book; absent in a state saved before it joined. */
  liloV2?: LiloV2Book;
  /** James's share accounts (James — Profit-Taking), kept apart from the lab accounts; absent before they joined. */
  james?: Record<string, LabAccount>;
  /** James's models, phase 2: their books; absent before they joined. */
  meanRev?: SignalBook;
  pair?: Record<string, PairBook>;
  winners?: Record<string, WinnersBook>;
  /** James — Winners & Layering's list ranking tonight (the report page reads it). */
  winnersRank?: WinnersRank;
  /** James's models, phase 3: their books; absent before they joined. */
  cycle?: CycleBook;
  cycleBtc?: BtcSleeveBook;
  marketMaker?: SignalBook;
  /** James's models, phase 4: per James — LEAPS account, the market fire-sale episode (its first day) each stock was bought in. Its accounts live in `leaps`. */
  jamesLeapsBought?: Record<string, Record<string, string>>;
  /** Options sentiment P2: the first day the options read was applied (go-live); "Engine, options off" joined then. */
  optionsLive?: string;
  /** 🤖 Claude, free choice (paperClaude.ts): its book; absent until the first order row is seen. It joins on its first fill. */
  claude?: ClaudeBook;
}

/** The share account of a lab or James setup id (James's ids live in `lab.james`). */
export function labAccount(lab: LabState, id: string): LabAccount | undefined {
  return id.startsWith('james.') ? lab.james?.[id] : lab.accounts[id];
}

export function newLabState(day: string, cash: number): LabState {
  return { joined: day, lilo: newLiloBook(cash), accounts: Object.fromEntries(LAB_SETUPS.map((s) => [s.id, { cash, pos: {}, toSell: [], toBuy: [], taxPaid: 0 }])), listBench: null };
}

export interface LabDayInput {
  readonly day: string;
  readonly bars: Readonly<Record<string, { readonly open: number; readonly close: number }>>;
  /** Tonight's reads for the owner's list. */
  readonly reads: readonly EngineRead[];
  /** Price history up to (at least) today, per ticker of the list. */
  readonly series: ReadonlyMap<string, PriceSeries>;
  readonly exitRead: (ticker: string, entryDate: string, entryPrice: number) => ExitReadResult;
  /** Tonight's option quotes and LEAPS picks (Cboe); without them the LEAPS accounts wait. */
  readonly options?: {
    readonly quote: (symbol: string) => LeapsQuote | null; readonly pick: (ticker: string) => LeapsPick | null; readonly nowUnix: number;
    /** James — LEAPS (phase 4): James's pick at a delta; absent = those accounts wait. */
    readonly jamesPick?: (ticker: string, delta: number) => JamesNightPick | null;
  } | null;
  /** G0b: the dated 10-year daily bars of the list and BTC-USD (paperJob LONG_BAR_TICKERS): James's layers are computed on them (else on `series`). */
  readonly long?: ReadonlyMap<string, PriceSeries>;
  /** Options sentiment P2: the options read is applied tonight (profile `options.applied`): "Engine, options off" joins / runs. */
  readonly optionsApplied?: boolean;
  /** 🤖 Claude, free choice: tonight's '🤖 Claude Picks' rows and how to price them; absent = the account is not run tonight. */
  readonly claude?: Omit<ClaudeNight, 'day' | 'fill'>;
}

const HOLD_OFF = new Set(['SPLIT', 'NO_CONSENSUS']);
/** James — Quality Gate's price items per series object (the nightly job hands the same objects every night it runs). */
const QG_PRICES = new WeakMap<PriceSeries, PriceItemsSeries>();

/** One closed day for every research account: fills at today's open (when `fill`), then decisions at the close (when `decide`). */
export function labDay(lab: LabState, input: LabDayInput, o: { fill: boolean; decide: boolean; cash: number }): PaperTrade[] {
  const d = input.day, trades: PaperTrade[] = [];
  const openOf = (t: string): number | null => input.bars[t]?.open ?? null;
  const closeOf = (t: string): number | null => input.bars[t]?.close ?? null;
  const reads = new Map(input.reads.map((r) => [r.ticker, r]));
  // Options sentiment P2: the twin "Engine, options off" reads the same night with options OFF (when the run has them).
  const readOf = (st: LabSetup, t: string): EngineRead | undefined => {
    const r = reads.get(t);
    return r && st.optionsOff && r.optionsOff ? { ...r, finalConviction: r.optionsOff.finalConviction, timing: r.optionsOff.timing, action: r.optionsOff.action } : r;
  };
  const trendCache = new Map<string, TrendDay | null>();
  const trendOn = (t: string, days: number): TrendDay | null => {
    const k = t + '|' + days;
    if (!trendCache.has(k)) {
      const s = input.series.get(t), i = s ? s.dates.lastIndexOf(d) : -1;
      trendCache.set(k, s && i >= 0 ? trendSeries(s.closes.slice(0, i + 1), days)[i] ?? null : null);
    }
    return trendCache.get(k) ?? null;
  };
  const wyCache = new Map<string, string | null>();
  const wyOn = (t: string): string | null => {
    if (!wyCache.has(t)) {
      const s = input.series.get(t), i = s ? s.dates.lastIndexOf(d) : -1;
      wyCache.set(t, s && i >= 0 ? wyckoffClassicSeries({ opens: s.opens.slice(0, i + 1), highs: s.highs.slice(0, i + 1), lows: s.lows.slice(0, i + 1), closes: s.closes.slice(0, i + 1), volumes: s.volumes.slice(0, i + 1) })[i]?.direction ?? null : null);
    }
    return wyCache.get(t) ?? null;
  };
  const dirOf = (m: string, t: string): string | null => (m === 'wyckoff' ? wyOn(t) : (reads.get(t)?.directions?.[m] ?? null));
  const says = (st: LabSetup, t: string, side: 'buy' | 'sell', a: LabAccount): boolean => {
    const want = side === 'buy' ? 'bullish' : 'cautionary';
    const r = readOf(st, t);
    if (st.model === 'engine' || st.model === 'current') {
      if (side === 'buy') return !!r && r.ok && r.finalConviction != null && (r.timing === 'BUY_NOW' || r.finalConviction >= 70) && (st.model === 'engine' || !HOLD_OFF.has(String(r.verdict)));
      const p = a.pos[t]; if (!p) return false;
      const x = input.exitRead(t, p.entryDate, p.cost / p.shares);
      return x.ok && x.actionClass === 'EXIT';
    }
    if (st.model === 'trend') return trendOn(t, st.trendDays)?.direction === want;
    if (st.model === 'combo') return ['turtle', 'schabacker', 'edwardsMagee'].filter((m) => dirOf(m, t) === want).length >= 2;
    if (st.model === 'best') {
      const combo = ['turtle', 'schabacker', 'edwardsMagee'].filter((m) => dirOf(m, t) === want).length >= 2;
      return side === 'buy' ? combo || says({ ...st, model: 'engine' }, t, 'buy', a) : combo;
    }
    return dirOf(st.model, t) === want;
  };
  const rankOf = (st: LabSetup, t: string): number => {
    const r = readOf(st, t);
    if (st.model === 'engine' || st.model === 'current' || st.model === 'best') return (r?.finalConviction ?? 0) + (r?.timing === 'BUY_NOW' ? 1000 : 0);
    return trendOn(t, st.trendDays)?.strength ?? -1;
  };

  const holdEqually = (list: readonly string[]): LabBench => {
    const b: LabBench = { cash: o.cash, shares: {}, cost: {} };
    const live = list.filter((t) => openOf(t) != null);
    for (const t of live) { const px = openOf(t) as number, n = Math.floor(o.cash / live.length / px); if (n > 0) { b.shares[t] = n; b.cost[t] = n * px; b.cash -= n * px; } }
    return b;
  };
  if (o.fill && !lab.listBench) lab.listBench = holdEqually(PAPER_OWNER_LIST);
  if (o.fill && !lab.list14Bench) lab.list14Bench = holdEqually(PAPER_RESEARCH_14);

  // James's layers (G1) on the 10-year bars (G0b), else on the 2-year series: at bar `back` before today (0 = today's close)
  const longOf = (t: string): PriceSeries | undefined => input.long?.get(t) ?? input.series.get(t);
  const layersOn = (t: string, o: typeof DEFAULT_LAYER_OPTIONS, back = 0): LayerSet | null => { const s = longOf(t), i = s ? s.dates.lastIndexOf(d) : -1; return s && i - back >= 0 ? layersAt(s, i - back, o) : null; };
  const barOf = (t: string): { open: number; high: number; low: number; close: number } | null => { const s = input.series.get(t), i = s ? s.dates.lastIndexOf(d) : -1; return s && i >= 0 ? { open: s.opens[i] as number, high: s.highs[i] as number, low: s.lows[i] as number, close: s.closes[i] as number } : null; };

  // James — Quality Gate: tonight's score of a stock (the 10-year bars when present: the 200-day trend needs 200 bars)
  const qualityTonight = (t: string): { pass: (g: GateRule) => boolean; line: string } | null => {
    const s = longOf(t), i = s ? s.dates.lastIndexOf(d) : -1;
    if (!s || i < 0) return null;
    let p = QG_PRICES.get(s); if (!p) { p = priceItemsSeries(s); QG_PRICES.set(s, p); }
    const sc = qualityScore({ ticker: t, day: d, prices: p, i, fund: null, history: true });
    const fails = sc.items.filter((x) => x.state === 'fail').map((x) => x.name.toLowerCase()), unknown = sc.items.filter((x) => x.state === 'unknown').length;
    return { pass: (g) => passesGate(sc, g), line: 'quality ' + sc.points + '/' + sc.known + ' known of 7' + (fails.length ? ': fails ' + fails.join(', ') : '') + (unknown ? ' (' + unknown + ' unknown)' : '') };
  };
  // Options sentiment P2: the go-live day is kept; the twin "Engine, options off" runs from then on.
  if (input.optionsApplied && o.decide && !lab.optionsLive) lab.optionsLive = d;
  for (const st of [...STOCK_SETUPS, ...JAMES_SHARE_SETUPS, ...(lab.optionsLive ? OPTIONS_OFF_SETUPS : [])]) {
    // An account that joins tonight only decides; its first fills are at the next open.
    const home = st.id.startsWith('james.') ? (lab.james ??= {}) : lab.accounts;
    const joining = !home[st.id];
    const a = home[st.id] ??= { cash: st.cash ?? o.cash, pos: {}, toSell: [], toBuy: [], taxPaid: 0 };
    const log = (side: 'BUY' | 'SELL', t: string, n: number, px: number, tax: number, why: string): void => { trades.push({ day: d, strategy: st.id, side, ticker: t, shares: n, price: px, value: n * px, tax, why }); };
    const sellPart = (t: string, n: number, px: number, why: string): void => {
      const p = a.pos[t]; if (!p || n <= 0) return;
      n = Math.min(n, p.shares);
      const cost = (p.cost * n) / p.shares, tax = Math.max(0, n * px - cost) * EXIT_TAX_RATE;
      p.shares -= n; p.cost -= cost; a.cash += n * px - tax; a.taxPaid += tax;
      if (p.shares <= 0) delete a.pos[t];
      log('SELL', t, n, px, tax, why);
    };
    const buy = (t: string, dollars: number, px: number, why: string): void => {
      const n = Math.floor(Math.min(dollars, a.cash) / px); if (n <= 0) return;
      a.cash -= n * px;
      const p = a.pos[t];
      if (p) { p.shares += n; p.cost += n * px; } else {
        // James — Profit-Taking: the sell layers of the stock at the close the buy was decided on, frozen with the position
        const ls = st.profitTaking && t !== 'QQQ' ? layersOn(t, DEFAULT_LAYER_OPTIONS, 1) : null;
        a.pos[t] = { shares: n, cost: n * px, entryDate: d, ...(ls && st.profitTaking ? { pt: newPtState(st.profitTaking, ls.levels, n) } : {}) };
      }
      log('BUY', t, n, px, 0, why);
    };

    // 1. at the open: sells, fund the buys from QQQ, buys, the rest into QQQ
    if (o.fill && !joining) {
      for (const t of a.toSell) { const px = openOf(t); if (px != null && a.pos[t]) sellPart(t, a.pos[t]!.shares, px, st.sell === 'trend200' ? '200-day trend broke' : 'model says sell'); }
      const buys = a.toBuy.filter((t) => openOf(t) != null && !a.pos[t]);
      const qOpen = openOf('QQQ');
      if (buys.length) {
        let eq = a.cash;
        for (const [t, p] of Object.entries(a.pos)) eq += p.shares * (openOf(t) ?? p.cost / p.shares);
        const slot = eq / st.slots, need = slot * buys.length - a.cash;
        if (need > 0 && a.pos.QQQ && qOpen) sellPart('QQQ', Math.ceil(need / qOpen), qOpen, 'money for a buy');
        for (const t of buys) buy(t, slot, openOf(t) as number, 'model says buy');
      }
      if (qOpen && a.cash >= qOpen) buy('QQQ', a.cash, qOpen, 'spare money');
      a.toSell = []; a.toBuy = [];
      if (st.profitTaking) profitTakingSells(a, barOf, log);
    }

    // 2. at the close: what to sell and buy at the next open
    if (o.decide) {
      const held = Object.keys(a.pos).filter((t) => t !== 'QQQ');
      // A stock too young for a 200-day average (SPCX listed 2026-06-12) is sold on the model's own sell rule instead.
      a.toSell = held.filter((t) => (st.sell === 'trend200' && trendOn(t, 200)?.sma != null ? trendOn(t, 200)?.direction === 'cautionary' : says(st, t, 'sell', a)));
      const free = st.slots - (held.length - a.toSell.length);
      if (st.quality) a.gate = {};
      const gateOk = (t: string): boolean => {
        if (!st.quality) return true;
        const q = qualityTonight(t), pass = !!q && q.pass(st.quality);
        a.gate![t] = { pass, line: q ? q.line : 'quality unknown (no bars)' };
        return pass;
      };
      a.toBuy = free > 0 ? PAPER_OWNER_LIST.filter((t) => closeOf(t) != null && !a.pos[t] && says(st, t, 'buy', a) && gateOk(t))
        .map((t) => ({ t, rank: rankOf(st, t) })).sort((x, y) => y.rank - x.rank || x.t.localeCompare(y.t)).slice(0, free).map((x) => x.t) : [];
    }
  }
  // LEAPS twins: a LEAPS call on each stock the twin holds after tonight's decisions
  if (input.options) {
    const leaps = lab.leaps ??= {};
    for (const st of STOCK_SETUPS) {
      const id = st === ALL_SHARES ? ALL_LEAPS_ID : leapsId(st.id), a = lab.accounts[st.id]!;
      const joining = !leaps[id];
      const acct = leaps[id] ??= newLeapsAccount(st.cash ?? o.cash);
      const want = new Set([...Object.keys(a.pos).filter((t) => t !== 'QQQ' && !a.toSell.includes(t)), ...a.toBuy]);
      const q = input.bars.QQQ ?? null;
      for (const x of leapsNight(acct, { qqq: q, quote: input.options.quote, pick: input.options.pick, nowUnix: input.options.nowUnix, want, slots: st.slots, fill: o.fill && !joining, decide: o.decide })) {
        trades.push({ day: d, strategy: id, side: x.side, ticker: x.ticker, shares: x.shares, price: x.price, value: x.shares * x.price * (x.ticker === 'QQQ' ? 1 : 100), tax: x.tax, why: x.why });
      }
    }
  }

  // LILO: its own book (limit rungs, stop, targets; spare money in QQQ)
  const book = lab.lilo ??= newLiloBook(o.cash);
  const bars = new Map<string, LiloBar>();
  for (const t of PAPER_OWNER_LIST) {
    const s = input.series.get(t), i = s ? s.dates.lastIndexOf(d) : -1;
    if (s && i >= 0) bars.set(t, { open: s.opens[i] as number, high: s.highs[i] as number, low: s.lows[i] as number, close: s.closes[i] as number });
  }
  let signals: Map<string, LiloSignal> | null = null;
  if (o.decide) {
    signals = new Map();
    for (const r of input.reads) {
      const z = r.lilo, c = r.finalConviction;
      if (r.ok && c != null && (r.timing === 'BUY_NOW' || c >= 70) && z && z.entryLow != null && z.entryHigh != null && bars.has(r.ticker)) {
        signals.set(r.ticker, { rank: c + (r.timing === 'BUY_NOW' ? 1000 : 0), entryLow: z.entryLow, entryHigh: z.entryHigh, entryCount: z.entryCount ?? 1, t1: z.t1, t2: z.t2, stop: r.stop });
      }
    }
  }
  const q = input.bars.QQQ ?? null;
  const lt = liloDay(book, LILO_SLOTS, bars, q, signals, o.fill);
  for (const x of lt) trades.push({ day: d, strategy: LILO_ID, side: x.side, ticker: x.ticker, shares: x.shares, price: x.price, value: x.shares * x.price, tax: x.tax, why: x.why });

  // James — Profit-Taking on the 14 held equally: bought at its first open, the schedule's steps at the layers, the rest held
  {
    const id = JAMES_PT_LIST14_ID, home = lab.james ??= {}, joining = !home[id];
    const a = home[id] ??= { cash: o.cash, pos: {}, toSell: [], toBuy: [...PAPER_RESEARCH_14], taxPaid: 0 };
    const log = (side: 'BUY' | 'SELL', t: string, n: number, px: number, tax: number, why: string): void => { trades.push({ day: d, strategy: id, side, ticker: t, shares: n, price: px, value: n * px, tax, why }); };
    if (o.fill && !joining) {
      const qOpen = openOf('QQQ');
      const first = a.toBuy.filter((t) => openOf(t) != null);
      for (const t of first) {
        const px = openOf(t) as number, n = Math.floor(o.cash / PAPER_RESEARCH_14.length / px);
        if (n <= 0 || n * px > a.cash) continue;
        const ls = layersOn(t, DEFAULT_LAYER_OPTIONS, 1);
        a.cash -= n * px; a.pos[t] = { shares: n, cost: n * px, entryDate: d, ...(ls ? { pt: newPtState(JAMES_PT_SCHEDULE, ls.levels, n) } : {}) };
        log('BUY', t, n, px, 0, LABELS.holdResearchCoreLower + ', with James\'s ' + JAMES_PT_SCHEDULE + ' schedule at its layers 6-10');
      }
      a.toBuy = a.toBuy.filter((t) => !first.includes(t));
      if (qOpen && a.cash >= qOpen) { const n = Math.floor(a.cash / qOpen); a.cash -= n * qOpen; const p = a.pos.QQQ; if (p) { p.shares += n; p.cost += n * qOpen; } else a.pos.QQQ = { shares: n, cost: n * qOpen, entryDate: d }; log('BUY', 'QQQ', n, qOpen, 0, 'spare money'); }
      profitTakingSells(a, barOf, log);
    }
  }

  // James — LILO v2: its own book (snipe buys at the layers, the 200-day stop; spare money in QQQ)
  {
    const joining = !lab.liloV2;
    const v2 = lab.liloV2 ??= newLiloV2Book(o.cash);
    const v2bars = new Map<string, { open: number; high: number; low: number; close: number }>();
    const layers = new Map<string, LayerSet | null>();
    for (const t of PAPER_OWNER_LIST) { const b = barOf(t); if (b) { v2bars.set(t, b); layers.set(t, layersOn(t, LILO_V2_CHOSEN.layers)); } }
    const stopHit = (t: string): boolean => {
      const s = longOf(t), i = s ? s.dates.lastIndexOf(d) : -1;
      if (!s || i < 0) return false;
      const m = smaSeries(s.closes.slice(Math.max(0, i - 199), i + 1), 200);
      const avg = m[m.length - 1];
      return avg != null && (s.closes[i] as number) < 0.97 * avg;
    };
    const vt = liloV2Day(v2, { ...LILO_V2_CHOSEN.book, reanchor: LILO_V2_CHOSEN.layers.anchor === 'A2' ? 'whenFlat' : 'adopt' }, {
      bars: v2bars, qqq: q, layers: o.decide ? layers : null, fill: o.fill && !joining, stopHit: LILO_V2_CHOSEN.book.stop === 'trend200' ? stopHit : undefined,
    });
    for (const x of vt) trades.push({ day: d, strategy: JAMES_LILO_V2_ID, side: x.side, ticker: x.ticker, shares: x.shares, price: x.price, value: x.shares * x.price, tax: x.tax, why: x.why });
  }
  james2Day(lab, input, o, trades, longOf);
  james3Day(lab, input, o, trades, longOf);
  jamesLeapsDay(lab, input, o, trades, longOf);
  // 🤖 Claude, free choice: its orders from the tab (the book is made when the first row is seen)
  const cl = input.claude;
  if (cl && (lab.claude || cl.rows.length)) {
    const b = lab.claude ??= newClaudeBook(o.cash);
    for (const x of claudeDay(b, { ...cl, day: d, fill: o.fill })) trades.push({ day: d, strategy: CLAUDE_ID, side: x.side, ticker: x.ticker, shares: x.shares, price: x.price, value: x.value, tax: x.tax, why: x.why });
  }
  return trades;
}

/**
 * James's models, phase 4: one night of every James — LEAPS account (fills tonight at the quotes when not joining,
 * then tonight's decisions), after the stock accounts and the cycle book have decided.
 */
function jamesLeapsDay(lab: LabState, input: LabDayInput, o: { fill: boolean; decide: boolean; cash: number }, trades: PaperTrade[], longOf: (t: string) => PriceSeries | undefined): void {
  const opts = input.options, jp = opts?.jamesPick;
  if (!opts || !jp) return;
  const d = input.day, q = input.bars.QQQ ?? null;
  const at = (t: string): { s: PriceSeries; k: number } | null => { const s = longOf(t), k = s ? s.dates.lastIndexOf(d) : -1; return s && k >= 0 ? { s, k } : null; };
  // tonight's fire sales: the market (QQQ) and each stock of the list
  const qs = longOf('QQQ'), qi = qs ? qs.dates.lastIndexOf(d) : -1;
  const mk = qs && qi >= 0 ? marketFireSale(qs.closes.slice(0, qi + 1))[qi] ?? null : null;
  const episode = mk && mk.on && mk.episodeStart != null ? (qs!.dates[mk.episodeStart] as string) : null;
  const tonight = new Map<string, { dd: number; z: number | null; market: boolean; stock: boolean; why: string; above: boolean; broken: boolean; rv252: number | null }>();
  for (const t of PAPER_OWNER_LIST) {
    const x = at(t); if (!x) continue;
    const c = x.s.closes.slice(0, x.k + 1), fs = stockFireSale(c)[x.k]!, z = zSeries(c.slice(-40), 20).z.at(-1) ?? null, tr = trendSeries(c, 200)[x.k]!;
    tonight.set(t, { dd: fs.dd, z, market: !!episode, stock: fs.buy, above: tr.sma != null && (c[x.k] as number) > tr.sma, broken: tr.direction === 'cautionary', rv252: realizedVol(c, 252),
      why: episode ? 'market fire sale: QQQ ' + Math.round((mk as { dd: number }).dd * 100) + '% under its 52-week high (episode from ' + episode + '), ' + t + ' ' + Math.round(fs.dd * 100) + '% under its own'
        : fs.buy ? 'stock fire sale: ' + t + ' ' + Math.round(fs.dd * 100) + '% under its 52-week high, ' + (fs.why ?? 'turnaround') : '' });
  }
  let rate = 0.04;
  try { rate = rateOn(d) || 0.04; } catch { /* the Fed funds file is not there: 4% */ }
  const night = { stock: (t: string) => input.bars[t] ?? null, trend: (t: string) => { const x = tonight.get(t); return x ? { above: x.above, broken: x.broken } : null; }, spike: (t: string) => (tonight.get(t)?.z ?? 0) >= 2 };
  const bought = lab.jamesLeapsBought ??= {};
  const leaps = lab.leaps ??= {};
  for (const st of JAMES_LEAPS_SETUPS) {
    const joining = !leaps[st.id];
    const a = leaps[st.id] ??= newLeapsAccount(o.cash);
    const mem = bought[st.id] ??= {};
    const held = new Set([...a.held.map((h) => h.ticker), ...Object.keys(a.shares ?? {}), ...a.orders.filter((x) => x.side === 'BUY').map((x) => x.ticker)]);
    let want: Set<string>;
    const why = new Map<string, { text: string; market: boolean }>();
    if (st.entry === 'twin.best') {
      const s = lab.accounts[ALL_SHARES.id];
      want = new Set(s ? [...Object.keys(s.pos).filter((t) => t !== 'QQQ' && !s.toSell.includes(t)), ...s.toBuy] : []);
      for (const t of want) why.set(t, { text: 'Everything together holds ' + t, market: false });
    } else if (st.entry === 'twin.cycle') {
      const b = lab.cycle;
      want = new Set(b ? [...Object.keys(b.pos), ...b.orders.filter((x) => x.side === 'BUY' && x.t !== 'QQQ').map((x) => x.t)] : []);
      for (const t of want) why.set(t, { text: 'James — Multi-Year Cycle holds ' + t, market: false });
    } else {
      // held stays wanted; a 60-day-roll account lets a holding go at the roll when its 200-day trend is broken
      want = new Set([...held].filter((t) => !(st.exit === 'roll60' && a.held.some((h) => h.ticker === t && (h.expUnix - opts.nowUnix) / 86_400 <= 60) && tonight.get(t)?.broken)));
      const cands = [...tonight].filter(([t, x]) => !held.has(t) && !(x.z != null && x.z >= 2) && ((x.market && mem[t] !== episode) || x.stock))
        .sort((x, y) => y[1].dd - x[1].dd || x[0].localeCompare(y[0]));
      let free = st.slots - held.size;
      for (const [t, x] of cands) { if (free <= 0) break; want.add(t); why.set(t, { text: x.why, market: x.market && mem[t] !== episode }); free--; }
    }
    const pick = (t: string): LeapsPick | null => {
      const p = jp(t, st.delta), w = why.get(t);
      if (!p) return null;
      if (st.fair && !(w?.market)) {
        // the fair-value filter (plan 04 P5 / P6), with the crash override for a market fire sale
        const x = tonight.get(t), spot = input.bars[t]?.close ?? null;
        if (spot != null) {
          const fv = fairValueOf({ strike: p.strike, expUnix: p.expUnix, bid: p.bid, ask: p.ask, iv: p.iv, delta: p.delta }, spot, opts.nowUnix, { rv20: null, rv60: null, rv252: x?.rv252 ?? null }, rate);
          if (fv.richFlag || fv.ivrFlag) return null;
        }
      }
      return { ...p, why: 'James — LEAPS (' + st.delta.toFixed(2) + '): ' + (w?.text ?? t) + '; ' + p.why };
    };
    const before = new Set(a.orders.map((x) => x.symbol));
    for (const x of leapsNight(a, { qqq: q, quote: opts.quote, pick, nowUnix: opts.nowUnix, want, slots: st.slots, fill: o.fill && !joining, decide: o.decide, ...night },
      { exit: st.exit, onePlus: 1.5, ...(st.trim ? { trim: true } : {}), ...(st.cap ? { deltaCap: 1 } : {}) })) {
      const option = x.ticker.includes(' call ');
      trades.push({ day: d, strategy: st.id, side: x.side, ticker: x.ticker, shares: x.shares, price: x.price, value: x.shares * x.price * (option ? 100 : 1), tax: x.tax, why: x.why });
    }
    if (episode) for (const x of a.orders) if (x.side === 'BUY' && !before.has(x.symbol) && why.get(x.ticker)?.market) mem[x.ticker] = episode;
  }
}

/** James's models, phase 2: one night of each book (fills at the open when the account is not joining, then tonight's decisions). */
function james2Day(lab: LabState, input: LabDayInput, o: { fill: boolean; decide: boolean; cash: number }, trades: PaperTrade[], longOf: (t: string) => PriceSeries | undefined): void {
  const d = input.day;
  const push = (id: string, x: { ticker: string; side: 'BUY' | 'SELL'; shares: number; price: number; tax: number; why: string }): void => { trades.push({ day: d, strategy: id, side: x.side, ticker: x.ticker, shares: x.shares, price: x.price, value: x.shares * x.price, tax: x.tax, why: x.why }); };
  const qs = input.series.get('QQQ'), qi = qs ? qs.dates.lastIndexOf(d) : -1, q = input.bars.QQQ ?? null;
  const closeOf = (t: string): number | null => input.bars[t]?.close ?? null;
  // ↩️ James — Mean Reversion
  {
    const joining = !lab.meanRev;
    const b = lab.meanRev ??= newSignalBook(o.cash);
    const bars = new Map<string, { open: number; close: number }>(), at = new Map<string, { s: PriceSeries; k: number }>();
    for (const t of PAPER_OWNER_LIST) { const s = input.series.get(t), k = s ? s.dates.lastIndexOf(d) : -1; if (s && k >= 0) { bars.set(t, { open: s.opens[k] as number, close: s.closes[k] as number }); at.set(t, { s, k }); } }
    let decide: Parameters<typeof signalDay>[2]['decide'] = null;
    if (o.decide && qs && qi >= 0) {
      // F3: QQQ "down" from a close 3% under its 150-day average until a close above a rising one (the state walked to tonight)
      let down = false;
      for (const x of trendSeries(qs.closes.slice(0, qi + 1), 150)) { if (x.direction === 'cautionary') down = true; else if (x.direction === 'bullish') down = false; }
      const exits = new Map<string, string>();
      for (const [t, p] of Object.entries(b.pos)) { const a = at.get(t); if (!a) continue; const why = mrExit(a.s, a.k, MR_CHOSEN, p.held, p.entryPx, p.note); if (why) exits.set(t, 'James — Mean Reversion: ' + why); }
      const entries = [...at].filter(([t, a]) => !b.pos[t] && signalsOf(a.s, MR_CHOSEN.n, MR_CHOSEN.entry, MR_CHOSEN.k, MR_CHOSEN.m)[a.k] && mrFilter(a.s, a.k, MR_CHOSEN, down))
        .map(([t, a]) => ({ t, z: zOf(a.s, MR_CHOSEN.n)[a.k] ?? 0, note: atrOf(a.s)[a.k] ?? null })).sort((x, y) => x.z - y.z || x.t.localeCompare(y.t))
        .map((x) => ({ t: x.t, why: 'James — Mean Reversion: close ' + Math.abs(x.z).toFixed(2) + ' SD under its ' + MR_CHOSEN.n + '-day average', note: x.note }));
      decide = { exits, entries };
    }
    for (const x of signalDay(b, { slots: MR_CHOSEN.slots, idle: MR_CHOSEN.idle, costBps: 0 }, { day: d, bars, qqq: q, fill: o.fill && !joining, decide })) push(JAMES_MR_ID, x);
  }
  // 🔁 James — Pair MSTR/TSLA
  {
    const books = lab.pair ??= {}, joining = !books[JAMES_PAIR_ID];
    const k = books[JAMES_PAIR_ID] ??= newPairBook('MSTR', 'TSLA', o.cash, PAIR_CHOSEN.sleeve);
    const opens = new Map<string, number>();
    for (const t of ['MSTR', 'TSLA']) { const v = input.bars[t]?.open; if (v != null) opens.set(t, v); }
    let want: string | null = null;
    const A = longOf('MSTR'), B = longOf('TSLA');
    if (o.decide && A && B) {
      const { al, st } = pairStates(A, B, PAIR_CHOSEN.opts), j = al.dates.lastIndexOf(d);
      const h = j >= 0 ? st[j]?.hold : null;
      want = h === 'A' ? 'MSTR' : h === 'B' ? 'TSLA' : null;
    }
    for (const x of pairDay(k, { costBps: 0 }, { opens, fill: o.fill && !joining, want, why: 'James — Pair Rotation: the MSTR/TSLA ratio 2 SD from its 20-day average' })) push(JAMES_PAIR_ID, x);
  }
  // 🏆 James — Winners & Layering (and + BTC sleeve)
  for (const [id, sleeve] of [[JAMES_WINNERS_ID, undefined], [JAMES_WINNERS_BTC_ID, JAMES_BTC_SLEEVE]] as const) {
    const books = lab.winners ??= {}, joining = !books[id];
    const b = books[id] ??= newWinnersBook(o.cash, sleeve ? { ...sleeve, countsAlso: [...sleeve.countsAlso] } : undefined);
    const opens = new Map<string, number>();
    for (const t of PAPER_OWNER_LIST) { const v = input.bars[t]?.open; if (v != null) opens.set(t, v); }
    for (const x of winnersDay(b, WINNERS_CHOSEN.o, { opens, qqqOpen: q?.open ?? null, fill: o.fill && !joining })) push(id, x);
    if (o.decide && qs && qi >= 0) {
      const stocks = new Map<string, WCtx>();
      for (const t of PAPER_OWNER_LIST) { const s = longOf(t), i = s ? s.dates.lastIndexOf(d) : -1; if (s && i >= 0) stocks.set(t, { closes: s.closes, highs: s.highs, i, date: d }); }
      const qctx: WCtx = { closes: qs.closes, highs: qs.highs, i: qi, date: d };
      const notRanked = sleeve ? new Set([sleeve.ticker]) : undefined;
      winnersDecide(b, WINNERS_CHOSEN.o, { stocks, qqq: qctx, ...(notRanked ? { notRanked } : {}) }, closeOf);
      if (!sleeve) lab.winnersRank = { day: d, n: WINNERS_CHOSEN.o.n, list: rankTonight(WINNERS_CHOSEN.o, { stocks, qqq: qctx }) };
    }
  }
}

/** Phase 3's cycle reads, once per series object per run (the nightly job hands the same objects every night it runs). */
const CYCLE_SIG = new WeakMap<PriceSeries, CycleSignals>();
const cycleSigOf = (s: PriceSeries): CycleSignals => { let x = CYCLE_SIG.get(s); if (!x) { x = cycleSignals(s); CYCLE_SIG.set(s, x); } return x; };

/** James's models, phase 3: one night of each book (fills at the open when the account is not joining, then tonight's decisions). */
function james3Day(lab: LabState, input: LabDayInput, o: { fill: boolean; decide: boolean; cash: number }, trades: PaperTrade[], longOf: (t: string) => PriceSeries | undefined): void {
  const d = input.day;
  const push = (id: string, x: { ticker: string; side: 'BUY' | 'SELL'; shares: number; price: number; tax: number; why: string }): void => { trades.push({ day: d, strategy: id, side: x.side, ticker: x.ticker, shares: x.shares, price: x.price, value: x.shares * x.price, tax: x.tax, why: x.why }); };
  const qs = longOf('QQQ'), qi = qs ? qs.dates.lastIndexOf(d) : -1, q = input.bars.QQQ ?? null;
  const opens = new Map<string, number>();
  for (const t of PAPER_OWNER_LIST) { const v = input.bars[t]?.open; if (v != null) opens.set(t, v); }
  // the cycle reads tonight: the list on its own bars; IBIT on BTC-USD's bar of the day before (T7), priced at its own close
  const btc = input.long?.get('BTC-USD');
  const stocks = new Map<string, { s: CycleSignals; i: number; close: number; price?: number }>();
  if (o.decide) for (const t of PAPER_OWNER_LIST) {
    const s = longOf(t), i = s ? s.dates.lastIndexOf(d) : -1;
    if (!s || i < 0) continue;
    if (t === 'IBIT' && btc) { const j = btcIndexBefore(btc, d); if (j >= 0) { stocks.set(t, { s: cycleSigOf(btc), i: j, close: btc.closes[j] as number, price: s.closes[i] as number }); continue; } }
    stocks.set(t, { s: cycleSigOf(s), i, close: s.closes[i] as number });
  }
  const qqqRet126 = qs && qi >= 126 ? (qs.closes[qi] as number) / (qs.closes[qi - 126] as number) - 1 : null;
  const ctx: CycleCtx = { day: d, stocks, qqqRet126, qqqClose: q?.close ?? null };
  // 🔄 James — Multi-Year Cycle (Part A)
  {
    const joining = !lab.cycle;
    const b = lab.cycle ??= newCycleBook(o.cash);
    if (o.fill && !joining) for (const x of cycleFill(b, { ...CYCLE_CHOSEN.o, costBps: 0 }, opens, q?.open ?? null, 0)) push(JAMES_CYCLE_ID, { ...x, why: 'James — Multi-Year Cycle: ' + x.why });
    if (o.decide && stocks.size) cycleDecide(b, CYCLE_CHOSEN.o, ctx);
  }
  // 🔄 James — BTC cycle sleeve (Parts B + C, descriptive)
  {
    const joining = !lab.cycleBtc;
    const b = lab.cycleBtc ??= newBtcSleeveBook(o.cash);
    if (o.fill && !joining) for (const x of btcSleeveFill(b, BTC_SLEEVE_DEFAULT, opens)) push(JAMES_CYCLE_BTC_ID, { ...x, why: 'James — BTC cycle sleeve: ' + x.why });
    if (o.decide && stocks.size) {
      const h = halvingMonth(d), j = btc ? btcIndexBefore(btc, d) : -1, reg = btc && j >= 0 ? btcRegimeAt(btc, cycleSigOf(btc), j) : null;
      btcSleeveDecide(b, BTC_SLEEVE_DEFAULT, { day: d, window: halvingWindow(h, HALVING_FROZEN_2017), halvingMonth: h, zone: reg?.zone ?? null, riskOff: reg?.riskOff ?? false,
        sleevePx: input.bars[BTC_SLEEVE_DEFAULT.ticker]?.close ?? null, leaders: leadersTonight(CYCLE_CHOSEN.o, { ...ctx, stocks: new Map([...stocks].filter(([t]) => t !== BTC_SLEEVE_DEFAULT.ticker)) }),
        closeOf: (t) => input.bars[t]?.close ?? null });
    }
  }
  // 🪤 James — Market Maker Stages
  {
    const joining = !lab.marketMaker;
    const b = lab.marketMaker ??= newSignalBook(o.cash);
    const bars = new Map<string, { open: number; close: number }>(), at = new Map<string, { s: PriceSeries; k: number }>();
    for (const t of PAPER_OWNER_LIST) { const s = longOf(t), k = s ? s.dates.lastIndexOf(d) : -1, bar = input.bars[t]; if (s && k >= 0 && bar) { bars.set(t, { open: bar.open, close: bar.close }); at.set(t, { s, k }); } }
    let decide: Parameters<typeof signalDay>[2]['decide'] = null;
    if (o.decide) {
      const exits = new Map<string, string>(), trims = new Map<string, { frac: number; why: string }>();
      for (const [t, p] of Object.entries(b.pos)) {
        const a = at.get(t); if (!a || !p.plan) continue;
        const x = mmExit(a.s, a.k, MM_CHOSEN.o, p.held, p.entryPx, p.plan);
        if (x?.sell) exits.set(t, 'James — Market Maker: ' + x.sell); else if (x?.trim) trims.set(t, { frac: 0.5, why: 'James — Market Maker: ' + x.trim });
      }
      const entries: Array<{ t: string; why: string; share?: number; plan: { stop: number; target1: number | null; target2: number | null; halfDone: boolean } }> = [];
      for (const [t, a] of at) {
        if (b.pos[t]) continue;
        const m = mmOf(a.s, MM_CHOSEN.o)[a.k];
        if (!m || !m.signal || m.stop == null) continue;
        const sh = mmShare(MM_CHOSEN.o, a.s.closes[a.k] as number, m.stop);
        if (sh === 0) continue;
        entries.push({ t, why: 'James — Market Maker: second sweep at ' + (m.sweepLow as number).toFixed(2) + ' (stage 3), stop ' + m.stop.toFixed(2), ...(sh != null ? { share: sh } : {}), plan: { stop: m.stop, target1: m.target1, target2: m.target2, halfDone: false } });
      }
      decide = { exits, entries, trims };
    }
    for (const x of signalDay(b, { slots: MM_CHOSEN.o.slots, idle: MM_CHOSEN.o.idle, costBps: 0 }, { day: d, bars, qqq: q, fill: o.fill && !joining, decide })) push(JAMES_MM_ID, x);
  }
}

/** James — Profit-Taking: today's steps at the layers (resting limit sells, filled at max(layer, open)), 25% tax on each step's gain. */
function profitTakingSells(a: LabAccount, barOf: (t: string) => { open: number; high: number; low: number; close: number } | null,
  log: (side: 'BUY' | 'SELL', t: string, n: number, px: number, tax: number, why: string) => void): void {
  for (const [t, p] of Object.entries(a.pos)) {
    const bar = t === 'QQQ' || !p.pt ? null : barOf(t);
    if (!bar || !p.pt) continue;
    for (const f of profitTakingFills(p.pt, bar, p.shares, 'intraday', p.cost / p.shares)) {
      const n = Math.min(f.shares, p.shares), px = f.price as number, cost = (p.cost * n) / p.shares, tax = Math.max(0, n * px - cost) * EXIT_TAX_RATE;
      p.shares -= n; p.cost -= cost; a.cash += n * px - tax; a.taxPaid += tax;
      log('SELL', t, n, px, tax, 'profit taking: ' + (f.step < 5 ? 'layer ' + (6 + f.step) : 'layer 10 x 1.2^' + (f.step - 4)) + ' $' + f.level.toFixed(2) + ', '
        + (p.pt.schedule.startsWith('A') || p.pt.schedule === 'C' ? (p.pt.schedule === 'A20' ? '20' : '10') + '% of current' : (p.pt.schedule === 'B20' ? '20' : '10') + '% of the first position') + ' (' + p.pt.schedule + ')');
      if (p.shares <= 0) { delete a.pos[t]; break; }
    }
  }
}

const afterTax = (cash: number, items: Array<[number, number, number | null]>): number =>
  items.reduce((v, [shares, cost, px]) => { const val = shares * (px ?? cost / shares); return v + val - Math.max(0, val - cost) * EXIT_TAX_RATE; }, cash);

/** Values after the tax on what is still held, per research account plus the list benchmark ('lab.list'). */
export function labValues(lab: LabState, closeOf: (t: string) => number | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const st of [...LAB_SETUPS, ...OPTIONS_OFF_SETUPS]) { const a = lab.accounts[st.id]; if (a) out[st.id] = afterTax(a.cash, Object.entries(a.pos).map(([t, p]) => [p.shares, p.cost, closeOf(t)])); }
  if (lab.lilo) out[LILO_ID] = liloValue(lab.lilo, closeOf);
  for (const [id, a] of Object.entries(lab.leaps ?? {})) out[id] = leapsValue(a, closeOf('QQQ'), closeOf);
  const all = lab.accounts[ALL_SHARES.id];
  if (all) out[ALL_ID] = afterTax(all.cash, Object.entries(all.pos).map(([t, p]) => [p.shares, p.cost, closeOf(t)])) + (out[ALL_LEAPS_ID] ?? (ALL_SHARES.cash as number));
  if (lab.listBench) { const b = lab.listBench; out['lab.list'] = afterTax(b.cash, Object.entries(b.shares).map(([t, n]) => [n, b.cost[t] ?? 0, closeOf(t)])); }
  if (lab.list14Bench) { const b = lab.list14Bench; out['lab.list14'] = afterTax(b.cash, Object.entries(b.shares).map(([t, n]) => [n, b.cost[t] ?? 0, closeOf(t)])); }
  // James's models (phase 1)
  for (const [id, a] of Object.entries(lab.james ?? {})) { out[id] = afterTax(a.cash, Object.entries(a.pos).map(([t, p]) => [p.shares, p.cost, closeOf(t)])); }
  if (lab.liloV2) out[JAMES_LILO_V2_ID] = liloV2Value(lab.liloV2, closeOf);
  // phase 2
  if (lab.meanRev) out[JAMES_MR_ID] = signalValue(lab.meanRev, closeOf);
  for (const [id, k] of Object.entries(lab.pair ?? {})) out[id] = pairValue(k, closeOf);
  for (const [id, b] of Object.entries(lab.winners ?? {})) out[id] = winnersValue(b, closeOf);
  // phase 3
  if (lab.cycle) out[JAMES_CYCLE_ID] = cycleValue(lab.cycle, closeOf);
  if (lab.cycleBtc) out[JAMES_CYCLE_BTC_ID] = btcSleeveValue(lab.cycleBtc, BTC_SLEEVE_DEFAULT, closeOf);
  if (lab.marketMaker) out[JAMES_MM_ID] = signalValue(lab.marketMaker, closeOf);
  // 🤖 Claude, free choice: from its first fill
  if (lab.claude?.joined) out[CLAUDE_ID] = claudeValue(lab.claude, closeOf);
  return out;
}

/** A phase-2 book's holdings (QQQ included when held); null for any other id. */
export function james2Held(lab: LabState, id: string): string[] | null {
  if (id === JAMES_MR_ID) return lab.meanRev ? [...signalHeld(lab.meanRev), ...(lab.meanRev.qqq.shares ? ['QQQ'] : [])] : [];
  if (id === JAMES_PAIR_ID) return lab.pair?.[id] ? pairHeld(lab.pair[id]!) : [];
  if (id === JAMES_WINNERS_ID || id === JAMES_WINNERS_BTC_ID) { const b = lab.winners?.[id]; return b ? [...winnersHeld(b), ...(b.qqq.shares ? ['QQQ'] : [])] : []; }
  if (id === JAMES_CYCLE_ID) return lab.cycle ? [...cycleHeld(lab.cycle), ...(lab.cycle.qqq.shares ? ['QQQ'] : [])] : [];
  if (id === JAMES_CYCLE_BTC_ID) return lab.cycleBtc ? btcSleeveHeld(lab.cycleBtc, BTC_SLEEVE_DEFAULT) : [];
  if (id === JAMES_MM_ID) return lab.marketMaker ? [...signalHeld(lab.marketMaker), ...(lab.marketMaker.qqq.shares ? ['QQQ'] : [])] : [];
  return null;
}

export const labHeld = (lab: LabState, id: string): string[] => id === CLAUDE_ID ? (lab.claude ? claudeHeld(lab.claude) : []) : james2Held(lab, id) ?? (id === JAMES_LILO_V2_ID ? (lab.liloV2 ? [...liloV2Held(lab.liloV2), ...(lab.liloV2.qqq.shares ? ['QQQ'] : [])] : []) : id === ALL_ID ? [...new Set([...labHeld(lab, ALL_SHARES.id), ...labHeld(lab, ALL_LEAPS_ID)])].sort() : lab.leaps?.[id] ? [...leapsHeld(lab.leaps[id]!), ...(lab.leaps[id]!.qqq.shares ? ['QQQ'] : [])] : id === LILO_ID ? (lab.lilo ? [...liloHeld(lab.lilo), ...(lab.lilo.qqq.shares ? ['QQQ'] : [])] : []) : Object.keys(labAccount(lab, id)?.pos ?? {}).sort());
