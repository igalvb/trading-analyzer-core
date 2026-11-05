/**
 * Fixtures for FL-7D (Gemini parity). Every response here is SYNTHETIC, in
 * the generateContent shape legacy reads; a real recording is still needed
 * (see the FL-7D handback). Inputs are generated, not hand-picked, and the
 * seed decides which optional report blocks exist so the branch coverage
 * guards in the test cannot pass vacuously.
 *
 * Also holds the ORACLE side of the comparison (the legacy call under a
 * replaying UrlFetchApp), shared by the Gemini and Claude tests.
 */

import { ExchangeBook, scrubUrl, type RecordedExchange } from '../src/net/http.ts';
import { rng } from './fundamentalsFixtures.ts';
import { loadOracle } from './oracle.ts';
import { withOracleGlobals } from './oracleGlobals.ts';
import { replayUrlFetchApp } from './gasFakes.ts';
import type { GeminiReviewInputs, MacroRegimeRead } from '../src/fetch/ai/geminiReview.ts';

export interface GeminiCase {
  readonly inputs: GeminiReviewInputs;
  /** What getCachedMacroRegime_ returns. */
  readonly macro: MacroRegimeRead | null | undefined;
  /** When set, getCachedMacroRegime_ throws this message instead. */
  readonly macroThrows?: string;
}

export function geminiExchange(url: string, payload: string, status: number, body: string): RecordedExchange {
  return { request: { method: 'POST', url: scrubUrl(url), payload }, response: { status, bodyBase64: Buffer.from(body, 'utf8').toString('base64') } };
}

const NUMS: readonly unknown[] = [null, undefined, NaN, '12.3456', 0, 1.23456, -4.5, 123.456789, 'abc', 7, 0.005, 1e-7, true, '  '];
const PES: readonly unknown[] = [12.345, 45.678, 40, 41, null, 120, undefined, '55.5'];

export function genGeminiCase(seed: number): GeminiCase {
  const r = rng(seed * 7919 + 13);
  const pickOf = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const odd = (): unknown => pickOf(NUMS);
  const real = (): number => Math.round(r() * 1e5) / 1e3 * (r() < 0.2 ? -1 : 1);
  const mix = (): unknown => (r() < 0.8 ? real() : odd());

  const drivers = Array.from({ length: Math.floor(r() * 5) }, (_, i) => ({ label: 'Driver ' + i, value: mix(), note: r() < 0.5 ? 'note ' + i : undefined, extra: 'dropped' }));
  const fundResult = {
    score: mix(), verdict: pickOf(['STRONG', 'OK', 'WEAK', undefined]), profile: pickOf(['TECH', 'BANK', null]),
    drivers: seed % 7 === 0 ? undefined : drivers, pricedForPerfection: pickOf([undefined, true, false, 1]),
  };
  const techPlan = {
    techScore: mix(), regime: pickOf(['UPTREND', 'RANGE', undefined]), timing: pickOf(['BUY_NOW', 'WAIT', undefined]),
    entryPrice: mix(), entryLow: mix(), entryHigh: mix(),
    timeToEntry: r() < 0.6 ? { humanText: '~' + Math.floor(r() * 9) + ' weeks' } : pickOf([null, undefined]),
    entryConfidencePct: mix(), t1: r() < 0.7 ? { price: mix() } : pickOf([null, undefined]), t2: r() < 0.7 ? { price: mix() } : pickOf([null, undefined]),
    stop: mix(), rrToT1: mix(), rrToT2: mix(),
    secular: seed % 2 === 0 ? { verdict: 'STRONG', why: 'steady compounding' } : pickOf([null, undefined]),
  };
  const decision = { action: pickOf(['BUY_NOW', 'WAIT', 'AVOID']), finalConviction: mix() };
  const ind = seed % 3 !== 0 ? { rs: { rs63: mix(), outperforming: pickOf([true, false, 1, 0, undefined]) } } : pickOf([{}, { rs: null }]);
  const chart = { currentPrice: mix(), vixContext: seed % 5 < 3 ? { read: 'VIX calm at 14' } : pickOf([null, undefined]) };

  const fm = seed % 4;
  const fund = fm === 0 ? pickOf([null, undefined])
    : fm === 1 ? {}
    : {
      revenueGrowth: mix(), debtToEquity: mix(), currentRatio: mix(), fcfPerShare: mix(),
      _insiderTrading: fm === 3 ? { netBuying: r() < 0.5 } : pickOf([null, undefined]),
      forwardPE: pickOf(PES), trailingPE: pickOf(PES),
      _treasuryRate10Y: r() < 0.8 ? { year10: pickOf([4.25, 4.256, null, '3.9']) } : pickOf([null, undefined]),
    };

  const om = seed % 3;
  const optAnalysis = om === 0 ? pickOf([null, undefined])
    : om === 1 ? { available: false, confirm: 'X' }
    : { available: true, confirm: pickOf(['CONFIRM', 'CONFLICT']), putCallOI: mix(), netBiasPct: mix(), dirSig: mix(), leapsLean: mix(), ivRank: mix(), notes: pickOf([['n1', 'n2'], 'text', undefined]) };

  const makePick = () => ({ found: true, contract: { strike: pickOf([100, 152.5, '210']), expUnix: 1.8e9 + Math.floor(r() * 1e8), delta: mix() } });
  const pm = (seed >> 1) % 4;
  const leapsCall = pm === 1 || pm === 3 ? makePick() : pickOf([null, undefined, { found: false }]);
  const shortTermCall = pm === 2 || pm === 3 ? makePick() : pickOf([null, undefined, { found: false }]);

  const mm = seed % 3;
  const macro = mm === 0 ? null : mm === 1 ? { available: false, regime: 'NEUTRAL' } : { available: true, regime: pickOf(['RISK_ON', 'RISK_OFF', 'NEUTRAL']) };

  return {
    inputs: {
      ticker: pickOf(['AAPL', 'NVDA', 'BRK.B', 'X']), fundResult, techPlan, decision, ind, gann: { unused: 1 }, confluence: { unused: 2 },
      fund, chart, optAnalysis, leapsCall, shortTermCall,
    },
    macro,
  };
}

