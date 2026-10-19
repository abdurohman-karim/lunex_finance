import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { FinanceModule } from '../finance/finance.module.js';
import { GoalsModule } from '../goals/goals.module.js';
import { ProfileModule } from '../profile/profile.module.js';
import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';

@Module({
  imports: [AuthModule, FinanceModule, GoalsModule, ProfileModule],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
