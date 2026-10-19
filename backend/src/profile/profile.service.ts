import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { asDbDate, localDate } from '../common/dates.js';
import { assertCurrencyPrecision } from '../common/schemas.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  type AccountDto,
  AccountsService,
} from '../finance/accounts/accounts.service.js';
import { FxService } from '../finance/fx.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { LanguageCode } from '../generated/prisma/enums.js';
import { type GoalDto, GoalsService } from '../goals/goals.service.js';
import type {
  ChangeWindow,
  ChangesPage,
  SyncPosition,
} from '../sync/sync-window.js';
import { type Profile, UsersService } from '../users/users.service.js';
import type {
  DeviceUpdateInput,
  OnboardingInput,
  UpdateProfileInput,
  UpdateSettingsInput,
} from './profile.schemas.js';

type Decimal = Prisma.Decimal;
const { Decimal } = Prisma;

const CASH_ACCOUNT_NAME: Record<LanguageCode, string> = {
  uz: 'Naqd pul',
  ru: 'Наличные',
  en: 'Cash',
};

/** Rows re-valued per SQL statement when the base currency changes. */
const REVALUE_CHUNK = 1000;

export interface SettingsDto {
  biometricLockEnabled: boolean;
  lockAfterSeconds: number;
  hideAmounts: boolean;
  weekStartsOn: number;
  monthStartsOnDay: number;
  defaultAccountId: string | null;
  dailyReminderEnabled: boolean;
  /** `HH:MM` */
  dailyReminderTime: string;
  budgetAlertsEnabled: boolean;
  goalAlertsEnabled: boolean;
  recurringAlertsEnabled: boolean;
  smartSaveEnabled: boolean;
  weeklyReportEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  hapticsEnabled: boolean;
  updatedAt: Date;
}

export interface ChecklistDto {
  /** «Первые шаги» on the home screen; the widget item is tracked by the app */
  firstTransaction: boolean;
  firstGoal: boolean;
  budget: boolean;
  completed: boolean;
}

export interface OnboardingResult {
  profile: Profile;
  account: AccountDto | null;
  goal: GoalDto | null;
  checklist: ChecklistDto;
}

type SettingsRow = Prisma.UserSettingsGetPayload<object>;

/** Postgres `time` comes back as 1970-01-01T…Z. */
const fromDbTime = (value: Date) => value.toISOString().slice(11, 16);
const toDbTime = (value: string) => new Date(`1970-01-01T${value}:00.000Z`);

function settingsToDto(row: SettingsRow): SettingsDto {
  return {
    biometricLockEnabled: row.biometric_lock_enabled,
    lockAfterSeconds: row.lock_after_seconds,
    hideAmounts: row.hide_amounts,
    weekStartsOn: row.week_starts_on,
    monthStartsOnDay: row.month_starts_on_day,
    defaultAccountId: row.default_account_id,
    dailyReminderEnabled: row.daily_reminder_enabled,
    dailyReminderTime: fromDbTime(row.daily_reminder_time),
    budgetAlertsEnabled: row.budget_alerts_enabled,
    goalAlertsEnabled: row.goal_alerts_enabled,
    recurringAlertsEnabled: row.recurring_alerts_enabled,
    smartSaveEnabled: row.smart_save_enabled,
    weeklyReportEnabled: row.weekly_report_enabled,
    quietHoursStart: fromDbTime(row.quiet_hours_start),
    quietHoursEnd: fromDbTime(row.quiet_hours_end),
    hapticsEnabled: row.haptics_enabled,
    updatedAt: row.updated_at,
  };
}

