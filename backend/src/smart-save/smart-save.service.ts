import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  BudgetService,
  type BudgetSnapshot,
} from '../budget/budget.service.js';
import { AppSettingsService } from '../common/app-settings.service.js';
import {
  addDays,
  asDbDate,
  localDate,
  localHour,
  startOfLocalDay,
} from '../common/dates.js';
import { assertCurrencyPrecision } from '../common/schemas.js';
import { PrismaService } from '../database/prisma.service.js';
import { uuidV5 } from '../database/uuid.js';
import { FxService } from '../finance/fx.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { SuggestionStatus } from '../generated/prisma/enums.js';
import {
  type ContributionResult,
  GoalsService,
} from '../goals/goals.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { type SmartSaveFigures, smartSaveAmount } from './smart-save-math.js';

type Decimal = Prisma.Decimal;
const { Decimal } = Prisma;

/** Local hour when the morning suggestion is prepared and pushed. */
export const MORNING_HOUR = 8;

export type SmartSaveState =
  | 'available'
  | 'already_saved'
  | 'declined'
  | 'no_goal'
  | 'no_spare_money'
  | 'too_small'
  | 'insufficient_balance'
  | 'exchange_rate_unavailable';

/** Why the amount is what it is; shown on the card. Money as strings. */
export interface SmartSaveExplanation {
  baseCurrency: string;
  monthIncome: string;
  monthExpenses: string;
  savedToGoals: string;
  upcomingRecurring: string;
  freeMoney: string;
  daysLeft: number;
  perDay: string;
  sharePercent: number;
  goalCurrency: string | null;
  /** Goal-currency units per base unit, when the currencies differ */
  rate: string | null;
  goalRemaining: string | null;
  accountId: string | null;
  /** Account balance in the goal currency */
  accountBalance: string | null;
  cappedBy: SmartSaveFigures['cappedBy'];
}

export interface SuggestionDto {
  id: string;
  forDate: string;
  status: SuggestionStatus;
  goal: { id: string; title: string; emoji: string };
  /** In the goal's currency */
  amount: string;
  currency: string;
  amountBase: string;
  acceptedAmount: string | null;
  expiresAt: Date;
  explanation: SmartSaveExplanation;
}

export interface TodayResult {
  status: SmartSaveState;
  suggestion: SuggestionDto | null;
  /** Present when there is nothing to suggest but the reason can be shown */
  explanation: SmartSaveExplanation | null;
}

export interface AcceptResult extends ContributionResult {
  suggestion: SuggestionDto;
}

interface Quote {
  status: Exclude<SmartSaveState, 'already_saved' | 'declined'>;
  snapshot: BudgetSnapshot;
  goal: {
    id: string;
    currency_id: number;
    currency: { code: string; decimals: number };
  } | null;
  accountId: string | null;
  rate: Decimal | null;
  figures: SmartSaveFigures | null;
  explanation: SmartSaveExplanation;
}

const suggestionInclude = {
  goal: { select: { id: true, title: true, emoji: true } },
  currency: { select: { code: true, decimals: true } },
} as const;
type SuggestionRow = Prisma.SmartSaveSuggestionsGetPayload<{
  include: typeof suggestionInclude;
}>;

function toDto(row: SuggestionRow): SuggestionDto {
  const money = (value: Decimal) => value.toFixed(row.currency.decimals);
  return {
    id: row.id,
    forDate: row.for_date.toISOString().slice(0, 10),
    status: row.status,
    goal: row.goal,
    amount: money(row.amount),
    currency: row.currency.code,
    amountBase: row.amount_base.toString(),
    acceptedAmount: row.accepted_amount ? money(row.accepted_amount) : null,
    expiresAt: row.expires_at,
    explanation: row.calculation as unknown as SmartSaveExplanation,
  };
}

const conflict = (code: string, message: string, extra: object = {}) =>
  new ConflictException({ code, message, ...extra });

