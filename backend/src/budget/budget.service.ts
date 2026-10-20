import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { EntitlementsService } from '../billing/entitlements.service.js';
import {
  type CalendarDate,
  addDays,
  asDbDate,
  localDate,
  startOfLocalDay,
} from '../common/dates.js';
import { PrismaService } from '../database/prisma.service.js';
import { FxService } from '../finance/fx.service.js';
import { occurrencesBetween } from '../finance/recurrence.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  type BudgetState,
  budgetLeftover,
  computeBudget,
  suggestedMonthly,
} from './budget-math.js';
import {
  type BudgetPeriod,
  budgetPeriod,
  daysLeftIn,
  periodDays,
} from './budget-period.js';
import type { BudgetPlanInput } from './budget.schemas.js';

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
  /** Last month's leftover carried in (Lunex Pro); 0 when carrying is off */
  rollover: string;
  rolloverEnabled: boolean;
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
  /** Limits of the month (Lunex Pro): spending counts the category and its subcategories */
  categoryLimits: {
    categoryId: string;
    limit: string;
    spent: string;
    alertThresholdPct: number;
  }[];
  /** Some amounts in other currencies had no exchange rate and were left out */
  incomplete: boolean;
}

/** What the wizard proposes, from the budget months before the current one. */
export interface BudgetSuggestions {
  /** Past budget months with operations that the averages cover (up to 3) */
  months: number;
  currency: string;
  /** Average monthly income, rounded down to the currency step; null without history */
  income: string | null;
  /** Average monthly spending, rounded up to the currency step; null without history */
  expenses: string | null;
  /** Average spending of each top-level expense category, largest first */
  categories: { categoryId: string; amount: string }[];
}

/** The current month as numbers in the base currency. */
export interface BudgetSnapshot {
  today: CalendarDate;
  timezone: string;
  /** Today included */
  daysLeft: number;
  baseCurrency: { id: number; code: string; decimals: number };
  incomeActual: Decimal;
  expensesTotal: Decimal;
  savedToGoals: Decimal;
  upcomingRecurring: Decimal;
  safeToSpendToday: Decimal;
  incomplete: boolean;
}

