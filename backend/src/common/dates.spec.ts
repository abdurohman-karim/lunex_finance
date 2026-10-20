import {
  addDays,
  clampedDate,
  daysBetween,
  localDate,
  localHour,
  startOfLocalDay,
} from './dates.js';

describe('calendar dates', () => {
  it('reads the wall-clock hour in a time zone', () => {
    const instant = new Date('2026-10-19T03:30:00Z');
    expect(localHour(instant, 'Asia/Tashkent')).toBe(8);
    expect(localHour(instant, 'UTC')).toBe(3);
    expect(localHour(instant, 'Etc/GMT+5')).toBe(22);
  });

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
