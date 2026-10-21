import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { AttachmentStorage } from '../storage/attachment-storage.js';
import type { ZipEntry } from './zip.js';

/** Columns that hold a calendar day, written as `2026-10-21` */
const DAY_COLUMNS = new Set([
  'period_start',
  'period_end',
  'deadline',
  'for_date',
  'start_on',
  'end_on',
  'next_run_on',
  'usage_date',
]);
/** Columns that hold a time of day, written as `21:00` */
const TIME_COLUMNS = new Set([
  'daily_reminder_time',
  'quiet_hours_start',
  'quiet_hours_end',
]);

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

type Plain =
  string | number | boolean | null | Plain[] | { [key: string]: Plain };

/**
 * Everything the server keeps about a user, for «Экспорт всех своих данных»: `data.json` with
 * the profile, settings, money, goals, budgets, AI and notifications — records deleted by the
 * user but still kept carry `deletedAt` — and the photos of receipts under `receipts/`.
 * Secrets stay out: refresh tokens, sign-in codes, push tokens, Apple's signed payloads.
 */
@Injectable()
export class DataExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: AttachmentStorage,
  ) {}

  /**
   * The entries of the archive. The data is read before this returns, so a refusal comes
   * before any byte is sent; the photos are read one by one while the archive goes out.
   */
  async entries(
    userId: string,
    now = new Date(),
  ): Promise<AsyncGenerator<ZipEntry>> {
    const data = await this.collect(userId, now);
    const storage = this.storage;
    return (async function* () {
      yield {
        name: 'data.json',
        data: Buffer.from(JSON.stringify(data.json, null, 2)),
        compress: true,
      };
      for (const attachment of data.attachments) {
        const photo = await storage.get(storage.key(userId, attachment.id));
        if (photo) yield { name: attachment.file, data: photo };
      }
    })();
  }

  private async collect(
    userId: string,
    now: Date,
  ): Promise<{
    json: Record<string, Plain>;
    attachments: { id: string; file: string }[];
  }> {
    const user = await this.prisma.users.findUnique({ where: { id: userId } });
    if (!user || user.deleted_at) {
      throw new NotFoundException({
        code: 'user_not_found',
        message: 'No such user',
      });
    }
    const mine = { where: { user_id: userId } };
    const [
      currencies,
      settings,
      identities,
      devices,
      accounts,
      ownCategories,
      systemCategories,
      categoryPreferences,
      transactions,
      attachments,
      recurringRules,
      budgets,
      goals,
      goalContributions,
      goalMilestones,
      autoSaveRules,
      smartSave,
      insights,
      conversations,
      notifications,
      subscriptions,
      aiUsage,
    ] = await Promise.all([
      this.prisma.currencies.findMany({ select: { id: true, code: true } }),
      this.prisma.userSettings.findUnique({ where: { user_id: userId } }),
      this.prisma.authIdentities.findMany({
        ...mine,
        select: {
          provider: true,
          email: true,
          created_at: true,
          last_used_at: true,
        },
        orderBy: { created_at: 'asc' },
      }),
      this.prisma.devices.findMany({
        ...mine,
        omit: { apns_token: true },
        orderBy: { created_at: 'asc' },
      }),
      this.prisma.accounts.findMany({
        ...mine,
        orderBy: { sort_order: 'asc' },
      }),
      this.prisma.categories.findMany({
        ...mine,
        orderBy: [{ type: 'desc' }, { sort_order: 'asc' }],
      }),
      this.prisma.categories.findMany({
        where: { user_id: null },
        include: { categoryTranslations: true },
        orderBy: [{ type: 'desc' }, { sort_order: 'asc' }],
      }),
      this.prisma.categoryPreferences.findMany(mine),
      this.prisma.transactions.findMany({
        ...mine,
        orderBy: { occurred_at: 'asc' },
      }),
      this.prisma.transactionAttachments.findMany({
        ...mine,
        omit: { storage_key: true },
        orderBy: { created_at: 'asc' },
      }),
      this.prisma.recurringRules.findMany({
        ...mine,
        orderBy: { created_at: 'asc' },
      }),
      this.prisma.budgets.findMany({
        ...mine,
        include: { budgetCategoryLimits: true },
        orderBy: { period_start: 'asc' },
      }),
      this.prisma.goals.findMany({ ...mine, orderBy: { priority: 'asc' } }),
      this.prisma.goalContributions.findMany({
        ...mine,
        orderBy: { created_at: 'asc' },
      }),
      this.prisma.goalMilestones.findMany({
        where: { goal: { user_id: userId } },
        orderBy: { reached_at: 'asc' },
      }),
      this.prisma.autoSaveRules.findMany({
        ...mine,
        orderBy: { created_at: 'asc' },
      }),
      this.prisma.smartSaveSuggestions.findMany({
        ...mine,
        orderBy: { for_date: 'asc' },
      }),
      this.prisma.aiInsights.findMany({
        ...mine,
        orderBy: { created_at: 'asc' },
      }),
      this.prisma.aiConversations.findMany({
        ...mine,
        include: { aiMessages: { orderBy: { created_at: 'asc' } } },
        orderBy: { created_at: 'asc' },
      }),
      this.prisma.notifications.findMany({
        ...mine,
        orderBy: { created_at: 'asc' },
      }),
      this.prisma.subscriptions.findMany({
        ...mine,
        orderBy: { started_at: 'asc' },
      }),
      this.prisma.aiUsageDaily.findMany({
        ...mine,
        orderBy: [{ usage_date: 'asc' }, { feature: 'asc' }],
      }),
    ]);

    const codes = new Map(currencies.map((c) => [c.id, c.code]));
    const plain = (value: unknown): Plain => toPlain(value, codes);
    const files = attachments.map((a) => ({
      id: a.id,
      file: `receipts/${a.id}.${EXTENSIONS[a.mime_type] ?? 'bin'}`,
    }));

    const json: Record<string, Plain> = {
      format: 'lunex-export',
      version: 1,
      exportedAt: now.toISOString(),
      user: plain({
        id: user.id,
        display_name: user.display_name,
        email: user.email,
        email_verified_at: user.email_verified_at,
        language: user.language,
        base_currency_id: user.base_currency_id,
        timezone: user.timezone,
        onboarding_focus: user.onboarding_focus,
        monthly_income_estimate: user.monthly_income_estimate,
        onboarding_completed_at: user.onboarding_completed_at,
        created_at: user.created_at,
        updated_at: user.updated_at,
      }),
      settings: plain(settings),
      signInMethods: plain(identities),
      devices: plain(devices),
      accounts: plain(accounts),
      categories: plain(ownCategories),
      systemCategories: systemCategories.map((category) => ({
        id: category.id,
        type: category.type,
        key: category.key,
        icon: category.icon,
        color: category.color,
        labels: Object.fromEntries(
          category.categoryTranslations.map((t) => [t.language, t.label]),
        ),
      })),
      categoryPreferences: plain(categoryPreferences),
      transactions: plain(transactions),
      attachments: attachments.map((attachment, index) => ({
        ...(plain(attachment) as Record<string, Plain>),
        file: files[index].file,
      })),
      recurringRules: plain(recurringRules),
      budgets: plain(
        budgets.map(({ budgetCategoryLimits, ...budget }) => ({
          ...budget,
          category_limits: budgetCategoryLimits,
        })),
      ),
      goals: plain(goals),
      goalContributions: plain(goalContributions),
      goalMilestones: plain(goalMilestones),
      autoSaveRules: plain(autoSaveRules),
      smartSaveSuggestions: plain(smartSave),
      insights: plain(insights),
      assistantConversations: plain(
        conversations.map(({ aiMessages, ...conversation }) => ({
          ...conversation,
          messages: aiMessages,
        })),
      ),
      notifications: plain(notifications),
      subscriptions: plain(subscriptions),
      aiUsage: plain(aiUsage),
    };
    return { json, attachments: files };
  }
}

/**
 * A database row as JSON: camelCase names, money as exact strings, currencies by code, days
 * and times without a time zone; the user's own id is left out, every row is theirs.
 */
export function toPlain(value: unknown, codes: Map<number, string>): Plain {
  if (value === null || value === undefined) return null;
  if (value instanceof Prisma.Decimal) return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((item) => toPlain(item, codes));
  if (typeof value === 'object') {
    const result: Record<string, Plain> = {};
    for (const [key, field] of Object.entries(value)) {
      if (key === 'user_id') continue;
      if (key.endsWith('currency_id') && typeof field === 'number') {
        result[camel(key.slice(0, -3))] = codes.get(field) ?? String(field);
      } else if (DAY_COLUMNS.has(key) && field instanceof Date) {
        result[camel(key)] = field.toISOString().slice(0, 10);
      } else if (TIME_COLUMNS.has(key) && field instanceof Date) {
        result[camel(key)] = field.toISOString().slice(11, 16);
      } else {
        result[camel(key)] = toPlain(field, codes);
      }
    }
    return result;
  }
  return value as Plain;
}

function camel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}
