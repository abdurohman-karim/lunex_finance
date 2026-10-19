import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EntitlementsService } from '../../billing/entitlements.service.js';
import { assertCurrencyPrecision } from '../../common/schemas.js';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { AccountType } from '../../generated/prisma/enums.js';
import {
  type ChangeWindow,
  type ChangesPage,
  changeOrder,
  changeWindowWhere,
  lastPosition,
} from '../../sync/sync-window.js';
import type {
  CreateAccountInput,
  UpdateAccountInput,
} from './accounts.schemas.js';

type Tx = Prisma.TransactionClient;

const withCurrency = {
  currency: { select: { code: true, decimals: true } },
} as const;
type AccountRow = Prisma.AccountsGetPayload<{ include: typeof withCurrency }>;

export interface AccountDto {
  id: string;
  name: string;
  type: AccountType;
  currency: string;
  initialBalance: string;
  /** initial balance plus income, minus expenses, ± transfers and goal contributions */
  currentBalance: string;
  icon: string | null;
  color: string | null;
  includeInTotal: boolean;
  isArchived: boolean;
  isDefault: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

function toDto(row: AccountRow, defaultAccountId: string | null): AccountDto {
  const decimals = row.currency.decimals;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    currency: row.currency.code,
    initialBalance: row.initial_balance.toFixed(decimals),
    currentBalance: row.current_balance.toFixed(decimals),
    icon: row.icon,
    color: row.color,
    includeInTotal: row.include_in_total,
    isArchived: row.is_archived,
    isDefault: row.id === defaultAccountId,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

const notFound = () =>
  new NotFoundException({
    code: 'account_not_found',
    message: 'Account not found',
  });

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async list(userId: string, updatedSince?: Date): Promise<AccountDto[]> {
    const [defaultId, rows] = await Promise.all([
      this.defaultAccountId(this.prisma, userId),
      this.prisma.accounts.findMany({
        where: updatedSince
          ? { user_id: userId, updated_at: { gt: updatedSince } }
          : { user_id: userId, deleted_at: null },
        include: withCurrency,
        orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
      }),
    ]);
    return rows.map((row) => toDto(row, defaultId));
  }

  /** Idempotent: sending the same id again returns the account created the first time. */
  async create(userId: string, input: CreateAccountInput): Promise<AccountDto> {
    const existing = await this.prisma.accounts.findUnique({
      where: { id: input.id },
      include: withCurrency,
    });
    if (existing) {
      if (existing.user_id !== userId || existing.deleted_at) {
        throw new ConflictException({
          code: 'id_conflict',
          message: 'This id is already used',
        });
      }
      return toDto(existing, await this.defaultAccountId(this.prisma, userId));
    }

    const currency = await this.currency(input.currency);
    assertCurrencyPrecision(input.initialBalance, currency);
    await this.entitlements.assertCanCreate(userId, 'accounts');

    return this.prisma.$transaction(async (tx) => {
      const { _max } = await tx.accounts.aggregate({
        where: { user_id: userId },
        _max: { sort_order: true },
      });
      const account = await tx.accounts.create({
        data: {
          id: input.id,
          user_id: userId,
          name: input.name,
          type: input.type,
          currency_id: currency.id,
          initial_balance: input.initialBalance,
          current_balance: input.initialBalance,
          icon: input.icon,
          color: input.color,
          include_in_total: input.includeInTotal,
          sort_order: (_max.sort_order ?? -1) + 1,
        },
        include: withCurrency,
      });
      // The first account becomes the one quick add preselects.
      if (!(await this.defaultAccountId(tx, userId))) {
        await this.setDefault(tx, userId, account.id);
      }
      return this.reload(tx, userId, account.id);
    });
  }

  async update(
    userId: string,
    id: string,
    patch: UpdateAccountInput,
  ): Promise<AccountDto> {
    const account = await this.findOwned(userId, id);

    let currencyId = account.currency_id;
    let currency = account.currency;
    if (patch.currency && patch.currency !== account.currency.code) {
      if (await this.hasMovements(id)) {
        throw new ConflictException({
          code: 'currency_locked',
          message: 'The currency of an account with operations cannot change',
        });
      }
      const next = await this.currency(patch.currency);
      currencyId = next.id;
      currency = next;
    }
    if (patch.initialBalance !== undefined) {
      assertCurrencyPrecision(patch.initialBalance, currency);
    }

    const archiving = patch.isArchived === true && !account.is_archived;
    const unarchiving = patch.isArchived === false && account.is_archived;
    if (unarchiving) {
      await this.entitlements.assertCanCreate(userId, 'accounts');
    }
    if (patch.isDefault && (account.is_archived || archiving) && !unarchiving) {
      throw new ConflictException({
        code: 'account_archived',
        message: 'An archived account cannot be the default one',
      });
    }

    return this.prisma.$transaction(async (tx) => {
      // Changing the opening balance shifts the current balance by the same amount.
      const delta =
        patch.initialBalance === undefined
          ? undefined
          : new Prisma.Decimal(patch.initialBalance).minus(
              account.initial_balance,
            );
      await tx.accounts.update({
        where: { id },
        data: {
          name: patch.name,
          type: patch.type,
          currency_id: currencyId,
          initial_balance: patch.initialBalance,
          current_balance: delta ? { increment: delta } : undefined,
          icon: patch.icon,
          color: patch.color,
          include_in_total: patch.includeInTotal,
          is_archived: patch.isArchived,
        },
      });

      if (patch.isDefault) {
        await this.setDefault(tx, userId, id);
      } else if (archiving) {
        await this.reassignDefault(tx, userId, id);
      } else if (unarchiving && !(await this.defaultAccountId(tx, userId))) {
        await this.setDefault(tx, userId, id);
      }
      return this.reload(tx, userId, id);
    });
  }

  async reorder(userId: string, ids: string[]): Promise<AccountDto[]> {
    const owned = await this.prisma.accounts.count({
      where: { id: { in: ids }, user_id: userId, deleted_at: null },
    });
    if (owned !== ids.length) {
      throw new BadRequestException({
        code: 'unknown_ids',
        message: 'Some ids are not your accounts',
      });
    }
    await this.prisma.$transaction(
      ids.map((id, index) =>
        this.prisma.accounts.update({
          where: { id },
          data: { sort_order: index },
        }),
      ),
    );
    return this.list(userId);
  }

  /** Only accounts nothing refers to can be deleted; the rest are archived, keeping history. */
  async remove(userId: string, id: string): Promise<void> {
    await this.findOwned(userId, id);
    if (await this.isReferenced(id)) {
      throw new ConflictException({
        code: 'account_in_use',
        message:
          'The account has operations or is used by goals; archive it instead',
      });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.accounts.update({
        where: { id },
        data: { deleted_at: new Date() },
      });
      await this.reassignDefault(tx, userId, id);
    });
  }

