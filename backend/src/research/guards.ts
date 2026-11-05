/**
 * G5 testing guards (docs/models/MASTER_PLAN.md section 6, T1 and T2), shared by every James model's history test:
 *
 *   - `sweepGuard`: a sweep's setup is chosen on 2010-2019 only (T1); the first pass is capped (T2b); for the chosen
 *     setup, its out-of-sample percentile among all swept setups, the share of setups beating QQQ out-of-sample and
 *     the sweep's median and interquartile spread (T2c); the stable-neighbourhood check, else the pre-registered
 *     default (T2d).
 *   - `randomSignalNull`: the same number of trades on random dates in the same stocks with the same holding rules,
 *     over 100 seeds (T2e); `nullVerdict`: the model counts only above the null's 95th percentile in-sample and above
 *     its median out-of-sample.
 *
 * Pure: the caller runs its own engine (runPortfolio, liloDay, a new book) and hands over the final values.
 */

/** T1: setups are chosen on PERIODS[0] (2010-2019); the later periods are the out-of-sample check. */
export const IN_SAMPLE = 0;
/** T2(b): the first pass is capped at about 50-100 setups per model. */
export const SWEEP_CAP = 100;
/** T2(e): seeds of the random-signal null. */
export const NULL_SEEDS = 100;
/** The research seed (as `randomBags`). */
export const NULL_SEED = 20261028;

/** Deterministic random numbers in [0, 1) (mulberry32), so a rerun draws the same. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** The q-quantile (0..1) of the values, linear between the two nearest ranks; NaN for none. */
export function quantile(values: readonly number[], q: number): number {
  const xs = [...values].sort((a, b) => a - b);
  if (!xs.length) return NaN;
  const h = (xs.length - 1) * q, lo = Math.floor(h), hi = Math.ceil(h);
  return (xs[lo] as number) + (h - lo) * ((xs[hi] as number) - (xs[lo] as number));
}

// ---------------------------------------------------------------------------------------------------------------
// Sweep guard (T1, T2 a-d)

/** One swept setup: its knobs as step numbers on each knob's grid (0, 1, 2, ...), and its final value per PERIODS period. */
export interface SweepSetup {
  readonly name: string;
  readonly knobs: Readonly<Record<string, number>>;
  readonly finals: readonly number[];
}

/** The chosen setup's standing in one out-of-sample period. */
export interface SweepPeriodStats {
  /** Share of all swept setups at or below the chosen one, %. */
  readonly percentile: number;
  /** Share of all swept setups beating QQQ, %. */
  readonly beatingQqqPct: number;
  readonly median: number; readonly q1: number; readonly q3: number;
}

export interface SweepGuard {
  /** T2(a): the pre-registered default, reported first. */
  readonly defaultSetup: SweepSetup;
  /** The best setup in the in-sample period. */
  readonly picked: SweepSetup;
  /** T2(d): the picked setup's one-step neighbours (one knob moved one step) and how many beat QQQ in-sample. */
  readonly neighbours: number; readonly neighboursBeatingQqq: number; readonly stable: boolean;
  /** The setup that is used: the pick when its neighbourhood is stable, else the pre-registered default. */
  readonly chosen: SweepSetup;
  /** T2(c), per PERIODS period: the chosen setup's standing; null for the in-sample period. */
  readonly periods: ReadonlyArray<SweepPeriodStats | null>;
}

/** One knob moved one step, every other knob the same. */
function isNeighbour(a: SweepSetup, b: SweepSetup): boolean {
  const ka = Object.keys(a.knobs), kb = Object.keys(b.knobs);
  if (ka.length !== kb.length || ka.some((k) => !(k in b.knobs))) return false;
  let moved = 0;
  for (const k of ka) {
    const d = Math.abs((a.knobs[k] as number) - (b.knobs[k] as number));
    if (d === 1) moved++; else if (d !== 0) return false;
  }
  return moved === 1;
}

/**
 * The sweep guard. `setups` is the first pass (at most `cap`, T2b); `defaultName` names the pre-registered default
 * among them; `qqq` is Hold QQQ's final value per PERIODS period. The pick is the best final in `inSample` only
 * (T1; another window only where the plan states it up front, e.g. model 6's 2020-2023). A pick with no neighbour
 * in the sweep counts as unstable.
 */
