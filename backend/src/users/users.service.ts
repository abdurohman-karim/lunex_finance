import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { DeviceInput } from '../auth/auth.schemas.js';
import type { IssuedTokens, VerifiedIdentity } from '../auth/auth.types.js';
import { TokensService } from '../auth/tokens.service.js';
import { AppSettingsService } from '../common/app-settings.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { DEFAULT_CURRENCY_CODE } from '../database/reference-data.js';
import { Prisma } from '../generated/prisma/client.js';
import type {
  AuthProvider,
  LanguageCode,
  OnboardingFocus,
  UserRole,
} from '../generated/prisma/enums.js';

/** A deleted account can be restored by signing in again during this period, then it is purged. */
export const ACCOUNT_RESTORE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

type Db = PrismaService | Prisma.TransactionClient;

export interface Profile {
  id: string;
  displayName: string | null;
  email: string | null;
  role: UserRole;
  language: LanguageCode;
  baseCurrency: string;
  timezone: string;
  onboardingCompleted: boolean;
  onboardingFocus: OnboardingFocus | null;
  /** In the base currency; used by the budget until real income arrives */
  monthlyIncomeEstimate: string | null;
  identities: AuthProvider[];
  createdAt: Date;
  updatedAt: Date;
}

export interface SignInResult {
  user: Profile;
  isNewUser: boolean;
  tokens: IssuedTokens;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
    private readonly settings: AppSettingsService,
  ) {}

  /**
   * Finds the account for a verified identity, or links it to the account with the same
   * verified email, or creates a new account (with settings and the Pro trial).
   */
  async signIn(
    identity: VerifiedIdentity,
    device: DeviceInput,
    language: LanguageCode | undefined,
    now = new Date(),
  ): Promise<SignInResult> {
    try {
      return await this.signInOnce(identity, device, language, now);
    } catch (error) {
      // Two first sign-ins racing on the same identity or email: the retry finds the winner's rows.
      if (isUniqueViolation(error)) {
        return this.signInOnce(identity, device, language, now);
      }
      throw error;
    }
  }

  private async signInOnce(
    identity: VerifiedIdentity,
    device: DeviceInput,
    language: LanguageCode | undefined,
    now: Date,
  ): Promise<SignInResult> {
    const trialDays = await this.settings.get('trial_days');
    return this.prisma.$transaction(async (tx) => {
      const { user, isNewUser } = await this.resolveUser(
        tx,
        identity,
        language,
        trialDays,
        now,
      );
      await this.attachDevice(tx, user.id, device, now);
      const tokens = await this.tokens.issue(tx, user, device.id, now);
      return { user: await this.loadProfile(tx, user.id), isNewUser, tokens };
    });
  }

  private async resolveUser(
    tx: Prisma.TransactionClient,
    identity: VerifiedIdentity,
    language: LanguageCode | undefined,
    trialDays: number,
    now: Date,
  ): Promise<{ user: { id: string; role: UserRole }; isNewUser: boolean }> {
    const known = await tx.authIdentities.findUnique({
      where: {
        provider_subject: {
          provider: identity.provider,
          subject: identity.subject,
        },
      },
      include: { user: true },
    });
    if (known) {
      await tx.authIdentities.update({
        where: { id: known.id },
        data: { last_used_at: now, email: identity.email ?? known.email },
      });
      return {
        user: await this.restoreIfDeleted(tx, known.user),
        isNewUser: false,
      };
    }

    if (identity.email && identity.emailVerified) {
      const sameEmail = await tx.users.findUnique({
        where: { email: identity.email },
      });
      if (sameEmail) {
        await this.createIdentity(tx, sameEmail.id, identity, now);
        return {
          user: await this.restoreIfDeleted(tx, sameEmail),
          isNewUser: false,
        };
      }
    }

    const currency = await tx.currencies.findUniqueOrThrow({
      where: { code: DEFAULT_CURRENCY_CODE },
    });
    const verifiedEmail = identity.emailVerified ? identity.email : undefined;
    const user = await tx.users.create({
      data: {
        display_name: identity.displayName,
        email: verifiedEmail,
        email_verified_at: verifiedEmail ? now : null,
        language: language ?? 'uz',
        base_currency_id: currency.id,
        userSettings: { create: {} },
        authIdentities: {
          create: {
            provider: identity.provider,
            subject: identity.subject,
            email: identity.email,
            last_used_at: now,
          },
        },
        subscriptions: {
          create: {
            source: 'trial',
            status: 'active',
            started_at: now,
            expires_at: new Date(now.getTime() + trialDays * DAY_MS),
          },
        },
      },
    });
    return { user, isNewUser: true };
  }

  private async restoreIfDeleted<
    T extends { id: string; deleted_at: Date | null },
  >(tx: Prisma.TransactionClient, user: T): Promise<T> {
    if (!user.deleted_at) {
      return user;
    }
    this.logger.log(`Restoring deleted account ${user.id} on sign-in`);
    await tx.users.update({
      where: { id: user.id },
      data: { deleted_at: null },
    });
    return { ...user, deleted_at: null };
  }

  private async createIdentity(
    tx: Prisma.TransactionClient,
    userId: string,
    identity: VerifiedIdentity,
    now: Date,
  ): Promise<void> {
    await tx.authIdentities.create({
      data: {
        user_id: userId,
        provider: identity.provider,
        subject: identity.subject,
        email: identity.email,
        last_used_at: now,
      },
    });
  }

  private async attachDevice(
    tx: Prisma.TransactionClient,
    userId: string,
    device: DeviceInput,
    now: Date,
  ): Promise<void> {
    const existing = await tx.devices.findUnique({ where: { id: device.id } });
    if (existing && existing.user_id !== userId) {
      // Another account signs in on this installation: the previous account's sessions here end.
      await this.tokens.revokeDevice(device.id, now, tx);
    }
    const info = {
      model: device.model,
      os_version: device.osVersion,
      app_version: device.appVersion,
      last_seen_at: now,
    };
    await tx.devices.upsert({
      where: { id: device.id },
      create: { id: device.id, user_id: userId, ...info },
      update: { user_id: userId, ...info },
    });
  }

  async profile(userId: string): Promise<Profile> {
    return this.loadProfile(this.prisma, userId);
  }

  private async loadProfile(db: Db, userId: string): Promise<Profile> {
    const user = await db.users.findUnique({
      where: { id: userId },
      include: {
        baseCurrency: { select: { code: true, decimals: true } },
        authIdentities: { select: { provider: true }, orderBy: { id: 'asc' } },
      },
    });
    if (!user || user.deleted_at) {
      throw new NotFoundException({
        code: 'account_not_found',
        message: 'Account not found',
      });
    }
    return {
      id: user.id,
      displayName: user.display_name,
      email: user.email,
      role: user.role,
      language: user.language,
      baseCurrency: user.baseCurrency.code,
      timezone: user.timezone,
      onboardingCompleted: user.onboarding_completed_at !== null,
      onboardingFocus: user.onboarding_focus,
      monthlyIncomeEstimate:
        user.monthly_income_estimate?.toFixed(user.baseCurrency.decimals) ??
        null,
      identities: user.authIdentities.map((i) => i.provider),
      createdAt: user.created_at,
      updatedAt: user.updated_at,
    };
  }

  /** Adds a sign-in method to the signed-in account. One identity per provider. */
  async linkIdentity(
    userId: string,
    identity: VerifiedIdentity,
    now = new Date(),
  ): Promise<Profile> {
    return this.prisma.$transaction(async (tx) => {
      const owner = await tx.authIdentities.findUnique({
        where: {
          provider_subject: {
            provider: identity.provider,
            subject: identity.subject,
          },
        },
      });
      if (owner && owner.user_id !== userId) {
        throw new ConflictException({
          code: 'identity_in_use',
          message: 'This sign-in method belongs to another account',
        });
      }
      if (!owner) {
        const sameProvider = await tx.authIdentities.findFirst({
          where: { user_id: userId, provider: identity.provider },
        });
        if (sameProvider) {
          throw new ConflictException({
            code: 'provider_already_linked',
            message: `A ${identity.provider} sign-in is already linked`,
          });
        }
        await this.createIdentity(tx, userId, identity, now);
      }

      if (identity.email && identity.emailVerified) {
        const user = await tx.users.findUniqueOrThrow({
          where: { id: userId },
        });
        const taken = await tx.users.findUnique({
          where: { email: identity.email },
        });
        if (!user.email && !taken) {
          await tx.users.update({
            where: { id: userId },
            data: { email: identity.email, email_verified_at: now },
          });
        }
      }
      return this.loadProfile(tx, userId);
    });
  }

  async unlinkIdentity(
    userId: string,
    provider: AuthProvider,
  ): Promise<Profile> {
    return this.prisma.$transaction(async (tx) => {
      const identities = await tx.authIdentities.findMany({
        where: { user_id: userId },
      });
      if (!identities.some((i) => i.provider === provider)) {
        throw new NotFoundException({
          code: 'identity_not_linked',
          message: `No ${provider} sign-in is linked`,
        });
      }
      if (identities.length <= 1) {
        throw new ConflictException({
          code: 'last_identity',
          message: 'The last sign-in method cannot be removed',
        });
      }
      await tx.authIdentities.deleteMany({
        where: { user_id: userId, provider },
      });
      return this.loadProfile(tx, userId);
    });
  }

  /** Marks the account deleted and ends every session; signing in within 30 days restores it. */
  async deleteAccount(userId: string, now = new Date()): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.users.findUniqueOrThrow({ where: { id: userId } });
      if (user.role === 'admin') {
        throw new ForbiddenException({
          code: 'admin_account',
          message:
            'Administrator accounts are removed by another administrator',
        });
      }
      await tx.users.update({
        where: { id: userId },
        data: { deleted_at: user.deleted_at ?? now },
      });
      await this.tokens.revokeAllForUser(userId, now, tx);
    });
  }

  /** Hard-deletes accounts whose restore period is over. Run by the maintenance queue. */
  async purgeDeletedAccounts(now = new Date()): Promise<{ purged: number }> {
    const due = await this.prisma.users.findMany({
      where: {
        deleted_at: {
          lt: new Date(now.getTime() - ACCOUNT_RESTORE_DAYS * DAY_MS),
        },
        role: 'user',
      },
      select: { id: true },
      take: 100,
    });
    for (const { id } of due) {
      await this.purgeUser(id);
    }
    if (due.length > 0) {
      this.logger.log(`Purged ${due.length} deleted accounts`);
    }
    return { purged: due.length };
  }

  /** Every row owned by the user, children before parents (foreign keys are RESTRICT). */
  async purgeUser(userId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.users.findUnique({ where: { id: userId } });
      if (!user) {
        return;
      }
      const byUser = { user_id: userId };

      await tx.goalContributions.deleteMany({ where: byUser });
      await tx.goalMilestones.deleteMany({ where: { goal: byUser } });
      await tx.smartSaveSuggestions.deleteMany({ where: byUser });
      await tx.autoSaveRules.deleteMany({ where: byUser });
      await tx.aiMessages.deleteMany({ where: { conversation: byUser } });
      await tx.aiConversations.deleteMany({ where: byUser });
      await tx.aiInsights.deleteMany({ where: byUser });
      await tx.aiUsageDaily.deleteMany({ where: byUser });
      await tx.notifications.deleteMany({ where: byUser });
      await tx.transactionAttachments.deleteMany({ where: byUser });
      await tx.transactions.deleteMany({ where: byUser });
      await tx.recurringRules.deleteMany({ where: byUser });
      await tx.budgetCategoryLimits.deleteMany({ where: { budget: byUser } });
      await tx.budgets.deleteMany({ where: byUser });
      await tx.userSettings.deleteMany({ where: byUser });
      await tx.goals.deleteMany({ where: byUser });
      await tx.categoryPreferences.deleteMany({ where: byUser });
      await tx.categoryTranslations.deleteMany({ where: { category: byUser } });
      await tx.categories.deleteMany({
        where: { ...byUser, parent_id: { not: null } },
      });
      await tx.categories.deleteMany({ where: byUser });
      await tx.accounts.deleteMany({ where: byUser });
      await tx.storeEvents.updateMany({
        where: { subscription: byUser },
        data: { subscription_id: null },
      });
      await tx.subscriptions.deleteMany({ where: byUser });
      await tx.refreshTokens.deleteMany({ where: byUser });
      await tx.devices.deleteMany({ where: byUser });
      await tx.authIdentities.deleteMany({ where: byUser });
      await tx.appSettings.updateMany({
        where: { updated_by: userId },
        data: { updated_by: null },
      });
      if (user.email) {
        await tx.emailVerifications.deleteMany({
          where: { email: user.email },
        });
      }
      await tx.users.delete({ where: { id: userId } });
    });
  }
}