export interface GeminiScenario {
  readonly name: string;
  readonly status: number;
  /** null: the request is not recorded (a replay miss, i.e. a network error). */
  readonly body: string | null;
}

export const geminiBody = (parts: readonly unknown[]): string => JSON.stringify({ candidates: [{ content: { parts } }] });

export const GEMINI_SCENARIOS: readonly GeminiScenario[] = [
  { name: 'ok-plain', status: 200, body: geminiBody([{ text: 'AT A GLANCE\n- A good company.' }]) },
  { name: 'ok-markdown', status: 200, body: geminiBody([{ text: '**AT A GLANCE**\n# Heading\n## Two\n- *item* with `code` and a*b and 2 * 3 and ** end' }]) },
  { name: 'ok-multipart', status: 200, body: geminiBody([{ text: 'Part one. ' }, {}, { text: 'part two ' }, { text: null }]) },
  { name: 'ok-trim', status: 200, body: geminiBody([{ text: '  \n body \n  ' }]) },
  { name: 'http-500', status: 500, body: 'upstream exploded' },
  { name: 'http-429-long', status: 429, body: 'x'.repeat(300) },
  { name: 'http-403-json', status: 403, body: JSON.stringify({ error: { code: 403, message: 'API key not valid. Please pass a valid API key.' } }) },
  { name: 'no-candidates', status: 200, body: '{}' },
  { name: 'blocked', status: 200, body: JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }) },
  { name: 'empty-candidates', status: 200, body: JSON.stringify({ candidates: [] }) },
  { name: 'cand-no-content', status: 200, body: JSON.stringify({ candidates: [{ finishReason: 'SAFETY' }] }) },
  { name: 'empty-text', status: 200, body: geminiBody([{ text: '' }]) },
  { name: 'whitespace-only', status: 200, body: geminiBody([{ text: ' \n ' }]) },
  { name: 'parts-empty-array', status: 200, body: geminiBody([]) },
  { name: 'bad-json', status: 200, body: '<html>oops</html>' },
  { name: 'json-null', status: 200, body: 'null' },
  { name: 'empty-body', status: 200, body: '' },
  { name: 'parts-not-array', status: 200, body: JSON.stringify({ candidates: [{ content: { parts: 'x' } }] }) },
  { name: 'parts-null-entry', status: 200, body: geminiBody([null]) },
  { name: 'unrecorded', status: 0, body: null },
];

