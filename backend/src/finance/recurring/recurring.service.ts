import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  type CalendarDate,
  addDays,
  asDbDate,
  localDate,
  startOfLocalDay,
} from '../../common/dates.js';
import { assertCurrencyPrecision } from '../../common/schemas.js';
import { PrismaService } from '../../database/prisma.service.js';
import { uuidV5 } from '../../database/uuid.js';
import { Prisma } from '../../generated/prisma/client.js';
import type {
  CategoryType,
  RecurrenceFrequency,
} from '../../generated/prisma/enums.js';
import {
  type ChangeWindow,
  type ChangesPage,
  changeOrder,
  changeWindowWhere,
  lastPosition,
} from '../../sync/sync-window.js';
import {
  type RecurrenceRule,
  type RecurrenceSchedule,
  firstOnOrAfter,
  occurrencesBetween,
} from '../recurrence.js';
import {
  type TransactionDto,
  TransactionsService,
} from '../transactions/transactions.service.js';
import type {
  CreateRecurringInput,
  RecordRecurringInput,
  SkipRecurringInput,
  UpdateRecurringInput,
} from './recurring.schemas.js';

const include = { currency: { select: { code: true, decimals: true } } };
type RuleRow = Prisma.RecurringRulesGetPayload<{ include: typeof include }>;

