import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { PrismaService } from '../database/prisma.service.js';
import {
  EMAIL_CODE_RETENTION_MS,
  MAINTENANCE_QUEUE,
  MaintenanceJob,
} from './queue.constants.js';

@Processor(MAINTENANCE_QUEUE)
export class MaintenanceProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(MaintenanceProcessor.name);

  constructor(
    @InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    // Idempotent: re-registering the same scheduler id on every start does not duplicate it.
    await this.queue.upsertJobScheduler(
      MaintenanceJob.PurgeExpiredEmailCodes,
      { every: 60 * 60 * 1000 },
      { name: MaintenanceJob.PurgeExpiredEmailCodes },
    );
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case MaintenanceJob.PurgeExpiredEmailCodes:
        return this.purgeExpiredEmailCodes();
      default:
        throw new Error(`Unknown maintenance job: ${job.name}`);
    }
  }

  async purgeExpiredEmailCodes(now = new Date()): Promise<{ deleted: number }> {
    const { count } = await this.prisma.emailVerifications.deleteMany({
      where: {
        expires_at: { lt: new Date(now.getTime() - EMAIL_CODE_RETENTION_MS) },
      },
    });
    if (count > 0) {
      this.logger.log(`Deleted ${count} expired email login codes`);
    }
    return { deleted: count };
  }
}
