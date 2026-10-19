import { type CalendarDate, addDays, clampedDate } from '../common/dates.js';

export interface BudgetPeriod {
  start: CalendarDate;
  /** Inclusive */
  end: CalendarDate;
}

/**
 * The budget month containing `today`. It starts on the user's payday
 * (`month_starts_on_day`); in shorter months the payday moves to the last day.
 */
export function budgetPeriod(
  today: CalendarDate,
  startDay: number,
): BudgetPeriod {
  const [year, month] = today.split('-').map(Number);
  const startThisMonth = clampedDate(year, month, startDay);
  const start =
    today >= startThisMonth
      ? startThisMonth
      : clampedDate(year, month - 1, startDay);

  const [startYear, startMonth] = start.split('-').map(Number);
  const nextStart = clampedDate(startYear, startMonth + 1, startDay);
  return { start, end: addDays(nextStart, -1) };
}
