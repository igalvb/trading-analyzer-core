/**
 * Synthetic provider responses for FL-2 -- FMP (/stable/), Alpha Vantage
 * (OVERVIEW) and Finnhub (metric, profile2, recommendation, peers) --
 * generated deterministically per ticker from a seeded PRNG.
 *
 * SYNTHETIC: the field names are the ones legacy reads; values and shapes
 * are invented. No fundamentals fixtures exist in legacy/historical_data.
 * Real recordings are still needed (see the FL-2 handback).
 */

import { scrubUrl, type RecordedExchange } from '../src/net/http.ts';

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export type Endpoint =
  | 'av' | 'fh.metric' | 'fh.profile2' | 'fh.recommendation' | 'fh.peers'
  | 'fmp.profile' | 'fmp.ratios' | 'fmp.metrics' | 'fmp.growth' | 'fmp.target' | 'fmp.rating'
  | 'fmp.earnings' | 'fmp.insider' | 'fmp.treasury';

export const ENDPOINTS: readonly Endpoint[] = [
  'av', 'fh.metric', 'fh.profile2', 'fh.recommendation', 'fh.peers',
  'fmp.profile', 'fmp.ratios', 'fmp.metrics', 'fmp.growth', 'fmp.target', 'fmp.rating',
  'fmp.earnings', 'fmp.insider', 'fmp.treasury',
];

/** The URL legacy builds for each endpoint (key value irrelevant: replay matches scrubbed URLs). */
export function endpointUrl(ep: Endpoint, ticker: string): string {
  const e = encodeURIComponent(ticker);
  const fmp = 'https://financialmodelingprep.com/stable/';
  const fh = 'https://finnhub.io/api/v1/stock/';
  switch (ep) {
    case 'av': return 'https://www.alphavantage.co/query?function=OVERVIEW&symbol=' + e + '&apikey=K';
    case 'fh.metric': return fh + 'metric?symbol=' + e + '&metric=all&token=K';
    case 'fh.profile2': return fh + 'profile2?symbol=' + e + '&token=K';
    case 'fh.recommendation': return fh + 'recommendation?symbol=' + e + '&token=K';
    case 'fh.peers': return fh + 'peers?symbol=' + e + '&token=K';
    case 'fmp.profile': return fmp + 'profile?symbol=' + ticker + '&apikey=K';
    case 'fmp.ratios': return fmp + 'ratios-ttm?symbol=' + ticker + '&apikey=K';
    case 'fmp.metrics': return fmp + 'key-metrics-ttm?symbol=' + ticker + '&apikey=K';
    case 'fmp.growth': return fmp + 'financial-growth?symbol=' + ticker + '&period=annual&limit=1&apikey=K';
    case 'fmp.target': return fmp + 'price-target-consensus?symbol=' + ticker + '&apikey=K';
    case 'fmp.rating': return fmp + 'ratings-snapshot?symbol=' + ticker + '&apikey=K';
    case 'fmp.earnings': return fmp + 'earnings?symbol=' + ticker + '&apikey=K';
    case 'fmp.insider': return fmp + 'insider-trading/search?symbol=' + ticker + '&page=0&limit=50&apikey=K';
    case 'fmp.treasury': return fmp + 'treasury-rates?apikey=K';
  }
}

/** A recorded reply. */
export interface Reply {
  readonly status: number;
  readonly body: string;
}

export const ok = (v: unknown): Reply => ({ status: 200, body: JSON.stringify(v) });
export const raw = (status: number, body: string): Reply => ({ status, body });

const round = (x: number, d = 4): number => Math.round(x * 10 ** d) / 10 ** d;

