import {
  Environment,
  type JWSRenewalInfoDecodedPayload,
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload,
  SignedDataVerifier,
} from '@apple/app-store-server-library';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { APPLE_ROOT_CA_G3 } from './apple-root-ca.js';

/** The data was not signed by the App Store for this app, or not in an accepted environment. */
export class AppStoreVerificationError extends Error {}

const ENVIRONMENTS: Record<string, Environment> = {
  Production: Environment.PRODUCTION,
  Sandbox: Environment.SANDBOX,
  Xcode: Environment.XCODE,
};

/**
 * Checks what the App Store signed — a transaction from the device, a notification, renewal
 * info — with Apple's certificate chain (App Store Server Library), for the environments the
 * server accepts (`APP_STORE_ENVIRONMENTS`). Xcode's StoreKit testing signs locally: accepted
 * only where configured, in development.
 */
@Injectable()
export class AppStoreVerifier {
  private readonly logger = new Logger(AppStoreVerifier.name);
  private readonly verifiers = new Map<string, SignedDataVerifier>();

  constructor(config: ConfigService<Env, true>) {
    const bundleId = config.get('APP_STORE_BUNDLE_ID', { infer: true });
    const appAppleId = config.get('APP_STORE_APP_APPLE_ID', { infer: true });
    const roots = [Buffer.from(APPLE_ROOT_CA_G3)];
    for (const name of config.get('APP_STORE_ENVIRONMENTS', { infer: true })) {
      if (name === 'Production' && appAppleId === undefined) {
        this.logger.warn(
          'APP_STORE_APP_APPLE_ID is not set: Production purchases are not accepted',
        );
        continue;
      }
      this.verifiers.set(
        name,
        new SignedDataVerifier(
          roots,
          // Online revocation checks of Apple's certificates.
          name !== 'Xcode',
          ENVIRONMENTS[name],
          bundleId,
          appAppleId,
        ),
      );
    }
  }

  async transaction(signed: string): Promise<JWSTransactionDecodedPayload> {
    return this.run(signed, (verifier) =>
      verifier.verifyAndDecodeTransaction(signed),
    );
  }

  async renewalInfo(signed: string): Promise<JWSRenewalInfoDecodedPayload> {
    return this.run(signed, (verifier) =>
      verifier.verifyAndDecodeRenewalInfo(signed),
    );
  }

  async notification(signed: string): Promise<ResponseBodyV2DecodedPayload> {
    return this.run(signed, (verifier) =>
      verifier.verifyAndDecodeNotification(signed),
    );
  }

  /** The verifier of the environment the data names; a data of another one is refused. */
  private async run<T>(
    signed: string,
    verify: (verifier: SignedDataVerifier) => Promise<T>,
  ): Promise<T> {
    const verifier = this.verifiers.get(environmentOf(signed) ?? '');
    if (!verifier) {
      throw new AppStoreVerificationError('Not from an accepted environment');
    }
    try {
      return await verify(verifier);
    } catch (error) {
      throw new AppStoreVerificationError(
        error instanceof Error ? error.message : 'Verification failed',
      );
    }
  }
}

/** The environment written in the signed data, read before it is checked. */
function environmentOf(signed: string): string | null {
  try {
    const payload = JSON.parse(
      Buffer.from(signed.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { environment?: string; data?: { environment?: string } };
    return payload.environment ?? payload.data?.environment ?? null;
  } catch {
    return null;
  }
}
