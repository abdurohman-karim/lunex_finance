import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { INSIGHTS_QUEUE, InsightsTrigger } from './insights.queue.js';

/** The insights queue and its trigger, for the operations code. */
@Module({
  imports: [BullModule.registerQueue({ name: INSIGHTS_QUEUE })],
  providers: [InsightsTrigger],
  exports: [InsightsTrigger, BullModule],
})
export class InsightsQueueModule {}
