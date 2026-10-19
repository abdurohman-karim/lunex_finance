import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import type { TelegramAuthData } from '../auth.schemas.js';
import type { VerifiedIdentity } from '../auth.types.js';

/** Login data older than this is refused, so a captured payload cannot be replayed later. */
export const TELEGRAM_AUTH_MAX_AGE_SECONDS = 15 * 60;

/** https://core.telegram.org/widgets/login#checking-authorization */
export function telegramHash(
  data: Omit<TelegramAuthData, 'hash'>,
  botToken: string,
): string {
  const dataCheckString = Object.entries(data)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHash('sha256').update(botToken).digest();
  return createHmac('sha256', secret).update(dataCheckString).digest('hex');
}

@Injectable()
export class TelegramVerifier {
  constructor(private readonly config: ConfigService<Env, true>) {}

  verify(authData: TelegramAuthData, now = new Date()): VerifiedIdentity {
    const botToken = this.config.get('TELEGRAM_BOT_TOKEN', { infer: true });
    if (!botToken) {
      throw new ServiceUnavailableException({
        code: 'provider_disabled',
        message: 'Telegram sign-in is not configured',
      });
    }

    const { hash, ...data } = authData;
    const expected = Buffer.from(telegramHash(data, botToken), 'hex');
    const actual = Buffer.from(hash, 'hex');
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new UnauthorizedException({
        code: 'invalid_telegram_auth',
        message: 'Telegram login data signature is invalid',
      });
    }

    const age = Math.floor(now.getTime() / 1000) - data.auth_date;
    if (age > TELEGRAM_AUTH_MAX_AGE_SECONDS || age < -60) {
      throw new UnauthorizedException({
        code: 'telegram_auth_expired',
        message: 'Telegram login data is too old',
      });
    }

    const name = [data.first_name, data.last_name].filter(Boolean).join(' ');
    return {
      provider: 'telegram',
      subject: String(data.id),
      emailVerified: false,
      displayName: name || data.username || undefined,
    };
  }
}
