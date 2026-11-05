/**
 * Master Lock, backend side (decision F-73). The lock itself stays INSIDE the sheet: a small Apps Script shim
 * (apps-script-shim/masterLock.gs) paints every tab red (#d50000) and a guardian reverts edits on red tabs.
 * The backend does three things around its writes: unlock -> write -> lock again, the lock again in a `finally`
 * so a crash in the middle of a write still leaves the sheet locked. A workflow step (npm run lock-sheets,
 * under `if: always()`) repeats the lock for the case where the whole process was killed.
 *
 * Unlock keeps non-red accent colours by default (keepAccentsOnUnlock). Lock overwrites every tab with the lock
 * colour, so accents cannot survive a lock: that is a limit of the design (finding F-L3), not of this code.
 */

import type { RunContext } from '../core/context.ts';
import { StepState } from '../core/status.ts';
import { err, ok, logDetail } from '../core/result.ts';
import type { StepResult } from '../core/result.ts';
import { LOCK_TAB_COLOR } from '../reports/options/ui.ts';
import { LOCK_STEP_KEYS, lockFailureSentence } from './client.ts';
import type { LockPhase, TabColorChange, TabColorInfo } from './client.ts';

export const LOCK_COLOR = LOCK_TAB_COLOR;

/** The part of SheetsClient this module needs (the tests pass a fake). */
export interface MasterLockSheets {
  tabColors(ctx: RunContext, phase: LockPhase): Promise<StepResult<TabColorInfo[]>>;
  setTabColors(ctx: RunContext, phase: LockPhase, changes: readonly TabColorChange[]): Promise<StepResult<number>>;
}

export interface MasterLockOptions {
  /** Default true: unlock clears only the red tabs and leaves other tab colours alone. False = clear every tab (the shim's behaviour). */
  readonly keepAccentsOnUnlock?: boolean;
}

export interface LockCounts { readonly changed: number; readonly total: number }
export interface UnlockCounts extends LockCounts { readonly keptAccents: number }

export function isLockRed(t: TabColorInfo): boolean {
  return !t.themed && t.color !== null && t.color.toLowerCase() === LOCK_COLOR;
}
const hasAccent = (t: TabColorInfo): boolean => !isLockRed(t) && (t.themed || t.color !== null);

/** Every tab red. Tabs that are already red are not touched, so it is safe to repeat. */
export async function lockAllTabs(ctx: RunContext, sheets: MasterLockSheets): Promise<StepResult<LockCounts>> {
  const read = await sheets.tabColors(ctx, 'lock');
  if (!read.ok) return err<LockCounts>(read.error);
  const todo = read.value.filter((t) => !isLockRed(t));
  const wrote = await sheets.setTabColors(ctx, 'lock', todo.map((t) => ({ sheetId: t.sheetId, color: LOCK_COLOR })));
  if (!wrote.ok) return err<LockCounts>(wrote.error);
  ctx.log.info('Master Lock: tabs locked', { changed: todo.length, total: read.value.length });
  return ok({ changed: todo.length, total: read.value.length });
}

/** Clears the lock colour (and, with keepAccentsOnUnlock false, every other tab colour too). */
export async function unlockAllTabs(ctx: RunContext, sheets: MasterLockSheets, opts: MasterLockOptions = {}): Promise<StepResult<UnlockCounts>> {
  const keep = opts.keepAccentsOnUnlock !== false;
  const read = await sheets.tabColors(ctx, 'unlock');
  if (!read.ok) return err<UnlockCounts>(read.error);
  const targets = read.value.filter((t) => (keep ? isLockRed(t) : isLockRed(t) || hasAccent(t)));
  const keptAccents = keep ? read.value.filter(hasAccent).length : 0;
  const wrote = await sheets.setTabColors(ctx, 'unlock', targets.map((t) => ({ sheetId: t.sheetId, color: null })));
  if (!wrote.ok) return err<UnlockCounts>(wrote.error);
  ctx.log.info('Master Lock: tabs unlocked', { changed: targets.length, total: read.value.length, keptAccents });
  return ok({ changed: targets.length, total: read.value.length, keptAccents });
}

/** Thrown when the unlock step failed, so `fn` was not run. */
export class SheetLockError extends Error {
  phase: 'unlock';
  constructor(phase: 'unlock', message: string) {
    super(message);
    this.name = 'SheetLockError';
    this.phase = phase;
  }
}

export interface UnlockedRun<T> {
  readonly value: T;
  /** False when the final lock failed (the sheet may be left unlocked). */
  readonly relocked: boolean;
  /** Plain-English report lines, ready for the report. Empty when all went well. */
  readonly reportLines: readonly string[];
}

/**
 * unlock -> fn -> lock again. The lock always runs (finally), also when fn throws; fn's own error is rethrown
 * unchanged. A failed lock is logged (technical), recorded in ctx.status under 'sheets.lockTabs' with a plain
 * sentence, and returned in reportLines. If the unlock fails fn does not run.
 */
export async function withUnlockedSheets<T>(
  ctx: RunContext, sheets: MasterLockSheets, fn: () => Promise<T>, opts: MasterLockOptions = {},
): Promise<UnlockedRun<T>> {
  let value: T | undefined;
  let relock: { ok: boolean; line: string | null } = { ok: false, line: null };
  try {
    let unlocked: StepResult<UnlockCounts>;
    try {
      unlocked = await unlockAllTabs(ctx, sheets, opts);
    } catch (e) {
      unlocked = err<UnlockCounts>({ kind: 'unknown', detail: logDetail(e instanceof Error ? e.message : 'unlock threw'), disclosure: lockFailureSentence('unlock'), attempts: 1, cause: e });
    }
    if (!unlocked.ok) {
      ctx.log.error('Master Lock: unlock failed, the write was not started', { detail: String(unlocked.error.detail) });
      ctx.status.set({ key: LOCK_STEP_KEYS.unlock, label: 'Unlock sheet tabs', state: StepState.FAILED, disclosure: lockFailureSentence('unlock'), detail: unlocked.error.detail });
      throw new SheetLockError('unlock', 'the sheet tabs could not be unlocked');
    }
    value = await fn();
  } finally {
    relock = await relockSafely(ctx, sheets);
  }
  return { value: value as T, relocked: relock.ok, reportLines: relock.line ? [relock.line] : [] };
}

async function relockSafely(ctx: RunContext, sheets: MasterLockSheets): Promise<{ ok: boolean; line: string | null }> {
  let res: StepResult<LockCounts>;
  try {
    res = await lockAllTabs(ctx, sheets);
  } catch (e) {
    res = err<LockCounts>({ kind: 'unknown', detail: logDetail(e instanceof Error ? e.message : 'lock threw'), disclosure: lockFailureSentence('lock'), attempts: 1, cause: e });
  }
  if (res.ok) return { ok: true, line: null };
  const line = String(lockFailureSentence('lock'));
  ctx.log.error('Master Lock: re-lock FAILED, the sheet may be left unlocked', { detail: String(res.error.detail) });
  ctx.status.set({ key: LOCK_STEP_KEYS.lock, label: 'Re-lock sheet tabs', state: StepState.FAILED, disclosure: lockFailureSentence('lock'), detail: res.error.detail });
  return { ok: false, line };
}
