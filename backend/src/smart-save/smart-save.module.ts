import { Module } from '@nestjs/common';
import { BudgetModule } from '../budget/budget.module.js';
import { FinanceModule } from '../finance/finance.module.js';
import { GoalsModule } from '../goals/goals.module.js';
import { SmartSaveController } from './smart-save.controller.js';
import { SmartSaveService } from './smart-save.service.js';

@Module({
  imports: [BudgetModule, GoalsModule, FinanceModule],
  controllers: [SmartSaveController],
  providers: [SmartSaveService],
  exports: [SmartSaveService],
})
export class SmartSaveModule {}
