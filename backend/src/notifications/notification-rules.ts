import {
  addDays,
  localDate,
  localDateTime,
  localMinutes,
} from '../common/dates.js';
import type { NotificationType } from '../generated/prisma/enums.js';

/** Pushes a day at most, besides the ones the user asked for. */
export const DAILY_LIMIT = 3;

/** Set up by the user themselves: not counted in the daily limit. */
export const REQUESTED: ReadonlySet<NotificationType> = new Set([
  'daily_reminder',
  'recurring_due',
  'auto_save_done',
  'auto_save_skipped',
]);

/** Shown quietly: no sound, no banner over what the user is doing. */
export const SILENT: ReadonlySet<NotificationType> = new Set([
  'auto_save_done',
]);

/** The evening reminder comes at the time the user chose, even inside quiet hours. */
export const IGNORES_QUIET_HOURS: ReadonlySet<NotificationType> = new Set([
  'daily_reminder',
]);

/** Local hour of the morning reminders: payments ahead, goal deadlines. */
export const REMINDER_HOUR = 9;

/** How long a failed delivery waits before the next try. */
export const RETRY_DELAY_MS = 5 * 60 * 1000;

export type SkipReason =
  | 'disabled'
  | 'expired'
  | 'not_needed'
  | 'quiet_hours'
  | 'daily_limit'
  | 'no_device'
  | 'user_deleted';

/** Skipped pushes the notification center still shows: what they said still matters. */
export const INBOX_SKIPS: SkipReason[] = [
  'daily_limit',
  'no_device',
  'quiet_hours',
];

export type NotificationSetting =
  | 'daily_reminder_enabled'
  | 'budget_alerts_enabled'
  | 'goal_alerts_enabled'
  | 'recurring_alerts_enabled'
  | 'smart_save_enabled'
  | 'weekly_report_enabled';

/** The switch in «Уведомления» that turns a kind on and off; null — always on. */
export const SETTING_OF: Record<NotificationType, NotificationSetting | null> =
  {
    daily_reminder: 'daily_reminder_enabled',
    budget_threshold: 'budget_alerts_enabled',
    budget_exceeded: 'budget_alerts_enabled',
    goal_milestone: 'goal_alerts_enabled',
    goal_deadline: 'goal_alerts_enabled',
    recurring_due: 'recurring_alerts_enabled',
    smart_save: 'smart_save_enabled',
    auto_save_done: 'goal_alerts_enabled',
    auto_save_skipped: 'goal_alerts_enabled',
    weekly_report: 'weekly_report_enabled',
    insight: null,
  };

/** Notification categories the app registers with its action buttons. */
export const CATEGORY_OF: Partial<Record<NotificationType, string>> = {
  smart_save: 'SMART_SAVE',
  recurring_due: 'RECURRING_DUE',
};

/** Minutes since midnight; `start` = `end` means no quiet hours. */
export interface QuietHours {
  start: number;
  end: number;
}

/** A `time` column (Prisma reads it as a date on 1970-01-01 UTC) in minutes since midnight. */
export function minutesOf(time: Date): number {
  return time.getUTCHours() * 60 + time.getUTCMinutes();
}

export function inQuietHours(minute: number, quiet: QuietHours): boolean {
  if (quiet.start === quiet.end) return false;
  return quiet.start < quiet.end
    ? minute >= quiet.start && minute < quiet.end
    : minute >= quiet.start || minute < quiet.end;
}

/** When the quiet hours `now` falls in end, on the user's wall clock. */
export function quietHoursEnd(
  now: Date,
  timezone: string,
  quiet: QuietHours,
): Date {
  const today = localDate(now, timezone);
  const day =
    localMinutes(now, timezone) >= quiet.end ? addDays(today, 1) : today;
  return localDateTime(day, quiet.end, timezone);
}

export interface DeliveryFacts {
  now: Date;
  timezone: string;
  type: NotificationType;
  expiresAt: Date;
  /** The kind is switched on in the user's settings */
  enabled: boolean;
  /** Still worth saying (no operations yet today, the payment not recorded…) */
  relevant: boolean;
  quiet: QuietHours;
  /** Pushes counted in the daily limit already sent today, local day */
  sentToday: number;
}

export type Decision =
  | { action: 'send' }
  | { action: 'defer'; until: Date }
  | { action: 'skip'; reason: SkipReason };

const skip = (reason: SkipReason): Decision => ({ action: 'skip', reason });

/** Whether a push goes now, waits for the end of quiet hours, or does not go at all. */
export function decide(facts: DeliveryFacts): Decision {
  if (facts.now >= facts.expiresAt) return skip('expired');
  if (!facts.enabled) return skip('disabled');
  if (!facts.relevant) return skip('not_needed');
  if (
    !IGNORES_QUIET_HOURS.has(facts.type) &&
    inQuietHours(localMinutes(facts.now, facts.timezone), facts.quiet)
  ) {
    const until = quietHoursEnd(facts.now, facts.timezone, facts.quiet);
    return until < facts.expiresAt
      ? { action: 'defer', until }
      : skip('quiet_hours');
  }
  if (!REQUESTED.has(facts.type) && facts.sentToday >= DAILY_LIMIT) {
    return skip('daily_limit');
  }
  return { action: 'send' };
}
