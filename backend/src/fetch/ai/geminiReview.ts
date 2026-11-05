/**
 * fetchGeminiReviewV7, ported exactly from dataLayerV1.gs:119-283 (the
 * function ends at :283; :284 is blank and :285 starts fetchYahooChartRaw_).
 *
 * ══ WHAT IS KEPT, ON PURPOSE ══════════════════════════════════════════
 * Everything the model sees: the distilled report object (conclusions, never
 * raw series), every defensive constraint earned by a real defect
 * (canonicalRevenueGrowthPct, the trimmed options block, the `fund &&`
 * guards), the prompt text byte for byte, the request body, and every
 * failure path with its log line. Failure is a null return plus a log line;
 * the one thing that still throws is a malformed INPUT (legacy builds the
 * report outside its try/catch), and it throws the same error.
 *
 * ══ WHAT IS INJECTED ═══════════════════════════════════════════════════
 * - The API key. Legacy read the GEMINI_API_KEY constant; here it is
 *   `deps.apiKey` (env GEMINI_API_KEY, see geminiKeyFromEnv). Gemini
 *   carries it in the URL (`?key=`), so net/http.ts scrubUrl redacts `key=`.
 * - getCachedMacroRegime_() (:186). It is called at the same point, once.
 * - The expiry formatter. Legacy used `new Date(expUnix*1000).toDateString()`,
 *   which renders in the PROCESS time zone (F-D2); the default is that exact
 *   call, so parity holds, and a caller can pin a zone.
 *
 * The report builder and the two prompt halves are exported so the Claude
 * review (src/ai) is fed the same distilled report and the same defensive
 * constraints rather than a re-typed copy.
 */

import type { HttpClient } from '../../net/http.ts';
import { IV_CHAIN_PCT_LABEL, IV_CHAIN_PCT_MEANING } from '../../analysis/options/labels.ts';

type Maybe<T> = T | null | undefined;

export const GEMINI_MODEL = 'gemini-flash-lite-latest'; // fullStockAnalysisV10_9.gs:5315
export const GEMINI_API_KEY_ENV = 'GEMINI_API_KEY';
export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';

/** An unset key is the empty string; fetchGeminiReview then logs 'no API key' and returns null. */
export function geminiKeyFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env[GEMINI_API_KEY_ENV] ?? '';
}

export interface GeminiDriver {
  readonly label?: unknown;
  readonly value?: unknown;
  readonly note?: unknown;
}

export interface GeminiFundResult {
  readonly score?: unknown;
  readonly verdict?: unknown;
  readonly profile?: unknown;
  readonly drivers?: Maybe<readonly GeminiDriver[]>;
  readonly pricedForPerfection?: unknown;
}

export interface GeminiTechPlan {
  readonly techScore?: unknown;
  readonly regime?: unknown;
  readonly timing?: unknown;
  readonly entryPrice?: unknown;
  readonly entryLow?: unknown;
  readonly entryHigh?: unknown;
  readonly timeToEntry?: Maybe<{ readonly humanText?: unknown }>;
  readonly entryConfidencePct?: unknown;
  readonly t1?: Maybe<{ readonly price?: unknown }>;
  readonly t2?: Maybe<{ readonly price?: unknown }>;
  readonly stop?: unknown;
  readonly rrToT1?: unknown;
  readonly rrToT2?: unknown;
  readonly secular?: Maybe<{ readonly verdict?: unknown; readonly why?: unknown }>;
}

export interface GeminiDecision {
  readonly action?: unknown;
  readonly finalConviction?: unknown;
}

export interface GeminiIndicators {
  readonly rs?: Maybe<{ readonly rs63?: unknown; readonly outperforming?: unknown }>;
}

export interface GeminiFund {
  readonly revenueGrowth?: unknown;
  readonly debtToEquity?: unknown;
  readonly currentRatio?: unknown;
  readonly fcfPerShare?: unknown;
  readonly forwardPE?: unknown;
  readonly trailingPE?: unknown;
  readonly _insiderTrading?: Maybe<{ readonly netBuying?: unknown }>;
  readonly _treasuryRate10Y?: Maybe<{ readonly year10?: unknown }>;
  readonly _companyName?: unknown;
}

export interface GeminiChart {
  readonly currentPrice?: unknown;
  readonly vixContext?: Maybe<{ readonly read?: unknown }>;
}

