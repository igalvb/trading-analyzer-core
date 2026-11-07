/**
 * The event check (owner 2026-11-07, jobs/washout/eventCheck.ts): the triggers, the fall type (market / sector /
 * company), the long-fall signals (yes / no / not known), the verdict and sizing rules on fixtures, the AI sentence
 * label, silence on quiet nights (no extra fetch), and profile alerts.eventCheck (off = nothing).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_RULES, BROAD_SECTORS, VERDICT_TEXT, AI_LABEL,
  changeOver, marketTrigger, stockTrigger, classifyMarket, classifyStock, cutsOf, marketCutsOf, creditOf, ratesOf, grindingOf,
  bounceOf, weeklyCloses, verdictOf, sizingOf, eventNight, eventSuffix, eventBlockLines, aiSentence, withAi, gatherEventNight,
  eventCheckOn, sectorEtfOf, type Series, type EventStock, type EventNightInput, type Sig,
} from '../src/jobs/washout/eventCheck.ts';
import type { FundPoint } from '../src/jobs/exit/businessAlerts.ts';
import type { WashoutCandidate } from '../src/jobs/washout/washoutAlert.ts';
import { validateProfile } from '../src/profile/schema.ts';
import { EXAMPLE_PROFILE_INPUT } from '../src/profile/example.ts';

const TODAY = '2026-11-06'; // a Friday

/** `n` weekdays ending on `last`, oldest first. */
function weekdaysTo(last: string, n: number): string[] {
  const out: string[] = []; let t = Date.parse(last + 'T00:00:00Z');
  while (out.length < n) { const d = new Date(t); if (d.getUTCDay() % 6 !== 0) out.unshift(d.toISOString().slice(0, 10)); t -= 86_400_000; }
  return out;
}
/** A flat-ish series of `n` bars, then the given daily changes at the end. */
function ser(tail: readonly number[] = [], n = 300, last = TODAY): Series {
  const c: number[] = [];
  for (let i = 0; i < n - tail.length; i++) c.push(100 * 1.0005 ** i + (i % 2 ? 0.05 : -0.05));
  for (const r of tail) c.push(c[c.length - 1]! * (1 + r));
  return { dates: weekdaysTo(last, c.length), closes: c };
}
const pt = (date: string, analystTarget: number | null, ratingScore: number | null = null): FundPoint =>
  ({ date, revenueGrowth: null, profitMargin: null, analystTarget, ratingScore, rating: null, source: 'test' });
const sig = (v: boolean | null): Sig => ({ v, text: String(v) });

describe('triggers', () => {
  test('market: -5% in 5 days or -3% in 1 day (inclusive); smaller falls and a stale bar do not', () => {
    assert.equal(marketTrigger('QQQ', ser([-0.0105, -0.0105, -0.0105, -0.0105, -0.0105]), TODAY)?.window, 5);
    assert.equal(marketTrigger('QQQ', ser([-0.03]), TODAY)?.window, 1);
    assert.equal(marketTrigger('QQQ', ser([-0.029]), TODAY), null);
    assert.equal(marketTrigger('QQQ', ser([-0.01, -0.01, -0.01, -0.01, -0.005]), TODAY), null);
    assert.equal(marketTrigger('QQQ', ser([-0.05], 300, '2026-10-20'), TODAY), null, 'not tonight\'s close');
    assert.equal(marketTrigger('QQQ', null, TODAY), null);
  });
  test('stock: -8% in a day, or a W1 washout', () => {
    assert.equal(stockTrigger('NVDA', ser([-0.08]), TODAY)?.window, 1);
    assert.equal(stockTrigger('NVDA', ser([-0.079]), TODAY), null);
    const wash = ser([-0.05, -0.05, -0.05, -0.05, -0.05, -0.05]);
    const t = stockTrigger('NVDA', wash, TODAY);
    assert.ok(t && t.washout && t.window === 5);
  });
  test('changeOver', () => {
    assert.equal(changeOver({ dates: ['a', 'b'], closes: [100, 90] }, 1)!.toFixed(2), '-0.10');
    assert.equal(changeOver({ dates: ['a'], closes: [100] }, 1), null);
  });
});

