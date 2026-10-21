import type Anthropic from '@anthropic-ai/sdk';
import { Injectable } from '@nestjs/common';
import { BudgetService } from '../budget/budget.service.js';
import {
  addDays,
  type CalendarDate,
  daysBetween,
  localDate,
  startOfLocalDay,
} from '../common/dates.js';
import { PrismaService } from '../database/prisma.service.js';
import { RecurringService } from '../finance/recurring/recurring.service.js';
import type { LanguageCode } from '../generated/prisma/enums.js';
import { Prisma } from '../generated/prisma/client.js';
import { GoalsService } from '../goals/goals.service.js';
import type { CategoryOption } from '../input/phrase-rules.js';
import {
  type CurrencyInfo,
  day,
  money,
} from '../notifications/notification-texts.js';

/** A mini chart of an answer, drawn by the app from these figures. */
export interface AssistantChart {
  /** `bars`: over time; `categories`: shares; `progress`: saved against a target */
  kind: 'bars' | 'categories' | 'progress';
  title: string;
  currency: string;
  points: { label: string; value: string; target?: string }[];
}

/** Something the assistant offers to do; nothing happens until the user confirms it. */
export type AssistantActionParams =
  | {
      kind: 'create_goal';
      title: string;
      targetAmount: string;
      currency: string;
      deadline: CalendarDate | null;
      emoji: string | null;
    }
  | {
      kind: 'category_limit';
      categoryId: string;
      categoryName: string;
      limit: string;
      currency: string;
    }
  | {
      kind: 'recurring';
      title: string;
      type: 'expense' | 'income';
      amount: string;
      currency: string;
      categoryId: string | null;
      categoryName: string | null;
      frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
      dayOfMonth: number | null;
      isSubscription: boolean;
    };

export interface AssistantUser {
  id: string;
  language: LanguageCode;
  timezone: string;
  currency: CurrencyInfo;
  today: CalendarDate;
  categories: Map<string, CategoryOption>;
}

/** What one answer collected while the model looked things up. */
export class AnswerParts {
  readonly charts: AssistantChart[] = [];
  readonly actions: AssistantActionParams[] = [];

  addChart(chart: AssistantChart): void {
    if (chart.points.length > 0 && this.charts.length < 2)
      this.charts.push(chart);
  }
}

export const MAX_ACTIONS = 3;
/** The longest stretch one question looks at */
const MAX_RANGE_DAYS = 366;

const dateSchema = {
  type: 'string',
  description: 'YYYY-MM-DD',
} as const;
const categorySchema = {
  type: 'string',
  description: 'A category ref from the list (c1, c2…)',
} as const;

export const ASSISTANT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'spending',
    description:
      'Totals of the user’s expenses (or incomes) from one day to another, in the base currency: the sum, the number of operations, the biggest categories and a breakdown over time. Transfers between accounts and savings into goals are not counted. A category counts with its subcategories.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['expense', 'income'] },
        from: { ...dateSchema, description: 'First day, YYYY-MM-DD' },
        to: { ...dateSchema, description: 'Last day, included, YYYY-MM-DD' },
        category: categorySchema,
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'operations',
    description:
      'Single operations between two days, newest or largest first: day, amount, category, note, shop and account. Up to 15.',
    input_schema: {
      type: 'object',
      properties: {
        from: dateSchema,
        to: dateSchema,
        type: { type: 'string', enum: ['expense', 'income', 'transfer'] },
        category: categorySchema,
        search: {
          type: 'string',
          description: 'Words of the note or the shop',
        },
        order: { type: 'string', enum: ['recent', 'largest'] },
        limit: { type: 'integer', minimum: 1, maximum: 15 },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'goals',
    description:
      'The user’s savings goals: saved, target, deadline, what is needed a month, the average actually saved a month over the last three months, and when the goal is reached at that pace.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'budget',
    description:
      'This budget month: income, spending so far, what is safe to spend today, the daily limit, what is left, recurring payments still due, the savings target and category limits with their spending.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'accounts',
    description: 'Balances of the user’s accounts.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'recurring',
    description:
      'Active recurring payments and incomes (subscriptions, rent, salary): amount, how often, the next date, what they make a month.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'propose_goal',
    description:
      'Offer to create a savings goal. The user sees a card and confirms it; it is not created until then.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        target_amount: { type: 'number' },
        currency: {
          type: 'string',
          description: 'ISO code; the base currency when left out',
        },
        deadline: dateSchema,
        emoji: { type: 'string' },
      },
      required: ['title', 'target_amount'],
    },
  },
  {
    name: 'propose_category_limit',
    description:
      'Offer to set a monthly spending limit for an expense category in the budget. The user confirms it on a card.',
    input_schema: {
      type: 'object',
      properties: {
        category: categorySchema,
        amount: {
          type: 'number',
          description: 'A budget month, base currency',
        },
      },
      required: ['category', 'amount'],
    },
  },
  {
    name: 'propose_recurring',
    description:
      'Offer to add a recurring payment or income (a subscription, rent, salary) on the default account. The user confirms it on a card.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        type: { type: 'string', enum: ['expense', 'income'] },
        amount: { type: 'number' },
        category: categorySchema,
        frequency: {
          type: 'string',
          enum: ['daily', 'weekly', 'monthly', 'yearly'],
        },
        day_of_month: { type: 'integer', minimum: 1, maximum: 31 },
        is_subscription: { type: 'boolean' },
      },
      required: ['title', 'type', 'amount', 'frequency'],
    },
  },
];

