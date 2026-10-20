import { Module } from '@nestjs/common';
import { AutoSaveQueueModule } from '../auto-save/auto-save-queue.module.js';
import { InsightsQueueModule } from '../insights/insights-queue.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { AccountsController } from './accounts/accounts.controller.js';
import { AccountsService } from './accounts/accounts.service.js';
import { CategoriesController } from './categories/categories.controller.js';
import { CategoriesService } from './categories/categories.service.js';
import { CbuClient } from './cbu.client.js';
import { FxRatesService } from './fx-rates.service.js';
import { FxService } from './fx.service.js';
import { RecurringController } from './recurring/recurring.controller.js';
import { RecurringService } from './recurring/recurring.service.js';
import { TransactionsController } from './transactions/transactions.controller.js';
import { TransactionsService } from './transactions/transactions.service.js';

@Module({
  imports: [NotificationsModule, AutoSaveQueueModule, InsightsQueueModule],
  controllers: [
    AccountsController,
    CategoriesController,
    RecurringController,
    TransactionsController,
  ],
  providers: [
    AccountsService,
    CategoriesService,
    CbuClient,
    FxRatesService,
    FxService,
    RecurringService,
    TransactionsService,
  ],
  exports: [
    AccountsService,
    CategoriesService,
    FxRatesService,
    FxService,
    RecurringService,
    TransactionsService,
  ],
})
export class FinanceModule {}
