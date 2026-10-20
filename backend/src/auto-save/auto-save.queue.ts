import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';

export const AUTO_SAVE_QUEUE = 'auto-save';

export const AutoSaveJob = {
  /** A new income or expense: shares and round-ups of the account's rules, `{ userId, transactionId }` */
  Operation: 'operation',
  /** Hourly: scheduled amounts due by each user's morning */
  RunDue: 'run-due',
} as const;

/**
 * Tells auto-save about new operations. Lives apart from the rules so the operations code
 * can call it without depending on goals.
 */
@Injectable()
export class AutoSaveTrigger {
  private readonly logger = new Logger(AutoSaveTrigger.name);

  constructor(@InjectQueue(AUTO_SAVE_QUEUE) private readonly queue: Queue) {}

  operationCreated(userId: string, transactionId: string): void {
    this.queue
      .add(
        AutoSaveJob.Operation,
        { userId, transactionId },
        { jobId: `operation-${transactionId}` },
      )
      .catch((error: Error) =>
        this.logger.warn(`Auto-save check not queued: ${error.message}`),
      );
  }
}
