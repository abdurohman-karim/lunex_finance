import { Injectable, Logger } from '@nestjs/common';
import { BudgetService } from '../budget/budget.service.js';
import {
  addDays,
  asDbDate,
  type CalendarDate,
  daysBetween,
  localDate,
  localHour,
  localMinutes,
  startOfLocalDay,
} from '../common/dates.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { minutesOf, REMINDER_HOUR } from './notification-rules.js';
import {
  budgetAlert,
  dailyReminder,
  goalDeadline,
  money,
  recurringDue,
} from './notification-texts.js';
import { NotificationsService } from './notifications.service.js';

const { Decimal } = Prisma;
const BATCH = 500;
/** The longest «remind N days before» the app offers, plus a day. */
const REMIND_HORIZON_DAYS = 15;

const dateOf = (value: Date): CalendarDate => value.toISOString().slice(0, 10);
/** The instant a local day ends. */
const endOfDay = (date: CalendarDate, timezone: string) =>
  startOfLocalDay(addDays(date, 1), timezone);

/** Finds what is worth a push: the evening reminder, payments ahead, deadlines, limits. */
@Injectable()
export class NotificationPlanner {
  private readonly logger = new Logger(NotificationPlanner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly budget: BudgetService,
  ) {}

  /** Every 5 minutes: plans what is due by now and sends it. */
  async tick(now = new Date()) {
    const reminders = await this.planDailyReminders(now);
    const payments = await this.planRecurringReminders(now);
    const deadlines = await this.planGoalDeadlines(now);
    const sent = await this.notifications.deliverDue(now);
    return { reminders, payments, deadlines, ...sent };
  }

  /**
   * «Запишите траты дня» within an hour after the chosen time, when the day has no operations.
   * `only` limits the run to some users (tests).
   */
  async planDailyReminders(now = new Date(), only?: string[]): Promise<number> {
    let planned = 0;
    let cursor: string | undefined;
    for (;;) {
      const users = await this.prisma.users.findMany({
        where: {
          deleted_at: null,
          onboarding_completed_at: { not: null },
          userSettings: { daily_reminder_enabled: true },
          id: {
            ...(cursor ? { gt: cursor } : {}),
            ...(only ? { in: only } : {}),
          },
        },
        select: {
          id: true,
          timezone: true,
          language: true,
          userSettings: { select: { daily_reminder_time: true } },
        },
        orderBy: { id: 'asc' },
        take: BATCH,
      });
      if (users.length === 0) break;
      cursor = users.at(-1)!.id;
      for (const user of users) {
        const since =
          localMinutes(now, user.timezone) -
          minutesOf(user.userSettings!.daily_reminder_time);
        if (since < 0 || since >= 60) continue;
        const today = localDate(now, user.timezone);
        const dedupeKey = `daily_reminder:${user.id}:${today}`;
        try {
          const told = await this.prisma.notifications.count({
            where: { dedupe_key: dedupeKey },
          });
          if (told > 0) continue;
          const operations = await this.prisma.transactions.count({
            where: {
              user_id: user.id,
              deleted_at: null,
              occurred_at: {
                gte: startOfLocalDay(today, user.timezone),
                lt: endOfDay(today, user.timezone),
              },
            },
          });
          if (operations > 0) continue;
          const id = await this.notifications.notify(
            {
              userId: user.id,
              type: 'daily_reminder',
              dedupeKey,
              text: dailyReminder(user.language),
              data: { link: 'lunex://add', date: today },
              expiresAt: endOfDay(today, user.timezone),
            },
            now,
          );
          if (id) planned++;
        } catch (error) {
          this.fail('Daily reminder', user.id, error);
        }
      }
    }
    return planned;
  }

