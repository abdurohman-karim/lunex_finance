import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import {
  AppStoreApi,
  type LatestState,
} from '../src/billing/app-store/app-store-api.js';
import { AppSettingsService } from '../src/common/app-settings.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { UsersService } from '../src/users/users.service.js';
import {
  resetRateLimits,
  signUp,
  type TestSession,
} from './support/session.js';

const DAY = 86_400_000;
const base64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * Signed the way Xcode's StoreKit testing signs: a JWS the App Store Server Library decodes
 * without Apple's chain, accepted only in the `Xcode` environment.
 */
const xcodeSigned = (payload: Record<string, unknown>) =>
  `${base64({ alg: 'ES256', kid: 'Apple_Xcode_Key' })}.${base64(payload)}.${Buffer.from('signature').toString('base64url')}`;

interface TransactionFields {
  originalTransactionId: string;
  userId?: string;
  productId?: string;
  expiresIn?: number;
  revoked?: boolean;
  environment?: string;
  bundleId?: string;
}

function transaction(fields: TransactionFields) {
  const now = Date.now();
  return xcodeSigned({
    transactionId: randomUUID(),
    originalTransactionId: fields.originalTransactionId,
    webOrderLineItemId: '0',
    bundleId: fields.bundleId ?? 'uz.lunex.finance',
    productId: fields.productId ?? 'lunex.pro.monthly',
    subscriptionGroupIdentifier: '21500000',
    purchaseDate: now - DAY,
    originalPurchaseDate: now - DAY,
    expiresDate: now + (fields.expiresIn ?? 29 * DAY),
    quantity: 1,
    type: 'Auto-Renewable Subscription',
    ...(fields.userId ? { appAccountToken: fields.userId.toUpperCase() } : {}),
    inAppOwnershipType: 'PURCHASED',
    signedDate: now,
    ...(fields.revoked ? { revocationDate: now, revocationReason: 0 } : {}),
    environment: fields.environment ?? 'Xcode',
    transactionReason: 'PURCHASE',
    storefront: 'UZB',
    storefrontId: '143566',
    price: 29990,
    currency: 'USD',
  });
}

function renewal(
  originalTransactionId: string,
  extra: Record<string, unknown> = {},
) {
  return xcodeSigned({
    originalTransactionId,
    autoRenewProductId: 'lunex.pro.monthly',
    productId: 'lunex.pro.monthly',
    autoRenewStatus: 1,
    signedDate: Date.now(),
    environment: 'Xcode',
    ...extra,
  });
}

function notification(
  type: string,
  signedTransactionInfo: string,
  options: { subtype?: string; uuid?: string; signedRenewalInfo?: string } = {},
) {
  return xcodeSigned({
    notificationType: type,
    ...(options.subtype ? { subtype: options.subtype } : {}),
    notificationUUID: options.uuid ?? randomUUID(),
    data: {
      bundleId: 'uz.lunex.finance',
      environment: 'Xcode',
      signedTransactionInfo,
      ...(options.signedRenewalInfo
        ? { signedRenewalInfo: options.signedRenewalInfo }
        : {}),
      status: 1,
    },
    version: '2.0',
    signedDate: Date.now(),
  });
}

/** The App Store Server API, played by the test: what the App Store would say about a purchase. */
class FakeAppStoreApi {
  answers = new Map<string, LatestState>();
  async latest(originalTransactionId: string): Promise<LatestState | null> {
    return this.answers.get(originalTransactionId) ?? null;
  }
}

