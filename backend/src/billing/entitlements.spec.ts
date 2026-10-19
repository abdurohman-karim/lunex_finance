import type { AppSettings } from '../common/app-settings.service.js';
import {
  DEFAULT_APP_SETTINGS,
  type AppSettingKey,
} from '../database/reference-data.js';
import {
  FREE_ANALYTICS_MONTHS,
  PRO_FEATURES,
  type SubscriptionRow,
  resolveAccess,
} from './entitlements.js';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-10-19T12:00:00Z');

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  const defaults = Object.fromEntries(
    (Object.keys(DEFAULT_APP_SETTINGS) as AppSettingKey[]).map((key) => [
      key,
      DEFAULT_APP_SETTINGS[key].value,
    ]),
  ) as AppSettings;
  return { ...defaults, ...overrides };
}

function trial(daysFromStart: number, length = 30): SubscriptionRow {
  const started = new Date(now.getTime() - daysFromStart * DAY);
  return {
    source: 'trial',
    status: 'active',
    started_at: started,
    expires_at: new Date(started.getTime() + length * DAY),
  };
}

describe('resolveAccess', () => {
  it('gives everyone Pro while monetization is off, even without a subscription', () => {
    const access = resolveAccess(settings(), [], now);
    expect(access).toMatchObject({
      monetizationEnabled: false,
      plan: 'pro',
      source: 'monetization_off',
      expiresAt: null,
      trial: null,
    });
    expect(access.features).toEqual([...PRO_FEATURES]);
    expect(access.limits).toEqual({
      accounts: null,
      activeGoals: null,
      aiMessagesPerDay: 50,
      analyticsMonths: null,
    });
  });

  it('still reports the trial while monetization is off, for when it is turned on', () => {
    const access = resolveAccess(settings(), [trial(3)], now);
    expect(access.trial).toMatchObject({ active: true, daysLeft: 27 });
  });

  it('gives Pro during the trial once monetization is on', () => {
    const subscription = trial(10);
    const access = resolveAccess(
      settings({ monetization_enabled: true }),
      [subscription],
      now,
    );
    expect(access).toMatchObject({
      plan: 'pro',
      source: 'trial',
      expiresAt: subscription.expires_at,
      trial: { active: true, daysLeft: 20 },
    });
  });

  it('falls back to Free with Free limits when the trial is over', () => {
    const access = resolveAccess(
      settings({ monetization_enabled: true }),
      [trial(31)],
      now,
    );
    expect(access).toMatchObject({
      plan: 'free',
      source: null,
      expiresAt: null,
      features: [],
      trial: { active: false, daysLeft: 0 },
    });
    expect(access.limits).toEqual({
      accounts: 2,
      activeGoals: 3,
      aiMessagesPerDay: 5,
      analyticsMonths: FREE_ANALYTICS_MONTHS,
    });
  });

  it('uses the limits an administrator configured', () => {
    const access = resolveAccess(
      settings({
        monetization_enabled: true,
        free_max_accounts: 4,
        free_max_goals: 1,
        ai_daily_limit_free: 2,
      }),
      [],
      now,
    );
    expect(access.limits).toMatchObject({
      accounts: 4,
      activeGoals: 1,
      aiMessagesPerDay: 2,
    });
  });

  it('keeps Pro in the App Store grace period', () => {
    const access = resolveAccess(
      settings({ monetization_enabled: true }),
      [
        trial(40),
        {
          source: 'app_store',
          status: 'grace_period',
          started_at: new Date(now.getTime() - 30 * DAY),
          expires_at: new Date(now.getTime() + 3 * DAY),
        },
      ],
      now,
    );
    expect(access).toMatchObject({ plan: 'pro', source: 'app_store' });
  });

  it('ignores expired and revoked subscriptions', () => {
    const access = resolveAccess(
      settings({ monetization_enabled: true }),
      [
        {
          source: 'app_store',
          status: 'revoked',
          started_at: new Date(now.getTime() - DAY),
          expires_at: new Date(now.getTime() + 300 * DAY),
        },
        {
          source: 'promo',
          status: 'expired',
          started_at: new Date(now.getTime() - DAY),
          expires_at: new Date(now.getTime() + 10 * DAY),
        },
      ],
      now,
    );
    expect(access.plan).toBe('free');
  });

  it('picks the live subscription that lasts longest', () => {
    const promo: SubscriptionRow = {
      source: 'promo',
      status: 'active',
      started_at: now,
      expires_at: new Date(now.getTime() + 90 * DAY),
    };
    const access = resolveAccess(
      settings({ monetization_enabled: true }),
      [trial(5), promo],
      now,
    );
    expect(access).toMatchObject({
      source: 'promo',
      expiresAt: promo.expires_at,
    });
  });
});
