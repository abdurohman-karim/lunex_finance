import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { localDate } from '../common/dates.js';
import type { Env } from '../config/env.js';
import { FxRatesService } from '../finance/fx-rates.service.js';
import { RecurringService } from '../finance/recurring/recurring.service.js';
import { SmartSaveService } from '../smart-save/smart-save.service.js';
import { UsersService } from '../users/users.service.js';
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
    private readonly users: UsersService,
    private readonly entitlements: EntitlementsService,
    private readonly smartSave: SmartSaveService,
    private readonly recurring: RecurringService,
    private readonly fxRates: FxRatesService,
    private readonly config: ConfigService<Env, true>,
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
    await this.queue.upsertJobScheduler(
      MaintenanceJob.PurgeDeletedAccounts,
      { pattern: '0 3 * * *', tz: 'Asia/Tashkent' },
      { name: MaintenanceJob.PurgeDeletedAccounts },
    );
    await this.queue.upsertJobScheduler(
      MaintenanceJob.ExpireSubscriptions,
      { every: 60 * 60 * 1000 },
      { name: MaintenanceJob.ExpireSubscriptions },
    );
    await this.queue.upsertJobScheduler(
      MaintenanceJob.SmartSaveHourly,
      { pattern: '0 * * * *' },
      { name: MaintenanceJob.SmartSaveHourly },
    );
    await this.queue.upsertJobScheduler(
      MaintenanceJob.RecurringHourly,
      { pattern: '5 * * * *' },
      { name: MaintenanceJob.RecurringHourly },
    );
    if (this.config.get('CBU_RATES_URL', { infer: true }) === '') {
      // Loading is off (tests hand in rates of their own).
      await this.queue.removeJobScheduler(MaintenanceJob.FxRates);
      return;
    }
    // CBU sets rates in the day; a late run catches corrections.
    await this.queue.upsertJobScheduler(
      MaintenanceJob.FxRates,
      { pattern: '10 0,9,15 * * *', tz: 'Asia/Tashkent' },
      { name: MaintenanceJob.FxRates },
    );
    // A fresh install has no rates until the first run: one now, once a day of starts.
    await this.queue.add(
      MaintenanceJob.FxRates,
      {},
      { jobId: `fx-rates-start-${localDate(new Date(), 'Asia/Tashkent')}` },
    );
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case MaintenanceJob.PurgeExpiredEmailCodes:
        return this.purgeExpiredEmailCodes();
      case MaintenanceJob.PurgeDeletedAccounts:
        return this.users.purgeDeletedAccounts();
      case MaintenanceJob.ExpireSubscriptions:
        return this.entitlements.expireSubscriptions();
      case MaintenanceJob.SmartSaveHourly: {
        const now = new Date();
        const expired = await this.smartSave.expireSuggestions(now);
        const prepared = await this.smartSave.prepareMorningSuggestions(now);
        return { ...expired, ...prepared };
      }
      case MaintenanceJob.RecurringHourly:
        return this.recurring.runDue();
      case MaintenanceJob.FxRates:
        return this.fxRates.refresh();
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
