import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { AiService } from '../ai/ai.service.js';
import type { ClaudeTier } from '../ai/claude.client.js';
import type { InsightKind, LanguageCode } from '../generated/prisma/enums.js';
import type { InsightText } from './insight-texts.js';

/** Who wrote an insight: the model's id, or the template when the AI was not there. */
export const TEMPLATE_MODEL = 'template';

const LANGUAGE_NAME: Record<LanguageCode, string> = {
  uz: 'Uzbek (Latin script)',
  ru: 'Russian',
  en: 'English',
};

const WHAT: Record<InsightKind, string> = {
  daily_tip: 'a short tip for today about the user’s money',
  weekly_report: 'a weekly spending report',
  monthly_report: 'a monthly spending report',
  spending_analysis: 'an analysis of spending',
  goal_analysis: 'an analysis of a savings goal with its score out of 100',
  anomaly: 'a note about an unusually large expense',
  budget_forecast: 'a forecast of whether the month’s spending fits the plan',
};

const replySchema = z.object({
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(600),
  recommendation: z.string().trim().min(1).max(300),
});

/**
 * Puts an insight into words: Claude writes it from the facts the server worked out, in the
 * user's language, counted as the `insight` feature; without the AI, or when its answer does
 * not hold up, the template says the same from the same facts.
 */
@Injectable()
export class InsightWriter {
  private readonly logger = new Logger(InsightWriter.name);

  constructor(private readonly ai: AiService) {}

  async write(input: {
    userId: string;
    kind: InsightKind;
    language: LanguageCode;
    facts: object;
    template: InsightText;
    tier?: ClaudeTier;
  }): Promise<{ text: InsightText; model: string }> {
    if (!this.ai.available) {
      return { text: input.template, model: TEMPLATE_MODEL };
    }
    try {
      const reply = await this.ai.ask(input.userId, 'insight', {
        tier: input.tier ?? 'smart',
        maxTokens: 400,
        system: [
          `You write ${WHAT[input.kind]} for Lunex Finance, a personal finance app.`,
          `Write in ${LANGUAGE_NAME[input.language]}, warm and plain, no jargon, no emoji.`,
          'Use only the facts given; never invent numbers. Amounts are already formatted: copy them as they are.',
          'Answer with JSON only: {"title": "...", "summary": "...", "recommendation": "..."}.',
          'title: up to 60 characters; summary: one or two sentences with the key numbers; recommendation: one concrete next step.',
        ].join('\n'),
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              facts: input.facts,
              example: input.template,
            }),
          },
        ],
      });
      const text = parseReply(reply.text);
      if (text) return { text, model: reply.model };
      this.logger.warn(
        `Unreadable ${input.kind} from ${reply.model}; using the template`,
      );
    } catch (error) {
      this.logger.warn(
        `${input.kind} for ${input.userId} written by template: ${(error as Error).message}`,
      );
    }
    return { text: input.template, model: TEMPLATE_MODEL };
  }
}

/** The JSON object in the model's answer, if it is one we can show. */
export function parseReply(raw: string): InsightText | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = replySchema.safeParse(JSON.parse(raw.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
