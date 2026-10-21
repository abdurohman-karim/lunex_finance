import type {
  JWSRenewalInfoDecodedPayload,
  JWSTransactionDecodedPayload,
  ResponseBodyV2DecodedPayload,
} from '@apple/app-store-server-library';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { SubscriptionStatus } from '../../generated/prisma/enums.js';
import type { Access } from '../entitlements.js';
import { EntitlementsService } from '../entitlements.service.js';
import { AppStoreApi } from './app-store-api.js';
import {
  AppStoreVerificationError,
  AppStoreVerifier,
} from './app-store-verifier.js';

/** The Lunex Pro subscriptions in App Store Connect (one group, «Lunex Pro»). */
export const APP_STORE_PRODUCTS = ['lunex.pro.monthly', 'lunex.pro.yearly'];

/** What a subscription is, as the App Store says. */
interface StoreState {
  originalTransactionId: string;
  productId: string;
  environment: string;
  appAccountToken: string | null;
  startedAt: Date;
  expiresAt: Date;
  status: SubscriptionStatus;
  autoRenew: boolean | null;
}

const uuid = z.uuid();

const invalid = (message = 'The App Store did not sign this purchase') =>
  new BadRequestException({ code: 'invalid_purchase', message });

/**
 * Lunex Pro bought in the App Store (spec: «Lunex Pro и пробный период»). The app sends every
 * verified StoreKit 2 transaction (a purchase, a renewal it saw, a restore); App Store Server
 * Notifications V2 bring the rest — renewals, cancellations, refunds, billing grace periods.
 * Both become one `subscriptions` row per original transaction, which `resolveAccess` reads.
 * The app puts the user's id into `appAccountToken`, so a purchase belongs to that account.
 */
