import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { uuidParamSchema } from '../common/schemas.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  type InsightDto,
  type InsightPage,
  InsightsService,
} from './insights.service.js';

const listQuerySchema = z.object({
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** The insights feed, the tip of the day and goal analysis (spec: «AI-инсайты и отчёты»). */
@Controller('insights')
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(listQuerySchema))
    query: z.infer<typeof listQuerySchema>,
  ): Promise<InsightPage> {
    return this.insights.list(user.userId, query.before, query.limit);
  }

  /** Today's tip, made on first request; free. */
  @Get('tip')
  tip(@CurrentUser() user: AuthUser): Promise<InsightDto> {
    return this.insights.dailyTip(user.userId);
  }

  /** Lunex Pro: conclusion, next step and score 0–100 for a goal. */
  @Post('goals/:id')
  @HttpCode(200)
  goal(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
  ): Promise<InsightDto> {
    return this.insights.goalAnalysis(user.userId, id);
  }

  @Post('read')
  @HttpCode(204)
  async readAll(@CurrentUser() user: AuthUser): Promise<void> {
    await this.insights.markAllRead(user.userId);
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
  ): Promise<InsightDto> {
    return this.insights.get(user.userId, id);
  }

  @Post(':id/read')
  @HttpCode(204)
  async read(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
  ): Promise<void> {
    await this.insights.markRead(user.userId, id);
  }
}
