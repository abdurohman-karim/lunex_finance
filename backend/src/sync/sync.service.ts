import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AttachmentsService } from '../attachments/attachments.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import {
  type AutoSaveRuleDto,
  AutoSaveService,
} from '../auto-save/auto-save.service.js';
import { BudgetService } from '../budget/budget.service.js';
import {
  type RecurringRuleDto,
  RecurringService,
} from '../finance/recurring/recurring.service.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  type AccountDto,
  AccountsService,
} from '../finance/accounts/accounts.service.js';
import {
  type CategoryDto,
  CategoriesService,
} from '../finance/categories/categories.service.js';
import {
  type ExchangeRateDto,
  FxRatesService,
} from '../finance/fx-rates.service.js';
import {
  type TransactionDto,
  TransactionsService,
} from '../finance/transactions/transactions.service.js';
import {
  type ContributionDto,
  type GoalDto,
  GoalsService,
} from '../goals/goals.service.js';
import {
  ProfileService,
  type SettingsDto,
} from '../profile/profile.service.js';
import { type Profile, UsersService } from '../users/users.service.js';
import {
  SYNC_STREAMS,
  type SyncCursor,
  type SyncStream,
  decodeSyncCursor,
  encodeSyncCursor,
} from './sync-cursor.js';
import { type SyncOperation, syncOperationSchema } from './sync.schemas.js';
import type { ChangeWindow, ChangesPage, SyncPosition } from './sync-window.js';

/** Sorts after every UUID: "everything up to the horizon has been seen". */
const MAX_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

export interface PullResult {
  /** Present when the profile changed */
  profile: Profile | null;
  accounts: AccountDto[];
  categories: CategoryDto[];
  transactions: TransactionDto[];
  goals: GoalDto[];
  goalContributions: ContributionDto[];
  recurringRules: RecurringRuleDto[];
  autoSaveRules: AutoSaveRuleDto[];
  /** The Central Bank's rates, new and corrected (a first sync: the last weeks') */
  exchangeRates: ExchangeRateDto[];
  /** Present when the settings changed */
  settings: SettingsDto | null;
  /** Send it back on the next pull */
  nextCursor: string;
  /** Pull again right away with nextCursor */
  hasMore: boolean;
  serverTime: Date;
}

export type PushResult =
  | { opId: string | null; status: 'applied'; record: unknown }
  | {
      opId: string | null;
      status: 'rejected';
      code: string;
      message: string;
      details?: unknown;
    };

