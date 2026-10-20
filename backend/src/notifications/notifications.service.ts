import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { addDays, localDate, startOfLocalDay } from '../common/dates.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Notifications, Prisma } from '../generated/prisma/client.js';
import type {
  LanguageCode,
  NotificationType,
} from '../generated/prisma/enums.js';
import type { GoalDto } from '../goals/goals.service.js';
import {
  CATEGORY_OF,
  decide,
  INBOX_SKIPS,
  minutesOf,
  REQUESTED,
  RETRY_DELAY_MS,
  SETTING_OF,
  type SkipReason,
} from './notification-rules.js';
import {
  type CurrencyInfo,
  goalMilestone,
  money,
  type PushText,
  smartSave,
} from './notification-texts.js';
import {
  BUDGET_CHECK_DELAY_MS,
  NOTIFICATIONS_QUEUE,
  NotificationJob,
} from './notifications.constants.js';
import { PushSender } from './push-sender.js';

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  /** One push per event: the same key again is ignored */
  dedupeKey: string;
  text: PushText;
  /** `link` opens the screen on tap; the rest is what the actions need */
  data: { link: string } & Record<string, unknown>;
  /** Not sent after this: a stale reminder is noise */
  expiresAt: Date;
  scheduledAt?: Date;
}

export interface NotificationDto {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  link: string;
  data: Record<string, unknown>;
  createdAt: Date;
  openedAt: Date | null;
}

export interface NotificationPage {
  items: NotificationDto[];
  /** Not opened yet, for the dot on the bell */
  unread: number;
  /** Pass as `before` for older ones; null at the end */
  nextBefore: string | null;
}

export type DeliveryOutcome =
  'sent' | 'deferred' | 'retry' | 'busy' | `skipped:${SkipReason}`;

/** What Smart Save hands over when the morning suggestion is ready. */
export interface SmartSaveNotice {
  id: string;
  forDate: string;
  amount: string;
  currency: string;
  /** In the base currency, shown beside a goal's other currency */
  amountBase: string;
  baseCurrency: string;
  expiresAt: Date;
  goal: { id: string; title: string; emoji: string };
}

/** Pushes that went out, and those kept back only by the limit or quiet hours. */
const inbox = (userId: string) => ({
  user_id: userId,
  OR: [
    { status: 'sent' as const },
    { status: 'skipped' as const, skip_reason: { in: INBOX_SKIPS } },
  ],
});

function toDto(row: Notifications): NotificationDto {
  const { link, ...data } = (row.payload ?? {}) as { link?: string };
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    link: link ?? 'lunex://home',
    data,
    createdAt: row.sent_at ?? row.created_at,
    openedAt: row.opened_at,
  };
}