/** Smart Save: one safe amount a day for the primary goal, accepted with a fresh recalculation. */
@Injectable()
export class SmartSaveService {
  private readonly logger = new Logger(SmartSaveService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly budget: BudgetService,
    private readonly goals: GoalsService,
    private readonly fx: FxService,
    private readonly settings: AppSettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Today's suggestion: computed fresh, stored so it can be accepted from the card or a push. */
  async today(userId: string, now = new Date()): Promise<TodayResult> {
    const timezone = await this.timezone(userId);
    const forDate = localDate(now, timezone);
    const existing = await this.prisma.smartSaveSuggestions.findFirst({
      where: { user_id: userId, for_date: asDbDate(forDate) },
      include: suggestionInclude,
      orderBy: [{ status: 'asc' }, { created_at: 'desc' }],
    });
    const decided = await this.prisma.smartSaveSuggestions.findFirst({
      where: {
        user_id: userId,
        for_date: asDbDate(forDate),
        status: { in: ['accepted', 'declined'] },
      },
      include: suggestionInclude,
      orderBy: { decided_at: 'desc' },
    });
    if (decided) {
      return {
        status: decided.status === 'accepted' ? 'already_saved' : 'declined',
        suggestion: toDto(decided),
        explanation: null,
      };
    }

    const quote = await this.quote(userId, now);
    if (quote.status !== 'available') {
      if (existing?.status === 'pending') {
        await this.prisma.smartSaveSuggestions.update({
          where: { id: existing.id },
          data: { status: 'expired' },
        });
      }
      return {
        status: quote.status,
        suggestion: null,
        explanation: quote.explanation,
      };
    }

    const row = await this.store(
      userId,
      forDate,
      timezone,
      quote,
      existing?.status === 'pending' ? existing.id : null,
    );
    return { status: 'available', suggestion: toDto(row), explanation: null };
  }

  /**
   * «Отложить»: recalculated now. A smaller safe amount than asked is not taken silently:
   * the answer is `amount_changed` with the new amount. `amount` may only lower the suggestion.
   */
  async accept(
    userId: string,
    suggestionId: string,
    requested: string | undefined,
    now = new Date(),
  ): Promise<AcceptResult> {
    const row = await this.ownedSuggestion(userId, suggestionId);
    const contributionId = uuidV5(`smart-save:${row.id}`);

    if (row.status === 'accepted') {
      // Already done (e.g. a retried tap): the same contribution id returns the stored result.
      const result = await this.goals.contribute(
        userId,
        row.goal_id,
        {
          id: contributionId,
          type: 'deposit',
          amount: row.accepted_amount!.toString(),
        },
        { method: 'smart_save', smartSaveSuggestionId: row.id },
      );
      return { ...result, suggestion: toDto(row) };
    }
    if (row.status !== 'pending' || row.expires_at <= now) {
      throw conflict(
        'suggestion_expired',
        'This suggestion is no longer valid; open Smart Save again',
      );
    }
    const acceptedToday = await this.prisma.smartSaveSuggestions.count({
      where: { user_id: userId, for_date: row.for_date, status: 'accepted' },
    });
    if (acceptedToday > 0) {
      throw conflict('already_saved', 'Smart Save was already used today');
    }

    let amount = row.amount;
    if (requested !== undefined) {
      assertCurrencyPrecision(requested, row.currency);
      amount = new Decimal(requested);
      if (amount.gt(row.amount)) {
        throw new BadRequestException({
          code: 'amount_too_high',
          message: 'The amount can only be lowered',
        });
      }
    }

    const quote = await this.quote(userId, now);
    if (quote.status !== 'available') {
      throw conflict(quote.status, 'Smart Save is not possible right now', {
        explanation: quote.explanation,
      });
    }
    const timezone = quote.snapshot.timezone;
    if (quote.goal!.id !== row.goal_id) {
      const fresh = await this.store(
        userId,
        quote.snapshot.today,
        timezone,
        quote,
        row.id,
      );
      throw conflict(
        'suggestion_changed',
        'The goal changed; review the new suggestion',
        {
          suggestion: toDto(fresh),
        },
      );
    }
    if (amount.gt(quote.figures!.amount)) {
      const fresh = await this.store(
        userId,
        quote.snapshot.today,
        timezone,
        quote,
        row.id,
      );
      throw conflict('amount_changed', 'The safe amount is lower now', {
        expected: amount.toFixed(row.currency.decimals),
        actual: quote.figures!.amount.toFixed(row.currency.decimals),
        suggestion: toDto(fresh),
      });
    }

    const result = await this.goals.contribute(
      userId,
      row.goal_id,
      {
        id: contributionId,
        type: 'deposit',
        amount: amount.toString(),
        accountId: quote.accountId ?? undefined,
      },
      { method: 'smart_save', smartSaveSuggestionId: row.id },
    );
    await this.prisma.smartSaveSuggestions.updateMany({
      where: { id: row.id, status: 'pending' },
      data: { status: 'accepted', accepted_amount: amount, decided_at: now },
    });
    return {
      ...result,
      suggestion: toDto(await this.ownedSuggestion(userId, row.id)),
    };
  }

  /** «Не сегодня»: no more card or reminder today. */
  async decline(
    userId: string,
    suggestionId: string,
    now = new Date(),
  ): Promise<SuggestionDto> {
    const row = await this.ownedSuggestion(userId, suggestionId);
    if (row.status === 'pending') {
      await this.prisma.smartSaveSuggestions.update({
        where: { id: row.id },
        data: { status: 'declined', decided_at: now },
      });
    }
    return toDto(await this.ownedSuggestion(userId, row.id));
  }

  /** Hourly job: prepares today's suggestion for users whose local time is the morning hour. */
  async prepareMorningSuggestions(
    now = new Date(),
  ): Promise<{ prepared: number }> {
    let prepared = 0;
    let cursor: string | undefined;
    for (;;) {
      const users = await this.prisma.users.findMany({
        where: {
          deleted_at: null,
          userSettings: { smart_save_enabled: true },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true, timezone: true },
        orderBy: { id: 'asc' },
        take: 500,
      });
      if (users.length === 0) break;
      cursor = users.at(-1)!.id;
      for (const user of users) {
        if (localHour(now, user.timezone) !== MORNING_HOUR) continue;
        try {
          const result = await this.today(user.id, now);
          if (result.status === 'available') {
            prepared++;
            await this.notifications.smartSaveReady(
              user.id,
              result.suggestion!,
              now,
            );
          }
        } catch (error) {
          this.logger.error(
            `Smart Save for user ${user.id} failed: ${(error as Error).message}`,
          );
        }
      }
    }
    return { prepared };
  }

  /** Suggestions not answered by the end of their day expire. */
  async expireSuggestions(now = new Date()): Promise<{ expired: number }> {
    const { count } = await this.prisma.smartSaveSuggestions.updateMany({
      where: { status: 'pending', expires_at: { lte: now } },
      data: { status: 'expired' },
    });
    return { expired: count };
  }

  // ---------- Internals ----------

  private async quote(userId: string, now: Date): Promise<Quote> {
    const [snapshot, share, goal, settings] = await Promise.all([
      this.budget.snapshot(userId, now),
      this.settings.get('smart_save_share'),
      // The primary goal first, then by priority; paused and reached goals are skipped.
      this.prisma.goals.findFirst({
        where: { user_id: userId, deleted_at: null, status: 'active' },
        include: { currency: true },
        orderBy: [
          { is_primary: 'desc' },
          { priority: 'asc' },
          { created_at: 'asc' },
        ],
      }),
      this.prisma.userSettings.findUnique({
        where: { user_id: userId },
        select: { defaultAccount: true },
      }),
    ]);

    const base = snapshot.baseCurrency;
    const baseMoney = (value: Decimal) => value.toFixed(base.decimals);
    const explanation: SmartSaveExplanation = {
      baseCurrency: base.code,
      monthIncome: baseMoney(snapshot.incomeActual),
      monthExpenses: baseMoney(snapshot.expensesTotal),
      savedToGoals: baseMoney(snapshot.savedToGoals),
      upcomingRecurring: baseMoney(snapshot.upcomingRecurring),
      freeMoney: baseMoney(
        snapshot.incomeActual
          .minus(snapshot.expensesTotal)
          .minus(snapshot.upcomingRecurring)
          .minus(Decimal.max(0, snapshot.savedToGoals)),
      ),
      daysLeft: snapshot.daysLeft,
      perDay: '0',
      sharePercent: Math.round(share * 100),
      goalCurrency: goal?.currency.code ?? null,
      rate: null,
      goalRemaining: null,
      accountId: null,
      accountBalance: null,
      cappedBy: null,
    };
    const blocked = (status: Quote['status']): Quote => ({
      status,
      snapshot,
      goal,
      accountId: null,
      rate: null,
      figures: null,
      explanation,
    });

    if (!goal) return blocked('no_goal');
    const rate = await this.fx.rate(base.id, goal.currency_id, now);
    if (!rate) return blocked('exchange_rate_unavailable');

    const account = settings?.defaultAccount;
    const usableAccount =
      account && !account.deleted_at && !account.is_archived ? account : null;
    let accountBalance: Decimal | null = null;
    if (usableAccount) {
      const accountRate = await this.fx.rate(
        usableAccount.currency_id,
        goal.currency_id,
        now,
      );
      if (!accountRate) return blocked('exchange_rate_unavailable');
      accountBalance = usableAccount.current_balance.times(accountRate);
    }

    const figures = smartSaveAmount({
      incomeActual: snapshot.incomeActual,
      expensesTotal: snapshot.expensesTotal,
      upcomingRecurring: snapshot.upcomingRecurring,
      savedToGoals: snapshot.savedToGoals,
      daysLeft: snapshot.daysLeft,
      share,
      rate,
      step: goal.currency.rounding_step,
      minimum: goal.currency.min_smart_save,
      goalRemaining: Decimal.max(
        0,
        goal.target_amount.minus(goal.saved_amount),
      ),
      accountBalance,
    });
    const goalMoney = (value: Decimal) => value.toFixed(goal.currency.decimals);
    Object.assign(explanation, {
      freeMoney: baseMoney(figures.freeMoney),
      perDay: baseMoney(figures.perDay),
      rate: goal.currency_id === base.id ? null : rate.toString(),
      goalRemaining: goalMoney(goal.target_amount.minus(goal.saved_amount)),
      accountId: usableAccount?.id ?? null,
      accountBalance: accountBalance ? goalMoney(accountBalance) : null,
      cappedBy: figures.cappedBy,
    });

    return {
      status: figures.block ?? 'available',
      snapshot,
      goal,
      accountId: usableAccount?.id ?? null,
      rate,
      figures,
      explanation,
    };
  }

  /** Creates today's pending suggestion, or refreshes `id` with the new numbers. */
  private async store(
    userId: string,
    forDate: string,
    timezone: string,
    quote: Quote,
    id: string | null,
  ): Promise<SuggestionRow> {
    const goal = quote.goal!;
    const figures = quote.figures!;
    const data = {
      goal_id: goal.id,
      amount: figures.amount,
      amount_base: figures.amount.dividedBy(quote.rate!).toDecimalPlaces(2),
      currency_id: goal.currency_id,
      safe_to_spend_today: quote.snapshot.safeToSpendToday,
      calculation: quote.explanation as unknown as Prisma.InputJsonValue,
      status: 'pending' as const,
      expires_at: startOfLocalDay(addDays(forDate, 1), timezone),
    };
    return id
      ? this.prisma.smartSaveSuggestions.update({
          where: { id },
          data,
          include: suggestionInclude,
        })
      : this.prisma.smartSaveSuggestions.create({
          data: { ...data, user_id: userId, for_date: asDbDate(forDate) },
          include: suggestionInclude,
        });
  }

  private async ownedSuggestion(
    userId: string,
    id: string,
  ): Promise<SuggestionRow> {
    const row = await this.prisma.smartSaveSuggestions.findUnique({
      where: { id },
      include: suggestionInclude,
    });
    if (!row || row.user_id !== userId) {
      throw new NotFoundException({
        code: 'suggestion_not_found',
        message: 'Suggestion not found',
      });
    }
    return row;
  }

  private async timezone(userId: string): Promise<string> {
    const user = await this.prisma.users.findUniqueOrThrow({
      where: { id: userId },
      select: { timezone: true },
    });
    return user.timezone;
  }
}
