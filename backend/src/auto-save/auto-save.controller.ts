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
import { z } from 'zod';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { uuidParamSchema } from '../common/schemas.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  type CreateAutoSaveInput,
  type UpdateAutoSaveInput,
  createAutoSaveSchema,
  listAutoSaveQuerySchema,
  updateAutoSaveSchema,
} from './auto-save.schemas.js';
import { type AutoSaveRuleDto, AutoSaveService } from './auto-save.service.js';

/** Auto-save rules of goals (Lunex Pro); the app mostly uses the sync queue instead. */
@Controller('auto-save')
export class AutoSaveController {
  constructor(private readonly autoSave: AutoSaveService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(listAutoSaveQuerySchema))
    query: z.infer<typeof listAutoSaveQuerySchema>,
  ): Promise<AutoSaveRuleDto[]> {
    return this.autoSave.list(user.userId, query.goalId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createAutoSaveSchema))
    body: CreateAutoSaveInput,
  ): Promise<AutoSaveRuleDto> {
    return this.autoSave.create(user.userId, body);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(updateAutoSaveSchema))
    body: UpdateAutoSaveInput,
  ): Promise<AutoSaveRuleDto> {
    return this.autoSave.update(user.userId, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
  ): Promise<void> {
    await this.autoSave.remove(user.userId, id);
  }
}
