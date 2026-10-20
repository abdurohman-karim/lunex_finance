import { Module } from '@nestjs/common';
import { BudgetModule } from '../budget/budget.module.js';
import { NotificationPlanner } from './notification-planner.service.js';
import { NotificationsModule } from './notifications.module.js';
import { NotificationsProcessor } from './notifications.processor.js';

/** The notification jobs: they read the budget, which itself reports spending changes. */
@Module({
  imports: [NotificationsModule, BudgetModule],
  providers: [NotificationPlanner, NotificationsProcessor],
  exports: [NotificationPlanner],
})
export class NotificationJobsModule {}
