import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { localDate } from '../common/dates.js';
import { assertCurrencyPrecision } from '../common/schemas.js';
import { PrismaService } from '../database/prisma.service.js';
import { GOAL_TEMPLATES } from '../database/reference-data.js';
import { FxService } from '../finance/fx.service.js';
import { decodeCursor, encodeCursor } from '../finance/transactions/cursor.js';
import { Prisma } from '../generated/prisma/client.js';
import type {
  ContributionMethod,
  ContributionType,
  GoalStatus,
  LanguageCode,
} from '../generated/prisma/enums.js';
import {
  type ChangeWindow,
  type ChangesPage,
  changeOrder,
  changeWindowWhere,
  lastPosition,
} from '../sync/sync-window.js';
import {
  type GoalSchedule,
  type ScheduleStatus,
  goalSchedule,
  progressPercent,
  reachedMilestones,
} from './goal-math.js';
import type {
  ContributionInput,
  CreateGoalInput,
  UpdateGoalInput,
} from './goals.schemas.js';

type Tx = Prisma.TransactionClient;
type Decimal = Prisma.Decimal;
const { Decimal } = Prisma;

const DEFAULT_EMOJI = '🎯';
const DEFAULT_COLOR = '#0A84FF';
/** Statuses in which a goal is being saved for; only these can be primary. */
const LIVE: GoalStatus[] = ['active', 'paused'];

const goalInclude = {
  currency: { select: { code: true, decimals: true } },
  goalMilestones: { select: { percent: true } },
} as const;
type GoalRow = Prisma.GoalsGetPayload<{ include: typeof goalInclude }>;

const contributionInclude = {
  currency: { select: { code: true, decimals: true } },
  sourceAccount: {
    select: { currency: { select: { code: true, decimals: true } } },
  },
} as const;
type ContributionRow = Prisma.GoalContributionsGetPayload<{
  include: typeof contributionInclude;
}>;