export interface GeminiOptionsAnalysis {
  readonly available?: unknown;
  readonly confirm?: unknown;
  readonly putCallOI?: unknown;
  readonly netBiasPct?: unknown;
  readonly dirSig?: unknown;
  readonly leapsLean?: unknown;
  readonly ivRank?: unknown;
  readonly notes?: unknown;
}

/** selectRecommendedCallV7's result: `found` and, when found, the contract. */
export interface GeminiContractPick {
  readonly found?: unknown;
  readonly contract?: Maybe<{ readonly strike?: unknown; readonly expUnix?: unknown; readonly delta?: unknown }>;
}

/** getCachedMacroRegime_()'s result: only `available` and `regime` are read. */
export interface MacroRegimeRead {
  readonly available?: unknown;
  readonly regime?: unknown;
  /** C4: 'live (cache stale)' when classified from a live fetch. */
  readonly source?: unknown;
}

/**
 * The legacy parameter list (ticker, fundResult, techPlan, decision, ind,
 * gann, confluence, fund, chart, optAnalysis, log, leapsCallArg,
 * shortTermCallArg) as one object. `gann` and `confluence` are accepted and
 * never read, exactly as in legacy.
 */
export interface GeminiReviewInputs {
  readonly ticker: string;
  readonly fundResult: GeminiFundResult;
  readonly techPlan: GeminiTechPlan;
  readonly decision: GeminiDecision;
  readonly ind: GeminiIndicators;
  readonly gann?: unknown;
  readonly confluence?: unknown;
  readonly fund: Maybe<GeminiFund>;
  readonly chart: GeminiChart;
  readonly optAnalysis: Maybe<GeminiOptionsAnalysis>;
  readonly leapsCall?: Maybe<GeminiContractPick>;
  readonly shortTermCall?: Maybe<GeminiContractPick>;
  /**
   * B2/D18 (production; unset = legacy's report exactly): adds technical.confidenceWord (fixed word for
   * entryConfidencePct), technical.methodAgreement (the entry zone's method-agreement label, a different
   * measure) and companyName (the profile's name), and buildGeminiPrompt adds the rule that binds them.
   */
  readonly plainPrompt?: boolean;
  /**
   * E1 (option A, label only): "✅ AT YOUR BUY LIMIT — ..." when the price is already inside/below the buy zone.
   * Added to report.technical (with a note not to advise waiting for a pullback). Absent in legacy-parity mode,
   * so the legacy report JSON and prompt are unchanged.
   */
  readonly atBuyLimit?: string | null;
  /**
   * B1 option B (display only): "Next resistance: $X (+Y%, methods) · R:R to it Z" (analysis/nextResistance.ts),
   * added to report.technical; the prompt asks for it in KEY NUMBERS next to Target 1. Absent in legacy-parity mode.
   */
  readonly nextResistance?: string | null;
  /** B1 option B part 2 (display only): "T2 (fixed): $X ..." when it differs from T2; the prompt asks for it next to Target 2. */
  readonly fixedT2?: string | null;
}

export type GetMacroRegime = () => Maybe<MacroRegimeRead> | Promise<Maybe<MacroRegimeRead>>;

/** Legacy: `new Date(expUnix*1000).toDateString()`. */
export type FormatExpiry = (expUnix: unknown) => string;

export const defaultFormatExpiry: FormatExpiry = (expUnix) => new Date((expUnix as number) * 1000).toDateString();

/**
 * B3 (fix plan 2026-10-30), `plainLabels` (production; parity runs leave it unset): the options block names the
 * IV percentile for what it is -- `ivVsThisChainPercentile`, with a one-line meaning -- instead of `ivRankPct`
 * (it is the near-term IV's place among today's contract IVs, not a history-based IV rank).
 */
export interface GeminiReportOptions {
  readonly plainLabels?: boolean;
  /** Options sentiment part B (display only): the last stored market options line, added to macroBackdrop as text. */
  readonly marketOptionsLine?: string | null;
}

/** The distilled report object; its shape varies with which optional blocks exist. */
export type GeminiReport = Record<string, any>;

const num = (v: unknown): number => v as number;

/**
 * The `report` object (:123-257), including the optional blocks. Async only
 * because the injected macro-regime read may be; the call happens at the
 * same point legacy makes it (:186), after every earlier block.
 */
