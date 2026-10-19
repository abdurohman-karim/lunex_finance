import { budgetPeriod } from '../budget/budget-period.js';
import {
  occurrencesBetween,
  type RecurrenceRule,
} from '../finance/recurrence.js';
import {
  addDays,
  clampedDate,
  daysBetween,
  localDate,
  startOfLocalDay,
} from './dates.js';

describe('calendar dates', () => {
  it('adds days across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-10-19', '2026-10-31')).toBe(12);
  });

  it('clamps paydays to the end of shorter months and normalises month overflow', () => {
    expect(clampedDate(2026, 2, 31)).toBe('2026-02-28');
    expect(clampedDate(2028, 2, 31)).toBe('2028-02-29');
    expect(clampedDate(2026, 13, 5)).toBe('2027-01-05');
    expect(clampedDate(2026, 0, 31)).toBe('2025-12-31');
  });

  it('finds when a day starts in the user time zone', () => {
    expect(startOfLocalDay('2026-10-19', 'Asia/Tashkent').toISOString()).toBe(
      '2026-10-18T19:00:00.000Z',
    );
    expect(startOfLocalDay('2026-10-19', 'UTC').toISOString()).toBe(
      '2026-10-19T00:00:00.000Z',
    );
    // DST: New York starts EDT on 8 March and returns to EST on 1 November 2026.
    expect(
      startOfLocalDay('2026-03-08', 'America/New_York').toISOString(),
    ).toBe('2026-03-08T05:00:00.000Z');
    expect(
      startOfLocalDay('2026-03-09', 'America/New_York').toISOString(),
    ).toBe('2026-03-09T04:00:00.000Z');
    expect(
      startOfLocalDay('2026-11-01', 'America/New_York').toISOString(),
    ).toBe('2026-11-01T04:00:00.000Z');
    expect(
      localDate(
        startOfLocalDay('2026-10-19', 'Asia/Tashkent'),
        'Asia/Tashkent',
      ),
    ).toBe('2026-10-19');
  });
});

describe('budgetPeriod', () => {
  it('is the calendar month when the payday is the 1st', () => {
    expect(budgetPeriod('2026-10-19', 1)).toEqual({
      start: '2026-10-01',
      end: '2026-10-31',
    });
  });

  it('runs from payday to the day before the next payday', () => {
    expect(budgetPeriod('2026-10-19', 10)).toEqual({
      start: '2026-10-10',
      end: '2026-11-09',
    });
    expect(budgetPeriod('2026-10-05', 10)).toEqual({
      start: '2026-09-10',
      end: '2026-10-09',
    });
  });

  it('moves a payday on the 31st to the last day of short months', () => {
    expect(budgetPeriod('2026-02-28', 31)).toEqual({
      start: '2026-02-28',
      end: '2026-03-30',
    });
    expect(budgetPeriod('2026-02-27', 31)).toEqual({
      start: '2026-01-31',
      end: '2026-02-27',
    });
  });
});

describe('occurrencesBetween', () => {
  const rule = (overrides: Partial<RecurrenceRule>): RecurrenceRule => ({
    frequency: 'monthly',
    interval: 1,
    dayOfMonth: null,
    startOn: '2026-01-31',
    endOn: null,
    nextRunOn: '2026-01-31',
    ...overrides,
  });

  it('keeps a monthly rule on its day, using the last day of short months', () => {
    expect(occurrencesBetween(rule({}), '2026-01-01', '2026-04-30')).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ]);
  });

  it('starts from the next pending run and stops at the end date', () => {
    const weekly = rule({
      frequency: 'weekly',
      startOn: '2026-10-05',
      nextRunOn: '2026-10-19',
      endOn: '2026-10-30',
    });
    expect(occurrencesBetween(weekly, '2026-10-01', '2026-12-31')).toEqual([
      '2026-10-19',
      '2026-10-26',
    ]);
  });

  it('skips runs before the window and honours the interval', () => {
    const everyTwoDays = rule({
      frequency: 'daily',
      interval: 2,
      startOn: '2026-10-15',
      nextRunOn: '2026-10-15',
    });
    expect(
      occurrencesBetween(everyTwoDays, '2026-10-18', '2026-10-22'),
    ).toEqual(['2026-10-19', '2026-10-21']);
  });

  it('handles yearly rules on 29 February', () => {
    const leap = rule({
      frequency: 'yearly',
      startOn: '2028-02-29',
      nextRunOn: '2029-02-28',
      dayOfMonth: 29,
    });
    expect(occurrencesBetween(leap, '2029-01-01', '2032-12-31')).toEqual([
      '2029-02-28',
      '2030-02-28',
      '2031-02-28',
      '2032-02-29',
    ]);
  });
});
