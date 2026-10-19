import { Injectable } from '@nestjs/common';
import {
  type CalendarDate,
  addDays,
  asDbDate,
  daysBetween,
  localDate,
  startOfLocalDay,
} from '../common/dates.js';
import { PrismaService } from '../database/prisma.service.js';
import { FxService } from '../finance/fx.service.js';
import { occurrencesBetween } from '../finance/recurrence.js';
import { Prisma } from '../generated/prisma/client.js';
import { type BudgetState, computeBudget } from './budget-math.js';
import { budgetPeriod } from './budget-period.js';

type Decimal = Prisma.Decimal;
const { Decimal } = Prisma;

export interface BudgetSummary {
  period: {
    start: CalendarDate;
    end: CalendarDate;
    today: CalendarDate;
    daysTotal: number;
    /** Today included */
    daysLeft: number;
  };
  currency: string;
  /** `planned` when the user set up a budget for this month, otherwise `auto` */
  mode: 'auto' | 'planned';
  income: { actual: string; planned: string | null; basis: string };
  expenses: { total: string; beforeToday: string; today: string };
  savedToGoals: string;
  savingsTarget: string;
  rollover: string;
  upcomingRecurring: string;
  totalLimit: string | null;
  /** Income minus expenses so far this month */
  balance: string;
  available: string;
  dailyLimit: string;
  safeToSpendToday: string;
  state: BudgetState;
  /** Spending this month per category, largest first; null id = no category */
  byCategory: { categoryId: string | null; amount: string }[];
  /** Some amounts in other currencies had no exchange rate and were left out */
  incomplete: boolean;
}

