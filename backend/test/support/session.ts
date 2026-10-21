import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type request from 'supertest';
import { telegramHash } from '../../src/auth/providers/telegram.verifier.js';
import { REDIS } from '../../src/redis/redis.module.js';

/** Must match TELEGRAM_BOT_TOKEN in vitest.config.e2e.ts */
export const TEST_TELEGRAM_TOKEN = '123456:test-token';

export interface TestSession {
  userId: string;
  auth: { Authorization: string };
  refreshToken: string;
}

/**
 * A fresh account through Telegram sign-in, the shortest flow without email. `ai` gives the
 * permission to send the user's data to Claude, as the app asks before its AI features.
 */
export async function signUp(
  http: ReturnType<typeof request>,
  language: 'uz' | 'ru' | 'en' = 'ru',
  options: { ai?: boolean } = {},
): Promise<TestSession> {
  const data = {
    id: Math.floor(Math.random() * 1e12) + 1,
    first_name: 'Test',
    auth_date: Math.floor(Date.now() / 1000),
  };
  const res = await http
    .post('/v1/auth/telegram')
    .send({
      authData: { ...data, hash: telegramHash(data, TEST_TELEGRAM_TOKEN) },
      device: { id: randomUUID() },
      language,
    })
    .expect(200);
  const session = {
    userId: res.body.user.id as string,
    auth: { Authorization: `Bearer ${res.body.accessToken}` },
    refreshToken: res.body.refreshToken as string,
  };
  if (options.ai) {
    await http
      .patch('/v1/me/settings')
      .set(session.auth)
      .send({ aiConsent: true })
      .expect(200);
  }
  return session;
}

/** Rate-limit windows persist in Redis between runs; each test file starts clean. */
export async function resetRateLimits(app: INestApplication): Promise<void> {
  const redis = app.get<Redis>(REDIS);
  const keys = await redis.keys('lunex:rl:*');
  if (keys.length > 0) await redis.del(...keys);
}
