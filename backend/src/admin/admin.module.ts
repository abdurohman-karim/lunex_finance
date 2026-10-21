import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AUTO_SAVE_QUEUE } from '../auto-save/auto-save.queue.js';
import { INSIGHTS_QUEUE } from '../insights/insights.queue.js';
import { NOTIFICATIONS_QUEUE } from '../notifications/notifications.constants.js';
import { MAINTENANCE_QUEUE } from '../queue/queue.constants.js';
import { AdminCatalogService } from './admin-catalog.service.js';
import { AdminController } from './admin.controller.js';
import { AdminGuard } from './admin.guard.js';
import { AdminMonitoringService } from './admin-monitoring.service.js';
import { AdminSettingsService } from './admin-settings.service.js';
import { AdminUsersService } from './admin-users.service.js';
import { AuditService } from './audit.service.js';

/** The admin panel's API; the panel itself is the static page at /admin. */
@Module({
  imports: [
    AuthModule,
    BullModule.registerQueue(
      { name: MAINTENANCE_QUEUE },
      { name: NOTIFICATIONS_QUEUE },
      { name: INSIGHTS_QUEUE },
      { name: AUTO_SAVE_QUEUE },
    ),
  ],
  controllers: [AdminController],
  providers: [
    AdminGuard,
    AuditService,
    AdminSettingsService,
    AdminCatalogService,
    AdminUsersService,
    AdminMonitoringService,
  ],
})
export class AdminModule {}
