import { type CalendarDate, addDays, clampedDate } from '../common/dates.js';
import type { RecurrenceFrequency } from '../generated/prisma/enums.js';

export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  /** Every N periods */
  interval: number;
  /** Monthly/yearly anchor day; 29–31 fall back to the last day of shorter months */
  dayOfMonth: number | null;
  startOn: CalendarDate;
  endOn: CalendarDate | null;
  /** The next occurrence not created yet */
  nextRunOn: CalendarDate;
}

/** Protects against a broken rule (e.g. interval 0) looping forever. */
const MAX_OCCURRENCES = 1000;

/** Occurrence after `date` for the rule's frequency. */
export function nextOccurrence(
  rule: RecurrenceRule,
  date: CalendarDate,
): CalendarDate {
  const step = Math.max(1, rule.interval);
  const [year, month] = date.split('-').map(Number);
  // Anchor on the rule's day, not the previous occurrence: Jan 31 → Feb 28 → Mar 31, not Mar 28.
  const anchorDay = rule.dayOfMonth ?? Number(rule.startOn.slice(8, 10));
  switch (rule.frequency) {
    case 'daily':
      return addDays(date, step);
    case 'weekly':
      return addDays(date, 7 * step);
    case 'monthly':
      return clampedDate(year, month + step, anchorDay);
    case 'yearly':
      return clampedDate(year + step, month, anchorDay);
  }
}

/** Pending occurrences of a rule within [from, to], starting from its next run. */
export function occurrencesBetween(
  rule: RecurrenceRule,
  from: CalendarDate,
  to: CalendarDate,
): CalendarDate[] {
  const result: CalendarDate[] = [];
  let date = rule.nextRunOn;
  for (let i = 0; i < MAX_OCCURRENCES && date <= to; i++) {
    if (rule.endOn && date > rule.endOn) break;
    if (date >= from) result.push(date);
    date = nextOccurrence(rule, date);
  }
  return result;
}
