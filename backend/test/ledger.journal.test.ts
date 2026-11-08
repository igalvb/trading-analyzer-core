/**
 * The advice journal (src/ledger/journal.ts, journalNight.ts, src/journalAdd.ts, the dashboard's Journal tab): the
 * dedupe, "acted?" from the ledger (edits, lots, closed positions), "right?" per advice type and horizon, pending, the
 * CLI, the Nightly step with report grids made by the real sheet builders, and the dashboard section (no NaN).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReportWorkbook, MemoryWorkbookBackend } from '../src/sheets/reportSheet.ts';
import { formatStockSignals, formatOptionsSignals } from '../src/reports/exit/exitReport.ts';
import { buildExitSheet, EXIT_SHEET_TAB } from '../src/reports/exitSheet/exitSheet.ts';
import type { ExitHoldingInput, ExitReportInput } from '../src/reports/exitSheet/types.ts';
import { buildBuySheet } from '../src/reports/buySheet/buySheet.ts';
import { BUY_SHEET_TAB, NCOLS } from '../src/reports/buySheet/text.ts';
import type { BuyCandidateInput } from '../src/reports/buySheet/types.ts';
import type { TabCell } from '../src/storage/tabStore.ts';
import { CLAUDE_IDEAS_TAB, CLAUDE_IDEAS_HEADER } from '../src/paper/claudeIdeas.ts';
import { parseExitReport, parseBuyReport, buildDashboard, type DashboardContext } from '../src/dashboard/data.ts';
import {
  makeJournalEntry, selectNewEntries, tradesOf, actedOf, scoreEntry, verdictOf, edgeOf, buildJournal, addMonths, addTradingDays, horizonEnd, journalSeriesKeys, validEntries,
  JOURNAL_HORIZONS, ALERT_REPEAT_DAYS, RULE_OF_THUMB_USD, type JournalFields, type JournalSeries,
} from '../src/ledger/journal.ts';
import { journalCandidates, runJournalNight, exitAdviceOf, buyAdviceOf } from '../src/ledger/journalNight.ts';
import { runJournalAdd, parseJournalArgs } from '../src/journalAdd.ts';
import { readLedgerJsonl } from '../src/ledger/store.ts';
import { LEDGER_FILES, LEDGER_SCHEMA, type LedgerEdit, type LedgerHoldings, type LedgerJournalEntry } from '../src/ledger/schema.ts';
import type { WashoutNight } from '../src/jobs/washout/washoutAlert.ts';
import type { BusinessAlertsResult } from '../src/jobs/exit/businessAlerts.ts';
import type { EventNight } from '../src/jobs/washout/eventCheck.ts';

const NOW = Date.parse('2026-11-06T04:40:00Z');
const AT = '2026-11-06T04:40:00.000Z';

function entry(f: Partial<JournalFields> & Pick<JournalFields, 'date' | 'source' | 'advice'>): LedgerJournalEntry {
  const m = makeJournalEntry({ ticker: 'AAA', detail: 'because', ...f } as JournalFields, AT);
  assert.ok(m.ok, m.ok ? '' : m.why);
  return m.entry;
}

/** A daily series from `from` (weekdays), close = f(i). */
function series(from: string, n: number, f: (i: number) => number): JournalSeries {
  const dates: string[] = [], closes: number[] = [];
  let d = from;
  for (let i = 0; dates.length < n; i++) {
    const w = new Date(d + 'T12:00:00Z').getUTCDay();
    if (w !== 0 && w !== 6) { dates.push(d); closes.push(f(dates.length - 1)); }
    d = new Date(Date.parse(d + 'T12:00:00Z') + 86_400_000).toISOString().slice(0, 10);
  }
  return { dates, closes };
}

describe('advice journal: the line', () => {
  test('makeJournalEntry checks every field; the id is day:source:subject:advice', () => {
    const e = entry({ date: '2026-11-05', source: 'claudeChat', ticker: 'pltr', advice: 'buy', detail: '  buy part   now ', priceAtAdvice: 154.99 });
    assert.equal(e.id, '2026-11-05:claudeChat:PLTR:BUY');
    assert.deepEqual([e.schema, e.ticker, e.advice, e.detail, e.priceAtAdvice, e.qqqAtAdvice, e.horizon, e.at], [LEDGER_SCHEMA, 'PLTR', 'BUY', 'buy part now', 154.99, null, '', AT]);
    const opt = entry({ date: '2026-11-07', source: 'exit', ticker: 'MSTR', advice: 'REVIEW', refs: { holding: 'MSTR call $100 2027-06-17' } });
    assert.equal(opt.id, '2026-11-07:exit:MSTR_call_$100_2027-06-17:REVIEW');
    assert.equal(entry({ date: '2026-11-07', source: 'marketShock', ticker: '-', advice: 'BUY_POINT' }).ticker, null);
    const bad = (f: Partial<JournalFields>): string => { const m = makeJournalEntry({ date: '2026-11-05', source: 'claudeChat', ticker: 'AAA', advice: 'BUY', detail: 'x', ...f } as JournalFields); return m.ok ? 'ok' : m.why; };
    assert.match(bad({ date: '2026-02-30' }), /not a day/);
    assert.match(bad({ source: 'gossip' }), /source must be one of/);
    assert.match(bad({ advice: 'SELL' }), /advice must be one of/);
    assert.match(bad({ ticker: 'not a ticker' }), /not a ticker/);
    assert.match(bad({ detail: '   ' }), /detail/);
    assert.match(bad({ priceAtAdvice: -3 }), /positive/);
    assert.equal(entry({ date: '2026-11-05', source: 'claudeChat', advice: 'BUY', detail: 'x'.repeat(900) }).detail.length, 300);
  });
});