export function sweepGuard(setups: readonly SweepSetup[], defaultName: string, qqq: readonly number[], o: { readonly inSample?: number; readonly cap?: number } = {}): SweepGuard {
  const ins = o.inSample ?? IN_SAMPLE, cap = o.cap ?? SWEEP_CAP;
  if (setups.length > cap) throw new Error('sweepGuard: ' + setups.length + ' setups, over the cap of ' + cap + ' (T2b: vary further knobs one at a time around the pick)');
  const defaultSetup = setups.find((s) => s.name === defaultName);
  if (!defaultSetup) throw new Error('sweepGuard: the pre-registered default "' + defaultName + '" is not in the sweep');
  const picked = setups.reduce((best, s) => ((s.finals[ins] as number) > (best.finals[ins] as number) ? s : best));
  const nb = setups.filter((s) => isNeighbour(picked, s));
  const beating = nb.filter((s) => (s.finals[ins] as number) > (qqq[ins] as number)).length;
  const stable = nb.length > 0 && beating * 2 >= nb.length;
  const chosen = stable ? picked : defaultSetup;
  const periods = qqq.map((q, k) => {
    if (k === ins) return null;
    const xs = setups.map((s) => s.finals[k] as number), mine = chosen.finals[k] as number;
    return {
      percentile: (xs.filter((x) => x <= mine).length / xs.length) * 100,
      beatingQqqPct: (xs.filter((x) => x > q).length / xs.length) * 100,
      median: quantile(xs, 0.5), q1: quantile(xs, 0.25), q3: quantile(xs, 0.75),
    };
  });
  return { defaultSetup, picked, neighbours: nb.length, neighboursBeatingQqq: beating, stable, chosen, periods };
}

// ---------------------------------------------------------------------------------------------------------------
// Random-signal null (T2 e)

/**
 * Random buy days with the model's count per ticker: for each ticker, `counts` days drawn without repeats from
 * `daysOf(ticker)` (that stock's decision days in the period).
 */
export function randomSignalDays(counts: ReadonlyMap<string, number>, daysOf: (ticker: string) => readonly string[], rnd: () => number): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [t, n] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
    const pool = [...daysOf(t)];
    const picked = new Set<string>();
    for (let k = 0; k < Math.min(n, pool.length); k++) {
      const j = k + Math.floor(rnd() * (pool.length - k));
      [pool[k], pool[j]] = [pool[j] as string, pool[k] as string];
      picked.add(pool[k] as string);
    }
    out.set(t, picked);
  }
  return out;
}

export interface NullDistribution {
  /** The final value of each seed's run, in seed order. */
  readonly values: readonly number[];
  readonly median: number; readonly p95: number;
}

/**
 * The random-signal null of one period: `seeds` runs of the same engine with the same holding rules (`run`), each
 * given random buy days with the model's own trade count per stock (`counts`, e.g. runPortfolio's `buysByTicker`).
 */
export function randomSignalNull(counts: ReadonlyMap<string, number>, daysOf: (ticker: string) => readonly string[], run: (buyDays: ReadonlyMap<string, ReadonlySet<string>>) => number,
  seeds = NULL_SEEDS, seed = NULL_SEED): NullDistribution {
  const values = Array.from({ length: seeds }, (_, k) => run(randomSignalDays(counts, daysOf, mulberry32(seed + k))));
  return { values, median: quantile(values, 0.5), p95: quantile(values, 0.95) };
}

/**
 * T2(e): the model counts only if it beats the null's 95th percentile in-sample and is above the null's median in
 * every out-of-sample period.
 */
export function nullVerdict(inSample: { readonly model: number; readonly nul: NullDistribution }, outOfSample: ReadonlyArray<{ readonly model: number; readonly nul: NullDistribution }>):
  { readonly beatsP95InSample: boolean; readonly aboveMedianOutOfSample: readonly boolean[]; readonly passes: boolean } {
  const beatsP95InSample = inSample.model > inSample.nul.p95;
  const aboveMedianOutOfSample = outOfSample.map((x) => x.model > x.nul.median);
  return { beatsP95InSample, aboveMedianOutOfSample, passes: beatsP95InSample && aboveMedianOutOfSample.every(Boolean) };
}
