import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { weekdayOf } from '../auto-save/auto-save-math.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import type { ProFeature } from '../billing/entitlements.js';
import { budgetPeriod } from '../budget/budget-period.js';
import { BudgetService, type BudgetSummary } from '../budget/budget.service.js';
import {
  addDays,
  asDbDate,
  type CalendarDate,
  daysBetween,
  localDate,
  localHour,
  startOfLocalDay,
} from '../common/dates.js';
import { PrismaService } from '../database/prisma.service.js';
import { uuidV5 } from '../database/uuid.js';
import { Prisma } from '../generated/prisma/client.js';
import type {
  AiInsights,
  InsightKind,
  LanguageCode,
} from '../generated/prisma/client.js';
import { GoalsService } from '../goals/goals.service.js';
import {
  type CurrencyInfo,
  day,
  money,
} from '../notifications/notification-texts.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import {
  anomaly,
  ANOMALY_WINDOW_DAYS,
  budgetForecast,
  goalScore,
  type Operation,
  type PeriodReport,
  periodReport,
} from './insight-math.js';
import {
  ANOMALY,
  BUDGET_FORECAST,
  DAILY_TIP,
  GOAL_ANALYSIS,
  type GoalFacts,
  type InsightText,
  MONTHLY_REPORT,
  type ReportFacts,
  type TipFacts,
  WEEKLY_REPORT,
} from './insight-texts.js';
import { InsightWriter, TEMPLATE_MODEL } from './insight-writer.service.js';

type Decimal = Prisma.Decimal;
const { Decimal } = Prisma;

/** Sunday evening: the week's report. */
export const WEEKLY_REPORT_HOUR = 19;
/** Payday morning: last month's report. */
export const MONTHLY_REPORT_HOUR = 10;
/** Midday: is the month heading over its plan? */
export const FORECAST_HOUR = 12;
/** The forecast speaks only once the month has some history and some days left. */
const FORECAST_MIN_ELAPSED = 7;
const FORECAST_MIN_LEFT = 3;
const BATCH = 500;

export interface InsightDto {
  id: string;
  kind: InsightKind;
  title: string;
  summary: string | null;
  recommendation: string | null;
  /** 0–100, goal analysis */
  score: number | null;
  /** Figures and chart data */
  payload: Record<string, unknown> | null;
  goalId: string | null;
  transactionId: string | null;
  periodStart: CalendarDate | null;
  periodEnd: CalendarDate | null;
  language: LanguageCode;
  /** `ai`: written by Claude; `template`: by the server's template */
  source: 'ai' | 'template';
  readAt: Date | null;
  createdAt: Date;
}

export interface InsightPage {
  items: InsightDto[];
  unread: number;
  /** Pass as `before` for older ones; null at the end */
  nextBefore: string | null;
}

interface UserContext {
  id: string;
  language: LanguageCode;
  timezone: string;
  currency: CurrencyInfo;
  monthStartsOnDay: number;
}

const dateOf = (value: Date | null): CalendarDate | null =>
  value ? value.toISOString().slice(0, 10) : null;