describe('advice journal: dedupe (a line when the advice first appears or changes)', () => {
  test('Exit report: EXIT / REVIEW when new or changed; HOLD only right after an EXIT / REVIEW', () => {
    const night = (date: string, advice: JournalFields['advice']): LedgerJournalEntry => entry({ date, source: 'exit', ticker: 'CLSK', advice });
    let file: LedgerJournalEntry[] = [];
    const run = (e: LedgerJournalEntry): number => { const n = selectNewEntries(file, [e]); file = [...file, ...n]; return n.length; };
    assert.equal(run(night('2026-11-02', 'HOLD')), 0, 'a first HOLD is not advice worth a line');
    assert.equal(run(night('2026-11-03', 'REVIEW')), 1);
    assert.equal(run(night('2026-11-04', 'REVIEW')), 0, 'unchanged');
    assert.equal(run(night('2026-11-05', 'HOLD')), 1, 'REVIEW -> HOLD is a change');
    assert.equal(run(night('2026-11-06', 'HOLD')), 0);
    assert.equal(run(night('2026-11-07', 'EXIT')), 1);
    assert.equal(run(night('2026-11-07', 'EXIT')), 0, 'the same id is never written twice');
    assert.deepEqual(file.map((e) => e.date + ' ' + e.advice), ['2026-11-03 REVIEW', '2026-11-05 HOLD', '2026-11-07 EXIT']);
  });
  test('two calls of one ticker are two subjects; Buy report verdict changes; ideas once per id', () => {
    const a = entry({ date: '2026-11-06', source: 'exit', ticker: 'IBIT', advice: 'REVIEW', refs: { holding: 'IBIT call $38 2027-12-17' } });
    const b = entry({ date: '2026-11-06', source: 'exit', ticker: 'IBIT', advice: 'REVIEW', refs: { holding: 'IBIT call $38 2027-06-17' } });
    assert.equal(selectNewEntries([], [a, b]).length, 2);
    const buy1 = entry({ date: '2026-11-06', source: 'buy', ticker: 'PLTR', advice: 'BUY_POINT' });
    const buy2 = entry({ date: '2026-11-07', source: 'buy', ticker: 'PLTR', advice: 'BUY_POINT' });
    const buy3 = entry({ date: '2026-11-08', source: 'buy', ticker: 'PLTR', advice: 'BUY' });
    assert.deepEqual(selectNewEntries([buy1], [buy2, buy3]).map((e) => e.id), [buy3.id]);
    const idea = entry({ date: '2026-11-06', source: 'claudeIdea', ticker: 'AMZN', advice: 'BUY' });
    assert.equal(selectNewEntries([idea], [idea]).length, 0);
    assert.equal(selectNewEntries([idea], [entry({ date: '2026-11-07', source: 'claudeIdea', ticker: 'AMZN', advice: 'BUY' })]).length, 1, 'a new idea row on another day');
  });
  test('alerts: not again for the same subject within 14 days, unless the triggers changed', () => {
    const w = (date: string, sig = 'W1'): LedgerJournalEntry => entry({ date, source: 'washout', ticker: 'MU', advice: 'BUY_POINT', refs: { sig } });
    assert.equal(selectNewEntries([w('2026-11-02')], [w('2026-11-03')]).length, 0);
    const later = new Date(Date.parse('2026-11-02T12:00:00Z') + ALERT_REPEAT_DAYS * 86_400_000).toISOString().slice(0, 10);
    assert.equal(selectNewEntries([w('2026-11-02')], [w(later)]).length, 1, '14 days later it is new again');
    const biz = (date: string, sig: string): LedgerJournalEntry => entry({ date, source: 'business', ticker: 'AAA', advice: 'ALERT', refs: { sig } });
    assert.equal(selectNewEntries([biz('2026-11-02', 'REVENUE')], [biz('2026-11-03', 'REVENUE')]).length, 0);
    assert.equal(selectNewEntries([biz('2026-11-02', 'REVENUE')], [biz('2026-11-03', 'MARGIN+REVENUE')]).length, 1, 'a new trigger is a change');
    assert.equal(selectNewEntries([], [w('2026-11-03'), w('2026-11-04')]).length, 1, 'within one batch too');
  });
});

