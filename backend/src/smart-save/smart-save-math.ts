import { Prisma } from '../generated/prisma/client.js';

type Decimal = Prisma.Decimal;
const { Decimal } = Prisma;

export type SmartSaveBlock =
  'no_spare_money' | 'too_small' | 'insufficient_balance';

export interface SmartSaveInputs {
  /** This budget month, in the base currency */
  incomeActual: Decimal;
  expensesTotal: Decimal;
  upcomingRecurring: Decimal;
  savedToGoals: Decimal;
  /** Days left in the month, today included */
  daysLeft: number;
  /** Share of the free money per day to suggest (app_settings.smart_save_share) */
  share: number;
  /** Goal-currency units per base-currency unit */
  rate: Decimal;
  /** Rounding step and minimum of the goal currency (UZS: 1000 and 1000) */
  step: Decimal;
  minimum: Decimal;
  /** Still to save for the goal, in its currency */
  goalRemaining: Decimal;
  /** Money on the account Smart Save takes from, in the goal currency; null when none is set */
  accountBalance: Decimal | null;
}

export interface SmartSaveFigures {
  /** Base currency */
  freeMoney: Decimal;
  perDay: Decimal;
  proposedBase: Decimal;
  /** Goal currency, after rounding and caps */
  amount: Decimal;
  cappedBy: 'goal_remaining' | 'account_balance' | null;
  block: SmartSaveBlock | null;
}

function floorToStep(value: Decimal, step: Decimal): Decimal {
  return step.lte(0) ? value : value.dividedBy(step).floor().times(step);
}

/**
 * Spec «Бизнес-правила», Smart Save: share × (month balance − upcoming payments −
 * already saved) ÷ days left, rounded down to the currency step, no more than the goal
 * still needs and no more than the account holds. Below the minimum it is «too small»,
 * unless it is exactly what finishes the goal.
 */
export function smartSaveAmount(inputs: SmartSaveInputs): SmartSaveFigures {
  const zero = new Decimal(0);
  const freeMoney = inputs.incomeActual
    .minus(inputs.expensesTotal)
    .minus(inputs.upcomingRecurring)
    .minus(Decimal.max(zero, inputs.savedToGoals));
  const perDay = freeMoney.dividedBy(Math.max(1, inputs.daysLeft));
  const proposedBase = perDay.times(inputs.share);

  if (freeMoney.lte(0)) {
    return {
      freeMoney,
      perDay,
      proposedBase,
      amount: zero,
      cappedBy: null,
      block: 'no_spare_money',
    };
  }

  let amount = floorToStep(proposedBase.times(inputs.rate), inputs.step);
  let cappedBy: SmartSaveFigures['cappedBy'] = null;
  if (amount.gt(inputs.goalRemaining)) {
    amount = inputs.goalRemaining;
    cappedBy = 'goal_remaining';
  }
  if (inputs.accountBalance !== null) {
    const affordable = Decimal.max(
      zero,
      floorToStep(inputs.accountBalance, inputs.step),
    );
    if (amount.gt(affordable)) {
      amount = affordable;
      cappedBy = 'account_balance';
    }
  }

  const finishesGoal = cappedBy === 'goal_remaining' && amount.gt(0);
  let block: SmartSaveBlock | null = null;
  if (amount.lt(inputs.minimum) && !finishesGoal) {
    block =
      cappedBy === 'account_balance' ? 'insufficient_balance' : 'too_small';
  }
  return { freeMoney, perDay, proposedBase, amount, cappedBy, block };
}
