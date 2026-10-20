import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';

export const INSIGHTS_QUEUE = 'insights';

export const InsightsJob = {
  /** A new expense: is it unusual for its category? `{ userId, transactionId }` */
  Expense: 'expense',
  /** Hourly: weekly and monthly reports and the budget forecast at each user's hour */
  Hourly: 'hourly',
} as const;

/** Tells insights about new expenses, without the operations code depending on them. */
@Injectable()
export class InsightsTrigger {
  private readonly logger = new Logger(InsightsTrigger.name);

  constructor(@InjectQueue(INSIGHTS_QUEUE) private readonly queue: Queue) {}

  expenseCreated(userId: string, transactionId: string): void {
    this.queue
      .add(
        InsightsJob.Expense,
        { userId, transactionId },
        { jobId: `expense-${transactionId}`, delay: 2_000 },
      )
      .catch((error: Error) =>
        this.logger.warn(`Anomaly check not queued: ${error.message}`),
      );
  }
}