const HOLD: LedgerHoldings = {
  schema: 1, updated: '2026-11-08',
  stocks: [
    { id: 'stock:aaa', ticker: 'AAA', kind: 'stock', qty: 30, avgCost: 10, currency: 'USD', bought: '2024-01-02', lots: [{ date: '2026-11-09', qty: 5, price: 11 }, { date: null, qty: 2, price: 9 }] },
  ],
  options: [{ id: 'o1', ticker: 'CCC', side: 'call', contracts: 1, strike: 50, expiry: '2027-01-15', avgPremium: 5, bought: '2026-11-10' }],
  closed: [{ id: 'c1', ticker: 'BBB', kind: 'stock', qty: 10, cost: 1000, proceeds: 1200, currency: 'USD', bought: '2025-01-02', sold: '2026-11-10' }],
};
const EDITS: LedgerEdit[] = [
  { schema: 1, at: '2026-11-11T15:00:00.000Z', by: 'x', kind: 'change', file: LEDGER_FILES.holdings, itemId: 's:ddd', before: { id: 's:ddd', ticker: 'DDD', qty: 10 }, after: { id: 's:ddd', ticker: 'DDD', qty: 15 } },
  { schema: 1, at: '2026-11-12T15:00:00.000Z', by: 'x', kind: 'change', file: LEDGER_FILES.holdings, itemId: 's:eee', before: { id: 's:eee', ticker: 'EEE', qty: 10 }, after: { id: 's:eee', ticker: 'EEE', qty: 4 } },
  { schema: 1, at: '2026-11-12T15:00:00.000Z', by: 'x', kind: 'change', file: LEDGER_FILES.holdings, itemId: 's:fff', before: { id: 's:fff', ticker: 'FFF', qty: 10, avgCost: 1 }, after: { id: 's:fff', ticker: 'FFF', qty: 10, avgCost: 2 } },
  { schema: 1, at: '2026-11-10T03:00:00.000Z', by: 'x', kind: 'add', file: LEDGER_FILES.holdings, itemId: 's:ggg', before: null, after: { id: 's:ggg', ticker: 'GGG', qty: 3, bought: null } },
  { schema: 1, at: '2026-11-13T15:00:00.000Z', by: 'x', kind: 'remove', file: LEDGER_FILES.holdings, itemId: 's:hhh', before: { id: 's:hhh', ticker: 'HHH', qty: 3 }, after: null },
  { schema: 1, at: '2026-11-13T15:00:00.000Z', by: 'x', kind: 'change', file: LEDGER_FILES.assets, itemId: 'a1', before: { qty: 1, ticker: 'ZZZ' }, after: { qty: 5, ticker: 'ZZZ' } },
];

describe('advice journal: acted? (ledger trades within 5 trading days)', () => {
  test('tradesOf reads dated lots, buy days, options, closed positions and the edits', () => {
    const t = tradesOf(HOLD, EDITS).map((x) => x.ticker + ' ' + x.side + ' ' + x.date + ' ' + x.from);
    assert.deepEqual(t, [
      'AAA buy 2024-01-02 bought', 'BBB buy 2025-01-02 closed', 'AAA buy 2026-11-09 lot', 'GGG buy 2026-11-09 edit:add', 'BBB sell 2026-11-10 closed', 'CCC buy 2026-11-10 bought',
      'DDD buy 2026-11-11 edit:change', 'EEE sell 2026-11-12 edit:change', 'HHH sell 2026-11-13 edit:remove',
    ], 'an add on 10 Nov 03:00 UTC is 9 Nov in New York; a cost change is no trade; an assets edit is not a holding');
  });
  test('followed / opposite / no action / waiting per advice type; the 5-day window; same day for chat only', () => {
    const tr = tradesOf(HOLD, EDITS);
    const a = (ticker: string | null, advice: JournalFields['advice'], date = '2026-11-06', source: JournalFields['source'] = 'exit', today = '2026-12-01'): string =>
      actedOf(entry({ date, source, ticker, advice }), tr, today).acted;
    assert.equal(a('AAA', 'BUY'), 'followed', 'a new dated lot on 9 Nov');
    assert.equal(a('BBB', 'EXIT'), 'followed', 'a closed position sold on 10 Nov');
    assert.equal(a('BBB', 'BUY'), 'opposite');
    assert.equal(a('DDD', 'ADD'), 'followed', 'quantity up on 11 Nov');
    assert.equal(a('EEE', 'HOLD'), 'opposite', 'quantity down on 12 Nov');
    assert.equal(a('FFF', 'HOLD'), 'followed', 'no trade: HOLD followed');
    assert.equal(a('FFF', 'WAIT'), 'followed');
    assert.equal(a('DDD', 'AVOID'), 'opposite');
    assert.equal(a('FFF', 'BUY'), 'no action');
    assert.equal(addTradingDays('2026-11-06', 5), '2026-11-13');
    assert.equal(a('HHH', 'EXIT', '2026-11-06'), 'followed', 'removed on the 5th weekday after the advice');
    assert.equal(a('HHH', 'EXIT', '2026-11-05'), 'no action', 'the 6th weekday is too late');
    assert.equal(a('CCC', 'BUY', '2026-11-10', 'exit'), 'no action', 'a report comes after the close: a trade the same day does not count');
    assert.equal(a('CCC', 'BUY', '2026-11-10', 'claudeChat'), 'followed', 'chat advice is given during the day');
    assert.equal(a('FFF', 'BUY', '2026-11-06', 'exit', '2026-11-09'), 'waiting', 'the window is still open');
    assert.equal(a('AAA', 'REVIEW'), 'traded');
    assert.equal(a('FFF', 'REVIEW'), 'no action');
    assert.equal(a(null, 'BUY_POINT', '2026-11-06', 'marketShock'), 'n/a');
  });
});

