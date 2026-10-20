import {
  type Money,
  formulaCases,
  money,
  plain,
} from '../../test/support/formula-cases.js';
import {
  type BudgetFigures,
  type BudgetInputs,
  budgetLeftover,
  computeBudget,
  suggestedMonthly,
} from './budget-math.js';

type MoneyInput = Exclude<keyof BudgetInputs, 'daysLeft' | 'decimals'>;
type CaseInputs = { [K in MoneyInput]: Money | null } & {
  daysLeft: number;
  decimals: number;
};

interface BudgetCase {
  name: string;
  inputs: Partial<CaseInputs>;
  expected: Partial<Record<Exclude<keyof BudgetFigures, 'state'>, Money>> & {
    state?: BudgetFigures['state'];
  };
}

const { defaults, cases } = formulaCases<{
  defaults: CaseInputs;
  cases: BudgetCase[];
}>('budget');

function inputs(values: CaseInputs): BudgetInputs {
  return {
    incomeActual: money(values.incomeActual ?? '0'),
    incomePlanned: money(values.incomePlanned),
    expensesBeforeToday: money(values.expensesBeforeToday ?? '0'),
    expensesToday: money(values.expensesToday ?? '0'),
    savedToGoals: money(values.savedToGoals ?? '0'),
    savingsTarget: money(values.savingsTarget ?? '0'),
    rollover: money(values.rollover ?? '0'),
    upcomingRecurring: money(values.upcomingRecurring ?? '0'),
    totalLimit: money(values.totalLimit),
    daysLeft: values.daysLeft,
    decimals: values.decimals,
  };
}

describe('computeBudget (shared/formula-cases/budget.json)', () => {
  it.each(cases)('$name', ({ inputs: changes, expected }) => {
    const result = computeBudget(inputs({ ...defaults, ...changes }));
    const { state, ...sums } = expected;
    if (state) expect(result.state).toBe(state);
    for (const [key, value] of Object.entries(sums)) {
      expect(plain(result[key as keyof typeof sums]), key).toBe(plain(value));
    }
  });
});

describe('budgetLeftover', () => {
  const left = (overrides: Partial<Parameters<typeof budgetLeftover>[0]>) =>
    plain(
      budgetLeftover({
        incomeActual: money('0'),
        rolloverIn: money('0'),
        savedToGoals: money('0'),
        expenses: money('0'),
        totalLimit: null,
        decimals: 0,
        ...overrides,
      }),
    );

  it('carries what is left of the real income, the carried-in amount included', () => {
    expect(
      left({
        incomeActual: money('5000000'),
        rolloverIn: money('200000'),
        expenses: money('3900000'),
      }),
    ).toBe('1300000');
  });

  it('keeps what went into goals out, but withdrawals add nothing', () => {
    expect(
      left({
        incomeActual: money('5000000'),
        savedToGoals: money('1000000'),
        expenses: money('3000000'),
      }),
    ).toBe('1000000');
    expect(
      left({
        incomeActual: money('5000000'),
        savedToGoals: money('-500000'),
        expenses: money('3000000'),
      }),
    ).toBe('2000000');
  });

  it('carries no more than the total limit left', () => {
    expect(
      left({
        incomeActual: money('10000000'),
        expenses: money('2400000'),
        totalLimit: money('2600000'),
      }),
    ).toBe('200000');
  });

  it('carries nothing from an overspent month', () => {
    expect(
      left({ incomeActual: money('1000000'), expenses: money('1200000') }),
    ).toBe('0');
    expect(
      left({
        incomeActual: money('10000000'),
        expenses: money('3000000'),
        totalLimit: money('2600000'),
      }),
    ).toBe('0');
  });

  it('rounds down to the currency precision', () => {
    expect(left({ incomeActual: money('100.559'), decimals: 2 })).toBe(
      '100.55',
    );
  });
});

describe('suggestedMonthly', () => {
  it('averages the past months and rounds up to the currency step', () => {
    expect(plain(suggestedMonthly(money('1234567'), 3, money('1000')))).toBe(
      '412000',
    );
    expect(plain(suggestedMonthly(money('900000'), 3, money('1000')))).toBe(
      '300000',
    );
  });

  it('works without a step and without history', () => {
    expect(plain(suggestedMonthly(money('100.5'), 2, money('0')))).toBe('51');
    expect(plain(suggestedMonthly(money('500000'), 0, money('1000')))).toBe(
      '0',
    );
    expect(plain(suggestedMonthly(money('0'), 3, money('1000')))).toBe('0');
  });
});
