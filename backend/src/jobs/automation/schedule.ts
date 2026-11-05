/**
 * installDailyTriggerV7 (fullStockAnalysisV10_9.gs:330-344) as DATA only.
 *
 * LEGACY VALUE, NOT THE NEW SCHEDULE. Apps Script ran runDailyAutomationV7 once a
 * day at "about 1 AM" in the Apps Script PROJECT's own time zone (a setting the code
 * cannot read; the legacy comment at :336-341 suspects Israel time). The user-approved
 * new nightly order (workflow cron) REPLACES this value; it is kept so the mapping is
 * complete and testable. The installer was idempotent: it did nothing if a trigger
 * for the handler already existed (the 20-trigger ceiling).
 */

export const DAILY_TRIGGER_HANDLER = 'runDailyAutomationV7';

export const LEGACY_DAILY_TRIGGER = {
  key: 'dailyAutomation.legacy',
  handler: DAILY_TRIGGER_HANDLER,
  installer: 'installDailyTriggerV7',
  everyDays: 1,
  atHour: 1,
  nearMinute: null,
  /** null = "the Apps Script project's own setting", which is not readable from code. */
  timeZone: null,
  idempotent: true,
  status: 'LEGACY_VALUE_TO_BE_REPLACED_BY_NEW_NIGHTLY_ORDER',
} as const;
