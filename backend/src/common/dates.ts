/**
 * Calendar dates are `YYYY-MM-DD` strings; they compare correctly as strings.
 * Arithmetic on them runs in UTC, where every day has 24 hours.
 */
export type CalendarDate = string;

const DAY_MS = 24 * 60 * 60 * 1000;

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const clockFormatters = new Map<string, Intl.DateTimeFormat>();

/** Calendar date of an instant in a time zone, e.g. Asia/Tashkent. */
export function localDate(instant: Date, timeZone: string): CalendarDate {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    // en-CA formats dates as YYYY-MM-DD.
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateFormatters.set(timeZone, formatter);
  }
  return formatter.format(instant);
}

/** Offset of the time zone from UTC at an instant, in milliseconds (Tashkent: +5 h). */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  let formatter = clockFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    clockFormatters.set(timeZone, formatter);
  }
  const part = (type: string) =>
    Number(
      formatter.formatToParts(instant).find((p) => p.type === type)?.value,
    );
  const wallClockAsUtc = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return wallClockAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Hour (0–23) on the wall clock of a time zone. */
export function localHour(instant: Date, timeZone: string): number {
  return new Date(
    instant.getTime() + zoneOffsetMs(instant, timeZone),
  ).getUTCHours();
}

/** The instant a calendar day starts in a time zone (DST-aware). */
export function startOfLocalDay(date: CalendarDate, timeZone: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const midnightUtc = Date.UTC(year, month - 1, day);
  const firstGuess =
    midnightUtc - zoneOffsetMs(new Date(midnightUtc), timeZone);
  // Re-check at the guess: the offset may differ there when DST switches that night.
  return new Date(midnightUtc - zoneOffsetMs(new Date(firstGuess), timeZone));
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** Whole days from `from` to `to` (`to` − `from`). */
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  const ms = (date: CalendarDate) => {
    const [year, month, day] = date.split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((ms(to) - ms(from)) / DAY_MS);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** `day` of the given month, moved to the last day when the month is shorter (31 → 30, 28…). */
export function clampedDate(
  year: number,
  month: number,
  day: number,
): CalendarDate {
  // Normalise month overflow such as 13 → January of the next year.
  const normalized = new Date(Date.UTC(year, month - 1, 1));
  const y = normalized.getUTCFullYear();
  const m = normalized.getUTCMonth() + 1;
  const d = Math.min(day, daysInMonth(y, m));
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** A calendar date as the UTC midnight Prisma uses for `@db.Date` columns. */
export function asDbDate(date: CalendarDate): Date {
  return new Date(`${date}T00:00:00.000Z`);
}