describe('type', () => {
  const rets = (r: number, over: Record<string, number | null> = {}): Record<string, number | null> => ({ ...Object.fromEntries(BROAD_SECTORS.map((e) => [e, r])), ...over });
  test('market-wide: QQQ and most sectors down', () => {
    const m = classifyMarket('QQQ', -0.06, rets(-0.04, { XLU: 0.01, XLP: 0.005 }), 5);
    assert.equal(m.type, 'market'); assert.match(m.text, /7 of 9 sectors down/);
  });
  test('sector: chips 2x QQQ while most sectors hold', () => {
    const m = classifyMarket('QQQ', -0.05, rets(0.0, { SMH: -0.11, SOXX: -0.12 }), 5);
    assert.equal(m.type, 'sector'); assert.match(m.text, /chips \(SOXX/);
    assert.equal(classifyMarket('QQQ', null, rets(-0.04), 5).type, null);
  });
  test('stock: company-specific (2x its sector), sector (sector 2x QQQ), market (in line)', () => {
    assert.equal(classifyStock('NVDA', -0.10, 'SMH', -0.02, 'QQQ', -0.01).type, 'company');
    assert.equal(classifyStock('NVDA', -0.10, 'SMH', 0.01, 'QQQ', -0.01).type, 'company', 'the sector rose');
    assert.equal(classifyStock('NVDA', -0.10, 'SMH', -0.07, 'QQQ', -0.03).type, 'sector');
    assert.equal(classifyStock('NVDA', -0.10, 'SMH', -0.07, 'QQQ', -0.05).type, 'market');
    assert.equal(classifyStock('XYZ', -0.10, null, null, 'QQQ', -0.02).type, 'company');
    assert.equal(classifyStock('XYZ', -0.10, null, null, 'QQQ', -0.06).type, 'market');
    assert.equal(classifyStock('XYZ', -0.10, null, null, 'QQQ', null).type, null);
  });
  test('sector ETF of a stock: chips -> SMH, else the analysis\' sector ETF', () => {
    assert.equal(sectorEtfOf('Semiconductors', 'XLK'), 'SMH');
    assert.equal(sectorEtfOf('Software', 'XLK'), 'XLK');
    assert.equal(sectorEtfOf(null, undefined), null);
  });
});

describe('signals', () => {
  test('cut forecasts: target -10%+ or rating 0.5+ worse vs 30 days ago; no history = not known', () => {
    const hist = [pt('2026-09-20', 200, 1.8), pt('2026-10-01', 200, 1.8)];
    assert.equal(cutsOf(hist, pt(TODAY, 180, 1.8), TODAY).v, true);
    assert.equal(cutsOf(hist, pt(TODAY, 181, 1.8), TODAY).v, false);
    assert.equal(cutsOf(hist, pt(TODAY, 200, 2.3), TODAY).v, true);
    assert.equal(cutsOf([pt('2026-10-20', 200)], pt(TODAY, 100), TODAY).v, null, 'history newer than 30 days');
    assert.equal(cutsOf(hist, null, TODAY).v, null);
  });
  test('market cut forecasts: half or more of the known stocks', () => {
    assert.equal(marketCutsOf([true, false, null]).v, true);
    assert.equal(marketCutsOf([true, false, false]).v, false);
    assert.equal(marketCutsOf([null, null]).v, null);
  });
  test('credit stress: HYG / IEF ratio -3% in 20 days; missing = not known', () => {
    const safe = ser([]), hyBad = ser(new Array(20).fill(-0.002)), hyOk = ser([]);
    assert.equal(creditOf(hyBad, safe).v, true);
    assert.equal(creditOf(hyOk, safe).v, false);
    assert.equal(creditOf(null, safe).v, null);
  });
  test('rates: TLT -5% in 20 days or the 10y +0.40 points; none = not known', () => {
    assert.equal(ratesOf(ser(new Array(20).fill(-0.003)), null).v, true);
    assert.equal(ratesOf(ser([]), [4.0, 4.1, 4.2]).v, false);
    assert.equal(ratesOf(null, [4.0, 4.2, 4.45]).v, true);
    assert.equal(ratesOf(null, null).v, null);
  });
  test('grinding: 5 lower weekly closes in a row; a bounce off the 5-day low', () => {
    const grind = ser(new Array(30).fill(-0.004));
    assert.ok(weeklyCloses(grind).length >= 6);
    assert.equal(grindingOf(grind).v, true);
    assert.equal(grindingOf(ser([-0.12])).v, false);
    assert.equal(grindingOf({ dates: weekdaysTo(TODAY, 10), closes: new Array(10).fill(1) }).v, null);
    assert.equal(bounceOf(ser([-0.10, 0.05])), true);
    assert.equal(bounceOf(ser([-0.10])), false);
  });
});

describe('verdict and sizing (the owner\'s rules)', () => {
  const s = (cuts: boolean | null, credit: boolean | null, rates: boolean | null, grinding: boolean | null) => ({ cuts: sig(cuts), credit: sig(credit), rates: sig(rates), grinding: sig(grinding) });
  test('long-type signs = cut forecasts + credit stress; months = rates / grinding / one of them; short otherwise', () => {
    assert.equal(verdictOf(s(true, true, false, false)), 'long');
    assert.equal(verdictOf(s(false, false, true, false)), 'months');
    assert.equal(verdictOf(s(false, false, false, true)), 'months');
    assert.equal(verdictOf(s(true, false, false, false)), 'months');
    assert.equal(verdictOf(s(false, false, false, false)), 'short');
    assert.equal(verdictOf(s(null, null, null, null)), 'short');
    assert.equal(VERDICT_TEXT.long, 'long-type signs (cut forecasts + credit stress)');
  });
  test('no loan on long-type signs; big loan only on a short black swan with strong washouts and the long signs known absent', () => {
    assert.match(sizingOf('long', s(true, true, false, false), true, true), /no loan/);
    assert.match(sizingOf('months', s(false, false, true, false), true, true), /normal \$5k per stock; no big loan/);
    assert.match(sizingOf('short', s(false, false, false, false), true, true), /big-loan case/);
    assert.doesNotMatch(sizingOf('short', s(false, false, false, false), false, true), /big-loan case/);
    assert.doesNotMatch(sizingOf('short', s(false, false, false, false), true, false), /big-loan case/);
    assert.match(sizingOf('short', s(null, false, false, false), true, true), /not ruled out/);
  });
});

/** A night: the index, all broad sectors, the chip ETFs, credit and rates calm; stocks as given. */
function night(o: Partial<EventNightInput> & { idx?: Series } = {}): EventNightInput {
  const sectors: Record<string, Series | null> = {};
  for (const e of [...BROAD_SECTORS, 'SMH', 'SOXX']) sectors[e] = ser([]);
  return {
    today: TODAY, index: { ticker: 'QQQ', series: o.idx ?? ser([]) }, sectors: { ...sectors, ...(o.sectors ?? {}) },
    hy: ser([]), safe: ser([]), tlt: ser([]), dgs10: [4.1, 4.1], vix: 18, stocks: o.stocks ?? [], ...o,
  };
}
const stock = (ticker: string, s: Series, o: Partial<EventStock> = {}): EventStock => ({ ticker, held: true, series: s, fundScore: 80, sectorEtf: 'SMH', history: [], latest: null, ...o });

describe('the night', () => {
  test('quiet night: null (no block, no suffix)', () => {
    assert.equal(eventNight(night({ stocks: [stock('NVDA', ser([0.01]))] })), null);
    assert.deepEqual(eventBlockLines(null), []);
  });
  test('market-wide panic drop with a calm credit / rates backdrop: likely short; a black swan with a strong washout = the big-loan case', () => {
    const crash = [-0.03, -0.03, -0.03, -0.02, -0.02];
    const sectors: Record<string, Series> = {};
    for (const e of BROAD_SECTORS) sectors[e] = ser(crash);
    const hist = [pt('2026-09-01', 100)];
    const wash = ser([-0.05, -0.05, -0.05, -0.05, -0.05, -0.05]);
    const n = eventNight(night({ idx: ser(crash), sectors, stocks: [stock('NVDA', wash, { history: hist, latest: pt(TODAY, 100) })] }))!;
    assert.equal(n.market!.type, 'market');
    assert.equal(n.market!.verdict, 'short');
    assert.match(n.market!.sizing, /big-loan case/);
    assert.equal(n.stocks.length, 1);
    const suffix = eventSuffix(n.stocks[0]!);
    assert.match(suffix, /^⚡ Event check: /);
    assert.match(suffix, /likely short \(sell-the-news \/ panic\)/);
    const block = eventBlockLines(n, new Set(['NVDA']));
    assert.equal(block.length, 3, 'market lines only: the washout stock is shown next to its washout line');
    assert.match(block[0]!, /^Market: QQQ −1[0-9]\.\d% in 5 days/);
    assert.equal(eventBlockLines(n).length, 4);
  });
  test('cut forecasts + credit stress: long-type signs, no loan', () => {
    const drop = ser([-0.035]);
    const hyBad = ser([...new Array(19).fill(-0.002), -0.01]);
    const st = stock('NVDA', ser([-0.09]), { history: [pt('2026-09-01', 200)], latest: pt(TODAY, 150) });
    const n = eventNight(night({ idx: drop, hy: hyBad, stocks: [st] }))!;
    assert.equal(n.market!.signals.cuts.v, true);
    assert.equal(n.market!.signals.credit.v, true);
    assert.equal(n.market!.verdict, 'long');
    assert.match(n.market!.sizing, /no loan/);
    assert.equal(n.stocks[0]!.type, 'company', 'NVDA -9% vs a flat SMH');
    assert.equal(n.stocks[0]!.verdict, 'long');
  });
  test('rates rising: likely months (policy / rates)', () => {
    const n = eventNight(night({ idx: ser([-0.031]), tlt: ser(new Array(20).fill(-0.003)) }))!;
    assert.equal(n.market!.signals.rates.v, true);
    assert.equal(n.market!.verdict, 'months');
    assert.match(eventBlockLines(n)[2]!, /^Verdict: likely months \(policy \/ rates\)\. Sizing: normal \$5k per stock; no big loan/);
  });
  test('missing data is "not known", never "no"', () => {
    const n = eventNight(night({ idx: ser([-0.04]), hy: null, tlt: null, dgs10: null }))!;
    assert.equal(n.market!.signals.credit.v, null);
    assert.equal(n.market!.signals.rates.v, null);
    assert.equal(n.market!.signals.cuts.v, null);
    assert.match(n.market!.sizing, /not ruled out/);
  });
});

describe('the AI sentence (Gemini, labelled; omitted without a key)', () => {
  test('one sentence, labelled "AI, unverified"; no ask = unchanged; a failed ask = no line', async () => {
    assert.equal(aiSentence('Chip export curbs announced on 2026-11-05. More text here.'), AI_LABEL + ' Chip export curbs announced on 2026-11-05.');
    assert.equal(aiSentence('  '), null);
    const n = eventNight(night({ idx: ser([-0.04]) }))!;
    assert.equal(await withAi(n, null, () => {}), n);
    const prompts: string[] = [];
    const a = await withAi(n, async (p) => { prompts.push(p); return 'Tariff news on 2026-11-05.'; }, () => {});
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /ONE sentence/);
    assert.equal(a.market!.ai, AI_LABEL + ' Tariff news on 2026-11-05.');
    assert.ok(eventBlockLines(a).includes(AI_LABEL + ' Tariff news on 2026-11-05.'));
    const f = await withAi(n, async () => { throw new Error('down'); }, () => {});
    assert.equal(f.market!.ai, undefined);
  });
});

