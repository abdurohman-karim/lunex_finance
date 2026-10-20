import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EntitlementsService } from '../billing/entitlements.service.js';
import {
  asDbDate,
  type CalendarDate,
  localDate,
  localHour,
} from '../common/dates.js';
import { assertCurrencyPrecision } from '../common/schemas.js';
import { PrismaService } from '../database/prisma.service.js';
import { uuidV5 } from '../database/uuid.js';
import { FxService } from '../finance/fx.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type {
  AutoSaveRuleType,
  ContributionMethod,
} from '../generated/prisma/enums.js';
import { GoalsService } from '../goals/goals.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import {
  type ChangeWindow,
  type ChangesPage,
  changeOrder,
  changeWindowWhere,
  lastPosition,
} from '../sync/sync-window.js';
import {
  type AutoSaveSchedule,
  firstRunOnOrAfter,
  nextRunAfter,
  roundUpChange,
  shareOf,
  weekdayOf,
} from './auto-save-math.js';
import type {
  CreateAutoSaveInput,
  UpdateAutoSaveInput,
} from './auto-save.schemas.js';

type Decimal = Prisma.Decimal;
const { Decimal } = Prisma;

/** Local hour a scheduled amount is set aside. */
export const AUTO_SAVE_HOUR = 9;

const include = {
  sourceAccount: {
    select: { currency: { select: { code: true, decimals: true } } },
  },
} as const;
type RuleRow = Prisma.AutoSaveRulesGetPayload<{ include: typeof include }>;

