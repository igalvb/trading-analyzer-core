/**
 * FL-9b (3): the trigger-removal checklist for Phase 8 (plan items 54 and 55: all 7 Apps Script triggers removed and
 * verified at zero; rollback tested). Maps every legacy trigger and every legacy menu item to the backend command or
 * workflow that replaces it, checks that each replacement really exists, and applies one go/no-go rule.
 *
 * PURE. The caller injects what exists (workflow files, CLI commands), the parallel-run verdict and the facts that
 * only a person can supply (rollback rehearsal, the user's approval, the live trigger count after removal). This
 * module never touches Apps Script and never removes anything: it only says whether removal may start, and whether
 * it is finished.
 *
 * GO / NO-GO RULE. Removal may start (GO) only when ALL of these hold:
 *   G1  each of the 7 legacy triggers has a replacement that exists: its workflow file is present and scheduled, and
 *       each nightly step it maps to is part of the approved nightly order
 *   G2  each legacy menu item has a backend entry point, and every command it names exists
 *   G3  the parallel run (parallelRun.ts evaluateRun) is GO
 *   G4  a rollback was rehearsed (a date is recorded)
 *   G5  no open blocking finding
 *   G6  the user approved removal on a recorded date. Never assumed.
 * The cutover is COMPLETE only when GO also holds and, after removal, the project's live trigger count equals
 * the expected remaining count (default 0). A count that was not supplied is "pending", never a pass.
 */

import { NIGHTLY_ORDER } from '../jobs/nightly/steps.ts';
import type { NightlyStepId } from '../jobs/nightly/steps.ts';
import { NIGHTLY, WORKFLOWS } from '../workflows/schedule.ts';
import type { WorkflowSpec } from '../workflows/schedule.ts';
import { LEGACY_MENUS, MENU_ENTRY_POINTS } from '../reports/options/ui.ts';
import type { EntryPoint, LegacyMenu } from '../reports/options/ui.ts';
import type { RunEvaluation } from './parallelRun.ts';

export interface LegacyTrigger {
  readonly id: string;
  /** The Apps Script function that installed it (a menu item or a manual run). */
  readonly installer: string;
  /** installer location in legacy/ */
  readonly installerAt: string;
  /** The function the trigger called. */
  readonly handler: string;
  /** Legacy schedule: daily at this local time of the Apps Script project time zone ("about", Apps Script is not exact). */
  readonly legacyTime: string;
  /** Workflow file that replaces it. */
  readonly workflow: string;
  /** Nightly steps (jobs/nightly/steps.ts) that replace the handler; empty = the workflow itself. */
  readonly steps: readonly NightlyStepId[];
}

/** The 7 triggers of the plan (item 54). Locations read in legacy/ on 2026-10-24. */
export const LEGACY_TRIGGERS: readonly LegacyTrigger[] = [
  { id: 'T1', installer: 'installDarkPoolTrackerTriggerV1', installerAt: 'darkPoolTrackerV1.gs:292', handler: 'refreshDarkPoolTrackerV1', legacyTime: '05:00', workflow: 'nightly.yml', steps: ['darkPool.tracker'] },
  { id: 'T2', installer: 'installEvaluativeIndexTriggerV1', installerAt: 'darkPoolTrackerV1.gs:382', handler: 'refreshEvaluativeIndexV1', legacyTime: '05:30', workflow: 'nightly.yml', steps: ['darkPool.evaluativeIndex'] },
  { id: 'T3', installer: 'installRelativeStrengthRankingTriggerV1', installerAt: 'darkPoolTrackerV1.gs:507', handler: 'refreshRelativeStrengthRankingV1_', legacyTime: '05:45', workflow: 'nightly.yml', steps: ['darkPool.relativeStrength'] },
  { id: 'T4', installer: 'installMacroRegimeCacheTriggerV1', installerAt: 'macro_fetchers_v0_15.gs:276', handler: 'refreshMacroRegimeCacheV1', legacyTime: '06:00', workflow: 'nightly.yml', steps: ['macro.refresh'] },
  { id: 'T5', installer: 'installDailyTriggerV7', installerAt: 'fullStockAnalysisV10_9.gs:330', handler: 'runDailyAutomationV7', legacyTime: '01:00', workflow: 'nightly.yml', steps: ['analysis.tickers', 'analysis.summary'] },
  { id: 'T6', installer: 'installExitStrategyTriggerV1', installerAt: 'fullStockAnalysisV10_9.gs:10516', handler: 'buildExitStrategyReportV7', legacyTime: '01:00', workflow: 'nightly.yml', steps: ['exit.report'] },
  { id: 'T7', installer: 'installMyOptionsEndOfDayTrigger', installerAt: 'myOptionsValueTracker.gs:187', handler: 'refreshMyOptionsValue', legacyTime: '17:00', workflow: 'my-options.yml', steps: [] },
];