/** Profile, settings, device, onboarding and the «Первые шаги» checklist. */
@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly accounts: AccountsService,
    private readonly goals: GoalsService,
    private readonly fx: FxService,
  ) {}

  // ---------- Profile ----------

  async updateProfile(
    userId: string,
    patch: UpdateProfileInput,
    now = new Date(),
  ): Promise<Profile> {
    // Validate before changing anything: the estimate is in the (new) base currency.
    if (patch.monthlyIncomeEstimate) {
      const currency = patch.baseCurrency
        ? await this.prisma.currencies.findUnique({
            where: { code: patch.baseCurrency },
          })
        : (
            await this.prisma.users.findUniqueOrThrow({
              where: { id: userId },
              include: { baseCurrency: true },
            })
          ).baseCurrency;
      if (currency) {
        assertCurrencyPrecision(patch.monthlyIncomeEstimate, currency);
      }
    }
    if (patch.baseCurrency) {
      await this.changeBaseCurrency(
        userId,
        patch.baseCurrency,
        patch.monthlyIncomeEstimate !== undefined,
        now,
      );
    }
    await this.prisma.users.update({
      where: { id: userId },
      data: {
        display_name: patch.displayName,
        language: patch.language,
        timezone: patch.timezone,
        monthly_income_estimate: patch.monthlyIncomeEstimate,
        onboarding_focus: patch.onboardingFocus,
      },
    });
    return this.users.profile(userId);
  }

  /**
   * Re-values every operation (`amount_base`, `fx_rate`) in the new base currency at the
   * rate of its date, plus the income estimate and current budgets at today's rate.
   * All or nothing: without every rate, nothing changes and the answer says so.
   */
  private async changeBaseCurrency(
    userId: string,
    code: string,
    estimateGiven: boolean,
    now: Date,
  ): Promise<void> {
    const [user, target] = await Promise.all([
      this.prisma.users.findUniqueOrThrow({
        where: { id: userId },
        include: { baseCurrency: true },
      }),
      this.prisma.currencies.findUnique({ where: { code } }),
    ]);
    if (!target || !target.is_active) {
      throw new BadRequestException({
        code: 'currency_not_supported',
        message: `Currency ${code} is not supported`,
      });
    }
    if (target.id === user.base_currency_id) return;

    const cache = new Map<string, Decimal | null>();
    const rateTo = async (currencyId: number, at: Date) => {
      const key = `${currencyId}:${at.toISOString().slice(0, 10)}`;
      if (!cache.has(key)) {
        cache.set(key, await this.fx.rate(currencyId, target.id, at));
      }
      return cache.get(key) ?? null;
    };
    const missing = new Set<number>();

    const operations = await this.prisma.transactions.findMany({
      where: { user_id: userId },
      select: { id: true, amount: true, currency_id: true, occurred_at: true },
    });
    const revalued: { id: string; amountBase: string; rate: string }[] = [];
    for (const op of operations) {
      const rate = await rateTo(op.currency_id, op.occurred_at);
      if (!rate) {
        missing.add(op.currency_id);
        continue;
      }
      revalued.push({
        id: op.id,
        amountBase: op.amount.times(rate).toDecimalPlaces(2).toString(),
        rate: rate.toDecimalPlaces(10).toString(),
      });
    }

    const today = localDate(now, user.timezone);
    const budgets = await this.prisma.budgets.findMany({
      where: { user_id: userId, period_end: { gte: asDbDate(today) } },
    });
    const estimateRate =
      !estimateGiven && user.monthly_income_estimate
        ? await rateTo(user.base_currency_id, now)
        : new Decimal(1);
    if (!estimateRate) missing.add(user.base_currency_id);
    const budgetRates = new Map<string, Decimal>();
    for (const budget of budgets) {
      const rate = await rateTo(budget.currency_id, now);
      if (rate) budgetRates.set(budget.id, rate);
      else missing.add(budget.currency_id);
    }

    if (missing.size > 0) {
      const codes = await this.prisma.currencies.findMany({
        where: { id: { in: [...missing] } },
        select: { code: true },
      });
      throw new UnprocessableEntityException({
        code: 'exchange_rate_unavailable',
        message: `Missing exchange rates to ${target.code}; the base currency was not changed`,
        from: codes.map((c) => c.code),
        to: target.code,
      });
    }

    await this.prisma.$transaction(
      async (tx) => {
        for (let i = 0; i < revalued.length; i += REVALUE_CHUNK) {
          const chunk = revalued.slice(i, i + REVALUE_CHUNK);
          await tx.$executeRaw`
            UPDATE transactions AS t
            SET amount_base = v.amount_base, fx_rate = v.fx_rate, updated_at = ${now}
            FROM (
              SELECT unnest(${chunk.map((r) => r.id)}::uuid[]) AS id,
                     unnest(${chunk.map((r) => r.amountBase)}::numeric[]) AS amount_base,
                     unnest(${chunk.map((r) => r.rate)}::numeric[]) AS fx_rate
            ) AS v
            WHERE t.id = v.id`;
        }
        await tx.users.update({
          where: { id: userId },
          data: {
            base_currency_id: target.id,
            monthly_income_estimate:
              !estimateGiven && user.monthly_income_estimate
                ? user.monthly_income_estimate
                    .times(estimateRate!)
                    .toDecimalPlaces(target.decimals)
                : undefined,
          },
        });
        for (const budget of budgets) {
          const rate = budgetRates.get(budget.id)!;
          const convert = (value: Decimal | null) =>
            value === null
              ? null
              : value.times(rate).toDecimalPlaces(target.decimals);
          await tx.budgets.update({
            where: { id: budget.id },
            data: {
              currency_id: target.id,
              planned_income: convert(budget.planned_income),
              total_limit: convert(budget.total_limit),
              savings_target: convert(budget.savings_target)!,
              rollover_amount: convert(budget.rollover_amount)!,
            },
          });
        }
      },
      { timeout: 60_000 },
    );
  }

  // ---------- Settings ----------

  async settings(userId: string): Promise<SettingsDto> {
    const row = await this.prisma.userSettings.upsert({
      where: { user_id: userId },
      create: { user_id: userId },
      update: {},
    });
    return settingsToDto(row);
  }

  async updateSettings(
    userId: string,
    patch: UpdateSettingsInput,
  ): Promise<SettingsDto> {
    await this.settings(userId);
    if (patch.defaultAccountId) {
      // Validates the account and touches both accounts for sync.
      await this.accounts.update(userId, patch.defaultAccountId, {
        isDefault: true,
      });
    }
    const time = (value: string | undefined) =>
      value === undefined ? undefined : toDbTime(value);
    await this.prisma.userSettings.update({
      where: { user_id: userId },
      data: {
        biometric_lock_enabled: patch.biometricLockEnabled,
        lock_after_seconds: patch.lockAfterSeconds,
        hide_amounts: patch.hideAmounts,
        week_starts_on: patch.weekStartsOn,
        month_starts_on_day: patch.monthStartsOnDay,
        daily_reminder_enabled: patch.dailyReminderEnabled,
        daily_reminder_time: time(patch.dailyReminderTime),
        budget_alerts_enabled: patch.budgetAlertsEnabled,
        goal_alerts_enabled: patch.goalAlertsEnabled,
        recurring_alerts_enabled: patch.recurringAlertsEnabled,
        smart_save_enabled: patch.smartSaveEnabled,
        weekly_report_enabled: patch.weeklyReportEnabled,
        quiet_hours_start: time(patch.quietHoursStart),
        quiet_hours_end: time(patch.quietHoursEnd),
        haptics_enabled: patch.hapticsEnabled,
      },
    });
    return this.settings(userId);
  }

  /** Sync stream: the settings record when it changed inside the window. */
  async settingsChanges(
    userId: string,
    window: ChangeWindow,
  ): Promise<ChangesPage<SettingsDto>> {
    const row = await this.prisma.userSettings.findUnique({
      where: { user_id: userId },
    });
    if (!row) return { items: [], last: null };
    const position: SyncPosition = { updatedAt: row.updated_at, id: userId };
    const inWindow =
      row.updated_at <= window.horizon &&
      (!window.after || row.updated_at > window.after.updatedAt);
    return inWindow
      ? { items: [settingsToDto(row)], last: position }
      : { items: [], last: null };
  }

  // ---------- Device ----------

  /** The calling installation: its APNs token for push notifications and what it runs. */
  async updateDevice(
    userId: string,
    deviceId: string,
    patch: DeviceUpdateInput,
  ) {
    const device = await this.prisma.devices.findUnique({
      where: { id: deviceId },
    });
    if (!device || device.user_id !== userId) {
      throw new NotFoundException({
        code: 'device_not_found',
        message: 'Device not found',
      });
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      if (patch.apnsToken) {
        // A token moves with a reinstall: whoever had it before no longer gets pushes.
        await tx.devices.updateMany({
          where: { apns_token: patch.apnsToken, id: { not: deviceId } },
          data: { apns_token: null, push_enabled: false },
        });
      }
      return tx.devices.update({
        where: { id: deviceId },
        data: {
          apns_token: patch.apnsToken,
          push_enabled:
            patch.pushEnabled ?? (patch.apnsToken === null ? false : undefined),
          model: patch.model,
          os_version: patch.osVersion,
          app_version: patch.appVersion,
        },
      });
    });
    return {
      id: updated.id,
      pushEnabled: updated.push_enabled,
      hasApnsToken: updated.apns_token !== null,
      model: updated.model,
      osVersion: updated.os_version,
      appVersion: updated.app_version,
      lastSyncAt: updated.last_sync_at,
    };
  }

  // ---------- Onboarding ----------

  /**
   * Applies what the user chose (every step may be skipped), creates the «Наличные» account
   * and the first goal, and marks onboarding done. Safe to repeat.
   */
  async completeOnboarding(
    userId: string,
    input: OnboardingInput,
    now = new Date(),
  ): Promise<OnboardingResult> {
    const profilePatch: UpdateProfileInput = Object.fromEntries(
      Object.entries({
        language: input.language,
        baseCurrency: input.baseCurrency,
        timezone: input.timezone,
        monthlyIncomeEstimate: input.monthlyIncomeEstimate,
        onboardingFocus: input.focus,
      }).filter(([, value]) => value !== undefined),
    );
    if (Object.keys(profilePatch).length > 0) {
      await this.updateProfile(userId, profilePatch, now);
    }

    const user = await this.prisma.users.findUniqueOrThrow({
      where: { id: userId },
      select: { language: true, baseCurrency: { select: { code: true } } },
    });
    const [ownAccounts, cashExists] = await Promise.all([
      this.prisma.accounts.count({
        where: { user_id: userId, deleted_at: null },
      }),
      this.prisma.accounts.count({
        where: { id: input.cashAccountId, user_id: userId },
      }),
    ]);
    // Accounts synced from another device mean onboarding already set money up.
    const account =
      ownAccounts === 0 || cashExists > 0
        ? await this.accounts.create(userId, {
            id: input.cashAccountId,
            name: CASH_ACCOUNT_NAME[user.language],
            type: 'cash',
            currency: user.baseCurrency.code,
            initialBalance: '0',
            icon: 'banknote',
            color: '#30D158',
            includeInTotal: true,
          })
        : null;

    const goal = input.firstGoal
      ? await this.goals.create(userId, input.firstGoal)
      : null;

    await this.prisma.users.updateMany({
      where: { id: userId, onboarding_completed_at: null },
      data: { onboarding_completed_at: now },
    });
    return {
      profile: await this.users.profile(userId),
      account,
      goal,
      checklist: await this.checklist(userId),
    };
  }

  async checklist(userId: string): Promise<ChecklistDto> {
    const [transactions, goals, budgets] = await Promise.all([
      this.prisma.transactions.count({
        where: { user_id: userId, deleted_at: null },
      }),
      this.prisma.goals.count({ where: { user_id: userId, deleted_at: null } }),
      this.prisma.budgets.count({ where: { user_id: userId } }),
    ]);
    const items = {
      firstTransaction: transactions > 0,
      firstGoal: goals > 0,
      budget: budgets > 0,
    };
    return { ...items, completed: Object.values(items).every(Boolean) };
  }
}
