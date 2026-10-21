import { z } from 'zod';
import { uuidSchema } from '../common/schemas.js';

/** What was read on a receipt, by the device (Apple Vision and the app's rules) or by Claude. */
export const receiptReadingSchema = z.object({
  source: z.enum(['device', 'ai']),
  /** Decimal text, the total paid */
  amount: z
    .string()
    .regex(/^\d{1,16}(\.\d{1,2})?$/)
    .nullish(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullish(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  merchant: z.string().trim().max(128).nullish(),
  confidence: z.number().min(0).max(1),
});

export type ReceiptReading = z.infer<typeof receiptReadingSchema>;

/** Multipart fields next to the photo; `receipt` comes as JSON text. */
export const uploadAttachmentSchema = z.object({
  transactionId: uuidSchema,
  receipt: z
    .string()
    .max(4000)
    .transform((text, ctx) => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'receipt must be JSON' });
        return z.NEVER;
      }
    })
    .pipe(receiptReadingSchema)
    .optional(),
});

export type UploadAttachmentInput = z.infer<typeof uploadAttachmentSchema>;
