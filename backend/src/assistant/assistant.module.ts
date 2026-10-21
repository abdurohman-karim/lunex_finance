import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { BudgetModule } from '../budget/budget.module.js';
import { FinanceModule } from '../finance/finance.module.js';
import { GoalsModule } from '../goals/goals.module.js';
import { AssistantController } from './assistant.controller.js';
import { AssistantService } from './assistant.service.js';
import { AssistantTools } from './assistant-tools.js';

/** The AI assistant (`/v1/assistant`). */
@Module({
  imports: [AiModule, BudgetModule, FinanceModule, GoalsModule],
  controllers: [AssistantController],
  providers: [AssistantService, AssistantTools],
})
export class AssistantModule {}
