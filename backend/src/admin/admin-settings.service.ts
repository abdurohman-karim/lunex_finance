import { BadRequestException, Injectable } from '@nestjs/common';
import { AppSettingsService } from '../common/app-settings.service.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  type AppSettingKey,
  DEFAULT_APP_SETTINGS,
} from '../database/reference-data.js';
import { SETTING_RULES } from './admin.schemas.js';
import { AuditService } from './audit.service.js';

export interface SettingDto {
  key: AppSettingKey;
  value: boolean | number;
  defaultValue: boolean | number;
  description: string;
  /** Changed in the panel: who and when; null while it is the seeded default */
  updatedBy: { id: string; name: string | null } | null;
  updatedAt: Date;
}

export interface MonetizationPreview {
  enabled: boolean;
  /** Accounts that are not deleted */
  users: number;
  /** A live App Store subscription */
  subscribers: number;
  /** Pro given by an administrator */
  promo: number;
  /** On the 30-day trial, nothing else */
  trials: number;
  /** Nothing live: these go to Free the moment Lunex Pro is switched on */
  toFree: number;
}

/**
 * Runtime settings and the Lunex Pro switch (spec: «Параметры приложения», «Монетизация
 * включается одной кнопкой»). Every change goes to the audit log with its old and new value.
 */
@Injectable()
export class AdminSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AppSettingsService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<SettingDto[]> {
    const [values, rows] = await Promise.all([
      this.settings.getAll(),
      this.prisma.appSettings.findMany({
        include: {
          user: {
            select: { id: true, display_name: true, email: true },
          },
        },
      }),
    ]);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return (Object.keys(DEFAULT_APP_SETTINGS) as AppSettingKey[]).map((key) => {
      const row = byKey.get(key);
      const admin = row?.user;
      return {
        key,
        value: values[key],
        defaultValue: DEFAULT_APP_SETTINGS[key].value,
        description: DEFAULT_APP_SETTINGS[key].description,
        updatedBy: admin
          ? { id: admin.id, name: admin.display_name ?? admin.email }
          : null,
        updatedAt: row?.updated_at ?? new Date(0),
      };
    });
  }

  async update(
    adminId: string,
    key: string,
    value: number,
  ): Promise<SettingDto[]> {
    if (!(key in SETTING_RULES)) {
      throw new BadRequestException({
        code: 'unknown_setting',
        message:
          key === 'monetization_enabled'
            ? 'Lunex Pro is switched on and off with its own confirmation'
            : `No setting ${key}`,
      });
    }
    const rule = SETTING_RULES[key as keyof typeof SETTING_RULES];
    const parsed = rule.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'invalid_value',
        message: parsed.error.issues[0]?.message ?? 'Invalid value',
      });
    }
    await this.write(
      adminId,
      key as AppSettingKey,
      parsed.data,
      'setting.update',
    );
    return this.list();
  }

  /** What switching Lunex Pro on (or off) changes, for the confirmation. */
  async preview(): Promise<MonetizationPreview> {
    const enabled = await this.settings.get('monetization_enabled');
    const [row] = await this.prisma.$queryRaw<
      {
        users: bigint;
        subscribers: bigint;
        promo: bigint;
        trials: bigint;
        to_free: bigint;
      }[]
    >`
      WITH live AS (
        SELECT u.id,
          bool_or(s.source = 'app_store') AS paid,
          bool_or(s.source = 'promo') AS promo,
          bool_or(s.source = 'trial') AS trial
        FROM users u
        LEFT JOIN subscriptions s ON s.user_id = u.id
          AND s.status IN ('active', 'grace_period') AND s.expires_at > now()
        WHERE u.deleted_at IS NULL
        GROUP BY u.id
      )
      SELECT count(*) AS users,
        count(*) FILTER (WHERE paid) AS subscribers,
        count(*) FILTER (WHERE promo AND NOT coalesce(paid, false)) AS promo,
        count(*) FILTER (WHERE trial AND NOT coalesce(paid, false) AND NOT coalesce(promo, false)) AS trials,
        count(*) FILTER (WHERE paid IS NULL) AS to_free
      FROM live`;
    return {
      enabled,
      users: Number(row.users),
      subscribers: Number(row.subscribers),
      promo: Number(row.promo),
      trials: Number(row.trials),
      toFree: Number(row.to_free),
    };
  }

  async setMonetization(
    adminId: string,
    enabled: boolean,
  ): Promise<MonetizationPreview> {
    await this.write(
      adminId,
      'monetization_enabled',
      enabled,
      enabled ? 'monetization.enable' : 'monetization.disable',
    );
    return this.preview();
  }

  private async write(
    adminId: string,
    key: AppSettingKey,
    value: boolean | number,
    action: string,
  ): Promise<void> {
    const before = await this.settings.get(key);
    if (before === value) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.appSettings.upsert({
        where: { key },
        create: {
          key,
          value,
          description: DEFAULT_APP_SETTINGS[key].description,
          updated_by: adminId,
        },
        update: { value, updated_by: adminId },
      });
      await this.audit.record(tx, adminId, action, key, before, value);
    });
    this.settings.invalidate();
  }
}
