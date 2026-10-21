import { z } from 'zod';
import { uuidSchema } from '../common/schemas.js';

export const sendMessageSchema = z.object({
  /** Made by the app; a new id starts a new conversation */
  conversationId: uuidSchema,
  /** Made by the app: sending again with the same id is «Повторить», not a second question */
  messageId: uuidSchema,
  text: z.string().trim().min(1).max(1000),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const decideActionSchema = z.object({
  decision: z.enum(['confirm', 'decline']),
});
