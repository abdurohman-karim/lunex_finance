import { Body, Controller, Get, Put } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { type BudgetPlanInput, budgetPlanSchema } from './budget.schemas.js';
import {
  type BudgetSuggestions,
  type BudgetSummary,
  BudgetService,
} from './budget.service.js';

@Controller('budget')
export class BudgetController {
  constructor(private readonly budget: BudgetService) {}

  /** The current budget month: plan vs actual, daily limit and «Можно потратить сегодня». */
  @Get('current')
  current(@CurrentUser() user: AuthUser): Promise<BudgetSummary> {
    return this.budget.current(user.userId);
  }

  /** The wizard's plan for this month and the next ones; answers with the month recalculated. */
  @Put('current')
  setPlan(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(budgetPlanSchema)) body: BudgetPlanInput,
  ): Promise<BudgetSummary> {
    return this.budget.setPlan(user.userId, body);
  }

  /** Averages of the last three budget months, for the wizard's suggested limits. */
  @Get('suggestions')
  suggestions(@CurrentUser() user: AuthUser): Promise<BudgetSuggestions> {
    return this.budget.suggestions(user.userId);
  }
}