describe('advice journal: right? per advice type and horizon', () => {
  test('the rule per advice', () => {
    assert.equal(verdictOf('BUY', 10, 5, false), 'right');
    assert.equal(verdictOf('ADD', 4, 5, false), 'wrong');
    assert.equal(verdictOf('BUY_POINT', 1, 5, false), 'wrong');
    assert.equal(verdictOf('BUY_POINT', 0, 2, true), 'right', 'market buy point: QQQ rose');
    assert.equal(verdictOf('EXIT', -3, 2, false), 'right');
    assert.equal(verdictOf('AVOID', 8, 2, false), 'wrong');
    assert.equal(verdictOf('HOLD', -2, 2, false), 'right', 'trailed by 4 points: within 5');
    assert.equal(verdictOf('HOLD', -4, 2, false), 'wrong', 'trailed by 6 points');
    for (const a of ['REVIEW', 'ALERT', 'WAIT'] as const) assert.equal(verdictOf(a, 50, -50, false), 'info');
    assert.equal(edgeOf('BUY', 12, 2, false), RULE_OF_THUMB_USD * 0.1);
    assert.equal(edgeOf('EXIT', 12, 2, false), -RULE_OF_THUMB_USD * 0.1);
    assert.equal(edgeOf('HOLD', 12, 2, false), null);
  });
  test('horizons: +1w, +1m, +3m, +1y end days; pending until passed; no data without a price', () => {
    assert.deepEqual(JOURNAL_HORIZONS.map((h) => horizonEnd('2026-01-31', h)), ['2026-02-07', '2026-02-28', '2026-04-30', '2027-01-31']);
    assert.equal(addMonths('2024-02-29', 12), '2025-02-28');
    const qqq = series('2026-01-02', 300, (i) => 100 + i * 0.1);
    const stock = series('2026-01-02', 300, (i) => 50 + i * 0.2);
    const map = new Map([['QQQ', qqq], ['AAA', stock]]);
    const e = entry({ date: '2026-02-02', source: 'buy', ticker: 'AAA', advice: 'BUY' });
    const s = scoreEntry(e, (k) => map.get(k), '2026-04-01');
    assert.deepEqual(s.map((x) => x.status), ['right', 'right', 'pending', 'pending']);
    const w = s[0]!;
    assert.ok(w.stockPct! > w.qqqPct!, 'the stock beat QQQ');
    assert.equal(w.edgeUsd, Math.round(RULE_OF_THUMB_USD * (w.stockPct! - w.qqqPct!)) / 100);
    assert.deepEqual(scoreEntry(entry({ date: '2026-02-02', source: 'exit', ticker: 'AAA', advice: 'EXIT' }), (k) => map.get(k), '2026-04-01').map((x) => x.status), ['wrong', 'wrong', 'pending', 'pending']);
    assert.deepEqual(scoreEntry(entry({ date: '2026-02-02', source: 'exit', ticker: 'AAA', advice: 'REVIEW' }), (k) => map.get(k), '2026-04-01').map((x) => x.status), ['info', 'info', 'pending', 'pending']);
    assert.deepEqual(scoreEntry(entry({ date: '2026-02-02', source: 'buy', ticker: 'ZZZ', advice: 'BUY' }), (k) => map.get(k), '2026-04-01').map((x) => x.status), ['no data', 'no data', 'pending', 'pending']);
    // priceAtAdvice wins over the history's close; a horizon whose close is not in the history yet stays pending for a week.
    const given = scoreEntry(entry({ date: '2026-02-02', source: 'buy', ticker: 'AAA', advice: 'BUY', priceAtAdvice: 1000, qqqAtAdvice: 1 }), (k) => map.get(k), '2026-04-01');
    assert.deepEqual([given[0]!.status, given[0]!.stockPct! < 0, given[0]!.qqqPct! > 0], ['wrong', true, true]);
    const short = new Map([['QQQ', series('2026-01-02', 18, () => 100)], ['AAA', series('2026-01-02', 18, () => 50)]]);
    assert.equal(scoreEntry(entry({ date: '2026-01-26', source: 'buy', ticker: 'AAA', advice: 'BUY' }), (k) => short.get(k), '2026-02-03')[0]!.status, 'pending');
    assert.equal(scoreEntry(entry({ date: '2026-01-26', source: 'buy', ticker: 'AAA', advice: 'BUY' }), (k) => short.get(k), '2026-03-01')[0]!.status, 'no data');
    // a market-wide buy point is scored on QQQ alone
    assert.equal(scoreEntry(entry({ date: '2026-02-02', source: 'marketShock', ticker: null, advice: 'BUY_POINT' }), (k) => map.get(k), '2026-04-01')[0]!.status, 'right');
  });
});

