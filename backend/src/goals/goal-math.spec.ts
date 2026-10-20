import {
  type Money,
  formulaCases,
  money,
  plain,
} from '../../test/support/formula-cases.js';
import {
  type GoalSchedule,
  goalSchedule,
  progressPercent,
  reachedMilestones,
} from './goal-math.js';

interface ScheduleInputs {
  target: Money;
  saved: Money;
  startedOn: string;
  deadline: string | null;
  today: string;
  decimals: number;
}

type ScheduleSums = 'perDay' | 'perWeek' | 'perMonth' | 'expectedSaved';

interface GoalCases {
  progress: {
    saved: Money;
    target: Money;
    percent: number;
    milestones: number[];
  }[];
  scheduleDefaults: Omit<ScheduleInputs, 'saved'>;
  schedule: {
    name: string;
    inputs: Partial<ScheduleInputs>;
    expected:
      | (Partial<Record<ScheduleSums, Money>> &
          Partial<Pick<GoalSchedule, 'daysLeft' | 'status'>>)
      | null;
  }[];
}

const cases = formulaCases<GoalCases>('goals');

describe('progress and milestones (shared/formula-cases/goals.json)', () => {
  it.each(cases.progress)(
    '$saved of $target is $percent %',
    ({ saved, target, percent, milestones }) => {
      const progress = progressPercent(money(saved), money(target));
      expect(progress).toBe(percent);
      expect(reachedMilestones(progress)).toEqual(milestones);
    },
  );
});

describe('goalSchedule (shared/formula-cases/goals.json)', () => {
  it.each(cases.schedule)('$name', ({ inputs, expected }) => {
    const values = {
      ...cases.scheduleDefaults,
      saved: '0',
      ...inputs,
    } as ScheduleInputs;
    const schedule = goalSchedule({
      ...values,
      target: money(values.target),
      saved: money(values.saved),
    });
    if (expected === null) {
      expect(schedule).toBeNull();
      return;
    }
    expect(schedule).not.toBeNull();
    const { daysLeft, status, ...sums } = expected;
    if (daysLeft !== undefined) expect(schedule!.daysLeft).toBe(daysLeft);
    if (status) expect(schedule!.status).toBe(status);
    for (const [key, value] of Object.entries(sums)) {
      expect(plain(schedule![key as ScheduleSums]), key).toBe(plain(value));
    }
  });
});
