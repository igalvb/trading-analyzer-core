/**
 * What the bot's server remembers between calls (one small JSON file on the server, never in a Sheet or the repo):
 *   halted     the kill switch (R6): /halt sets it, nothing is sent while it is on;
 *   pending    the one plan waiting for the next open: its hash, the day it runs, approval, hold, what was skipped;
 *   ledger     the bot's own view of its account (positions and cash, from its own fills), for reconciliation (3.5);
 *   nonces     signed control calls already seen (replay refusal), kept until their timestamp is too old anyway.
 * The broker is always the truth for what is held; the ledger only exists to notice changes the bot did not make.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Plan } from '../planner.ts';

export type PlanStatus = 'awaiting-approval' | 'approved' | 'ready' | 'held' | 'skipped' | 'done';

export interface Approval { readonly at: number; readonly hash: string; readonly by: string }

export interface PendingPlan {
  readonly plan: Plan;
  readonly hash: string;
  /** The trading day the plan is sent on (the next one after the plan's decision day). */
  readonly execDay: string;
  readonly receivedAt: number;
  status: PlanStatus;
  approval: Approval | null;
  /** Why the plan is held (reconciliation mismatches, broker unknown at plan time). */
  held: string[];
  /** Order refs the bot decided not to send this morning, with why (logged once). */
  skipped: Record<string, string>;
  /** Free notes for /status. */
  notes: string[];
  /** True once the executor started its first send (from then on the broker must be read to know what was sent). */
  sendStarted: boolean;
  /** The morning's summary went to Telegram (sent once). */
  summarySent: boolean;
}

export interface Ledger {
  /** instrumentKey -> quantity. */
  positions: Record<string, number>;
  cash: number;
  /** When the owner last confirmed it (or the bot adopted the broker's view after a confirm). */
  confirmedAt: number;
}

export interface BotState {
  halted: boolean;
  haltedWhy: string | null;
  pending: PendingPlan | null;
  ledger: Ledger | null;
  /** execIds already applied to the ledger. */
  appliedFills: string[];
  /** nonce -> ms after which it may be forgotten. */
  nonces: Record<string, number>;
}

export const emptyBotState = (): BotState => ({ halted: false, haltedWhy: null, pending: null, ledger: null, appliedFills: [], nonces: {} });

export interface BotStateStore {
  load(): Promise<BotState>;
  save(s: BotState): Promise<void>;
}

export class MemoryBotStateStore implements BotStateStore {
  private json: string;
  constructor(initial: BotState = emptyBotState()) { this.json = JSON.stringify(initial); }
  async load(): Promise<BotState> { return JSON.parse(this.json) as BotState; }
  async save(s: BotState): Promise<void> { this.json = JSON.stringify(s); }
}

const chains = new WeakMap<BotStateStore, Promise<unknown>>();

/**
 * Load, change and save as one step, one at a time per store (the control handler and the morning executor share
 * the state; a /halt must never be lost under an executor save). `fn` must not wait on the broker.
 */
export function updateState<T>(store: BotStateStore, fn: (s: BotState) => T): Promise<T> {
  const run = (chains.get(store) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const s = await store.load();
    const out = fn(s);
    await store.save(s);
    return out;
  });
  chains.set(store, run);
  return run;
}

/** A JSON file, written whole to a temporary file and renamed (never half-written). */
export class FileBotStateStore implements BotStateStore {
  private readonly file: string;
  constructor(file: string) { this.file = file; }
  async load(): Promise<BotState> {
    if (!fs.existsSync(this.file)) return emptyBotState();
    return { ...emptyBotState(), ...(JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<BotState>) };
  }
  async save(s: BotState): Promise<void> {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