function toDto(row: AiInsights): InsightDto {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    recommendation: row.recommendation,
    score: row.score,
    payload: (row.payload as Record<string, unknown> | null) ?? null,
    goalId: row.goal_id,
    transactionId: row.transaction_id,
    periodStart: dateOf(row.period_start),
    periodEnd: dateOf(row.period_end),
    language: row.language,
    source: row.model === TEMPLATE_MODEL ? 'template' : 'ai',
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

/** Insights a deleted operation was about leave the feed with it. */
const visible = (userId: string): Prisma.AiInsightsWhereInput => ({
  user_id: userId,
  OR: [{ transaction_id: null }, { transaction: { deleted_at: null } }],
});

/**
 * AI insights (spec: «AI-инсайты и отчёты»): the server works the numbers out, Claude puts them
 * into words in the user's language (the template when it cannot). The tip of the day is free;
 * reports, anomalies and the forecast are Lunex Pro (`ai_reports`), goal analysis too
 * (`goal_analysis`). Each insight has an id derived from what it is about, so it is made once.
 */
@Injectable()
export class InsightsService {
  private readonly logger = new Logger(InsightsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly budget: BudgetService,
    private readonly goals: GoalsService,
    private readonly writer: InsightWriter,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------- Feed ----------

  async list(
    userId: string,
    before?: string,
    limit = 20,
  ): Promise<InsightPage> {
    const rows = await this.prisma.aiInsights.findMany({
      where: {
        ...visible(userId),
        ...(before ? { created_at: { lt: new Date(before) } } : {}),
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const unread = await this.prisma.aiInsights.count({
      where: { ...visible(userId), read_at: null },
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map(toDto),
      unread,
      nextBefore:
        rows.length > limit ? page.at(-1)!.created_at.toISOString() : null,
    };
  }

  async get(userId: string, id: string): Promise<InsightDto> {
    const row = await this.prisma.aiInsights.findFirst({
      where: { id, ...visible(userId) },
    });
    if (!row) throw this.notFound();
    return toDto(row);
  }

  async markRead(userId: string, id: string, now = new Date()) {
    const { count } = await this.prisma.aiInsights.updateMany({
      where: { id, user_id: userId, read_at: null },
      data: { read_at: now },
    });
    if (count === 0) await this.get(userId, id);
  }

  async markAllRead(userId: string, now = new Date()) {
    await this.prisma.aiInsights.updateMany({
      where: { user_id: userId, read_at: null },
      data: { read_at: now },
    });
  }

  // ---------- Tip of the day (Free) ----------

  /** Today's tip, made the first time it is asked for; one a day in the user's time zone. */
  async dailyTip(userId: string, now = new Date()): Promise<InsightDto> {
    const user = await this.context(userId);
    const today = localDate(now, user.timezone);
    const id = uuidV5(`daily_tip:${userId}:${today}`);
    const existing = await this.prisma.aiInsights.findUnique({ where: { id } });
    if (existing) return toDto(existing);

    const summary = await this.budget.current(userId, now);
    const facts = await this.tipFacts(user, summary);
    const { text, model } = await this.writer.write({
      userId,
      kind: 'daily_tip',
      language: user.language,
      facts,
      template: DAILY_TIP[user.language](facts),
      tier: 'fast',
    });
    return this.save(user, id, 'daily_tip', text, model, {
      period_start: asDbDate(today),
      period_end: asDbDate(today),
      payload: {
        currency: summary.currency,
        situation: facts.situation,
        safeToSpendToday: summary.safeToSpendToday,
        dailyLimit: summary.dailyLimit,
        daysLeft: summary.period.daysLeft,
      },
    });
  }

  private async tipFacts(
    user: UserContext,
    summary: BudgetSummary,
  ): Promise<TipFacts> {
    const m = (value: string) => money(value, user.currency, user.language);
    const base = {
      safeToSpend: m(summary.safeToSpendToday),
      dailyLimit: m(summary.dailyLimit),
      daysLeft: summary.period.daysLeft,
    };
    if (summary.state === 'no_income')
      return { situation: 'no_income', ...base };
    const safe = new Decimal(summary.safeToSpendToday);
    if (safe.lt(0)) {
      return {
        situation: 'overspent',
        ...base,
        overBy: m(safe.neg().toString()),
      };
    }

    const goal = await this.primaryGoal(user.id);
    if (goal?.schedule?.status === 'behind') {
      const currency = await this.notifications.currency(goal.currency);
      return {
        situation: 'goal_behind',
        ...base,
        goal: {
          title: goal.title,
          perDay: money(goal.schedule.perDay, currency, user.language),
        },
      };
    }

    const expenses = new Decimal(summary.expenses.total);
    const top = summary.byCategory[0];
    const elapsed = summary.period.daysTotal - summary.period.daysLeft + 1;
    if (top?.categoryId && expenses.gt(0) && elapsed >= 3) {
      const share = new Decimal(top.amount)
        .dividedBy(expenses)
        .times(100)
        .round()
        .toNumber();
      if (share >= 35) {
        const names = await this.categoryNames([top.categoryId], user.language);
        return {
          situation: 'top_category',
          ...base,
          category: {
            name: names.get(top.categoryId) ?? '',
            sharePercent: share,
          },
        };
      }
    }
    if (goal?.schedule?.status === 'ahead') {
      return {
        situation: 'goal_ahead',
        ...base,
        goal: { title: goal.title, perDay: '' },
      };
    }
    return { situation: 'steady', ...base };
  }

  // ---------- Goal analysis (Pro) ----------

  /**
   * A conclusion, a next step and a score 0–100 for a goal; asked again the same day with the
   * same figures, the same analysis comes back.
   */
  async goalAnalysis(
    userId: string,
    goalId: string,
    now = new Date(),
  ): Promise<InsightDto> {
    await this.entitlements.assertFeature(userId, 'goal_analysis');
    const user = await this.context(userId);
    const goal = await this.goals.get(userId, goalId);
    const today = localDate(now, user.timezone);
    const id = uuidV5(
      `goal_analysis:${goal.id}:${today}:${goal.savedAmount}:${goal.targetAmount}:${goal.deadline ?? ''}:${goal.status}`,
    );
    const existing = await this.prisma.aiInsights.findUnique({ where: { id } });
    if (existing) return toDto(existing);

    const currency = await this.notifications.currency(goal.currency);
    const m = (value: string) => money(value, currency, user.language);
    const monthsWithDeposits = await this.monthsWithDeposits(
      goal.id,
      user.timezone,
      today,
    );
    const reached = goal.progress >= 100 || goal.status === 'completed';
    const score = goalScore({
      progress: goal.progress,
      saved: new Decimal(goal.savedAmount),
      expectedSaved: goal.schedule
        ? new Decimal(goal.schedule.expectedSaved)
        : null,
      monthsWithDeposits,
    });
    const facts: GoalFacts = {
      title: goal.title,
      progress: Math.min(goal.progress, 100),
      saved: m(goal.savedAmount),
      target: m(goal.targetAmount),
      score,
      status: reached ? 'reached' : (goal.schedule?.status ?? 'no_deadline'),
      perMonth: goal.schedule ? m(goal.schedule.perMonth) : null,
      deadline: goal.deadline ? day(goal.deadline, user.language) : null,
      monthsWithDeposits,
    };
    const { text, model } = await this.writer.write({
      userId,
      kind: 'goal_analysis',
      language: user.language,
      facts,
      template: GOAL_ANALYSIS[user.language](facts),
    });
    return this.save(user, id, 'goal_analysis', text, model, {
      goal_id: goal.id,
      score,
      payload: {
        currency: goal.currency,
        saved: goal.savedAmount,
        target: goal.targetAmount,
        progress: goal.progress,
        status: facts.status,
        deadline: goal.deadline,
        perDay: goal.schedule?.perDay ?? null,
        perMonth: goal.schedule?.perMonth ?? null,
        daysLeft: goal.schedule?.daysLeft ?? null,
        monthsWithDeposits,
      },
    });
  }

  // ---------- Reports (Pro) ----------

  /** The seven days ending today against the seven before; null when there was nothing or it is made already. */
  async weeklyReport(
    userId: string,
    now = new Date(),
  ): Promise<InsightDto | null> {
    const user = await this.context(userId);
    const end = localDate(now, user.timezone);
    const start = addDays(end, -6);
    return this.report(
      user,
      'weekly_report',
      { start, end },
      {
        start: addDays(start, -7),
        end: addDays(start, -1),
      },
      `${day(start, user.language)} – ${day(end, user.language)}`,
    );
  }

  /** The budget month that just ended against the one before it; null as for the week. */
  async monthlyReport(
    userId: string,
    now = new Date(),
  ): Promise<InsightDto | null> {
    const user = await this.context(userId);
    const today = localDate(now, user.timezone);
    const current = budgetPeriod(today, user.monthStartsOnDay);
    const last = budgetPeriod(
      addDays(current.start, -1),
      user.monthStartsOnDay,
    );
    const before = budgetPeriod(addDays(last.start, -1), user.monthStartsOnDay);
    const name =
      user.monthStartsOnDay === 1
        ? new Intl.DateTimeFormat(LOCALE[user.language], {
            month: 'long',
            year: 'numeric',
            timeZone: 'UTC',
          }).format(new Date(`${last.start}T00:00:00Z`))
        : `${day(last.start, user.language)} – ${day(last.end, user.language)}`;
    return this.report(user, 'monthly_report', last, before, name);
  }

  private async report(
    user: UserContext,
    kind: 'weekly_report' | 'monthly_report',
    period: { start: CalendarDate; end: CalendarDate },
    previous: { start: CalendarDate; end: CalendarDate },
    name: string,
  ): Promise<InsightDto | null> {
    const id = uuidV5(`${kind}:${user.id}:${period.start}`);
    if (await this.prisma.aiInsights.findUnique({ where: { id } })) return null;

    const [current, earlier] = await Promise.all([
      this.operations(user, period.start, addDays(period.end, 1)),
      this.operations(user, previous.start, addDays(previous.end, 1)),
    ]);
    if (current.length === 0) return null;
    const days = Array.from(
      { length: daysBetween(period.start, period.end) + 1 },
      (_, i) => addDays(period.start, i),
    );
    const report = periodReport(current, earlier, days);
    const names = await this.categoryNames(
      report.categories.flatMap((line) =>
        line.categoryId ? [line.categoryId] : [],
      ),
      user.language,
    );
    const facts = this.reportFacts(user, report, names, name);
    const { text, model } = await this.writer.write({
      userId: user.id,
      kind,
      language: user.language,
      facts,
      template: (kind === 'weekly_report' ? WEEKLY_REPORT : MONTHLY_REPORT)[
        user.language
      ](facts),
    });
    const fixed = (value: Decimal) => value.toFixed(user.currency.decimals);
    const insight = await this.save(user, id, kind, text, model, {
      period_start: asDbDate(period.start),
      period_end: asDbDate(period.end),
      payload: {
        currency: user.currency.code,
        income: fixed(report.income),
        expense: fixed(report.expense),
        previousIncome: fixed(report.previousIncome),
        previousExpense: fixed(report.previousExpense),
        changePercent: report.expenseChangePercent,
        categories: report.categories.slice(0, 6).map((line) => ({
          categoryId: line.categoryId,
          name: line.categoryId ? (names.get(line.categoryId) ?? '') : null,
          amount: fixed(line.amount),
          previous: fixed(line.previous),
          changePercent: line.changePercent,
        })),
        days: report.days.map((entry) => ({
          date: entry.date,
          expense: fixed(entry.expense),
        })),
      },
    });
    await this.push(user, insight, 'weekly_report', 2);
    return insight;
  }

  private reportFacts(
    user: UserContext,
    report: PeriodReport,
    names: Map<string, string>,
    period: string,
  ): ReportFacts {
    const m = (value: Decimal) => money(value, user.currency, user.language);
    const name = (id: string | null) =>
      id ? (names.get(id) ?? '') : UNCATEGORIZED[user.language];
    const top = report.categories[0];
    return {
      period,
      expense: m(report.expense),
      income: m(report.income),
      changePercent: report.expenseChangePercent,
      topCategory: top
        ? {
            name: name(top.categoryId),
            amount: m(top.amount),
            sharePercent: report.expense.gt(0)
              ? top.amount
                  .dividedBy(report.expense)
                  .times(100)
                  .round()
                  .toNumber()
              : 0,
          }
        : null,
      biggestIncrease: report.biggestIncrease
        ? {
            name: name(report.biggestIncrease.categoryId),
            amount: m(report.biggestIncrease.amount),
            changePercent: report.biggestIncrease.changePercent,
          }
        : null,
    };
  }

  /** At midday: will the month end within its plan? Once per month and verdict. */
  async budgetForecast(
    userId: string,
    now = new Date(),
  ): Promise<InsightDto | null> {
    const user = await this.context(userId);
    const summary = await this.budget.current(userId, now);
    const { daysTotal, daysLeft } = summary.period;
    if (
      daysTotal - daysLeft + 1 < FORECAST_MIN_ELAPSED ||
      daysLeft < FORECAST_MIN_LEFT
    ) {
      return null;
    }
    const spent = new Decimal(summary.expenses.total);
    const upcoming = new Decimal(summary.upcomingRecurring);
    const reserved = Decimal.max(
      new Decimal(summary.savingsTarget),
      new Decimal(summary.savedToGoals),
    );
    const basis = new Decimal(summary.income.basis).minus(reserved);
    const plan = summary.totalLimit
      ? new Decimal(summary.totalLimit)
      : basis.gt(0)
        ? basis
        : null;
    const forecast = budgetForecast({
      spent,
      upcomingRecurring: upcoming,
      daysTotal,
      daysLeft,
      plan,
      decimals: user.currency.decimals,
    });
    if (forecast.verdict === 'unknown' || !forecast.plan || !forecast.overBy) {
      return null;
    }
    const id = uuidV5(
      `budget_forecast:${userId}:${summary.period.start}:${forecast.verdict}`,
    );
    const existing = await this.prisma.aiInsights.findUnique({ where: { id } });
    if (existing) return null;

    const m = (value: Decimal) => money(value, user.currency, user.language);
    const room = Decimal.max(forecast.plan.minus(spent).minus(upcoming), 0);
    const facts = {
      forecast: m(forecast.forecast),
      plan: m(forecast.plan),
      difference: m(forecast.overBy.abs()),
      verdict: forecast.verdict,
      daysLeft,
      perDayToStay: m(
        room
          .dividedBy(daysLeft)
          .toDecimalPlaces(user.currency.decimals, Decimal.ROUND_DOWN),
      ),
    };
    const { text, model } = await this.writer.write({
      userId,
      kind: 'budget_forecast',
      language: user.language,
      facts,
      template: BUDGET_FORECAST[user.language](facts),
      tier: 'fast',
    });
    const fixed = (value: Decimal) => value.toFixed(user.currency.decimals);
    const insight = await this.save(user, id, 'budget_forecast', text, model, {
      period_start: asDbDate(summary.period.start),
      period_end: asDbDate(summary.period.end),
      payload: {
        currency: user.currency.code,
        forecast: fixed(forecast.forecast),
        plan: fixed(forecast.plan),
        spent: fixed(spent),
        upcomingRecurring: fixed(upcoming),
        overBy: fixed(forecast.overBy),
        verdict: forecast.verdict,
        daysLeft,
      },
    });
    // Only a month heading over its plan is worth a push.
    if (forecast.verdict === 'over')
      await this.push(user, insight, 'insight', 1);
    return insight;
  }

  /** A new expense far above its category's usual: noted and pushed, once. */
  async checkAnomaly(
    userId: string,
    transactionId: string,
  ): Promise<InsightDto | null> {
    const tx = await this.prisma.transactions.findUnique({
      where: { id: transactionId },
      select: {
        id: true,
        user_id: true,
        type: true,
        amount_base: true,
        category_id: true,
        occurred_at: true,
        note: true,
        merchant: true,
        deleted_at: true,
      },
    });
    if (
      !tx ||
      tx.user_id !== userId ||
      tx.type !== 'expense' ||
      tx.deleted_at ||
      !tx.category_id
    ) {
      return null;
    }
    if (!(await this.allows(userId, 'ai_reports'))) return null;
    const id = uuidV5(`anomaly:${tx.id}`);
    if (await this.prisma.aiInsights.findUnique({ where: { id } })) return null;

    const since = new Date(
      tx.occurred_at.getTime() - ANOMALY_WINDOW_DAYS * 86_400_000,
    );
    const history = await this.prisma.transactions.findMany({
      where: {
        user_id: userId,
        type: 'expense',
        category_id: tx.category_id,
        deleted_at: null,
        id: { not: tx.id },
        occurred_at: { gte: since, lt: tx.occurred_at },
      },
      select: { amount_base: true },
    });
    const found = anomaly(
      tx.amount_base,
      history.map((row) => row.amount_base),
    );
    if (!found) return null;

    const user = await this.context(userId);
    const names = await this.categoryNames([tx.category_id], user.language);
    const m = (value: Decimal) => money(value, user.currency, user.language);
    const facts = {
      amount: m(tx.amount_base),
      median: m(found.median.toDecimalPlaces(user.currency.decimals)),
      ratio: found.ratio,
      category: names.get(tx.category_id) ?? '',
      date: day(localDate(tx.occurred_at, user.timezone), user.language),
      note: tx.merchant ?? tx.note ?? null,
    };
    const { text, model } = await this.writer.write({
      userId,
      kind: 'anomaly',
      language: user.language,
      facts,
      template: ANOMALY[user.language](facts),
      tier: 'fast',
    });
    const insight = await this.save(user, id, 'anomaly', text, model, {
      transaction_id: tx.id,
      payload: {
        currency: user.currency.code,
        amount: tx.amount_base.toFixed(user.currency.decimals),
        median: found.median.toFixed(user.currency.decimals),
        ratio: found.ratio,
        categoryId: tx.category_id,
        categoryName: facts.category,
        occurredAt: tx.occurred_at.toISOString(),
      },
    });
    await this.push(user, insight, 'insight', 1);
    return insight;
  }

  /**
   * Every hour: the weekly report on Sunday evening, last month's on payday morning, the
   * forecast at midday, each at the user's own hour and only for Lunex Pro.
   */
  async runHourly(now = new Date(), only?: string[]) {
    const done = { weekly: 0, monthly: 0, forecasts: 0 };
    let cursor: string | undefined;
    for (;;) {
      const users = await this.prisma.users.findMany({
        where: {
          deleted_at: null,
          onboarding_completed_at: { not: null },
          id: {
            ...(cursor ? { gt: cursor } : {}),
            ...(only ? { in: only } : {}),
          },
        },
        select: {
          id: true,
          timezone: true,
          userSettings: { select: { month_starts_on_day: true } },
        },
        orderBy: { id: 'asc' },
        take: BATCH,
      });
      if (users.length === 0) break;
      cursor = users.at(-1)!.id;
      for (const user of users) {
        const hour = localHour(now, user.timezone);
        const today = localDate(now, user.timezone);
        const weekly = hour === WEEKLY_REPORT_HOUR && weekdayOf(today) === 7;
        const monthly =
          hour === MONTHLY_REPORT_HOUR &&
          budgetPeriod(today, user.userSettings?.month_starts_on_day ?? 1)
            .start === today;
        const forecast = hour === FORECAST_HOUR;
        if (!weekly && !monthly && !forecast) continue;
        try {
          if (!(await this.allows(user.id, 'ai_reports'))) continue;
          if (weekly && (await this.weeklyReport(user.id, now))) done.weekly++;
          if (monthly && (await this.monthlyReport(user.id, now)))
            done.monthly++;
          if (forecast && (await this.budgetForecast(user.id, now)))
            done.forecasts++;
        } catch (error) {
          this.logger.error(
            `Insights for user ${user.id} failed: ${(error as Error).message}`,
          );
        }
      }
    }
    return done;
  }

  // ---------- Internals ----------

  private async save(
    user: UserContext,
    id: string,
    kind: InsightKind,
    text: InsightText,
    model: string,
    extra: Omit<
      Prisma.AiInsightsCreateManyInput,
      | 'id'
      | 'user_id'
      | 'kind'
      | 'language'
      | 'title'
      | 'summary'
      | 'recommendation'
      | 'model'
    >,
  ): Promise<InsightDto> {
    // Made twice at once (two devices asking for the tip): the first one stays.
    await this.prisma.aiInsights.createMany({
      data: [
        {
          ...extra,
          id,
          user_id: user.id,
          kind,
          language: user.language,
          title: text.title.slice(0, 160),
          summary: text.summary,
          recommendation: text.recommendation,
          model: model.slice(0, 64),
        },
      ],
      skipDuplicates: true,
    });
    return toDto(
      await this.prisma.aiInsights.findUniqueOrThrow({ where: { id } }),
    );
  }

  private async push(
    user: UserContext,
    insight: InsightDto,
    type: 'weekly_report' | 'insight',
    days: number,
  ) {
    await this.notifications.notify({
      userId: user.id,
      type,
      dedupeKey: `${type}:${insight.id}`,
      text: {
        title: insight.title,
        body: (insight.summary ?? '').slice(0, 500),
      },
      data: { link: `lunex://insights/${insight.id}`, insightId: insight.id },
      expiresAt: new Date(Date.now() + days * 86_400_000),
    });
  }

  private async allows(userId: string, feature: ProFeature) {
    return (await this.entitlements.getAccess(userId)).features.includes(
      feature,
    );
  }

  private async context(userId: string): Promise<UserContext> {
    const user = await this.prisma.users.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        language: true,
        timezone: true,
        baseCurrency: { select: { code: true, decimals: true, symbol: true } },
        userSettings: { select: { month_starts_on_day: true } },
      },
    });
    return {
      id: user.id,
      language: user.language,
      timezone: user.timezone,
      currency: user.baseCurrency,
      monthStartsOnDay: user.userSettings?.month_starts_on_day ?? 1,
    };
  }

  /** Incomes and expenses in the base currency from `from` up to (not including) `to`. */
  private async operations(
    user: UserContext,
    from: CalendarDate,
    to: CalendarDate,
  ): Promise<Operation[]> {
    const rows = await this.prisma.transactions.findMany({
      where: {
        user_id: user.id,
        deleted_at: null,
        type: { in: ['income', 'expense'] },
        occurred_at: {
          gte: startOfLocalDay(from, user.timezone),
          lt: startOfLocalDay(to, user.timezone),
        },
      },
      select: {
        type: true,
        amount_base: true,
        occurred_at: true,
        category: { select: { id: true, parent_id: true } },
      },
    });
    return rows.map((row) => ({
      type: row.type as Operation['type'],
      amount: row.amount_base,
      categoryId: row.category
        ? (row.category.parent_id ?? row.category.id)
        : null,
      date: localDate(row.occurred_at, user.timezone),
    }));
  }

  private async primaryGoal(userId: string) {
    const goals = await this.goals.list(userId);
    const live = goals.filter((goal) => goal.status === 'active');
    return live.find((goal) => goal.isPrimary) ?? live[0] ?? null;
  }

  /** Of the last three months (the current one included), how many had a deposit. */
  private async monthsWithDeposits(
    goalId: string,
    timezone: string,
    today: CalendarDate,
  ): Promise<number> {
    const [year, month] = today.split('-').map(Number);
    const start = new Date(Date.UTC(year, month - 3, 1))
      .toISOString()
      .slice(0, 10);
    const rows = await this.prisma.goalContributions.findMany({
      where: {
        goal_id: goalId,
        type: 'deposit',
        deleted_at: null,
        created_at: { gte: startOfLocalDay(start, timezone) },
      },
      select: { created_at: true },
    });
    return new Set(
      rows.map((row) => localDate(row.created_at, timezone).slice(0, 7)),
    ).size;
  }

  private async categoryNames(
    ids: string[],
    language: LanguageCode,
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

  private notFound() {
    return new NotFoundException({
      code: 'insight_not_found',
      message: 'Insight not found',
    });
  }
}

const LOCALE: Record<LanguageCode, string> = {
  uz: 'uz-Latn',
  ru: 'ru',
  en: 'en',
};

const UNCATEGORIZED: Record<LanguageCode, string> = {
  uz: 'Toifasiz',
  ru: 'Без категории',
  en: 'Uncategorized',
};
