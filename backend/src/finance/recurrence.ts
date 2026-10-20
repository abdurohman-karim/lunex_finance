import {
  type CalendarDate,
  addDays,
  clampedDate,
  daysBetween,
} from '../common/dates.js';
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

/** What fixes a rule's run days, without its progress. */
export type RecurrenceSchedule = Pick<
  RecurrenceRule,
  'frequency' | 'interval' | 'dayOfMonth' | 'startOn'
>;

/**
 * The rule's first run on or after `from`, counted from its start: a new rule's next run.
 * A monthly or yearly rule runs on its own day, so a payment day before the start's day
 * begins the next month (or year).
 */
export function firstOnOrAfter(
  rule: RecurrenceSchedule,
  from: CalendarDate,
): CalendarDate {
  const step = Math.max(1, rule.interval);
  const [year, month] = rule.startOn.split('-').map(Number);
  const anchorDay = rule.dayOfMonth ?? Number(rule.startOn.slice(8, 10));
  let first = rule.startOn;
  if (rule.frequency === 'monthly' || rule.frequency === 'yearly') {
    first = clampedDate(year, month, anchorDay);
    if (first < rule.startOn) {
      first =
        rule.frequency === 'monthly'
          ? clampedDate(year, month + 1, anchorDay)
          : clampedDate(year + 1, month, anchorDay);
    }
  }
  if (first >= from) return first;

  if (rule.frequency === 'daily' || rule.frequency === 'weekly') {
    const days = (rule.frequency === 'daily' ? 1 : 7) * step;
    return addDays(first, Math.ceil(daysBetween(first, from) / days) * days);
  }
  let date = first;
  for (let i = 0; i < MAX_OCCURRENCES && date < from; i++) {
    date = nextOccurrence({ ...rule, endOn: null, nextRunOn: date }, date);
  }
  return date;
}
