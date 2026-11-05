/**
 * GENERIC_PLAN P2: the paper test's dates from the profile (`paper.start`, `paper.end`).
 *   start       the profile's start day ('' when the profile has none: paper/paperJob.ts then refuses with a plain line;
 *               starting on the first night is P8 work)
 *   end         the profile's end day, or one year after the start
 *   decideFrom  the trading day before the start: decisions only, so the first buys fill at the start day's open
 */

import { previousTradingDay } from '../live/marketCalendar.ts';
import type { Profile } from './schema.ts';

export interface PaperDates { readonly start: string; readonly end: string; readonly decideFrom: string }

export function paperDatesOf(p: Profile): PaperDates {
  const start = p.paper.start;
  if (!start) return { start: '', end: '', decideFrom: '' };
  const end = p.paper.end ?? String(Number(start.slice(0, 4)) + 1) + start.slice(4);
  return { start, end, decideFrom: previousTradingDay(start) };
}
