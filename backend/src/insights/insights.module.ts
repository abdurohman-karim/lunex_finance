import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { BudgetModule } from '../budget/budget.module.js';
import { GoalsModule } from '../goals/goals.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { InsightWriter } from './insight-writer.service.js';
import { InsightsQueueModule } from './insights-queue.module.js';
import { InsightsController } from './insights.controller.js';
import { InsightsProcessor } from './insights.processor.js';
import { InsightsService } from './insights.service.js';

/** AI insights: the tip of the day, reports, anomalies, the forecast and goal analysis. */
@Module({
  imports: [
    AiModule,
    BudgetModule,
    GoalsModule,
    NotificationsModule,
    InsightsQueueModule,
  ],
  controllers: [InsightsController],
  providers: [InsightsService, InsightWriter, InsightsProcessor],
  exports: [InsightsService],
})
export class InsightsModule {}