// ---- entry points -----------------------------------------------------------------------------

export interface ParsedEntry {
  /** CLI commands named by the entry ('cli: chart TICKER' -> 'chart'). */
  readonly commands: readonly string[];
  /** True when the entry names a workflow / nightly step. */
  readonly workflow: boolean;
}

export function parseEntry(entry: string): ParsedEntry {
  const commands: string[] = [];
  for (const m of entry.matchAll(/\bcli:\s*([a-z][a-z0-9-]*)/g)) if (!commands.includes(m[1] as string)) commands.push(m[1] as string);
  return { commands, workflow: /\bworkflow:/.test(entry) };
}

export type ItemStatus = 'READY' | 'UNMAPPED' | 'COMMAND_MISSING' | 'WORKFLOW_MISSING';

export interface MenuRow {
  readonly menu: string;
  readonly label: string;
  readonly handler: string;
  readonly entry: string;
  readonly status: ItemStatus;
  readonly detail: string;
}

export interface TriggerRow {
  readonly trigger: LegacyTrigger;
  readonly ready: boolean;
  readonly replacement: string;
  readonly problems: readonly string[];
}

export interface ChecklistInputs {
  /** File names found in .github/workflows (for example 'nightly.yml'). */
  readonly workflowFiles: readonly string[];
  /** CLI commands that exist now (for example the keys of package.json scripts). */
  readonly availableCommands: readonly string[];
  /** The parallel-run verdict, or null when there is no run yet. */
  readonly run: RunEvaluation | null;
  readonly rollbackTestedOn: string | null;
  readonly userApprovedRemovalOn: string | null;
  readonly openBlockingFindings: readonly string[];
  /** ScriptApp.getProjectTriggers().length read by a person AFTER removal; null = not read yet. */
  readonly liveTriggerCountAfterRemoval: number | null;
  /** Triggers that are allowed to remain (default 0). Raise only by a recorded user decision. */
  readonly expectedRemainingTriggers?: number;
  /** Overridable for tests. */
  readonly triggers?: readonly LegacyTrigger[];
  readonly menus?: readonly LegacyMenu[];
  readonly entries?: Readonly<Record<string, EntryPoint>>;
  readonly workflows?: readonly WorkflowSpec[];
  readonly nightlyOrder?: readonly string[];
}

export function resolveTriggers(inp: ChecklistInputs): TriggerRow[] {
  const specs = inp.workflows ?? WORKFLOWS;
  const order = inp.nightlyOrder ?? NIGHTLY_ORDER;
  return (inp.triggers ?? LEGACY_TRIGGERS).map((t) => {
    const problems: string[] = [];
    const spec = specs.find((s) => s.file === t.workflow);
    if (!spec) problems.push('workflow ' + t.workflow + ' is not defined in workflows/schedule.ts');
    else if (spec.crons.length === 0 && !(spec.relayCrons ?? []).length) problems.push('workflow ' + t.workflow + ' has no schedule');
    if (!inp.workflowFiles.includes(t.workflow)) problems.push('workflow file ' + t.workflow + ' is not in .github/workflows');
    for (const s of t.steps) if (!order.includes(s)) problems.push('step ' + s + ' is not in the approved nightly order');
    const viaRelay = !!spec && spec.crons.length === 0 && (spec.relayCrons ?? []).length > 0;
    const cron = spec ? (viaRelay ? spec.relayCrons ?? [] : spec.crons).join(' and ') : '?';
    const replacement = t.workflow + (t.steps.length ? ' step ' + t.steps.join(' + ') : '') + ' (cron ' + cron + ' UTC' + (viaRelay ? ', started by the relay' : '') + ')';
    return { trigger: t, ready: problems.length === 0, replacement, problems };
  });
}

