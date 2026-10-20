import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { AutoSaveService } from './auto-save.service.js';
import { AUTO_SAVE_QUEUE, AutoSaveJob } from './auto-save.queue.js';

@Processor(AUTO_SAVE_QUEUE)
export class AutoSaveProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    @InjectQueue(AUTO_SAVE_QUEUE) private readonly queue: Queue,
    private readonly autoSave: AutoSaveService,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    // Idempotent: re-registering the same scheduler id on every start does not duplicate it.
    await this.queue.upsertJobScheduler(
      AutoSaveJob.RunDue,
      { pattern: '10 * * * *' },
      { name: AutoSaveJob.RunDue },
    );
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case AutoSaveJob.Operation: {
        const { userId, transactionId } = job.data as {
          userId: string;
          transactionId: string;
        };
        return this.autoSave.onOperation(userId, transactionId);
      }
      case AutoSaveJob.RunDue:
        return this.autoSave.runDue();
      default:
        throw new Error(`Unknown auto-save job: ${job.name}`);
    }
  }
}
