import type { PrismaService } from '../database/prisma.service.js';
import type { CategoryType, LanguageCode } from '../generated/prisma/enums.js';
import type { CategoryOption } from './phrase-rules.js';

/**
 * Live categories for reading a phrase or a receipt: the user's own by their name, system ones
 * by their label in every language, the user's language first.
 */
export async function userCategories(
  prisma: PrismaService,
  userId: string,
  language: LanguageCode,
  type?: CategoryType,
): Promise<CategoryOption[]> {
  const rows = await prisma.categories.findMany({
    where: {
      deleted_at: null,
      is_archived: false,
      ...(type ? { type } : {}),
      OR: [{ user_id: null }, { user_id: userId }],
    },
    select: {
      id: true,
      type: true,
      key: true,
      name: true,
      user_id: true,
      categoryTranslations: { select: { language: true, label: true } },
      categoryPreferences: {
        where: { user_id: userId },
        select: { is_archived: true },
      },
    },
  });
  return rows
    .filter((row) => !row.categoryPreferences[0]?.is_archived)
    .map((row) => {
      const labels = row.categoryTranslations
        .sort((a, b) =>
          a.language === language ? -1 : b.language === language ? 1 : 0,
        )
        .map((t) => t.label);
      return {
        id: row.id,
        type: row.type,
        key: row.user_id ? null : row.key,
        names: row.name ? [row.name] : labels,
      };
    });
}
