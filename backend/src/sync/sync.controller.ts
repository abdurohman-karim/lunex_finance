import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { pullQuerySchema, pushSchema } from './sync.schemas.js';
import {
  type PullResult,
  type PushResult,
  SyncService,
} from './sync.service.js';

@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  /** Incremental download. Repeat while `hasMore`, then store `nextCursor` for next time. */
  @Get('changes')
  pull(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(pullQuerySchema))
    query: z.infer<typeof pullQuerySchema>,
  ): Promise<PullResult> {
    return this.sync.pull(user, query.cursor, query.limit);
  }

  /** Upload of the offline queue: one result per operation, in order. */
  @Post('push')
  @HttpCode(200)
  async push(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(pushSchema)) body: z.infer<typeof pushSchema>,
  ): Promise<{ results: PushResult[] }> {
    return { results: await this.sync.push(user.userId, body.operations) };
  }
}
