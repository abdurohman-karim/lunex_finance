import { Prisma } from '../generated/prisma/client.js';
import {
  goalSchedule,
  progressPercent,
  reachedMilestones,
} from './goal-math.js';

const d = (value: number) => new Prisma.Decimal(value);

describe('progress and milestones', () => {
  it('floors the percentage', () => {
    expect(progressPercent(d(2_499_999), d(10_000_000))).toBe(24);
    expect(progressPercent(d(2_500_000), d(10_000_000))).toBe(25);
    expect(progressPercent(d(10_500_000), d(10_000_000))).toBe(105);
    expect(progressPercent(d(0), d(0))).toBe(0);
  });

  it('lists the milestones reached', () => {
    expect(reachedMilestones(24)).toEqual([]);
    expect(reachedMilestones(74)).toEqual([25, 50]);
    expect(reachedMilestones(105)).toEqual([25, 50, 75, 100]);
  });
});

describe('goalSchedule', () => {
  const base = {
    target: d(12_000_000),
    startedOn: '2026-01-01',
    deadline: '2026-12-31',
    today: '2026-07-02',
    decimals: 0,
  };

  it('is null without a deadline or when the goal is reached', () => {
    expect(goalSchedule({ ...base, saved: d(0), deadline: null })).toBeNull();
    expect(goalSchedule({ ...base, saved: d(12_000_000) })).toBeNull();
  });

  it('splits what is left over the remaining days, weeks and months, rounding up', () => {
    const schedule = goalSchedule({ ...base, saved: d(6_000_000) })!;
    // 183 days left (2 July – 31 December), 27 weeks, 7 thirty-day months.
    expect(schedule.daysLeft).toBe(183);
    expect(schedule.perDay.toNumber()).toBe(32_787);
    expect(schedule.perWeek.toNumber()).toBe(222_223);
    expect(schedule.perMonth.toNumber()).toBe(857_143);
  });

  it('compares the savings with a steady pace, with 5 % of the target as tolerance', () => {
    // 182 of 364 days have passed: a steady pace has saved 6 000 000; tolerance is 600 000.
    expect(goalSchedule({ ...base, saved: d(6_000_000) })!.status).toBe(
      'on_track',
    );
    expect(goalSchedule({ ...base, saved: d(5_500_000) })!.status).toBe(
      'on_track',
    );
    expect(goalSchedule({ ...base, saved: d(5_300_000) })!.status).toBe(
      'behind',
    );
    expect(goalSchedule({ ...base, saved: d(7_000_000) })!.status).toBe(
      'ahead',
    );
  });

  it('asks for everything that is left once the deadline has passed', () => {
    const late = goalSchedule({
      ...base,
      saved: d(11_000_000),
      today: '2027-01-15',
    })!;
    expect(late).toMatchObject({ daysLeft: 0, status: 'behind' });
    expect(late.perDay.toNumber()).toBe(1_000_000);
  });
});