/** A Finnhub metric series: per key, newest point first, sometimes thin, null-holed or with an outlier. */
export function makeSeries(r: () => number, opts: { size?: number; scale?: Record<string, number> } = {}): Record<string, unknown> {
  const keys = ['salesPerShare', 'netMargin', 'grossMargin', 'fcfMargin', 'evRevenueTTM', 'cashPerShareTTM', 'fcfPerShareTTM'];
  const base: Record<string, number> = {
    salesPerShare: 5 + r() * 40, netMargin: -0.4 + r() * 0.7, grossMargin: 0.2 + r() * 0.6, fcfMargin: -0.3 + r() * 0.6,
    evRevenueTTM: 0.5 + r() * 30, cashPerShareTTM: r() * 20, fcfPerShareTTM: -3 + r() * 6, ...(opts.scale ?? {}),
  };
  const quarterly: Record<string, unknown> = {};
  const annual: Record<string, unknown> = {};
  for (const k of keys) {
    const n = opts.size ?? Math.floor(r() * 13);
    const drift = (r() - 0.5) * 0.2 * Math.abs(base[k] || 1);
    const pts: Array<{ period: string; v: number | null }> = [];
    for (let i = 0; i < n; i++) {
      let v: number | null = round(base[k] - drift * i + (r() - 0.5) * 0.05 * Math.abs(base[k] || 1));
      if (r() < 0.06) v = null;
      if (r() < 0.04) v = round((v ?? 1) * -8);
      const y = 2026 - Math.floor(i / 4);
      const q = ['12-31', '09-30', '06-30', '03-31'][i % 4];
      pts.push({ period: y + '-' + q, v });
    }
    if (r() < 0.8) quarterly[k] = pts;
    if (r() < 0.6) annual[k] = pts.filter((_, i) => i % 4 === 0);
  }
  return { quarterly, annual };
}