type Input = Record<string, unknown>;
type Decimal = Prisma.Decimal;
const ZERO = new Prisma.Decimal(0);

/**
 * What the assistant may look up (spec: «AI-ассистент»): read-only views of the user's own
 * data in the base currency, the money already worded the user's way, and proposals that only
 * become cards to confirm. Every figure of an answer comes from here.
 */
@Injectable()
export class AssistantTools {
  constructor(
    private readonly prisma: PrismaService,
    private readonly budget: BudgetService,
    private readonly goals: GoalsService,
    private readonly recurring: RecurringService,
  ) {}

  /** Runs a tool; a mistake in its input goes back to the model as `error`. */
  async run(
    user: AssistantUser,
    name: string,
    input: Input,
    parts: AnswerParts,
    now: Date,
  ): Promise<unknown> {
    try {
      switch (name) {
        case 'spending':
          return await this.spending(user, input, parts);
        case 'operations':
          return await this.operations(user, input);
        case 'goals':
          return await this.goalsView(user, parts);
        case 'budget':
          return await this.budgetView(user, now);
        case 'accounts':
          return await this.accounts(user);
        case 'recurring':
          return await this.recurringView(user);
        case 'propose_goal':
          return await this.proposeGoal(user, input, parts);
        case 'propose_category_limit':
          return this.proposeLimit(user, input, parts);
        case 'propose_recurring':
          return await this.proposeRecurring(user, input, parts);
        default:
          return { error: `No tool ${name}` };
      }
    } catch (error) {
      if (error instanceof ToolInputError) return { error: error.message };
      throw error;
    }
  }

  // ---------- Looking up ----------

  private async spending(
    user: AssistantUser,
    input: Input,
    parts: AnswerParts,
  ) {
    const type = input.type === 'income' ? 'income' : 'expense';
    const { from, to } = this.range(user, input);
    const category = this.category(user, input.category);
    const rows = await this.prisma.transactions.findMany({
      where: {
        user_id: user.id,
        deleted_at: null,
        type,
        occurred_at: this.between(user, from, to),
        ...(category
          ? {
              category: {
                OR: [{ id: category.id }, { parent_id: category.id }],
              },
            }
          : {}),
      },
      select: {
        amount_base: true,
        occurred_at: true,
        category: { select: { id: true, parent_id: true } },
      },
    });
    const total = rows.reduce((sum, row) => sum.add(row.amount_base), ZERO);

    const byCategory = new Map<string | null, Decimal>();
    for (const row of rows) {
      const key = row.category
        ? (row.category.parent_id ?? row.category.id)
        : null;
      byCategory.set(key, (byCategory.get(key) ?? ZERO).add(row.amount_base));
    }
    const names = await this.categoryNames(
      [...byCategory.keys()].filter((id): id is string => id !== null),
      user.language,
    );
    const ranked = [...byCategory.entries()]
      .sort((a, b) => b[1].comparedTo(a[1]))
      .map(([id, amount]) => ({
        name: id ? (names.get(id) ?? '') : NO_CATEGORY[user.language],
        amount,
      }));

    const series = this.series(user, rows, from, to);
    const days = daysBetween(from, to) + 1;
    if (category || days <= 31) {
      parts.addChart({
        kind: 'bars',
        title: category ? category.names[0] : TOTAL_TITLE[type][user.language],
        currency: user.currency.code,
        points: series.map((point) => ({
          label: point.label,
          value: point.amount.toFixed(user.currency.decimals),
        })),
      });
    } else if (ranked.length > 1) {
      parts.addChart({
        kind: 'categories',
        title: TOTAL_TITLE[type][user.language],
        currency: user.currency.code,
        points: ranked.slice(0, 6).map((entry) => ({
          label: entry.name,
          value: entry.amount.toFixed(user.currency.decimals),
        })),
      });
    }
    return {
      type,
      from,
      to,
      category: category?.names[0] ?? null,
      total: this.money(user, total),
      operations: rows.length,
      byCategory: ranked.slice(0, 8).map((entry) => ({
        name: entry.name,
        amount: this.money(user, entry.amount),
        share: total.isZero()
          ? 0
          : Math.round(entry.amount.div(total).toNumber() * 100),
      })),
      overTime: series.map((point) => ({
        period: point.label,
        amount: this.money(user, point.amount),
      })),
    };
  }