@Injectable()
export class SyncService {
  private readonly lagMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly accounts: AccountsService,
    private readonly categories: CategoriesService,
    private readonly transactions: TransactionsService,
    private readonly goals: GoalsService,
    private readonly profile: ProfileService,
    private readonly budget: BudgetService,
    private readonly recurring: RecurringService,
    private readonly fxRates: FxRatesService,
    private readonly autoSave: AutoSaveService,
    private readonly attachments: AttachmentsService,
    config: ConfigService<Env, true>,
  ) {
    this.lagMs = config.get('SYNC_LAG_MS', { infer: true });
  }

  /**
   * Everything that changed since the cursor, per stream, up to `limit` records each.
   * An empty cursor means a full sync. Deleted records come back with `deletedAt` set.
   */
  async pull(
    user: AuthUser,
    cursorValue: string | undefined,
    limit: number,
  ): Promise<PullResult> {
    // Runs of recurring payments missed meanwhile are made first, so this pull has them.
    await this.recurring.runDue(new Date(), user.userId);
    const now = new Date();
    const horizon = new Date(now.getTime() - this.lagMs);
    const cursor: SyncCursor = cursorValue ? decodeSyncCursor(cursorValue) : {};
    const window = (stream: SyncStream): ChangeWindow => ({
      after: cursor[stream] ?? null,
      horizon,
      limit,
    });
    const userId = user.userId;

    const [
      profile,
      accounts,
      categories,
      preferences,
      transactions,
      goals,
      goalContributions,
      settings,
      recurringRules,
      autoSaveRules,
      exchangeRates,
    ] = await Promise.all([
      this.profileChanges(userId, window('profile')),
      this.accounts.changes(userId, window('accounts')),
      this.categories.changes(userId, window('categories')),
      this.categories.preferenceChanges(userId, window('categoryPreferences')),
      this.transactions.changes(userId, window('transactions')),
      this.goals.changes(userId, window('goals')),
      this.goals.contributionChanges(userId, window('goalContributions')),
      this.profile.settingsChanges(userId, window('settings')),
      this.recurring.changes(userId, window('recurringRules')),
      this.autoSave.changes(userId, window('autoSaveRules')),
      // Few rows a day, so no pages: everything new comes at once.
      this.fxRates.changes(cursor.exchangeRates ?? null, horizon, now),
    ]);
    const pages: Record<SyncStream, ChangesPage<unknown>> = {
      profile,
      accounts,
      categories,
      categoryPreferences: preferences,
      transactions,
      goals,
      goalContributions,
      settings,
      recurringRules,
      autoSaveRules,
      exchangeRates,
    };

    const next: SyncCursor = {};
    let hasMore = false;
    for (const stream of SYNC_STREAMS) {
      const page = pages[stream];
      const after = cursor[stream];
      if (
        stream !== 'exchangeRates' &&
        page.items.length >= limit &&
        page.last
      ) {
        hasMore = true;
        next[stream] = page.last;
      } else {
        // The stream is complete up to the horizon; never move a position backwards.
        next[stream] =
          after && after.updatedAt > horizon
            ? after
            : { updatedAt: horizon, id: MAX_ID };
      }
    }

    if (!hasMore) {
      await this.prisma.devices.updateMany({
        where: { id: user.deviceId, user_id: userId },
        data: { last_sync_at: now },
      });
    }

    // One category may come from both streams; the later copy is identical, keep one.
    const categoriesById = new Map(
      [...categories.items, ...preferences.items].map((c) => [c.id, c]),
    );

    return {
      profile: profile.items[0] ?? null,
      accounts: accounts.items,
      categories: [...categoriesById.values()],
      transactions: transactions.items,
      goals: goals.items,
      goalContributions: goalContributions.items,
      recurringRules: recurringRules.items,
      autoSaveRules: autoSaveRules.items,
      exchangeRates: exchangeRates.items,
      settings: settings.items[0] ?? null,
      nextCursor: encodeSyncCursor(next),
      hasMore,
      serverTime: now,
    };
  }

  /**
   * Applies queued operations in order. Business errors reject only that operation;
   * a server failure aborts the batch so the app resends it — every operation is idempotent.
   */
  async push(userId: string, operations: unknown[]): Promise<PushResult[]> {
    const results: PushResult[] = [];
    for (const raw of operations) {
      const opId =
        typeof raw === 'object' && raw !== null && 'opId' in raw
          ? String((raw as { opId: unknown }).opId)
          : null;

      const parsed = syncOperationSchema.safeParse(raw);
      if (!parsed.success) {
        results.push({
          opId,
          status: 'rejected',
          code: 'validation_failed',
          message: 'Operation is invalid',
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
        continue;
      }

      try {
        const record = await this.apply(userId, parsed.data);
        results.push({ opId, status: 'applied', record });
      } catch (error) {
        if (!isPermanent(error)) {
          throw error;
        }
        const body = error.getResponse();
        const response =
          typeof body === 'object' && body !== null
            ? (body as Record<string, unknown>)
            : { message: body };
        const { code, message, ...details } = response;
        results.push({
          opId,
          status: 'rejected',
          code: typeof code === 'string' ? code : 'rejected',
          message: typeof message === 'string' ? message : error.message,
          details: Object.keys(details).length > 0 ? details : undefined,
        });
      }
    }
    return results;
  }

  private apply(userId: string, op: SyncOperation): Promise<unknown> {
    switch (op.type) {
      case 'account.create':
        return this.accounts.create(userId, op.data);
      case 'account.update':
        return this.accounts.update(userId, op.id, op.data);
      case 'account.delete':
        return this.accounts.remove(userId, op.id).then(() => null);
      case 'account.reorder':
        return this.accounts.reorder(userId, op.data.ids);
      case 'category.create':
        return this.categories.create(userId, op.data);
      case 'category.update':
        return this.categories.update(userId, op.id, op.data);
      case 'category.delete':
        return this.categories.remove(userId, op.id).then(() => null);
      case 'category.reorder':
        return this.categories.reorder(userId, op.data.ids);
      case 'transaction.create':
        return this.transactions.create(userId, op.data);
      case 'transaction.update':
        return this.transactions.update(userId, op.id, op.data);
      case 'transaction.delete':
        return this.transactions.remove(userId, op.id).then(() => null);
      case 'transaction.restore':
        return this.transactions.restore(userId, op.id);
      case 'attachment.delete':
        return this.attachments.remove(userId, op.id).then(() => null);
      case 'goal.create':
        return this.goals.create(userId, op.data);
      case 'goal.update':
        return this.goals.update(userId, op.id, op.data);
      case 'goal.delete':
        return this.goals.remove(userId, op.id).then(() => null);
      case 'goal.reorder':
        return this.goals.reorder(userId, op.data.ids);
      case 'goal.contribute':
        return this.goals.contribute(userId, op.goalId, op.data);
      case 'goal.contribution.delete':
        return this.goals.removeContribution(userId, op.goalId, op.id);
      case 'profile.update':
        return this.profile.updateProfile(userId, op.data);
      case 'settings.update':
        return this.profile.updateSettings(userId, op.data);
      case 'budget.set':
        return this.budget.setPlan(userId, op.data);
      case 'recurring.create':
        return this.recurring.create(userId, op.data);
      case 'recurring.update':
        return this.recurring.update(userId, op.id, op.data);
      case 'recurring.delete':
        return this.recurring.remove(userId, op.id).then(() => null);
      case 'recurring.record':
        return this.recurring.record(userId, op.id, op.data);
      case 'recurring.skip':
        return this.recurring.skip(userId, op.id, op.data);
      case 'autoSave.create':
        return this.autoSave.create(userId, op.data);
      case 'autoSave.update':
        return this.autoSave.update(userId, op.id, op.data);
      case 'autoSave.delete':
        return this.autoSave.remove(userId, op.id).then(() => null);
    }
  }

  private async profileChanges(
    userId: string,
    window: ChangeWindow,
  ): Promise<ChangesPage<Profile>> {
    const user = await this.prisma.users.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, updated_at: true },
    });
    const position: SyncPosition = { updatedAt: user.updated_at, id: user.id };
    const inWindow =
      user.updated_at <= window.horizon &&
      (!window.after || user.updated_at > window.after.updatedAt);
    return inWindow
      ? { items: [await this.users.profile(userId)], last: position }
      : { items: [], last: null };
  }
}

/** 4xx except 429: retrying the same operation would fail the same way. */
function isPermanent(error: unknown): error is HttpException {
  return (
    error instanceof HttpException &&
    error.getStatus() >= 400 &&
    error.getStatus() < 500 &&
    error.getStatus() !== HttpStatus.TOO_MANY_REQUESTS
  );
}
