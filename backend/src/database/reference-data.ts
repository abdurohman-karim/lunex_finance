import type { CategoryType, LanguageCode } from '../generated/prisma/enums.js';
import { uuidV5 } from './uuid.js';

export interface CurrencySeed {
  code: string;
  name: string;
  symbol: string;
  decimals: number;
  roundingStep: number;
  minSmartSave: number;
  sortOrder: number;
}

export const CURRENCIES: readonly CurrencySeed[] = [
  {
    code: 'UZS',
    name: 'Uzbekistani Som',
    symbol: 'soʻm',
    decimals: 0,
    roundingStep: 1000,
    minSmartSave: 1000,
    sortOrder: 0,
  },
  {
    code: 'USD',
    name: 'US Dollar',
    symbol: '$',
    decimals: 2,
    roundingStep: 1,
    minSmartSave: 1,
    sortOrder: 1,
  },
  {
    code: 'EUR',
    name: 'Euro',
    symbol: '€',
    decimals: 2,
    roundingStep: 1,
    minSmartSave: 1,
    sortOrder: 2,
  },
  {
    code: 'RUB',
    name: 'Russian Ruble',
    symbol: '₽',
    decimals: 2,
    roundingStep: 100,
    minSmartSave: 100,
    sortOrder: 3,
  },
  {
    code: 'KZT',
    name: 'Kazakhstani Tenge',
    symbol: '₸',
    decimals: 0,
    roundingStep: 500,
    minSmartSave: 500,
    sortOrder: 4,
  },
];

export const DEFAULT_CURRENCY_CODE = 'UZS';

export interface SystemCategorySeed {
  id: string;
  type: CategoryType;
  key: string;
  /** SF Symbol name rendered by the iOS app */
  icon: string;
  color: string;
  sortOrder: number;
  labels: Record<LanguageCode, string>;
}

type CategoryDefinition = Omit<SystemCategorySeed, 'id' | 'type' | 'sortOrder'>;

/** Stable id of a system category, so the app and the server agree on it without a lookup. */
export function systemCategoryId(type: CategoryType, key: string): string {
  return uuidV5(`category:${type}:${key}`);
}

// Order is the default order in the category grid. The first six expense and five income
// categories are the ones the Telegram bot had. Colours are muted tones of the design system's
// data palette: categories colour charts, the rest of the UI stays monochrome.
const EXPENSE_CATEGORIES: readonly CategoryDefinition[] = [
  {
    key: 'food',
    icon: 'fork.knife',
    color: '#C08B5C',
    labels: { uz: 'Oziq-ovqat', ru: 'Еда', en: 'Food' },
  },
  {
    key: 'transport',
    icon: 'bus.fill',
    color: '#557A95',
    labels: { uz: 'Transport', ru: 'Транспорт', en: 'Transport' },
  },
  {
    key: 'market',
    icon: 'cart.fill',
    color: '#6E8B74',
    labels: { uz: 'Supermarket', ru: 'Супермаркет', en: 'Groceries' },
  },
  {
    key: 'shopping',
    icon: 'bag.fill',
    color: '#938E94',
    labels: { uz: 'Xaridlar', ru: 'Покупки', en: 'Shopping' },
  },
  {
    key: 'subscriptions',
    icon: 'creditcard.fill',
    color: '#8A9BA8',
    labels: { uz: 'Obunalar', ru: 'Подписки', en: 'Subscriptions' },
  },
  {
    key: 'fun',
    icon: 'party.popper.fill',
    color: '#B1A296',
    labels: { uz: 'Koʻngilochar', ru: 'Развлечения', en: 'Entertainment' },
  },
  {
    key: 'cafe',
    icon: 'cup.and.saucer.fill',
    color: '#8C7B6B',
    labels: {
      uz: 'Kafe va restoranlar',
      ru: 'Кафе и рестораны',
      en: 'Cafes & restaurants',
    },
  },
  {
    key: 'health',
    icon: 'cross.case.fill',
    color: '#5F8A8B',
    labels: { uz: 'Salomatlik', ru: 'Здоровье', en: 'Health' },
  },
  {
    key: 'home',
    icon: 'house.fill',
    color: '#5D5C61',
    labels: { uz: 'Uy-joy', ru: 'Жильё', en: 'Housing' },
  },
  {
    key: 'utilities',
    icon: 'bolt.fill',
    color: '#7395AE',
    labels: {
      uz: 'Kommunal xizmatlar',
      ru: 'Коммунальные услуги',
      en: 'Utilities',
    },
  },
  {
    key: 'education',
    icon: 'graduationcap.fill',
    color: '#557A95',
    labels: { uz: 'Taʼlim', ru: 'Образование', en: 'Education' },
  },
  {
    key: 'gifts',
    icon: 'gift.fill',
    color: '#C08B5C',
    labels: { uz: 'Sovgʻalar', ru: 'Подарки', en: 'Gifts' },
  },
];

