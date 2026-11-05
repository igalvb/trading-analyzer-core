/**
 * James's models, phase 5 (docs/models/MASTER_PLAN.md section 5): the report page "✅ James — Quality Gate" in the
 * Full Ticker Analysis (and the PDF), its row in 🧮 All Models and its line in the Bottom Line. DISPLAY ONLY, computed
 * after every score and decision is final: nothing here feeds a score, the conviction, the verdict, the timing or a
 * Buy report tier; it is NOT merged into the OWN fundamentals score or its blocking floor; the read stays out of the
 * nightly Buy and Exit reports (decision 8).
 *
 * James's 8-step checklist (2023-12-10, written for Solana tokens) and Ackman's 4 points (2026-06-01), mapped to stock
 * facts by plan 10 (every threshold [PROPOSED]): analysis/models/qualityGate.ts. These are James's models, not the
 * owner's: every label says "James — ".
 */

import { qualityScore, priceItemsSeries, passesGate, QUALITY_DEFAULTS, type QualityItem, type GateRule, type FundInputs } from './models/qualityGate.ts';
import { formatDateInTz } from '../core/dates.ts';
import { RESULTS, NO_HISTORY, type ResultsPack } from '../profile/results.ts';

export const JAMES_QG_NAME = 'James — Quality Gate';
const DISCLAIMER = 'Shown for information only: nothing on this page changes any score, the conviction, the verdict or the Buy report tiers, and it is not part of the OWN fundamentals score.';

/** The plan's live gate as written (6 of 8, an unknown item = no point). */
export const QG_LIVE_STRICT: GateRule = { mode: 'strict', mark: 6, outOf: 8 };
/** The level chosen on 2010-2019 for Trend 200, the paper account's host (research/qualityGateCli.ts QG_CHOSEN.trend200; a test keeps the two equal). */
export const QG_PAGE_RULE: GateRule = { mode: 'scaled', mark: 4, outOf: 7 };

/**
 * History of the research list, $100,000, after tax, 10 bps per side (docs/models/results/phase5.md): the profile's results pack
 * (GENERIC_PLAN P4, profile/results.ts); null = no pack, the pages say NO_HISTORY.
 */
export const JAMES5_HISTORY: ResultsPack['james5'] | null = RESULTS?.james5 ?? null;
/** The research run's basis (list, hold yardstick, tax), for the history headers. */
const BASIS = RESULTS?.basis ?? null;

export interface J5Bars { readonly dates: ReadonlyArray<Date | string>; readonly closes: readonly number[]; readonly volumes?: readonly number[] }
const ds = (d: Date | string | undefined, tz: string): string => (d == null ? '' : typeof d === 'string' ? d.slice(0, 10) : formatDateInTz(d, tz, 'yyyy-MM-dd'));
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

export interface QualityRead {
  readonly status: 'ok' | 'noData';
  readonly day: string;
  readonly points: number; readonly known: number; readonly outOf: number;
  readonly passesStrict: boolean; readonly passesChosen: boolean;
  readonly items: readonly QualityItem[];
}

/**
 * Tonight's score (out of 8) from the run's chart (items 7, 8), the CEO table (item 1) and the run's merged
 * fundamentals for items 2 and 4 (TODAY's numbers, marked "current, not point-in-time"); dilution (3) and the peer
 * price-to-sales (6) are not in the merged fundamentals and show "unknown"; item 5 is the owner's call.
 */
export function buildQualityRead(ticker: string, b: J5Bars | null | undefined, fund: Readonly<Record<string, unknown>> | null | undefined, tz = 'America/New_York'): QualityRead {
  if (!b || !b.closes.length) return { status: 'noData', day: '', points: 0, known: 0, outOf: 8, passesStrict: false, passesChosen: false, items: [] };
  const day = ds(b.dates[b.dates.length - 1], tz);
  const prices = priceItemsSeries(b, QUALITY_DEFAULTS);
  const f: FundInputs = {
    revenueGrowth: num(fund?.['revenueGrowth']), grossMargin: num(fund?.['grossMargins']), dilution: null, ps: null, peerMedianPs: null,
    source: 'current fundamentals (not point-in-time)', pit: false, missing: fund ? 'not in this run\'s fundamentals' : 'no fundamentals this run',
  };
  const s = qualityScore({ ticker, day, prices, i: b.closes.length - 1, fund: f, history: false, useCase: null });
  return { status: 'ok', day, points: s.points, known: s.known, outOf: s.outOf, passesStrict: passesGate(s, QG_LIVE_STRICT), passesChosen: passesGate(s, QG_PAGE_RULE), items: s.items };
}

const MARK: Readonly<Record<QualityItem['state'], string>> = { pass: '✓', fail: '✗', unknown: '?' };

