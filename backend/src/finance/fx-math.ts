import { type CalendarDate, daysBetween } from '../common/dates.js';
import { Prisma } from '../generated/prisma/client.js';

type Decimal = Prisma.Decimal;
const { Decimal } = Prisma;

/** CBU publishes every rate against the sum, so cross rates go through UZS. */
export const PIVOT_CURRENCY = 'UZS';

/**
 * CBU publishes on working days; a week covers weekends and holidays.
 * An older rate would silently mis-value the operation, so it counts as missing.
 */
export const MAX_RATE_AGE_DAYS = 7;

/** 1 `base` = `rate` `quote`, set on `date`. */
export interface RateRow {
  base: string;
  quote: string;
  rate: Decimal;
  date: CalendarDate;
}

/**
 * How many `to` one `from` buys on `date`: the latest rate on or before the day and at most
 * a week old — direct, inverse, or through the sum. Null when none is known.
 * The app repeats this on the device (shared/formula-cases/fx.json).
 */
export function rateOn(
  rows: RateRow[],
  from: string,
  to: string,
  date: CalendarDate,
): Decimal | null {
  if (from === to) return new Decimal(1);
  const direct = latest(rows, from, to, date);
  if (direct) return direct;
  const inverse = latest(rows, to, from, date);
  if (inverse) return new Decimal(1).dividedBy(inverse);
  if (from === PIVOT_CURRENCY || to === PIVOT_CURRENCY) return null;
  const fromPivot = rateOn(rows, from, PIVOT_CURRENCY, date);
  const toPivot = rateOn(rows, to, PIVOT_CURRENCY, date);
  return fromPivot && toPivot ? fromPivot.dividedBy(toPivot) : null;
}

function latest(
  rows: RateRow[],
  base: string,
  quote: string,
  date: CalendarDate,
): Decimal | null {
  let best: RateRow | null = null;
  for (const row of rows) {
    if (row.base !== base || row.quote !== quote || row.date > date) continue;
    if (daysBetween(row.date, date) > MAX_RATE_AGE_DAYS) continue;
    if (!best || row.date > best.date) best = row;
  }
  return best?.rate ?? null;
}