export async function buildGeminiReport(inputs: GeminiReviewInputs, getMacroRegime: GetMacroRegime, formatExpiry: FormatExpiry = defaultFormatExpiry, opts: GeminiReportOptions = {}): Promise<GeminiReport> {
  const { ticker, fundResult, techPlan, decision, ind, fund, chart, optAnalysis } = inputs;
  const round = (v: unknown, d?: number): number | null => (v == null || isNaN(v as number)) ? null : Number(Number(v).toFixed(d == null ? 2 : d));

  const report: GeminiReport = {
    ticker: ticker, price: round(chart.currentPrice),
    fundamental: {
      score: fundResult.score, verdict: fundResult.verdict, sectorModel: fundResult.profile,
      drivers: (fundResult.drivers || []).map((d) => ({ label: d.label, value: d.value, note: d.note })),
      pricedForPerfection: fundResult.pricedForPerfection || false,
      // The canonical, single-source-of-truth revenue growth figure, so the
      // model cannot paraphrase a different driver into "revenue growth".
      // The `fund &&` guards are the v9.70 crash fix: fund is null whenever
      // all three fundamentals sources fail.
      canonicalRevenueGrowthPct: fund && fund.revenueGrowth != null ? round(num(fund.revenueGrowth) * 100, 1) : null,
      // Balance sheet health -- 3 distilled numbers, not raw statements.
      debtToEquity: fund && fund.debtToEquity != null ? round(fund.debtToEquity, 2) : null,
      currentRatio: fund && fund.currentRatio != null ? round(fund.currentRatio, 2) : null,
      fcfPerShare: fund && fund.fcfPerShare != null ? round(fund.fcfPerShare, 2) : null,
    },
    technical: {
      techScore: techPlan.techScore, regime: techPlan.regime, timing: techPlan.timing,
      entry: round(techPlan.entryPrice), entryZone: [round(techPlan.entryLow), round(techPlan.entryHigh)],
      eta: techPlan.timeToEntry ? techPlan.timeToEntry.humanText : null, confidencePct: techPlan.entryConfidencePct,
      exitT1: techPlan.t1 ? round(techPlan.t1.price) : null, exitT2: techPlan.t2 ? round(techPlan.t2.price) : null,
      stop: round(techPlan.stop), rrToT1: round(techPlan.rrToT1, 2), rrToT2: round(techPlan.rrToT2, 2),
    },
    decision: { action: decision.action, finalConviction: decision.finalConviction },
  };
  if (inputs.atBuyLimit) {
    report.technical.atBuyLimit = inputs.atBuyLimit + ' The timing label is still WAIT_PULLBACK by rule, but the price is already at the'
      + ' buy limit: do NOT tell the reader to wait for a pullback or a dip; say the stock is at the buy limit and give the stop and the risk at today\'s price.';
  }
  if (inputs.nextResistance) report.technical.nextResistance = inputs.nextResistance;
  if (inputs.fixedT2) report.technical.exitT2Fixed = inputs.fixedT2;

  // Secular (5-10yr) read -- one verdict string, not the underlying series.
  if (techPlan.secular) {
    report.secular = { verdict: techPlan.secular.verdict, why: techPlan.secular.why };
  }
  // Sector-relative strength -- 2 numbers, already a finished comparison.
  if (ind.rs) {
    report.sectorStrength = { rs63Pct: round(ind.rs.rs63, 1), outperforming: !!ind.rs.outperforming };
  }
  // Broad-market backdrop (VIX) -- 1 read, not the VIX time series.
  if (chart.vixContext) {
    report.macroBackdrop = chart.vixContext.read;
  }
  if (opts.marketOptionsLine) report.macroBackdrop = (report.macroBackdrop ? report.macroBackdrop + '; ' : '') + opts.marketOptionsLine;
  // Cross-asset macro regime, the same signal the conviction modifier uses,
  // with the same weak/unconfirmed disclosure attached.
  {
    const macroRead = await getMacroRegime();
    if (macroRead && macroRead.available) {
      report.macroRegime = macroRead.regime + ' (weak/unconfirmed signal -- see MACRO_REGIME_VALIDATION_RESULTS.md)'
        // C4: only set outside legacy mode, when the regime was classified from a live fetch
        + (typeof macroRead.source === 'string' ? ' [source: ' + macroRead.source + ']' : '');
    }
  }
  // Insider trading -- net direction only, and only when real data came back.
  if (fund && fund._insiderTrading) {
    report.insiderActivity = fund._insiderTrading.netBuying ? 'net buying' : 'net selling';
  }
  // Rate-sensitivity -- only when it is a real consideration (high P/E).
  {
    const pe = fund && (fund.forwardPE != null ? fund.forwardPE : fund.trailingPE);
    if (pe != null && num(pe) > 40 && (fund as GeminiFund)._treasuryRate10Y && (fund as GeminiFund)._treasuryRate10Y!.year10 != null) {
      report.rateSensitivity = 'high (P/E ' + round(pe, 1) + 'x vs ' + round((fund as GeminiFund)._treasuryRate10Y!.year10, 2) + '% 10yr yield)';
    }
  }

  if (optAnalysis && optAnalysis.available) {
    // Only the aggregate positioning signals. The specific contract comes
    // from the recommended picks below, so the narrative cannot describe a
    // different contract than the rest of the report.
    report.options = opts.plainLabels ? {
      confirm: optAnalysis.confirm, putCallOI: round(optAnalysis.putCallOI, 2), netBiasPct: round(optAnalysis.netBiasPct, 1),
      dirSignal: round(optAnalysis.dirSig, 2), leapsLean: round(optAnalysis.leapsLean, 2), ivVsThisChainPercentile: optAnalysis.ivRank,
      ivVsThisChainPercentileMeans: IV_CHAIN_PCT_MEANING + '; call it "' + IV_CHAIN_PCT_LABEL + '", never "IV rank"',
      notes: optAnalysis.notes,
    } : {
      confirm: optAnalysis.confirm, putCallOI: round(optAnalysis.putCallOI, 2), netBiasPct: round(optAnalysis.netBiasPct, 1),
      dirSignal: round(optAnalysis.dirSig, 2), leapsLean: round(optAnalysis.leapsLean, 2), ivRankPct: optAnalysis.ivRank,
      notes: optAnalysis.notes,
    };
  }
  // The actual recommended contract(s), distilled to strike/expiry/delta.
  function distillPick(pick: Maybe<GeminiContractPick>): { strike: unknown; expiry: string; delta: number | null } | null {
    if (!pick || !pick.found) return null;
    const c = pick.contract as NonNullable<GeminiContractPick['contract']>;
    return { strike: c.strike, expiry: formatExpiry(c.expUnix), delta: round(c.delta, 2) };
  }
  const leapsPick = distillPick(inputs.leapsCall), shortPick = distillPick(inputs.shortTermCall);
  if (leapsPick || shortPick) {
    report.recommendedContract = {};
    if (leapsPick) report.recommendedContract.leaps = leapsPick;
    if (shortPick) report.recommendedContract.shortTerm = shortPick;
  }
  if (inputs.plainPrompt) {
    const pct = techPlan.entryConfidencePct;
    if (typeof pct === 'number' && isFinite(pct)) report.technical.confidenceWord = confidenceWord(pct);
    const conf = inputs.confluence as Maybe<{ readonly entryConfidence?: unknown }>;
    if (conf && typeof conf.entryConfidence === 'string' && conf.entryConfidence) report.technical.methodAgreement = conf.entryConfidence;
    if (fund && typeof fund._companyName === 'string' && fund._companyName) report.companyName = fund._companyName;
  }
  return report;
}

