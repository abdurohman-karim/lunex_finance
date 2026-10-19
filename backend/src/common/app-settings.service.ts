import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import {
  type AppSettingKey,
  DEFAULT_APP_SETTINGS,
} from '../database/reference-data.js';

type Widen<T> = T extends boolean ? boolean : T extends number ? number : T;
export type AppSettingValue<K extends AppSettingKey> = Widen<
  (typeof DEFAULT_APP_SETTINGS)[K]['value']
>;
export type AppSettings = { [K in AppSettingKey]: AppSettingValue<K> };

/** Every API instance sees an administrator's change within this time. */
export const APP_SETTINGS_CACHE_MS = 10_000;

/** Runtime settings from `app_settings`, changed by administrators without a deploy. */
@Injectable()
export class AppSettingsService {
  private readonly logger = new Logger(AppSettingsService.name);
  private cache: { settings: AppSettings; loadedAt: number } | undefined;

  constructor(private readonly prisma: PrismaService) {}

  async get<K extends AppSettingKey>(key: K): Promise<AppSettingValue<K>> {
    return (await this.getAll())[key];
  }

  /** All settings in one query; missing or mistyped values fall back to the defaults. */
  async getAll(): Promise<AppSettings> {
    if (
      this.cache &&
      Date.now() - this.cache.loadedAt < APP_SETTINGS_CACHE_MS
    ) {
      return this.cache.settings;
    }

    const rows = await this.prisma.appSettings.findMany();
    const stored = new Map(rows.map((row) => [row.key, row.value]));
    const settings = {} as Record<AppSettingKey, unknown>;
    for (const key of Object.keys(DEFAULT_APP_SETTINGS) as AppSettingKey[]) {
      const fallback = DEFAULT_APP_SETTINGS[key].value;
      const value = stored.get(key);
      if (value !== undefined && typeof value !== typeof fallback) {
        this.logger.warn(
          `app_settings.${key} has a ${typeof value} value, expected ${typeof fallback}; using the default`,
        );
      }
      settings[key] = typeof value === typeof fallback ? value : fallback;
    }

    this.cache = { settings: settings as AppSettings, loadedAt: Date.now() };
    return this.cache.settings;
  }

  /** Drop the cached values, e.g. right after an administrator changed a setting. */
  invalidate(): void {
    this.cache = undefined;
  }
}
