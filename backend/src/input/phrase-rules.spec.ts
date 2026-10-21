import { systemCategoryId } from '../database/reference-data.js';
import { type CategoryOption, normalize, parsePhrase } from './phrase-rules.js';

const sys = (
  type: 'income' | 'expense',
  key: string,
  names: string[],
): CategoryOption => ({ id: systemCategoryId(type, key), type, key, names });

const CATEGORIES: CategoryOption[] = [
  sys('expense', 'food', ['Oziq-ovqat', 'Еда', 'Food']),
  sys('expense', 'transport', ['Transport', 'Транспорт', 'Transport']),
  sys('expense', 'cafe', ['Kafe', 'Кафе', 'Cafe']),
  sys('expense', 'market', ['Supermarket', 'Супермаркет', 'Groceries']),
  sys('expense', 'gifts', ['Sovgʻalar', 'Подарки', 'Gifts']),
  sys('income', 'salary', ['Ish haqi', 'Зарплата', 'Salary']),
  sys('income', 'cashback', ['Keshbek', 'Кешбэк', 'Cashback']),
  { id: 'own-coffee', type: 'expense', key: null, names: ['Coffee'] },
];
const id = (type: 'income' | 'expense', key: string) =>
  systemCategoryId(type, key);
const TODAY = '2026-10-21';
const parse = (text: string) => parsePhrase(text, TODAY, CATEGORIES);

describe('phrase rules', () => {
  it('groups digits and joins apostrophes', () => {
    expect(normalize('Обед 1 500 000 сум')).toBe('обед 1500000 сум');
    expect(normalize('Oʻyin 40 000')).toBe("o'yin 40000");
  });

  it('reads an amount with its multiplier and the category', () => {
    expect(parse('кофе 25 тысяч')).toEqual([
      {
        type: 'expense',
        amount: '25000',
        currency: null,
        categoryId: id('expense', 'cafe'),
        date: TODAY,
        note: 'Кофе',
        confidence: 0.7,
      },
    ]);
    expect(parse('taksi 30 ming')[0]).toMatchObject({
      amount: '30000',
      categoryId: id('expense', 'transport'),
      note: 'Taksi',
    });
    expect(parse('lunch 12.50')[0]).toMatchObject({
      amount: '12.5',
      categoryId: id('expense', 'food'),
    });
    expect(parse('такси 25к')[0].amount).toBe('25000');
    expect(parse('продукты 1,5 млн')[0]).toMatchObject({
      amount: '1500000',
      categoryId: id('expense', 'market'),
    });
    expect(parse('бензин 250.000')[0].amount).toBe('250000');
  });

  it('knows income and the day', () => {
    expect(parse('зарплата 8 млн вчера')).toEqual([
      expect.objectContaining({
        type: 'income',
        amount: '8000000',
        categoryId: id('income', 'salary'),
        date: '2026-10-20',
        note: 'Зарплата',
      }),
    ]);
    expect(parse('kecha maosh 5 mln')[0]).toMatchObject({
      type: 'income',
      date: '2026-10-20',
    });
    expect(parse('cashback 12000')[0]).toMatchObject({
      type: 'income',
      categoryId: id('income', 'cashback'),
    });
    expect(parse('получил 300000')[0]).toMatchObject({
      type: 'income',
      categoryId: null,
      confidence: 0.5,
    });
  });

  it('splits a phrase into several operations', () => {
    const ops = parse('обед 40 000 и такси 15 000 вчера');
    expect(ops.map((op) => [op.amount, op.categoryId, op.date])).toEqual([
      ['40000', id('expense', 'food'), '2026-10-20'],
      ['15000', id('expense', 'transport'), '2026-10-20'],
    ]);
    expect(
      parse('кофе 25000 такси 15000').map((op) => [op.note, op.amount]),
    ).toEqual([
      ['Кофе', '25000'],
      ['Такси', '15000'],
    ]);
    expect(parse('nonushta 20 ming va metro 2 ming')).toHaveLength(2);
  });

  it('finds the user’s own categories and names a currency', () => {
    expect(parse('coffee 3 $')[0]).toMatchObject({
      categoryId: 'own-coffee',
      currency: 'USD',
      amount: '3',
    });
    expect(parse('подарок маме 200 долларов')[0]).toMatchObject({
      categoryId: id('expense', 'gifts'),
      currency: 'USD',
      note: 'Подарок маме',
    });
    expect(parse('ужин 150 000 сум')[0].currency).toBeNull();
  });

  it('finds nothing without an amount', () => {
    expect(parse('кофе')).toEqual([]);
    expect(parse('')).toEqual([]);
  });
});
