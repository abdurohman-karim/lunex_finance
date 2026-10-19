import { Prisma } from '../generated/prisma/client.js';
import { type BudgetInputs, computeBudget } from './budget-math.js';

const d = (value: number) => new Prisma.Decimal(value);

function inputs(overrides: Partial<BudgetInputs> = {}): BudgetInputs {
  return {
    incomeActual: d(0),
    incomePlanned: null,
    expensesBeforeToday: d(0),
    expensesToday: d(0),
    savedToGoals: d(0),
    savingsTarget: d(0),
    rollover: d(0),
    upcomingRecurring: d(0),
    totalLimit: null,
    daysLeft: 13,
    decimals: 0,
    ...overrides,
  };
}

const figures = (overrides: Partial<BudgetInputs>) => {
  const result = computeBudget(inputs(overrides));
  return {
    available: result.available.toNumber(),
    dailyLimit: result.dailyLimit.toNumber(),
    safeToSpendToday: result.safeToSpendToday.toNumber(),
    state: result.state,
  };
};

describe('computeBudget', () => {
  it('spreads what is left over the remaining days and subtracts today', () => {
    expect(
      figures({
        incomeActual: d(6_000_000),
        expensesBeforeToday: d(1_200_000),
        upcomingRecurring: d(1_500_000),
        expensesToday: d(50_000),
      }),
    ).toEqual({
      available: 3_300_000,
      dailyLimit: 253_846,
      safeToSpendToday: 203_846,
      state: 'ok',
    });
  });

  it('uses the larger of planned and actual income', () => {
    expect(
      figures({ incomePlanned: d(4_000_000), incomeActual: d(1_000_000) })
        .available,
    ).toBe(4_000_000);
    expect(
      figures({ incomePlanned: d(4_000_000), incomeActual: d(5_000_000) })
        .available,
    ).toBe(5_000_000);
  });

  it('reserves the savings target, or more if more was already saved', () => {
    expect(
      figures({ incomeActual: d(1_000_000), savingsTarget: d(200_000) })
        .available,
    ).toBe(800_000);
    expect(
      figures({
        incomeActual: d(1_000_000),
        savingsTarget: d(200_000),
        savedToGoals: d(300_000),
      }).available,
    ).toBe(700_000);
  });

  it('adds the rollover from last month', () => {
    expect(
      figures({ incomeActual: d(1_000_000), rollover: d(130_000) }).available,
    ).toBe(1_130_000);
  });

  it('takes the stricter of income and the total limit', () => {
    const result = figures({
      incomeActual: d(10_000_000),
      totalLimit: d(2_600_000),
      expensesBeforeToday: d(1_300_000),
    });
    expect(result.dailyLimit).toBe(100_000);
  });

  it('never suggests a negative daily limit, and reports overspending today', () => {
    expect(
      figures({
        incomeActual: d(100_000),
        expensesBeforeToday: d(500_000),
        expensesToday: d(20_000),
      }),
    ).toEqual({
      available: -400_000,
      dailyLimit: 0,
      safeToSpendToday: -20_000,
      state: 'overspent',
    });
  });

  it('rounds down to the currency precision', () => {
    expect(
      figures({ incomeActual: d(100), daysLeft: 3, decimals: 2 }).dailyLimit,
    ).toBe(33.33);
  });

  it('asks for income when there is none yet', () => {
    expect(figures({}).state).toBe('no_income');
    expect(figures({ totalLimit: d(1_000_000) }).state).toBe('ok');
  });

  it('counts the last day of the month as one full day', () => {
    expect(figures({ incomeActual: d(90_000), daysLeft: 1 }).dailyLimit).toBe(
      90_000,
    );
  });
});
