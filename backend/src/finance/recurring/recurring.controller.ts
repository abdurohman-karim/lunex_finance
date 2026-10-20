import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../../auth/auth.decorators.js';
import type { AuthUser } from '../../auth/auth.types.js';
import { uuidParamSchema } from '../../common/schemas.js';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import type { TransactionDto } from '../transactions/transactions.service.js';
import {
  type CreateRecurringInput,
  type RecordRecurringInput,
  type SkipRecurringInput,
  type UpdateRecurringInput,
  createRecurringSchema,
  recordRecurringSchema,
  skipRecurringSchema,
  updateRecurringSchema,
} from './recurring.schemas.js';
import {
  type RecurringRuleDto,
  RecurringService,
} from './recurring.service.js';

/** Recurring payments and subscriptions; the app mostly uses the sync queue instead. */
@Controller('recurring')
export class RecurringController {
  constructor(private readonly recurring: RecurringService) {}

  @Get()
  list(@CurrentUser() user: AuthUser): Promise<RecurringRuleDto[]> {
    return this.recurring.list(user.userId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createRecurringSchema))
    body: CreateRecurringInput,
  ): Promise<RecurringRuleDto> {
    return this.recurring.create(user.userId, body);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(updateRecurringSchema))
    body: UpdateRecurringInput,
  ): Promise<RecurringRuleDto> {
    return this.recurring.update(user.userId, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
  ): Promise<void> {
    await this.recurring.remove(user.userId, id);
  }

  /** «Записать» a reminder's run */
  @Post(':id/record')
  @HttpCode(200)
  record(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(recordRecurringSchema))
    body: RecordRecurringInput,
  ): Promise<{ rule: RecurringRuleDto; transaction: TransactionDto }> {
    return this.recurring.record(user.userId, id, body);
  }

  /** «Пропустить» a run */
  @Post(':id/skip')
  @HttpCode(200)
  skip(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(skipRecurringSchema))
    body: SkipRecurringInput,
  ): Promise<RecurringRuleDto> {
    return this.recurring.skip(user.userId, id, body);
  }
}
