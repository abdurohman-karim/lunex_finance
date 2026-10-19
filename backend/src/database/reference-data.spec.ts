import {
  CURRENCIES,
  DEFAULT_APP_SETTINGS,
  DEFAULT_CURRENCY_CODE,
  SYSTEM_CATEGORIES,
  systemCategoryId,
} from './reference-data.js';
import { uuidV5 } from './uuid.js';

describe('uuidV5', () => {
  it('matches the RFC 9562 test vector', () => {
    const dnsNamespace = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    expect(uuidV5('www.example.com', dnsNamespace)).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });

  it('is stable for the same name and different for different names', () => {
    expect(uuidV5('a')).toBe(uuidV5('a'));
    expect(uuidV5('a')).not.toBe(uuidV5('b'));
  });
});

describe('reference data', () => {
  it('has unique currency codes and includes the default currency', () => {
    const codes = CURRENCIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toContain(DEFAULT_CURRENCY_CODE);
  });

  it('rounds UZS Smart Save amounts to 1000 like the bot did', () => {
    const uzs = CURRENCIES.find((c) => c.code === 'UZS');
    expect(uzs).toMatchObject({
      decimals: 0,
      roundingStep: 1000,
      minSmartSave: 1000,
    });
  });

  it('keeps every category the Telegram bot had', () => {
    const keys = (type: string) =>
      SYSTEM_CATEGORIES.filter((c) => c.type === type).map((c) => c.key);
    expect(keys('expense')).toEqual(
      expect.arrayContaining([
        'food',
        'transport',
        'market',
        'shopping',
        'subscriptions',
        'fun',
      ]),
    );
    expect(keys('income')).toEqual(
      expect.arrayContaining([
        'salary',
        'transfer',
        'business',
        'sale',
        'gift',
      ]),
    );
  });

  it('gives each system category a unique, stable id', () => {
    const ids = SYSTEM_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const category of SYSTEM_CATEGORIES) {
      expect(category.id).toBe(systemCategoryId(category.type, category.key));
    }
  });

  it('has unique keys per type and sequential sort order', () => {
    for (const type of ['expense', 'income'] as const) {
      const categories = SYSTEM_CATEGORIES.filter((c) => c.type === type);
      expect(new Set(categories.map((c) => c.key)).size).toBe(
        categories.length,
      );
      expect(categories.map((c) => c.sortOrder)).toEqual(
        categories.map((_, i) => i),
      );
    }
  });

  it('translates every category into uz, ru and en', () => {
    for (const category of SYSTEM_CATEGORIES) {
      expect(Object.keys(category.labels).sort()).toEqual(['en', 'ru', 'uz']);
      for (const label of Object.values(category.labels)) {
        expect(label.trim()).not.toBe('');
      }
    }
  });

  it('uses hex colors', () => {
    for (const category of SYSTEM_CATEGORIES) {
      expect(category.color).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it('ships with monetization off and a 30-day trial', () => {
    expect(DEFAULT_APP_SETTINGS.monetization_enabled.value).toBe(false);
    expect(DEFAULT_APP_SETTINGS.trial_days.value).toBe(30);
  });
});