/** B2: the one fixed word for the entry-confidence percentage (>=70 high, 50-69 medium, <50 low). */
export function confidenceWord(pct: number): 'high' | 'medium' | 'low' {
  return pct >= 70 ? 'high' : pct >= 50 ? 'medium' : 'low';
}

/** B2/D18: the rule for the plain-prompt fields; added only when the report carries them. */
export function plainPromptRules(ticker: string, report: GeminiReport): string {
  let s = '';
  if (typeof report.companyName === 'string') {
    s += 'COMPANY NAME: the company is "' + report.companyName + '" (ticker ' + ticker + '). Call it by that name or by the ticker -- never invent, expand or respell a name from the ticker letters. ';
  }
  const t = report.technical || {};
  if (typeof t.confidenceWord === 'string') {
    s += 'CONFIDENCE WORDS: technical.confidencePct is the entry-plan confidence. Describe it ONLY with the word in technical.confidenceWord ' +
      '(fixed scale: 70% or more = high, 50-69% = medium, under 50% = low), e.g. "' + t.confidenceWord + ' confidence (' + t.confidencePct + '%)". ';
  }
  if (typeof t.methodAgreement === 'string') {
    s += 'technical.methodAgreement ("' + t.methodAgreement + '") is a DIFFERENT measure: how many independent price methods agree on the entry zone. ' +
      'Call it "method agreement", never "confidence", and never mix the two. ';
  }
  if (typeof t.nextResistance === 'string') {
    s += 'NEXT RESISTANCE: technical.nextResistance is the nearest price level above the entry where selling may start; Target 1 (exitT1) and its ' +
      'Risk/Reward stay the plan\'s target. In KEY NUMBERS add, right after Target 1, the line "' + t.nextResistance + '" exactly as given. ';
  }
  if (typeof t.exitT2Fixed === 'string') {
    s += 'T2 (FIXED): technical.exitT2Fixed is Target 2 rebuilt without the price methods the zones excluded; Target 2 (exitT2) stays the plan\'s. ' +
      'In KEY NUMBERS add, right after Target 2, the line "' + t.exitT2Fixed + '" exactly as given. ';
  }
  return s ? s + '\n\n' : '';
}

