import { Prisma } from '../generated/prisma/client.js';
import {
  anomaly,
  budgetForecast,
  goalScore,
  median,
  type Operation,
  periodReport,
} from './insight-math.js';

const d = (value: string | number) => new Prisma.Decimal(value);
const op = (
  type: Operation['type'],
  amount: number,
  categoryId: string | null,
  date: string,
): Operation => ({ type, amount: d(amount), categoryId, date });

describe('insight math', () => {
  it('puts a week against the week before, by category and day', () => {
    const report = periodReport(
      [
        op('income', 5_000_000, null, '2026-10-12'),
        op('expense', 300_000, 'food', '2026-10-12'),
        op('expense', 150_000, 'food', '2026-10-14'),
        op('expense', 90_000, 'taxi', '2026-10-14'),
        op('expense', 40_000, null, '2026-10-18'),
      ],
      [
        op('expense', 200_000, 'food', '2026-10-06'),
        op('expense', 150_000, 'taxi', '2026-10-07'),
        op('expense', 70_000, 'gifts', '2026-10-08'),
      ],
      [
        '2026-10-12',
        '2026-10-13',
        '2026-10-14',
        '2026-10-15',
        '2026-10-16',
        '2026-10-17',
        '2026-10-18',
      ],
    );
    expect(report.income.toString()).toBe('5000000');
    expect(report.expense.toString()).toBe('580000');
    expect(report.previousExpense.toString()).toBe('420000');
    expect(report.expenseChangePercent).toBe(38);
    expect(
      report.categories.map((line) => [
        line.categoryId,
        line.amount.toNumber(),
        line.changePercent,
      ]),
    ).toEqual([
      ['food', 450_000, 125],
      ['taxi', 90_000, -40],
      [null, 40_000, null],
    ]);
    expect(report.biggestIncrease?.categoryId).toBe('food');
    expect(report.days.map((day) => day.expense.toNumber())).toEqual([
      300_000, 0, 240_000, 0, 0, 0, 40_000,
    ]);
  });

  it('flags an expense over three medians of its category, with history only', () => {
    expect(median([d(5), d(1), d(3)])?.toString()).toBe('3');
    expect(median([d(4), d(1), d(3), d(2)])?.toString()).toBe('2.5');
    const history = [d(40_000), d(50_000), d(60_000)];
    expect(anomaly(d(150_000), history)).toBeNull();
    expect(anomaly(d(150_001), history)).toEqual({
      median: d(50_000),
      ratio: 3,
    });
    expect(anomaly(d(400_000), history)?.ratio).toBe(8);
    expect(anomaly(d(1_000_000), history.slice(0, 2))).toBeNull();
  });

  it('forecasts the month at its pace against the plan', () => {
    // 10 of 30 days gone, 1 000 000 spent, 200 000 of payments still due.
    const input = {
      spent: d(1_000_000),
      upcomingRecurring: d(200_000),
      daysTotal: 30,
      daysLeft: 21,
      decimals: 0,
    };
    expect(budgetForecast({ ...input, plan: d(3_000_000) })).toMatchObject({
      forecast: d(3_200_000),
      overBy: d(200_000),
      verdict: 'over',
    });
    expect(budgetForecast({ ...input, plan: d(4_000_000) }).verdict).toBe(
      'within',
    );
    expect(budgetForecast({ ...input, plan: null }).verdict).toBe('unknown');
  });

  it('scores a goal by its pace, or by progress and regular deposits', () => {
    expect(
      goalScore({
        progress: 40,
        saved: d(400),
        expectedSaved: d(400),
        monthsWithDeposits: 1,
      }),
    ).toBe(85);
    expect(
      goalScore({
        progress: 40,
        saved: d(500),
        expectedSaved: d(400),
        monthsWithDeposits: 1,
      }),
    ).toBe(100);
    expect(
      goalScore({
        progress: 20,
        saved: d(200),
        expectedSaved: d(400),
        monthsWithDeposits: 1,
      }),
    ).toBe(43);
    expect(
      goalScore({
        progress: 100,
        saved: d(1000),
        expectedSaved: d(400),
        monthsWithDeposits: 0,
      }),
    ).toBe(100);
    expect(
      goalScore({
        progress: 50,
        saved: d(500),
        expectedSaved: null,
        monthsWithDeposits: 3,
      }),
    ).toBe(80);
    expect(
      goalScore({
        progress: 0,
        saved: d(0),
        expectedSaved: null,
        monthsWithDeposits: 0,
      }),
    ).toBe(30);
  });
});