export interface GoalDto {
  id: string;
  title: string;
  emoji: string;
  color: string;
  coverImageKey: string | null;
  templateKey: string | null;
  targetAmount: string;
  savedAmount: string;
  remaining: string;
  /** ⌊saved ÷ target × 100⌋, may exceed 100 */
  progress: number;
  currency: string;
  deadline: string | null;
  status: GoalStatus;
  isPrimary: boolean;
  priority: number;
  linkedAccountId: string | null;
  milestones: number[];
  schedule: {
    perDay: string;
    perWeek: string;
    perMonth: string;
    expectedSaved: string;
    status: ScheduleStatus;
    daysLeft: number;
  } | null;
  completedAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ContributionDto {
  id: string;
  goalId: string;
  type: ContributionType;
  /** In the goal's currency */
  amount: string;
  currency: string;
  accountId: string | null;
  /** What the account paid or got, in its currency */
  accountAmount: string | null;
  accountCurrency: string | null;
  method: ContributionMethod;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ContributionResult {
  goal: GoalDto;
  contribution: ContributionDto;
  /** Milestones reached by this contribution, for the celebration animation */
  newMilestones: number[];
  /** The goal reached its target with this contribution */
  completed: boolean;
}

/** Extra links for contributions made by Smart Save and auto-save rules. */
export interface ContributionOrigin {
  method: ContributionMethod;
  smartSaveSuggestionId?: string;
  autoSaveRuleId?: string;
}

function dateOnly(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function goalToDto(row: GoalRow, today: string, timezone: string): GoalDto {
  const decimals = row.currency.decimals;
  const money = (value: Decimal) => value.toFixed(decimals);
  const schedule: GoalSchedule | null = LIVE.includes(row.status)
    ? goalSchedule({
        target: row.target_amount,
        saved: row.saved_amount,
        startedOn: localDate(row.created_at, timezone),
        deadline: dateOnly(row.deadline),
        today,
        decimals,
      })
    : null;
  return {
    id: row.id,
    title: row.title,
    emoji: row.emoji,
    color: row.color,
    coverImageKey: row.cover_image_key,
    templateKey: row.template_key,
    targetAmount: money(row.target_amount),
    savedAmount: money(row.saved_amount),
    remaining: money(Decimal.max(0, row.target_amount.minus(row.saved_amount))),
    progress: progressPercent(row.saved_amount, row.target_amount),
    currency: row.currency.code,
    deadline: dateOnly(row.deadline),
    status: row.status,
    isPrimary: row.is_primary,
    priority: row.priority,
    linkedAccountId: row.linked_account_id,
    milestones: row.goalMilestones.map((m) => m.percent).sort((a, b) => a - b),
    schedule: schedule && {
      perDay: money(schedule.perDay),
      perWeek: money(schedule.perWeek),
      perMonth: money(schedule.perMonth),
      expectedSaved: money(schedule.expectedSaved),
      status: schedule.status,
      daysLeft: schedule.daysLeft,
    },
    completedAt: row.completed_at,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function contributionToDto(row: ContributionRow): ContributionDto {
  const accountCurrency = row.sourceAccount?.currency ?? null;
  return {
    id: row.id,
    goalId: row.goal_id,
    type: row.type,
    amount: row.amount.toFixed(row.currency.decimals),
    currency: row.currency.code,
    accountId: row.source_account_id,
    accountAmount:
      row.source_amount && accountCurrency
        ? row.source_amount.toFixed(accountCurrency.decimals)
        : null,
    accountCurrency: accountCurrency?.code ?? null,
    method: row.method,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

const goalNotFound = () =>
  new NotFoundException({ code: 'goal_not_found', message: 'Goal not found' });

const conflict = (code: string, message: string) =>
  new ConflictException({ code, message });

@Injectable()
export class GoalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly fx: FxService,
  ) {}

  templates(language: LanguageCode) {
    return GOAL_TEMPLATES.map((template) => ({
      key: template.key,
      emoji: template.emoji,
      color: template.color,
      name: template.labels[language],
      labels: template.labels,
    }));
  }

  async language(userId: string): Promise<LanguageCode> {
    const user = await this.prisma.users.findUniqueOrThrow({
      where: { id: userId },
      select: { language: true },
    });
    return user.language;
  }

  // ---------- Goals ----------

  async list(userId: string, status?: GoalStatus): Promise<GoalDto[]> {
    const [clock, rows] = await Promise.all([
      this.clock(userId),
      this.prisma.goals.findMany({
        where: { user_id: userId, deleted_at: null, status },
        include: goalInclude,
        orderBy: [{ priority: 'asc' }, { created_at: 'asc' }],
      }),
    ]);
    return rows.map((row) => goalToDto(row, clock.today, clock.timezone));
  }

  async get(userId: string, id: string): Promise<GoalDto> {
    const row = await this.prisma.goals.findUnique({
      where: { id },
      include: goalInclude,
    });
    if (!row || row.user_id !== userId || row.deleted_at) throw goalNotFound();
    return this.toDto(userId, row);
  }

  /** Idempotent: the same id again returns the goal created the first time. */
  async create(userId: string, input: CreateGoalInput): Promise<GoalDto> {
    const existing = await this.prisma.goals.findUnique({
      where: { id: input.id },
      include: goalInclude,
    });
    if (existing) {
      if (existing.user_id !== userId || existing.deleted_at) {
        throw conflict('id_conflict', 'This id is already used');
      }
      return this.toDto(userId, existing);
    }

    const clock = await this.clock(userId);
    const currency = input.currency
      ? await this.prisma.currencies.findUnique({
          where: { code: input.currency },
        })
      : await this.prisma.currencies.findUnique({
          where: { id: clock.baseCurrencyId },
        });
    if (!currency || !currency.is_active) {
      throw new BadRequestException({
        code: 'currency_not_supported',
        message: `Currency ${input.currency} is not supported`,
      });
    }
    assertCurrencyPrecision(input.targetAmount, currency);
    this.assertDeadline(input.deadline ?? null, clock.today);
    if (input.linkedAccountId) {
      await this.assertLinkedAccount(
        userId,
        input.linkedAccountId,
        currency.id,
      );
    }
    await this.entitlements.assertCanCreate(userId, 'active_goals');

    const template = GOAL_TEMPLATES.find((t) => t.key === input.templateKey);
    return this.prisma.$transaction(async (tx) => {
      const [{ _max }, primary] = await Promise.all([
        tx.goals.aggregate({
          where: { user_id: userId },
          _max: { priority: true },
        }),
        tx.goals.count({
          where: { user_id: userId, deleted_at: null, is_primary: true },
        }),
      ]);
      const row = await tx.goals.create({
        data: {
          id: input.id,
          user_id: userId,
          title: input.title,
          template_key: input.templateKey,
          emoji: input.emoji ?? template?.emoji ?? DEFAULT_EMOJI,
          color: input.color ?? template?.color ?? DEFAULT_COLOR,
          target_amount: input.targetAmount,
          currency_id: currency.id,
          deadline: input.deadline ? new Date(input.deadline) : null,
          linked_account_id: input.linkedAccountId,
          priority: (_max.priority ?? -1) + 1,
          // The first goal becomes the primary one.
          is_primary: primary === 0,
        },
        include: goalInclude,
      });
      return goalToDto(row, clock.today, clock.timezone);
    });
  }

  async update(
    userId: string,
    id: string,
    patch: UpdateGoalInput,
  ): Promise<GoalDto> {
    const clock = await this.clock(userId);
    return this.prisma.$transaction(async (tx) => {
      const goal = await this.lockGoal(tx, userId, id);
      const next = patch.status ?? goal.status;
      const reviving = LIVE.includes(next) && !LIVE.includes(goal.status);
      const resuming = next === 'active' && goal.status === 'paused';

      if (patch.targetAmount) {
        assertCurrencyPrecision(patch.targetAmount, goal.currency);
      }
      if (patch.deadline !== undefined) {
        this.assertDeadline(patch.deadline, clock.today);
      }
      if (patch.linkedAccountId) {
        await this.assertLinkedAccount(
          userId,
          patch.linkedAccountId,
          goal.currency_id,
          tx,
        );
      }
      if (reviving || resuming) {
        await this.entitlements.assertCanCreate(userId, 'active_goals');
      }
      if (patch.isPrimary && !LIVE.includes(next)) {
        throw conflict(
          'goal_not_active',
          'Only an active goal can be the primary one',
        );
      }

      const now = new Date();
      const target = patch.targetAmount
        ? new Decimal(patch.targetAmount)
        : goal.target_amount;
      // Reaching the target (also by lowering it) completes a goal that is being saved for.
      const reachesTarget =
        LIVE.includes(next) && goal.saved_amount.gte(target);
      const status: GoalStatus = reachesTarget ? 'completed' : next;

      await tx.goals.update({
        where: { id },
        data: {
          title: patch.title,
          emoji: patch.emoji,
          color: patch.color,
          target_amount: patch.targetAmount,
          deadline:
            patch.deadline === undefined
              ? undefined
              : patch.deadline === null
                ? null
                : new Date(patch.deadline),
          linked_account_id: patch.linkedAccountId,
          status,
          completed_at:
            status === 'completed' && goal.status !== 'completed'
              ? now
              : LIVE.includes(status)
                ? null
                : undefined,
          archived_at:
            status === 'archived' && goal.status !== 'archived'
              ? now
              : status !== 'archived'
                ? null
                : undefined,
        },
      });

      if (patch.isPrimary && LIVE.includes(status)) {
        await this.makePrimary(tx, userId, id);
      } else {
        await this.settlePrimary(tx, userId);
      }
      return this.reload(tx, userId, id, clock);
    });
  }

  async reorder(userId: string, ids: string[]): Promise<GoalDto[]> {
    const owned = await this.prisma.goals.count({
      where: { id: { in: ids }, user_id: userId, deleted_at: null },
    });
    if (owned !== ids.length) {
      throw new BadRequestException({
        code: 'unknown_ids',
        message: 'Some ids are not your goals',
      });
    }
    await this.prisma.$transaction(
      ids.map((id, index) =>
        this.prisma.goals.update({ where: { id }, data: { priority: index } }),
      ),
    );
    return this.list(userId);
  }

  /** Only an empty goal can be deleted: money inside must be withdrawn first, or the goal archived. */
  async remove(userId: string, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const goal = await this.lockGoal(tx, userId, id);
      if (goal.saved_amount.gt(0)) {
        throw conflict(
          'goal_has_money',
          'Withdraw the money or archive the goal instead',
        );
      }
      const now = new Date();
      await tx.goals.update({
        where: { id },
        data: { deleted_at: now, is_primary: false },
      });
      await tx.goalContributions.updateMany({
        where: { goal_id: id, deleted_at: null },
        data: { deleted_at: now },
      });
      await this.settlePrimary(tx, userId);
    });
  }

  // ---------- Contributions ----------

  /**
   * Deposit into or withdrawal from a goal. Money moves between the chosen account and the
   * goal's savings account (or the goal itself when it has none) in one database transaction.
   * Idempotent by contribution id.
   */
  async contribute(
    userId: string,
    goalId: string,
    input: ContributionInput,
    origin: ContributionOrigin = { method: 'manual' },
  ): Promise<ContributionResult> {
    const clock = await this.clock(userId);
    return this.prisma.$transaction(async (tx) => {
      const goal = await this.lockGoal(tx, userId, goalId);

      const repeated = await tx.goalContributions.findUnique({
        where: { id: input.id },
        include: contributionInclude,
      });
      if (repeated) {
        if (repeated.user_id !== userId || repeated.goal_id !== goalId) {
          throw conflict('id_conflict', 'This id is already used');
        }
        return {
          goal: await this.reload(tx, userId, goalId, clock),
          contribution: contributionToDto(repeated),
          newMilestones: [],
          completed: false,
        };
      }

      const deposit = input.type === 'deposit';
      if (deposit && goal.status === 'completed') {
        throw conflict(
          'goal_completed',
          'The goal is reached; bring it back to save more',
        );
      }
      if (deposit && goal.status === 'archived') {
        throw conflict('goal_archived', 'The goal is archived');
      }
      assertCurrencyPrecision(input.amount, goal.currency);
      const amount = new Decimal(input.amount);
      if (!deposit && amount.gt(goal.saved_amount)) {
        throw conflict(
          'insufficient_goal_funds',
          'The goal has less money than that',
        );
      }

      const accountAmount = input.accountId
        ? await this.accountAmount(tx, userId, goal, input)
        : null;

      await this.moveMoney(
        tx,
        goal,
        input.type,
        amount,
        input.accountId ?? null,
        accountAmount,
        1,
      );

      const row = await tx.goalContributions.create({
        data: {
          id: input.id,
          goal_id: goalId,
          user_id: userId,
          type: input.type,
          amount,
          currency_id: goal.currency_id,
          source_account_id: input.accountId,
          source_amount: accountAmount,
          method: origin.method,
          smart_save_suggestion_id: origin.smartSaveSuggestionId,
          auto_save_rule_id: origin.autoSaveRuleId,
          note: input.note,
        },
        include: contributionInclude,
      });

      const saved = deposit
        ? goal.saved_amount.plus(amount)
        : goal.saved_amount.minus(amount);
      const completed =
        deposit && LIVE.includes(goal.status) && saved.gte(goal.target_amount);
      await tx.goals.update({
        where: { id: goalId },
        data: {
          saved_amount: saved,
          ...(completed
            ? { status: 'completed', completed_at: new Date() }
            : {}),
        },
      });
      const newMilestones = deposit
        ? await this.recordMilestones(
            tx,
            goalId,
            progressPercent(saved, goal.target_amount),
          )
        : [];
      if (completed) {
        await this.settlePrimary(tx, userId);
      }

      return {
        goal: await this.reload(tx, userId, goalId, clock),
        contribution: contributionToDto(row),
        newMilestones,
        completed,
      };
    });
  }

  /** Undo of a contribution: money goes back where it came from. */
  async removeContribution(
    userId: string,
    goalId: string,
    contributionId: string,
  ): Promise<GoalDto> {
    const clock = await this.clock(userId);
    return this.prisma.$transaction(async (tx) => {
      const goal = await this.lockGoal(tx, userId, goalId);
      const contribution = await tx.goalContributions.findUnique({
        where: { id: contributionId },
      });
      if (
        !contribution ||
        contribution.user_id !== userId ||
        contribution.goal_id !== goalId
      ) {
        throw new NotFoundException({
          code: 'contribution_not_found',
          message: 'Contribution not found',
        });
      }
      if (contribution.deleted_at) {
        return this.reload(tx, userId, goalId, clock);
      }

      const deposit = contribution.type === 'deposit';
      if (deposit && contribution.amount.gt(goal.saved_amount)) {
        throw conflict(
          'insufficient_goal_funds',
          'This money was already withdrawn from the goal',
        );
      }
      await this.moveMoney(
        tx,
        goal,
        contribution.type,
        contribution.amount,
        contribution.source_account_id,
        contribution.source_amount,
        -1,
      );
      await tx.goalContributions.update({
        where: { id: contributionId },
        data: { deleted_at: new Date() },
      });

      const saved = deposit
        ? goal.saved_amount.minus(contribution.amount)
        : goal.saved_amount.plus(contribution.amount);
      // Undoing a deposit that had reached the target puts the goal back to work.
      // Undoing a withdrawal only returns money and never reopens a reached goal.
      const reopen =
        deposit && goal.status === 'completed' && saved.lt(goal.target_amount);
      await tx.goals.update({
        where: { id: goalId },
        data: {
          saved_amount: saved,
          ...(reopen ? { status: 'active', completed_at: null } : {}),
        },
      });
      if (reopen) await this.settlePrimary(tx, userId);
      return this.reload(tx, userId, goalId, clock);
    });
  }

  async listContributions(
    userId: string,
    goalId: string,
    cursorValue: string | undefined,
    limit: number,
  ): Promise<{ items: ContributionDto[]; nextCursor: string | null }> {
    await this.get(userId, goalId);
    const cursor = cursorValue ? decodeCursor(cursorValue) : null;
    const rows = await this.prisma.goalContributions.findMany({
      where: {
        goal_id: goalId,
        user_id: userId,
        deleted_at: null,
        ...(cursor
          ? {
              OR: [
                { created_at: { lt: cursor.occurredAt } },
                { created_at: cursor.occurredAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      include: contributionInclude,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(contributionToDto),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ occurredAt: last.created_at, id: last.id })
          : null,
    };
  }

  // ---------- Sync streams ----------

  async changes(
    userId: string,
    window: ChangeWindow,
  ): Promise<ChangesPage<GoalDto>> {
    const [clock, rows] = await Promise.all([
      this.clock(userId),
      this.prisma.goals.findMany({
        where: {
          user_id: userId,
          ...changeWindowWhere(window),
        } as Prisma.GoalsWhereInput,
        include: goalInclude,
        orderBy: changeOrder(),
        take: window.limit,
      }),
    ]);
    return {
      items: rows.map((row) => goalToDto(row, clock.today, clock.timezone)),
      last: lastPosition(rows, (row) => ({
        updatedAt: row.updated_at,
        id: row.id,
      })),
    };
  }

  async contributionChanges(
    userId: string,
    window: ChangeWindow,
  ): Promise<ChangesPage<ContributionDto>> {
    const rows = await this.prisma.goalContributions.findMany({
      where: {
        user_id: userId,
        ...changeWindowWhere(window),
      } as Prisma.GoalContributionsWhereInput,
      include: contributionInclude,
      orderBy: changeOrder(),
      take: window.limit,
    });
    return {
      items: rows.map(contributionToDto),
      last: lastPosition(rows, (row) => ({
        updatedAt: row.updated_at,
        id: row.id,
      })),
    };
  }

  // ---------- Internals ----------

  /**
   * Deposit: account → savings account (or into the goal). Withdrawal: the reverse.
   * `sign` −1 undoes a contribution. Accounts touched in a stable order.
   */
  private async moveMoney(
    tx: Tx,
    goal: GoalRow,
    type: ContributionType,
    amount: Decimal,
    accountId: string | null,
    accountAmount: Decimal | null,
    sign: 1 | -1,
  ): Promise<void> {
    const linked = goal.linked_account_id;
    if (accountId && accountId === linked) {
      return; // The money already sits in the savings account.
    }
    const deltas = new Map<string, Decimal>();
    const flow = type === 'deposit' ? 1 : -1;
    if (accountId && accountAmount) {
      deltas.set(accountId, accountAmount.times(-flow * sign));
    }
    if (linked) {
      deltas.set(linked, amount.times(flow * sign));
    }
    for (const id of [...deltas.keys()].sort()) {
      await tx.accounts.updateMany({
        where: { id, deleted_at: null },
        data: { current_balance: { increment: deltas.get(id)! } },
      });
    }
  }

  /** What the chosen account pays or gets, in its own currency. */
  private async accountAmount(
    tx: Tx,
    userId: string,
    goal: GoalRow,
    input: ContributionInput,
  ): Promise<Decimal> {
    const account = await tx.accounts.findUnique({
      where: { id: input.accountId },
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
    const amount = new Decimal(input.amount);
    if (account.currency_id === goal.currency_id) {
      if (
        input.accountAmount &&
        !new Decimal(input.accountAmount).equals(amount)
      ) {
        throw new BadRequestException({
          code: 'amount_mismatch',
          message:
            'An account in the goal currency moves exactly the goal amount',
        });
      }
      return amount;
    }
    if (input.accountAmount) {
      assertCurrencyPrecision(input.accountAmount, account.currency);
      return new Decimal(input.accountAmount);
    }
    const rate = await this.fx.rate(
      goal.currency_id,
      account.currency_id,
      new Date(),
    );
    if (!rate) {
      throw new UnprocessableEntityException({
        code: 'exchange_rate_unavailable',
        message: `No ${goal.currency.code}→${account.currency.code} rate; pass accountAmount`,
        from: goal.currency.code,
        to: account.currency.code,
      });
    }
    return amount.times(rate).toDecimalPlaces(account.currency.decimals);
  }

  /** Stores milestones reached for the first time and returns them. */
  private async recordMilestones(
    tx: Tx,
    goalId: string,
    percent: number,
  ): Promise<number[]> {
    const reached = reachedMilestones(percent);
    if (reached.length === 0) return [];
    const existing = await tx.goalMilestones.findMany({
      where: { goal_id: goalId },
      select: { percent: true },
    });
    const known = new Set(existing.map((m) => m.percent));
    const fresh = reached.filter((p) => !known.has(p));
    if (fresh.length > 0) {
      const now = new Date();
      await tx.goalMilestones.createMany({
        data: fresh.map((p) => ({
          goal_id: goalId,
          percent: p,
          reached_at: now,
        })),
        skipDuplicates: true,
      });
    }
    return fresh;
  }

  private async makePrimary(
    tx: Tx,
    userId: string,
    goalId: string,
  ): Promise<void> {
    await tx.goals.updateMany({
      where: { user_id: userId, is_primary: true, id: { not: goalId } },
      data: { is_primary: false },
    });
    await tx.goals.update({
      where: { id: goalId },
      data: { is_primary: true },
    });
  }

  /**
   * Keeps exactly one primary goal among the live ones: a primary goal that was completed,
   * archived or deleted hands over to the next live goal by priority.
   */
  private async settlePrimary(tx: Tx, userId: string): Promise<void> {
    await tx.goals.updateMany({
      where: {
        user_id: userId,
        is_primary: true,
        OR: [{ status: { notIn: LIVE } }, { deleted_at: { not: null } }],
      },
      data: { is_primary: false },
    });
    const hasPrimary = await tx.goals.count({
      where: { user_id: userId, is_primary: true },
    });
    if (hasPrimary > 0) return;
    const next = await tx.goals.findFirst({
      where: { user_id: userId, deleted_at: null, status: { in: LIVE } },
      orderBy: [{ priority: 'asc' }, { created_at: 'asc' }],
    });
    if (next) {
      await tx.goals.update({
        where: { id: next.id },
        data: { is_primary: true },
      });
    }
  }

  private assertDeadline(deadline: string | null, today: string): void {
    if (deadline && deadline < today) {
      throw new BadRequestException({
        code: 'deadline_in_past',
        message: 'The deadline must be today or later',
      });
    }
  }

  private async assertLinkedAccount(
    userId: string,
    accountId: string,
    currencyId: number,
    db: PrismaService | Tx = this.prisma,
  ): Promise<void> {
    const account = await db.accounts.findUnique({ where: { id: accountId } });
    if (
      !account ||
      account.user_id !== userId ||
      account.deleted_at ||
      account.is_archived ||
      account.currency_id !== currencyId
    ) {
      throw new BadRequestException({
        code: 'invalid_linked_account',
        message:
          'The savings account must be an active account in the goal currency',
      });
    }
  }

  /** Row lock: contributions to one goal apply one after another. */
  private async lockGoal(tx: Tx, userId: string, id: string): Promise<GoalRow> {
    await tx.$queryRaw`SELECT 1 FROM goals WHERE id = ${id}::uuid FOR UPDATE`;
    const goal = await tx.goals.findUnique({
      where: { id },
      include: goalInclude,
    });
    if (!goal || goal.user_id !== userId || goal.deleted_at)
      throw goalNotFound();
    return goal;
  }

  private async reload(
    tx: Tx,
    userId: string,
    id: string,
    clock: { today: string; timezone: string },
  ): Promise<GoalDto> {
    const row = await tx.goals.findUniqueOrThrow({
      where: { id },
      include: goalInclude,
    });
    return goalToDto(row, clock.today, clock.timezone);
  }

  private async toDto(userId: string, row: GoalRow): Promise<GoalDto> {
    const clock = await this.clock(userId);
    return goalToDto(row, clock.today, clock.timezone);
  }

  private async clock(userId: string) {
    const user = await this.prisma.users.findUniqueOrThrow({
      where: { id: userId },
      select: { timezone: true, base_currency_id: true },
    });
    return {
      timezone: user.timezone,
      today: localDate(new Date(), user.timezone),
      baseCurrencyId: user.base_currency_id,
    };
  }
}
