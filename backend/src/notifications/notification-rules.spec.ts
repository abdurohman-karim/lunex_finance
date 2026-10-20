import {
  DAILY_LIMIT,
  type DeliveryFacts,
  decide,
  inQuietHours,
  minutesOf,
  quietHoursEnd,
} from './notification-rules.js';

const TZ = 'Asia/Tashkent';
const NIGHT = { start: 22 * 60, end: 8 * 60 };
/** A wall-clock time in Tashkent (UTC+5) on 20 October 2026. */
const at = (time: string, day = '2026-10-20') =>
  new Date(`${day}T${time}:00+05:00`);

const facts = (overrides: Partial<DeliveryFacts> = {}): DeliveryFacts => ({
  now: at('12:00'),
  timezone: TZ,
  type: 'budget_threshold',
  expiresAt: at('23:59', '2026-10-31'),
  enabled: true,
  relevant: true,
  quiet: NIGHT,
  sentToday: 0,
  ...overrides,
});

describe('quiet hours', () => {
  it('spans midnight or a part of one day', () => {
    expect(inQuietHours(23 * 60, NIGHT)).toBe(true);
    expect(inQuietHours(7 * 60 + 59, NIGHT)).toBe(true);
    expect(inQuietHours(8 * 60, NIGHT)).toBe(false);
    expect(inQuietHours(21 * 60 + 59, NIGHT)).toBe(false);
    const nap = { start: 13 * 60, end: 15 * 60 };
    expect(inQuietHours(14 * 60, nap)).toBe(true);
    expect(inQuietHours(15 * 60, nap)).toBe(false);
    expect(inQuietHours(3 * 60, { start: 0, end: 0 })).toBe(false);
  });

  it('end on the same morning or the next one', () => {
    expect(quietHoursEnd(at('23:30'), TZ, NIGHT)).toEqual(
      at('08:00', '2026-10-21'),
    );
    expect(quietHoursEnd(at('06:10'), TZ, NIGHT)).toEqual(at('08:00'));
  });

  it('reads time columns as minutes', () => {
    expect(minutesOf(new Date('1970-01-01T21:30:00Z'))).toBe(21 * 60 + 30);
  });
});

describe('decide', () => {
  it('sends in the daytime', () => {
    expect(decide(facts())).toEqual({ action: 'send' });
  });

  it('waits for the end of quiet hours, or drops what would be stale by then', () => {
    expect(decide(facts({ now: at('23:10') }))).toEqual({
      action: 'defer',
      until: at('08:00', '2026-10-21'),
    });
    expect(
      decide(facts({ now: at('23:10'), expiresAt: at('00:00', '2026-10-21') })),
    ).toEqual({ action: 'skip', reason: 'quiet_hours' });
  });

  it('brings the evening reminder at the chosen time, quiet hours or not', () => {
    expect(decide(facts({ type: 'daily_reminder', now: at('22:30') }))).toEqual(
      { action: 'send' },
    );
  });

  it('keeps to three a day, besides what the user asked for', () => {
    const full = { sentToday: DAILY_LIMIT };
    expect(decide(facts(full))).toEqual({
      action: 'skip',
      reason: 'daily_limit',
    });
    expect(decide(facts({ ...full, type: 'daily_reminder' }))).toEqual({
      action: 'send',
    });
    expect(decide(facts({ ...full, type: 'recurring_due' }))).toEqual({
      action: 'send',
    });
  });

  it('drops expired, switched off and no longer needed ones first', () => {
    expect(decide(facts({ expiresAt: at('11:00') }))).toEqual({
      action: 'skip',
      reason: 'expired',
    });
    expect(decide(facts({ enabled: false, now: at('23:00') }))).toEqual({
      action: 'skip',
      reason: 'disabled',
    });
    expect(decide(facts({ relevant: false, sentToday: 5 }))).toEqual({
      action: 'skip',
      reason: 'not_needed',
    });
  });
});
