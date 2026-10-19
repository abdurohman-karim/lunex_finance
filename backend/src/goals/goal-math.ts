import { type CalendarDate, daysBetween } from '../common/dates.js';
import { Prisma } from '../generated/prisma/client.js';

type Decimal = Prisma.Decimal;
const { Decimal } = Prisma;

export const MILESTONES = [25, 50, 75, 100] as const;

/** Spec «Бизнес-правила»: progress = ⌊saved ÷ target × 100⌋. */
export function progressPercent(saved: Decimal, target: Decimal): number {
  if (target.lte(0)) return 0;
  return Math.max(0, saved.dividedBy(target).times(100).floor().toNumber());
}

/** Milestones the progress has reached. */
export function reachedMilestones(percent: number): number[] {
  return MILESTONES.filter((milestone) => percent >= milestone);
}

export type ScheduleStatus = 'on_track' | 'behind' | 'ahead';

export interface GoalSchedule {
  /** Needed contribution to finish by the deadline, rounded up to the currency */
  perDay: Decimal;
  perWeek: Decimal;
  perMonth: Decimal;
  /** What a steady pace from the goal's start would have saved by today */
  expectedSaved: Decimal;
  status: ScheduleStatus;
  /** Days until the deadline, today included; 0 when it has passed */
  daysLeft: number;
}

/** Within ±5 % of the target from the steady pace counts as «В графике». */
export const SCHEDULE_TOLERANCE = 0.05;

/**
 * Contribution plan for a goal with a deadline: (target − saved) ÷ periods left,
 * and «В графике / Отстаёт / Опережает» against a straight line from the start date.
 * Null without a deadline or once the target is reached.
 */
export function goalSchedule(input: {
  target: Decimal;
  saved: Decimal;
  startedOn: CalendarDate;
  deadline: CalendarDate | null;
  today: CalendarDate;
  decimals: number;
}): GoalSchedule | null {
  if (!input.deadline || input.saved.gte(input.target)) {
    return null;
  }
  const remaining = input.target.minus(input.saved);
  const daysLeft = Math.max(0, daysBetween(input.today, input.deadline) + 1);
  const roundUp = (value: Decimal) =>
    value.toDecimalPlaces(input.decimals, Decimal.ROUND_UP);
  const per = (days: number) =>
    roundUp(remaining.dividedBy(Math.max(1, Math.ceil(daysLeft / days))));

  const totalDays = Math.max(1, daysBetween(input.startedOn, input.deadline));
  const elapsed = Math.min(
    totalDays,
    Math.max(0, daysBetween(input.startedOn, input.today)),
  );
  const expectedSaved = input.target.times(elapsed).dividedBy(totalDays);
  const tolerance = input.target.times(SCHEDULE_TOLERANCE);

  const status: ScheduleStatus = input.saved.lt(expectedSaved.minus(tolerance))
    ? 'behind'
    : input.saved.gt(expectedSaved.plus(tolerance))
      ? 'ahead'
      : 'on_track';

  return {
    perDay: per(1),
    perWeek: per(7),
    perMonth: per(30),
    expectedSaved: expectedSaved.toDecimalPlaces(input.decimals),
    status: daysLeft === 0 ? 'behind' : status,
    daysLeft,
  };
}