export function resolveMenus(inp: ChecklistInputs): MenuRow[] {
  const rows: MenuRow[] = [];
  const entries = inp.entries ?? MENU_ENTRY_POINTS;
  for (const menu of inp.menus ?? LEGACY_MENUS) {
    for (const item of menu.items) {
      if (!item) continue;
      const [label, handler] = item;
      const e = entries[handler];
      if (!e) { rows.push({ menu: menu.menu, label, handler, entry: '-', status: 'UNMAPPED', detail: 'no entry in MENU_ENTRY_POINTS' }); continue; }
      const p = parseEntry(e.entry);
      const missing = p.commands.filter((c) => !inp.availableCommands.includes(c));
      if (missing.length) {
        const hints = missing.map((c) => {
          const similar = inp.availableCommands.filter((a) => a.split('-')[0] === c.split('-')[0]);
          return c + (similar.length ? ' (similar existing command: ' + similar.join(', ') + ')' : '');
        });
        rows.push({ menu: menu.menu, label, handler, entry: e.entry, status: 'COMMAND_MISSING', detail: 'missing: ' + hints.join('; ') });
        continue;
      }
      if (p.commands.length === 0 && p.workflow && !inp.workflowFiles.includes(NIGHTLY.file)) {
        rows.push({ menu: menu.menu, label, handler, entry: e.entry, status: 'WORKFLOW_MISSING', detail: NIGHTLY.file + ' not found' });
        continue;
      }
      rows.push({ menu: menu.menu, label, handler, entry: e.entry, status: 'READY', detail: '' });
    }
  }
  return rows;
}

// ---- go / no-go -------------------------------------------------------------------------------

export interface Gate { readonly id: string; readonly label: string; readonly pass: boolean; readonly detail: string }

