import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { InsightsService } from './insights.service.js';
import { INSIGHTS_QUEUE, InsightsJob } from './insights.queue.js';

@Processor(INSIGHTS_QUEUE)
export class InsightsProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    @InjectQueue(INSIGHTS_QUEUE) private readonly queue: Queue,
    private readonly insights: InsightsService,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      InsightsJob.Hourly,
      { pattern: '20 * * * *' },
      { name: InsightsJob.Hourly },
    );
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case InsightsJob.Expense: {
        const { userId, transactionId } = job.data as {
          userId: string;
          transactionId: string;
        };
        return (
          (await this.insights.checkAnomaly(userId, transactionId))?.id ?? null
        );
      }
      case InsightsJob.Hourly:
        return this.insights.runHourly();
      default:
        throw new Error(`Unknown insights job: ${job.name}`);
    }
  }
}
