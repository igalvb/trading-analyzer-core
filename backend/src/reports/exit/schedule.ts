/**
 * FL-7f: installExitStrategyTriggerV1 (fullStockAnalysisV10_9.gs:10515-10524) as DATA, and the menu mapping.
 *
 * NOTE: the schedule value below (daily, about 01:00) is the LEGACY value. The user approved a new nightly order, so
 * the workflow generator must NOT copy it; it only reads handler/installer names from here. Legacy fired
 * atHour(1) in the Apps Script project time zone (America/New_York per the SCRIPT_TIME_ZONE decision), although the
 * user's own comment asked for 1am Israel time (userStatedTimeZone).
 */
import type { EntryPoint } from '../options/ui.ts';
import { activeProfile } from '../../profile/active.ts';
export const EXIT_STRATEGY_LEGACY_TRIGGER = {
  handler: 'buildExitStrategyReportV7', installer: 'installExitStrategyTriggerV1', menuHandler: 'buildExitStrategyReportV7Menu',
  frequency: 'daily', everyDays: 1, atHour: 1, approximate: true, timeZone: 'America/New_York', userStatedTimeZone: activeProfile().user.timeZone,
  status: 'LEGACY_VALUE_TO_BE_REPLACED',
} as const;
export interface TriggerInstallPlan { readonly install: boolean; readonly chain: readonly string[]; readonly log: string }
/** The installer's logic (idempotent per handler name) as a pure plan; legacy log text and ScriptApp call chain. */
export function planExitStrategyTriggerInstall(existingHandlers: readonly string[]): TriggerInstallPlan {
  const h = EXIT_STRATEGY_LEGACY_TRIGGER.handler;
  const n = existingHandlers.filter((x) => x === h).length;
  if (n > 0) return { install: false, chain: [], log: 'Exit Strategy trigger already installed (' + n + ' found) — not adding another.' };
  return { install: true, chain: ['newTrigger:' + h, 'timeBased', 'everyDays:1', 'atHour:1', 'create'], log: 'Exit Strategy trigger installed: ' + h + ' at ~1:00 AM (project time zone).' };
}
export const EXIT_REPORT_ENTRY_POINTS: Readonly<Record<string, EntryPoint>> = {
  buildExitStrategyReportV7Menu: { entry: 'cli: exit-report', ported: 'app/menuCommands.ts: the nightly exit.report job alone (Exit pipeline -> Exit Report tab)', note: 'the menu wrapper only called buildExitStrategyReportV7; the old Exit Strategy tab writer was removed (owner 2026-11-04)' },
  buildExitStrategyReportV7: { entry: 'workflow: nightly step + cli: exit-report', ported: 'jobs/exit (Exit pipeline -> reports/exitSheet, the Exit Report tab)', note: 'the trigger handler; the schedule is workflow data. The old Exit Strategy tab writer was removed (owner 2026-11-04)' },
  installExitStrategyTriggerV1: { entry: 'workflow: nightly cron (schedule set by the workflow generator)', ported: 'FL-7f reports/exit/schedule.ts EXIT_STRATEGY_LEGACY_TRIGGER', note: 'legacy 01:00 is a superseded value; trigger installer -> declarative cron' },
};