// ── report grids from the real sheet builders ──────────────────────────────────────────────────────────────────────

function stock(ticker: string, stop: number, breached = false): ExitHoldingInput {
  return {
    ticker, kind: 'STOCK', position: { quantity: 10, avgCost: 100, entryDate: '2025-01-10', currentPrice: 120 },
    signals: formatStockSignals({ chandelierSinceEntry: stop, stopBreached: breached, t1: 140, t2: 160, entryDateStr: '2025-01-10' }, true),
    levels: { stopLevel: stop, stopBasis: 'SINCE_ENTRY', stopBreached: breached, thesisInvalidated: false, t1: 140, hitT1: false, t2: 160, hitT2: false },
    models: [], dataHealth: [],
  } as ExitHoldingInput;
}
async function exitGrid(): Promise<TabCell[][]> {
  const option: ExitHoldingInput = {
    ticker: 'BBB', kind: 'OPTION', position: { quantity: 2, avgCost: 3, entryDate: '2026-06-01', currentPrice: 5 },
    option: { right: 'CALL', strike: 50, expiry: '2026-12-18', daysToExpiry: 42, expiryThreshold: 30, expiryWarning: false, underlyingPrice: 48 },
    signals: formatOptionsSignals({ daysToExpiry: 42, expiryThreshold: 30, expiryWarning: false, technical: { chandelierSinceEntry: 40, t1: 60, t2: 70 } }, true, 2),
    levels: { stopLevel: 40, stopBasis: 'SINCE_ENTRY', stopBreached: false, thesisInvalidated: false, t1: 60, hitT1: false, t2: 70, hitT2: false }, models: [], dataHealth: [],
  };
  const input: ExitReportInput = { runAt: new Date(NOW), holdings: [stock('AAA', 110), stock('BBB', 130, true), option], skipped: { crypto: [], otherStock: [], blankTickerRowCount: 0 }, dataHealth: [] };
  const be = new MemoryWorkbookBackend({ Portfolio: [['x']] });
  const ss = await ReportWorkbook.open(be, ['*']);
  buildExitSheet(ss, input);
  await ss.flush();
  return be.grid(EXIT_SHEET_TAB) as TabCell[][];
}
async function buyGrid(): Promise<TabCell[][]> {
  const cand = (ticker: string, rank: number, conviction: number, action: string, low: number, high: number): BuyCandidateInput => ({
    ticker, status: 'ok', tier: 1, rank, slot: rank, buyNow: false, blocked: false, conviction, entryConfidencePct: 64, ownScore: 72, ownBand: 'own', timing: 'WAIT_PULLBACK', regime: 'TREND_UP', action,
    entryZone: { low, center: (low + high) / 2, high }, timeToEntry: null, stop: low * 0.9, rrToT1: 2, rrToT2: 3, t1: high * 1.2, t2: high * 1.4, entryLadder: { rungs: [], percents: [] },
    sizing: null, sizingText: null, models: null, comparison: null, options: null, held: null, addToPosition: false, opportunityCost: [], promotion: null, change: null,
    bitcoinGroup: false, dataHealth: [], note: null, techScore: 61,
  } as BuyCandidateInput);
  const be = new MemoryWorkbookBackend({ Portfolio: [['x']] });
  const ss = await ReportWorkbook.open(be, ['*']);
  buildBuySheet(ss, { runAt: new Date(NOW), candidates: [cand('CCC', 1, 82, '✅ BUY NOW', 48, 52), cand('DDD', 2, 70, '⏳ GREAT COMPANY — SET A BUY LIMIT', 90, 95)], seeded: false, portfolioOk: true });
  await ss.flush();
  return be.grid(BUY_SHEET_TAB, NCOLS) as TabCell[][];
}
const IDEAS: TabCell[][] = [[...CLAUDE_IDEAS_HEADER], ['2026-11-05 07:08', 'EEE', 'stock', 'BUY', '$253 - $263', '237', '280', '6-12 months', 'Top conviction, in its zone.', 'open'], ['2026-11-05 07:08', 'FFF', 'stock', 'SELL', '-', '-', '-', 'weeks', 'Trend broke.', 'open']];

