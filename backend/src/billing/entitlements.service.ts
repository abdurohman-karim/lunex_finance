import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { AppSettingsService } from '../common/app-settings.service.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  type Access,
  type LimitedResource,
  type ProFeature,
  limitFor,
  resolveAccess,
} from './entitlements.js';

/** The one place that decides what a user may do on Free and on Pro. The server is the source of truth. */
@Injectable()
export class EntitlementsService {
  private readonly logger = new Logger(EntitlementsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AppSettingsService,
  ) {}

  async getAccess(userId: string, now = new Date()): Promise<Access> {
    const [settings, subscriptions] = await Promise.all([
      this.settings.getAll(),
      this.prisma.subscriptions.findMany({
        where: { user_id: userId },
        select: {
          source: true,
          status: true,
          started_at: true,
          expires_at: true,
        },
      }),
    ]);
    return resolveAccess(settings, subscriptions, now);
  }

  async assertFeature(userId: string, feature: ProFeature): Promise<void> {
    const access = await this.getAccess(userId);
    if (!access.features.includes(feature)) {
      throw new ForbiddenException({
        code: 'pro_required',
        message: 'This feature needs Lunex Pro',
        feature,
      });
    }
  }

  /**
   * Call before creating (or re-activating) a capped record. Existing records above the cap
   * stay readable after Pro ends; only new ones are refused.
   */
  async assertCanCreate(
    userId: string,
    resource: LimitedResource,
  ): Promise<void> {
    const access = await this.getAccess(userId);
    const limit = limitFor(access, resource);
    if (limit === null) {
      return;
    }
    const current = await this.count(userId, resource);
    if (current >= limit) {
      throw new ForbiddenException({
        code: 'free_limit_reached',
        message: 'The Free plan limit is reached; Lunex Pro removes it',
        resource,
        limit,
        current,
      });
    }
  }

  private count(userId: string, resource: LimitedResource): Promise<number> {
    if (resource === 'accounts') {
      return this.prisma.accounts.count({
        where: { user_id: userId, deleted_at: null, is_archived: false },
      });
    }
    return this.prisma.goals.count({
      where: { user_id: userId, deleted_at: null, status: 'active' },
    });
  }

  /** Housekeeping for the maintenance queue: access checks already ignore expired rows. */
  async expireSubscriptions(now = new Date()): Promise<{ expired: number }> {
    const { count } = await this.prisma.subscriptions.updateMany({
      where: {
        status: { in: ['active', 'grace_period'] },
        expires_at: { lte: now },
      },
      data: { status: 'expired' },
    });
    if (count > 0) {
      this.logger.log(`Marked ${count} subscriptions as expired`);
    }
    return { expired: count };
  }
}
