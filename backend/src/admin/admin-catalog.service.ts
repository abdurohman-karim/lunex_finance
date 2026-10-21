import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { systemCategoryId } from '../database/reference-data.js';
import type { LanguageCode } from '../generated/prisma/enums.js';
import type {
  CategoryCreate,
  CategoryPatch,
  CurrencyPatch,
} from './admin.schemas.js';
import { AuditService } from './audit.service.js';

export interface CurrencyDto {
  code: string;
  name: string;
  symbol: string;
  decimals: number;
  roundingStep: string;
  minSmartSave: string;
  isActive: boolean;
  sortOrder: number;
}

export interface SystemCategoryDto {
  id: string;
  type: 'expense' | 'income';
  key: string | null;
  icon: string;
  color: string;
  sortOrder: number;
  isArchived: boolean;
  labels: Record<LanguageCode, string>;
  updatedAt: Date;
}

const LANGUAGES: LanguageCode[] = ['uz', 'ru', 'en'];

/**
 * Reference data (spec: «Справочники»): currencies with the Smart Save step and minimum, and
 * the system categories with their names in three languages. A category's change bumps its
 * `updated_at`, so every device gets it with the next sync.
 */
@Injectable()
export class AdminCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async currencies(): Promise<CurrencyDto[]> {
    const rows = await this.prisma.currencies.findMany({
      orderBy: [{ sort_order: 'asc' }, { code: 'asc' }],
    });
    return rows.map((row) => ({
      code: row.code,
      name: row.name,
      symbol: row.symbol,
      decimals: row.decimals,
      roundingStep: row.rounding_step.toString(),
      minSmartSave: row.min_smart_save.toString(),
      isActive: row.is_active,
      sortOrder: row.sort_order,
    }));
  }

  async updateCurrency(
    adminId: string,
    code: string,
    patch: CurrencyPatch,
  ): Promise<CurrencyDto[]> {
    const existing = await this.prisma.currencies.findUnique({
      where: { code: code.toUpperCase() },
    });
    if (!existing) {
      throw new NotFoundException({
        code: 'currency_not_found',
        message: `No currency ${code}`,
      });
    }
    const before = {
      name: existing.name,
      symbol: existing.symbol,
      roundingStep: existing.rounding_step.toString(),
      minSmartSave: existing.min_smart_save.toString(),
      isActive: existing.is_active,
      sortOrder: existing.sort_order,
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.currencies.update({
        where: { id: existing.id },
        data: {
          name: patch.name,
          symbol: patch.symbol,
          rounding_step: patch.roundingStep,
          min_smart_save: patch.minSmartSave,
          is_active: patch.isActive,
          sort_order: patch.sortOrder,
        },
      });
      await this.audit.record(
        tx,
        adminId,
        'currency.update',
        existing.code,
        pick(before, patch),
        patch,
      );
    });
    return this.currencies();
  }

  async categories(): Promise<SystemCategoryDto[]> {
    const rows = await this.prisma.categories.findMany({
      where: { user_id: null, deleted_at: null },
      include: { categoryTranslations: true },
      orderBy: [{ type: 'desc' }, { sort_order: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      key: row.key,
      icon: row.icon,
      color: row.color,
      sortOrder: row.sort_order,
      isArchived: row.is_archived,
      labels: Object.fromEntries(
        LANGUAGES.map((language) => [
          language,
          row.categoryTranslations.find((t) => t.language === language)
            ?.label ?? '',
        ]),
      ) as Record<LanguageCode, string>,
      updatedAt: row.updated_at,
    }));
  }

  async updateCategory(
    adminId: string,
    id: string,
    patch: CategoryPatch,
  ): Promise<SystemCategoryDto[]> {
    const existing = (await this.categories()).find((c) => c.id === id);
    if (!existing) {
      throw new NotFoundException({
        code: 'category_not_found',
        message: 'No such system category',
      });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.categories.update({
        where: { id },
        data: {
          icon: patch.icon,
          color: patch.color,
          sort_order: patch.sortOrder,
          is_archived: patch.isArchived,
          // A new name alone changes the category too: sync sends it again.
          updated_at: new Date(),
        },
      });
      for (const [language, label] of Object.entries(patch.labels ?? {})) {
        await tx.categoryTranslations.upsert({
          where: {
            category_id_language: {
              category_id: id,
              language: language as LanguageCode,
            },
          },
          create: {
            category_id: id,
            language: language as LanguageCode,
            label,
          },
          update: { label },
        });
      }
      await this.audit.record(
        tx,
        adminId,
        'category.update',
        existing.key ?? id,
        pick(existing, patch),
        patch,
      );
    });
    return this.categories();
  }

  async createCategory(
    adminId: string,
    input: CategoryCreate,
  ): Promise<SystemCategoryDto[]> {
    const id = systemCategoryId(input.type, input.key);
    if (await this.prisma.categories.findUnique({ where: { id } })) {
      throw new ConflictException({
        code: 'category_exists',
        message: `A ${input.type} category «${input.key}» already exists`,
      });
    }
    const last = await this.prisma.categories.aggregate({
      where: { user_id: null, type: input.type },
      _max: { sort_order: true },
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.categories.create({
        data: {
          id,
          type: input.type,
          key: input.key,
          icon: input.icon,
          color: input.color,
          sort_order: (last._max.sort_order ?? 0) + 1,
          categoryTranslations: {
            create: LANGUAGES.map((language) => ({
              language,
              label: input.labels[language],
            })),
          },
        },
      });
      await this.audit.record(
        tx,
        adminId,
        'category.create',
        input.key,
        null,
        input,
      );
    });
    return this.categories();
  }
}

/** The fields of `before` that the patch changes, for the log. */
function pick(before: object, patch: object): Record<string, unknown> {
  const values = before as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(patch).map((key) => [key, values[key] ?? null]),
  );
}
