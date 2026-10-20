import { z } from 'zod';
import { budgetPlanSchema } from '../budget/budget.schemas.js';
import { reorderSchema, uuidSchema } from '../common/schemas.js';
import {
  createAccountSchema,
  updateAccountSchema,
} from '../finance/accounts/accounts.schemas.js';
import {
  createCategorySchema,
  updateCategorySchema,
} from '../finance/categories/categories.schemas.js';
import {
  createRecurringSchema,
  recordRecurringSchema,
  skipRecurringSchema,
  updateRecurringSchema,
} from '../finance/recurring/recurring.schemas.js';
import {
  createTransactionSchema,
  updateTransactionSchema,
} from '../finance/transactions/transactions.schemas.js';
import {
  contributionSchema,
  createGoalSchema,
  updateGoalSchema,
} from '../goals/goals.schemas.js';
import {
  updateProfileSchema,
  updateSettingsSchema,
} from '../profile/profile.schemas.js';

const opId = z.string().min(1).max(64);
const id = uuidSchema;
const goalId = uuidSchema;

/** One queued change from the app. Every kind is idempotent, so a batch can be resent. */
export const syncOperationSchema = z.discriminatedUnion('type', [
  z.object({
    opId,
    type: z.literal('account.create'),
    data: createAccountSchema,
  }),
  z.object({
    opId,
    type: z.literal('account.update'),
    id,
    data: updateAccountSchema,
  }),
  z.object({ opId, type: z.literal('account.delete'), id }),
  z.object({ opId, type: z.literal('account.reorder'), data: reorderSchema }),
  z.object({
    opId,
    type: z.literal('category.create'),
    data: createCategorySchema,
  }),
  z.object({
    opId,
    type: z.literal('category.update'),
    id,
    data: updateCategorySchema,
  }),
  z.object({ opId, type: z.literal('category.delete'), id }),
  z.object({ opId, type: z.literal('category.reorder'), data: reorderSchema }),
  z.object({
    opId,
    type: z.literal('transaction.create'),
    data: createTransactionSchema,
  }),
  z.object({
    opId,
    type: z.literal('transaction.update'),
    id,
    data: updateTransactionSchema,
  }),
  z.object({ opId, type: z.literal('transaction.delete'), id }),
  z.object({ opId, type: z.literal('transaction.restore'), id }),
  z.object({ opId, type: z.literal('goal.create'), data: createGoalSchema }),
  z.object({
    opId,
    type: z.literal('goal.update'),
    id,
    data: updateGoalSchema,
  }),
  z.object({ opId, type: z.literal('goal.delete'), id }),
  z.object({ opId, type: z.literal('goal.reorder'), data: reorderSchema }),
  z.object({
    opId,
    type: z.literal('goal.contribute'),
    goalId,
    data: contributionSchema,
  }),
  z.object({
    opId,
    type: z.literal('goal.contribution.delete'),
    goalId,
    id,
  }),
  z.object({
    opId,
    type: z.literal('profile.update'),
    data: updateProfileSchema,
  }),
  z.object({
    opId,
    type: z.literal('settings.update'),
    data: updateSettingsSchema,
  }),
  z.object({
    opId,
    type: z.literal('budget.set'),
    data: budgetPlanSchema,
  }),
  z.object({
    opId,
    type: z.literal('recurring.create'),
    data: createRecurringSchema,
  }),
  z.object({
    opId,
    type: z.literal('recurring.update'),
    id,
    data: updateRecurringSchema,
  }),
  z.object({ opId, type: z.literal('recurring.delete'), id }),
  z.object({
    opId,
    type: z.literal('recurring.record'),
    id,
    data: recordRecurringSchema,
  }),
  z.object({
    opId,
    type: z.literal('recurring.skip'),
    id,
    data: skipRecurringSchema,
  }),
]);
export type SyncOperation = z.infer<typeof syncOperationSchema>;

/** Operations are validated one by one, so a malformed one cannot block the queue. */
export const pushSchema = z.object({
  operations: z.array(z.unknown()).min(1).max(100),
});

export const pullQuerySchema = z.object({
  cursor: z.string().max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});