const WASH = { hits: [{ ticker: 'GGG', date: '2026-11-05', held: true, read: { fired: true, sdUnder: 2.7, offHigh: 0.41, trendRising: true, bars: 300 }, fundScore: 80, line: '🟢 Washout: GGG closed 2.7 SD under its 20-day average', deduped: false }], regime: null } as unknown as WashoutNight;
const BIZ = {
  mode: 'shadow', today: '2026-11-05', market: { id: 'MARKET', state: 'TRIGGERED', text: 'VIX 36 (2026-11-05)', source: 'VIX', date: '2026-11-05' },
  holdings: [{ ticker: 'AAA', checks: [], triggered: [{ id: 'TARGET', state: 'TRIGGERED', text: 'mean target cut 25%', source: 'FMP', date: '2026-11-05' }], status: 'ALERT', historyFrom: null }, { ticker: 'BBB', checks: [], triggered: [], status: 'NONE', historyFrom: null }],
  fresh: [], telegram: [], nextState: {}, historyFrom: null,
} as unknown as BusinessAlertsResult;
const EVENT = { today: '2026-11-05', market: { subject: 'MARKET', trigger: 'QQQ -5.8% in 5 days', type: 'sector', typeText: 'sector: chips', signals: {}, verdict: 'short', sizing: 'normal $5k per stock' }, stocks: [] } as unknown as EventNight;

