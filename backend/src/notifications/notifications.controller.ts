import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { uuidParamSchema } from '../common/schemas.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  type NotificationPage,
  NotificationsService,
} from './notifications.service.js';

const pageQuerySchema = z.object({
  before: z.iso
    .datetime({ offset: true })
    .transform((value) => new Date(value))
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
type PageQuery = z.infer<typeof pageQuerySchema>;

/** The notification center: pushes that went out, newest first. */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(pageQuerySchema)) query: PageQuery,
  ): Promise<NotificationPage> {
    return this.notifications.list(user.userId, query.before, query.limit);
  }

  /** Everything seen: the center was opened. */
  @Post('opened')
  @HttpCode(204)
  async openedAll(@CurrentUser() user: AuthUser): Promise<void> {
    await this.notifications.markAllOpened(user.userId);
  }

  /** One push tapped. */
  @Post(':id/opened')
  @HttpCode(204)
  async opened(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
  ): Promise<void> {
    await this.notifications.markOpened(user.userId, id);
  }
}