/** What follows the ticker sentence: the two-score separation and the revenue-growth constraint (:199-206). */
export const GEMINI_PROMPT_RULES =
  'This report deliberately keeps TWO SEPARATE scores: a Fundamental/OWN score (is this a good company to own?) ' +
  'and a Technical/BUY-TIMING score+plan (is now the time to buy, and if not, at what price and roughly when?). ' +
  'Respect that separation — never merge them into one number or imply one determines the other. ' +
  'Use ONLY the numbers provided — do NOT invent prices, targets, or figures. ' +
  'IMPORTANT: if you state a revenue growth percentage anywhere, you MUST use the value in ' +
  'fundamental.canonicalRevenueGrowthPct verbatim (or say revenue growth data is unavailable if it is null). ' +
  'Do NOT use any figure from the "drivers" list as a revenue-growth percentage — a driver labeled ' +
  '"Revenue/share trend" describes a DIFFERENT metric (revenue per share, not total revenue growth) ' +
  'and must never be reported as "revenue growth."\n\n';

/** Audience, format rules and the section list (:208-228). */
export const GEMINI_PROMPT_FORMAT =
  'AUDIENCE: a NON-EXPERT investor. Write a clear, pedagogical briefing (≤320 words). Explain any jargon in a few words the first time you use it. ' +
  'FORMAT RULES (important): do NOT use any Markdown symbols — no asterisks, no "#", no backticks, no bold markup. ' +
  'Use these EXACT section headers, each on its own line in UPPERCASE, followed by 1–3 short sentences or lines that start with "- ":\n\n' +
  'AT A GLANCE\n' +
  '- one plain sentence: is it a good company, is now a good time to buy, and what is the action.\n\n' +
  'THE COMPANY (SHOULD YOU OWN IT?)\n' +
  '- reference the OWN score/verdict and the 2–3 biggest positive and negative drivers, in plain words. If balance-sheet fields (debtToEquity/currentRatio/fcfPerShare) are present, weave in a one-line financial-health read. If insiderActivity is present, mention it briefly as a supporting (not primary) signal.\n\n' +
  'THE TIMING (IS NOW A GOOD TIME TO BUY?)\n' +
  '- reference the BUY-TIMING score, trend, and whether to buy now or wait; if waiting, give the entry price, zone, ETA and confidence %. If secular is present, add one sentence on the long-term (5-10yr) read, kept clearly distinct from this short-term timing call. If sectorStrength or macroBackdrop or rateSensitivity or macroRegime are present, weave in briefly where relevant — do not force all four if only one is present. If macroRegime is present, mention it as one contributing factor only, exactly as weak/unconfirmed as its own label says — never imply it is a confirmed or primary driver of the timing call.\n\n' +
  'WHAT THE OPTIONS SAY\n' +
  '- if an options block is present: plain-English read of confirm/conflict, Put/Call and LEAPS lean (near-term timing vs long-term ownership conviction) and IV; state it nudges the Final Conviction and BUY-TIMING but NEVER the OWN score. If recommendedContract is present, name the actual strike/expiry as the specific contract this report points to (leaps and/or short-term). If both options and recommendedContract are absent, say options data was not loaded.\n\n' +
  'REAL-WORLD EXPOSURE (STRUCTURAL, NOT A NEW SCORE)\n' +
  '- Using what you know about this specific company (not the report data), name ONE real, concrete exposure that could matter: a key input cost (does it depend on a specific commodity/material?), a supply-chain dependency (a concentrated supplier, a single-region manufacturing base), or its 2-3 real named competitors and whether this company is relatively better or worse positioned on that same exposure. Keep this to 2-3 sentences, plainly labeled as general/structural reasoning, not tied to any specific current event unless commodityMoves data is present in the report (it usually will not be yet). Skip this section entirely rather than force a generic "macro risk exists" statement if nothing concrete comes to mind for this specific company.\n\n' +
  'KEY NUMBERS\n' +
  '- a compact list, one per line as "Label: value", covering OWN score, BUY-TIMING score, Final Conviction, Entry, Stop, Target 1, Target 2, and Risk/Reward.\n\n' +
  'BOTTOM LINE\n' +
  '- the decision action, the Final Conviction, and one plain sentence on what a non-expert should actually do.\n\n';

