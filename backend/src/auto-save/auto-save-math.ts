import { addDays, type CalendarDate, clampedDate } from '../common/dates.js';
import { Prisma } from '../generated/prisma/client.js';

type Decimal = Prisma.Decimal;
const { Decimal } = Prisma;

/** When a fixed amount is set aside: every day, a weekday (1 = Monday) or a day of the month. */
export interface AutoSaveSchedule {
  frequency: 'daily' | 'weekly' | 'monthly';
  weekday: number | null;
  dayOfMonth: number | null;
}

/** 1 = Monday … 7 = Sunday. */
export function weekdayOf(date: CalendarDate): number {
  return ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

/** The first run on or after `from`; a day 29–31 is the last day of a shorter month. */
export function firstRunOnOrAfter(
  schedule: AutoSaveSchedule,
  from: CalendarDate,
): CalendarDate {
  switch (schedule.frequency) {
    case 'daily':
      return from;
    case 'weekly': {
      const weekday = schedule.weekday ?? 1;
      return addDays(from, (weekday - weekdayOf(from) + 7) % 7);
    }
    case 'monthly': {
      const [year, month] = from.split('-').map(Number);
      const wanted = schedule.dayOfMonth ?? 1;
      const thisMonth = clampedDate(year, month, wanted);
      if (thisMonth >= from) return thisMonth;
      return clampedDate(year, month + 1, wanted);
    }
  }
}

/** The run after `date`. */
export function nextRunAfter(
  schedule: AutoSaveSchedule,
  date: CalendarDate,
): CalendarDate {
  return firstRunOnOrAfter(schedule, addDays(date, 1));
}

/** What rounding an expense up to the step leaves over: 47 000 to 5 000 → 3 000; none when exact. */
export function roundUpChange(amount: Decimal, step: Decimal): Decimal {
  if (step.lte(0)) return new Decimal(0);
  const rounded = amount.dividedBy(step).ceil().times(step);
  return rounded.minus(amount);
}

/** `percent` of an income, rounded down to the currency's minor units. */
export function shareOf(
  amount: Decimal,
  percent: Decimal,
  decimals: number,
): Decimal {
  return amount
    .times(percent)
    .dividedBy(100)
    .toDecimalPlaces(decimals, Decimal.ROUND_DOWN);
}
