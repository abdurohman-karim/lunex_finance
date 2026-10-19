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

async function seedCurrencies(): Promise<void> {
  for (const currency of CURRENCIES) {
    const data = {
      name: currency.name,
      symbol: currency.symbol,
      decimals: currency.decimals,
      rounding_step: currency.roundingStep,
      min_smart_save: currency.minSmartSave,
      sort_order: currency.sortOrder,
    };
    await prisma.currencies.upsert({
      where: { code: currency.code },
      create: { code: currency.code, ...data },
      update: data,
    });
  }
}

async function seedSystemCategories(): Promise<void> {
  for (const category of SYSTEM_CATEGORIES) {
    const data = {
      type: category.type,
      key: category.key,
      icon: category.icon,
      color: category.color,
      sort_order: category.sortOrder,
    };
    await prisma.categories.upsert({
      where: { id: category.id },
      create: { id: category.id, ...data },
      update: data,
    });

    for (const [language, label] of Object.entries(category.labels)) {
      const lang = language as keyof typeof category.labels;
      await prisma.categoryTranslations.upsert({
        where: {
          category_id_language: { category_id: category.id, language: lang },
        },
        create: { category_id: category.id, language: lang, label },
        update: { label },
      });
    }
  }
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
