import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { localDate } from '../../common/dates.js';
import { assertCurrencyPrecision } from '../../common/schemas.js';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import type {
  TransactionSource,
  TransactionType,
} from '../../generated/prisma/enums.js';
import { FxService } from '../fx.service.js';
import { type BalanceMovement, netEffects } from './balance-effects.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import type {
  CreateTransactionInput,
  ListTransactionsQuery,
  UpdateTransactionInput,
} from './transactions.schemas.js';

type Tx = Prisma.TransactionClient;
type Decimal = Prisma.Decimal;

/** Dates more than this far ahead are refused: the app records what happened, not plans. */
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
const FREQUENT_WINDOW_DAYS = 90;
const FREQUENT_LIMIT = 8;

const include = {
  currency: { select: { code: true, decimals: true } },
  transferAccount: {
    select: { currency: { select: { code: true, decimals: true } } },
  },
} as const;
type TransactionRow = Prisma.TransactionsGetPayload<{
  include: typeof include;
}>;

interface UserContext {
  baseCurrencyId: number;
  baseCurrency: { code: string; decimals: number };
  timezone: string;
}

export interface TransactionDto {
  id: string;
  type: TransactionType;
  accountId: string;
  transferAccountId: string | null;
  /** In the account currency */
  amount: string;
  currency: string;
  /** Transfers: what the receiving account got, in its currency */
  transferAmount: string | null;
  transferCurrency: string | null;
  /** In the user's base currency, at the rate of the operation date */
  amountBase: string;
  baseCurrency: string;
  fxRate: string;
  categoryId: string | null;
  note: string | null;
  merchant: string | null;
  occurredAt: Date;
  source: TransactionSource;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface DayTotal {
  /** Calendar day in the user's time zone */
  date: string;
  income: string;
  expense: string;
}

export interface TransactionPage {
  items: TransactionDto[];
  nextCursor: string | null;
  /** Totals of every day present in `items`, over the whole day and the same filters */
  days: DayTotal[];
}

/** The state an operation will have, after merging a patch, before validation. */
interface Draft {
  type: TransactionType;
  accountId: string;
  amount: string;
  categoryId: string | null;
  transferAccountId: string | null;
  transferAmount: string | null;
  fxRate: string | null;
  note: string | null;
  merchant: string | null;
  occurredAt: Date;
}

function toDto(row: TransactionRow, user: UserContext): TransactionDto {
  const transferCurrency = row.transferAccount?.currency ?? null;
  return {
    id: row.id,
    type: row.type,
    accountId: row.account_id,
    transferAccountId: row.transfer_account_id,
    amount: row.amount.toFixed(row.currency.decimals),
    currency: row.currency.code,
    transferAmount:
      row.transfer_amount && transferCurrency
        ? row.transfer_amount.toFixed(transferCurrency.decimals)
        : null,
    transferCurrency: transferCurrency?.code ?? null,
    amountBase: row.amount_base.toFixed(user.baseCurrency.decimals),
    baseCurrency: user.baseCurrency.code,
    fxRate: row.fx_rate.toString(),
    categoryId: row.category_id,
    note: row.note,
    merchant: row.merchant,
    occurredAt: row.occurred_at,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function movementOf(row: {
  type: TransactionType;
  account_id: string;
  amount: Decimal;
  transfer_account_id: string | null;
  transfer_amount: Decimal | null;
}): BalanceMovement {
  return {
    type: row.type,
    account_id: row.account_id,
    amount: row.amount,
    transfer_account_id: row.transfer_account_id,
    transfer_amount: row.transfer_amount,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

const notFound = () =>
  new NotFoundException({
    code: 'transaction_not_found',
    message: 'Operation not found',
  });

const bad = (code: string, message: string) =>
  new BadRequestException({ code, message });

@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fx: FxService,
  ) {}

  // ---------- Reading ----------

  async get(userId: string, id: string): Promise<TransactionDto> {
    const row = await this.prisma.transactions.findUnique({
      where: { id },
      include,
    });
    if (!row || row.user_id !== userId) {
      throw notFound();
    }
    return toDto(row, await this.userContext(userId));
  }

  async list(
    userId: string,
    query: ListTransactionsQuery,
  ): Promise<TransactionPage> {
    const user = await this.userContext(userId);
    const where = await this.filters(userId, query);
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;

    const rows = await this.prisma.transactions.findMany({
      where: cursor
        ? {
            AND: [
              where,
              {
                OR: [
                  { occurred_at: { lt: cursor.occurredAt } },
                  { occurred_at: cursor.occurredAt, id: { lt: cursor.id } },
                ],
              },
            ],
          }
        : where,
      include,
      orderBy: [{ occurred_at: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => toDto(row, user)),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ occurredAt: last.occurred_at, id: last.id })
          : null,
      days: await this.dayTotals(where, page, user),
    };
  }

  /** Categories for the quick-add grid: most used in the last 90 days first, then most recent. */
  async frequentCategories(
    userId: string,
    type: 'income' | 'expense',
    now = new Date(),
  ): Promise<string[]> {
    const groups = await this.prisma.transactions.groupBy({
      by: ['category_id'],
      where: {
        user_id: userId,
        type,
        deleted_at: null,
        category_id: { not: null },
        occurred_at: {
          gte: new Date(now.getTime() - FREQUENT_WINDOW_DAYS * 86_400_000),
        },
      },
      _count: { _all: true },
      _max: { occurred_at: true },
    });
    return groups
      .sort(
        (a, b) =>
          b._count._all - a._count._all ||
          (b._max.occurred_at?.getTime() ?? 0) -
            (a._max.occurred_at?.getTime() ?? 0),
      )
      .slice(0, FREQUENT_LIMIT)
      .map((group) => group.category_id!);
  }

  // ---------- Writing ----------

  /** Idempotent: the same id again returns the first result and does not move balances twice. */
  async create(
    userId: string,
    input: CreateTransactionInput,
  ): Promise<TransactionDto> {
    const user = await this.userContext(userId);
    const existing = await this.findExisting(userId, input.id, user);
    if (existing) return existing;

    const draft: Draft = {
      type: input.type,
      accountId: input.accountId,
      amount: input.amount,
      categoryId: input.categoryId ?? null,
      transferAccountId: input.transferAccountId ?? null,
      transferAmount: input.transferAmount ?? null,
      fxRate: input.fxRate ?? null,
      note: input.note ?? null,
      merchant: input.merchant ?? null,
      occurredAt: input.occurredAt,
    };

    try {
      return await this.prisma.$transaction(async (tx) => {
        const data = await this.resolve(tx, userId, user, draft, null);
        const created = await tx.transactions.create({
          data: {
            ...data,
            id: input.id,
            user_id: userId,
            source: input.source,
          },
          include,
        });
        await this.applyBalances(tx, netEffects(null, movementOf(created)));
        return toDto(created, user);
      });
    } catch (error) {
      // A retry raced the first request: return what the first one stored.
      if (isUniqueViolation(error)) {
        const raced = await this.findExisting(userId, input.id, user);
        if (raced) return raced;
      }
      throw error;
    }
  }

  async update(
    userId: string,
    id: string,
    patch: UpdateTransactionInput,
  ): Promise<TransactionDto> {
    const user = await this.userContext(userId);
    return this.prisma.$transaction(async (tx) => {
      const existing = await this.lockOwned(tx, userId, id);
      if (existing.deleted_at) throw notFound();

      const type = patch.type ?? existing.type;
      const typeChanged = type !== existing.type;
      // Changing the kind of operation drops fields that do not fit the new kind.
      const draft: Draft = {
        type,
        accountId: patch.accountId ?? existing.account_id,
        amount: patch.amount ?? existing.amount.toString(),
        categoryId:
          patch.categoryId !== undefined
            ? patch.categoryId
            : typeChanged
              ? null
              : existing.category_id,
        transferAccountId:
          type !== 'transfer'
            ? null
            : patch.transferAccountId !== undefined
              ? patch.transferAccountId
              : existing.transfer_account_id,
        transferAmount:
          type !== 'transfer'
            ? null
            : patch.transferAmount !== undefined
              ? patch.transferAmount
              : patch.amount !== undefined ||
                  patch.accountId !== undefined ||
                  patch.transferAccountId !== undefined ||
                  typeChanged
                ? null
                : (existing.transfer_amount?.toString() ?? null),
        fxRate: patch.fxRate ?? null,
        note: patch.note !== undefined ? patch.note : existing.note,
        merchant:
          patch.merchant !== undefined ? patch.merchant : existing.merchant,
        occurredAt: patch.occurredAt ?? existing.occurred_at,
      };

      const data = await this.resolve(tx, userId, user, draft, existing);
      const updated = await tx.transactions.update({
        where: { id },
        data,
        include,
      });
      await this.applyBalances(
        tx,
        netEffects(movementOf(existing), movementOf(updated)),
      );
      return toDto(updated, user);
    });
  }

  /** Soft delete: balances are restored and the row stays for undo and sync. */
  async remove(userId: string, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await this.lockOwned(tx, userId, id);
      if (existing.deleted_at) return;
      await tx.transactions.update({
        where: { id },
        data: { deleted_at: new Date() },
      });
      await this.applyBalances(tx, netEffects(movementOf(existing), null));
    });
  }

  /** Undo of a delete: the operation and its effect on balances come back. */
  async restore(userId: string, id: string): Promise<TransactionDto> {
    const user = await this.userContext(userId);
    return this.prisma.$transaction(async (tx) => {
      const existing = await this.lockOwned(tx, userId, id);
      if (existing.deleted_at) {
        const accountIds = [
          existing.account_id,
          existing.transfer_account_id,
        ].filter((value): value is string => value !== null);
        const live = await tx.accounts.count({
          where: { id: { in: accountIds }, deleted_at: null },
        });
        if (live !== accountIds.length) {
          throw new ConflictException({
            code: 'account_deleted',
            message: 'The account of this operation was deleted',
          });
        }
        await tx.transactions.update({
          where: { id },
          data: { deleted_at: null },
        });
        await this.applyBalances(tx, netEffects(null, movementOf(existing)));
      }
      const row = await tx.transactions.findUniqueOrThrow({
        where: { id },
        include,
      });
      return toDto(row, user);
    });
  }

  // ---------- Internals ----------

  /**
   * Validates a draft against the user's accounts and categories and works out the
   * stored columns: currency, transfer amount, rate and amount in the base currency.
   */
  private async resolve(
    tx: Tx,
    userId: string,
    user: UserContext,
    draft: Draft,
    existing: TransactionRow | null,
  ) {
    if (draft.occurredAt.getTime() > Date.now() + MAX_FUTURE_MS) {
      throw bad('occurred_in_future', 'The date is too far in the future');
    }

    const account = await this.usableAccount(
      tx,
      userId,
      draft.accountId,
      existing?.account_id,
    );
    assertCurrencyPrecision(draft.amount, account.currency);
    const amount = new Prisma.Decimal(draft.amount);

    let categoryId: string | null = null;
    let transferAccountId: string | null = null;
    let transferAmount: Decimal | null = null;

    if (draft.type === 'transfer') {
      if (draft.categoryId) {
        throw bad('category_not_allowed', 'Transfers have no category');
      }
      if (!draft.transferAccountId) {
        throw bad('transfer_account_required', 'Choose the receiving account');
      }
      if (draft.transferAccountId === draft.accountId) {
        throw bad('same_account', 'A transfer needs two different accounts');
      }
      const target = await this.usableAccount(
        tx,
        userId,
        draft.transferAccountId,
        existing?.transfer_account_id ?? undefined,
      );
      transferAccountId = target.id;

      if (target.currency_id === account.currency_id) {
        if (
          draft.transferAmount &&
          !new Prisma.Decimal(draft.transferAmount).equals(amount)
        ) {
          throw bad(
            'transfer_amount_mismatch',
            'Accounts in one currency receive exactly the amount sent',
          );
        }
        transferAmount = amount;
      } else if (draft.transferAmount) {
        assertCurrencyPrecision(draft.transferAmount, target.currency);
        transferAmount = new Prisma.Decimal(draft.transferAmount);
      } else {
        const rate = await this.fx.rate(
          account.currency_id,
          target.currency_id,
          draft.occurredAt,
        );
        if (!rate) {
          throw this.rateUnavailable(
            account.currency.code,
            target.currency.code,
          );
        }
        transferAmount = amount
          .times(rate)
          .toDecimalPlaces(target.currency.decimals);
      }
    } else {
      if (draft.transferAccountId || draft.transferAmount) {
        throw bad(
          'transfer_fields_not_allowed',
          'Only transfers have a receiving account',
        );
      }
      if (draft.categoryId) {
        await this.assertCategory(tx, userId, draft.categoryId, draft.type);
        categoryId = draft.categoryId;
      }
    }

    // Keep the stored rate when nothing that defines it has changed.
    const sameRateBasis =
      existing !== null &&
      existing.currency_id === account.currency_id &&
      existing.occurred_at.getTime() === draft.occurredAt.getTime();
    const fxRate = draft.fxRate
      ? new Prisma.Decimal(draft.fxRate)
      : sameRateBasis
        ? existing.fx_rate
        : await this.fx.rate(
            account.currency_id,
            user.baseCurrencyId,
            draft.occurredAt,
          );
    if (!fxRate) {
      throw this.rateUnavailable(account.currency.code, user.baseCurrency.code);
    }

    return {
      type: draft.type,
      account_id: account.id,
      amount,
      currency_id: account.currency_id,
      amount_base: amount.times(fxRate).toDecimalPlaces(2),
      fx_rate: fxRate,
      category_id: categoryId,
      transfer_account_id: transferAccountId,
      transfer_amount: transferAmount,
      note: draft.note,
      merchant: draft.merchant,
      occurred_at: draft.occurredAt,
    };
  }

  /**
   * The user's live account. Archived accounts accept no new operations,
   * but operations already on them can still be edited.
   */
  private async usableAccount(
    tx: Tx,
    userId: string,
    accountId: string,
    currentAccountId?: string,
  ) {
    const account = await tx.accounts.findUnique({
      where: { id: accountId },
      include: { currency: true },
    });
    if (!account || account.user_id !== userId || account.deleted_at) {
      throw bad('invalid_account', 'Account not found');
    }
    if (account.is_archived && accountId !== currentAccountId) {
      throw new ConflictException({
        code: 'account_archived',
        message: 'The account is archived',
      });
    }
    return account;
  }

  private async assertCategory(
    tx: Tx,
    userId: string,
    categoryId: string,
    type: TransactionType,
  ): Promise<void> {
    const category = await tx.categories.findUnique({
      where: { id: categoryId },
    });
    if (
      !category ||
      category.deleted_at ||
      (category.user_id !== null && category.user_id !== userId) ||
      category.type !== type
    ) {
      throw bad('invalid_category', `Choose a ${type} category`);
    }
  }

  /** Atomic increments in a stable order, so concurrent writers never lose an update or deadlock. */
  private async applyBalances(
    tx: Tx,
    effects: Map<string, Decimal>,
  ): Promise<void> {
    for (const accountId of [...effects.keys()].sort()) {
      await tx.accounts.update({
        where: { id: accountId },
        data: { current_balance: { increment: effects.get(accountId)! } },
      });
    }
  }

  /** Row lock: parallel edits of one operation apply one after another. */
  private async lockOwned(
    tx: Tx,
    userId: string,
    id: string,
  ): Promise<TransactionRow> {
    await tx.$queryRaw`SELECT 1 FROM transactions WHERE id = ${id}::uuid FOR UPDATE`;
    const row = await tx.transactions.findUnique({ where: { id }, include });
    if (!row || row.user_id !== userId) {
      throw notFound();
    }
    return row;
  }

  private async findExisting(
    userId: string,
    id: string,
    user: UserContext,
  ): Promise<TransactionDto | null> {
    const row = await this.prisma.transactions.findUnique({
      where: { id },
      include,
    });
    if (!row) return null;
    if (row.user_id !== userId || row.deleted_at) {
      throw new ConflictException({
        code: 'id_conflict',
        message: 'This id is already used',
      });
    }
    return toDto(row, user);
  }

  private async filters(
    userId: string,
    query: ListTransactionsQuery,
  ): Promise<Prisma.TransactionsWhereInput> {
    const and: Prisma.TransactionsWhereInput[] = [
      { user_id: userId, deleted_at: null },
    ];
    if (query.type) and.push({ type: query.type });
    if (query.accountId) {
      and.push({
        OR: [
          { account_id: query.accountId },
          { transfer_account_id: query.accountId },
        ],
      });
    }
    if (query.categoryId) {
      const children = await this.prisma.categories.findMany({
        where: { parent_id: query.categoryId },
        select: { id: true },
      });
      and.push({
        category_id: { in: [query.categoryId, ...children.map((c) => c.id)] },
      });
    }
    if (query.from) and.push({ occurred_at: { gte: query.from } });
    if (query.to) and.push({ occurred_at: { lte: query.to } });
    if (query.q) {
      const q = query.q;
      const text = { contains: q, mode: 'insensitive' as const };
      const or: Prisma.TransactionsWhereInput[] = [
        { note: text },
        { merchant: text },
        {
          category: {
            is: {
              OR: [
                { name: text },
                { categoryTranslations: { some: { label: text } } },
              ],
            },
          },
        },
      ];
      // "25 000", "25000" or "12,50" also find operations of exactly that amount.
      const numeric = q.replace(/\s/g, '').replace(',', '.');
      if (/^\d+(\.\d{1,2})?$/.test(numeric)) {
        or.push({ amount: new Prisma.Decimal(numeric) });
      }
      and.push({ OR: or });
    }
    return { AND: and };
  }

  private async dayTotals(
    where: Prisma.TransactionsWhereInput,
    page: TransactionRow[],
    user: UserContext,
  ): Promise<DayTotal[]> {
    if (page.length === 0) return [];
    const dates = new Set(
      page.map((row) => localDate(row.occurred_at, user.timezone)),
    );
    const times = page.map((row) => row.occurred_at.getTime());
    // One day of margin on both sides covers any time zone offset.
    const rows = await this.prisma.transactions.findMany({
      where: {
        AND: [
          where,
          { type: { in: ['income', 'expense'] } },
          {
            occurred_at: {
              gte: new Date(Math.min(...times) - 86_400_000),
              lte: new Date(Math.max(...times) + 86_400_000),
            },
          },
        ],
      },
      select: { type: true, amount_base: true, occurred_at: true },
    });

    const totals = new Map<string, { income: Decimal; expense: Decimal }>();
    for (const date of dates) {
      totals.set(date, {
        income: new Prisma.Decimal(0),
        expense: new Prisma.Decimal(0),
      });
    }
    for (const row of rows) {
      const day = totals.get(localDate(row.occurred_at, user.timezone));
      if (!day) continue;
      if (row.type === 'income') day.income = day.income.plus(row.amount_base);
      else day.expense = day.expense.plus(row.amount_base);
    }
    const decimals = user.baseCurrency.decimals;
    return [...totals.entries()]
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([date, day]) => ({
        date,
        income: day.income.toFixed(decimals),
        expense: day.expense.toFixed(decimals),
      }));
  }

  private rateUnavailable(from: string, to: string) {
    return new UnprocessableEntityException({
      code: 'exchange_rate_unavailable',
      message: `No ${from}→${to} rate for this date; pass fxRate or transferAmount`,
      from,
      to,
    });
  }

  private async userContext(userId: string): Promise<UserContext> {
    const user = await this.prisma.users.findUniqueOrThrow({
      where: { id: userId },
      select: {
        timezone: true,
        base_currency_id: true,
        baseCurrency: { select: { code: true, decimals: true } },
      },
    });
    return {
      baseCurrencyId: user.base_currency_id,
      baseCurrency: user.baseCurrency,
      timezone: user.timezone,
    };
  }
}