export interface GenOptions {
  /** Relative disagreement between providers (0 = identical values). */
  readonly noise?: number;
  /** Encode values as strings, 'None', '-', '' and zeros where providers do. */
  readonly odd?: boolean;
  readonly peers?: readonly unknown[];
  readonly now: number;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Good bodies for every endpoint of one ticker. */
export function goodBodies(ticker: string, o: GenOptions): Record<Endpoint, Reply> {
  const r = rng(seedOf(ticker + JSON.stringify(o.noise ?? 0.3) + (o.odd ? 'odd' : '')));
  const noise = o.noise ?? 0.3;
  const jit = (x: number): number => round(x * (1 + (r() - 0.5) * 2 * noise), 6);
  const odd = (v: number | null, kind: 'av' | 'fmp' | 'fh'): unknown => {
    if (!o.odd || v == null) return v;
    const p = r();
    if (kind === 'av') return p < 0.2 ? 'None' : p < 0.3 ? '-' : p < 0.35 ? '' : p < 0.4 ? 'NaN' : p < 0.45 ? '0' : String(v);
    if (kind === 'fmp') return p < 0.2 ? String(v) : p < 0.3 ? '' : p < 0.4 ? 0 : p < 0.45 ? 'abc' : v;
    return p < 0.2 ? String(v) : p < 0.3 ? 0 : p < 0.35 ? 'x' : v;
  };
  const sectors = ['Technology', 'Financial Services', 'Healthcare', 'Energy', 'Consumer Cyclical', 'Communication Services'];
  const t = {
    price: 5 + r() * 500, beta: 0.3 + r() * 2.2, mc: 1e9 + r() * 2.5e12, pe: -30 + r() * 120, fpe: 5 + r() * 60, peg: -1 + r() * 4,
    pb: 0.5 + r() * 20, pm: -0.4 + r() * 0.8, gm: 0.1 + r() * 0.7, roe: -0.4 + r() * 0.9, roa: -0.2 + r() * 0.4, rg: -0.3 + r() * 1.1,
    eg: -0.6 + r() * 1.5, div: r() < 0.4 ? 0 : r() * 3, sector: sectors[Math.floor(r() * sectors.length)], float: 5e6 + r() * 5e9,
    sb: Math.floor(r() * 15), b: Math.floor(r() * 20), h: Math.floor(r() * 15), s: Math.floor(r() * 5), ss: Math.floor(r() * 3),
  };
  const target = t.price * (0.7 + r() * 0.9);
  const now = o.now;
  const day = 86_400_000;
  const nyToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(now));
  const earnings = [
    { date: isoDay(now + 130 * day), epsActual: null, epsEstimated: round(r() * 3), revenueActual: null, revenueEstimated: round(r() * 1e10) },
    { date: isoDay(now + 40 * day), epsActual: null, epsEstimated: round(r() * 3), revenueActual: null, revenueEstimated: round(r() * 1e10) },
    { date: nyToday, epsActual: null, epsEstimated: 1.1, revenueActual: null, revenueEstimated: 5e9 },
    { date: isoDay(now - 30 * day), epsActual: round(r() * 3), epsEstimated: round(r() * 3), revenueActual: round(r() * 1e10), revenueEstimated: round(r() * 1e10) },
    { date: isoDay(now - 120 * day), epsActual: '1.20', epsEstimated: round(r() * 3), revenueActual: round(r() * 1e10), revenueEstimated: null },
    { date: '', epsActual: 1 },
    { date: 'not-a-date', epsActual: 1 },
    { date: isoDay(now - 300 * day), epsActual: round(r() * 3), epsEstimated: round(r() * 3), revenueActual: round(r() * 1e10), revenueEstimated: round(r() * 1e10) },
  ];
  const insider = Array.from({ length: 12 }, () => {
    const p = r();
    return { symbol: ticker, acquistionOrDisposition: p < 0.45 ? 'A' : p < 0.9 ? 'D' : '', securitiesTransacted: r() < 0.1 ? 'n/a' : Math.floor(r() * 50000) };
  });
  const peers = o.peers ?? [ticker, 'PEERA', 'PEERB', ticker.toLowerCase(), 42, 'PEERC', 'PEERD', 'PEERE', 'PEERF'];
  const fhMetric: Record<string, unknown> = {
    forwardPE: odd(jit(t.fpe), 'fh'), peTTM: odd(jit(t.pe), 'fh'), pegTTM: odd(jit(t.peg), 'fh'),
    [r() < 0.5 ? 'pbQuarterly' : 'pb']: odd(jit(t.pb), 'fh'),
    netProfitMarginTTM: odd(jit(t.pm * 100), 'fh'), grossMarginTTM: odd(jit(t.gm * 100), 'fh'), roeTTM: odd(jit(t.roe * 100), 'fh'), roaTTM: odd(jit(t.roa * 100), 'fh'),
    [r() < 0.6 ? 'revenueGrowthTTMYoy' : 'revenueGrowthQuarterlyYoy']: odd(jit(t.rg * 100), 'fh'),
    [r() < 0.6 ? 'epsGrowthTTMYoy' : 'epsGrowthQuarterlyYoy']: odd(jit(t.eg * 100), 'fh'),
    beta: odd(jit(t.beta), 'fh'), dividendPerShareTTM: odd(t.div, 'fh'), currentDividendPerShareTTM: r() < 0.5 ? jit(t.div + 0.01) : null,
  };
  return {
    'av': ok({
      Symbol: ticker, Name: ticker + ' Inc', ForwardPE: odd(jit(t.fpe), 'av') ?? 'None', PERatio: odd(jit(t.pe), 'av'), PEGRatio: odd(jit(t.peg), 'av'),
      PriceToBookRatio: odd(jit(t.pb), 'av'), ProfitMargin: odd(jit(t.pm), 'av'), ReturnOnEquityTTM: odd(jit(t.roe), 'av'), ReturnOnAssetsTTM: odd(jit(t.roa), 'av'),
      QuarterlyRevenueGrowthYOY: odd(jit(t.rg), 'av'), QuarterlyEarningsGrowthYOY: odd(jit(t.eg), 'av'), Beta: odd(jit(t.beta), 'av'),
      MarketCapitalization: String(Math.round(t.mc)), SharesFloat: String(Math.round(t.float)), DividendPerShare: odd(t.div, 'av'),
      Sector: r() < 0.15 ? 'None' : t.sector.toUpperCase(), Industry: r() < 0.15 ? 'None' : 'SEMICONDUCTORS & RELATED DEVICES',
      AnalystTargetPrice: odd(jit(target), 'av'), AnalystRatingStrongBuy: String(t.sb), AnalystRatingBuy: String(t.b), AnalystRatingHold: String(t.h),
      AnalystRatingSell: String(t.s), AnalystRatingStrongSell: r() < 0.2 ? '-' : String(t.ss),
    }),
    'fh.metric': ok({ metric: fhMetric, series: makeSeries(r), symbol: ticker }),
    'fh.profile2': ok({ name: ticker, marketCapitalization: odd(round(jit(t.mc) / 1e6, 2), 'fh'), floatingShare: odd(round(jit(t.float) / 1e6, 3), 'fh'), finnhubIndustry: r() < 0.1 ? '' : 'Semiconductors' }),
    'fh.recommendation': ok(r() < 0.1 ? [] : [
      { period: '2026-10-01', strongBuy: t.sb, buy: t.b, hold: t.h, sell: t.s, strongSell: t.ss },
      { period: '2026-09-01', strongBuy: t.sb + 1, buy: t.b, hold: t.h, sell: t.s, strongSell: t.ss },
    ]),
    'fh.peers': ok(peers),
    'fmp.profile': ok([{ symbol: ticker, price: odd(round(t.price, 2), 'fmp'), beta: odd(jit(t.beta), 'fmp'), marketCap: odd(Math.round(jit(t.mc)), 'fmp'), lastDividend: odd(t.div, 'fmp'), sector: r() < 0.1 ? '' : t.sector, industry: 'Semiconductors', cusip: '000000000' }]),
    'fmp.ratios': ok([{
      priceToEarningsRatioTTM: odd(jit(t.pe), 'fmp'), priceToEarningsGrowthRatioTTM: odd(jit(t.peg), 'fmp'), priceToBookRatioTTM: odd(jit(t.pb), 'fmp'),
      netProfitMarginTTM: odd(jit(t.pm), 'fmp'), grossProfitMarginTTM: odd(jit(t.gm), 'fmp'), debtToEquityRatioTTM: odd(round(r() * 3), 'fmp'),
      currentRatioTTM: odd(round(0.5 + r() * 3), 'fmp'), quickRatioTTM: odd(round(0.3 + r() * 2), 'fmp'),
      ...(r() < 0.5 ? { freeCashFlowPerShareTTM: odd(round(-2 + r() * 8), 'fmp') } : {}),
    }]),
    'fmp.metrics': ok([{ returnOnEquityTTM: odd(jit(t.roe), 'fmp'), returnOnAssetsTTM: odd(jit(t.roa), 'fmp'), freeCashFlowPerShareTTM: round(-2 + r() * 8) }]),
    'fmp.growth': ok([{ revenueGrowth: odd(jit(t.rg), 'fmp'), ...(r() < 0.5 ? { netIncomeGrowth: odd(jit(t.eg), 'fmp') } : {}), epsgrowth: jit(t.eg) }]),
    'fmp.target': ok([{ targetConsensus: r() < 0.2 ? null : odd(round(jit(target), 2), 'fmp'), targetMedian: round(target, 2), targetHigh: round(target * 1.3, 2), targetLow: round(target * 0.7, 2), ...(r() < 0.5 ? { numberOfAnalystOpinions: 12 } : {}) }]),
    'fmp.rating': ok([{ symbol: ticker, rating: ['A+', 'A', 'B+', 'B', 'C-', 'D', 'F', '', 'b'][Math.floor(r() * 9)], overallScore: 3 }]),
    'fmp.earnings': ok(earnings),
    'fmp.insider': ok(insider),
    'fmp.treasury': ok([{ date: isoDay(now - day), month1: 4.5, year2: 4.0, year10: round(3.5 + r()) }, { date: isoDay(now - 2 * day), year10: 4.0 }]),
  };
}