/** Daily limit and «Можно потратить сегодня» for the current budget month. */
@Injectable()
export class BudgetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fx: FxService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /**
   * Replaces the plan of the current budget month: planned income, total limit, savings target,
   * carrying last month's leftover and category limits (the last two need Lunex Pro). The plan
   * repeats in the following months until changed.
   */
  async setPlan(
    userId: string,
    input: BudgetPlanInput,
    now = new Date(),
  ): Promise<BudgetSummary> {
    if (input.categoryLimits.length > 0) {
      await this.entitlements.assertFeature(userId, 'category_limits');
    }
    if (input.rolloverEnabled) {
      await this.entitlements.assertFeature(userId, 'budget_rollover');
    }
    const user = await this.user(userId);
    const decimals = user.baseCurrency.decimals;
    const period = budgetPeriod(
      localDate(now, user.timezone),
      user.userSettings?.month_starts_on_day ?? 1,
    );

    const ids = input.categoryLimits.map((limit) => limit.categoryId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException({
        code: 'duplicate_category',
        message: 'A category has one limit',
      });
    }
    const categories = await this.prisma.categories.findMany({
      where: {
        id: { in: ids },
        type: 'expense',
        deleted_at: null,
        OR: [{ user_id: userId }, { user_id: null }],
      },
      select: { id: true },
    });
    if (categories.length !== ids.length) {
      throw new BadRequestException({
        code: 'invalid_category',
        message: 'Limits need expense categories of this account',
      });
    }

    const amount = (value: string) =>
      new Decimal(value).toDecimalPlaces(decimals);
    const plan = {
      currency_id: user.base_currency_id,
      planned_income: input.plannedIncome ? amount(input.plannedIncome) : null,
      total_limit: input.totalLimit ? amount(input.totalLimit) : null,
      savings_target: amount(input.savingsTarget),
      rollover_enabled: input.rolloverEnabled,
    };
    await this.prisma.$transaction(async (tx) => {
      const budget = await tx.budgets.upsert({
        where: {
          user_id_period_start: {
            user_id: userId,
            period_start: asDbDate(period.start),
          },
        },
        create: {
          id: randomUUID(),
          user_id: userId,
          period_start: asDbDate(period.start),
          period_end: asDbDate(period.end),
          ...plan,
        },
        update: plan,
      });
      await tx.budgetCategoryLimits.deleteMany({
        where: { budget_id: budget.id },
      });
      await tx.budgetCategoryLimits.createMany({
        data: input.categoryLimits.map((limit) => ({
          id: randomUUID(),
          budget_id: budget.id,
          category_id: limit.categoryId,
          limit_amount: amount(limit.limit),
          alert_threshold_pct: limit.alertThresholdPct,
        })),
      });
    });
    return this.current(userId, now);
  }

  /**
   * Averages of the (up to) three budget months before the current one, for the wizard:
   * income, spending and each top-level category with its subcategories.
   */
  async suggestions(
    userId: string,
    now = new Date(),
  ): Promise<BudgetSuggestions> {
    const user = await this.user(userId);
    const tz = user.timezone;
    const payday = user.userSettings?.month_starts_on_day ?? 1;
    const current = budgetPeriod(localDate(now, tz), payday);
    const past: BudgetPeriod[] = [];
    for (let start = current.start; past.length < 3;) {
      const previous = budgetPeriod(addDays(start, -1), payday);
      past.push(previous);
      start = previous.start;
    }
    const bounds = (period: BudgetPeriod) => ({
      gte: startOfLocalDay(period.start, tz),
      lt: startOfLocalDay(addDays(period.end, 1), tz),
    });
    const window = {
      gte: bounds(past[past.length - 1]).gte,
      lt: startOfLocalDay(current.start, tz),
    };
    const counts = await Promise.all(
      past.map((period) =>
        this.prisma.transactions.count({
          where: {
            user_id: userId,
            deleted_at: null,
            type: { in: ['income', 'expense'] },
            occurred_at: bounds(period),
          },
        }),
      ),
    );
    const months = counts.filter((count) => count > 0).length;
    const [income, expenses, groups] = await Promise.all([
      this.sumBase(userId, 'income', window.gte, window.lt),
      this.sumBase(userId, 'expense', window.gte, window.lt),
      this.prisma.transactions.groupBy({
        by: ['category_id'],
        where: {
          user_id: userId,
          deleted_at: null,
          type: 'expense',
          occurred_at: window,
        },
        _sum: { amount_base: true },
      }),
    ]);

    const parents = await this.parents(groups.map((g) => g.category_id));
    const totals = new Map<string, Decimal>();
    for (const group of groups) {
      if (!group.category_id) continue;
      const top = parents.get(group.category_id) ?? group.category_id;
      totals.set(
        top,
        (totals.get(top) ?? new Decimal(0)).plus(group._sum.amount_base ?? 0),
      );
    }
    const step = user.baseCurrency.rounding_step;
    const decimals = user.baseCurrency.decimals;
    const money = (value: Decimal) => value.toFixed(decimals);
    const averageIncome =
      step.gt(0) && months > 0
        ? income.dividedBy(months).dividedBy(step).floor().times(step)
        : months > 0
          ? income.dividedBy(months).floor()
          : new Decimal(0);
    return {
      months,
      currency: user.baseCurrency.code,
      income: months > 0 && averageIncome.gt(0) ? money(averageIncome) : null,
      expenses:
        months > 0 && expenses.gt(0)
          ? money(suggestedMonthly(expenses, months, step))
          : null,
      categories: [...totals]
        .map(([categoryId, total]) => ({
          categoryId,
          amount: suggestedMonthly(total, months, step),
        }))
        .filter((category) => category.amount.gt(0))
        .sort((a, b) => b.amount.comparedTo(a.amount))
        .map(({ categoryId, amount }) => ({
          categoryId,
          amount: money(amount),
        })),
    };
  }

  async current(userId: string, now = new Date()): Promise<BudgetSummary> {
    return (await this.evaluate(userId, now)).summary;
  }

  /** The same month as numbers, for features that build on it (Smart Save). */
  async snapshot(userId: string, now = new Date()): Promise<BudgetSnapshot> {
    return (await this.evaluate(userId, now)).snapshot;
  }

  private async evaluate(
    userId: string,
    now: Date,
  ): Promise<{ summary: BudgetSummary; snapshot: BudgetSnapshot }> {
    const user = await this.user(userId);
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
    const daysLeft = daysLeftIn(period, today);

    const sumBase = (type: 'income' | 'expense', from: Date, to: Date) =>
      this.sumBase(userId, type, from, to);

    const [
      budget,
      incomeActual,
      expensesBeforeToday,
      expensesToday,
      byCategory,
      goals,
      recurring,
    ] = await Promise.all([
      this.monthBudget(userId, period, {
        tz,
        baseId,
        decimals,
        payday: user.userSettings?.month_starts_on_day ?? 1,
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
    const incomplete = goals.incomplete || recurring.incomplete;
    const snapshot: BudgetSnapshot = {
      today,
      timezone: tz,
      daysLeft,
      baseCurrency: { id: baseId, ...user.baseCurrency },
      incomeActual,
      expensesTotal,
      savedToGoals: goals.total,
      upcomingRecurring: recurring.total,
      safeToSpendToday: figures.safeToSpendToday,
      incomplete,
    };
    const summary: BudgetSummary = {
      period: {
        start: period.start,
        end: period.end,
        today,
        daysTotal: periodDays(period),
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
      rolloverEnabled: budget?.rollover_enabled ?? false,
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
      categoryLimits: await this.limitsWithSpending(
        budget?.budgetCategoryLimits ?? [],
        byCategory,
        money,
      ),
      incomplete,
    };
    return { summary, snapshot };
  }

  private user(userId: string) {
    return this.prisma.users.findUniqueOrThrow({
      where: { id: userId },
      select: {
        timezone: true,
        monthly_income_estimate: true,
        base_currency_id: true,
        baseCurrency: {
          select: { code: true, decimals: true, rounding_step: true },
        },
        userSettings: { select: { month_starts_on_day: true } },
      },
    });
  }

  private async sumBase(
    userId: string,
    type: 'income' | 'expense',
    from: Date,
    to: Date,
  ): Promise<Decimal> {
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
  }

  /**
   * The plan of this budget month. A month without one repeats the latest earlier plan (in the
   * same base currency); with carrying on, its rollover is last month's leftover, worked out
   * again on every read so late edits of last month count.
   */
  private async monthBudget(
    userId: string,
    period: BudgetPeriod,
    context: { tz: string; baseId: number; decimals: number; payday: number },
  ) {
    const find = () =>
      this.prisma.budgets.findUnique({
        where: {
          user_id_period_start: {
            user_id: userId,
            period_start: asDbDate(period.start),
          },
        },
        include: { budgetCategoryLimits: true },
      });
    let budget =
      (await find()) ??
      (await this.carryForward(userId, period, context.baseId).then(find));
    if (!budget?.rollover_enabled) return budget;

    const leftover = await this.leftoverBefore(userId, period, context);
    if (!leftover.equals(budget.rollover_amount)) {
      budget = await this.prisma.budgets.update({
        where: { id: budget.id },
        data: { rollover_amount: leftover },
        include: { budgetCategoryLimits: true },
      });
    }
    return budget;
  }

  /** Copies the latest earlier plan into a new month; a concurrent copy wins quietly. */
  private async carryForward(
    userId: string,
    period: BudgetPeriod,
    baseId: number,
  ): Promise<void> {
    const previous = await this.prisma.budgets.findFirst({
      where: { user_id: userId, period_start: { lt: asDbDate(period.start) } },
      orderBy: { period_start: 'desc' },
      include: {
        budgetCategoryLimits: {
          include: { category: { select: { deleted_at: true } } },
        },
      },
    });
    // Amounts in an older base currency mean nothing now.
    if (!previous || previous.currency_id !== baseId) return;
    const id = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.budgets.createMany({
        data: [
          {
            id,
            user_id: userId,
            period_start: asDbDate(period.start),
            period_end: asDbDate(period.end),
            currency_id: baseId,
            planned_income: previous.planned_income,
            total_limit: previous.total_limit,
            savings_target: previous.savings_target,
            rollover_enabled: previous.rollover_enabled,
          },
        ],
        skipDuplicates: true,
      });
      if (count === 0) return;
      await tx.budgetCategoryLimits.createMany({
        data: previous.budgetCategoryLimits
          .filter((limit) => limit.category.deleted_at === null)
          .map((limit) => ({
            id: randomUUID(),
            budget_id: id,
            category_id: limit.category_id,
            limit_amount: limit.limit_amount,
            alert_threshold_pct: limit.alert_threshold_pct,
          })),
      });
    });
  }

  /** What the budget month before `period` left over, in the base currency. */
  private async leftoverBefore(
    userId: string,
    period: BudgetPeriod,
    context: { tz: string; baseId: number; decimals: number; payday: number },
  ): Promise<Decimal> {
    const previous = budgetPeriod(addDays(period.start, -1), context.payday);
    const from = startOfLocalDay(previous.start, context.tz);
    const to = startOfLocalDay(addDays(previous.end, 1), context.tz);
    const [budget, income, expenses, saved] = await Promise.all([
      this.prisma.budgets.findUnique({
        where: {
          user_id_period_start: {
            user_id: userId,
            period_start: asDbDate(previous.start),
          },
        },
      }),
      this.sumBase(userId, 'income', from, to),
      this.sumBase(userId, 'expense', from, to),
      this.savedToGoals(userId, context.baseId, from, to),
    ]);
    return budgetLeftover({
      incomeActual: income,
      rolloverIn:
        budget?.rollover_enabled && budget.currency_id === context.baseId
          ? budget.rollover_amount
          : new Decimal(0),
      savedToGoals: saved.total,
      expenses,
      totalLimit:
        budget?.currency_id === context.baseId ? budget.total_limit : null,
      decimals: context.decimals,
    });
  }

  /** Top-level category of each subcategory among `ids`. */
  private async parents(ids: (string | null)[]): Promise<Map<string, string>> {
    const known = ids.filter((id): id is string => id !== null);
    if (known.length === 0) return new Map();
    const rows = await this.prisma.categories.findMany({
      where: { id: { in: known }, parent_id: { not: null } },
      select: { id: true, parent_id: true },
    });
    return new Map(rows.map((row) => [row.id, row.parent_id!]));
  }

  private async limitsWithSpending(
    limits: {
      category_id: string;
      limit_amount: Decimal;
      alert_threshold_pct: number;
    }[],
    byCategory: {
      category_id: string | null;
      _sum: { amount_base: Decimal | null };
    }[],
    money: (value: Decimal) => string,
  ): Promise<BudgetSummary['categoryLimits']> {
    if (limits.length === 0) return [];
    const parents = await this.parents(byCategory.map((g) => g.category_id));
    const spent = new Map<string, Decimal>();
    const add = (id: string, amount: Decimal) =>
      spent.set(id, (spent.get(id) ?? new Decimal(0)).plus(amount));
    for (const group of byCategory) {
      if (!group.category_id) continue;
      const amount = group._sum.amount_base ?? new Decimal(0);
      add(group.category_id, amount);
      const parent = parents.get(group.category_id);
      if (parent) add(parent, amount);
    }
    return limits.map((limit) => ({
      categoryId: limit.category_id,
      limit: money(limit.limit_amount),
      spent: money(spent.get(limit.category_id) ?? new Decimal(0)),
      alertThresholdPct: limit.alert_threshold_pct,
    }));
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