/**
 * Push notifications: each event is stored once (by `dedupe_key`), then sent to the user's
 * devices by the rules — the kind switched on, quiet hours, at most 3 a day, still relevant.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private currencies?: Promise<Map<string, CurrencyInfo>>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: PushSender,
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue,
  ) {}

  // ---------- Creating ----------

  /** Stores the event and sends it when due; null when this event was already told. */
  async notify(input: NotifyInput, now = new Date()): Promise<string | null> {
    const id = randomUUID();
    const scheduledAt = input.scheduledAt ?? now;
    const { count } = await this.prisma.notifications.createMany({
      data: [
        {
          id,
          user_id: input.userId,
          type: input.type,
          title: input.text.title,
          body: input.text.body,
          payload: input.data as Prisma.InputJsonObject,
          dedupe_key: input.dedupeKey,
          scheduled_at: scheduledAt,
          expires_at: input.expiresAt,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 0) return null;
    if (scheduledAt <= now) {
      // The 5-minute sweep sends it anyway if the queue is unreachable now.
      await this.queue
        .add(NotificationJob.Deliver, { id }, { jobId: `deliver-${id}` })
        .catch((error: Error) =>
          this.logger.warn(`Delivery of ${id} not queued: ${error.message}`),
        );
    }
    return id;
  }

  /** Spending changed: limits are checked a moment later, once for a burst of operations. */
  expensesChanged(userId: string): void {
    this.queue
      .add(
        NotificationJob.BudgetCheck,
        { userId },
        {
          delay: BUDGET_CHECK_DELAY_MS,
          deduplication: { id: `budget-${userId}`, keepLastIfActive: true },
        },
      )
      .catch((error: Error) =>
        this.logger.warn(`Budget check not queued: ${error.message}`),
      );
  }

  /** 25 / 50 / 75 / 100 % reached: one push for the highest, once per milestone. */
  async goalMilestone(
    userId: string,
    goal: GoalDto,
    milestones: number[],
    now = new Date(),
  ): Promise<void> {
    if (milestones.length === 0) return;
    const percent = Math.max(...milestones);
    const { language } = await this.recipient(userId);
    const currency = await this.currency(goal.currency);
    await this.notify(
      {
        userId,
        type: 'goal_milestone',
        dedupeKey: `goal_milestone:${goal.id}:${percent}`,
        text: goalMilestone(
          {
            goal: goal.title,
            emoji: goal.emoji,
            percent,
            saved: money(goal.savedAmount, currency, language),
            target: money(goal.targetAmount, currency, language),
          },
          language,
        ),
        data: { link: `lunex://goals/${goal.id}`, goalId: goal.id, percent },
        expiresAt: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000),
      },
      now,
    );
  }

  /** The morning Smart Save, with «Отложить» right in the push. */
  async smartSaveReady(
    userId: string,
    suggestion: SmartSaveNotice,
    now = new Date(),
  ): Promise<void> {
    const { language } = await this.recipient(userId);
    const currency = await this.currency(suggestion.currency);
    let amount = money(suggestion.amount, currency, language);
    if (suggestion.baseCurrency !== suggestion.currency) {
      // A goal in another currency: the sum of the day's rate beside it.
      const base = await this.currency(suggestion.baseCurrency);
      amount += ` (${money(suggestion.amountBase, base, language)})`;
    }
    await this.notify(
      {
        userId,
        type: 'smart_save',
        dedupeKey: `smart_save:${userId}:${suggestion.forDate}`,
        text: smartSave(
          {
            amount,
            goal: suggestion.goal.title,
            emoji: suggestion.goal.emoji,
          },
          language,
        ),
        data: {
          link: 'lunex://smart-save',
          suggestionId: suggestion.id,
          goalId: suggestion.goal.id,
          amount: suggestion.amount,
          currency: suggestion.currency,
        },
        expiresAt: suggestion.expiresAt,
      },
      now,
    );
  }

  // ---------- Sending ----------

  /** Sends one notification if it is due, by the rules; safe to call twice. */
  async deliver(id: string, now = new Date()): Promise<DeliveryOutcome> {
    // Claimed by marking it sent; a second worker finds nothing to claim.
    const claimed = await this.prisma.notifications.updateMany({
      where: { id, status: 'pending', scheduled_at: { lte: now } },
      data: { status: 'sent', sent_at: now },
    });
    if (claimed.count === 0) return 'busy';
    const row = await this.prisma.notifications.findUniqueOrThrow({
      where: { id },
      include: {
        user: {
          select: { deleted_at: true, timezone: true, userSettings: true },
        },
      },
    });
    if (row.user.deleted_at) return this.skip(id, 'user_deleted');

    const settings = row.user.userSettings;
    const timezone = row.user.timezone;
    const setting = SETTING_OF[row.type];
    const enabled = setting === null || (settings?.[setting] ?? true);
    const open = enabled && now < row.expires_at;
    const decision = decide({
      now,
      timezone,
      type: row.type,
      expiresAt: row.expires_at,
      enabled,
      relevant: open ? await this.relevant(row, timezone) : true,
      quiet: settings
        ? {
            start: minutesOf(settings.quiet_hours_start),
            end: minutesOf(settings.quiet_hours_end),
          }
        : { start: 22 * 60, end: 8 * 60 },
      sentToday:
        open && !REQUESTED.has(row.type)
          ? await this.prisma.notifications.count({
              where: {
                user_id: row.user_id,
                id: { not: id },
                status: 'sent',
                type: { notIn: [...REQUESTED] },
                sent_at: {
                  gte: startOfLocalDay(localDate(now, timezone), timezone),
                },
              },
            })
          : 0,
    });

    if (decision.action === 'skip') return this.skip(id, decision.reason);
    if (decision.action === 'defer') {
      await this.prisma.notifications.update({
        where: { id },
        data: {
          status: 'pending',
          sent_at: null,
          scheduled_at: decision.until,
        },
      });
      return 'deferred';
    }
    return this.push(row, now);
  }

  /** The 5-minute sweep: what was deferred, retried or missed by the queue. */
  async deliverDue(
    now = new Date(),
  ): Promise<{ delivered: number; pending: number }> {
    const due = await this.prisma.notifications.findMany({
      where: { status: 'pending', scheduled_at: { lte: now } },
      select: { id: true },
      orderBy: { scheduled_at: 'asc' },
      take: 500,
    });
    let delivered = 0;
    for (const { id } of due) {
      try {
        if ((await this.deliver(id, now)) === 'sent') delivered++;
      } catch (error) {
        this.logger.error(
          `Notification ${id} failed: ${(error as Error).message}`,
        );
      }
    }
    return { delivered, pending: due.length - delivered };
  }

  // ---------- Notification center ----------

  async list(
    userId: string,
    before?: Date,
    limit = 30,
  ): Promise<NotificationPage> {
    const where = inbox(userId);
    const [rows, unread] = await Promise.all([
      this.prisma.notifications.findMany({
        where: { ...where, ...(before ? { created_at: { lt: before } } : {}) },
        orderBy: { created_at: 'desc' },
        take: limit + 1,
      }),
      this.prisma.notifications.count({
        where: { ...where, opened_at: null },
      }),
    ]);
    const items = rows.slice(0, limit);
    return {
      items: items.map(toDto),
      unread,
      nextBefore:
        rows.length > limit ? items.at(-1)!.created_at.toISOString() : null,
    };
  }

  /** Tapped in the system or the center; repeating it changes nothing. */
  async markOpened(userId: string, id: string, now = new Date()) {
    await this.prisma.notifications.updateMany({
      where: { id, user_id: userId, opened_at: null },
      data: { opened_at: now },
    });
  }

  /** The center was looked at: nothing is new any more. */
  async markAllOpened(userId: string, now = new Date()) {
    await this.prisma.notifications.updateMany({
      where: { ...inbox(userId), opened_at: null },
      data: { opened_at: now },
    });
  }

  // ---------- Internals ----------

  async currency(code: string): Promise<CurrencyInfo> {
    this.currencies ??= this.prisma.currencies
      .findMany({ select: { code: true, decimals: true, symbol: true } })
      .then((rows) => new Map(rows.map((row) => [row.code, row])));
    return (
      (await this.currencies).get(code) ?? { code, decimals: 2, symbol: code }
    );
  }

  async recipient(
    userId: string,
  ): Promise<{ language: LanguageCode; timezone: string }> {
    return this.prisma.users.findUniqueOrThrow({
      where: { id: userId },
      select: { language: true, timezone: true },
    });
  }

  private async push(row: Notifications, now: Date): Promise<DeliveryOutcome> {
    const devices = await this.prisma.devices.findMany({
      where: {
        user_id: row.user_id,
        push_enabled: true,
        apns_token: { not: null },
      },
      select: { apns_token: true },
    });
    if (devices.length === 0) return this.skip(row.id, 'no_device');

    const category = CATEGORY_OF[row.type];
    const payload = {
      aps: {
        alert: { title: row.title, body: row.body },
        sound: 'default',
        'thread-id': row.type,
        ...(category ? { category } : {}),
      },
      lunex: { id: row.id, type: row.type, ...(row.payload as object) },
    };
    const results = await Promise.all(
      devices.map(({ apns_token }) =>
        this.sender
          .send({ token: apns_token!, payload, expiresAt: row.expires_at })
          .catch((error: Error) => ({
            status: 'retry' as const,
            reason: error.message,
          })),
      ),
    );

    const dead = devices
      .filter((_, index) => results[index].status === 'invalid_token')
      .map((device) => device.apns_token!);
    if (dead.length > 0) {
      // The app was deleted or reinstalled: this token never works again.
      await this.prisma.devices.updateMany({
        where: { apns_token: { in: dead } },
        data: { apns_token: null, push_enabled: false },
      });
    }
    if (results.some((result) => result.status === 'ok')) return 'sent';
    if (dead.length === devices.length) return this.skip(row.id, 'no_device');

    const reasons = results
      .map((result) => ('reason' in result ? result.reason : ''))
      .join(', ');
    this.logger.warn(`Push ${row.id} not delivered: ${reasons}`);
    const retryAt = new Date(now.getTime() + RETRY_DELAY_MS);
    if (retryAt >= row.expires_at) return this.skip(row.id, 'expired');
    await this.prisma.notifications.update({
      where: { id: row.id },
      data: { status: 'pending', sent_at: null, scheduled_at: retryAt },
    });
    return 'retry';
  }

  private async skip(id: string, reason: SkipReason): Promise<DeliveryOutcome> {
    await this.prisma.notifications.update({
      where: { id },
      data: { status: 'skipped', skip_reason: reason, sent_at: null },
    });
    return `skipped:${reason}`;
  }

  /** Whether the push still says something true at the moment it would go out. */
  private async relevant(
    row: Notifications,
    timezone: string,
  ): Promise<boolean> {
    const data = (row.payload ?? {}) as Record<string, string | undefined>;
    switch (row.type) {
      case 'daily_reminder': {
        // Nothing to remind about once the day has operations.
        const date = data.date!;
        const count = await this.prisma.transactions.count({
          where: {
            user_id: row.user_id,
            deleted_at: null,
            occurred_at: {
              gte: startOfLocalDay(date, timezone),
              lt: startOfLocalDay(addDays(date, 1), timezone),
            },
          },
        });
        return count === 0;
      }
      case 'smart_save': {
        const suggestion = await this.prisma.smartSaveSuggestions.findUnique({
          where: { id: data.suggestionId },
          select: { status: true },
        });
        return suggestion?.status === 'pending';
      }
      case 'recurring_due': {
        // Recorded or skipped in the meantime: the next run date moved on.
        const rule = await this.prisma.recurringRules.findUnique({
          where: { id: data.ruleId },
          select: { is_active: true, deleted_at: true, next_run_on: true },
        });
        return (
          !!rule &&
          rule.is_active &&
          !rule.deleted_at &&
          rule.next_run_on.toISOString().slice(0, 10) === data.date
        );
      }
      case 'goal_milestone':
      case 'goal_deadline': {
        const goal = await this.prisma.goals.findUnique({
          where: { id: data.goalId },
          select: { deleted_at: true, status: true },
        });
        return (
          !!goal &&
          !goal.deleted_at &&
          (row.type === 'goal_milestone' || goal.status === 'active')
        );
      }
      default:
        return true;
    }
  }
}