/** Peer metric reply for `/stock/metric` of a peer symbol. */
export function peerMetricReply(sym: string, r: () => number): Reply {
  const p = r();
  if (p < 0.1) return raw(402, '{"error":"You don\'t have access to this resource."}');
  if (p < 0.15) return ok({ metric: null });
  if (p < 0.18) return raw(200, '{oops');
  return ok({
    metric: { revenueGrowthTTMYoy: r() < 0.2 ? null : round(-20 + r() * 80, 2), revenueGrowthQuarterlyYoy: round(r() * 30, 2), grossMarginTTM: round(r() * 80, 2), netProfitMarginTTM: r() < 0.2 ? null : round(-30 + r() * 60, 2) },
    series: makeSeries(r, { size: 1 + Math.floor(r() * 4) }),
  });
}

/** Recorded exchanges for one ticker; a null reply is left unrecorded (the request throws, like a network error). */
export function exchangesOf(ticker: string, replies: Partial<Record<Endpoint, Reply | null | readonly (Reply | null)[]>>): RecordedExchange[] {
  const out: RecordedExchange[] = [];
  for (const ep of ENDPOINTS) {
    const v = replies[ep];
    const list = Array.isArray(v) ? v : [v];
    for (const rep of list as Array<Reply | null | undefined>) {
      if (!rep) continue;
      out.push({ request: { method: 'GET', url: scrubUrl(endpointUrl(ep, ticker)) }, response: { status: rep.status, bodyBase64: Buffer.from(rep.body, 'utf8').toString('base64') } });
    }
  }
  return out;
}

