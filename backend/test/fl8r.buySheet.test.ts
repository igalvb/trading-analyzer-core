/** FL-8r: the single combined, tiered Buy report sheet. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ReportWorkbook, MemoryWorkbookBackend, SheetsWorkbookBackend, type TabChange } from '../src/sheets/reportSheet.ts';
import { assertNoReportLeaks } from '../src/reports/messages/leakScan.ts';
import { reasonLine } from '../src/reports/messages/catalog.ts';
import { buildBuySheet, writeBuyAiSummaries, readModels, readComparison, readOptions } from '../src/reports/buySheet/buySheet.ts';
import { BUY_SHEET_TAB, BUY_SHEET_TAB_COLOR, AI_ANCHOR, AI_PLACEHOLDER, NCOLS, T, expiryText } from '../src/reports/buySheet/text.ts';
import type { BuyAiSummariesInput, BuyCandidateInput, BuyReportInput } from '../src/reports/buySheet/types.ts';

const NOW = new Date('2026-10-24T20:00:00Z');
const TAB = BUY_SHEET_TAB;

class CountingBackend extends MemoryWorkbookBackend {
  applyCount = 0;
  async applyTab(tab: string, change: TabChange): Promise<void> { this.applyCount++; return super.applyTab(tab, change); }
}

const MODELS = (['ENGINE', 'SCHABACKER', 'EDWARDS_MAGEE', 'BROKER_COURSE', 'TURTLE'] as const)
  .map((m, i) => ({ model: m, stance: i === 4 ? 'BEARISH' : 'BULLISH', score: 60 + i }));
const CMP = { agreeCount: 4, totalCount: 5, majority: 'BULLISH', dissenters: ['TURTLE'] };
const CLEAN_OPP = 'You do not hold this stock, and it does not overlap with a group you are already heavily exposed to.';

function cand(o: Partial<BuyCandidateInput> & { ticker: string }): BuyCandidateInput {
  return {
    status: 'ok', tier: 1, rank: 1, slot: 1, buyNow: false, blocked: false, conviction: 75, entryConfidencePct: 64, ownScore: 72, ownBand: 'own',
    timing: 'WAIT_PULLBACK', regime: 'TREND_UP', action: '⏳ GREAT COMPANY — SET A BUY LIMIT',
    entryZone: { low: 98, center: 101, high: 104 }, timeToEntry: 'about 3 to 5 days', stop: 92.5, rrToT1: 2.4, rrToT2: 3.8, t1: 120, t2: 135,
    entryLadder: { rungs: [{ rung: 1, price: 104 }, { rung: 2, price: 98 }], percents: [50, 50] },
    sizing: { firstUnitRiskPctOfAccount: 0.5, n: 2.1, stopLevel: 96.8 },
    sizingText: 'A first position unit risks about 0.5% of the account if the initial stop is hit.',
    models: MODELS, comparison: CMP, options: null, held: null, addToPosition: false, opportunityCost: [CLEAN_OPP], promotion: null, change: null,
    bitcoinGroup: false, dataHealth: ['Data quality', 'No data issues.'], note: null, techScore: 61,
    ...o,
  } as BuyCandidateInput;
}

const PICKS = {
  leaps: { found: true, contract: { strike: 150, expUnix: Date.UTC(2027, 0, 15) / 1000, delta: 0.7, iv: 0.42 } },
  shortTerm: { found: false, reason: 'no contract passed the filters.' },
};

function candidates(): BuyCandidateInput[] {
  return [
    cand({ ticker: 'NVDA', rank: 1, slot: 1, buyNow: true, timing: 'BUY_NOW', conviction: 88, action: '✅ BUY NOW', options: PICKS, held: { stockShares: 10, hasOptions: false }, addToPosition: true,
      opportunityCost: ['You already hold this stock, so the question is whether to add to your position, not whether to open a new one.'],
      change: { from: '⏳ GREAT COMPANY — SET A BUY LIMIT', to: '✅ BUY NOW', fromConviction: 71 } }),
    cand({ ticker: 'AMD', rank: 2, slot: 2, conviction: 72, rrToT1: 0.8, rrToT1AtSpot: 0.9,
      options: { leaps: null, shortTerm: { found: true, contract: { strike: 120, expUnix: Date.UTC(2026, 11, 18) / 1000, delta: 0.45, iv: 0.5 } } } }),
    cand({ ticker: 'GBTC', tier: 2, rank: 3, slot: 3, conviction: 60, bitcoinGroup: true, stop: 52, entryZone: { low: 55, center: 57, high: 60 }, promotion: 'Would be actionable if it pulled back to $60.00 or lower.', rrToT1: 1.2 }),
    cand({ ticker: 'IBIT', tier: 2, rank: 4, slot: 3, conviction: 58, bitcoinGroup: true, stop: 35, entryZone: { low: 36, center: 38, high: 40 }, promotion: 'Would be actionable if it pulled back to $40.00 or lower.' }),
    cand({ ticker: 'MQZC', tier: 2, rank: 5, slot: 4, conviction: 50, promotion: 'Would be actionable if it pulled back to $104.00 or lower, or if conviction rose to 70.' }),
    cand({ ticker: 'SQZB', tier: 3, rank: 6, slot: 5, blocked: true, conviction: 0, ownScore: 12, ownBand: 'weak', timing: 'AVOID', action: '🚫 BLOCKED — fundamentals too weak (OWN 12/100), regardless of chart' }),
    cand({ ticker: 'PLTR', tier: 3, rank: 7, slot: 6, status: 'failed', conviction: null, ownScore: null, ownBand: null, timing: null, regime: null, action: null, entryZone: { low: null, center: null, high: null },
      stop: null, rrToT1: null, rrToT2: null, t1: null, t2: null, entryLadder: { rungs: [], percents: [] }, sizing: null, sizingText: null, models: null, comparison: null,
      opportunityCost: [], note: 'PLTR: The data provider did not respond.', techScore: null }),
  ];
}

function input(o: Partial<BuyReportInput> = {}): BuyReportInput {
  return {
    runAt: NOW, candidates: candidates(), seeded: false, portfolioOk: true,
    bitcoin: { members: ['GBTC', 'IBIT'], substitutesText: T.btcSubstitutes('GBTC, IBIT') },
    ...o,
  };
}

async function nightly(inp: BuyReportInput = input(), be: CountingBackend = new CountingBackend({ Portfolio: [['x']] })) {
  const ss = await ReportWorkbook.open(be, ['*']);
  const logs: string[] = [];
  const res = buildBuySheet(ss, inp, { log: (m) => logs.push(m) });
  await ss.flush();
  return { be, ss, res, logs };
}
const grid = (be: MemoryWorkbookBackend): string[][] => be.grid(TAB, NCOLS).map((r) => r.map((v) => String(v ?? '')));
const colA = (be: MemoryWorkbookBackend): string[] => grid(be).map((r) => r[0] as string);
const allText = (be: MemoryWorkbookBackend): string[] => grid(be).flat();
/** Rows of a section: from the row whose col A equals `start` to the next blank row. */
function section(be: MemoryWorkbookBackend, start: (t: string) => boolean): string[][] {
  const g = grid(be);
  const s = g.findIndex((r) => start(r[0] as string));
  assert.ok(s >= 0, 'section start not found');
  let e = s;
  while (e < g.length && (g[e] as string[]).some((c) => c !== '')) e++;
  return g.slice(s, e);
}

