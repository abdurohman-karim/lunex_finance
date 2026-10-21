import { z } from 'zod';
import {
  hexColorSchema,
  positiveMoneySchema,
  sfSymbolSchema,
} from '../common/schemas.js';
import type { AppSettingKey } from '../database/reference-data.js';

/**
 * What each setting may be set to. Monetization has its own switch with a confirmation, so it
 * is not here.
 */
export const SETTING_RULES: Record<
  Exclude<AppSettingKey, 'monetization_enabled'>,
  z.ZodType<number>
> = {
  trial_days: z.number().int().min(0).max(365),
  ai_daily_limit_free: z.number().int().min(0).max(1000),
  ai_daily_limit_pro: z.number().int().min(0).max(1000),
  ai_daily_limit_parse: z.number().int().min(0).max(10_000),
  ai_daily_limit_receipt: z.number().int().min(0).max(10_000),
  free_max_accounts: z.number().int().min(1).max(100),
  free_max_goals: z.number().int().min(1).max(100),
  smart_save_share: z.number().min(0.05).max(1),
};

export const settingValueSchema = z.object({ value: z.number() });

export const monetizationSchema = z.object({ enabled: z.boolean() });

export const currencyPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    symbol: z.string().trim().min(1).max(8),
    /** Smart Save and auto-save amounts are rounded down to this */
    roundingStep: positiveMoneySchema,
    minSmartSave: positiveMoneySchema,
    isActive: z.boolean(),
    sortOrder: z.number().int().min(0).max(1000),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'Nothing to change');
export type CurrencyPatch = z.infer<typeof currencyPatchSchema>;

const label = z.string().trim().min(1).max(64);
export const labelsSchema = z.object({ uz: label, ru: label, en: label });

export const categoryPatchSchema = z
  .object({
    icon: sfSymbolSchema,
    color: hexColorSchema,
    sortOrder: z.number().int().min(0).max(1000),
    isArchived: z.boolean(),
    labels: labelsSchema.partial(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'Nothing to change');
export type CategoryPatch = z.infer<typeof categoryPatchSchema>;

export const categoryCreateSchema = z.object({
  type: z.enum(['expense', 'income']),
  /** Stable key the app and the server know the category by */
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,31}$/, 'a-z, 0-9 and _, 2–32 characters'),
  icon: sfSymbolSchema,
  color: hexColorSchema,
  labels: labelsSchema,
});
export type CategoryCreate = z.infer<typeof categoryCreateSchema>;

export const userSearchSchema = z.object({
  q: z.string().trim().min(1).max(128),
});

export const promoSchema = z.object({
  days: z.number().int().min(1).max(3650),
});

export const auditQuerySchema = z.object({
  before: z
    .string()
    .regex(/^\d{1,19}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
