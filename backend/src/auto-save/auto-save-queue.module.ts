import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AUTO_SAVE_QUEUE, AutoSaveTrigger } from './auto-save.queue.js';

/** The auto-save queue and its trigger, for the operations code. */
@Module({
  imports: [BullModule.registerQueue({ name: AUTO_SAVE_QUEUE })],
  providers: [AutoSaveTrigger],
  exports: [AutoSaveTrigger, BullModule],
})
export class AutoSaveQueueModule {}
