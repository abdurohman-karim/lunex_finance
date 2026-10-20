import { Prisma } from '../generated/prisma/client.js';

type Decimal = Prisma.Decimal;
const { Decimal } = Prisma;

/** Everything in the user's base currency, for the current budget month. */
export interface BudgetInputs {
  incomeActual: Decimal;
  /** Planned income of the budget, or the estimate from onboarding; null when unknown */
  incomePlanned: Decimal | null;
  expensesBeforeToday: Decimal;
  expensesToday: Decimal;
  /** Net goal contributions this month (deposits − withdrawals) */
  savedToGoals: Decimal;
  savingsTarget: Decimal;
  rollover: Decimal;
  /** Recurring expenses still to come from today to the end of the month */
  upcomingRecurring: Decimal;
  totalLimit: Decimal | null;
  /** Days left in the month, today included (≥ 1) */
  daysLeft: number;
  /** Decimal places of the base currency */
  decimals: number;
}

export type BudgetState = 'no_income' | 'ok' | 'overspent';

export interface BudgetFigures {
  incomeBasis: Decimal;
  reservedForSavings: Decimal;
  /** Left for the rest of the month, today included */
  available: Decimal;
  dailyLimit: Decimal;
  /** Negative when today's spending is over the daily limit */
  safeToSpendToday: Decimal;
  state: BudgetState;
}

/**
 * Spec «Бизнес-правила»:
 * available = max(planned, actual income) + rollover − savings − expenses before today − upcoming recurring;
 * daily limit = available ÷ days left (the smaller one when a total limit is set);
 * safe to spend today = daily limit − today's expenses.
 */
export function computeBudget(inputs: BudgetInputs): BudgetFigures {
  const zero = new Decimal(0);
  const days = Math.max(1, inputs.daysLeft);

  const incomeBasis = Decimal.max(
    inputs.incomeActual,
    inputs.incomePlanned ?? zero,
  );
  // A savings target reserves its amount up front; saving more than planned reserves what was saved.
  const reservedForSavings = Decimal.max(
    inputs.savingsTarget,
    inputs.savedToGoals,
  );
  const available = incomeBasis
    .plus(inputs.rollover)
    .minus(reservedForSavings)
    .minus(inputs.expensesBeforeToday)
    .minus(inputs.upcomingRecurring);

  let daily = available.dividedBy(days);
  if (inputs.totalLimit) {
    const withinLimit = inputs.totalLimit
      .minus(inputs.expensesBeforeToday)
      .minus(inputs.upcomingRecurring)
      .dividedBy(days);
    daily = Decimal.min(daily, withinLimit);
  }
  // Rounded down: the app never suggests spending money the user does not have.
  const dailyLimit = Decimal.max(zero, daily).toDecimalPlaces(
    inputs.decimals,
    Decimal.ROUND_DOWN,
  );
  const safeToSpendToday = dailyLimit.minus(inputs.expensesToday);

  const hasMoney =
    incomeBasis.plus(inputs.rollover).greaterThan(0) ||
    inputs.totalLimit !== null;
  return {
    incomeBasis,
    reservedForSavings,
    available,
    dailyLimit,
    safeToSpendToday,
    state: !hasMoney
      ? 'no_income'
      : safeToSpendToday.isNegative()
        ? 'overspent'
        : 'ok',
  };
}

/**
 * What a closed budget month leaves for the next one (spec: «перенос остатка»). Real money only:
 * the actual income, not the plan, plus what was carried in, minus net savings and spending.
 * With a total limit, no more than the limit left unspent. Never negative: an overspent month
 * carries nothing.
 */
export function budgetLeftover(inputs: {
  incomeActual: Decimal;
  rolloverIn: Decimal;
  savedToGoals: Decimal;
  expenses: Decimal;
  totalLimit: Decimal | null;
  decimals: number;
}): Decimal {
  const zero = new Decimal(0);
  let left = inputs.incomeActual
    .plus(inputs.rolloverIn)
    .minus(Decimal.max(zero, inputs.savedToGoals))
    .minus(inputs.expenses);
  if (inputs.totalLimit) {
    left = Decimal.min(left, inputs.totalLimit.minus(inputs.expenses));
  }
  return Decimal.max(zero, left).toDecimalPlaces(
    inputs.decimals,
    Decimal.ROUND_DOWN,
  );
}

/**
 * A monthly amount suggested from past months (limits in the budget wizard): the average over
 * `months`, rounded up to the currency's step so a typical month fits. Nothing without history.
 */
export function suggestedMonthly(
  total: Decimal,
  months: number,
  step: Decimal,
): Decimal {
  if (months <= 0 || total.lte(0)) return new Decimal(0);
  const average = total.dividedBy(months);
  return step.gt(0)
    ? average.dividedBy(step).ceil().times(step)
    : average.ceil();
}
