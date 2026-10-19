import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { MaintenanceProcessor } from './maintenance.processor.js';
import { MAINTENANCE_QUEUE } from './queue.constants.js';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        connection: { url: config.get('REDIS_URL', { infer: true }) },
        prefix: 'lunex',
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { count: 1_000 },
          removeOnFail: { count: 5_000 },
        },
      }),
    }),
    BullModule.registerQueue({ name: MAINTENANCE_QUEUE }),
  ],
  providers: [MaintenanceProcessor],
  exports: [BullModule],
})
export class QueueModule {}