export interface AutoSaveRuleDto {
  id: string;
  goalId: string;
  type: AutoSaveRuleType;
  /** fixed_schedule, in the source account's currency */
  amount: string | null;
  /** percent_of_income */
  percent: string | null;
  /** round_up: the step expenses are rounded up to */
  roundTo: string | null;
  /** The source account's currency */
  currency: string;
  frequency: 'daily' | 'weekly' | 'monthly' | null;
  weekday: number | null;
  dayOfMonth: number | null;
  sourceAccountId: string;
  /** fixed_schedule: the next day money is set aside */
  nextRunOn: CalendarDate | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export type RunOutcome = 'saved' | 'skipped' | 'paused' | 'none';

const day = (value: Date): CalendarDate => value.toISOString().slice(0, 10);

function toDto(row: RuleRow): AutoSaveRuleDto {
  const money = (value: Decimal | null) =>
    value === null ? null : value.toFixed(row.sourceAccount.currency.decimals);
  return {
    id: row.id,
    goalId: row.goal_id,
    type: row.type,
    amount: money(row.amount),
    percent: row.percent === null ? null : row.percent.toString(),
    roundTo: money(row.round_to),
    currency: row.sourceAccount.currency.code,
    frequency: row.frequency as AutoSaveRuleDto['frequency'],
    weekday: row.weekday,
    dayOfMonth: row.day_of_month,
    sourceAccountId: row.source_account_id,
    nextRunOn: row.next_run_on ? day(row.next_run_on) : null,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function schedule(row: {
  frequency: string | null;
  weekday: number | null;
  day_of_month: number | null;
}): AutoSaveSchedule {
  return {
    frequency: (row.frequency ?? 'monthly') as AutoSaveSchedule['frequency'],
    weekday: row.weekday,
    dayOfMonth: row.day_of_month,
  };
}

const conflict = (code: string, message: string) =>
  new ConflictException({ code, message });

/**
 * Auto-save (spec: «Автонакопления»): a fixed amount on a schedule, a share of every income
 * and the change of every expense rounded up move into a goal by themselves, on the server.
 * Amounts are in the source account's currency; a contribution's id comes from the rule and
 * its day or operation, so nothing is set aside twice.
 */
@Injectable()
export class AutoSaveService {
  private readonly logger = new Logger(AutoSaveService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly goals: GoalsService,
    private readonly entitlements: EntitlementsService,
    private readonly fx: FxService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(userId: string, goalId?: string): Promise<AutoSaveRuleDto[]> {
    const rows = await this.prisma.autoSaveRules.findMany({
      where: {
        user_id: userId,
        deleted_at: null,
        ...(goalId ? { goal_id: goalId } : {}),
      },
      include,
      orderBy: { created_at: 'asc' },
    });
    return rows.map(toDto);
  }

  async changes(
    userId: string,
    window: ChangeWindow,
  ): Promise<ChangesPage<AutoSaveRuleDto>> {
    const rows = await this.prisma.autoSaveRules.findMany({
      where: {
        user_id: userId,
        ...changeWindowWhere(window),
      } as Prisma.AutoSaveRulesWhereInput,
      include,
      orderBy: changeOrder(),
      take: window.limit,
    });
    return {
      items: rows.map(toDto),
      last: lastPosition(rows, (row) => ({
        updatedAt: row.updated_at,
        id: row.id,
      })),
    };
  }

  /** Lunex Pro. Idempotent: the same id again returns the rule as first created. */
  async create(
    userId: string,
    input: CreateAutoSaveInput,
  ): Promise<AutoSaveRuleDto> {
    const existing = await this.prisma.autoSaveRules.findUnique({
      where: { id: input.id },
      include,
    });
    if (existing) {
      if (existing.user_id !== userId) throw this.notFound();
      return toDto(existing);
    }
    await this.entitlements.assertFeature(userId, 'auto_save');
    await this.liveGoal(userId, input.goalId);
    const account = await this.usableAccount(userId, input.sourceAccountId);

    let next: CalendarDate | null = null;
    let fields: Partial<Prisma.AutoSaveRulesUncheckedCreateInput> = {};
    if (input.type === 'fixed_schedule') {
      assertCurrencyPrecision(input.amount, account.currency);
      const today = await this.today(userId);
      const rule = {
        frequency: input.frequency,
        weekday:
          input.frequency === 'weekly'
            ? (input.weekday ?? weekdayOf(today))
            : null,
        dayOfMonth:
          input.frequency === 'monthly'
            ? (input.dayOfMonth ?? Number(today.slice(8)))
            : null,
      };
      next = firstRunOnOrAfter(rule, today);
      fields = {
        amount: new Decimal(input.amount),
        frequency: rule.frequency,
        weekday: rule.weekday,
        day_of_month: rule.dayOfMonth,
      };
    } else if (input.type === 'percent_of_income') {
      fields = { percent: new Decimal(input.percent) };
    } else {
      assertCurrencyPrecision(input.roundTo, account.currency);
      fields = { round_to: new Decimal(input.roundTo) };
    }

    const row = await this.prisma.autoSaveRules.create({
      data: {
        id: input.id,
        user_id: userId,
        goal_id: input.goalId,
        type: input.type,
        source_account_id: account.id,
        next_run_on: next ? asDbDate(next) : null,
        ...fields,
      },
      include,
    });
    return toDto(row);
  }

  async update(
    userId: string,
    id: string,
    patch: UpdateAutoSaveInput,
  ): Promise<AutoSaveRuleDto> {
    const rule = await this.owned(userId, id);
    if (patch.isActive && !rule.is_active) {
      await this.entitlements.assertFeature(userId, 'auto_save');
      await this.liveGoal(userId, rule.goal_id);
    }
    const ownFields: Record<AutoSaveRuleType, (keyof UpdateAutoSaveInput)[]> = {
      fixed_schedule: ['amount', 'frequency', 'weekday', 'dayOfMonth'],
      percent_of_income: ['percent'],
      round_up: ['roundTo'],
    };
    const foreign = (
      [
        'amount',
        'percent',
        'roundTo',
        'frequency',
        'weekday',
        'dayOfMonth',
      ] as const
    ).filter(
      (field) =>
        patch[field] !== undefined && !ownFields[rule.type].includes(field),
    );
    if (foreign.length > 0) {
      throw new BadRequestException({
        code: 'field_not_allowed',
        message: `A ${rule.type} rule has no ${foreign.join(', ')}`,
      });
    }

    const account = patch.sourceAccountId
      ? await this.usableAccount(userId, patch.sourceAccountId)
      : await this.prisma.accounts.findUniqueOrThrow({
          where: { id: rule.source_account_id },
          include: { currency: true },
        });
    for (const value of [patch.amount, patch.roundTo]) {
      if (value) assertCurrencyPrecision(value, account.currency);
    }

    let nextRunOn: Date | undefined;
    const rescheduled =
      rule.type === 'fixed_schedule' &&
      (patch.frequency !== undefined ||
        patch.weekday !== undefined ||
        patch.dayOfMonth !== undefined ||
        (patch.isActive === true && !rule.is_active));
    const frequency = patch.frequency ?? rule.frequency;
    const today = rescheduled ? await this.today(userId) : null;
    const weekday =
      frequency === 'weekly'
        ? (patch.weekday ?? rule.weekday ?? weekdayOf(today ?? day(new Date())))
        : null;
    const dayOfMonth =
      frequency === 'monthly'
        ? (patch.dayOfMonth ??
          rule.day_of_month ??
          Number((today ?? day(new Date())).slice(8)))
        : null;
    if (rescheduled && today) {
      nextRunOn = asDbDate(
        firstRunOnOrAfter(
          {
            frequency: frequency as AutoSaveSchedule['frequency'],
            weekday,
            dayOfMonth,
          },
          today,
        ),
      );
    }

    const row = await this.prisma.autoSaveRules.update({
      where: { id },
      data: {
        amount: patch.amount ? new Decimal(patch.amount) : undefined,
        percent: patch.percent ? new Decimal(patch.percent) : undefined,
        round_to: patch.roundTo ? new Decimal(patch.roundTo) : undefined,
        ...(rule.type === 'fixed_schedule'
          ? { frequency, weekday, day_of_month: dayOfMonth }
          : {}),
        source_account_id: patch.sourceAccountId,
        next_run_on: nextRunOn,
        is_active: patch.isActive,
      },
      include,
    });
    return toDto(row);
  }

  /** Contributions it made stay in the goal. */
  async remove(userId: string, id: string): Promise<void> {
    const rule = await this.owned(userId, id, { allowDeleted: true });
    if (rule.deleted_at) return;
    await this.prisma.autoSaveRules.update({
      where: { id },
      data: { deleted_at: new Date(), is_active: false },
    });
  }

  // ---------- Running ----------

  /**
   * Hourly: scheduled amounts due today in each user's zone, from 09:00. Days missed while
   * the server was down do not pile up: a rule sets aside once, then waits for its next day.
   */
  async runDue(
    now = new Date(),
    userId?: string,
  ): Promise<Record<RunOutcome, number>> {
    // The furthest «today» on Earth (UTC+14): later runs are not due anywhere yet.
    const latestToday = localDate(now, 'Pacific/Kiritimati');
    const rules = await this.prisma.autoSaveRules.findMany({
      where: {
        ...(userId ? { user_id: userId } : {}),
        type: 'fixed_schedule',
        is_active: true,
        deleted_at: null,
        next_run_on: { lte: asDbDate(latestToday) },
        user: { deleted_at: null },
      },
      include: { ...include, user: { select: { timezone: true } } },
    });
    const counts: Record<RunOutcome, number> = {
      saved: 0,
      skipped: 0,
      paused: 0,
      none: 0,
    };
    for (const rule of rules) {
      const timezone = rule.user.timezone;
      const today = localDate(now, timezone);
      const due = day(rule.next_run_on!);
      if (due > today) continue;
      if (due === today && localHour(now, timezone) < AUTO_SAVE_HOUR) continue;
      try {
        const outcome = await this.execute(
          rule,
          rule.amount!,
          uuidV5(`auto-save:${rule.id}:${today}`),
          'auto_save',
          today,
          now,
        );
        counts[outcome]++;
      } catch (error) {
        this.logger.error(
          `Auto-save rule ${rule.id} failed: ${(error as Error).message}`,
        );
      }
      await this.prisma.autoSaveRules.update({
        where: { id: rule.id },
        data: {
          next_run_on: asDbDate(nextRunAfter(schedule(rule), today)),
        },
      });
    }
    return counts;
  }

  /**
   * A new operation on an account: an income sets aside its share, an expense the change of
   * rounding it up — for every active rule of that account.
   */
  async onOperation(
    userId: string,
    transactionId: string,
    now = new Date(),
  ): Promise<Record<RunOutcome, number>> {
    const counts: Record<RunOutcome, number> = {
      saved: 0,
      skipped: 0,
      paused: 0,
      none: 0,
    };
    const operation = await this.prisma.transactions.findUnique({
      where: { id: transactionId },
      include: {
        currency: { select: { decimals: true } },
        user: { select: { timezone: true, deleted_at: true } },
      },
    });
    if (
      !operation ||
      operation.user_id !== userId ||
      operation.deleted_at ||
      operation.user.deleted_at
    ) {
      return counts;
    }
    const type: AutoSaveRuleType | null =
      operation.type === 'income'
        ? 'percent_of_income'
        : operation.type === 'expense'
          ? 'round_up'
          : null;
    if (!type) return counts;
    const rules = await this.prisma.autoSaveRules.findMany({
      where: {
        user_id: userId,
        source_account_id: operation.account_id,
        type,
        is_active: true,
        deleted_at: null,
      },
      include,
    });
    const today = localDate(now, operation.user.timezone);
    for (const rule of rules) {
      const amount =
        type === 'percent_of_income'
          ? shareOf(
              operation.amount,
              rule.percent!,
              operation.currency.decimals,
            )
          : roundUpChange(operation.amount, rule.round_to!);
      if (amount.lte(0)) continue;
      try {
        const outcome = await this.execute(
          rule,
          amount,
          uuidV5(`auto-save:${rule.id}:${operation.id}`),
          type === 'round_up' ? 'round_up' : 'auto_save',
          today,
          now,
        );
        counts[outcome]++;
      } catch (error) {
        this.logger.error(
          `Auto-save rule ${rule.id} failed: ${(error as Error).message}`,
        );
      }
    }
    return counts;
  }

  /**
   * Sets `amount` (source account currency) aside into the rule's goal: never past the goal's
   * target, never more than the account holds — then it is skipped and the user is told.
   */
  private async execute(
    rule: RuleRow,
    requested: Decimal,
    contributionId: string,
    method: ContributionMethod,
    today: CalendarDate,
    now: Date,
  ): Promise<RunOutcome> {
    const goal = await this.prisma.goals.findUnique({
      where: { id: rule.goal_id },
      include: { currency: true },
    });
    const account = await this.prisma.accounts.findUnique({
      where: { id: rule.source_account_id },
      include: { currency: true },
    });
    if (
      !goal ||
      goal.deleted_at ||
      goal.status === 'completed' ||
      goal.status === 'archived' ||
      !account ||
      account.deleted_at ||
      account.is_archived
    ) {
      // Nothing left to save for, or nothing to save from: the rule stops.
      await this.prisma.autoSaveRules.update({
        where: { id: rule.id },
        data: { is_active: false },
      });
      return 'paused';
    }
    if (goal.status === 'paused') return 'none';
    // Done already (a retried job, a second run the same day).
    if (
      await this.prisma.goalContributions.count({
        where: { id: contributionId },
      })
    ) {
      return 'none';
    }

    const sameCurrency = account.currency_id === goal.currency_id;
    const rate = sameCurrency
      ? new Decimal(1)
      : await this.fx.rate(account.currency_id, goal.currency_id, now);
    if (!rate) {
      this.logger.warn(`Auto-save rule ${rule.id}: no rate, set aside later`);
      return 'none';
    }
    let accountAmount = requested;
    let goalAmount = accountAmount
      .times(rate)
      .toDecimalPlaces(goal.currency.decimals, Decimal.ROUND_DOWN);
    const remaining = goal.target_amount.minus(goal.saved_amount);
    if (remaining.lte(0)) return 'none';
    if (goalAmount.gt(remaining)) {
      goalAmount = remaining;
      accountAmount = sameCurrency
        ? remaining
        : remaining
            .dividedBy(rate)
            .toDecimalPlaces(account.currency.decimals, Decimal.ROUND_UP);
    }
    if (goalAmount.lte(0)) return 'none';

    if (account.current_balance.lt(accountAmount)) {
      await this.notifications.autoSaveSkipped(
        rule.user_id,
        {
          ruleId: rule.id,
          goal: { id: goal.id, title: goal.title, emoji: goal.emoji },
          account: account.name,
          amount: accountAmount.toFixed(account.currency.decimals),
          currency: account.currency.code,
          day: today,
        },
        now,
      );
      return 'skipped';
    }

    await this.goals.contribute(
      rule.user_id,
      goal.id,
      {
        id: contributionId,
        type: 'deposit',
        amount: goalAmount.toFixed(goal.currency.decimals),
        accountId: account.id,
        accountAmount: sameCurrency
          ? undefined
          : accountAmount.toFixed(account.currency.decimals),
      },
      { method, autoSaveRuleId: rule.id },
    );
    await this.notifications.autoSaveDone(
      rule.user_id,
      {
        ruleId: rule.id,
        type: rule.type,
        percent: rule.percent?.toString() ?? null,
        goal: { id: goal.id, title: goal.title, emoji: goal.emoji },
        amount: goalAmount.toFixed(goal.currency.decimals),
        currency: goal.currency.code,
        day: today,
      },
      now,
    );
    return 'saved';
  }

  // ---------- Internals ----------

  private async liveGoal(userId: string, goalId: string): Promise<void> {
    const goal = await this.prisma.goals.findUnique({ where: { id: goalId } });
    if (!goal || goal.user_id !== userId || goal.deleted_at) {
      throw new BadRequestException({
        code: 'invalid_goal',
        message: 'Goal not found',
      });
    }
    if (goal.status === 'completed' || goal.status === 'archived') {
      throw conflict('goal_not_active', 'The goal is reached or archived');
    }
  }

  private async usableAccount(userId: string, accountId: string) {
    const account = await this.prisma.accounts.findUnique({
      where: { id: accountId },
      include: { currency: true },
    });
    if (!account || account.user_id !== userId || account.deleted_at) {
      throw new BadRequestException({
        code: 'invalid_account',
        message: 'Account not found',
      });
    }
    if (account.is_archived) {
      throw conflict('account_archived', 'The account is archived');
    }
    return account;
  }

  private async owned(
    userId: string,
    id: string,
    options: { allowDeleted?: boolean } = {},
  ): Promise<RuleRow> {
    const rule = await this.prisma.autoSaveRules.findUnique({
      where: { id },
      include,
    });
    if (
      !rule ||
      rule.user_id !== userId ||
      (rule.deleted_at && !options.allowDeleted)
    ) {
      throw this.notFound();
    }
    return rule;
  }

  private async today(userId: string): Promise<CalendarDate> {
    const user = await this.prisma.users.findUniqueOrThrow({
      where: { id: userId },
      select: { timezone: true },
    });
    return localDate(new Date(), user.timezone);
  }

  private notFound() {
    return new NotFoundException({
      code: 'auto_save_not_found',
      message: 'Auto-save rule not found',
    });
  }
}
