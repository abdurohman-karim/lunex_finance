import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import {
  CURRENCIES,
  DEFAULT_APP_SETTINGS,
  SYSTEM_CATEGORIES,
} from '../src/database/reference-data.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

// Currencies and system categories are edited in the admin panel: the seed only adds what is
// missing and never overwrites an administrator's change.

async function seedCurrencies(): Promise<void> {
  await prisma.currencies.createMany({
    data: CURRENCIES.map((currency) => ({
      code: currency.code,
      name: currency.name,
      symbol: currency.symbol,
      decimals: currency.decimals,
      rounding_step: currency.roundingStep,
      min_smart_save: currency.minSmartSave,
      sort_order: currency.sortOrder,
    })),
    skipDuplicates: true,
  });
}

async function seedSystemCategories(): Promise<void> {
  await prisma.categories.createMany({
    data: SYSTEM_CATEGORIES.map((category) => ({
      id: category.id,
      type: category.type,
      key: category.key,
      icon: category.icon,
      color: category.color,
      sort_order: category.sortOrder,
    })),
    skipDuplicates: true,
  });
  await prisma.categoryTranslations.createMany({
    data: SYSTEM_CATEGORIES.flatMap((category) =>
      Object.entries(category.labels).map(([language, label]) => ({
        category_id: category.id,
        language: language as keyof typeof category.labels,
        label,
      })),
    ),
    skipDuplicates: true,
  });
}

async function seedAppSettings(): Promise<void> {
  for (const [key, setting] of Object.entries(DEFAULT_APP_SETTINGS)) {
    await prisma.appSettings.upsert({
      where: { key },
      create: { key, value: setting.value, description: setting.description },
      // Keep values an administrator may have changed; only refresh the description.
      update: { description: setting.description },
    });
  }
}

// Every step is an idempotent upsert, so the seed can be re-run at any time.
try {
  await seedCurrencies();
  await seedSystemCategories();
  await seedAppSettings();
  console.log(
    `Seeded ${CURRENCIES.length} currencies, ${SYSTEM_CATEGORIES.length} system categories, ${Object.keys(DEFAULT_APP_SETTINGS).length} app settings`,
  );
} finally {
  await prisma.$disconnect();
}
