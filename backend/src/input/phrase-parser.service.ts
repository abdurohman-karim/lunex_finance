import { HttpException, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { AiService } from '../ai/ai.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { addDays, type CalendarDate, localDate } from '../common/dates.js';
import { PrismaService } from '../database/prisma.service.js';
import type { LanguageCode } from '../generated/prisma/enums.js';
import {
  type CategoryOption,
  type ParsedOperation,
  parsePhrase,
} from './phrase-rules.js';
import { userCategories } from './user-categories.js';

/** The furthest back a spoken day may go («на прошлой неделе» and the like). */
const MAX_DAYS_BACK = 60;
const MAX_OPERATIONS = 10;

export interface ParseResult {
  text: string;
  /** `ai`: Claude read it; `rules`: the server's own rules (no key, a failure or the day's limit) */
  source: 'ai' | 'rules';
  operations: ParsedOperation[];
}

const LANGUAGE_NAME: Record<LanguageCode, string> = {
  uz: 'Uzbek',
  ru: 'Russian',
  en: 'English',
};

const replySchema = z.object({
  operations: z
    .array(
      z.object({
        type: z.enum(['income', 'expense']),
        amount: z.union([z.number(), z.string()]),
        currency: z.string().nullish(),
        category: z.string().nullish(),
        date: z.string().nullish(),
        note: z.string().nullish(),
        confidence: z.number().nullish(),
      }),
    )
    .max(20),
});

/**
 * Voice and text input (spec: «Голосовой и текстовый ввод»): a phrase becomes operations to
 * check before saving. Claude (the fast model, counted as `parse_input`) reads it with the
 * user's categories; when it is not set up, fails, answers nonsense or the day's limit is
 * used up, the server's rules read it instead, so the user always gets cards to fix.
 * Lunex Pro (`voice_input`).
 */
@Injectable()
export class PhraseParserService {
  private readonly logger = new Logger(PhraseParserService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly ai: AiService,
  ) {}

  async parse(
    userId: string,
    text: string,
    now = new Date(),
  ): Promise<ParseResult> {
    await this.entitlements.assertFeature(userId, 'voice_input');
    const user = await this.prisma.users.findUniqueOrThrow({
      where: { id: userId },
      select: {
        language: true,
        timezone: true,
        baseCurrency: { select: { code: true } },
      },
    });
    const today = localDate(now, user.timezone);
    const categories = await userCategories(this.prisma, userId, user.language);

    if (this.ai.available) {
      try {
        const operations = await this.askClaude(
          userId,
          text,
          today,
          user.language,
          user.baseCurrency.code,
          categories,
          now,
        );
        if (operations.length > 0) return { text, source: 'ai', operations };
      } catch (error) {
        // Pro was checked above; anything else (no permission to use Claude, the limit, a
        // failure) falls back to the rules.
        if (
          error instanceof HttpException &&
          error.getStatus() === 403 &&
          !isConsentMissing(error)
        ) {
          throw error;
        }
        this.logger.warn(`Phrase read by rules: ${(error as Error).message}`);
      }
    }
    return {
      text,
      source: 'rules',
      operations: parsePhrase(text, today, categories).slice(0, MAX_OPERATIONS),
    };
  }

  private async askClaude(
    userId: string,
    text: string,
    today: CalendarDate,
    language: LanguageCode,
    baseCurrency: string,
    categories: CategoryOption[],
    now: Date,
  ): Promise<ParsedOperation[]> {
    // Short references keep the prompt small; they map back to ids below.
    const refs = new Map(categories.map((c, i) => [`c${i + 1}`, c]));
    const list = [...refs]
      .map(([ref, c]) => `${ref} ${c.type} ${c.names.join(' / ')}`)
      .join('\n');
    const reply = await this.ai.ask(
      userId,
      'parse_input',
      {
        tier: 'fast',
        maxTokens: 600,
        system: [
          'You turn a short phrase about money into operations for a personal finance app.',
          `The phrase is usually ${LANGUAGE_NAME[language]}, Russian, Uzbek or English, often from speech recognition with mistakes.`,
          `Today is ${today}. Amounts are in ${baseCurrency} unless the phrase names another currency.`,
          'Spoken numbers: «25 тысяч», «30 ming», «25k» = 25000; «8 млн», «8 mln» = 8000000.',
          'One phrase may hold several operations («обед 40 000 и такси 15 000»). Transfers between accounts are not operations here.',
          'Categories (ref, type, names):',
          list,
          'Answer with JSON only: {"operations":[{"type":"expense"|"income","amount":number,"currency":"ISO code"|null,"category":"ref"|null,"date":"YYYY-MM-DD","note":"short text in the phrase language"|null,"confidence":0..1}]}.',
          'currency is null unless the phrase names one. note says what it was for («Кофе», «Такси»), without the amount or the day.',
        ].join('\n'),
        messages: [{ role: 'user', content: text }],
      },
      now,
    );
    return this.readReply(reply.text, today, refs);
  }

  /** Keeps only what holds up: a positive amount, a known category of the right type, a day not ahead. */
  readReply(
    raw: string,
    today: CalendarDate,
    refs: Map<string, CategoryOption>,
  ): ParsedOperation[] {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return [];
    let parsed: z.infer<typeof replySchema>;
    try {
      const result = replySchema.safeParse(
        JSON.parse(raw.slice(start, end + 1)),
      );
      if (!result.success) return [];
      parsed = result.data;
    } catch {
      return [];
    }
    const earliest = addDays(today, -MAX_DAYS_BACK);
    return parsed.operations
      .flatMap((op): ParsedOperation[] => {
        const amount = Number(
          String(op.amount).replace(/\s/g, '').replace(',', '.'),
        );
        if (!Number.isFinite(amount) || amount <= 0) return [];
        const category = op.category ? refs.get(op.category) : undefined;
        const date =
          op.date &&
          /^\d{4}-\d{2}-\d{2}$/.test(op.date) &&
          op.date <= today &&
          op.date >= earliest
            ? op.date
            : today;
        const currency = op.currency?.toUpperCase();
        const note = op.note?.trim().slice(0, 255);
        return [
          {
            type: op.type,
            amount: String(Math.round(amount * 100) / 100),
            currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
            categoryId:
              category && category.type === op.type ? category.id : null,
            date,
            note: note || null,
            confidence: Math.min(1, Math.max(0, op.confidence ?? 0.8)),
          },
        ];
      })
      .slice(0, MAX_OPERATIONS);
  }
}

function isConsentMissing(error: HttpException): boolean {
  const body = error.getResponse();
  return (
    typeof body === 'object' &&
    (body as { code?: string }).code === 'ai_consent_required'
  );
}