  private async findOwned(userId: string, id: string): Promise<AccountRow> {
    const account = await this.prisma.accounts.findUnique({
      where: { id },
      include: withCurrency,
    });
    if (!account || account.user_id !== userId || account.deleted_at) {
      throw notFound();
    }
    return account;
  }

  private async currency(code: string) {
    const currency = await this.prisma.currencies.findUnique({
      where: { code },
    });
    if (!currency || !currency.is_active) {
      throw new BadRequestException({
        code: 'currency_not_supported',
        message: `Currency ${code} is not supported`,
      });
    }
    return currency;
  }

  private async hasMovements(accountId: string): Promise<boolean> {
    const [transactions, contributions] = await Promise.all([
      this.prisma.transactions.count({
        where: {
          deleted_at: null,
          OR: [{ account_id: accountId }, { transfer_account_id: accountId }],
        },
      }),
      this.prisma.goalContributions.count({
        where: { source_account_id: accountId, deleted_at: null },
      }),
    ]);
    return transactions + contributions > 0;
  }

  private async isReferenced(accountId: string): Promise<boolean> {
    if (await this.hasMovements(accountId)) {
      return true;
    }
    const [recurring, autoSave, goals] = await Promise.all([
      this.prisma.recurringRules.count({
        where: { account_id: accountId, deleted_at: null },
      }),
      this.prisma.autoSaveRules.count({
        where: { source_account_id: accountId, deleted_at: null },
      }),
      this.prisma.goals.count({
        where: { linked_account_id: accountId, deleted_at: null },
      }),
    ]);
    return recurring + autoSave + goals > 0;
  }

  private async defaultAccountId(
    db: PrismaService | Tx,
    userId: string,
  ): Promise<string | null> {
    const settings = await db.userSettings.findUnique({
      where: { user_id: userId },
      select: { default_account_id: true },
    });
    return settings?.default_account_id ?? null;
  }

  /** When the default account goes away, the next active one by order takes its place. */
  private async reassignDefault(
    tx: Tx,
    userId: string,
    leavingId: string,
  ): Promise<void> {
    if ((await this.defaultAccountId(tx, userId)) !== leavingId) {
      return;
    }
    const next = await tx.accounts.findFirst({
      where: {
        user_id: userId,
        id: { not: leavingId },
        deleted_at: null,
        is_archived: false,
      },
      orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
    });
    await this.setDefault(tx, userId, next?.id ?? null);
  }

  /**
   * `isDefault` is stored in user_settings, so the accounts losing and gaining it are
   * touched too: otherwise sync would never report the change.
   */
  private async setDefault(
    tx: Tx,
    userId: string,
    accountId: string | null,
  ): Promise<void> {
    const previous = await this.defaultAccountId(tx, userId);
    if (previous === accountId) {
      return;
    }
    await tx.userSettings.update({
      where: { user_id: userId },
      data: { default_account_id: accountId },
    });
    const touched = [previous, accountId].filter(
      (id): id is string => id !== null,
    );
    await tx.accounts.updateMany({
      where: { id: { in: touched } },
      data: { updated_at: new Date() },
    });
  }

  private async reload(
    tx: Tx,
    userId: string,
    id: string,
  ): Promise<AccountDto> {
    const row = await tx.accounts.findUniqueOrThrow({
      where: { id },
      include: withCurrency,
    });
    return toDto(row, await this.defaultAccountId(tx, userId));
  }

  /** Sync stream: accounts changed inside the window, tombstones included. */
  async changes(
    userId: string,
    window: ChangeWindow,
  ): Promise<ChangesPage<AccountDto>> {
    const [defaultId, rows] = await Promise.all([
      this.defaultAccountId(this.prisma, userId),
      this.prisma.accounts.findMany({
        where: {
          user_id: userId,
          ...changeWindowWhere(window),
        } as Prisma.AccountsWhereInput,
        include: withCurrency,
        orderBy: changeOrder(),
        take: window.limit,
      }),
    ]);
    return {
      items: rows.map((row) => toDto(row, defaultId)),
      last: lastPosition(rows, (row) => ({
        updatedAt: row.updated_at,
        id: row.id,
      })),
    };
  }
}
