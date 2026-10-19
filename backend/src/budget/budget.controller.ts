import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { type BudgetSummary, BudgetService } from './budget.service.js';

@Controller('budget')
export class BudgetController {
  constructor(private readonly budget: BudgetService) {}

  /** The current budget month: plan vs actual, daily limit and «Можно потратить сегодня». */
  @Get('current')
  current(@CurrentUser() user: AuthUser): Promise<BudgetSummary> {
    return this.budget.current(user.userId);
  }
}
