import { Module } from '@nestjs/common';
import { AccountsController } from './accounts/accounts.controller.js';
import { AccountsService } from './accounts/accounts.service.js';
import { CategoriesController } from './categories/categories.controller.js';
import { CategoriesService } from './categories/categories.service.js';
import { FxService } from './fx.service.js';
import { RecurringController } from './recurring/recurring.controller.js';
import { RecurringService } from './recurring/recurring.service.js';
import { TransactionsController } from './transactions/transactions.controller.js';
import { TransactionsService } from './transactions/transactions.service.js';

@Module({
  controllers: [
    AccountsController,
    CategoriesController,
    RecurringController,
    TransactionsController,
  ],
  providers: [
    AccountsService,
    CategoriesService,
    FxService,
    RecurringService,
    TransactionsService,
  ],
  exports: [
    AccountsService,
    CategoriesService,
    FxService,
    RecurringService,
    TransactionsService,
  ],
})
export class FinanceModule {}
