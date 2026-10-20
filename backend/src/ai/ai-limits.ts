import type { Access, ProFeature } from '../billing/entitlements.js';
import type { AppSettings } from '../common/app-settings.service.js';
import {
  addDays,
  type CalendarDate,
  localDate,
  startOfLocalDay,
} from '../common/dates.js';
import type { AiFeature } from '../generated/prisma/enums.js';

export const AI_FEATURES = [
  'assistant',
  'parse_input',
  'receipt',
  'insight',
] as const satisfies readonly AiFeature[];

/** The Pro feature an AI feature belongs to; the assistant is on Free too, with fewer messages. */
export const PRO_FEATURE_OF: Record<AiFeature, ProFeature | null> = {
  assistant: null,
  parse_input: 'voice_input',
  receipt: 'receipt_scan',
  // Insights are made by the server; each kind is gated where it is made.
  insight: null,
};

/**
 * Requests a user may make a day (spec: «Лимит AI»): assistant messages by plan, set by
 * administrators; voice/text parsing and receipts a fair-use cap against abuse; insights,
 * which the server makes itself, none. null = no cap.
 */
export function dailyLimit(
  feature: AiFeature,
  access: Access,
  settings: AppSettings,
): number | null {
  switch (feature) {
    case 'assistant':
      return access.limits.aiMessagesPerDay;
    case 'parse_input':
      return settings.ai_daily_limit_parse;
    case 'receipt':
      return settings.ai_daily_limit_receipt;
    case 'insight':
      return null;
  }
}

/** The user's day the request counts in, and when the next one starts (limits reset then). */
export function usageDay(
  now: Date,
  timeZone: string,
): { date: CalendarDate; resetsAt: Date } {
  const date = localDate(now, timeZone);
  return { date, resetsAt: startOfLocalDay(addDays(date, 1), timeZone) };
}
