import { randomUUID } from 'node:crypto';
import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { telegramHash } from '../src/auth/providers/telegram.verifier.js';
import { EntitlementsService } from '../src/billing/entitlements.service.js';
import { RequiresPro } from '../src/billing/requires-pro.js';
import { AppSettingsService } from '../src/common/app-settings.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { REDIS } from '../src/redis/redis.module.js';
import { UsersService } from '../src/users/users.service.js';

// A route that exists only in this test, to exercise @RequiresPro end to end.
@Controller('probe')
class ProbeController {
  @Get('reports')
  @RequiresPro('ai_reports')
  reports() {
    return { ok: true };
  }
}

describe('Lunex Pro access (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  let entitlements: EntitlementsService;
  let settings: AppSettingsService;
  let originalMonetization: unknown;
  const userIds: string[] = [];

  async function setMonetization(enabled: boolean) {
    await prisma.appSettings.update({
      where: { key: 'monetization_enabled' },
      data: { value: enabled },
    });
    settings.invalidate();
  }

  async function signUp() {
    const data = {
      id: Math.floor(Math.random() * 1e9) + 1,
      first_name: 'Pro',
      auth_date: Math.floor(Date.now() / 1000),
    };
    const res = await http
      .post('/v1/auth/telegram')
      .send({
        authData: { ...data, hash: telegramHash(data, '123456:test-token') },
        device: { id: randomUUID() },
      })
      .expect(200);
    userIds.push(res.body.user.id);
    return {
      userId: res.body.user.id as string,
      auth: { Authorization: `Bearer ${res.body.accessToken}` },
    };
  }

  async function endTrial(userId: string) {
    await prisma.subscriptions.updateMany({
      where: { user_id: userId, source: 'trial' },
      data: { expires_at: new Date(Date.now() - 60_000) },
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ProbeController],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    http = request(app.getHttpServer());
    prisma = app.get(PrismaService);
    entitlements = app.get(EntitlementsService);
    settings = app.get(AppSettingsService);

    const redis = app.get<Redis>(REDIS);
    const keys = await redis.keys('lunex:rl:*');
    if (keys.length > 0) await redis.del(...keys);

    originalMonetization = (
      await prisma.appSettings.findUniqueOrThrow({
        where: { key: 'monetization_enabled' },
      })
    ).value;
  });

  afterAll(async () => {
    try {
      await prisma.appSettings.update({
        where: { key: 'monetization_enabled' },
        data: { value: originalMonetization as boolean },
      });
      const users = app.get(UsersService);
      for (const id of userIds) await users.purgeUser(id);
    } finally {
      await app.close();
    }
  });

  beforeEach(() => setMonetization(false));

  it('opens everything while monetization is off', async () => {
    const { userId, auth } = await signUp();
    const res = await http.get('/v1/me/access').set(auth).expect(200);
    expect(res.body).toMatchObject({
      monetizationEnabled: false,
      plan: 'pro',
      source: 'monetization_off',
      trial: { active: true, daysLeft: 30 },
      limits: { accounts: null, activeGoals: null, aiMessagesPerDay: 50 },
    });
    await http.get('/v1/probe/reports').set(auth).expect(200);

    // Even past the trial nothing is locked until an administrator turns monetization on.
    await endTrial(userId);
    await http.get('/v1/probe/reports').set(auth).expect(200);
  });

  it('runs on the trial once monetization is on, then falls back to Free', async () => {
    const { userId, auth } = await signUp();
    await setMonetization(true);

    const during = await http.get('/v1/me/access').set(auth).expect(200);
    expect(during.body).toMatchObject({
      monetizationEnabled: true,
      plan: 'pro',
      source: 'trial',
    });
    expect(new Date(during.body.expiresAt).getTime()).toBeGreaterThan(
      Date.now(),
    );
    await http.get('/v1/probe/reports').set(auth).expect(200);

    await endTrial(userId);
    const after = await http.get('/v1/me/access').set(auth).expect(200);
    expect(after.body).toMatchObject({
      plan: 'free',
      source: null,
      features: [],
      limits: { accounts: 2, activeGoals: 3, aiMessagesPerDay: 5 },
    });

    const locked = await http.get('/v1/probe/reports').set(auth).expect(403);
    expect(locked.body).toMatchObject({
      code: 'pro_required',
      feature: 'ai_reports',
    });
  });

  it('caps accounts and active goals on Free, counting only live ones', async () => {
    const { userId } = await signUp();
    const uzs = await prisma.currencies.findUniqueOrThrow({
      where: { code: 'UZS' },
    });
    const account = (name: string) =>
      prisma.accounts.create({
        data: { id: randomUUID(), user_id: userId, name, currency_id: uzs.id },
      });
    const goal = () =>
      prisma.goals.create({
        data: {
          id: randomUUID(),
          user_id: userId,
          title: 'Goal',
          color: '#0A84FF',
          target_amount: 1_000_000,
          currency_id: uzs.id,
        },
      });

    await account('Cash');
    const card = await account('Card');
    const goals = [await goal(), await goal(), await goal()];

    // Monetization off: no caps.
    await expect(
      entitlements.assertCanCreate(userId, 'accounts'),
    ).resolves.toBeUndefined();

    await setMonetization(true);
    await endTrial(userId);

    await expect(
      entitlements.assertCanCreate(userId, 'accounts'),
    ).rejects.toMatchObject({
      response: {
        code: 'free_limit_reached',
        resource: 'accounts',
        limit: 2,
        current: 2,
      },
    });
    await expect(
      entitlements.assertCanCreate(userId, 'active_goals'),
    ).rejects.toMatchObject({
      response: {
        code: 'free_limit_reached',
        resource: 'active_goals',
        limit: 3,
      },
    });

    // Archived accounts and paused goals free a slot; their data stays.
    await prisma.accounts.update({
      where: { id: card.id },
      data: { is_archived: true },
    });
    await prisma.goals.update({
      where: { id: goals[0].id },
      data: { status: 'paused' },
    });
    await expect(
      entitlements.assertCanCreate(userId, 'accounts'),
    ).resolves.toBeUndefined();
    await expect(
      entitlements.assertCanCreate(userId, 'active_goals'),
    ).resolves.toBeUndefined();
  });

  it('marks ended subscriptions as expired', async () => {
    const { userId } = await signUp();
    await endTrial(userId);
    await entitlements.expireSubscriptions();
    const trial = await prisma.subscriptions.findFirstOrThrow({
      where: { user_id: userId, source: 'trial' },
    });
    expect(trial.status).toBe('expired');
  });
});
