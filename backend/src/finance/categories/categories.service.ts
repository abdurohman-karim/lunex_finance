import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type {
  CategoryType,
  LanguageCode,
} from '../../generated/prisma/enums.js';
import type {
  CreateCategoryInput,
  UpdateCategoryInput,
} from './categories.schemas.js';

export interface CategoryDto {
  id: string;
  type: CategoryType;
  /** Stable key of a system category (`food`); null for own categories */
  key: string | null;
  /** In the user's language */
  name: string;
  /** All languages of a system category, so the app can switch language offline */
  translations: Partial<Record<LanguageCode, string>> | null;
  icon: string;
  color: string;
  parentId: string | null;
  sortOrder: number;
  isArchived: boolean;
  isSystem: boolean;
  updatedAt: Date;
  deletedAt: Date | null;
}

function includeFor(userId: string) {
  return {
    categoryTranslations: true,
    categoryPreferences: { where: { user_id: userId } },
  } as const;
}
type CategoryRow = Prisma.CategoriesGetPayload<{
  include: ReturnType<typeof includeFor>;
}>;

function toDto(row: CategoryRow, language: LanguageCode): CategoryDto {
  const isSystem = row.user_id === null;
  const preference = row.categoryPreferences[0];
  const translations = isSystem
    ? Object.fromEntries(
        row.categoryTranslations.map((t) => [t.language, t.label]),
      )
    : null;
  const updatedAt =
    preference && preference.updated_at > row.updated_at
      ? preference.updated_at
      : row.updated_at;

  return {
    id: row.id,
    type: row.type,
    key: row.key,
    name: isSystem
      ? (translations?.[language] ?? translations?.en ?? row.key ?? '')
      : (row.name ?? ''),
    translations,
    icon: row.icon,
    color: row.color,
    parentId: row.parent_id,
    sortOrder: isSystem
      ? (preference?.sort_order ?? row.sort_order)
      : row.sort_order,
    isArchived: isSystem ? (preference?.is_archived ?? false) : row.is_archived,
    isSystem,
    updatedAt,
    deletedAt: row.deleted_at,
  };
}

function byOrder(a: CategoryDto, b: CategoryDto): number {
  return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
}

const notFound = () =>
  new NotFoundException({
    code: 'category_not_found',
    message: 'Category not found',
  });

const systemReadonly = () =>
  new ForbiddenException({
    code: 'system_category_readonly',
    message: 'System categories can only be reordered or archived',
  });

