import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module.js';
import { GoalsModule } from '../goals/goals.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { AutoSaveQueueModule } from './auto-save-queue.module.js';
import { AutoSaveController } from './auto-save.controller.js';
import { AutoSaveProcessor } from './auto-save.processor.js';
import { AutoSaveService } from './auto-save.service.js';

@Module({
  imports: [
    AutoSaveQueueModule,
    FinanceModule,
    GoalsModule,
    NotificationsModule,
  ],
  controllers: [AutoSaveController],
  providers: [AutoSaveService, AutoSaveProcessor],
  exports: [AutoSaveService],
})
export class AutoSaveModule {}
