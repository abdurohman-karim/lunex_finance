import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { telegramHash } from '../src/auth/providers/telegram.verifier.js';
import { AppSettingsService } from '../src/common/app-settings.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { systemCategoryId } from '../src/database/reference-data.js';
import { UsersService } from '../src/users/users.service.js';
import {
  resetRateLimits,
  TEST_TELEGRAM_TOKEN,
  type TestSession,
} from './support/session.js';

const CAFE = systemCategoryId('expense', 'cafe');

describe('Admin panel API (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  const userIds: string[] = [];
  let originalMonetization: unknown;

  /** Signs in with Telegram as `telegramId`; `admin` asks for a panel session. */
  async function telegram(telegramId: number, admin = false, status = 200) {
    const data = {
      id: telegramId,
      first_name: 'Admin',
      auth_date: Math.floor(Date.now() / 1000),
    };
    const res = await http
      .post('/v1/auth/telegram')
      .send({
        authData: { ...data, hash: telegramHash(data, TEST_TELEGRAM_TOKEN) },
        device: admin
          ? { id: randomUUID(), platform: 'web', model: 'Safari' }
          : { id: randomUUID() },
        ...(admin ? { admin: true } : { language: 'ru' }),
      })
      .expect(status);
    if (res.status !== 200) return res;
    if (!userIds.includes(res.body.user.id)) userIds.push(res.body.user.id);
    return res;
  }

  const session = (res: request.Response): TestSession => ({
    userId: res.body.user.id,
    auth: { Authorization: `Bearer ${res.body.accessToken}` },
    refreshToken: res.body.refreshToken,
  });

  /** A fresh account made an administrator, signed in to the panel. */
  async function admin() {
    const telegramId = Math.floor(Math.random() * 1e12) + 1;
    const user = await telegram(telegramId);
    await prisma.users.update({
      where: { id: user.body.user.id },
      data: { role: 'admin' },
    });
    return session(await telegram(telegramId, true));
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
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
  });

  afterAll(async () => {
    try {
      await prisma.appSettings.update({
        where: { key: 'monetization_enabled' },
        data: { value: originalMonetization as boolean, updated_by: null },
      });
      await prisma.appSettings.updateMany({ data: { updated_by: null } });
      app.get(AppSettingsService).invalidate();
      await prisma.adminAuditLog.deleteMany({
        where: { admin_id: { in: userIds } },
      });
      const users = app.get(UsersService);
      for (const id of userIds) await users.purgeUser(id);
    } finally {
      await app.close();
    }
  });

  it('lets only administrators in, and creates no account on the way', async () => {
    const telegramId = Math.floor(Math.random() * 1e12) + 1;
    // Nobody with this Telegram: refused, and nobody is created.
    const unknown = await telegram(telegramId, true, 403);
    expect(unknown.body.code).toBe('admin_only');
    expect(
      await prisma.authIdentities.count({
        where: { provider: 'telegram', subject: String(telegramId) },
      }),
    ).toBe(0);

    // An ordinary user: refused in the panel, and their app session cannot use the API.
    const user = session(await telegram(telegramId));
    expect((await telegram(telegramId, true, 403)).body.code).toBe(
      'admin_only',
    );
    await http.get('/v1/admin/me').set(user.auth).expect(403);
    await http.get('/v1/admin/settings').expect(401);

    const boss = await admin();
    const me = await http.get('/v1/admin/me').set(boss.auth).expect(200);
    expect(me.body.role).toBe('admin');
    const device = await prisma.refreshTokens.findFirstOrThrow({
      where: { user_id: boss.userId },
      orderBy: { created_at: 'desc' },
      include: { device: true },
    });
    expect(device.device).toMatchObject({ platform: 'web', model: 'Safari' });

    // The role taken away: the next request is refused, the token notwithstanding.
    await prisma.users.update({
      where: { id: boss.userId },
      data: { role: 'user' },
    });
    await http.get('/v1/admin/me').set(boss.auth).expect(403);
  });

  it('changes settings within their bounds, and logs who changed what', async () => {
    const boss = await admin();
    const list = await http
      .get('/v1/admin/settings')
      .set(boss.auth)
      .expect(200);
    expect(list.body.map((s: { key: string }) => s.key)).toContain(
      'trial_days',
    );
    const before = list.body.find(
      (s: { key: string }) => s.key === 'ai_daily_limit_free',
    );

    const res = await http
      .put('/v1/admin/settings/ai_daily_limit_free')
      .set(boss.auth)
      .send({ value: 7 })
      .expect(200);
    expect(
      res.body.find((s: { key: string }) => s.key === 'ai_daily_limit_free'),
    ).toMatchObject({
      value: 7,
      defaultValue: 5,
      updatedBy: { id: boss.userId },
    });
    // At once, everywhere: the cache was dropped.
    expect(await app.get(AppSettingsService).get('ai_daily_limit_free')).toBe(
      7,
    );

    const bad = await http
      .put('/v1/admin/settings/smart_save_share')
      .set(boss.auth)
      .send({ value: 3 })
      .expect(400);
    expect(bad.body.code).toBe('invalid_value');
    const switchOnly = await http
      .put('/v1/admin/settings/monetization_enabled')
      .set(boss.auth)
      .send({ value: 1 })
      .expect(400);
    expect(switchOnly.body.code).toBe('unknown_setting');

    const audit = await http.get('/v1/admin/audit').set(boss.auth).expect(200);
    expect(audit.body.items[0]).toMatchObject({
      admin: { id: boss.userId },
      action: 'setting.update',
      target: 'ai_daily_limit_free',
      oldValue: before.value,
      newValue: 7,
    });

    await http
      .put('/v1/admin/settings/ai_daily_limit_free')
      .set(boss.auth)
      .send({ value: before.value })
      .expect(200);
  });

  it('switches Lunex Pro on after showing who goes to Free, and off again', async () => {
    const boss = await admin();
    await prisma.appSettings.update({
      where: { key: 'monetization_enabled' },
      data: { value: false },
    });
    app.get(AppSettingsService).invalidate();
    // One account whose trial is over: it goes to Free.
    const lapsed = session(
      await telegram(Math.floor(Math.random() * 1e12) + 1),
    );
    await prisma.subscriptions.updateMany({
      where: { user_id: lapsed.userId },
      data: { expires_at: new Date(Date.now() - 86_400_000) },
    });

    const preview = await http
      .get('/v1/admin/monetization')
      .set(boss.auth)
      .expect(200);
    expect(preview.body).toMatchObject({ enabled: false });
    expect(preview.body.toFree).toBeGreaterThanOrEqual(1);
    expect(preview.body.users).toBeGreaterThanOrEqual(
      preview.body.toFree + preview.body.trials,
    );

    const on = await http
      .put('/v1/admin/monetization')
      .set(boss.auth)
      .send({ enabled: true })
      .expect(200);
    expect(on.body.enabled).toBe(true);
    const access = await http.get('/v1/me/access').set(lapsed.auth).expect(200);
    expect(access.body).toMatchObject({
      monetizationEnabled: true,
      plan: 'free',
    });

    await http
      .put('/v1/admin/monetization')
      .set(boss.auth)
      .send({ enabled: false })
      .expect(200);
    const audit = await http.get('/v1/admin/audit').set(boss.auth).expect(200);
    expect(
      audit.body.items.slice(0, 2).map((e: { action: string }) => e.action),
    ).toEqual(['monetization.disable', 'monetization.enable']);
  });

  it('edits currencies and system categories, which reach the devices', async () => {
    const boss = await admin();
    const user = session(await telegram(Math.floor(Math.random() * 1e12) + 1));
    const currencies = await http
      .get('/v1/admin/currencies')
      .set(boss.auth)
      .expect(200);
    const uzs = currencies.body.find((c: { code: string }) => c.code === 'UZS');
    expect(uzs).toMatchObject({ roundingStep: '1000', minSmartSave: '1000' });

    const changed = await http
      .patch('/v1/admin/currencies/uzs')
      .set(boss.auth)
      .send({ roundingStep: '5000', minSmartSave: '5000' })
      .expect(200);
    expect(
      changed.body.find((c: { code: string }) => c.code === 'UZS'),
    ).toMatchObject({ roundingStep: '5000', minSmartSave: '5000' });
    await http
      .patch('/v1/admin/currencies/UZS')
      .set(boss.auth)
      .send({ roundingStep: '1000', minSmartSave: '1000' })
      .expect(200);

    const categories = await http
      .get('/v1/admin/categories')
      .set(boss.auth)
      .expect(200);
    const cafe = categories.body.find((c: { id: string }) => c.id === CAFE);
    const since = new Date(Date.now() - 1000).toISOString();
    await http
      .patch(`/v1/admin/categories/${CAFE}`)
      .set(boss.auth)
      .send({ labels: { ru: 'Кафе' }, color: '#5F8A8B' })
      .expect(200);
    // The user's device gets the new name with its next sync.
    const synced = await http
      .get('/v1/categories')
      .query({ updatedSince: since })
      .set(user.auth)
      .expect(200);
    expect(
      synced.body.find((c: { id: string }) => c.id === CAFE),
    ).toMatchObject({ name: 'Кафе', color: '#5F8A8B' });
    await http
      .patch(`/v1/admin/categories/${CAFE}`)
      .set(boss.auth)
      .send({ labels: { ru: cafe.labels.ru }, color: cafe.color })
      .expect(200);

    const key = `pets_${Date.now().toString(36)}`.slice(0, 32);
    const created = await http
      .post('/v1/admin/categories')
      .set(boss.auth)
      .send({
        type: 'expense',
        key,
        icon: 'pawprint',
        color: '#6E8B74',
        labels: { uz: 'Uy hayvonlari', ru: 'Питомцы', en: 'Pets' },
      })
      .expect(201);
    const pets = created.body.find((c: { key: string }) => c.key === key);
    expect(pets.labels).toEqual({
      uz: 'Uy hayvonlari',
      ru: 'Питомцы',
      en: 'Pets',
    });
    await http
      .post('/v1/admin/categories')
      .set(boss.auth)
      .send({
        type: 'expense',
        key,
        icon: 'pawprint',
        color: '#6E8B74',
        labels: pets.labels,
      })
      .expect(409);
    await prisma.categoryTranslations.deleteMany({
      where: { category_id: pets.id },
    });
    await prisma.categories.delete({ where: { id: pets.id } });

    const audit = await http.get('/v1/admin/audit').set(boss.auth).expect(200);
    expect(
      audit.body.items.slice(0, 5).map((e: { action: string }) => e.action),
    ).toEqual([
      'category.create',
      'category.update',
      'category.update',
      'currency.update',
      'currency.update',
    ]);
    expect(audit.body.items[3]).toMatchObject({
      target: 'UZS',
      oldValue: { roundingStep: '5000', minSmartSave: '5000' },
      newValue: { roundingStep: '1000', minSmartSave: '1000' },
    });
  });

  it('finds a user and gives them Lunex Pro for a while', async () => {
    const boss = await admin();
    const telegramId = Math.floor(Math.random() * 1e12) + 1;
    const user = session(await telegram(telegramId));
    await prisma.subscriptions.updateMany({
      where: { user_id: user.userId },
      data: { expires_at: new Date(Date.now() - 86_400_000) },
    });
    await prisma.appSettings.update({
      where: { key: 'monetization_enabled' },
      data: { value: true },
    });
    app.get(AppSettingsService).invalidate();

    const found = await http
      .get('/v1/admin/users')
      .query({ q: String(telegramId) })
      .set(boss.auth)
      .expect(200);
    expect(found.body).toEqual([
      expect.objectContaining({
        id: user.userId,
        signIn: ['telegram'],
        plan: 'free',
      }),
    ]);

    const granted = await http
      .post(`/v1/admin/users/${user.userId}/promo`)
      .set(boss.auth)
      .send({ days: 30 })
      .expect(201);
    expect(granted.body).toMatchObject({ plan: 'pro', source: 'promo' });
    // A second grant adds to the first.
    const again = await http
      .post(`/v1/admin/users/${user.userId}/promo`)
      .set(boss.auth)
      .send({ days: 10 })
      .expect(201);
    const days =
      (new Date(again.body.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(40);
    // The panel shows both dates even while monetization is off.
    expect(again.body.promoUntil).toBe(again.body.expiresAt);
    expect(new Date(again.body.trialUntil).getTime()).toBeLessThan(Date.now());
    const access = await http.get('/v1/me/access').set(user.auth).expect(200);
    expect(access.body).toMatchObject({ plan: 'pro', source: 'promo' });

    const audit = await http
      .get('/v1/admin/audit')
      .query({ limit: 1 })
      .set(boss.auth)
      .expect(200);
    expect(audit.body.items[0]).toMatchObject({
      action: 'subscription.grant',
      target: user.userId,
      newValue: expect.objectContaining({ days: 10 }),
    });
    expect(audit.body.nextBefore).toEqual(expect.any(String));
    const older = await http
      .get('/v1/admin/audit')
      .query({ limit: 1, before: audit.body.nextBefore })
      .set(boss.auth)
      .expect(200);
    expect(older.body.items[0]).toMatchObject({
      action: 'subscription.grant',
      newValue: expect.objectContaining({ days: 30 }),
    });
  });

  it('shows the jobs, AI use, subscriptions and the panel itself', async () => {
    const boss = await admin();
    const monitoring = await http
      .get('/v1/admin/monitoring')
      .set(boss.auth)
      .expect(200);
    expect(monitoring.body.users.total).toBeGreaterThan(0);
    expect(monitoring.body.subscriptions).toEqual(
      expect.objectContaining({
        trialsActive: expect.any(Number),
        trialsEnded: expect.any(Number),
        appStore: expect.any(Object),
      }),
    );
    expect(monitoring.body.queues.map((q: { name: string }) => q.name)).toEqual(
      ['maintenance', 'notifications', 'insights', 'auto-save'],
    );
    expect(monitoring.body.queues[0].counts).toEqual(
      expect.objectContaining({
        waiting: expect.any(Number),
        failed: expect.any(Number),
      }),
    );
    expect(Array.isArray(monitoring.body.ai.days)).toBe(true);

    const page = await http.get('/admin/').expect(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.text).toContain('Lunex');
    expect(page.headers['cache-control']).toBe('no-cache');
  });
});