describe('build', () => {
  test('R-1 exactly one new tab, green, one applyTab, one setValues', async () => {
    const be = new CountingBackend({ Portfolio: [['x']] });
    const before = (await be.listTabs()).map((t) => t.name);
    const { ss } = await nightly(input(), be);
    const after = (await be.listTabs()).map((t) => t.name);
    assert.deepEqual(after, [...before, TAB]);
    assert.equal(be.applyCount, 1);
    assert.equal(be.tabs.get(TAB)!.tabColor, BUY_SHEET_TAB_COLOR);
    assert.notEqual(be.tabs.get(TAB)!.tabColor, '#d50000');
    assert.equal(ss.getSheetByName(TAB)!.calls.filter((c) => c[0] === 'range:setValues').length, 1);
  });

  test('R-2 every written cell is leak-free; never "cache", never tax, no raw error labels', async () => {
    const { be } = await nightly();
    assertNoReportLeaks(be.grid(TAB));
    for (const t of allText(be)) {
      assert.ok(!/cache/i.test(t), t);
      assert.ok(!/\btax/i.test(t), t);
      assert.ok(!/ERROR:?/.test(t), t);
      assert.ok(!/undefined|NaN/.test(t), t);
    }
  });

  test('R-3 the ranking lists every candidate in rank order, none dropped, even from shuffled input', async () => {
    const shuffled = candidates().reverse();
    const { be, res } = await nightly(input({ candidates: shuffled }));
    assert.deepEqual(res.order, ['NVDA', 'AMD', 'GBTC', 'IBIT', 'MQZC', 'SQZB', 'PLTR']);
    const rk = section(be, (t) => t.startsWith('FULL RANKING'));
    const body = rk.slice(3); // band, note, header
    assert.deepEqual(body.map((r) => r[0]), ['#1 NVDA', '#2 AMD', '#3 GBTC', '#3 IBIT', '#4 MQZC', '#5 SQZB', '#6 PLTR']);
    assert.deepEqual(rk[2]!.slice(0, 5), ['Rank and ticker', 'Conviction', 'Fundamentals', 'Timing', 'Entry zone']);
    assert.equal(rk[2]![7], 'Updated');
  });

  test('R-4 legacy columns: conviction, OWN score, timing score, entry zone, verdict, and the legacy Updated time', async () => {
    const { be } = await nightly();
    const rk = section(be, (t) => t.startsWith('FULL RANKING'));
    const nv = rk.find((r) => r[0] === '#1 NVDA')!;
    assert.equal(nv[1], '88/100');
    assert.equal(nv[2], '72 · Strong');
    assert.equal(nv[3], 'Buy now · 61/100');
    assert.equal(nv[4], '$98.00 – $104.00');
    assert.ok(nv[5]!.startsWith('✅ BUY NOW'));
    assert.equal(nv[7], new Date(NOW).toLocaleTimeString('en-US', { timeZone: 'America/New_York' }));
    const pl = rk.find((r) => r[0] === '#6 PLTR')!;
    assert.equal(pl[1], '—');
    assert.ok(pl[5]!.startsWith('No verdict. PLTR: The data provider did not respond.'));
  });

  test('R-5 every ranking row jumps to a row that holds that ticker', async () => {
    const { be, res } = await nightly();
    const rk = section(be, (t) => t.startsWith('FULL RANKING')).slice(3);
    const col = colA(be);
    assert.equal(rk.length, res.order.length);
    rk.forEach((r, i) => {
      const n = Number(String(r[8]).replace('Go to row ', ''));
      assert.ok(n > 0, 'row ' + i);
      assert.ok(col[n - 1]!.includes(res.order[i]!), res.order[i] + ' -> ' + col[n - 1]);
    });
  });

  test('R-6 the shortlist holds only Tier 1; tiers are split by the pipeline tier', async () => {
    const { be, res } = await nightly();
    const sl = section(be, (t) => t.startsWith('⭐ THE SHORTLIST'));
    const labels = sl.slice(2).map((r) => r[0]);
    assert.deepEqual(labels, ['#1 NVDA', '#2 AMD']);
    assert.deepEqual(res.tiers, { 1: ['NVDA', 'AMD'], 2: ['GBTC', 'IBIT', 'MQZC'], 3: ['SQZB', 'PLTR'] });
  });

  test('R-7 "nothing actionable" is a first-class statement; an empty watchlist says so too', async () => {
    const none = candidates().filter((c) => c.tier !== 1);
    const a = await nightly(input({ candidates: none }));
    const sl = section(a.be, (t) => t.startsWith('⭐ THE SHORTLIST'));
    assert.equal(sl[1]![0], T.nothingActionable);
    assert.ok(colA(a.be).includes(T.tier1None));
    const b = await nightly(input({ candidates: [], bitcoin: null }));
    assert.equal(section(b.be, (t) => t.startsWith('⭐ THE SHORTLIST'))[1]![0], T.noCandidates);
    const c = await nightly(input({ candidates: none, emptyText: 'Custom nothing sentence.' }));
    assert.equal(section(c.be, (t) => t.startsWith('⭐ THE SHORTLIST'))[1]![0], 'Custom nothing sentence.');
  });

  test('R-8 Tier 2 candidates each state a concrete promotion condition; a missing one is logged and replaced', async () => {
    const { be } = await nightly();
    const text = allText(be);
    assert.ok(text.includes('Would be actionable if it pulled back to $60.00 or lower.'));
    assert.ok(text.includes('Would be actionable if it pulled back to $40.00 or lower.'));
    assert.ok(text.some((t) => t.startsWith('Would be actionable if it pulled back to $104.00')));
    const cs = candidates(); cs[4] = cand({ ticker: 'MQZC', tier: 2, rank: 5, slot: 4, conviction: 50, promotion: null });
    const r = await nightly(input({ candidates: cs }));
    assert.ok(allText(r.be).includes(T.promotionFallback));
    assert.ok(r.logs.some((l) => l.includes('MQZC') && l.includes('no promotion condition')));
  });

  test('R-9 Bitcoin group: one shared rank, substitutes statement, per-ticker dollar levels, fund-data honesty', async () => {
    const { be } = await nightly();
    const col = colA(be);
    assert.ok(col.includes('#3 GBTC') && col.includes('#3 IBIT'));
    const bt = section(be, (t) => t.startsWith('₿ BITCOIN COMPLEX'));
    assert.ok(bt.some((r) => r[0] === T.btcSubstitutes('GBTC, IBIT')));
    const g = bt.find((r) => r[0] === 'GBTC')!; const i = bt.find((r) => r[0] === 'IBIT')!;
    assert.equal(g[4], '$52.00'); assert.equal(i[4], '$35.00');
    assert.notEqual(g[3], i[3]);
    assert.ok(bt.some((r) => r[0] === T.btcNoDifferentiators));
    assert.ok(bt.some((r) => r[0] === T.btcNoSharedThesis));
    const rk = section(be, (t) => t.startsWith('FULL RANKING'));
    assert.ok(rk.find((r) => r[0] === '#3 IBIT')![5]!.endsWith(T.tagGroup));
  });

  test('R-10 Bitcoin members in Tier 1: disclosure in each member section, own stop in each, differentiators when supplied', async () => {
    const cs = candidates();
    cs[2] = cand({ ticker: 'GBTC', tier: 1, rank: 3, slot: 3, conviction: 74, bitcoinGroup: true, stop: 52 });
    cs[3] = cand({ ticker: 'IBIT', tier: 1, rank: 4, slot: 3, conviction: 73, bitcoinGroup: true, stop: 35 });
    const inp = input({ candidates: cs, bitcoin: { members: ['GBTC', 'IBIT'], differentiators: [{ ticker: 'GBTC', expenseRatioPct: 1.5, avgDailyVolume: 1200000, premiumDiscountPct: -2.1 }, { ticker: 'IBIT', expenseRatioPct: 0.25, avgDailyVolume: 30000000, premiumDiscountPct: 0 }] } });
    const { be } = await nightly(inp);
    const col = colA(be);
    for (const [tk, stop] of [['GBTC', '$52.00'], ['IBIT', '$35.00']] as const) {
      const start = col.indexOf('═══ ' + tk + ' ═══');
      assert.ok(start >= 0, tk);
      const end = grid(be).findIndex((r, k) => k > start && r.every((c) => c === ''));
      const sec = grid(be).slice(start, end).flat();
      assert.ok(sec.includes(T.btcDisclosure('GBTC, IBIT')), tk + ' disclosure');
      assert.ok(sec.some((t) => t.startsWith(stop)), tk + ' stop');
    }
    const bt = section(be, (t) => t.startsWith('₿ BITCOIN COMPLEX'));
    assert.ok(bt.some((r) => r[0] === 'GBTC' && r[1] === '1.5%'));
    assert.ok(bt.some((r) => r[0] === 'IBIT' && r[3] === '0.0%'));
    assert.ok(!bt.some((r) => r[0] === T.btcNoDifferentiators));
  });

  test('R-11 a candidate you already hold is flagged as an add-to-position decision (table, shortlist, section)', async () => {
    const { be } = await nightly();
    const rk = section(be, (t) => t.startsWith('FULL RANKING'));
    assert.ok(rk.find((r) => r[0] === '#1 NVDA')![5]!.includes('add-to-position'));
    assert.ok(!rk.find((r) => r[0] === '#2 AMD')![5]!.includes('add-to-position'));
    assert.ok(allText(be).includes(T.heldBanner));
    const sl = section(be, (t) => t.startsWith('⭐ THE SHORTLIST'));
    assert.ok(sl.find((r) => r[0] === '#1 NVDA')![1]!.includes('add-to-position'));
  });

  test('R-12 changed since last run lists verdict flips and states the baseline; none case is plain', async () => {
    const { be } = await nightly();
    const ch = section(be, (t) => t.startsWith('⚠ CHANGED SINCE LAST RUN'));
    const row = ch.find((r) => r[0] === 'NVDA')!;
    assert.equal(row[1], T.changeLine('⏳ GREAT COMPANY — SET A BUY LIMIT', '✅ BUY NOW', '71', '88'));
    assert.ok(ch.some((r) => r[0] === T.changeBaselineNote));
    const cs = candidates().map((c) => ({ ...c, change: null }));
    const n = await nightly(input({ candidates: cs }));
    assert.ok(colA(n.be).includes(T.noChanges));
  });

  test('R-13 methodology footer carries the unvalidated-floor and tier caveats; override replaces the default', async () => {
    const { be } = await nightly();
    const f = section(be, (t) => t === 'HOW THIS REPORT WAS BUILT').map((r) => r[0] as string);
    assert.ok(f.some((t) => t.includes('The floor of 20 is a reasoned default and has not been validated against results.')));
    assert.ok(f.some((t) => t.includes('Tier 1 = can be bought now, or conviction 70 or higher.') && t.includes('not been validated')));
    assert.ok(f.includes(T.longOnly));
    const o = await nightly(input({ methodologyCaveats: ['Custom caveat sentence.'], tiers: { tier1Min: 80, tier2Min: 50 } }));
    const f2 = section(o.be, (t) => t === 'HOW THIS REPORT WAS BUILT').map((r) => r[0] as string);
    assert.ok(f2.includes('Custom caveat sentence.'));
    assert.ok(!f2.some((t) => t.includes('The floor of 20')));
    assert.ok(f2.some((t) => t.startsWith('Tier 1 = can be bought now, or conviction 80 or higher. Tier 2 = conviction 50 to 79.')));
  });

  test('R-14 a failed candidate degrades only its own entry; a broken section degrades only itself', async () => {
    const cs = candidates(); cs[0] = { ...cs[0]!, opportunityCost: 5 as never };
    const { be, res, logs } = await nightly(input({ candidates: cs }));
    assert.deepEqual(res.degraded.map((d) => d.name), ['NVDA']);
    assert.ok(logs.some((l) => l.includes('NVDA') && l.includes('failed')));
    const col = colA(be);
    const start = col.indexOf('═══ NVDA ═══');
    assert.ok(start >= 0);
    assert.ok(grid(be)[start + 1]!.join(' ').includes('No verdict. ' + reasonLine('SECTION_UNAVAILABLE')));
    assert.ok(col.includes('═══ AMD ═══'), 'the next candidate is intact');
    assert.ok(col.includes('#1 NVDA'), 'NVDA is still in the ranking');
    assertNoReportLeaks(be.grid(TAB));
  });

  test('R-15 leak defence: a pipeline string with a URL or key is replaced and logged, never written', async () => {
    const cs = candidates(); cs[1] = { ...cs[1]!, action: 'Buy now. See https://evil.example/x?apikey=SECRET123456' };
    const { be, logs } = await nightly(input({ candidates: cs }));
    for (const t of allText(be)) { assert.ok(!t.includes('evil.example'), t); assert.ok(!t.includes('SECRET'), t); }
    assert.ok(logs.some((l) => l.includes('leak scan') && l.includes('AMD')));
    assertNoReportLeaks(be.grid(TAB));
  });

  test('R-16 options (Tier 1): calls only, dates are the UTC expiry day, short-term pick warns when the chart says wait; legacy flag restores toDateString', async () => {
    const { be } = await nightly();
    const text = allText(be);
    assert.ok(text.some((t) => t.startsWith('$150 call, expires Jan 15, 2027') && t.includes('delta 0.70') && t.includes('implied volatility 42.0%')));
    assert.ok(text.includes(T.optionNotFound('no contract passed the filters.')));
    assert.ok(text.some((t) => t.startsWith('$120 call, expires Dec 18, 2026') && t.includes(T.optionAhead)));
    assert.ok(!text.some((t) => /\bput\b/i.test(t) && !t.includes('no short or put ideas')), 'long-only: no put wording except the long-only disclaimer');
    const ss = await ReportWorkbook.open(new MemoryWorkbookBackend({ P: [['x']] }), ['*']);
    buildBuySheet(ss, input(), { legacyExpiryText: true });
    const legacy = ss.getSheetByName(TAB)!.grid(NCOLS).flat().map((v) => String(v ?? ''));
    assert.ok(legacy.some((t) => t.includes('expires ' + new Date(Date.UTC(2027, 0, 15)).toDateString())));
    assert.equal(expiryText(Date.UTC(2027, 0, 15) / 1000, false), 'Jan 15, 2027');
    assert.equal(expiryText('x', false), null);
  });

  test('R-17 reward-to-risk wording follows the legacy gate (marginal under 1.0, thin under 1.5); spot R:R shown when present', async () => {
    const { be } = await nightly();
    const amd = section(be, (t) => t === '═══ AMD ═══');
    assert.ok(amd.some((r) => r[0] === 'Reward to risk, target 1' && r[1] === '0.80 to 1 — marginal structure'));
    assert.ok(amd.some((r) => r[0] === "Reward to risk at today's price" && r[1]!.startsWith('0.90 to 1 (versus 0.80 to 1 at the $101.00 ladder entry)')));
    const nvda = section(be, (t) => t === '═══ NVDA ═══');
    assert.ok(nvda.some((r) => r[0] === 'Reward to risk, target 1' && r[1] === '2.40 to 1'));
    const gbtc = section(be, (t) => t.startsWith('─── GBTC'));
    assert.ok(gbtc.some((r) => r[1]!.includes('target 1: 1.20 to 1 — thin, size accordingly')));
  });

  test('R-18 Tier 1 has all seven parts; sizing is relative only (no share counts, no dollars of risk)', async () => {
    const { be } = await nightly();
    const nvda = section(be, (t) => t === '═══ NVDA ═══');
    const heads = nvda.map((r) => r[0]).filter((t) => /^[①②③④⑤⑥⑦]/.test(t!));
    assert.deepEqual(heads, ['① VERDICT', '② ENTRY PLAN', '③ RISK', '④ THE 5 MODELS — independent reads', '⑤ FUNDAMENTALS AND POSITIONING', '⑥ OPPORTUNITY COST — against what you already hold', '⑦ DATA HEALTH']);
    const size = nvda.find((r) => r[0] === 'Position size')!;
    assert.equal(size[1], 'A first position unit risks about 0.5% of the account if the initial stop is hit.');
    assert.ok(!allText(be).some((t) => /\bshares?\b/i.test(t) && /\d/.test(t)));
    assert.ok(nvda.some((r) => r[0] === '' && r[1] === T.ladderRung(2, '$98.00', 50)));
    assert.ok(nvda.some((r) => r[0] === T.modelsAgreement(4, 5, 'Leans bullish', 'Turtle')));
  });

  test('R-19 a weak-fundamentals BUY_NOW gets the chart-only caution (presentation only)', async () => {
    const cs = candidates(); cs[0] = { ...cs[0]!, ownBand: 'weak', ownScore: 30 };
    const { be } = await nightly(input({ candidates: cs }));
    assert.ok(allText(be).includes(T.chartOnlyCaution));
  });

  test('R-20 the Sheets calls are few and asserted: 1 addSheet, 1 value batch, 1 format batch, no clear', async () => {
    const calls = { tabIds: 0, batchGet: 0, batchUpdate: 0, batchClear: 0, formatBatch: 0 };
    const ids: Record<string, number> = { Portfolio: 1 };
    let next = 10;
    const api = {
      async tabIds() { calls.tabIds++; return { ok: true, value: { ...ids } }; },
      async batchGet() { calls.batchGet++; return { ok: true, value: [[]] }; },
      async batchUpdate(_c: unknown, u: readonly unknown[]) { calls.batchUpdate++; return { ok: true, value: u.length }; },
      async batchClear() { calls.batchClear++; return { ok: true, value: 0 }; },
      async formatBatch(_c: unknown, reqs: readonly { addSheet?: { properties: { title: string } } }[]) {
        calls.formatBatch++;
        for (const r of reqs) if (r.addSheet) ids[r.addSheet.properties.title] = next++;
        return { ok: true, value: reqs.length };
      },
    };
    const backend = new SheetsWorkbookBackend({} as never, api as never, 'America/New_York');
    const ss = await ReportWorkbook.open(backend, ['*']);
    buildBuySheet(ss, input());
    await ss.flush();
    assert.equal(calls.batchUpdate, 1);
    assert.equal(calls.formatBatch, 2);
    assert.equal(calls.batchClear, 0);
  });
});

