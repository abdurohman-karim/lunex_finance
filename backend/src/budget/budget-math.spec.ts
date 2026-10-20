import {
  type Money,
  formulaCases,
  money,
  plain,
} from '../../test/support/formula-cases.js';
import {
  type BudgetFigures,
  type BudgetInputs,
  computeBudget,
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
