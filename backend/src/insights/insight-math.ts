import { Prisma } from '../generated/prisma/client.js';

type Decimal = Prisma.Decimal;
const { Decimal } = Prisma;

/** An income or expense in the base currency, its category folded into the top-level one. */
export interface Operation {
  type: 'income' | 'expense';
  amount: Decimal;
  /** Top-level category; null without one */
  categoryId: string | null;
  /** `YYYY-MM-DD` in the user's time zone */
  date: string;
}

export interface CategoryLine {
  categoryId: string | null;
  amount: Decimal;
  previous: Decimal;
  /** Rounded; null when the period before had nothing */
  changePercent: number | null;
}

export interface PeriodReport {
  income: Decimal;
  expense: Decimal;
  previousIncome: Decimal;
  previousExpense: Decimal;
  expenseChangePercent: number | null;
  /** Spending by category, largest first */
  categories: CategoryLine[];
  /** Spending of each day of the period, in order */
  days: { date: string; expense: Decimal }[];
  /** The category that grew the most against the period before, which had spending in it */
  biggestIncrease: CategoryLine | null;
}

/** Rounded percent from `old` to `now`; null when `old` is nothing. */
export function percentChange(now: Decimal, old: Decimal): number | null {
  if (old.lte(0)) return null;
  return now.minus(old).dividedBy(old).times(100).round().toNumber();
}

/** A week or a month in numbers against the one before (spec: «Еженедельный и месячный отчёт»). */
export function periodReport(
  current: Operation[],
  previous: Operation[],
  days: string[],
): PeriodReport {
  const sum = (ops: Operation[], type: Operation['type']) =>
    ops
      .filter((op) => op.type === type)
      .reduce((total, op) => total.plus(op.amount), new Decimal(0));
  const byCategory = (ops: Operation[]) => {
    const map = new Map<string | null, Decimal>();
    for (const op of ops) {
      if (op.type !== 'expense') continue;
      map.set(
        op.categoryId,
        (map.get(op.categoryId) ?? new Decimal(0)).plus(op.amount),
      );
    }
    return map;
  };

  const now = byCategory(current);
  const before = byCategory(previous);
  const categories = [...new Set([...now.keys(), ...before.keys()])]
    .map((categoryId): CategoryLine => {
      const amount = now.get(categoryId) ?? new Decimal(0);
      const prev = before.get(categoryId) ?? new Decimal(0);
      return {
        categoryId,
        amount,
        previous: prev,
        changePercent: percentChange(amount, prev),
      };
    })
    .filter((line) => line.amount.gt(0))
    .sort((a, b) => b.amount.comparedTo(a.amount));

  const perDay = new Map<string, Decimal>();
  for (const op of current) {
    if (op.type !== 'expense') continue;
    perDay.set(
      op.date,
      (perDay.get(op.date) ?? new Decimal(0)).plus(op.amount),
    );
  }

  // Growth needs a period before to grow from; a category new this period is not «выросла».
  const increases = categories.filter(
    (line) => line.previous.gt(0) && line.amount.gt(line.previous),
  );
  const biggestIncrease =
    increases.sort((a, b) =>
      b.amount.minus(b.previous).comparedTo(a.amount.minus(a.previous)),
    )[0] ?? null;

  const expense = sum(current, 'expense');
  const previousExpense = sum(previous, 'expense');
  return {
    income: sum(current, 'income'),
    expense,
    previousIncome: sum(previous, 'income'),
    previousExpense,
    expenseChangePercent: percentChange(expense, previousExpense),
    categories,
    days: days.map((date) => ({
      date,
      expense: perDay.get(date) ?? new Decimal(0),
    })),
    biggestIncrease,
  };
}

export function median(values: Decimal[]): Decimal | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : sorted[middle - 1].plus(sorted[middle]).dividedBy(2);
}

/** Expenses of the category in the 90 days before needed to tell what is usual. */
export const ANOMALY_MIN_HISTORY = 3;
export const ANOMALY_FACTOR = 3;
export const ANOMALY_WINDOW_DAYS = 90;

/**
 * Spec: «трата больше трёх медиан категории за 90 дней». Needs a few expenses of the category
 * before it to know what is usual; null when the expense is not unusual.
 */
export function anomaly(
  amount: Decimal,
  history: Decimal[],
): { median: Decimal; ratio: number } | null {
  if (history.length < ANOMALY_MIN_HISTORY) return null;
  const usual = median(history);
  if (!usual || usual.lte(0)) return null;
  if (amount.lte(usual.times(ANOMALY_FACTOR))) return null;
  return {
    median: usual,
    ratio: amount.dividedBy(usual).toDecimalPlaces(1).toNumber(),
  };
}

export interface ForecastInput {
  spent: Decimal;
  upcomingRecurring: Decimal;
  daysTotal: number;
  /** Today included */
  daysLeft: number;
  /** The total limit, else the income basis less the savings target; null when unknown */
  plan: Decimal | null;
  decimals: number;
}

export interface Forecast {
  forecast: Decimal;
  plan: Decimal | null;
  /** Positive: over the plan by this much at the month's end */
  overBy: Decimal | null;
  verdict: 'over' | 'within' | 'unknown';
}

/**
 * Spending by the month's end at this month's pace, recurring payments still due included
 * (the app's figure on the budget screen), against the plan.
 */
export function budgetForecast(input: ForecastInput): Forecast {
  const elapsed = Math.max(1, input.daysTotal - input.daysLeft + 1);
  const forecast = input.spent
    .dividedBy(elapsed)
    .times(input.daysTotal)
    .plus(input.upcomingRecurring)
    .toDecimalPlaces(input.decimals);
  if (input.plan === null || input.plan.lte(0)) {
    return { forecast, plan: null, overBy: null, verdict: 'unknown' };
  }
  const overBy = forecast.minus(input.plan);
  return {
    forecast,
    plan: input.plan,
    overBy,
    verdict: overBy.gt(0) ? 'over' : 'within',
  };
}

/**
 * The goal analysis score, 0–100: with a deadline, how far savings are against the steady
 * pace (on pace = 85, a fifth ahead or more = 100, behind falls in proportion); without one,
 * progress and how many of the last three months had deposits. A reached goal is 100.
 */
export function goalScore(input: {
  progress: number;
  saved: Decimal;
  /** What the steady pace would have saved by today; null without a deadline */
  expectedSaved: Decimal | null;
  /** Of the last three months */
  monthsWithDeposits: number;
}): number {
  if (input.progress >= 100) return 100;
  const clamp = (value: number) =>
    Math.min(100, Math.max(0, Math.round(value)));
  if (input.expectedSaved !== null) {
    if (input.expectedSaved.lte(0)) return input.saved.gt(0) ? 90 : 70;
    const pace = input.saved.dividedBy(input.expectedSaved).toNumber();
    return clamp(85 * pace);
  }
  return clamp(
    30 +
      input.progress * 0.4 +
      Math.min(3, Math.max(0, input.monthsWithDeposits)) * 10,
  );
}
