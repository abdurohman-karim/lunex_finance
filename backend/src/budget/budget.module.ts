import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module.js';
import { BudgetController } from './budget.controller.js';
import { BudgetService } from './budget.service.js';

@Module({
  imports: [FinanceModule],
  controllers: [BudgetController],
  providers: [BudgetService],
  exports: [BudgetService],
})
export class BudgetModule {}
