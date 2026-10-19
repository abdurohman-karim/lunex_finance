import { Module } from '@nestjs/common';
import { AccountsController } from './accounts/accounts.controller.js';
import { AccountsService } from './accounts/accounts.service.js';
import { CategoriesController } from './categories/categories.controller.js';
import { CategoriesService } from './categories/categories.service.js';
import { FxService } from './fx.service.js';
import { TransactionsController } from './transactions/transactions.controller.js';
import { TransactionsService } from './transactions/transactions.service.js';

@Module({
  controllers: [
    AccountsController,
    CategoriesController,
    TransactionsController,
  ],
  providers: [
    AccountsService,
    CategoriesService,
    FxService,
    TransactionsService,
  ],
  exports: [AccountsService, CategoriesService, FxService, TransactionsService],
})
export class FinanceModule {}
