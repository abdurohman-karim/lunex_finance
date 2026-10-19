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

/** Runtime settings from `app_settings`, changed by administrators without a deploy. */
@Injectable()
export class AppSettingsService {
  private readonly logger = new Logger(AppSettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async get<K extends AppSettingKey>(key: K): Promise<AppSettingValue<K>> {
    const fallback = DEFAULT_APP_SETTINGS[key].value as AppSettingValue<K>;
    const row = await this.prisma.appSettings.findUnique({ where: { key } });
    if (!row) {
      return fallback;
    }
    if (typeof row.value !== typeof fallback) {
      this.logger.warn(
        `app_settings.${key} has a ${typeof row.value} value, expected ${typeof fallback}; using the default`,
      );
      return fallback;
    }
    return row.value as AppSettingValue<K>;
  }
}
