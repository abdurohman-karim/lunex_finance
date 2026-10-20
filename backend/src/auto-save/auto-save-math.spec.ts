import { Prisma } from '../generated/prisma/client.js';
import {
  firstRunOnOrAfter,
  nextRunAfter,
  roundUpChange,
  shareOf,
  weekdayOf,
} from './auto-save-math.js';

const d = (value: string) => new Prisma.Decimal(value);

describe('auto-save schedule', () => {
  it('runs daily from the day itself', () => {
    const daily = {
      frequency: 'daily' as const,
      weekday: null,
      dayOfMonth: null,
    };
    expect(firstRunOnOrAfter(daily, '2026-10-20')).toBe('2026-10-20');
    expect(nextRunAfter(daily, '2026-10-20')).toBe('2026-10-21');
  });

  it('runs weekly on its weekday', () => {
    // 20 October 2026 is a Tuesday.
    expect(weekdayOf('2026-10-20')).toBe(2);
    const mondays = {
      frequency: 'weekly' as const,
      weekday: 1,
      dayOfMonth: null,
    };
    expect(firstRunOnOrAfter(mondays, '2026-10-20')).toBe('2026-10-26');
    expect(firstRunOnOrAfter(mondays, '2026-10-26')).toBe('2026-10-26');
    expect(nextRunAfter(mondays, '2026-10-26')).toBe('2026-11-02');
  });

  it('runs monthly on its day, the last day of a shorter month', () => {
    const payday = {
      frequency: 'monthly' as const,
      weekday: null,
      dayOfMonth: 25,
    };
    expect(firstRunOnOrAfter(payday, '2026-10-20')).toBe('2026-10-25');
    expect(nextRunAfter(payday, '2026-10-25')).toBe('2026-11-25');
    const last = {
      frequency: 'monthly' as const,
      weekday: null,
      dayOfMonth: 31,
    };
    expect(firstRunOnOrAfter(last, '2027-02-01')).toBe('2027-02-28');
    expect(nextRunAfter(last, '2027-02-28')).toBe('2027-03-31');
    expect(nextRunAfter(last, '2026-12-31')).toBe('2027-01-31');
  });
});

describe('auto-save amounts', () => {
  it('keeps the change of rounding an expense up', () => {
    expect(roundUpChange(d('47000'), d('5000')).toString()).toBe('3000');
    expect(roundUpChange(d('47300'), d('1000')).toString()).toBe('700');
    expect(roundUpChange(d('50000'), d('10000')).toString()).toBe('0');
    expect(roundUpChange(d('12.30'), d('1')).toString()).toBe('0.7');
  });

  it('takes a share of an income, rounded down', () => {
    expect(shareOf(d('8000000'), d('10'), 0).toString()).toBe('800000');
    expect(shareOf(d('1234567'), d('7.5'), 0).toString()).toBe('92592');
    expect(shareOf(d('99.99'), d('15'), 2).toString()).toBe('14.99');
  });
});
