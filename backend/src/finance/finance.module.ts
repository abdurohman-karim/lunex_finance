import { Module } from '@nestjs/common';
import { AccountsController } from './accounts/accounts.controller.js';
import { AccountsService } from './accounts/accounts.service.js';
import { CategoriesController } from './categories/categories.controller.js';
import { CategoriesService } from './categories/categories.service.js';

@Module({
  controllers: [AccountsController, CategoriesController],
  providers: [AccountsService, CategoriesService],
  exports: [AccountsService, CategoriesService],
})
export class FinanceModule {}