  /** Reminders of payments that wait for «Записать»: N days before, in the morning, once a run. */
  async planRecurringReminders(
    now = new Date(),
    only?: string[],
  ): Promise<number> {
    let planned = 0;
    let cursor: string | undefined;
    const horizon = addDays(localDate(now, 'UTC'), REMIND_HORIZON_DAYS);
    for (;;) {
      const rules = await this.prisma.recurringRules.findMany({
        where: {
          auto_create: false,
          is_active: true,
          deleted_at: null,
          next_run_on: { lte: asDbDate(horizon) },
          user: { deleted_at: null },
          ...(only ? { user_id: { in: only } } : {}),
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        include: {
          user: { select: { timezone: true, language: true } },
          currency: true,
        },
        orderBy: { id: 'asc' },
        take: BATCH,
      });
      if (rules.length === 0) break;
      cursor = rules.at(-1)!.id;
      for (const rule of rules) {
        const { timezone, language } = rule.user;
        if (localHour(now, timezone) < REMINDER_HOUR) continue;
        const today = localDate(now, timezone);
        const runOn = dateOf(rule.next_run_on);
        if (rule.end_on && runOn > dateOf(rule.end_on)) continue;
        if (today < addDays(runOn, -rule.remind_days_before)) continue;
        try {
          const id = await this.notifications.notify(
            {
              userId: rule.user_id,
              type: 'recurring_due',
              dedupeKey: `recurring_due:${rule.id}:${runOn}`,
              text: recurringDue(
                {
                  title: rule.title,
                  amount: money(rule.amount, rule.currency, language),
                  income: rule.type === 'income',
                  date: runOn,
                  today,
                },
                language,
              ),
              data: { link: 'lunex://recurring', ruleId: rule.id, date: runOn },
              expiresAt: endOfDay(runOn > today ? runOn : today, timezone),
            },
            now,
          );
          if (id) planned++;
        } catch (error) {
          this.fail('Recurring reminder', rule.user_id, error);
        }
      }
    }
    return planned;
  }

  /** A week before a goal's deadline, if it is not reached yet. */
  async planGoalDeadlines(now = new Date(), only?: string[]): Promise<number> {
    let planned = 0;
    const utcToday = localDate(now, 'UTC');
    const goals = await this.prisma.goals.findMany({
      where: {
        status: 'active',
        deleted_at: null,
        // Seven local days ahead is six to eight UTC days, whatever the time zone.
        deadline: {
          gte: asDbDate(addDays(utcToday, 6)),
          lte: asDbDate(addDays(utcToday, 8)),
        },
        user: { deleted_at: null },
        ...(only ? { user_id: { in: only } } : {}),
      },
      include: {
        user: { select: { timezone: true, language: true } },
        currency: true,
      },
    });
    for (const goal of goals) {
      const { timezone, language } = goal.user;
      const deadline = dateOf(goal.deadline!);
      if (daysBetween(localDate(now, timezone), deadline) !== 7) continue;
      if (localHour(now, timezone) < REMINDER_HOUR) continue;
      if (goal.saved_amount.gte(goal.target_amount)) continue;
      try {
        const id = await this.notifications.notify(
          {
            userId: goal.user_id,
            type: 'goal_deadline',
            dedupeKey: `goal_deadline:${goal.id}:${deadline}`,
            text: goalDeadline(
              {
                goal: goal.title,
                emoji: goal.emoji,
                remaining: money(
                  goal.target_amount.minus(goal.saved_amount),
                  goal.currency,
                  language,
                ),
                deadline,
              },
              language,
            ),
            data: { link: `lunex://goals/${goal.id}`, goalId: goal.id },
            expiresAt: endOfDay(localDate(now, timezone), timezone),
          },
          now,
        );
        if (id) planned++;
      } catch (error) {
        this.fail('Goal deadline', goal.user_id, error);
      }
    }
    return planned;
  }

  /**
   * Limits of this budget month crossed: the alert threshold (80 % by default) and 100 %,
   * each once a month. A limit already over 100 % does not report its 80 % afterwards.
   */
  async checkBudget(userId: string, now = new Date()): Promise<number> {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { deleted_at: true, language: true, timezone: true },
    });
    if (!user || user.deleted_at) return 0;
    const summary = await this.budget.current(userId, now);
    const limits = [
      ...(summary.totalLimit === null
        ? []
        : [
            {
              key: 'total',
              categoryId: null,
              limit: summary.totalLimit,
              spent: summary.expenses.total,
              threshold: 80,
            },
          ]),
      ...summary.categoryLimits.map((limit) => ({
        key: limit.categoryId,
        categoryId: limit.categoryId,
        limit: limit.limit,
        spent: limit.spent,
        threshold: limit.alertThresholdPct,
      })),
    ];
    if (limits.length === 0) return 0;

    const prefix = `${userId}:${summary.period.start}`;
    const exceededKey = (key: string) => `budget_exceeded:${prefix}:${key}`;
    const thresholdKey = (key: string, pct: number) =>
      `budget_threshold:${prefix}:${key}:${pct}`;
    const told = new Set(
      (
        await this.prisma.notifications.findMany({
          where: {
            dedupe_key: {
              in: limits.flatMap((l) => [
                exceededKey(l.key),
                thresholdKey(l.key, l.threshold),
              ]),
            },
          },
          select: { dedupe_key: true },
        })
      ).map((row) => row.dedupe_key),
    );
    const { language, timezone } = user;
    const names = await this.categoryNames(
      limits.flatMap((l) => (l.categoryId ? [l.categoryId] : [])),
      language,
    );
    const currency = await this.notifications.currency(summary.currency);
    const expiresAt = endOfDay(summary.period.end, timezone);

    let planned = 0;
    for (const limit of limits) {
      const amount = new Decimal(limit.limit);
      if (amount.lte(0)) continue;
      const spent = new Decimal(limit.spent);
      // Exactly the limit is 100 %; a sum over it reads as over, however little.
      const percent = spent.gt(amount)
        ? Math.max(101, spent.div(amount).times(100).floor().toNumber())
        : spent.div(amount).times(100).floor().toNumber();
      const exceeded = percent >= 100;
      if (!exceeded && percent < limit.threshold) continue;
      if (!exceeded && told.has(exceededKey(limit.key))) continue;
      const id = await this.notifications.notify(
        {
          userId,
          type: exceeded ? 'budget_exceeded' : 'budget_threshold',
          dedupeKey: exceeded
            ? exceededKey(limit.key)
            : thresholdKey(limit.key, limit.threshold),
          text: budgetAlert(
            {
              category: limit.categoryId
                ? (names.get(limit.categoryId) ?? '')
                : null,
              percent,
              spent: money(limit.spent, currency, language),
              limit: money(limit.limit, currency, language),
            },
            language,
          ),
          data: {
            link: 'lunex://budget',
            ...(limit.categoryId ? { categoryId: limit.categoryId } : {}),
          },
          expiresAt,
        },
        now,
      );
      if (id) planned++;
    }
    return planned;
  }

  /** Names in the user's language: system categories from their translations. */
  private async categoryNames(
    ids: string[],
    language: Prisma.CategoryTranslationsWhereInput['language'],
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.categories.findMany({
      where: { id: { in: ids } },
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

  private fail(what: string, userId: string, error: unknown) {
    this.logger.error(
      `${what} for user ${userId} failed: ${(error as Error).message}`,
    );
  }
}
