import { Prisma } from '../generated/prisma/client.js';
import { type SmartSaveInputs, smartSaveAmount } from './smart-save-math.js';

const d = (value: number) => new Prisma.Decimal(value);

function inputs(overrides: Partial<SmartSaveInputs> = {}): SmartSaveInputs {
  return {
    incomeActual: d(3_900_000),
    expensesTotal: d(0),
    upcomingRecurring: d(0),
    savedToGoals: d(0),
    daysLeft: 13,
    share: 0.5,
    rate: d(1),
    step: d(1000),
    minimum: d(1000),
    goalRemaining: d(10_000_000),
    accountBalance: null,
    ...overrides,
  };
}

const run = (overrides: Partial<SmartSaveInputs> = {}) => {
  const result = smartSaveAmount(inputs(overrides));
  return {
    amount: result.amount.toNumber(),
    cappedBy: result.cappedBy,
    block: result.block,
  };
};

describe('smartSaveAmount', () => {
  it('suggests half of the free money per day, rounded down to 1000 sum', () => {
    // 3 900 000 / 13 = 300 000 a day; half is 150 000.
    expect(run()).toEqual({ amount: 150_000, cappedBy: null, block: null });
    // 4 000 000 / 13 = 307 692.3; half is 153 846 → 153 000.
    expect(run({ incomeActual: d(4_000_000) }).amount).toBe(153_000);
  });

  it('subtracts spending, upcoming payments and what is already saved', () => {
    const result = smartSaveAmount(
      inputs({
        expensesTotal: d(1_300_000),
        upcomingRecurring: d(1_300_000),
        savedToGoals: d(650_000),
      }),
    );
    expect(result.freeMoney.toNumber()).toBe(650_000);
    expect(result.amount.toNumber()).toBe(25_000);
  });

  it('has nothing to suggest when the month is not in plus', () => {
    expect(run({ expensesTotal: d(3_900_000) })).toMatchObject({
      amount: 0,
      block: 'no_spare_money',
    });
  });

  it('is too small below the minimum', () => {
    expect(run({ incomeActual: d(20_000) })).toMatchObject({
      amount: 0,
      block: 'too_small',
    });
  });

  it('never suggests more than the goal still needs, even below the minimum', () => {
    expect(run({ goalRemaining: d(40_000) })).toEqual({
      amount: 40_000,
      cappedBy: 'goal_remaining',
      block: null,
    });
    expect(run({ goalRemaining: d(500) })).toEqual({
      amount: 500,
      cappedBy: 'goal_remaining',
      block: null,
    });
  });

  it('never takes more than the account holds', () => {
    expect(run({ accountBalance: d(50_500) })).toEqual({
      amount: 50_000,
      cappedBy: 'account_balance',
      block: null,
    });
    expect(run({ accountBalance: d(700) })).toMatchObject({
      amount: 0,
      block: 'insufficient_balance',
    });
  });

  it('converts to the goal currency and rounds to its step', () => {
    // 150 000 UZS at 1/12 650 USD per sum is 11.857… USD → 11 USD with a step of 1.
    expect(
      run({ rate: d(1).dividedBy(12_650), step: d(1), minimum: d(1) }).amount,
    ).toBe(11);
  });
});
