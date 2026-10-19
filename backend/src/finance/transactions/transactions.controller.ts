import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { z } from 'zod';
import { CurrentUser } from '../../auth/auth.decorators.js';
import type { AuthUser } from '../../auth/auth.types.js';
import { uuidParamSchema } from '../../common/schemas.js';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import {
  createTransactionSchema,
  frequentCategoriesQuerySchema,
  listTransactionsQuerySchema,
  updateTransactionSchema,
} from './transactions.schemas.js';
import {
  type TransactionDto,
  type TransactionPage,
  TransactionsService,
} from './transactions.service.js';

@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactions: TransactionsService) {}

  /** History, newest first, with filters, search, cursor paging and day totals. */
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(listTransactionsQuerySchema))
    query: z.infer<typeof listTransactionsQuerySchema>,
  ): Promise<TransactionPage> {
    return this.transactions.list(user.userId, query);
  }

  /** Category ids to show first in the quick-add grid. */
  @Get('frequent-categories')
  async frequentCategories(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(frequentCategoriesQuerySchema))
    query: z.infer<typeof frequentCategoriesQuerySchema>,
  ): Promise<{ categoryIds: string[] }> {
    return {
      categoryIds: await this.transactions.frequentCategories(
        user.userId,
        query.type,
      ),
    };
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
  ): Promise<TransactionDto> {
    return this.transactions.get(user.userId, id);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createTransactionSchema))
    body: z.infer<typeof createTransactionSchema>,
  ): Promise<TransactionDto> {
    return this.transactions.create(user.userId, body);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(updateTransactionSchema))
    body: z.infer<typeof updateTransactionSchema>,
  ): Promise<TransactionDto> {
    return this.transactions.update(user.userId, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
  ): Promise<void> {
    await this.transactions.remove(user.userId, id);
  }

  /** «Отменить» after a delete */
  @Post(':id/restore')
  @HttpCode(200)
  restore(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
  ): Promise<TransactionDto> {
    return this.transactions.restore(user.userId, id);
  }
}
