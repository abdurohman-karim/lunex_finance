import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { TelegramVerifier, telegramHash } from './telegram.verifier.js';

const BOT_TOKEN = '123456:test-token';
const now = new Date('2026-10-19T10:00:00Z');
const nowSeconds = Math.floor(now.getTime() / 1000);

function config(token: string | undefined): ConfigService<Env, true> {
  return { get: () => token } as unknown as ConfigService<Env, true>;
}

function signed(data: Record<string, string | number>) {
  return {
    ...data,
    hash: telegramHash(data as never, BOT_TOKEN),
  } as never;
}

describe('TelegramVerifier', () => {
  const verifier = new TelegramVerifier(config(BOT_TOKEN));
  const base = {
    id: 42,
    first_name: 'Asadbek',
    username: 'asadbek',
    auth_date: nowSeconds - 30,
  };

  it('accepts correctly signed, fresh data', () => {
    expect(verifier.verify(signed(base), now)).toEqual({
      provider: 'telegram',
      subject: '42',
      emailVerified: false,
      displayName: 'Asadbek',
    });
  });

  it('rejects data changed after signing', () => {
    const data = { ...(signed(base) as object), id: 43 } as never;
    expect(() => verifier.verify(data, now)).toThrow(/signature/);
  });

  it('rejects data signed with another bot token', () => {
    const data = {
      ...base,
      hash: telegramHash(base as never, '999:other'),
    } as never;
    expect(() => verifier.verify(data, now)).toThrow(/signature/);
  });

  it('rejects stale login data', () => {
    const data = signed({ ...base, auth_date: nowSeconds - 16 * 60 });
    expect(() => verifier.verify(data, now)).toThrow(/too old/);
  });

  it('is disabled without a bot token', () => {
    expect(() =>
      new TelegramVerifier(config(undefined)).verify(signed(base), now),
    ).toThrow(/not configured/);
  });

  it('builds the check string from keys in alphabetical order', () => {
    // Field order in the payload must not matter.
    const reordered = {
      username: base.username,
      auth_date: base.auth_date,
      id: base.id,
      first_name: base.first_name,
    };
    expect(telegramHash(reordered as never, BOT_TOKEN)).toBe(
      telegramHash(base as never, BOT_TOKEN),
    );
  });
});
