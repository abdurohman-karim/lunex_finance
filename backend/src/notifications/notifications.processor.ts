import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { NotificationPlanner } from './notification-planner.service.js';
import {
  NOTIFICATIONS_QUEUE,
  NotificationJob,
} from './notifications.constants.js';
import { NotificationsService } from './notifications.service.js';

@Processor(NOTIFICATIONS_QUEUE)
export class NotificationsProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue,
    private readonly notifications: NotificationsService,
    private readonly planner: NotificationPlanner,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    // Idempotent: re-registering the same scheduler id on every start does not duplicate it.
    await this.queue.upsertJobScheduler(
      NotificationJob.Tick,
      { pattern: '*/5 * * * *' },
      { name: NotificationJob.Tick },
    );
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case NotificationJob.Deliver:
        return this.notifications.deliver((job.data as { id: string }).id);
      case NotificationJob.BudgetCheck:
        return this.planner.checkBudget(
          (job.data as { userId: string }).userId,
        );
      case NotificationJob.Tick:
        return this.planner.tick();
      default:
        throw new Error(`Unknown notification job: ${job.name}`);
    }
  }
}