export function formatQualityGatePage(ticker: string, r: QualityRead): string {
  const out = ['── ' + ticker + ' — ' + JAMES_QG_NAME + ' (James\'s 8-step checklist + Ackman, mapped to stocks) ──', '', DISCLAIMER,
    'James\'s "8 Step Process" (InvestAnswers, 2023-12-10) was written for new Solana tokens where "all the data the compendium needs is not available"; Ackman\'s People / Opportunity / Context / Deal (2026-06-01) has no numbers. Every threshold below is our proposal (plan 10), not James\'s.'];
  if (r.status !== 'ok') return [...out, '', 'No price data this run.'].join('\n');
  out.push('', '1. SCORE ' + r.points + ' / ' + r.outOf + ' (' + r.known + ' of ' + r.outOf + ' items known) — '
    + (r.passesStrict ? 'passes' : 'would not pass') + ' the plan\'s gate of 6 of 8; ' + (r.passesChosen ? 'passes' : 'would not pass') + ' the level chosen on 2010-2019 (4 of 7 of the known items)');
  for (const x of r.items) out.push('  ' + x.n + ' ' + x.name.padEnd(19) + ' ' + MARK[x.state] + '  ' + x.value + '  [' + x.threshold + '; ' + x.source + (x.pit ? '' : ', current') + ']');
  out.push('  Ackman Context (regulation, competition, timing): your call — shown, never scored.',
    '  "?" = unknown (no data: no point, not a fail). Items 2 and 4 use today\'s fundamentals; items 3 and 6 need the SEC point-in-time download (research/fetchFundamentalsPit.ts).');
  const H = JAMES5_HISTORY;
  if (!H || !BASIS) out.push('', '2. HISTORY', '  ' + NO_HISTORY);
  else out.push('', '2. HISTORY (the gate as a filter: the host buys only stocks that pass; ' + BASIS.list + ', $100,000, after the ' + BASIS.tax + ' tax, 10 bps per side; 2010-19 / 2020-23 / 2024-26)',
    '  What history could see: the CEO table, Trend 200 and dollar volume (no SEC point-in-time data reached this build); the level was chosen on 2010-2019 only.',
    '  Trend 200 gated ' + H.trend200.gated + ' vs ungated ' + H.trend200.ungated + ' (deepest fall ' + H.trend200.fall + ')',
    '  Combo 2 of 3 gated ' + H.combo.gated + ' vs ungated ' + H.combo.ungated,
    '  Engine gated ' + H.engine.gated + ' vs ungated ' + H.engine.ungated,
    '  Everything together gated ' + H.best.gated + ' vs ungated ' + H.best.ungated,
    '  The plan\'s gate as written: ' + H.asWritten + '.',
    '  📊 Hold QQQ ' + H.qqq + '; 📊 ' + BASIS.holdList + ' ' + H.list14 + '.',
    '  Verdict: ' + H.verdict + '. It runs in the paper test as information ("James — Quality Gate on Trend 200").');
  return out.join('\n');
}

// ─────────────────────────────── reads, 🧮 All Models, Bottom Line ───────────────────────────────

export interface James5Reads { readonly quality: QualityRead }

/** Defensive reader (the read arrives as `unknown` through the pipelines and the analysis cache). */
export function readJames5Reads(x: unknown): James5Reads | null {
  if (!x || typeof x !== 'object') return null;
  const q = (x as Record<string, unknown>)['quality'] as Record<string, unknown> | undefined;
  if (!q || typeof q !== 'object' || (q['status'] !== 'ok' && q['status'] !== 'noData') || !Array.isArray(q['items'])) return null;
  return x as James5Reads;
}

export interface James5RowText { readonly key: 'QUALITY_GATE'; readonly model: string; readonly read: string; readonly why: string }

const failing = (r: QualityRead): string => {
  const f = r.items.filter((x) => x.state === 'fail').map((x) => x.name.toLowerCase()), u = r.items.filter((x) => x.state === 'unknown').length;
  return (f.length ? 'fails ' + f.join(', ') : 'fails nothing known') + (u ? '; ' + u + ' unknown' : '');
};

export function james5AllModelsRows(j: James5Reads | null): James5RowText[] {
  const model = JAMES_QG_NAME + ' (8-step / Ackman)';
  if (!j || j.quality.status !== 'ok') return [{ key: 'QUALITY_GATE', model, read: 'Not available', why: 'This model did not run.' }];
  const r = j.quality;
  return [{ key: 'QUALITY_GATE', model, read: r.points + ' / ' + r.outOf + ' — ' + (r.passesChosen ? 'passes' : 'would block'), why: failing(r) + '.' }];
}

export function james5BottomLines(j: James5Reads): Array<[string, string]> {
  const r = j.quality;
  return [['✅ ' + JAMES_QG_NAME, r.status !== 'ok' ? 'Not available' : r.points + '/' + r.outOf + ' (' + r.known + ' known) — ' + (r.passesChosen ? 'passes' : 'would block') + ' a buy; ' + failing(r)]];
}
