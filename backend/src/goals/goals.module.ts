import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module.js';
import { GoalsController } from './goals.controller.js';
import { GoalsService } from './goals.service.js';

@Module({
  imports: [FinanceModule],
  controllers: [GoalsController],
  providers: [GoalsService],
  exports: [GoalsService],
})
export class GoalsModule {}