describe('gathering: quiet nights fetch nothing extra', () => {
  test('a quiet night reads only the index and the candidates, and returns null', async () => {
    const asked: string[] = [];
    const cand: WashoutCandidate = { ticker: 'NVDA', held: true, ...ser([0.01]), fundScore: 80 };
    const deps = {
      today: TODAY, indexTicker: 'QQQ', candidates: async () => [cand],
      chart: async (t: string) => { asked.push(t); return ser([]); },
      rawChart: async (t: string) => { asked.push('raw:' + t); return ser([]); },
      sectorEtf: async () => { asked.push('sector'); return 'SMH'; },
      latest: async () => { asked.push('latest'); return null; },
      history: async () => { asked.push('history'); return null; },
      dgs10: async () => { asked.push('dgs10'); return null; },
      ai: async () => { asked.push('ai'); return 'x'; },
    };
    assert.equal(await gatherEventNight(deps, () => {}), null);
    assert.deepEqual(asked, ['QQQ']);
    // A sharp fall: the rest is read, HYG / IEF raw (no price tab).
    asked.length = 0;
    const n = await gatherEventNight({ ...deps, chart: async (t: string) => { asked.push(t); return t === 'QQQ' ? ser([-0.04]) : ser([]); } }, () => {});
    assert.ok(n && n.market);
    assert.ok(asked.includes('raw:HYG') && asked.includes('raw:IEF') && asked.includes('TLT') && asked.includes('ai'));
    assert.equal(asked.filter((x) => x === 'ai').length, 1);
  });
});

describe('profile alerts.eventCheck', () => {
  test('default off; on / off accepted; anything else refused', () => {
    const def = validateProfile(EXAMPLE_PROFILE_INPUT);
    assert.ok(def.ok);
    if (def.ok) { assert.equal(def.profile.alerts.eventCheck, 'off'); assert.equal(eventCheckOn(def.profile), false); }
    const on = validateProfile({ ...EXAMPLE_PROFILE_INPUT, alerts: { eventCheck: 'on' } });
    assert.ok(on.ok);
    if (on.ok) { assert.equal(eventCheckOn(on.profile), true); assert.equal(on.profile.alerts.washout, 'off'); }
    assert.equal(validateProfile({ ...EXAMPLE_PROFILE_INPUT, alerts: { eventCheck: 'yes' } }).ok, false);
  });
  test('the rules stay in one place', () => {
    assert.equal(EVENT_RULES.marketFall5d, -0.05);
    assert.equal(EVENT_RULES.marketFall1d, -0.03);
    assert.equal(EVENT_RULES.stockFall1d, -0.08);
    assert.equal(EVENT_RULES.ratio, 2);
  });
});