export interface RemovalDecision {
  readonly removal: 'GO' | 'NO-GO';
  /** DONE = GO and the live count equals the expected remaining count; PENDING = count not read yet; FAILED = count differs. */
  readonly cutover: 'NOT-STARTED' | 'PENDING' | 'FAILED' | 'DONE';
  readonly gates: readonly Gate[];
  readonly triggers: readonly TriggerRow[];
  readonly menus: readonly MenuRow[];
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function decideRemoval(inp: ChecklistInputs): RemovalDecision {
  const triggers = resolveTriggers(inp);
  const menus = resolveMenus(inp);
  const badTriggers = triggers.filter((t) => !t.ready);
  const badMenus = menus.filter((m) => m.status !== 'READY');
  const expected = inp.expectedRemainingTriggers ?? 0;
  const gates: Gate[] = [
    { id: 'G1', label: 'Every legacy trigger has an existing, scheduled replacement', pass: badTriggers.length === 0 && triggers.length === 7, detail: triggers.length !== 7 ? triggers.length + ' triggers listed, the plan has 7' : badTriggers.length ? badTriggers.map((t) => t.trigger.id + ': ' + t.problems.join(', ')).join('; ') : '7 of 7' },
    { id: 'G2', label: 'Every legacy menu item has an existing backend entry point', pass: badMenus.length === 0, detail: badMenus.length ? badMenus.length + ' of ' + menus.length + ' not ready' : menus.length + ' of ' + menus.length },
    { id: 'G3', label: 'The parallel run is GO', pass: inp.run !== null && inp.run.verdict === 'GO', detail: inp.run === null ? 'no parallel run supplied' : inp.run.verdict + ' (' + inp.run.completeNights + ' complete night(s))' },
    { id: 'G4', label: 'A rollback was rehearsed', pass: !!inp.rollbackTestedOn && ISO.test(inp.rollbackTestedOn), detail: inp.rollbackTestedOn ?? 'not recorded' },
    { id: 'G5', label: 'No open blocking finding', pass: inp.openBlockingFindings.length === 0, detail: inp.openBlockingFindings.length ? inp.openBlockingFindings.join(', ') : 'none' },
    { id: 'G6', label: 'The user approved removal', pass: !!inp.userApprovedRemovalOn && ISO.test(inp.userApprovedRemovalOn), detail: inp.userApprovedRemovalOn ?? 'not recorded' },
  ];
  const removal = gates.every((g) => g.pass) ? 'GO' : 'NO-GO';
  let cutover: RemovalDecision['cutover'] = 'NOT-STARTED';
  if (removal === 'GO') {
    if (inp.liveTriggerCountAfterRemoval === null) cutover = 'PENDING';
    else cutover = inp.liveTriggerCountAfterRemoval === expected ? 'DONE' : 'FAILED';
  }
  return { removal, cutover, gates, triggers, menus };
}

// ---- rendering --------------------------------------------------------------------------------

const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const box = (done: boolean): string => (done ? '[x]' : '[ ]');

/** The checklist as markdown: gates, then one block per trigger, then the menu table, then the rollback and the final check. */
export function renderChecklist(d: RemovalDecision, inp: ChecklistInputs): string {
  const expected = inp.expectedRemainingTriggers ?? 0;
  const o: string[] = [];
  o.push('## Trigger removal: ' + d.removal + ' (cutover ' + d.cutover + ')', '');
  o.push('| Gate | Result | Detail |', '|---|---|---|');
  for (const g of d.gates) o.push('| ' + g.id + ' ' + esc(g.label) + ' | ' + (g.pass ? 'pass' : 'FAIL') + ' | ' + esc(g.detail) + ' |');

  o.push('', '### Triggers to remove (7)', '', '| # | Legacy handler | Installed by | Legacy time | Replaced by | Replacement exists |', '|---|---|---|---|---|---|');
  for (const r of d.triggers) {
    const t = r.trigger;
    o.push('| ' + t.id + ' | ' + t.handler + ' | ' + t.installer + ' (' + t.installerAt + ') | about ' + t.legacyTime + ' | ' + esc(r.replacement) + ' | ' + (r.ready ? 'yes' : 'NO: ' + esc(r.problems.join('; '))) + ' |');
  }

  o.push('', '### Steps (do these only when removal is GO)', '');
  for (const r of d.triggers) {
    o.push('- ' + box(false) + ' ' + r.trigger.id + ': in the Apps Script editor, Triggers page, delete the trigger for `' + r.trigger.handler + '`.');
  }
  o.push('- ' + box(false) + ' In the Apps Script editor, run `ScriptApp.getProjectTriggers().length` (for example inside a temporary function) and write the number down. Expected: ' + expected + '.');
  o.push('- ' + box(d.cutover === 'DONE') + ' Record the count in this tool as the live trigger count. Cutover is DONE only when it equals ' + expected + '.');
  if (expected === 0) o.push('- Note: the optional Master Lock shim (apps-script-shim/masterLock.gs) needs one edit trigger if the red-tab lock is kept (finding F-L1). That would make the expected count 1 and needs a recorded user decision first.');

  o.push('', '### Rollback (rehearse once during the parallel run)', '');
  o.push('- ' + box(!!inp.rollbackTestedOn) + ' Disable the schedule in the workflow files (nightly.yml, my-options.yml), or run them by hand only.');
  o.push('- ' + box(!!inp.rollbackTestedOn) + ' In the Apps Script editor, run each installer once: ' + d.triggers.map((t) => '`' + t.trigger.installer + '`').join(', ') + '. Each installer skips if its trigger already exists.');
  o.push('- ' + box(!!inp.rollbackTestedOn) + ' Confirm the next morning that every legacy tab was refreshed, then switch the backend schedule back on.');

  o.push('', '### Menu items (' + d.menus.length + ')', '', '| Menu | Item | Legacy handler | Backend entry | Status |', '|---|---|---|---|---|');
  for (const m of d.menus) o.push('| ' + esc(m.menu) + ' | ' + esc(m.label) + ' | ' + m.handler + ' | ' + esc(m.entry) + ' | ' + m.status + (m.detail ? ' (' + esc(m.detail) + ')' : '') + ' |');
  return o.join('\n') + '\n';
}
