import {
  assertCurrencyPrecision,
  hexColorSchema,
  moneySchema,
} from './schemas.js';

describe('moneySchema', () => {
  it.each([
    [1500000, '1500000'],
    ['12.50', '12.50'],
    [' -300 ', '-300'],
    [0, '0'],
  ])('accepts %j as %j', (input, output) => {
    expect(moneySchema.parse(input)).toBe(output);
  });

  it.each(['12.345', '1e21', 'abc', '', '12345678901234567', 0.1 + 0.2])(
    'rejects %j',
    (input) => {
      expect(moneySchema.safeParse(input).success).toBe(false);
    },
  );
});

describe('assertCurrencyPrecision', () => {
  const uzs = { code: 'UZS', decimals: 0 };
  const usd = { code: 'USD', decimals: 2 };

  it('allows whole soʻm and trailing zeros', () => {
    expect(() => assertCurrencyPrecision('150000', uzs)).not.toThrow();
    expect(() => assertCurrencyPrecision('150000.00', uzs)).not.toThrow();
  });

  it('refuses tiyin in UZS but allows cents in USD', () => {
    expect(() => assertCurrencyPrecision('150000.5', uzs)).toThrow(/UZS/);
    expect(() => assertCurrencyPrecision('12.55', usd)).not.toThrow();
  });
});

describe('hexColorSchema', () => {
  it('normalises to upper case', () => {
    expect(hexColorSchema.parse('#0a84ff')).toBe('#0A84FF');
  });
});
