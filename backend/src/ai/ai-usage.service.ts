import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { AppSettingsService } from '../common/app-settings.service.js';
import { asDbDate, type CalendarDate } from '../common/dates.js';
import { PrismaService } from '../database/prisma.service.js';
import type { AiFeature } from '../generated/prisma/enums.js';
import {
  AI_FEATURES,
  PRO_FEATURE_OF,
  dailyLimit,
  usageDay,
} from './ai-limits.js';

export interface FeatureUsage {
  feature: AiFeature;
  used: number;
  /** null: no cap */
  limit: number | null;
  remaining: number | null;
}

export interface UsageStatus {
  /** The user's day, `YYYY-MM-DD` */
  date: CalendarDate;
  /** When the counters start again: the user's next midnight */
  resetsAt: Date;
  features: FeatureUsage[];
}

/** A request counted against today's limit; committed with its tokens or released. */
export interface Reservation {
  userId: string;
  feature: AiFeature;
  date: CalendarDate;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Counts AI requests and tokens per user, day (the user's time zone) and feature in
 * `ai_usage_daily`, and holds users to the day's limits. A request takes its place before
 * the model is called, atomically, so parallel requests cannot pass the limit; a request
 * that fails gives its place back (spec: «неудачный запрос не списывается с лимита»).
 */
@Injectable()
export class AiUsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AppSettingsService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async status(userId: string, now = new Date()): Promise<UsageStatus> {
    const [timeZone, access, settings] = await Promise.all([
      this.timeZone(userId),
      this.entitlements.getAccess(userId, now),
      this.settings.getAll(),
    ]);
    const { date, resetsAt } = usageDay(now, timeZone);
    const rows = await this.prisma.aiUsageDaily.findMany({
      where: { user_id: userId, usage_date: asDbDate(date) },
    });
    const used = new Map(rows.map((row) => [row.feature, row.requests]));
    return {
      date,
      resetsAt,
      features: AI_FEATURES.map((feature) => {
        const limit = dailyLimit(feature, access, settings);
        const count = used.get(feature) ?? 0;
        return {
          feature,
          used: count,
          limit,
          remaining: limit === null ? null : Math.max(0, limit - count),
        };
      }),
    };
  }

  /**
   * Takes one of today's requests: Pro features need Pro (`pro_required`), and a full day
   * answers 429 `ai_limit_reached` with the limit and when it resets.
   */
  async reserve(
    userId: string,
    feature: AiFeature,
    now = new Date(),
  ): Promise<Reservation> {
    const proFeature = PRO_FEATURE_OF[feature];
    if (proFeature) await this.entitlements.assertFeature(userId, proFeature);
    const [timeZone, access, settings] = await Promise.all([
      this.timeZone(userId),
      this.entitlements.getAccess(userId, now),
      this.settings.getAll(),
    ]);
    const { date, resetsAt } = usageDay(now, timeZone);
    const limit = dailyLimit(feature, access, settings);
    const day = asDbDate(date);

    if (limit === null) {
      await this.prisma.aiUsageDaily.upsert({
        where: {
          user_id_usage_date_feature: {
            user_id: userId,
            usage_date: day,
            feature,
          },
        },
        create: { user_id: userId, usage_date: day, feature, requests: 1 },
        update: { requests: { increment: 1 } },
      });
      return { userId, feature, date };
    }

    // One statement: the place is taken only while the day has one, whatever runs alongside.
    const taken = await this.prisma.$queryRaw<{ requests: number }[]>`
      INSERT INTO ai_usage_daily (user_id, usage_date, feature, requests)
      SELECT ${userId}::uuid, ${date}::date, ${feature}::ai_feature, 1
      WHERE ${limit}::int > 0
      ON CONFLICT (user_id, usage_date, feature)
      DO UPDATE SET requests = ai_usage_daily.requests + 1
      WHERE ai_usage_daily.requests < ${limit}::int
      RETURNING requests`;
    if (taken.length === 0) {
      throw new HttpException(
        {
          code: 'ai_limit_reached',
          message: 'The daily AI limit is reached',
          feature,
          limit,
          used: limit,
          resetsAt: resetsAt.toISOString(),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return { userId, feature, date };
  }

  /** The request succeeded: its tokens are added to the day. */
  async commit(reservation: Reservation, usage: TokenUsage): Promise<void> {
    await this.prisma.aiUsageDaily.update({
      where: this.key(reservation),
      data: {
        input_tokens: { increment: Math.max(0, Math.round(usage.inputTokens)) },
        output_tokens: {
          increment: Math.max(0, Math.round(usage.outputTokens)),
        },
      },
    });
  }

  /** The request failed: its place goes back, and the failure is counted for monitoring. */
  async release(reservation: Reservation): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE ai_usage_daily SET requests = GREATEST(requests - 1, 0), failed = failed + 1
      WHERE user_id = ${reservation.userId}::uuid
        AND usage_date = ${reservation.date}::date
        AND feature = ${reservation.feature}::ai_feature`;
  }

  /** Reserves, runs `call`, then commits its tokens, or releases the place when it throws. */
  async run<T extends { usage: TokenUsage }>(
    userId: string,
    feature: AiFeature,
    call: () => Promise<T>,
    now = new Date(),
  ): Promise<T> {
    const reservation = await this.reserve(userId, feature, now);
    let result: T;
    try {
      result = await call();
    } catch (error) {
      await this.release(reservation);
      throw error;
    }
    await this.commit(reservation, result.usage);
    return result;
  }

  private key(reservation: Reservation) {
    return {
      user_id_usage_date_feature: {
        user_id: reservation.userId,
        usage_date: asDbDate(reservation.date),
        feature: reservation.feature,
      },
    };
  }

  private async timeZone(userId: string): Promise<string> {
    const user = await this.prisma.users.findUniqueOrThrow({
      where: { id: userId },
      select: { timezone: true },
    });
    return user.timezone;
  }
}