describe('parsers', () => {
  test('R-21 models / comparison / options parsers drop bad shapes instead of printing them', () => {
    assert.deepEqual(readModels('junk'), []);
    assert.deepEqual(readModels([{ model: 'NOPE', stance: 'BULLISH' }, { model: 'TURTLE', stance: 'BEARISH', score: 'x' }]), [{ model: 'TURTLE', stance: 'BEARISH', score: null }]);
    assert.equal(readComparison({ agreeCount: 'x' }), null);
    assert.deepEqual(readComparison({ agreeCount: 3, totalCount: 5, majority: 'NEUTRAL', dissenters: ['TURTLE', 'BAD'] }), { agreeCount: 3, totalCount: 5, majority: 'NEUTRAL', dissenters: ['TURTLE'] });
    assert.equal(readOptions(7), null);
  });
  test('R-22 a candidate with unreadable models/comparison renders plain "did not run" sentences', async () => {
    const cs = candidates(); cs[0] = { ...cs[0]!, models: { weird: true }, comparison: 'x' };
    const { be } = await nightly(input({ candidates: cs }));
    assert.ok(allText(be).some((t) => t.startsWith('Model reads:') && t.includes('did not run')));
  });
});

const AI: BuyAiSummariesInput = {
  ranAt: NOW, geminiUsed: true, opusMode: 'REVIEW', effort: 'high',
  candidates: [{ ticker: 'NVDA', tier: 1 }, { ticker: 'AMD', tier: 1 }, { ticker: 'MQZC', tier: 2 }, { ticker: 'SQZB', tier: 3 }],
  entries: [
    { ticker: 'NVDA', gemini: 'Gemini says LONGMARKER buy.\nSee https://x.example/a', opus: 'Opus agrees.' },
    { ticker: 'AMD', gemini: 'AMD narrative.', opus: null },
  ],
};

