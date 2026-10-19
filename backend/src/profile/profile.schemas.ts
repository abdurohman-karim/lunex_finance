import { z } from 'zod';
import { languageSchema } from '../auth/auth.schemas.js';
import { positiveMoneySchema, uuidSchema } from '../common/schemas.js';
import { createGoalSchema } from '../goals/goals.schemas.js';

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, 'An IANA time zone such as Asia/Tashkent');

const currencyCodeSchema = z
  .string()
  .trim()
  .length(3)
  .transform((code) => code.toUpperCase());

const focusSchema = z.enum(['save', 'track', 'budget']);

/** `HH:MM`, 24-hour clock */
const clockTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time like 21:00');

export const updateProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(128).nullable(),
    language: languageSchema,
    /** Changing it re-values every operation at its date's rate */
    baseCurrency: currencyCodeSchema,
    timezone: timeZoneSchema,
    monthlyIncomeEstimate: positiveMoneySchema.nullable(),
    onboardingFocus: focusSchema.nullable(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'Nothing to update');
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const updateSettingsSchema = z
  .object({
    biometricLockEnabled: z.boolean(),
    /** Lock again after this long in the background */
    lockAfterSeconds: z.number().int().min(0).max(3600),
    hideAmounts: z.boolean(),
    /** 1 = Monday … 7 = Sunday */
    weekStartsOn: z.number().int().min(1).max(7),
    /** Payday: the budget month starts on it */
    monthStartsOnDay: z.number().int().min(1).max(31),
    defaultAccountId: uuidSchema,
    dailyReminderEnabled: z.boolean(),
    dailyReminderTime: clockTimeSchema,
    budgetAlertsEnabled: z.boolean(),
    goalAlertsEnabled: z.boolean(),
    recurringAlertsEnabled: z.boolean(),
    smartSaveEnabled: z.boolean(),
    weeklyReportEnabled: z.boolean(),
    quietHoursStart: clockTimeSchema,
    quietHoursEnd: clockTimeSchema,
    hapticsEnabled: z.boolean(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'Nothing to update');
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

/** Every step can be skipped; only the id for the «Наличные» account is required. */
export const onboardingSchema = z.object({
  language: languageSchema.optional(),
  baseCurrency: currencyCodeSchema.optional(),
  timezone: timeZoneSchema.optional(),
  focus: focusSchema.optional(),
  monthlyIncomeEstimate: positiveMoneySchema.optional(),
  /** Id the app generated for the cash account created now */
  cashAccountId: uuidSchema,
  firstGoal: createGoalSchema.optional(),
});
export type OnboardingInput = z.infer<typeof onboardingSchema>;

export const deviceUpdateSchema = z
  .object({
    /** APNs device token in hex; null when the user turned notifications off */
    apnsToken: z
      .string()
      .regex(/^[0-9a-fA-F]{32,200}$/)
      .nullable(),
    pushEnabled: z.boolean(),
    model: z.string().max(64),
    osVersion: z.string().max(32),
    appVersion: z.string().max(32),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'Nothing to update');
export type DeviceUpdateInput = z.infer<typeof deviceUpdateSchema>;