/** Daily limit and «Можно потратить сегодня» for the current budget month. */
@Injectable()
export class BudgetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fx: FxService,
  ) {}

  async current(userId: string, now = new Date()): Promise<BudgetSummary> {
    const user = await this.prisma.users.findUniqueOrThrow({
      where: { id: userId },
      select: {
        timezone: true,
        monthly_income_estimate: true,
        base_currency_id: true,
        baseCurrency: { select: { code: true, decimals: true } },
        userSettings: { select: { month_starts_on_day: true } },
      },
    });
    const tz = user.timezone;
    const baseId = user.base_currency_id;
    const decimals = user.baseCurrency.decimals;

    const today = localDate(now, tz);
    const period = budgetPeriod(
      today,
      user.userSettings?.month_starts_on_day ?? 1,
    );
    const periodStart = startOfLocalDay(period.start, tz);
    const todayStart = startOfLocalDay(today, tz);
    const tomorrowStart = startOfLocalDay(addDays(today, 1), tz);
    const periodEnd = startOfLocalDay(addDays(period.end, 1), tz);
    const daysLeft = daysBetween(today, period.end) + 1;

    const sumBase = async (
      type: 'income' | 'expense',
      from: Date,
      to: Date,
    ) => {
      const result = await this.prisma.transactions.aggregate({
        where: {
          user_id: userId,
          deleted_at: null,
          type,
          occurred_at: { gte: from, lt: to },
        },
        _sum: { amount_base: true },
      });
      return result._sum.amount_base ?? new Decimal(0);
    };

    const [
      budget,
      incomeActual,
      expensesBeforeToday,
      expensesToday,
      byCategory,
      goals,
      recurring,
    ] = await Promise.all([
      this.prisma.budgets.findUnique({
        where: {
          user_id_period_start: {
            user_id: userId,
            period_start: asDbDate(period.start),
          },
        },
      }),
      sumBase('income', periodStart, periodEnd),
      sumBase('expense', periodStart, todayStart),
      sumBase('expense', todayStart, tomorrowStart),
      this.prisma.transactions.groupBy({
        by: ['category_id'],
        where: {
          user_id: userId,
          deleted_at: null,
          type: 'expense',
          occurred_at: { gte: periodStart, lt: tomorrowStart },
        },
        _sum: { amount_base: true },
      }),
      this.savedToGoals(userId, baseId, periodStart, periodEnd),
      this.upcomingRecurring(userId, baseId, today, period.end, now),
    ]);

    const incomePlanned =
      budget?.planned_income ?? user.monthly_income_estimate ?? null;
    const savingsTarget = budget?.savings_target ?? new Decimal(0);
    const rollover = budget?.rollover_enabled
      ? budget.rollover_amount
      : new Decimal(0);
    const totalLimit = budget?.total_limit ?? null;

    const figures = computeBudget({
      incomeActual,
      incomePlanned,
      expensesBeforeToday,
      expensesToday,
      savedToGoals: goals.total,
      savingsTarget,
      rollover,
      upcomingRecurring: recurring.total,
      totalLimit,
      daysLeft,
      decimals,
    });

    const money = (value: Decimal) => value.toFixed(decimals);
    const expensesTotal = expensesBeforeToday.plus(expensesToday);
    return {
      period: {
        start: period.start,
        end: period.end,
        today,
        daysTotal: daysBetween(period.start, period.end) + 1,
        daysLeft,
      },
      currency: user.baseCurrency.code,
      mode:
        budget &&
        (budget.planned_income !== null || budget.total_limit !== null)
          ? 'planned'
          : 'auto',
      income: {
        actual: money(incomeActual),
        planned: incomePlanned ? money(incomePlanned) : null,
        basis: money(figures.incomeBasis),
      },
      expenses: {
        total: money(expensesTotal),
        beforeToday: money(expensesBeforeToday),
        today: money(expensesToday),
      },
      savedToGoals: money(goals.total),
      savingsTarget: money(savingsTarget),
      rollover: money(rollover),
      upcomingRecurring: money(recurring.total),
      totalLimit: totalLimit ? money(totalLimit) : null,
      balance: money(incomeActual.minus(expensesTotal)),
      available: money(figures.available),
      dailyLimit: money(figures.dailyLimit),
      safeToSpendToday: money(figures.safeToSpendToday),
      state: figures.state,
      byCategory: byCategory
        .map((group) => ({
          categoryId: group.category_id,
          amount: group._sum.amount_base ?? new Decimal(0),
        }))
        .sort((a, b) => b.amount.comparedTo(a.amount))
        .map((group) => ({
          categoryId: group.categoryId,
          amount: money(group.amount),
        })),
      incomplete: goals.incomplete || recurring.incomplete,
    };
  }

  /** Net goal contributions of the month in the base currency, at each contribution's date. */
  private async savedToGoals(
    userId: string,
    baseId: number,
    from: Date,
    to: Date,
  ): Promise<{ total: Decimal; incomplete: boolean }> {
    const contributions = await this.prisma.goalContributions.findMany({
      where: {
        user_id: userId,
        deleted_at: null,
        created_at: { gte: from, lt: to },
      },
      select: { type: true, amount: true, currency_id: true, created_at: true },
    });
    let total = new Decimal(0);
    let incomplete = false;
    for (const c of contributions) {
      const rate = await this.fx.rate(c.currency_id, baseId, c.created_at);
      if (!rate) {
        incomplete = true;
        continue;
      }
      const value = c.amount.times(rate);
      total = c.type === 'deposit' ? total.plus(value) : total.minus(value);
    }
    return { total, incomplete };
  }

  /** Recurring expenses not created yet, from today to the end of the month, at today's rate. */
  private async upcomingRecurring(
    userId: string,
    baseId: number,
    today: CalendarDate,
    end: CalendarDate,
    now: Date,
  ): Promise<{ total: Decimal; incomplete: boolean }> {
    const rules = await this.prisma.recurringRules.findMany({
      where: {
        user_id: userId,
        deleted_at: null,
        is_active: true,
        type: 'expense',
        next_run_on: { lte: asDbDate(end) },
      },
    });
    let total = new Decimal(0);
    let incomplete = false;
    for (const rule of rules) {
      const dates = occurrencesBetween(
        {
          frequency: rule.frequency,
          interval: rule.interval,
          dayOfMonth: rule.day_of_month,
          startOn: rule.start_on.toISOString().slice(0, 10),
          endOn: rule.end_on?.toISOString().slice(0, 10) ?? null,
          nextRunOn: rule.next_run_on.toISOString().slice(0, 10),
        },
        today,
        end,
      );
      if (dates.length === 0) continue;
      const rate = await this.fx.rate(rule.currency_id, baseId, now);
      if (!rate) {
        incomplete = true;
        continue;
      }
      total = total.plus(rule.amount.times(rate).times(dates.length));
    }
    return { total, incomplete };
  }
}
