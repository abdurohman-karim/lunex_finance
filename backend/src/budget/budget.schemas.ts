import { z } from 'zod';
import {
  moneySchema,
  positiveMoneySchema,
  uuidSchema,
} from '../common/schemas.js';

/**
 * The month's plan from the budget wizard (`PUT /v1/budget/current`, sync `budget.set`). It
 * replaces the whole plan of the current budget month and repeats in the next months.
 */
export const budgetPlanSchema = z.object({
  /** null: auto, by the month's actual income (or the onboarding estimate) */
  plannedIncome: positiveMoneySchema.nullable().default(null),
  /** null: no total limit */
  totalLimit: positiveMoneySchema.nullable().default(null),
  savingsTarget: moneySchema
    .refine((value) => Number(value) >= 0, 'Must not be negative')
    .default('0'),
  /** Lunex Pro: carry what is left of last month into this one */
  rolloverEnabled: z.boolean().default(false),
  /** Lunex Pro: limits of expense categories; a limit covers its subcategories */
  categoryLimits: z
    .array(
      z.object({
        categoryId: uuidSchema,
        limit: positiveMoneySchema,
        alertThresholdPct: z.number().int().min(50).max(100).default(80),
      }),
    )
    .max(100)
    .default([]),
});
export type BudgetPlanInput = z.infer<typeof budgetPlanSchema>;