describe('App Store purchases (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  const api = new FakeAppStoreApi();
  let originalMonetization: unknown;
  const userIds: string[] = [];

  /** A user whose trial is over, with monetization on: Free until they buy. */
  async function freeUser() {
    const session = await signUp(http, 'ru');
    userIds.push(session.userId);
    await prisma.subscriptions.updateMany({
      where: { user_id: session.userId, source: 'trial' },
      data: { expires_at: new Date(Date.now() - DAY) },
    });
    return session;
  }

  const buy = (session: TestSession, signedTransaction: string, status = 200) =>
    http
      .post('/v1/billing/app-store/transactions')
      .set(session.auth)
      .send({ signedTransaction })
      .expect(status);

  const notify = (signedPayload: string, status = 200) =>
    http
      .post('/v1/billing/app-store/notifications')
      .send({ signedPayload })
      .expect(status);

  const access = async (session: TestSession) =>
    (await http.get('/v1/me/access').set(session.auth).expect(200)).body;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AppStoreApi)
      .useValue(api)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    http = request(app.getHttpServer());
    prisma = app.get(PrismaService);
    await resetRateLimits(app);
    originalMonetization = (
      await prisma.appSettings.findUniqueOrThrow({
        where: { key: 'monetization_enabled' },
      })
    ).value;
    await prisma.appSettings.update({
      where: { key: 'monetization_enabled' },
      data: { value: true },
    });
    app.get(AppSettingsService).invalidate();
  });

  afterEach(() => api.answers.clear());

  afterAll(async () => {
    try {
      await prisma.appSettings.update({
        where: { key: 'monetization_enabled' },
        data: { value: originalMonetization as boolean },
      });
      app.get(AppSettingsService).invalidate();
      await prisma.storeEvents.deleteMany({
        where: { subscription: { user_id: { in: userIds } } },
      });
      const users = app.get(UsersService);
      for (const id of userIds) await users.purgeUser(id);
    } finally {
      await app.close();
    }
  });

  it('a purchase from the app gives Pro until it ends, once per original transaction', async () => {
    const session = await freeUser();
    const before = await access(session);
    expect(before.plan).toBe('free');
    // Both plans, for the comparison on the Lunex Pro screen.
    expect(before.plans).toEqual({
      free: expect.objectContaining({
        accounts: 2,
        activeGoals: 3,
        aiMessagesPerDay: 5,
      }),
      pro: expect.objectContaining({
        accounts: null,
        activeGoals: null,
        aiMessagesPerDay: 50,
      }),
    });
    const original = `2000000${Date.now()}`;

    const bought = await buy(
      session,
      transaction({ originalTransactionId: original, userId: session.userId }),
    );
    expect(bought.body).toMatchObject({
      plan: 'pro',
      source: 'app_store',
      monetizationEnabled: true,
    });
    expect(new Date(bought.body.expiresAt).getTime()).toBeGreaterThan(
      Date.now() + 28 * DAY,
    );

    // Restored, or the same renewal seen again: still one subscription.
    await buy(
      session,
      transaction({
        originalTransactionId: original,
        userId: session.userId,
        productId: 'lunex.pro.yearly',
        expiresIn: 364 * DAY,
      }),
    );
    const rows = await prisma.subscriptions.findMany({
      where: { user_id: session.userId, source: 'app_store' },
    });
    expect(rows).toEqual([
      expect.objectContaining({
        original_transaction_id: original,
        product_id: 'lunex.pro.yearly',
        status: 'active',
        environment: 'Xcode',
        auto_renew: true,
      }),
    ]);

    // Another Lunex account on the same Apple ID cannot take it over.
    const other = await freeUser();
    const taken = await buy(
      other,
      transaction({ originalTransactionId: original }),
      409,
    );
    expect(taken.body.code).toBe('purchase_linked_elsewhere');
    const token = await buy(
      other,
      transaction({
        originalTransactionId: `3000000${Date.now()}`,
        userId: session.userId,
      }),
      409,
    );
    expect(token.body.code).toBe('purchase_linked_elsewhere');
    expect((await access(other)).plan).toBe('free');
  });

  it('refuses what the App Store did not sign for Lunex Pro', async () => {
    const session = await freeUser();
    const id = `4000000${Date.now()}`;
    const expectInvalid = async (signed: string) => {
      const res = await buy(session, signed, 400);
      expect(res.body.code).toBe('invalid_purchase');
    };
    // Sandbox needs Apple's certificate chain; this one has none.
    await expectInvalid(
      transaction({ originalTransactionId: id, environment: 'Sandbox' }),
    );
    // Production is not accepted on this server at all.
    await expectInvalid(
      transaction({ originalTransactionId: id, environment: 'Production' }),
    );
    await expectInvalid(
      transaction({ originalTransactionId: id, bundleId: 'com.example.other' }),
    );
    await expectInvalid(
      transaction({ originalTransactionId: id, productId: 'coins.100' }),
    );
    await expectInvalid('not.a.jws-token-at-all');
    expect(
      await prisma.subscriptions.count({
        where: { user_id: session.userId, source: 'app_store' },
      }),
    ).toBe(0);
  });

  it('asks the App Store Server API for the latest word when it can', async () => {
    const session = await freeUser();
    const id = `5000000${Date.now()}`;
    // The device still has the purchase; the App Store already refunded it.
    api.answers.set(id, {
      signedTransactionInfo: transaction({
        originalTransactionId: id,
        userId: session.userId,
        revoked: true,
      }),
      signedRenewalInfo: renewal(id, { autoRenewStatus: 0 }),
    });
    const res = await buy(
      session,
      transaction({ originalTransactionId: id, userId: session.userId }),
    );
    expect(res.body.plan).toBe('free');
    expect(
      await prisma.subscriptions.findUniqueOrThrow({
        where: { original_transaction_id: id },
      }),
    ).toMatchObject({ status: 'revoked', auto_renew: false });
  });

  it('follows the App Store notifications: renewal, grace period, expiry, refund', async () => {
    const session = await freeUser();
    const id = `6000000${Date.now()}`;
    const tx = (fields: Partial<TransactionFields> = {}) =>
      transaction({
        originalTransactionId: id,
        userId: session.userId,
        ...fields,
      });
    const row = () =>
      prisma.subscriptions.findUniqueOrThrow({
        where: { original_transaction_id: id },
      });

    // Bought, and the notification comes before the app reports it: linked by the token.
    const uuid = randomUUID();
    await notify(
      notification('SUBSCRIBED', tx(), { subtype: 'INITIAL_BUY', uuid }),
    );
    expect((await access(session)).plan).toBe('pro');
    // Delivered again: kept once, applied once.
    await notify(
      notification('SUBSCRIBED', tx(), { subtype: 'INITIAL_BUY', uuid }),
    );
    expect(
      await prisma.storeEvents.findMany({ where: { notification_uuid: uuid } }),
    ).toEqual([
      expect.objectContaining({
        notification_type: 'SUBSCRIBED',
        subtype: 'INITIAL_BUY',
        original_transaction_id: id,
        processed_at: expect.any(Date),
        error: null,
      }),
    ]);

    await notify(notification('DID_RENEW', tx({ expiresIn: 59 * DAY })));
    const renewed = await row();
    expect(renewed.expires_at.getTime()).toBeGreaterThan(Date.now() + 58 * DAY);
    // An older renewal arriving late does not move the end back.
    await notify(notification('DID_RENEW', tx({ expiresIn: 29 * DAY })));
    expect((await row()).expires_at).toEqual(renewed.expires_at);

    await notify(
      notification('DID_CHANGE_RENEWAL_STATUS', tx({ expiresIn: 59 * DAY }), {
        subtype: 'AUTO_RENEW_DISABLED',
        signedRenewalInfo: renewal(id, { autoRenewStatus: 0 }),
      }),
    );
    expect(await row()).toMatchObject({ status: 'active', auto_renew: false });

    // Payment failed: Pro stays through the billing grace period.
    const graceEnds = Date.now() + 6 * DAY;
    await notify(
      notification('DID_FAIL_TO_RENEW', tx({ expiresIn: -DAY }), {
        subtype: 'GRACE_PERIOD',
        signedRenewalInfo: renewal(id, { gracePeriodExpiresDate: graceEnds }),
      }),
    );
    expect(await row()).toMatchObject({
      status: 'grace_period',
      expires_at: new Date(graceEnds),
    });
    expect((await access(session)).plan).toBe('pro');

    await notify(notification('GRACE_PERIOD_EXPIRED', tx({ expiresIn: -DAY })));
    expect((await row()).status).toBe('expired');
    expect((await access(session)).plan).toBe('free');

    await notify(notification('DID_RENEW', tx({ expiresIn: 30 * DAY })));
    expect((await access(session)).plan).toBe('pro');
    await notify(
      notification('REFUND', tx({ expiresIn: 30 * DAY, revoked: true })),
    );
    expect((await row()).status).toBe('revoked');
    expect((await access(session)).plan).toBe('free');
  });

  it('keeps what it cannot place, and refuses what Apple did not sign', async () => {
    const stranger = `7000000${Date.now()}`;
    const uuid = randomUUID();
    // No account behind it yet (no token): kept for when the app reports the purchase.
    await notify(
      notification(
        'SUBSCRIBED',
        transaction({ originalTransactionId: stranger }),
        { uuid },
      ),
    );
    expect(
      await prisma.storeEvents.findUniqueOrThrow({
        where: { notification_uuid: uuid },
      }),
    ).toMatchObject({
      error: 'unknown_account',
      processed_at: expect.any(Date),
    });
    await prisma.storeEvents.delete({ where: { notification_uuid: uuid } });

    const test = xcodeSigned({
      notificationType: 'TEST',
      notificationUUID: randomUUID(),
      data: { bundleId: 'uz.lunex.finance', environment: 'Xcode' },
      version: '2.0',
      signedDate: Date.now(),
    });
    await notify(test);

    const forged = notification(
      'SUBSCRIBED',
      transaction({ originalTransactionId: stranger }),
    ).replace(
      base64({ alg: 'ES256', kid: 'Apple_Xcode_Key' }),
      base64({ alg: 'ES256' }),
    );
    const sandbox = Buffer.from(forged.split('.')[1], 'base64url')
      .toString()
      .replace('"environment":"Xcode"', '"environment":"Sandbox"');
    const res = await notify(
      `${forged.split('.')[0]}.${Buffer.from(sandbox).toString('base64url')}.c2ln`,
      400,
    );
    expect(res.body.code).toBe('invalid_notification');
    await notify('garbage-that-is-long-enough', 400);
  });
});