  private async operations(user: AssistantUser, input: Input) {
    const { from, to } = this.range(user, input);
    const category = this.category(user, input.category);
    const type =
      input.type === 'income' ||
      input.type === 'transfer' ||
      input.type === 'expense'
        ? input.type
        : undefined;
    const search =
      typeof input.search === 'string' ? input.search.trim().slice(0, 64) : '';
    const limit = Math.min(15, Math.max(1, Number(input.limit) || 10));
    const rows = await this.prisma.transactions.findMany({
      where: {
        user_id: user.id,
        deleted_at: null,
        occurred_at: this.between(user, from, to),
        ...(type ? { type } : {}),
        ...(category
          ? {
              category: {
                OR: [{ id: category.id }, { parent_id: category.id }],
              },
            }
          : {}),
        ...(search
          ? {
              OR: [
                { note: { contains: search, mode: 'insensitive' } },
                { merchant: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy:
        input.order === 'largest'
          ? [{ amount_base: 'desc' }]
          : [{ occurred_at: 'desc' }],
      take: limit,
      select: {
        type: true,
        amount: true,
        amount_base: true,
        occurred_at: true,
        note: true,
        merchant: true,
        currency: { select: { code: true, decimals: true, symbol: true } },
        account: { select: { name: true } },
        category: { select: { id: true } },
      },
    });
    const names = await this.categoryNames(
      rows.flatMap((row) => (row.category ? [row.category.id] : [])),
      user.language,
    );
    return {
      from,
      to,
      operations: rows.map((row) => ({
        day: localDate(row.occurred_at, user.timezone),
        type: row.type,
        amount: money(row.amount, row.currency, user.language),
        inBaseCurrency:
          row.currency.code === user.currency.code
            ? undefined
            : this.money(user, row.amount_base),
        category: row.category ? (names.get(row.category.id) ?? null) : null,
        note: row.note,
        shop: row.merchant,
        account: row.account.name,
      })),
    };
  }

  private async goalsView(user: AssistantUser, parts: AnswerParts) {
    const goals = (await this.goals.list(user.id)).filter(
      (goal) => goal.status !== 'archived',
    );
    const since = addDays(user.today, -90);
    const flows = await this.prisma.goalContributions.groupBy({
      by: ['goal_id', 'type'],
      where: {
        user_id: user.id,
        deleted_at: null,
        created_at: { gte: startOfLocalDay(since, user.timezone) },
      },
      _sum: { amount: true },
    });
    const pace = new Map<string, Decimal>();
    for (const flow of flows) {
      const amount = flow._sum.amount ?? ZERO;
      const signed = flow.type === 'deposit' ? amount : amount.neg();
      pace.set(flow.goal_id, (pace.get(flow.goal_id) ?? ZERO).add(signed));
    }
    const currencies = await this.currencies(
      goals.map((goal) => goal.currency),
    );

    const live = goals.filter((goal) => goal.status !== 'completed');
    if (live.length > 0) {
      parts.addChart({
        kind: 'progress',
        title: GOALS_TITLE[user.language],
        currency: live[0].currency,
        points: live.slice(0, 4).map((goal) => ({
          label: `${goal.emoji} ${goal.title}`,
          value: goal.savedAmount,
          target: goal.targetAmount,
        })),
      });
    }
    return {
      goals: goals.map((goal) => {
        const currency = currencies.get(goal.currency) ?? user.currency;
        const perMonth = (pace.get(goal.id) ?? ZERO).div(3);
        const remaining = new Prisma.Decimal(goal.remaining);
        const months =
          perMonth.gt(0) && remaining.gt(0)
            ? remaining.div(perMonth).toNumber()
            : null;
        return {
          title: `${goal.emoji} ${goal.title}`,
          status: goal.status,
          primary: goal.isPrimary,
          saved: money(goal.savedAmount, currency, user.language),
          target: money(goal.targetAmount, currency, user.language),
          left: money(goal.remaining, currency, user.language),
          progressPercent: goal.progress,
          deadline: goal.deadline ? day(goal.deadline, user.language) : null,
          neededPerMonth: goal.schedule
            ? money(goal.schedule.perMonth, currency, user.language)
            : null,
          onSchedule: goal.schedule?.status ?? null,
          savedPerMonthLately: money(
            perMonth.toFixed(2),
            currency,
            user.language,
          ),
          reachedAtThisPace: remaining.lte(0)
            ? 'reached'
            : months === null
              ? null
              : addDays(user.today, Math.ceil(months * 30.44)),
        };
      }),
    };
  }

  private async budgetView(user: AssistantUser, now: Date) {
    const summary = await this.budget.current(user.id, now);
    const names = await this.categoryNames(
      summary.categoryLimits.map((limit) => limit.categoryId),
      user.language,
    );
    const m = (value: string | null) =>
      value === null ? null : this.money(user, new Prisma.Decimal(value));
    return {
      month: { from: summary.period.start, to: summary.period.end },
      daysLeftIncludingToday: summary.period.daysLeft,
      mode: summary.mode,
      income: m(summary.income.actual),
      plannedIncome: m(summary.income.planned),
      spent: m(summary.expenses.total),
      spentToday: m(summary.expenses.today),
      savedToGoals: m(summary.savedToGoals),
      savingsTarget: m(summary.savingsTarget),
      recurringStillDue: m(summary.upcomingRecurring),
      totalLimit: m(summary.totalLimit),
      leftForTheMonth: m(summary.available),
      dailyLimit: m(summary.dailyLimit),
      safeToSpendToday: m(summary.safeToSpendToday),
      /** ok, overspent, or no_income yet */
      state: summary.state,
      categoryLimits: summary.categoryLimits.map((limit) => ({
        category: names.get(limit.categoryId) ?? '',
        limit: m(limit.limit),
        spent: m(limit.spent),
      })),
    };
  }

  private async accounts(user: AssistantUser) {
    const rows = await this.prisma.accounts.findMany({
      where: { user_id: user.id, deleted_at: null, is_archived: false },
      orderBy: { sort_order: 'asc' },
      select: {
        name: true,
        type: true,
        current_balance: true,
        include_in_total: true,
        currency: { select: { code: true, decimals: true, symbol: true } },
      },
    });
    return {
      accounts: rows.map((row) => ({
        name: row.name,
        type: row.type,
        balance: money(row.current_balance, row.currency, user.language),
        inTotal: row.include_in_total,
      })),
    };
  }

  private async recurringView(user: AssistantUser) {
    const rules = (await this.recurring.list(user.id)).filter(
      (rule) => rule.isActive,
    );
    const currencies = await this.currencies(
      rules.map((rule) => rule.currency),
    );
    const perYear = { daily: 365, weekly: 52, monthly: 12, yearly: 1 };
    return {
      payments: rules.map((rule) => {
        const currency = currencies.get(rule.currency) ?? user.currency;
        const monthly = new Prisma.Decimal(rule.amount)
          .mul(perYear[rule.frequency])
          .div(rule.interval * 12);
        return {
          title: rule.title,
          type: rule.type,
          amount: money(rule.amount, currency, user.language),
          every: `${rule.interval} ${rule.frequency}`,
          next: rule.nextRunOn,
          aMonth: money(
            monthly.toFixed(currency.decimals),
            currency,
            user.language,
          ),
          subscription: rule.isSubscription,
        };
      }),
    };
  }

  // ---------- Proposals ----------

  private async proposeGoal(
    user: AssistantUser,
    input: Input,
    parts: AnswerParts,
  ) {
    this.roomForAction(parts);
    const title = text(input.title, 120);
    const target = positive(input.target_amount);
    const currency =
      typeof input.currency === 'string' && /^[A-Za-z]{3}$/.test(input.currency)
        ? input.currency.toUpperCase()
        : user.currency.code;
    const known = await this.currencies([currency]);
    if (!known.has(currency))
      throw new ToolInputError(`Unknown currency ${currency}`);
    const deadline =
      typeof input.deadline === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(input.deadline)
        ? input.deadline
        : null;
    if (deadline && deadline <= user.today) {
      throw new ToolInputError('The deadline must be after today');
    }
    // One emoji, however many code points it takes (the column holds 8 characters).
    const emoji =
      typeof input.emoji === 'string' &&
      input.emoji.length <= 8 &&
      [...new Intl.Segmenter().segment(input.emoji)].length === 1
        ? input.emoji
        : null;
    parts.actions.push({
      kind: 'create_goal',
      title,
      targetAmount: target.toFixed(known.get(currency)!.decimals),
      currency,
      deadline,
      emoji,
    });
    return PROPOSED;
  }

  private proposeLimit(user: AssistantUser, input: Input, parts: AnswerParts) {
    this.roomForAction(parts);
    const category = this.category(user, input.category);
    if (!category || category.type !== 'expense') {
      throw new ToolInputError('A limit needs an expense category ref');
    }
    parts.actions.push({
      kind: 'category_limit',
      categoryId: category.id,
      categoryName: category.names[0],
      limit: positive(input.amount).toFixed(user.currency.decimals),
      currency: user.currency.code,
    });
    return PROPOSED;
  }

  private async proposeRecurring(
    user: AssistantUser,
    input: Input,
    parts: AnswerParts,
  ) {
    this.roomForAction(parts);
    const type = input.type === 'income' ? 'income' : 'expense';
    const frequency = ['daily', 'weekly', 'monthly', 'yearly'].includes(
      String(input.frequency),
    )
      ? (input.frequency as 'daily' | 'weekly' | 'monthly' | 'yearly')
      : 'monthly';
    const category = this.category(user, input.category);
    if (category && category.type !== type) {
      throw new ToolInputError(`The category is not of ${type}`);
    }
    const account = await this.defaultAccount(user.id);
    if (!account) throw new ToolInputError('The user has no account');
    const dayOfMonth = Number(input.day_of_month);
    parts.actions.push({
      kind: 'recurring',
      title: text(input.title, 64),
      type,
      amount: positive(input.amount).toFixed(account.currency.decimals),
      currency: account.currency.code,
      categoryId: category?.id ?? null,
      categoryName: category?.names[0] ?? null,
      frequency,
      dayOfMonth:
        (frequency === 'monthly' || frequency === 'yearly') &&
        Number.isInteger(dayOfMonth) &&
        dayOfMonth >= 1 &&
        dayOfMonth <= 31
          ? dayOfMonth
          : null,
      isSubscription: input.is_subscription === true,
    });
    return PROPOSED;
  }

  /** The account from the settings, or the first live one: where proposals put money. */
  async defaultAccount(userId: string) {
    const settings = await this.prisma.userSettings.findUnique({
      where: { user_id: userId },
      select: { default_account_id: true },
    });
    const accounts = await this.prisma.accounts.findMany({
      where: { user_id: userId, deleted_at: null, is_archived: false },
      orderBy: { sort_order: 'asc' },
      select: {
        id: true,
        currency: { select: { code: true, decimals: true } },
      },
    });
    return (
      accounts.find((account) => account.id === settings?.default_account_id) ??
      accounts[0] ??
      null
    );
  }

  // ---------- Pieces ----------

  private roomForAction(parts: AnswerParts) {
    if (parts.actions.length >= MAX_ACTIONS) {
      throw new ToolInputError(
        `At most ${MAX_ACTIONS} proposals in one answer`,
      );
    }
  }

  private range(user: AssistantUser, input: Input) {
    const valid = (value: unknown): value is CalendarDate =>
      typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
    if (!valid(input.from) || !valid(input.to)) {
      throw new ToolInputError('from and to are YYYY-MM-DD');
    }
    const to = input.to > user.today ? user.today : input.to;
    let from = input.from > to ? to : input.from;
    if (daysBetween(from, to) >= MAX_RANGE_DAYS) {
      from = addDays(to, -(MAX_RANGE_DAYS - 1));
    }
    return { from, to };
  }

  private between(user: AssistantUser, from: CalendarDate, to: CalendarDate) {
    return {
      gte: startOfLocalDay(from, user.timezone),
      lt: startOfLocalDay(addDays(to, 1), user.timezone),
    };
  }

  private category(user: AssistantUser, ref: unknown): CategoryOption | null {
    if (ref === undefined || ref === null || ref === '') return null;
    const key = typeof ref === 'string' ? ref : JSON.stringify(ref);
    const category = user.categories.get(key);
    if (!category) throw new ToolInputError(`Unknown category ref ${key}`);
    return category;
  }

  /** By day up to a month, by week up to four months, by month beyond. */
  private series(
    user: AssistantUser,
    rows: { amount_base: Decimal; occurred_at: Date }[],
    from: CalendarDate,
    to: CalendarDate,
  ): { label: string; amount: Decimal }[] {
    const days = daysBetween(from, to) + 1;
    const step = days <= 31 ? 'day' : days <= 120 ? 'week' : 'month';
    const buckets: { label: string; start: CalendarDate; amount: Decimal }[] =
      [];
    if (step === 'month') {
      let cursor = `${from.slice(0, 7)}-01` as CalendarDate;
      while (cursor <= to) {
        buckets.push({
          label: cursor.slice(0, 7),
          start: cursor,
          amount: ZERO,
        });
        const [year, month] = cursor.split('-').map(Number);
        cursor = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
      }
    } else {
      const size = step === 'day' ? 1 : 7;
      for (let cursor = from; cursor <= to; cursor = addDays(cursor, size)) {
        buckets.push({ label: cursor, start: cursor, amount: ZERO });
      }
    }
    for (const row of rows) {
      const date = localDate(row.occurred_at, user.timezone);
      let index = buckets.length - 1;
      while (index > 0 && buckets[index].start > date) index--;
      buckets[index].amount = buckets[index].amount.add(row.amount_base);
    }
    return buckets.map(({ label, amount }) => ({ label, amount }));
  }

  private money(user: AssistantUser, amount: Decimal) {
    return money(
      amount.toFixed(user.currency.decimals),
      user.currency,
      user.language,
    );
  }

  private async currencies(
    codes: string[],
  ): Promise<Map<string, CurrencyInfo>> {
    if (codes.length === 0) return new Map();
    const rows = await this.prisma.currencies.findMany({
      where: { code: { in: [...new Set(codes)] } },
      select: { code: true, decimals: true, symbol: true },
    });
    return new Map(rows.map((row) => [row.code, row]));
  }

  private async categoryNames(
    ids: string[],
    language: LanguageCode,
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.categories.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: {
        id: true,
        name: true,
        categoryTranslations: { where: { language }, select: { label: true } },
      },
    });
    return new Map(
      rows.map((row) => [
        row.id,
        row.name ?? row.categoryTranslations[0]?.label ?? '',
      ]),
    );
  }
}

/** A tool called with input that does not hold up; the model reads the reason and retries. */
class ToolInputError extends Error {}

const PROPOSED = {
  proposed: true,
  note: 'The user sees a card with a button to confirm. It is not done until they confirm it.',
};

function text(value: unknown, max: number): string {
  const result = typeof value === 'string' ? value.trim().slice(0, max) : '';
  if (!result) throw new ToolInputError('A title is required');
  return result;
}

function positive(value: unknown): Decimal {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number >= 1e15) {
    throw new ToolInputError('The amount must be a positive number');
  }
  return new Prisma.Decimal(number);
}

const NO_CATEGORY: Record<LanguageCode, string> = {
  uz: 'Toifasiz',
  ru: 'Без категории',
  en: 'No category',
};
const TOTAL_TITLE: Record<
  'expense' | 'income',
  Record<LanguageCode, string>
> = {
  expense: { uz: 'Xarajatlar', ru: 'Расходы', en: 'Spending' },
  income: { uz: 'Daromadlar', ru: 'Доходы', en: 'Income' },
};
const GOALS_TITLE: Record<LanguageCode, string> = {
  uz: 'Maqsadlar',
  ru: 'Цели',
  en: 'Goals',
};
