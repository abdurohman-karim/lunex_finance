import { resolveAccess } from '../billing/entitlements.js';
import type { AppSettings } from '../common/app-settings.service.js';
import {
  type AppSettingKey,
  DEFAULT_APP_SETTINGS,
} from '../database/reference-data.js';
import { dailyLimit, usageDay } from './ai-limits.js';

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  const defaults = Object.fromEntries(
    (Object.keys(DEFAULT_APP_SETTINGS) as AppSettingKey[]).map((key) => [
      key,
      DEFAULT_APP_SETTINGS[key].value,
    ]),
  ) as AppSettings;
  return { ...defaults, ...overrides };
}

describe('AI limits', () => {
  const now = new Date('2026-10-20T06:00:00Z');

  it('gives the assistant 5 messages on Free and 50 on Pro, as administrators set', () => {
    const on = settings({ monetization_enabled: true });
    const free = resolveAccess(on, [], now);
    const pro = resolveAccess(settings(), [], now);
    expect(dailyLimit('assistant', free, on)).toBe(5);
    expect(dailyLimit('assistant', pro, on)).toBe(50);

    const changed = settings({
      monetization_enabled: true,
      ai_daily_limit_free: 3,
    });
    expect(
      dailyLimit('assistant', resolveAccess(changed, [], now), changed),
    ).toBe(3);
  });

  it('caps parsing and receipts for fair use and leaves insights alone', () => {
    const all = settings();
    const access = resolveAccess(all, [], now);
    expect(dailyLimit('parse_input', access, all)).toBe(100);
    expect(dailyLimit('receipt', access, all)).toBe(30);
    expect(dailyLimit('insight', access, all)).toBeNull();
  });

  it("counts in the user's day and resets at their midnight", () => {
    // 23:30 on the 20th in Tashkent is still the 20th there.
    const late = new Date('2026-10-20T18:30:00Z');
    expect(usageDay(late, 'Asia/Tashkent')).toEqual({
      date: '2026-10-20',
      resetsAt: new Date('2026-10-20T19:00:00Z'),
    });
    expect(usageDay(late, 'UTC').resetsAt).toEqual(
      new Date('2026-10-21T00:00:00Z'),
    );
    expect(
      usageDay(new Date('2026-10-20T19:00:00Z'), 'Asia/Tashkent').date,
    ).toBe('2026-10-21');
  });
});
