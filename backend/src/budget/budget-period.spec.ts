import { formulaCases } from '../../test/support/formula-cases.js';
import { budgetPeriod, daysLeftIn, periodDays } from './budget-period.js';

interface PeriodCase {
  name: string;
  today: string;
  payday: number;
  start: string;
  end: string;
  days: number;
  daysLeft: number;
}

const { cases } = formulaCases<{ cases: PeriodCase[] }>('budget-period');

describe('budgetPeriod (shared/formula-cases/budget-period.json)', () => {
  it.each(cases)('$name', ({ today, payday, start, end, days, daysLeft }) => {
    const period = budgetPeriod(today, payday);
    expect(period).toEqual({ start, end });
    expect(periodDays(period)).toBe(days);
    expect(daysLeftIn(period, today)).toBe(daysLeft);
  });
});