describe('AI summaries', () => {
  test('R-23 nightly leaves the placeholder; AI replaces it in place, states scope, drops leaking lines, creates no tab', async () => {
    const a = await nightly();
    const col0 = colA(a.be);
    assert.ok(col0.includes(AI_ANCHOR));
    assert.equal(col0[col0.indexOf(AI_ANCHOR) + 1], AI_PLACEHOLDER);
    const tabsBefore = (await a.be.listTabs()).map((t) => t.name);
    const ss = await ReportWorkbook.open(a.be, ['*']);
    const logs: string[] = [];
    const r = writeBuyAiSummaries(ss, AI, { log: (m) => logs.push(m) });
    await ss.flush();
    assert.equal(r.written, true);
    assert.equal(r.droppedLines, 1);
    assert.deepEqual((await a.be.listTabs()).map((t) => t.name), tabsBefore);
    const text = allText(a.be);
    assert.ok(text.includes('Gemini says LONGMARKER buy.'));
    assert.ok(!text.some((t) => t.includes('x.example')));
    assert.ok(text.includes(T.aiDropped));
    assert.ok(text.includes(T.aiScope(2, 4, 'NVDA, AMD', 'MQZC (Tier 2), SQZB (Tier 3)')));
    assert.ok(text.includes('▸ NVDA (Tier 1)'));
    assert.ok(!text.includes(AI_PLACEHOLDER));
    assert.ok(logs.some((l) => l.includes('dropped')));
    assertNoReportLeaks(a.be.grid(TAB));
  });

  test('R-24 idempotent: a second AI run gives the identical sheet; the next nightly build clears it back to the placeholder', async () => {
    const a = await nightly();
    const run = async () => { const ss = await ReportWorkbook.open(a.be, ['*']); writeBuyAiSummaries(ss, AI); await ss.flush(); };
    await run();
    const g1 = grid(a.be);
    await run();
    assert.deepEqual(grid(a.be), g1);
    const ss2 = await ReportWorkbook.open(a.be, ['*']);
    buildBuySheet(ss2, input());
    await ss2.flush();
    const text = allText(a.be);
    assert.ok(text.includes(AI_PLACEHOLDER));
    assert.ok(!text.some((t) => t.includes('LONGMARKER')));
  });

  test('R-25 a shorter AI section after a longer one leaves no stale text; every AI row is merged full width', async () => {
    const a = await nightly();
    const ss = await ReportWorkbook.open(a.be, ['*']);
    writeBuyAiSummaries(ss, AI);
    await ss.flush();
    const ss2 = await ReportWorkbook.open(a.be, ['*']);
    const r = writeBuyAiSummaries(ss2, { ...AI, entries: [{ ticker: 'NVDA', gemini: 'Short.', opus: 'Brief.' }] });
    assert.equal(r.written, true);
    const sh = ss2.getSheetByName(TAB)!;
    const merges = sh.calls.filter((c) => c[0] === 'range:merge' && (c[1] as number) > r.anchorRow!);
    assert.ok(merges.length > 0);
    for (const m of merges) { assert.equal(m[2], 1); assert.equal(m[4], NCOLS); }
    await ss2.flush();
    assert.ok(!allText(a.be).some((t) => t.includes('AMD narrative.')));
  });

  test('R-26 AI run never creates the tab, and refuses a missing, duplicate or unreadable anchor with a plain sentence', async () => {
    const be = new CountingBackend({ Portfolio: [['x']] });
    const ss = await ReportWorkbook.open(be, ['*']);
    const r = writeBuyAiSummaries(ss, AI);
    assert.equal(r.written, false);
    assert.equal(r.message, T.aiRunNightlyFirst);
    assert.deepEqual((await be.listTabs()).map((t) => t.name), ['Portfolio']);
    const dup = new CountingBackend({ [TAB]: [['a'], [AI_ANCHOR], [AI_ANCHOR]] });
    const r2 = writeBuyAiSummaries(await ReportWorkbook.open(dup, ['*']), AI);
    assert.equal(r2.message, T.aiAnchorDuplicate);
    const none = new CountingBackend({ [TAB]: [['a'], ['b']] });
    const r3 = writeBuyAiSummaries(await ReportWorkbook.open(none, ['*']), AI);
    assert.equal(r3.message, T.aiAnchorMissing);
    const unloaded = await ReportWorkbook.open(new CountingBackend({ [TAB]: [[AI_ANCHOR]] }), []);
    const r4 = writeBuyAiSummaries(unloaded, AI);
    assert.equal(r4.written, false);
    assertNoReportLeaks([[r.message, r2.message, r3.message, r4.message]]);
  });

  test('R-27 AI scope states plainly when everything was covered and when Opus is off', async () => {
    const a = await nightly();
    const ss = await ReportWorkbook.open(a.be, ['*']);
    writeBuyAiSummaries(ss, { ...AI, opusMode: 'OFF', candidates: [{ ticker: 'NVDA', tier: 1 }, { ticker: 'AMD', tier: 1 }] });
    await ss.flush();
    const text = allText(a.be);
    assert.ok(text.includes(T.aiScope(2, 2, 'NVDA, AMD', '')));
    assert.ok(text.some((t) => t.startsWith('Opus review: ') && t.includes('did not run')));
  });
});

