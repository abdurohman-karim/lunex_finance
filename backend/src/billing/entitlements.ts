import type {
  SubscriptionSource,
  SubscriptionStatus,
} from '../generated/prisma/enums.js';
import type { AppSettings } from '../common/app-settings.service.js';

/**
 * Lunex Pro features (spec: «Lunex Pro и пробный период»). Everything not listed here,
 * e.g. transactions, auto budget, Smart Save, recurring payments, widgets, is free.
 * Account and goal counts are capped through `limits` instead.
 */
export const PRO_FEATURES = [
  'category_limits',
  'budget_rollover',
  'auto_save',
  'voice_input',
  'receipt_scan',
  'ai_reports',
  'goal_analysis',
  'analytics_any_period',
  'export',
] as const;
export type ProFeature = (typeof PRO_FEATURES)[number];

/** Resources whose count is capped on Free. */
export type LimitedResource = 'accounts' | 'active_goals';

/** Free analytics: the current and the previous month. */
export const FREE_ANALYTICS_MONTHS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SubscriptionRow {
  source: SubscriptionSource;
  status: SubscriptionStatus;
  started_at: Date;
  expires_at: Date;
}

export interface AccessLimits {
  /** null = unlimited */
  accounts: number | null;
  activeGoals: number | null;
  aiMessagesPerDay: number;
  /** Months of history analytics may show, counting the current one; null = any period */
  analyticsMonths: number | null;
}

export interface Access {
  monetizationEnabled: boolean;
  plan: 'pro' | 'free';
  /** Why the user has Pro; null on Free */
  source: SubscriptionSource | 'monetization_off' | null;
  /** When the paid/trial/promo Pro ends; null when Pro comes from monetization being off, or on Free */
  expiresAt: Date | null;
  trial: {
    startedAt: Date;
    endsAt: Date;
    active: boolean;
    daysLeft: number;
  } | null;
  features: ProFeature[];
  limits: AccessLimits;
}

function isLive(subscription: SubscriptionRow, now: Date): boolean {
  return (
    (subscription.status === 'active' ||
      subscription.status === 'grace_period') &&
    subscription.expires_at > now
  );
}

/**
 * Spec rule «Доступ к Pro»: Pro while monetization is off, or with a live subscription
 * (active or in grace period, not yet expired). The longest-lasting live subscription wins.
 */
export function resolveAccess(
  settings: AppSettings,
  subscriptions: readonly SubscriptionRow[],
  now: Date,
): Access {
  const trialRow = subscriptions.find((s) => s.source === 'trial');
  const trial = trialRow
    ? {
        startedAt: trialRow.started_at,
        endsAt: trialRow.expires_at,
        active: isLive(trialRow, now),
        daysLeft: Math.max(
          0,
          Math.ceil((trialRow.expires_at.getTime() - now.getTime()) / DAY_MS),
        ),
      }
    : null;

  const live = subscriptions
    .filter((s) => isLive(s, now))
    .sort((a, b) => b.expires_at.getTime() - a.expires_at.getTime())[0];

  const monetizationEnabled = settings.monetization_enabled;
  const isPro = !monetizationEnabled || live !== undefined;

  const proLimits: AccessLimits = {
    accounts: null,
    activeGoals: null,
    aiMessagesPerDay: settings.ai_daily_limit_pro,
    analyticsMonths: null,
  };
  const freeLimits: AccessLimits = {
    accounts: settings.free_max_accounts,
    activeGoals: settings.free_max_goals,
    aiMessagesPerDay: settings.ai_daily_limit_free,
    analyticsMonths: FREE_ANALYTICS_MONTHS,
  };

  return {
    monetizationEnabled,
    plan: isPro ? 'pro' : 'free',
    source: !monetizationEnabled ? 'monetization_off' : (live?.source ?? null),
    expiresAt: monetizationEnabled ? (live?.expires_at ?? null) : null,
    trial,
    features: isPro ? [...PRO_FEATURES] : [],
    limits: isPro ? proLimits : freeLimits,
  };
}

/** The cap for a resource under the given access, or null when unlimited. */
export function limitFor(
  access: Access,
  resource: LimitedResource,
): number | null {
  return resource === 'accounts'
    ? access.limits.accounts
    : access.limits.activeGoals;
}
