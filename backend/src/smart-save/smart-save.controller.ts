import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { positiveMoneySchema, uuidParamSchema } from '../common/schemas.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  type AcceptResult,
  type SuggestionDto,
  SmartSaveService,
  type TodayResult,
} from './smart-save.service.js';

const acceptSchema = z.object({
  /** Lower amount chosen with the slider; omitted = the suggested amount */
  amount: positiveMoneySchema.optional(),
});

@Controller('smart-save')
export class SmartSaveController {
  constructor(private readonly smartSave: SmartSaveService) {}

  /** The card for the home screen: a suggestion, or why there is none today. */
  @Get('today')
  today(@CurrentUser() user: AuthUser): Promise<TodayResult> {
    return this.smartSave.today(user.userId);
  }

  /** «Отложить» */
  @Post(':id/accept')
  @HttpCode(200)
  accept(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(acceptSchema))
    body: z.infer<typeof acceptSchema>,
  ): Promise<AcceptResult> {
    return this.smartSave.accept(user.userId, id, body.amount);
  }

  /** «Не сегодня» */
  @Post(':id/decline')
  @HttpCode(200)
  decline(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
  ): Promise<SuggestionDto> {
    return this.smartSave.decline(user.userId, id);
  }
}
