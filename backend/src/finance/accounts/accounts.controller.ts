import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { z } from 'zod';
import { CurrentUser } from '../../auth/auth.decorators.js';
import type { AuthUser } from '../../auth/auth.types.js';
import {
  listQuerySchema,
  reorderSchema,
  uuidParamSchema,
} from '../../common/schemas.js';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import {
  createAccountSchema,
  updateAccountSchema,
} from './accounts.schemas.js';
import { type AccountDto, AccountsService } from './accounts.service.js';

@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(listQuerySchema))
    query: z.infer<typeof listQuerySchema>,
  ): Promise<AccountDto[]> {
    return this.accounts.list(user.userId, query.updatedSince);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createAccountSchema))
    body: z.infer<typeof createAccountSchema>,
  ): Promise<AccountDto> {
    return this.accounts.create(user.userId, body);
  }

  /** Drag-and-drop order: the listed ids get positions 0, 1, 2… */
  @Put('order')
  reorder(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(reorderSchema))
    body: z.infer<typeof reorderSchema>,
  ): Promise<AccountDto[]> {
    return this.accounts.reorder(user.userId, body.ids);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(updateAccountSchema))
    body: z.infer<typeof updateAccountSchema>,
  ): Promise<AccountDto> {
    return this.accounts.update(user.userId, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
  ): Promise<void> {
    await this.accounts.remove(user.userId, id);
  }
}