/** System categories are shared; per-user order and archiving live in category_preferences. */
@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    userId: string,
    filter: { type?: CategoryType; updatedSince?: Date } = {},
  ): Promise<CategoryDto[]> {
    const language = await this.language(userId);
    const since = filter.updatedSince;
    const rows = await this.prisma.categories.findMany({
      where: {
        type: filter.type,
        AND: [
          { OR: [{ user_id: null }, { user_id: userId }] },
          since
            ? {
                OR: [
                  { updated_at: { gt: since } },
                  {
                    categoryPreferences: {
                      some: { user_id: userId, updated_at: { gt: since } },
                    },
                  },
                ],
              }
            : { deleted_at: null },
        ],
      },
      include: includeFor(userId),
    });
    return rows.map((row) => toDto(row, language)).sort(byOrder);
  }

  /** Idempotent: sending the same id again returns the category created the first time. */
  async create(
    userId: string,
    input: CreateCategoryInput,
  ): Promise<CategoryDto> {
    const existing = await this.prisma.categories.findUnique({
      where: { id: input.id },
      include: includeFor(userId),
    });
    if (existing) {
      if (existing.user_id !== userId || existing.deleted_at) {
        throw new ConflictException({
          code: 'id_conflict',
          message: 'This id is already used',
        });
      }
      return toDto(existing, await this.language(userId));
    }

    const parentId = input.parentId ?? null;
    if (parentId) {
      await this.assertValidParent(userId, parentId, input.type);
    }
    await this.assertNameFree(userId, input.type, parentId, input.name);

    const siblings = await this.list(userId, { type: input.type });
    const lastOrder = Math.max(
      -1,
      ...siblings
        .filter((c) => c.parentId === parentId)
        .map((c) => c.sortOrder),
    );

    const created = await this.prisma.categories.create({
      data: {
        id: input.id,
        user_id: userId,
        type: input.type,
        name: input.name,
        icon: input.icon,
        color: input.color,
        parent_id: parentId,
        sort_order: lastOrder + 1,
      },
      include: includeFor(userId),
    });
    return toDto(created, await this.language(userId));
  }

  async update(
    userId: string,
    id: string,
    patch: UpdateCategoryInput,
  ): Promise<CategoryDto> {
    const category = await this.findVisible(userId, id);

    if (category.user_id === null) {
      const { isArchived, ...rest } = patch;
      if (Object.keys(rest).length > 0 || isArchived === undefined) {
        throw systemReadonly();
      }
      await this.prisma.categoryPreferences.upsert({
        where: { user_id_category_id: { user_id: userId, category_id: id } },
        create: {
          user_id: userId,
          category_id: id,
          sort_order: category.sort_order,
          is_archived: isArchived,
        },
        update: { is_archived: isArchived },
      });
      return this.get(userId, id);
    }

    if (patch.parentId !== undefined && patch.parentId !== category.parent_id) {
      if (patch.parentId !== null) {
        if (patch.parentId === id) {
          throw this.invalidParent('A category cannot be its own parent');
        }
        const children = await this.prisma.categories.count({
          where: { parent_id: id, deleted_at: null },
        });
        if (children > 0) {
          throw this.invalidParent(
            'A category with subcategories cannot become a subcategory',
          );
        }
        await this.assertValidParent(userId, patch.parentId, category.type);
      }
    }
    const parentId =
      patch.parentId === undefined ? category.parent_id : patch.parentId;
    if (patch.name !== undefined || patch.parentId !== undefined) {
      await this.assertNameFree(
        userId,
        category.type,
        parentId,
        patch.name ?? category.name ?? '',
        id,
      );
    }

    await this.prisma.categories.update({
      where: { id },
      data: {
        name: patch.name,
        icon: patch.icon,
        color: patch.color,
        parent_id: patch.parentId,
        is_archived: patch.isArchived,
      },
    });
    return this.get(userId, id);
  }

  /** Drag-and-drop order within one list: the listed ids get positions 0, 1, 2… */
  async reorder(userId: string, ids: string[]): Promise<CategoryDto[]> {
    const categories = await this.prisma.categories.findMany({
      where: {
        id: { in: ids },
        deleted_at: null,
        OR: [{ user_id: null }, { user_id: userId }],
      },
      include: { categoryPreferences: { where: { user_id: userId } } },
    });
    if (categories.length !== ids.length) {
      throw new BadRequestException({
        code: 'unknown_ids',
        message: 'Some ids are not your categories',
      });
    }
    const byId = new Map(categories.map((c) => [c.id, c]));

    await this.prisma.$transaction(
      ids.map((id, index) =>
        byId.get(id)!.user_id === null
          ? this.prisma.categoryPreferences.upsert({
              where: {
                user_id_category_id: { user_id: userId, category_id: id },
              },
              create: { user_id: userId, category_id: id, sort_order: index },
              update: { sort_order: index },
            })
          : this.prisma.categories.update({
              where: { id },
              data: { sort_order: index },
            }),
      ),
    );
    return this.list(userId);
  }

  /** Own categories nothing refers to are deleted; used ones are archived instead, keeping history. */
  async remove(userId: string, id: string): Promise<void> {
    const category = await this.findVisible(userId, id);
    if (category.user_id === null) {
      throw systemReadonly();
    }
    const children = await this.prisma.categories.count({
      where: { parent_id: id, deleted_at: null },
    });
    if (children > 0) {
      throw new ConflictException({
        code: 'category_has_children',
        message: 'Delete or move its subcategories first',
      });
    }
    const [transactions, recurring, limits] = await Promise.all([
      this.prisma.transactions.count({
        where: { category_id: id, deleted_at: null },
      }),
      this.prisma.recurringRules.count({
        where: { category_id: id, deleted_at: null },
      }),
      this.prisma.budgetCategoryLimits.count({ where: { category_id: id } }),
    ]);
    if (transactions + recurring + limits > 0) {
      throw new ConflictException({
        code: 'category_in_use',
        message:
          'The category is used by operations or budgets; archive it instead',
      });
    }
    await this.prisma.categories.update({
      where: { id },
      data: { deleted_at: new Date() },
    });
  }

  private async get(userId: string, id: string): Promise<CategoryDto> {
    const row = await this.prisma.categories.findUniqueOrThrow({
      where: { id },
      include: includeFor(userId),
    });
    return toDto(row, await this.language(userId));
  }

  /** A system category or the user's own, not deleted. */
  private async findVisible(userId: string, id: string) {
    const category = await this.prisma.categories.findUnique({ where: { id } });
    if (
      !category ||
      category.deleted_at ||
      (category.user_id !== null && category.user_id !== userId)
    ) {
      throw notFound();
    }
    return category;
  }

  private async assertValidParent(
    userId: string,
    parentId: string,
    type: CategoryType,
  ): Promise<void> {
    const parent = await this.prisma.categories.findUnique({
      where: { id: parentId },
    });
    if (
      !parent ||
      parent.deleted_at ||
      (parent.user_id !== null && parent.user_id !== userId)
    ) {
      throw this.invalidParent('Parent category not found');
    }
    if (parent.parent_id !== null) {
      throw this.invalidParent('Subcategories have only one level');
    }
    if (parent.type !== type) {
      throw this.invalidParent('Parent category has another type');
    }
  }

  private async assertNameFree(
    userId: string,
    type: CategoryType,
    parentId: string | null,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const duplicate = await this.prisma.categories.findFirst({
      where: {
        user_id: userId,
        type,
        parent_id: parentId,
        deleted_at: null,
        name: { equals: name, mode: 'insensitive' },
        id: exceptId ? { not: exceptId } : undefined,
      },
    });
    if (duplicate) {
      throw new ConflictException({
        code: 'category_name_taken',
        message: 'A category with this name already exists here',
      });
    }
  }

  private invalidParent(message: string): BadRequestException {
    return new BadRequestException({ code: 'invalid_parent', message });
  }

  private async language(userId: string): Promise<LanguageCode> {
    const user = await this.prisma.users.findUniqueOrThrow({
      where: { id: userId },
      select: { language: true },
    });
    return user.language;
  }
}