export interface Scenario {
  readonly name: string;
  readonly gen?: Partial<GenOptions>;
  /** Replace some replies (null = unrecorded); the others stay good. */
  readonly replies?: (good: Record<Endpoint, Reply>) => Partial<Record<Endpoint, Reply | null | readonly (Reply | null)[]>>;
}

const all = (eps: readonly Endpoint[], rep: Reply | null): Partial<Record<Endpoint, Reply | null>> => Object.fromEntries(eps.map((e) => [e, rep]));
const FMP_CORE: readonly Endpoint[] = ['fmp.profile', 'fmp.ratios', 'fmp.metrics'];
const FMP_PREMIUM: readonly Endpoint[] = ['fmp.ratios', 'fmp.metrics', 'fmp.growth', 'fmp.target', 'fmp.rating'];
const FMP_ALL: readonly Endpoint[] = ['fmp.profile', ...FMP_PREMIUM];
const FINNHUB_FUND: readonly Endpoint[] = ['fh.metric', 'fh.profile2', 'fh.recommendation'];

export const SCENARIOS: readonly Scenario[] = [
  { name: 'all good' },
  { name: 'providers agree (CV fine)', gen: { noise: 0.02 } },
  { name: 'providers disagree wildly', gen: { noise: 0.9 } },
  { name: 'odd encodings (strings, None, -, zeros)', gen: { odd: true } },
  { name: 'FMP premium-gated except profile', replies: () => all(FMP_PREMIUM, raw(402, '{"Error":"Premium"}')) },
  { name: 'FMP 429 everywhere', replies: () => all(FMP_ALL, raw(429, 'Limit Reach . Please upgrade your plan')) },
  { name: 'FMP "Limit Reach" inside a 200', replies: () => ({ 'fmp.ratios': raw(200, '{"Error Message":"Limit Reach"}'), 'fmp.target': raw(200, 'Limit Reach') }) },
  { name: 'FMP "current subscription" inside a 200', replies: () => ({ 'fmp.profile': raw(200, '{"x":"not available under your current subscription"}') }) },
  { name: 'FMP Error Message / errors objects', replies: () => ({ 'fmp.ratios': ok({ 'Error Message': 'Invalid API KEY' }), 'fmp.metrics': ok({ errors: ['x'] }) }) },
  { name: 'FMP core all fail (500)', replies: () => all(FMP_CORE, raw(500, 'oops')) },
  { name: 'FMP connected but all-null', replies: () => ({ 'fmp.profile': ok([{ symbol: 'X', sector: 'Tech', beta: 0 }]), 'fmp.ratios': ok([{}]), 'fmp.metrics': ok([]), 'fmp.growth': ok([{ revenueGrowth: 0 }]), 'fmp.target': raw(200, 'null'), 'fmp.rating': ok([]) }) },
  { name: 'FMP empty / short bodies', replies: () => ({ 'fmp.profile': raw(200, ''), 'fmp.ratios': raw(200, '[]'), 'fmp.growth': raw(200, '{}') }) },
  { name: 'profile-only: FMP has a beta and nothing else, AV and Finnhub fail', replies: () => ({ av: raw(500, ''), ...all(FINNHUB_FUND, raw(500, '')), 'fmp.profile': ok([{ symbol: 'X', beta: 1.3, sector: 'Technology', price: 10 }]), 'fmp.ratios': ok([{ x: 1 }]), 'fmp.metrics': ok([{ x: 1 }]), 'fmp.growth': ok([{ x: 1 }]), 'fmp.target': ok([{ x: 1 }]), 'fmp.rating': ok([{ x: 1 }]) }) },
  { name: 'AV Note (rate limit)', replies: () => ({ av: ok({ Note: 'Thank you for using Alpha Vantage! Our standard API call frequency is 5 calls per minute and 500 calls per day.' }) }) },
  { name: 'AV Information', replies: () => ({ av: ok({ Information: 'The **demo** API key is for demo purposes only.' }) }) },
  { name: 'AV no Symbol / too few keys', replies: () => ({ av: ok({ Symbol: 'X', A: 1 }) }) },
  { name: 'AV 503 and Finnhub 401', replies: () => ({ av: raw(503, ''), 'fh.metric': raw(401, '{"error":"Invalid API key"}'), 'fh.profile2': raw(401, ''), 'fh.recommendation': raw(401, '') }) },
  { name: 'AV body null', replies: () => ({ av: raw(200, 'null') }) },
  { name: 'Finnhub error field and empty rec', replies: () => ({ 'fh.metric': ok({ error: 'limit' }), 'fh.recommendation': ok([]) }) },
  { name: 'Finnhub no data at all', replies: () => ({ 'fh.metric': ok({}), 'fh.profile2': raw(200, 'null'), 'fh.recommendation': ok([]) }) },
  { name: 'Finnhub rec[0] null', replies: () => ({ 'fh.recommendation': ok([null]) }) },
  { name: 'everything fails: no fund, no side calls', replies: () => ({ ...all(FMP_CORE, raw(500, '')), av: raw(500, ''), ...all(FINNHUB_FUND, raw(500, '')) }) },
  { name: 'invalid JSON bodies', replies: () => ({ av: raw(200, '{bad'), 'fh.metric': raw(200, '{bad'), 'fmp.profile': raw(200, '{bad json'), 'fmp.earnings': raw(200, '[{bad'), 'fmp.insider': raw(200, '{bad'), 'fmp.treasury': raw(200, '{bad') }) },
  { name: 'network errors (unrecorded)', replies: () => ({ av: null, 'fh.profile2': null, 'fmp.ratios': null, 'fmp.earnings': null, 'fmp.insider': null, 'fmp.treasury': null, 'fh.peers': null }) },
  { name: 'side endpoints: field names missing', replies: () => ({ 'fmp.earnings': ok([{ when: '2026-01-01' }]), 'fmp.insider': ok([{ type: 'A' }]), 'fmp.treasury': ok([{ date: 'x', y10: 4 }]) }) },
  { name: 'side endpoints: 402 / 404 / empty', replies: () => ({ 'fmp.earnings': raw(404, ''), 'fmp.insider': raw(402, ''), 'fmp.treasury': ok([]) }) },
  { name: 'side endpoints: insider 404, earnings only past', replies: (g) => ({ 'fmp.insider': raw(404, 'x'), 'fmp.earnings': ok(JSON.parse(g['fmp.earnings'].body).slice(3)) }) },
  { name: 'v7: second metric call fails, peers ok', replies: (g) => ({ 'fh.metric': [g['fh.metric'], raw(500, '')] }) },
  { name: 'v7: second metric body null -> throws, peers skipped', replies: (g) => ({ 'fh.metric': [g['fh.metric'], raw(200, 'null')] }) },
  { name: 'v7: peers not an array', replies: () => ({ 'fh.peers': ok({ peers: ['A'] }) }) },
  { name: 'v7: few peers', gen: { peers: ['ZZ1'] } },
  { name: 'v7: empty peers', gen: { peers: [] } },
];