/** The complete Gemini prompt (:195-231). */
export function buildGeminiPrompt(ticker: string, report: GeminiReport): string {
  return 'You are a professional equity analyst reviewing an automated v7 report for ' + ticker + '. ' +
    GEMINI_PROMPT_RULES + plainPromptRules(ticker, report) + GEMINI_PROMPT_FORMAT +
    'REPORT (JSON):\n' + JSON.stringify(report);
}

/** The request body (:270). Temperature and token cap are the legacy values. */
export function buildGeminiPayload(prompt: string): { contents: Array<{ parts: Array<{ text: string }> }>; generationConfig: { temperature: number; maxOutputTokens: number } } {
  return { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4, maxOutputTokens: 1024 } };
}

/** The post-hoc Markdown strip (:279), regexes verbatim. It leaves a trailing `x*` (F-D3). */
export function stripStrayMarkdown(text: string): string {
  return text.replace(/\*\*/g, '').replace(/(^|[^\w])\*(?=\S)/g, '$1').replace(/`/g, '').replace(/^#+\s*/gm, '').trim();
}

export interface GeminiReviewDeps {
  readonly http: HttpClient;
  /** Env GEMINI_API_KEY (geminiKeyFromEnv). Empty -> 'no API key', null, no request. */
  readonly apiKey: string;
  readonly getMacroRegime: GetMacroRegime;
  /** Legacy's GEMINI_MODEL; defaults to it. */
  readonly model?: string;
  readonly formatExpiry?: FormatExpiry;
  /** B3: GeminiReportOptions.plainLabels. */
  readonly plainLabels?: boolean;
  /** Legacy's `log` parameter; omitted -> silent. */
  readonly log?: (message: string) => void;
  /** Per-request timeout. Legacy had none (Apps Script could not bound a fetch); the http client's default applies when unset. */
  readonly timeoutMs?: number;
  /** Options sentiment part B: the last stored market options line (display text for macroBackdrop); null / absent = none. */
  readonly marketOptionsLine?: () => Promise<string | null>;
}

/**
 * fetchGeminiReviewV7. The review text, or null on every failure (the log
 * line says which). Rejects only for a malformed input, as legacy threw.
 */
export async function fetchGeminiReview(deps: GeminiReviewDeps, inputs: GeminiReviewInputs): Promise<string | null> {
  const key = deps.apiKey;
  const log = deps.log;
  if (!key) { if (log) log('  Gemini: no API key'); return null; }

  const marketOptionsLine = deps.marketOptionsLine ? await deps.marketOptionsLine().catch(() => null) : null;
  const report = await buildGeminiReport(inputs, deps.getMacroRegime, deps.formatExpiry, { plainLabels: deps.plainLabels, ...(marketOptionsLine ? { marketOptionsLine } : {}) });
  const prompt = buildGeminiPrompt(inputs.ticker, report);

  const url = GEMINI_ENDPOINT + (deps.model ?? GEMINI_MODEL) + ':generateContent?key=' + encodeURIComponent(key);
  const payload = buildGeminiPayload(prompt);
  try {
    const res = await deps.http.fetch({ url, method: 'POST', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true, timeoutMs: deps.timeoutMs });
    const code = res.status;
    if (code !== 200) { if (log) log('  Gemini HTTP ' + code + ': ' + res.text().substring(0, 120)); return null; }
    const json = JSON.parse(res.text());
    const cand = json.candidates && json.candidates[0];
    if (!cand) { const fb = json.promptFeedback && json.promptFeedback.blockReason; if (log) log('  Gemini: no candidate' + (fb ? ' (blocked: ' + fb + ')' : '')); return null; }
    let text = '';
    if (cand.content && cand.content.parts) text = cand.content.parts.map((p: any) => p.text || '').join('').trim();
    if (!text) { if (log) log('  Gemini: empty text'); return null; }
    return stripStrayMarkdown(text); // strip stray Markdown
  } catch (e) { if (log) log('  Gemini error: ' + (e as { message: string }).message.substring(0, 80)); return null; }
}
