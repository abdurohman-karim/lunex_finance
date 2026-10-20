import { formulaCases, money } from '../../test/support/formula-cases.js';
import { rateOn, type RateRow } from './fx-math.js';

interface FxCases {
  rates: { base: string; quote: string; rate: string; date: string }[];
  cases: {
    name: string;
    from: string;
    to: string;
    date: string;
    rate: string | null;
  }[];
}

const fx = formulaCases<FxCases>('fx');
const rows: RateRow[] = fx.rates.map((row) => ({
  ...row,
  rate: money(row.rate),
}));

describe('rate of a day (shared/formula-cases/fx.json)', () => {
  it.each(fx.cases)('$name', ({ from, to, date, rate }) => {
    const found = rateOn(rows, from, to, date);
    expect(found?.toDecimalPlaces(10).toFixed() ?? null).toBe(rate);
  });
});
