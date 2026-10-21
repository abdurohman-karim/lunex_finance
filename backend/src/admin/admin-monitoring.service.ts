import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { AUTO_SAVE_QUEUE } from '../auto-save/auto-save.queue.js';
import { addDays, type CalendarDate } from '../common/dates.js';
import { PrismaService } from '../database/prisma.service.js';
import { INSIGHTS_QUEUE } from '../insights/insights.queue.js';
import { NOTIFICATIONS_QUEUE } from '../notifications/notifications.constants.js';
import { MAINTENANCE_QUEUE } from '../queue/queue.constants.js';

/** Days of AI use the panel shows */
const AI_DAYS = 14;

export interface QueueStatus {
  name: string;
  counts: Record<string, number>;
  /** Repeating jobs: what runs and when next */
  schedules: { name: string; pattern: string | null; next: Date | null }[];
  failed: {
    name: string;
    reason: string;
    at: Date | null;
    attempts: number;
  }[];
}

export interface Monitoring {
  users: { total: number; newThisWeek: number; deletedPending: number };
  subscriptions: {
    trialsActive: number;
    trialsEnded: number;
    appStore: Record<string, number>;
    promoActive: number;
  };
  storeEvents: {
    lastDay: number;
    failing: { type: string; error: string; at: Date }[];
  };
  ai: {
    days: {
      date: CalendarDate;
      feature: string;
      requests: number;
      inputTokens: number;
      outputTokens: number;
      failed: number;
    }[];
  };
  queues: QueueStatus[];
}

/**
 * What the server is doing (spec: «Мониторинг»): the background jobs, AI use and its failures
 * by day and feature, subscriptions and trials, App Store notifications that did not apply.
 */
@Injectable()
export class AdminMonitoringService {
  private readonly queues: Queue[];

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(MAINTENANCE_QUEUE) maintenance: Queue,
    @InjectQueue(NOTIFICATIONS_QUEUE) notifications: Queue,
    @InjectQueue(INSIGHTS_QUEUE) insights: Queue,
    @InjectQueue(AUTO_SAVE_QUEUE) autoSave: Queue,
  ) {
    this.queues = [maintenance, notifications, insights, autoSave];
  }

  async overview(now = new Date()): Promise<Monitoring> {
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const firstDay = addDays(now.toISOString().slice(0, 10), -(AI_DAYS - 1));
    const [
      total,
      newThisWeek,
      deletedPending,
      trialsActive,
      trialsEnded,
      appStore,
      promoActive,
      lastDay,
      failing,
      ai,
      queues,
    ] = await Promise.all([
      this.prisma.users.count({ where: { deleted_at: null } }),
      this.prisma.users.count({
        where: { deleted_at: null, created_at: { gte: weekAgo } },
      }),
      this.prisma.users.count({ where: { deleted_at: { not: null } } }),
      this.prisma.subscriptions.count({
        where: { source: 'trial', status: 'active', expires_at: { gt: now } },
      }),
      this.prisma.subscriptions.count({
        where: {
          source: 'trial',
          OR: [{ status: { not: 'active' } }, { expires_at: { lte: now } }],
        },
      }),
      this.prisma.subscriptions.groupBy({
        by: ['status'],
        where: { source: 'app_store' },
        _count: { _all: true },
      }),
      this.prisma.subscriptions.count({
        where: { source: 'promo', status: 'active', expires_at: { gt: now } },
      }),
      this.prisma.storeEvents.count({ where: { created_at: { gte: dayAgo } } }),
      this.prisma.storeEvents.findMany({
        where: { processed_at: null, error: { not: null } },
        orderBy: { created_at: 'desc' },
        take: 5,
      }),
      this.prisma.aiUsageDaily.groupBy({
        by: ['usage_date', 'feature'],
        where: { usage_date: { gte: new Date(`${firstDay}T00:00:00Z`) } },
        _sum: {
          requests: true,
          input_tokens: true,
          output_tokens: true,
          failed: true,
        },
        orderBy: [{ usage_date: 'desc' }, { feature: 'asc' }],
      }),
      Promise.all(this.queues.map((queue) => this.queueStatus(queue))),
    ]);
    return {
      users: { total, newThisWeek, deletedPending },
      subscriptions: {
        trialsActive,
        trialsEnded,
        appStore: Object.fromEntries(
          appStore.map((row) => [row.status, row._count._all]),
        ),
        promoActive,
      },
      storeEvents: {
        lastDay,
        failing: failing.map((event) => ({
          type: event.notification_type,
          error: event.error ?? '',
          at: event.created_at,
        })),
      },
      ai: {
        days: ai.map((row) => ({
          date: row.usage_date.toISOString().slice(0, 10),
          feature: row.feature,
          requests: row._sum.requests ?? 0,
          inputTokens: row._sum.input_tokens ?? 0,
          outputTokens: row._sum.output_tokens ?? 0,
          failed: row._sum.failed ?? 0,
        })),
      },
      queues,
    };
  }

  private async queueStatus(queue: Queue): Promise<QueueStatus> {
    const [counts, schedulers, failed] = await Promise.all([
      queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
      queue.getJobSchedulers(0, 50, true),
      queue.getFailed(0, 4),
    ]);
    return {
      name: queue.name,
      counts,
      schedules: schedulers.map((scheduler) => ({
        name: scheduler.name,
        pattern:
          scheduler.pattern ??
          (scheduler.every ? `every ${scheduler.every} ms` : null),
        next: scheduler.next ? new Date(scheduler.next) : null,
      })),
      failed: failed.map((job) => ({
        name: job.name,
        reason: (job.failedReason ?? '').slice(0, 300),
        at: job.finishedOn ? new Date(job.finishedOn) : null,
        attempts: job.attemptsMade,
      })),
    };
  }
}
