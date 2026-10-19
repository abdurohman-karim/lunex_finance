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
import { reorderSchema, uuidParamSchema } from '../../common/schemas.js';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import {
  createCategorySchema,
  listCategoriesQuerySchema,
  updateCategorySchema,
} from './categories.schemas.js';
import { type CategoryDto, CategoriesService } from './categories.service.js';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  /** System and own categories, ordered for this user; archived ones included with isArchived. */
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(listCategoriesQuerySchema))
    query: z.infer<typeof listCategoriesQuerySchema>,
  ): Promise<CategoryDto[]> {
    return this.categories.list(user.userId, query);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createCategorySchema))
    body: z.infer<typeof createCategorySchema>,
  ): Promise<CategoryDto> {
    return this.categories.create(user.userId, body);
  }

  @Put('order')
  reorder(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(reorderSchema))
    body: z.infer<typeof reorderSchema>,
  ): Promise<CategoryDto[]> {
    return this.categories.reorder(user.userId, body.ids);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(updateCategorySchema))
    body: z.infer<typeof updateCategorySchema>,
  ): Promise<CategoryDto> {
    return this.categories.update(user.userId, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
  ): Promise<void> {
    await this.categories.remove(user.userId, id);
  }
}
