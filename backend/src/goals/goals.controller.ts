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
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { reorderSchema, uuidParamSchema } from '../common/schemas.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  contributionSchema,
  createGoalSchema,
  listContributionsQuerySchema,
  listGoalsQuerySchema,
  templatesQuerySchema,
  updateGoalSchema,
} from './goals.schemas.js';
import {
  type ContributionResult,
  type GoalDto,
  GoalsService,
} from './goals.service.js';

const idPipe = new ZodValidationPipe(uuidParamSchema);

@Controller('goals')
export class GoalsController {
  constructor(private readonly goals: GoalsService) {}

  /** Templates for «Новая цель»: phone, car, home, travel… */
  @Get('templates')
  async templates(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(templatesQuerySchema))
    query: z.infer<typeof templatesQuerySchema>,
  ) {
    return this.goals.templates(
      query.language ?? (await this.goals.language(user.userId)),
    );
  }

  /** Goals by priority, with progress, milestones and the contribution plan. */
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(listGoalsQuerySchema))
    query: z.infer<typeof listGoalsQuerySchema>,
  ): Promise<GoalDto[]> {
    return this.goals.list(user.userId, query.status);
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
  ): Promise<GoalDto> {
    return this.goals.get(user.userId, id);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createGoalSchema))
    body: z.infer<typeof createGoalSchema>,
  ): Promise<GoalDto> {
    return this.goals.create(user.userId, body);
  }

  @Put('order')
  reorder(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(reorderSchema))
    body: z.infer<typeof reorderSchema>,
  ): Promise<GoalDto[]> {
    return this.goals.reorder(user.userId, body.ids);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(updateGoalSchema))
    body: z.infer<typeof updateGoalSchema>,
  ): Promise<GoalDto> {
    return this.goals.update(user.userId, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
  ): Promise<void> {
    await this.goals.remove(user.userId, id);
  }

  @Get(':id/contributions')
  contributions(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
    @Query(new ZodValidationPipe(listContributionsQuerySchema))
    query: z.infer<typeof listContributionsQuerySchema>,
  ) {
    return this.goals.listContributions(
      user.userId,
      id,
      query.cursor,
      query.limit,
    );
  }

  /** Deposit or withdrawal; the response lists milestones to celebrate. */
  @Post(':id/contributions')
  contribute(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(contributionSchema))
    body: z.infer<typeof contributionSchema>,
  ): Promise<ContributionResult> {
    return this.goals.contribute(user.userId, id, body);
  }

  /** Undo of a contribution */
  @Delete(':id/contributions/:contributionId')
  removeContribution(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
    @Param('contributionId', idPipe) contributionId: string,
  ): Promise<GoalDto> {
    return this.goals.removeContribution(user.userId, id, contributionId);
  }
}