@Injectable()
export class AppStoreService {
  private readonly logger = new Logger(AppStoreService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly verifier: AppStoreVerifier,
    private readonly api: AppStoreApi,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** A transaction from the device: a purchase or a restore. */
  async syncTransaction(
    userId: string,
    signedTransaction: string,
    now = new Date(),
  ): Promise<Access> {
    let transaction: JWSTransactionDecodedPayload;
    try {
      transaction = await this.verifier.transaction(signedTransaction);
    } catch (error) {
      if (error instanceof AppStoreVerificationError) throw invalid();
      throw error;
    }
    let state = this.fromTransaction(transaction, null, now);
    if (!state) throw invalid('Not a Lunex Pro subscription');

    // The App Store's latest word, when the server may ask (a refund the device missed).
    const latest = await this.api.latest(
      state.originalTransactionId,
      state.environment,
    );
    if (latest) {
      try {
        const fresh = this.fromTransaction(
          await this.verifier.transaction(latest.signedTransactionInfo),
          latest.signedRenewalInfo
            ? await this.verifier.renewalInfo(latest.signedRenewalInfo)
            : null,
          now,
        );
        if (fresh) state = fresh;
      } catch (error) {
        this.logger.warn(`Latest App Store state ignored: ${String(error)}`);
      }
    }

    const owner = state.appAccountToken?.toLowerCase();
    if (owner && owner !== userId) throw this.elsewhere();
    await this.save(userId, state, 'device');
    return this.entitlements.getAccess(userId, now);
  }

  /**
   * An App Store Server Notification V2. Each one is kept by its UUID and applied once; an
   * invalid one is refused, and a failure to apply answers 500 so the App Store sends it again.
   */
  async notify(signedPayload: string, now = new Date()): Promise<void> {
    let payload: ResponseBodyV2DecodedPayload;
    try {
      payload = await this.verifier.notification(signedPayload);
    } catch (error) {
      if (error instanceof AppStoreVerificationError) {
        throw new BadRequestException({
          code: 'invalid_notification',
          message: 'The App Store did not sign this notification',
        });
      }
      throw error;
    }
    const notificationUuid = payload.notificationUUID ?? '';
    if (!notificationUuid) throw invalid('No notification id');

    let event = await this.prisma.storeEvents.findUnique({
      where: { notification_uuid: notificationUuid },
    });
    if (event?.processed_at) return;
    event ??= await this.prisma.storeEvents
      .create({
        data: {
          notification_uuid: notificationUuid,
          notification_type: String(payload.notificationType ?? 'UNKNOWN'),
          subtype: payload.subtype ? String(payload.subtype) : null,
          signed_payload: signedPayload,
        },
      })
      .catch(async (error: unknown) => {
        // The same notification at the same moment: the other delivery has it.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          return this.prisma.storeEvents.findUniqueOrThrow({
            where: { notification_uuid: notificationUuid },
          });
        }
        throw error;
      });

    try {
      const outcome = await this.apply(payload, now);
      await this.prisma.storeEvents.update({
        where: { id: event.id },
        data: {
          processed_at: new Date(),
          original_transaction_id: outcome.originalTransactionId,
          subscription_id: outcome.subscriptionId,
          error: outcome.note,
        },
      });
    } catch (error) {
      await this.prisma.storeEvents.update({
        where: { id: event.id },
        data: { error: String(error).slice(0, 500) },
      });
      throw error;
    }
  }

  private async apply(
    payload: ResponseBodyV2DecodedPayload,
    now: Date,
  ): Promise<{
    originalTransactionId: string | null;
    subscriptionId: string | null;
    note: string | null;
  }> {
    const signedTransaction = payload.data?.signedTransactionInfo;
    if (!signedTransaction) {
      return { originalTransactionId: null, subscriptionId: null, note: null };
    }
    const transaction = await this.verifier.transaction(signedTransaction);
    const renewal = payload.data?.signedRenewalInfo
      ? await this.verifier.renewalInfo(payload.data.signedRenewalInfo)
      : null;
    const state = this.fromTransaction(transaction, renewal, now);
    if (!state) {
      return {
        originalTransactionId: transaction.originalTransactionId ?? null,
        subscriptionId: null,
        note: 'not_lunex_pro',
      };
    }

    const type = String(payload.notificationType);
    const subtype = payload.subtype ? String(payload.subtype) : null;
    switch (type) {
      case 'REFUND':
      case 'REVOKE':
        state.status = 'revoked';
        break;
      case 'EXPIRED':
      case 'GRACE_PERIOD_EXPIRED':
        state.status = 'expired';
        break;
      case 'DID_FAIL_TO_RENEW':
        // In a billing grace period Pro stays until it ends; in a plain billing retry it does not.
        if (subtype === 'GRACE_PERIOD' && renewal?.gracePeriodExpiresDate) {
          state.status = 'grace_period';
          state.expiresAt = new Date(renewal.gracePeriodExpiresDate);
        } else {
          state.status = 'expired';
        }
        break;
      case 'DID_CHANGE_RENEWAL_STATUS':
        state.autoRenew = subtype === 'AUTO_RENEW_ENABLED';
        break;
    }

    const existing = await this.prisma.subscriptions.findUnique({
      where: { original_transaction_id: state.originalTransactionId },
      select: { user_id: true },
    });
    const owner =
      existing?.user_id ?? (await this.userOf(state.appAccountToken));
    if (!owner) {
      // Kept: the app sends the transaction itself once it can, and it is linked then.
      return {
        originalTransactionId: state.originalTransactionId,
        subscriptionId: null,
        note: 'unknown_account',
      };
    }
    const subscriptionId = await this.save(owner, state, 'notification');
    return {
      originalTransactionId: state.originalTransactionId,
      subscriptionId,
      note: null,
    };
  }

  /** The subscription as a transaction (and its renewal info) says; null when not Lunex Pro. */
  private fromTransaction(
    transaction: JWSTransactionDecodedPayload,
    renewal: JWSRenewalInfoDecodedPayload | null,
    now: Date,
  ): StoreState | null {
    if (
      !transaction.originalTransactionId ||
      !transaction.productId ||
      !APP_STORE_PRODUCTS.includes(transaction.productId) ||
      !transaction.expiresDate
    ) {
      return null;
    }
    const expiresAt = new Date(transaction.expiresDate);
    const status: SubscriptionStatus = transaction.revocationDate
      ? 'revoked'
      : expiresAt > now
        ? 'active'
        : 'expired';
    return {
      originalTransactionId: transaction.originalTransactionId,
      productId: transaction.productId,
      environment: String(transaction.environment),
      appAccountToken: transaction.appAccountToken ?? null,
      startedAt: new Date(
        transaction.originalPurchaseDate ??
          transaction.purchaseDate ??
          now.getTime(),
      ),
      expiresAt,
      status,
      autoRenew: renewal ? renewal.autoRenewStatus === 1 : null,
    };
  }

  /**
   * One row per original transaction. A renewal never moves the end of an active subscription
   * back (notifications may come out of order); a grace period, an expiry or a refund does.
   */
  private async save(
    userId: string,
    state: StoreState,
    from: 'device' | 'notification',
  ): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${state.originalTransactionId}))`;
      const existing = await tx.subscriptions.findUnique({
        where: { original_transaction_id: state.originalTransactionId },
      });
      if (existing && existing.user_id !== userId) throw this.elsewhere();
      if (!existing) {
        const created = await tx.subscriptions.create({
          data: {
            user_id: userId,
            source: 'app_store',
            product_id: state.productId,
            status: state.status,
            started_at: state.startedAt,
            expires_at: state.expiresAt,
            auto_renew: state.autoRenew ?? state.status === 'active',
            original_transaction_id: state.originalTransactionId,
            environment: state.environment,
          },
        });
        this.logger.log(
          `App Store subscription ${state.productId} (${state.status}) from the ${from}`,
        );
        return created.id;
      }
      // A grace period, an expiry or a refund sets its own end.
      const expiresAt =
        state.status === 'active' &&
        existing.status === 'active' &&
        existing.expires_at > state.expiresAt
          ? existing.expires_at
          : state.expiresAt;
      await tx.subscriptions.update({
        where: { id: existing.id },
        data: {
          product_id: state.productId,
          status: state.status,
          expires_at: expiresAt,
          ...(state.autoRenew === null ? {} : { auto_renew: state.autoRenew }),
          environment: state.environment,
        },
      });
      return existing.id;
    });
  }

  /** The account a purchase was made in, from the token the app set. */
  private async userOf(token: string | null): Promise<string | null> {
    const parsed = uuid.safeParse(token?.toLowerCase());
    if (!parsed.success) return null;
    const user = await this.prisma.users.findUnique({
      where: { id: parsed.data },
      select: { id: true },
    });
    return user?.id ?? null;
  }

  private elsewhere() {
    return new ConflictException({
      code: 'purchase_linked_elsewhere',
      message: 'This App Store purchase belongs to another Lunex account',
    });
  }
}