const INCOME_CATEGORIES: readonly CategoryDefinition[] = [
  {
    key: 'salary',
    icon: 'briefcase.fill',
    color: '#6E8B74',
    labels: { uz: 'Ish haqi', ru: 'Зарплата', en: 'Salary' },
  },
  {
    key: 'transfer',
    icon: 'arrow.down.left.circle.fill',
    color: '#557A95',
    labels: { uz: 'Oʻtkazma', ru: 'Перевод', en: 'Transfer' },
  },
  {
    key: 'business',
    icon: 'chart.line.uptrend.xyaxis',
    color: '#5D5C61',
    labels: { uz: 'Biznes', ru: 'Бизнес', en: 'Business' },
  },
  {
    key: 'sale',
    icon: 'tag.fill',
    color: '#C08B5C',
    labels: { uz: 'Sotuv', ru: 'Продажа', en: 'Sale' },
  },
  {
    key: 'gift',
    icon: 'gift.fill',
    color: '#938E94',
    labels: { uz: 'Sovgʻa', ru: 'Подарок', en: 'Gift' },
  },
  {
    key: 'freelance',
    icon: 'laptopcomputer',
    color: '#7395AE',
    labels: { uz: 'Frilans', ru: 'Фриланс', en: 'Freelance' },
  },
  {
    key: 'cashback',
    icon: 'arrow.uturn.backward.circle.fill',
    color: '#B1A296',
    labels: { uz: 'Keshbek', ru: 'Кешбэк', en: 'Cashback' },
  },
];

function withIds(
  type: CategoryType,
  definitions: readonly CategoryDefinition[],
): SystemCategorySeed[] {
  return definitions.map((definition, index) => ({
    ...definition,
    id: systemCategoryId(type, definition.key),
    type,
    sortOrder: index,
  }));
}

export const SYSTEM_CATEGORIES: readonly SystemCategorySeed[] = [
  ...withIds('expense', EXPENSE_CATEGORIES),
  ...withIds('income', INCOME_CATEGORIES),
];

export interface GoalTemplate {
  key: string;
  emoji: string;
  color: string;
  labels: Record<LanguageCode, string>;
}

/** Ready-made goals offered in onboarding and on «Новая цель». */
/** Colours come from the design system's data palette: goals are data, the rest of the UI is monochrome. */
export const GOAL_TEMPLATES: readonly GoalTemplate[] = [
  {
    key: 'phone',
    emoji: '📱',
    color: '#557A95',
    labels: { uz: 'Telefon', ru: 'Телефон', en: 'Phone' },
  },
  {
    key: 'car',
    emoji: '🚗',
    color: '#B1A296',
    labels: { uz: 'Avtomobil', ru: 'Машина', en: 'Car' },
  },
  {
    key: 'home',
    emoji: '🏠',
    color: '#5D5C61',
    labels: { uz: 'Uy', ru: 'Дом', en: 'Home' },
  },
  {
    key: 'travel',
    emoji: '✈️',
    color: '#7395AE',
    labels: { uz: 'Sayohat', ru: 'Путешествие', en: 'Travel' },
  },
  {
    key: 'education',
    emoji: '🎓',
    color: '#938E94',
    labels: { uz: 'Taʼlim', ru: 'Учёба', en: 'Education' },
  },
  {
    key: 'emergency_fund',
    emoji: '🛟',
    color: '#557A95',
    labels: {
      uz: 'Favqulodda jamgʻarma',
      ru: 'Подушка безопасности',
      en: 'Emergency fund',
    },
  },
  {
    key: 'wedding',
    emoji: '💍',
    color: '#B1A296',
    labels: { uz: 'Toʻy', ru: 'Свадьба', en: 'Wedding' },
  },
  {
    key: 'gadget',
    emoji: '💻',
    color: '#7395AE',
    labels: { uz: 'Gadjet', ru: 'Гаджет', en: 'Gadget' },
  },
];

/**
 * Defaults of runtime settings. The seed only inserts missing keys:
 * values changed by an administrator are never overwritten.
 */
export const DEFAULT_APP_SETTINGS = {
  monetization_enabled: {
    value: false,
    description: 'Платная подписка Lunex Pro включена',
  },
  trial_days: {
    value: 30,
    description: 'Дней Lunex Pro при первой регистрации',
  },
  ai_daily_limit_free: {
    value: 5,
    description: 'Сообщений AI-ассистенту в день на Free',
  },
  ai_daily_limit_pro: {
    value: 50,
    description: 'Сообщений AI-ассистенту в день на Pro',
  },
  free_max_accounts: { value: 2, description: 'Максимум счетов на Free' },
  free_max_goals: { value: 3, description: 'Максимум активных целей на Free' },
  smart_save_share: {
    value: 0.5,
    description:
      'Доля свободного остатка на день, которую предлагает Smart Save',
  },
} as const satisfies Record<
  string,
  { value: boolean | number; description: string }
>;

export type AppSettingKey = keyof typeof DEFAULT_APP_SETTINGS;