export interface RecurringRuleDto {
  id: string;
  title: string;
  type: CategoryType;
  amount: string;
  /** The account's currency */
  currency: string;
  accountId: string;
  categoryId: string | null;
  frequency: RecurrenceFrequency;
  interval: number;
  dayOfMonth: number | null;
  startOn: CalendarDate;
  endOn: CalendarDate | null;
  /** The next run not created or recorded yet */
  nextRunOn: CalendarDate;
  autoCreate: boolean;
  remindDaysBefore: number;
  isSubscription: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

const day = (value: Date): CalendarDate => value.toISOString().slice(0, 10);

function toDto(row: RuleRow): RecurringRuleDto {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    amount: row.amount.toFixed(row.currency.decimals),
    currency: row.currency.code,
    accountId: row.account_id,
    categoryId: row.category_id,
    frequency: row.frequency,
    interval: row.interval,
    dayOfMonth: row.day_of_month,
    startOn: day(row.start_on),
    endOn: row.end_on ? day(row.end_on) : null,
    nextRunOn: day(row.next_run_on),
    autoCreate: row.auto_create,
    remindDaysBefore: row.remind_days_before,
    isSubscription: row.is_subscription,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function schedule(row: RuleRow): RecurrenceRule {
  return {
    frequency: row.frequency,
    interval: row.interval,
    dayOfMonth: row.day_of_month,
    startOn: day(row.start_on),
    endOn: row.end_on ? day(row.end_on) : null,
    nextRunOn: day(row.next_run_on),
  };
}

/** Weekly rules keep the start's weekday, 1 = Monday … 7 = Sunday (for display). */
function weekday(date: CalendarDate): number {
  return ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

/** An error the app can act on: its stable `code`. */
function errorCode(error: unknown): string | null {
  if (!(error instanceof HttpException)) return null;
  const body = error.getResponse();
  return typeof body === 'object' && body !== null && 'code' in body
    ? String((body as { code: unknown }).code)
    : null;
}

/**
 * Recurring payments and incomes (spec: «Регулярные платежи и подписки»). A rule with
 * `autoCreate` makes its operations itself, hourly and at every sync, so runs missed while
 * nobody looked are made up later; a reminder rule waits for «Записать» or «Пропустить».
 * Operation ids are derived from the rule and the day, so no run is ever created twice.
 */
@Injectable()
export class RecurringService {
  private readonly logger = new Logger(RecurringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionsService,
  ) {}

  async list(userId: string): Promise<RecurringRuleDto[]> {
    const rows = await this.prisma.recurringRules.findMany({
      where: { user_id: userId, deleted_at: null },
      include,
      orderBy: [{ next_run_on: 'asc' }, { title: 'asc' }],
    });
    return rows.map(toDto);
  }

  async changes(
    userId: string,
    window: ChangeWindow,
  ): Promise<ChangesPage<RecurringRuleDto>> {
    const rows = await this.prisma.recurringRules.findMany({
      where: {
        user_id: userId,
        ...changeWindowWhere(window),
      } as Prisma.RecurringRulesWhereInput,
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

  /** Idempotent: the same id again returns the rule as first created. */
  async create(
    userId: string,
    input: CreateRecurringInput,
  ): Promise<RecurringRuleDto> {
    const existing = await this.prisma.recurringRules.findUnique({
      where: { id: input.id },
      include,
    });
    if (existing) {
      if (existing.user_id !== userId) throw this.notFound();
      return toDto(existing);
    }
    const account = await this.usableAccount(userId, input.accountId);
    assertCurrencyPrecision(input.amount, account.currency);
    if (input.categoryId) {
      await this.assertCategory(userId, input.categoryId, input.type);
    }
    const today = await this.today(userId);
    const row = await this.prisma.recurringRules.create({
      data: {
        id: input.id,
        user_id: userId,
        account_id: account.id,
        category_id: input.categoryId,
        type: input.type,
        title: input.title,
        amount: new Prisma.Decimal(input.amount),
        currency_id: account.currency_id,
        frequency: input.frequency,
        interval: input.interval,
        day_of_month: input.dayOfMonth,
        weekday: weekday(input.startOn),
        start_on: asDbDate(input.startOn),
        end_on: input.endOn ? asDbDate(input.endOn) : null,
        // Past runs of an existing payment are already recorded: begin today.
        next_run_on: asDbDate(firstOnOrAfter(input, today)),
        auto_create: input.autoCreate,
        remind_days_before: input.remindDaysBefore,
        is_subscription: input.isSubscription,
      },
      include,
    });
    return toDto(row);
  }

  async update(
    userId: string,
    id: string,
    input: UpdateRecurringInput,
  ): Promise<RecurringRuleDto> {
    const rule = await this.owned(userId, id);
    const type = input.type ?? rule.type;
    let currencyId = rule.currency_id;
    if (input.accountId && input.accountId !== rule.account_id) {
      currencyId = (await this.usableAccount(userId, input.accountId))
        .currency_id;
    }
    if (input.amount) {
      const currency = await this.prisma.currencies.findUniqueOrThrow({
        where: { id: currencyId },
      });
      assertCurrencyPrecision(input.amount, currency);
    }
    const categoryId =
      input.categoryId === undefined ? rule.category_id : input.categoryId;
    if (categoryId && (input.categoryId !== undefined || input.type)) {
      await this.assertCategory(userId, categoryId, type);
    }

    const next: RecurrenceSchedule = {
      frequency: input.frequency ?? rule.frequency,
      interval: input.interval ?? rule.interval,
      dayOfMonth:
        input.dayOfMonth === undefined ? rule.day_of_month : input.dayOfMonth,
      startOn: input.startOn ?? day(rule.start_on),
    };
    const endOn =
      input.endOn === undefined ? rule.end_on && day(rule.end_on) : input.endOn;
    if (endOn && endOn < next.startOn) {
      throw new BadRequestException({
        code: 'invalid_dates',
        message: 'The end date is before the start',
      });
    }
    const rescheduled =
      input.frequency !== undefined ||
      input.interval !== undefined ||
      input.dayOfMonth !== undefined ||
      input.startOn !== undefined;

    const row = await this.prisma.recurringRules.update({
      where: { id },
      data: {
        title: input.title,
        type: input.type,
        amount: input.amount ? new Prisma.Decimal(input.amount) : undefined,
        account_id: input.accountId,
        currency_id: currencyId,
        category_id: categoryId,
        frequency: next.frequency,
        interval: next.interval,
        day_of_month: next.dayOfMonth,
        weekday: weekday(next.startOn),
        start_on: asDbDate(next.startOn),
        end_on: endOn ? asDbDate(endOn) : null,
        next_run_on: rescheduled
          ? asDbDate(firstOnOrAfter(next, await this.today(userId)))
          : undefined,
        auto_create: input.autoCreate,
        remind_days_before: input.remindDaysBefore,
        is_subscription: input.isSubscription,
        is_active: input.isActive,
      },
      include,
    });
    return toDto(row);
  }

  /** Operations it created stay. */
  async remove(userId: string, id: string): Promise<void> {
    const rule = await this.owned(userId, id, { allowDeleted: true });
    if (rule.deleted_at) return;
    await this.prisma.recurringRules.update({
      where: { id },
      data: { deleted_at: new Date() },
    });
  }

  /**
   * «Записать»: the run of `date` happened. Creates the operation (idempotent by its id)
   * and moves the next run past that day.
   */
  async record(
    userId: string,
    id: string,
    input: RecordRecurringInput,
    now = new Date(),
  ): Promise<{ rule: RecurringRuleDto; transaction: TransactionDto }> {
    const rule = await this.owned(userId, id);
    const timezone = await this.timezone(userId);
    const transaction = await this.transactions.create(
      userId,
      {
        id: input.transactionId,
        type: rule.type,
        accountId: rule.account_id,
        amount: input.amount ?? rule.amount.toFixed(rule.currency.decimals),
        categoryId: rule.category_id,
        note: input.note ?? rule.title,
        occurredAt: this.occurredAt(input.date, timezone, now),
        source: 'recurring',
      },
      { recurringRuleId: rule.id },
    );
    return { rule: await this.passed(rule, input.date), transaction };
  }

  /** «Пропустить»: the run of `date` will not happen. */
  async skip(
    userId: string,
    id: string,
    input: SkipRecurringInput,
  ): Promise<RecurringRuleDto> {
    return this.passed(await this.owned(userId, id), input.date);
  }

  /**
   * Creates every due run of the active rules that make their operations themselves, up to
   * today in each user's time zone. Hourly for everyone; at every sync for that user.
   */
  async runDue(
    now = new Date(),
    userId?: string,
  ): Promise<{ created: number; paused: number }> {
    // The furthest «today» on Earth (UTC+14): later runs are not due anywhere yet.
    const latestToday = localDate(now, 'Pacific/Kiritimati');
    const rules = await this.prisma.recurringRules.findMany({
      where: {
        ...(userId ? { user_id: userId } : {}),
        auto_create: true,
        is_active: true,
        deleted_at: null,
        next_run_on: { lte: asDbDate(latestToday) },
      },
      include: { ...include, user: { select: { timezone: true } } },
    });
    let created = 0;
    let paused = 0;
    for (const rule of rules) {
      const today = localDate(now, rule.user.timezone);
      const dates = occurrencesBetween(
        schedule(rule),
        day(rule.next_run_on),
        today,
      );
      let last: CalendarDate | null = null;
      for (const date of dates) {
        const outcome = await this.createRun(rule, date, now);
        if (outcome === 'paused') {
          paused++;
          break;
        }
        created += outcome === 'created' ? 1 : 0;
        last = date;
      }
      if (last) await this.passed(rule, last);
    }
    return { created, paused };
  }

  // ---------- Internals ----------

  /** One run's operation; an account that can no longer take it pauses the rule. */
  private async createRun(
    rule: RuleRow & { user: { timezone: string } },
    date: CalendarDate,
    now: Date,
  ): Promise<'created' | 'existed' | 'paused'> {
    const id = uuidV5(`recurring:${rule.id}:${date}`);
    const before = await this.prisma.transactions.count({ where: { id } });
    const input = {
      id,
      type: rule.type,
      accountId: rule.account_id,
      amount: rule.amount.toFixed(rule.currency.decimals),
      categoryId: rule.category_id,
      note: rule.title,
      occurredAt: this.occurredAt(date, rule.user.timezone, now),
      source: 'recurring' as const,
    };
    try {
      await this.transactions.create(rule.user_id, input, {
        recurringRuleId: rule.id,
      });
    } catch (error) {
      const code = errorCode(error);
      if (code === 'invalid_category') {
        // The category is gone: the payment still happens, without it.
        await this.transactions.create(
          rule.user_id,
          { ...input, categoryId: null },
          { recurringRuleId: rule.id },
        );
      } else if (code === 'invalid_account' || code === 'account_archived') {
        this.logger.warn(`Recurring rule ${rule.id} paused: ${code}`);
        await this.prisma.recurringRules.update({
          where: { id: rule.id },
          data: { is_active: false },
        });
        return 'paused';
      } else {
        throw error;
      }
    }
    return before === 0 ? 'created' : 'existed';
  }

  /** Moves the next run past `date` (never back). */
  private async passed(
    rule: RuleRow,
    date: CalendarDate,
  ): Promise<RecurringRuleDto> {
    if (date < day(rule.next_run_on)) return toDto(rule);
    const next = firstOnOrAfter(
      {
        frequency: rule.frequency,
        interval: rule.interval,
        dayOfMonth: rule.day_of_month,
        startOn: day(rule.start_on),
      },
      addDays(date, 1),
    );
    const row = await this.prisma.recurringRules.update({
      where: { id: rule.id },
      data: { next_run_on: asDbDate(next) },
      include,
    });
    return toDto(row);
  }

  /** 09:00 of that day in the user's zone; today's run, created early, is «now». */
  private occurredAt(date: CalendarDate, timezone: string, now: Date): Date {
    const morning = new Date(
      startOfLocalDay(date, timezone).getTime() + 9 * 60 * 60 * 1000,
    );
    return morning > now ? now : morning;
  }

  private async owned(
    userId: string,
    id: string,
    options: { allowDeleted?: boolean } = {},
  ): Promise<RuleRow> {
    const rule = await this.prisma.recurringRules.findUnique({
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

  private notFound() {
    return new NotFoundException({
      code: 'recurring_not_found',
      message: 'Recurring payment not found',
    });
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
      throw new BadRequestException({
        code: 'account_archived',
        message: 'The account is archived',
      });
    }
    return account;
  }

  private async assertCategory(
    userId: string,
    categoryId: string,
    type: CategoryType,
  ): Promise<void> {
    const category = await this.prisma.categories.findUnique({
      where: { id: categoryId },
    });
    if (
      !category ||
      category.deleted_at ||
      (category.user_id !== null && category.user_id !== userId) ||
      category.type !== type
    ) {
      throw new BadRequestException({
        code: 'invalid_category',
        message: `Choose a ${type} category`,
      });
    }
  }

  private async timezone(userId: string): Promise<string> {
    const user = await this.prisma.users.findUniqueOrThrow({
      where: { id: userId },
      select: { timezone: true },
    });
    return user.timezone;
  }

  private async today(userId: string): Promise<CalendarDate> {
    return localDate(new Date(), await this.timezone(userId));
  }
}