describe('advice journal: the Nightly step', () => {
  test('exitAdviceOf / buyAdviceOf: the reports\' words as advice', () => {
    assert.deepEqual(['EXIT', 'TRIM', 'REVIEW', 'TARGET HIT', 'HOLD', 'NO VERDICT'].map(exitAdviceOf), ['EXIT', 'EXIT', 'REVIEW', 'REVIEW', 'HOLD', null]);
    assert.equal(buyAdviceOf({ verdict: '✅ BUY NOW', verdictKey: 'BUY NOW' }), 'BUY');
    assert.equal(buyAdviceOf({ verdict: '✅ BUY NOW · you hold this: add-to-position decision', verdictKey: 'BUY NOW' }), 'ADD');
    assert.equal(buyAdviceOf({ verdict: '⏳ GREAT COMPANY — SET A BUY LIMIT', verdictKey: 'SET A BUY LIMIT' }), 'BUY_POINT');
    assert.equal(buyAdviceOf({ verdict: 'NO VERDICT', verdictKey: 'NO VERDICT' }), null);
  });
  test('journalCandidates from real report grids, the alerts and the ideas', async () => {
    const exit = parseExitReport(await exitGrid()), buy = parseBuyReport(await buyGrid(), new Map());
    const { parseIdeas } = await import('../src/dashboard/data.ts');
    const closes = new Map([['QQQ', 600], ['AAA', 120], ['BBB', 48], ['CCC', 50], ['DDD', 96], ['GGG', 10]]);
    const c = journalCandidates({ today: '2026-11-05', exit, exitDay: '2026-11-05', buy, buyDay: '2026-11-05', ideas: parseIdeas(IDEAS, new Map()), washout: WASH, event: EVENT, business: BIZ, closes }, AT);
    const ids = c.map((e) => e.id);
    for (const id of ['2026-11-05:buy:CCC:BUY', '2026-11-05:buy:DDD:BUY_POINT', '2026-11-05:washout:GGG:ADD', '2026-11-05:marketShock:MARKET:BUY_POINT', '2026-11-05:business:AAA:ALERT', '2026-11-05:eventCheck:MARKET:ALERT', '2026-11-05:claudeIdea:EEE:BUY', '2026-11-05:claudeIdea:FFF:EXIT']) assert.ok(ids.includes(id), id + ' in ' + ids.join(', '));
    assert.ok(c.some((e) => e.source === 'exit' && e.ticker === 'BBB' && !e.refs?.holding), 'the stock row of BBB');
    const opt = c.find((e) => e.source === 'exit' && e.refs?.holding);
    assert.ok(opt && opt.ticker === 'BBB' && opt.priceAtAdvice === 48, 'an option is priced on its underlying');
    assert.ok(c.every((e) => e.qqqAtAdvice === 600 || e.source === 'claudeIdea'));
    assert.ok(!c.some((e) => e.ticker === 'BBB' && e.source === 'business'), 'no trigger: no business line');
    const idea = c.find((e) => e.id === '2026-11-05:claudeIdea:EEE:BUY')!;
    assert.deepEqual([idea.horizon, idea.priceAtAdvice, idea.refs?.zone], ['6-12 months', null, '$253 - $263'], 'no close known for it tonight');
  });
  test('runJournalNight appends the new advice once; off = nothing; no folder = a warning', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
    const tabs: Record<string, TabCell[][]> = { [EXIT_SHEET_TAB]: await exitGrid(), [BUY_SHEET_TAB]: await buyGrid(), [CLAUDE_IDEAS_TAB]: IDEAS };
    const lines: string[] = [];
    const deps = {
      mode: 'shadow' as const, root, today: '2026-11-05', nowIso: AT, readTab: async (t: string) => tabs[t] ?? null, close: async (t: string) => (t === 'QQQ' ? 600 : 100),
      washout: async () => WASH, eventCheck: async () => EVENT, business: () => BIZ, info: (m: string) => lines.push(m), warn: (m: string) => lines.push('WARN ' + m),
    };
    assert.deepEqual(await runJournalNight({ ...deps, mode: 'off' }), { candidates: 0, added: 0, skipped: true });
    const none = await runJournalNight(deps);
    assert.equal(none.skipped, true);
    assert.match(lines.pop()!, /^WARN advice journal \(shadow\): no ledger folder/);
    fs.mkdirSync(path.join(root, 'ledger'));
    const first = await runJournalNight(deps);
    assert.ok(first.added >= 8 && first.added === readLedgerJsonl(root, 'journal').length, JSON.stringify(first));
    assert.match(lines.pop()!, /^advice journal: \d+ new line\(s\) of \d+ advice tonight \(/);
    const again = await runJournalNight({ ...deps, today: '2026-11-06' });
    assert.equal(again.added, 0, 'the next night with the same advice adds nothing');
    const throws = await runJournalNight({ ...deps, readTab: async () => { throw new Error('quota'); }, washout: async () => null, eventCheck: async () => null, business: () => null });
    assert.equal(throws.added, 0);
    assert.ok(lines.some((l) => /WARN advice journal: the tab .* could not be read \(quota\)/.test(l)));
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('advice journal: npm run journal-add', () => {
  test('writes one checked line to the data branch folder; a repeat or a bad line is refused', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-cli-'));
    const out: string[] = [];
    const run = (args: string[]): number => runJournalAdd(args, { env: { DATA_BRANCH_DIR: root }, now: Date.parse('2026-11-05T18:00:00Z'), out: (l) => out.push(l) });
    assert.equal(run(['claudeChat', 'MRVL', 'WAIT', "wait for Friday's", 'weekly close']), 0);
    assert.match(out.pop()!, /^appended to ledger\/journal\.jsonl .*2026-11-05 claudeChat MRVL WAIT — wait for Friday's weekly close\. Commit it to the data branch\.$/);
    assert.equal(run(['claudeChat', 'PLTR', 'BUY', 'buy part', '--price', '$154.99', '--qqq', '647.05', '--date', '2026-11-05', '--horizon', 'months', '--note', 'part now']), 0);
    assert.equal(run(['claudeChat', 'PLTR', 'BUY', 'again']), 1);
    assert.match(out.pop()!, /^refused: already in the journal \(2026-11-05:claudeChat:PLTR:BUY\)/);
    assert.equal(run(['claudeChat', '-', 'WAIT', 'the market']), 0);
    for (const bad of [['claudeChat', 'PLTR'], ['nope', 'PLTR', 'BUY', 'x'], ['claudeChat', 'PLTR', 'SELL', 'x'], ['claudeChat', 'PLTR', 'BUY', 'x', '--price', 'abc'], ['claudeChat', 'PLTR', 'BUY', 'x', '--bogus', '1'], ['claudeChat', 'PLTR', 'BUY', 'x', '--date']]) {
      assert.equal(run(bad), 1, bad.join(' '));
      assert.match(out.pop()!, /^refused: /);
    }
    const lines = readLedgerJsonl(root, 'journal');
    assert.deepEqual(lines.map((e) => [e.id, e.priceAtAdvice, e.qqqAtAdvice, e.horizon, e.refs?.note ?? null]), [
      ['2026-11-05:claudeChat:MRVL:WAIT', null, null, '', null], ['2026-11-05:claudeChat:PLTR:BUY', 154.99, 647.05, 'months', 'part now'], ['2026-11-05:claudeChat:MARKET:WAIT', null, null, '', null],
    ]);
    assert.equal(typeof parseJournalArgs([]), 'string');
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('advice journal: the dashboard section', () => {
  const qqq = series('2026-01-02', 260, (i) => 600 + i);
  const S = new Map<string, JournalSeries>([['QQQ', qqq], ['AAA', series('2026-01-02', 260, (i) => 100 + i * 0.5)], ['BBB', series('2026-01-02', 260, (i) => 50 - i * 0.05)]]);
  const ENTRIES: LedgerJournalEntry[] = [
    entry({ date: '2026-02-02', source: 'buy', ticker: 'AAA', advice: 'BUY_POINT', detail: 'set a buy limit', priceAtAdvice: 110.5, qqqAtAdvice: 621 }),
    entry({ date: '2026-02-02', source: 'exit', ticker: 'BBB', advice: 'EXIT', detail: 'the weekly trend broke' }),
    entry({ date: '2026-02-03', source: 'exit', ticker: 'BBB', advice: 'REVIEW', detail: 'call', refs: { holding: 'BBB call $50 2026-12-18' } }),
    entry({ date: '2026-02-04', source: 'marketShock', ticker: null, advice: 'BUY_POINT', detail: 'VIX 36' }),
    entry({ date: '2026-02-05', source: 'claudeChat', ticker: 'ZZZ', advice: 'WAIT', detail: 'no signal' }),
    entry({ date: '2026-03-20', source: 'claudeIdea', ticker: 'AAA', advice: 'AVOID', detail: 'later' }),
  ];
  const H: LedgerHoldings = { schema: 1, updated: '2026-03-01', stocks: [{ id: 's:aaa', ticker: 'AAA', kind: 'stock', qty: 10, avgCost: 100, currency: 'USD', bought: null, lots: [{ date: '2026-02-04', qty: 10, price: 116 }] }], options: [], closed: [] };
  test('buildJournal: rows newest first, acted, scores, the scorecard per source; no NaN anywhere', () => {
    const j = buildJournal({ entries: [...ENTRIES, { junk: true } as never, { ...ENTRIES[0]!, date: 'nope' } as never], holdings: H, edits: [], series: S, latest: new Map([['AAA', 999]]), today: '2026-04-01' });
    assert.equal(j.rows.length, 6, 'a bad line is left out');
    assert.equal(j.rows[0]!.date, '2026-03-20');
    const aaa = j.rows.find((r) => r.source === 'buy')!;
    assert.equal(aaa.acted, 'followed');
    assert.deepEqual(aaa.trade, { side: 'buy', date: '2026-02-04' });
    assert.deepEqual(aaa.scores.map((s) => s.status), ['right', 'right', 'pending', 'pending']);
    assert.equal(aaa.yoursUsd['1w'], aaa.scores[0]!.edgeUsd);
    const bbb = j.rows.find((r) => r.source === 'exit' && r.advice === 'EXIT')!;
    assert.deepEqual([bbb.acted, bbb.scores[0]!.status, bbb.yoursUsd['1w']], ['no action', 'right', 0]);
    assert.equal(j.rows.find((r) => r.advice === 'REVIEW')!.subject, 'BBB call $50 2026-12-18');
    assert.equal(j.rows.find((r) => r.source === 'marketShock')!.acted, 'n/a');
    assert.deepEqual(j.noHistory, ['ZZZ']);
    const all = j.scorecard[0]!;
    assert.equal(all.source, 'all');
    assert.equal(all.count, 6);
    const w = all.horizons.find((h) => h.id === '1w')!;
    assert.deepEqual([w.right, w.wrong], [3, 1], 'BUY_POINT beat QQQ, EXIT trailed it, the market rose; the AVOID beat QQQ (wrong)');
    assert.equal(w.hitPct, 75);
    assert.equal(w.ifFollowedUsd, Math.round((aaa.scores[0]!.edgeUsd! + bbb.scores[0]!.edgeUsd!) * 100) / 100);
    assert.equal(w.yoursUsd, aaa.scores[0]!.edgeUsd);
    assert.deepEqual(j.scorecard.map((c) => c.source), ['all', 'exit', 'buy', 'marketShock', 'claudeIdea', 'claudeChat']);
    const text = JSON.stringify(j);
    assert.doesNotMatch(text, /NaN|Infinity/);
    assert.match(j.assumption, /\$5,000 per advice/);
    assert.deepEqual(journalSeriesKeys(ENTRIES), ['QQQ', 'AAA', 'BBB', 'ZZZ']);
    assert.equal(validEntries([null, 3, 'x']).length, 0);
  });
  test('buildDashboard: the journal section with the ledger; left out (named) without one; one bad section does not stop the others', () => {
    const CTX: DashboardContext = { nowMs: Date.parse('2026-04-01T15:00:00Z'), taxRate: 0.25, list: [], labels: { list: 'l', holdCore: 'h', holdList: 'h' }, timeZone: 'America/New_York' };
    const d = buildDashboard({ ledger: { holdings: H, journal: ENTRIES, edits: [] }, journalPrices: S }, CTX);
    assert.ok(d.journal && d.journal.rows.length === 6 && !d.missing.includes('journal'));
    assert.doesNotMatch(JSON.stringify(d.journal), /NaN|Infinity/);
    assert.ok(buildDashboard({ ledger: { holdings: H, journal: [] } }, CTX).missing.includes('journal'));
    const broken = buildDashboard({ ledger: { holdings: H, journal: ENTRIES, edits: 'not a list' as never }, journalPrices: S }, CTX);
    assert.ok(broken.networth, 'the net worth screen still builds');
  });
  test('the page: a Journal view rendered on its own, no external script, the CSP unchanged', () => {
    const dir = path.join(import.meta.dirname, '..', 'dashboard');
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.ok(html.includes('id="view-journal"') && html.includes("['journal', 'Journal']") && html.includes("['journal', renderJournal, '#view-journal']"));
    assert.ok(html.includes("mkChart('journal'"), 'the chart goes through the guarded chart maker');
    assert.doesNotMatch(html, /<script[^>]+src="https?:/i, 'no external script');
    const csp = fs.readFileSync(path.join(dir, '_headers'), 'utf8').split('\n').find((l) => l.includes('Content-Security-Policy'))!.trim();
    assert.equal(csp, "Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  });
});
