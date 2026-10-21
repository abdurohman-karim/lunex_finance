import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { AiService } from '../ai/ai.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { addDays, type CalendarDate, localDate } from '../common/dates.js';
import { PrismaService } from '../database/prisma.service.js';
import type { UploadedFile } from '../attachments/attachments.service.js';
import { userCategories } from './user-categories.js';

/** Receipts older than this are taken for a misread date. */
const MAX_DAYS_BACK = 366;

/** The image types Claude reads; the app sends JPEG. */
const READABLE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
type ReadableType = (typeof READABLE_TYPES)[number];

export interface ReceiptResult {
  source: 'ai';
  /** Decimal text: the total paid */
  amount: string | null;
  currency: string | null;
  /** `2026-10-21` */
  date: string | null;
  merchant: string | null;
  /** An expense category that fits, when one does */
  categoryId: string | null;
  /** 0–1 */
  confidence: number;
}

const replySchema = z.object({
  amount: z.union([z.number(), z.string()]).nullish(),
  currency: z.string().nullish(),
  date: z.string().nullish(),
  merchant: z.string().nullish(),
  category: z.string().nullish(),
  confidence: z.number().nullish(),
});

/**
 * Receipts the device read unsure of (spec: «Сканирование чека»): Claude's fast model looks at
 * the photo, with what Apple Vision read on the device as a hint, and finds the total, the day
 * and the shop. Counted as `receipt` (`ai_daily_limit_receipt` a day), Lunex Pro
 * (`receipt_scan`). Without the model the app keeps its own reading.
 */
@Injectable()
export class ReceiptReaderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly ai: AiService,
  ) {}

  async read(
    userId: string,
    file: UploadedFile | undefined,
    deviceText: string | undefined,
    now = new Date(),
  ): Promise<ReceiptResult> {
    await this.entitlements.assertFeature(userId, 'receipt_scan');
    if (!file || !READABLE_TYPES.includes(file.mimetype as ReadableType)) {
      throw new UnprocessableEntityException({
        code: 'unsupported_file',
        message: 'A JPEG, PNG or WebP photo of the receipt is expected',
      });
    }
    const user = await this.prisma.users.findUniqueOrThrow({
      where: { id: userId },
      select: {
        language: true,
        timezone: true,
        baseCurrency: { select: { code: true } },
      },
    });
    const today = localDate(now, user.timezone);
    const categories = await userCategories(
      this.prisma,
      userId,
      user.language,
      'expense',
    );
    const refs = new Map(categories.map((c, i) => [`c${i + 1}`, c]));
    const list = [...refs]
      .map(([ref, c]) => `${ref} ${c.names.join(' / ')}`)
      .join('\n');

    const reply = await this.ai.ask(
      userId,
      'receipt',
      {
        tier: 'fast',
        maxTokens: 400,
        system: [
          'You read a photo of a shop receipt for a personal finance app, usually from Uzbekistan: a fiscal receipt in Uzbek or Russian, sometimes English.',
          'Find the total paid (ИТОГО, К ОПЛАТЕ, JAMI, JAMI TOʻLOV, TOTAL), not a subtotal, tax (QQS, НДС) or change.',
          `The currency is ${user.baseCurrency.code} unless the receipt prints another; «soʻm», «сум», «sum» are UZS.`,
          `The purchase date as printed; today is ${today}. The shop: its brand or legal name (OOO, MCHJ, ООО, ИП) near the top.`,
          'Expense categories (ref, names):',
          list,
          'Answer with JSON only: {"amount":number|null,"currency":"ISO code"|null,"date":"YYYY-MM-DD"|null,"merchant":"name"|null,"category":"ref"|null,"confidence":0..1}.',
          'Use null for what you cannot read for certain.',
        ].join('\n'),
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: file.mimetype as ReadableType,
                  data: file.buffer.toString('base64'),
                },
              },
              {
                type: 'text',
                text: deviceText
                  ? `Text the phone read on it, possibly with mistakes:\n${deviceText}`
                  : 'Read the receipt.',
              },
            ],
          },
        ],
      },
      now,
    );
    return this.readReply(reply.text, today, refs);
  }

  /** Keeps what holds up: a positive amount, a day not ahead and not a year back, a known category. */
  readReply(
    raw: string,
    today: CalendarDate,
    refs: Map<string, { id: string }>,
  ): ReceiptResult {
    const empty: ReceiptResult = {
      source: 'ai',
      amount: null,
      currency: null,
      date: null,
      merchant: null,
      categoryId: null,
      confidence: 0,
    };
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return empty;
    let parsed: z.infer<typeof replySchema>;
    try {
      const result = replySchema.safeParse(
        JSON.parse(raw.slice(start, end + 1)),
      );
      if (!result.success) return empty;
      parsed = result.data;
    } catch {
      return empty;
    }
    const amount =
      parsed.amount === null || parsed.amount === undefined
        ? NaN
        : Number(String(parsed.amount).replace(/\s/g, '').replace(',', '.'));
    const currency = parsed.currency?.toUpperCase();
    const date =
      parsed.date &&
      /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) &&
      parsed.date <= today &&
      parsed.date >= addDays(today, -MAX_DAYS_BACK)
        ? parsed.date
        : null;
    const merchant = parsed.merchant?.trim().slice(0, 128);
    return {
      source: 'ai',
      amount:
        Number.isFinite(amount) && amount > 0
          ? String(Math.round(amount * 100) / 100)
          : null,
      currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
      date,
      merchant: merchant || null,
      categoryId: (parsed.category && refs.get(parsed.category)?.id) ?? null,
      confidence: Math.min(1, Math.max(0, parsed.confidence ?? 0.8)),
    };
  }
}
