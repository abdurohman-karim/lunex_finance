import {
  AppStoreServerAPIClient,
  Environment,
} from '@apple/app-store-server-library';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';

/** A subscription's latest state as the App Store has it, still signed. */
export interface LatestState {
  signedTransactionInfo: string;
  signedRenewalInfo: string | null;
}

/**
 * App Store Server API (with the In-App Purchase key): the latest transaction and renewal info
 * of a subscription, which catches what the device may not know yet (a refund, a renewal).
 * Without the key it answers null and the server goes by what the device and notifications say.
 */
@Injectable()
export class AppStoreApi {
  private readonly logger = new Logger(AppStoreApi.name);
  private readonly clients = new Map<string, AppStoreServerAPIClient>();

  constructor(config: ConfigService<Env, true>) {
    const keyId = config.get('APP_STORE_KEY_ID', { infer: true });
    const issuerId = config.get('APP_STORE_ISSUER_ID', { infer: true });
    const privateKey = config
      .get('APP_STORE_PRIVATE_KEY', { infer: true })
      ?.replaceAll('\\n', '\n');
    if (!keyId || !issuerId || !privateKey) return;
    const bundleId = config.get('APP_STORE_BUNDLE_ID', { infer: true });
    for (const [name, environment] of [
      ['Production', Environment.PRODUCTION],
      ['Sandbox', Environment.SANDBOX],
    ] as const) {
      this.clients.set(
        name,
        new AppStoreServerAPIClient(
          privateKey,
          keyId,
          issuerId,
          bundleId,
          environment,
        ),
      );
    }
  }

  async latest(
    originalTransactionId: string,
    environment: string,
  ): Promise<LatestState | null> {
    const client = this.clients.get(environment);
    if (!client) return null;
    try {
      const response = await client.getAllSubscriptionStatuses(
        originalTransactionId,
      );
      for (const group of response.data ?? []) {
        const last = group.lastTransactions?.find(
          (item) => item.originalTransactionId === originalTransactionId,
        );
        if (last?.signedTransactionInfo) {
          return {
            signedTransactionInfo: last.signedTransactionInfo,
            signedRenewalInfo: last.signedRenewalInfo ?? null,
          };
        }
      }
      return null;
    } catch (error) {
      // The device's signed transaction stands on its own; this only adds the latest news.
      this.logger.warn(
        `App Store Server API failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}