describe('options sentiment (shadow A-8, part B): display lines only', () => {
  test('the options-reads section and the market line appear; tiers, order and every other row are unchanged', async () => {
    const base = await nightly(input());
    const shadow = 'NVDA — options read 2026-10-30, not yet applied: CONFIRM, +8 conviction if applied (70 → 78).';
    const market = 'Market options (2026-10-30, display only, feeds no score): SPY P/C 1.40, skew 6.1 pts, term normal, IV 30d 15% vs RV20 11% (hedging normal).';
    const withLines = await nightly(input({ optionsReads: { lines: [shadow], missing: ['AMD'], applied: false }, marketOptionsLine: market }));
    assert.deepEqual(withLines.res.order, base.res.order);
    assert.deepEqual(withLines.res.tiers, base.res.tiers);
    const text = allText(withLines.be);
    assert.ok(text.includes(shadow));
    assert.ok(text.includes(market));
    assert.ok(text.includes(T.optionsReadsHeader(false)));
    assert.ok(text.includes(T.optionsReadsMissing('AMD')));
    const extra = new Set([shadow, market, T.optionsReadsHeader(false), T.optionsReadsNote, T.optionsReadsMissing('AMD')]);
    const noRows = (t: string): string => t.replace(/\brow \d+/g, 'row N');
    assert.deepEqual(text.filter((t) => t !== '' && !extra.has(t)).map(noRows), allText(base.be).filter((t) => t !== '').map(noRows), 'nothing else changed (row numbers shift)');
  });
  test('no lines: no section (the report is byte for byte the same)', async () => {
    const a = await nightly(input()), b = await nightly(input({ optionsReads: { lines: [], missing: ['AMD'], applied: false }, marketOptionsLine: null }));
    assert.deepEqual(grid(b.be), grid(a.be));
  });
});
