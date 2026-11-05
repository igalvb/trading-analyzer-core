/**
 * FL-9d: display-only conversion of the analysis' model comparison into the per-model rows both report
 * sheets show. Nothing is scored or re-decided here: a direction the comparison already holds is re-labelled
 * (bullish -> BULLISH, cautionary -> BEARISH, mixed -> NEUTRAL). A model whose key is absent is simply not
 * listed (the sheet then says it did not run).
 *
 * Accepts, in this order of preference:
 *   models      : a valid ModelRead[] (kept as given, including scores)
 *   comparison  : a valid ComparisonRead, else the real ComparisonReport (see analysis/models/brokerCourse/comparison.ts)
 */
import { REASON_CODES } from '../messages/catalog.ts';
import type { ReasonCode } from '../messages/catalog.ts';
import type { ComparisonRead, ModelId, ModelRead, Stance } from '../exitSheet/types.ts';

const MODEL_IDS: readonly ModelId[] = ['ENGINE', 'SCHABACKER', 'EDWARDS_MAGEE', 'BROKER_COURSE', 'TURTLE'];
const STANCES: readonly Stance[] = ['BULLISH', 'NEUTRAL', 'BEARISH', 'UNAVAILABLE'];
const isModelId = (x: unknown): x is ModelId => typeof x === 'string' && (MODEL_IDS as readonly string[]).includes(x);
const isStance = (x: unknown): x is Stance => typeof x === 'string' && (STANCES as readonly string[]).includes(x);
const isReason = (x: unknown): x is ReasonCode => typeof x === 'string' && (REASON_CODES as readonly string[]).includes(x);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

const DIRECTION: Readonly<Record<string, Stance>> = { bullish: 'BULLISH', cautionary: 'BEARISH', mixed: 'NEUTRAL' };

const KEYS: ReadonlyArray<{ readonly model: ModelId; readonly key: string }> = [
  { model: 'ENGINE', key: 'existingDirection' },
  { model: 'SCHABACKER', key: 'schabackerDirection' },
  { model: 'EDWARDS_MAGEE', key: 'edwardsMageeDirection' },
  { model: 'BROKER_COURSE', key: 'newDirection' },
  { model: 'TURTLE', key: 'turtleDirection' },
];

export function validModelReads(x: unknown): ModelRead[] {
  if (!Array.isArray(x)) return [];
  const out: ModelRead[] = [];
  for (const m of x) {
    if (m === null || typeof m !== 'object') continue;
    const o = m as Record<string, unknown>;
    if (!isModelId(o['model']) || !isStance(o['stance'])) continue;
    out.push({ model: o['model'], stance: o['stance'], score: num(o['score']), ...(isReason(o['reasonCode']) ? { reasonCode: o['reasonCode'] } : {}) });
  }
  return out;
}

export function validComparisonRead(x: unknown): ComparisonRead | null {
  if (x === null || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const agree = num(o['agreeCount']);
  const total = num(o['totalCount']);
  if (agree == null || total == null) return null;
  const dis = Array.isArray(o['dissenters']) ? (o['dissenters'] as unknown[]).filter(isModelId) : [];
  return { agreeCount: agree, totalCount: total, majority: isStance(o['majority']) ? o['majority'] : null, dissenters: dis };
}

/** Model rows from a ComparisonReport-shaped object. Empty when the object is not one. */
export function modelsFromReport(x: unknown): ModelRead[] {
  if (x === null || typeof x !== 'object') return [];
  const o = x as Record<string, unknown>;
  if (!('existingDirection' in o)) return [];
  const out: ModelRead[] = [];
  for (const { model, key } of KEYS) {
    if (!(key in o)) continue;
    const d = o[key];
    const brokerGone = model === 'BROKER_COURSE' && o['newModelUnavailable'] === true;
    const stance = !brokerGone && typeof d === 'string' ? DIRECTION[d] : undefined;
    if (stance) out.push({ model, stance, score: null });
    else out.push({ model, stance: 'UNAVAILABLE', score: null, reasonCode: 'SECTION_UNAVAILABLE' });
  }
  return out;
}

/** Display count from the listed stances. A majority needs a strict lead AND more than half of the available reads. */
export function comparisonFromModels(models: readonly ModelRead[]): ComparisonRead | null {
  const avail = models.filter((m) => m.stance !== 'UNAVAILABLE');
  if (!avail.length) return null;
  const counts = new Map<Stance, number>();
  for (const m of avail) counts.set(m.stance, (counts.get(m.stance) ?? 0) + 1);
  let top: Stance = avail[0]!.stance;
  let topN = 0;
  let tied = false;
  for (const [s, n] of counts) {
    if (n > topN) { top = s; topN = n; tied = false; } else if (n === topN) tied = true;
  }
  const majority: Stance | null = !tied && topN * 2 > avail.length ? top : null;
  return {
    agreeCount: topN, totalCount: avail.length, majority,
    dissenters: majority ? avail.filter((m) => m.stance !== majority).map((m) => m.model) : [],
  };
}

export function readsFrom(models: unknown, comparison: unknown): { models: ModelRead[]; comparison: ComparisonRead | null } {
  const direct = validModelReads(models);
  const list = direct.length ? direct : modelsFromReport(comparison);
  return { models: list, comparison: validComparisonRead(comparison) ?? comparisonFromModels(list) };
}
