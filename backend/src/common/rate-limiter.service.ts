import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.module.js';

/** Fixed-window counters in Redis, shared by every API instance. */
@Injectable()
export class RateLimiter {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Counts one hit for `key`; throws 429 with `retryAfter` once `limit` hits happened in the window. */
  async consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<void> {
    const redisKey = `lunex:rl:${key}`;
    const results = await this.redis
      .multi()
      .set(redisKey, 0, 'EX', windowSeconds, 'NX')
      .incr(redisKey)
      .ttl(redisKey)
      .exec();

    const count = Number(results?.[1]?.[1] ?? 0);
    const ttl = Number(results?.[2]?.[1] ?? windowSeconds);
    if (count > limit) {
      throw new HttpException(
        {
          code: 'rate_limited',
          message: 'Too many requests',
          retryAfter: ttl > 0 ? ttl : windowSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