/** Strings over the characters the Markdown strip cares about. */
export function markdownFuzz(seed: number, n: number): string[] {
  const r = rng(seed);
  const alphabet = ['*', '*', '**', '#', '#', '`', ' ', ' ', '\n', 'a', 'b', '1', '_', '-', '\t'];
  return Array.from({ length: n }, () => {
    const len = 1 + Math.floor(r() * 24);
    let s = '';
    for (let i = 0; i < len; i++) s += alphabet[Math.floor(r() * alphabet.length)];
    return s;
  });
}

// ── the oracle side ─────────────────────────────────────────────────────

export type FetchBehavior =
  | { readonly kind: 'replay'; readonly exchanges: readonly RecordedExchange[] }
  | { readonly kind: 'throw'; readonly value: unknown };

export interface Outcome {
  value: string | null | undefined;
  threw: string | undefined;
  logs: string[];
  trace: string[];
  misses: string[];
  macroCalls: number;
}

/** The message of a thrown value; oracle-realm errors are not `instanceof Error` here, so read the property. */
export function errMessage(e: unknown): string {
  return e !== null && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e);
}

/** One normalised line per request: method, scrubbed URL, body, content type, mute flag. */
export function traceKey(method: string | undefined, url: string, payload: string | undefined, contentType: string | undefined, mute: boolean | undefined): string {
  return [(method ?? 'GET').toUpperCase(), scrubUrl(url), payload ?? '', contentType ?? '', String(!!mute)].join(' | ');
}

/** Reads a top-level legacy constant (they are `const`, so unreachable through setGlobal). */
export function legacyGeminiConst(expr: string): string {
  const F = loadOracle().fns.fetchGeminiReviewV7 as unknown as { constructor: FunctionConstructor };
  return String(new F.constructor('return ' + expr)());
}

function oracleArgs(c: GeminiCase, log: (m: string) => void): unknown[] {
  const i = c.inputs;
  return [i.ticker, i.fundResult, i.techPlan, i.decision, i.ind, i.gann, i.confluence, i.fund, i.chart, i.optAnalysis, log, i.leapsCall, i.shortTermCall];
}

export function runOracleGemini(c: GeminiCase, behavior: FetchBehavior): Outcome {
  const logs: string[] = [];
  const trace: string[] = [];
  let macroCalls = 0;
  const book = new ExchangeBook(behavior.kind === 'replay' ? behavior.exchanges : []);
  const inner = replayUrlFetchApp(book) as { fetch: (u: string, p: Record<string, unknown>) => unknown };
  const urlFetch = {
    fetch: (url: string, params: { method?: string; payload?: string; contentType?: string; muteHttpExceptions?: boolean }) => {
      trace.push(traceKey(params.method, url, params.payload, params.contentType, params.muteHttpExceptions));
      if (behavior.kind === 'throw') throw behavior.value;
      return inner.fetch(url, params);
    },
    fetchAll: () => { throw new Error('fetchAll is not expected'); },
  };
  let value: string | null | undefined;
  let threw: string | undefined;
  withOracleGlobals({
    UrlFetchApp: urlFetch,
    getCachedMacroRegime_: () => { macroCalls++; if (c.macroThrows) throw new Error(c.macroThrows); return c.macro; },
  }, () => {
    try {
      value = loadOracle().fns.fetchGeminiReviewV7(...oracleArgs(c, (m) => { logs.push(m); })) as string | null;
    } catch (e) {
      threw = errMessage(e);
    }
  });
  return { value, threw, logs, trace, misses: book.misses, macroCalls };
}

/** What the legacy function sends for these inputs (the reply is irrelevant), or null if it never reaches the fetch. */
export function captureOracleGemini(c: GeminiCase): { url: string; payload: string } | null {
  let got: { url: string; payload: string } | null = null;
  const reply = { getResponseCode: () => 500, getContentText: () => '' };
  withOracleGlobals({
    UrlFetchApp: { fetch: (url: string, p: { payload: string }) => { got = { url, payload: p.payload }; return reply; }, fetchAll: () => [] },
    getCachedMacroRegime_: () => { if (c.macroThrows) throw new Error(c.macroThrows); return c.macro; },
  }, () => {
    try { loadOracle().fns.fetchGeminiReviewV7(...oracleArgs(c, () => {})); } catch { /* the capture only needs the request, if any */ }
  });
  return got;
}
