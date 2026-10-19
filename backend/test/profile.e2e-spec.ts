import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { systemCategoryId } from '../src/database/reference-data.js';
import { UsersService } from '../src/users/users.service.js';
import { resetRateLimits, signUp } from './support/session.js';

describe('Onboarding, profile and settings (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  const userIds: string[] = [];
  const rateIds: bigint[] = [];

  async function newUser(language: 'uz' | 'ru' | 'en' = 'ru') {
    const session = await signUp(http, language);
    userIds.push(session.userId);
    return session;
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
  });

  afterAll(async () => {
    try {
      await prisma.exchangeRates.deleteMany({ where: { id: { in: rateIds } } });
      const users = app.get(UsersService);
      for (const id of userIds) await users.purgeUser(id);
    } finally {
      await app.close();
    }
  });

  describe('onboarding', () => {
    it('applies the choices, creates «Наличные» and the first goal', async () => {
      const me = await newUser('uz');
      const cashAccountId = randomUUID();
      const goalId = randomUUID();
      const body = {
        language: 'ru',
        baseCurrency: 'UZS',
        timezone: 'Asia/Samarkand',
        focus: 'save',
        monthlyIncomeEstimate: '6000000',
        cashAccountId,
        firstGoal: {
          id: goalId,
          title: 'Новый телефон',
          templateKey: 'phone',
          targetAmount: '9000000',
        },
      };
      const res = await http
        .post('/v1/me/onboarding')
        .set(me.auth)
        .send(body)
        .expect(200);
      expect(res.body).toMatchObject({
        profile: {
          language: 'ru',
          timezone: 'Asia/Samarkand',
          onboardingCompleted: true,
          onboardingFocus: 'save',
          monthlyIncomeEstimate: '6000000',
        },
        account: {
          id: cashAccountId,
          name: 'Наличные',
          type: 'cash',
          currency: 'UZS',
          isDefault: true,
        },
        goal: { id: goalId, emoji: '📱', isPrimary: true },
        checklist: {
          firstTransaction: false,
          firstGoal: true,
          budget: false,
          completed: false,
        },
      });

      // Repeating it changes nothing and creates nothing new.
      await http.post('/v1/me/onboarding').set(me.auth).send(body).expect(200);
      const [accounts, goals] = await Promise.all([
        prisma.accounts.count({ where: { user_id: me.userId } }),
        prisma.goals.count({ where: { user_id: me.userId } }),
      ]);
      expect({ accounts, goals }).toEqual({ accounts: 1, goals: 1 });
    });

    it('works with every step skipped', async () => {
      const me = await newUser('en');
      const res = await http
        .post('/v1/me/onboarding')
        .set(me.auth)
        .send({ cashAccountId: randomUUID() })
        .expect(200);
      expect(res.body).toMatchObject({
        profile: { onboardingCompleted: true, onboardingFocus: null },
        account: { name: 'Cash', currency: 'UZS' },
        goal: null,
      });
    });

    it('ticks the checklist as the user goes', async () => {
      const me = await newUser();
      const cash = randomUUID();
      await http
        .post('/v1/me/onboarding')
        .set(me.auth)
        .send({ cashAccountId: cash })
        .expect(200);
      await http
        .post('/v1/transactions')
        .set(me.auth)
        .send({
          id: randomUUID(),
          type: 'expense',
          accountId: cash,
          amount: '1000',
          occurredAt: new Date().toISOString(),
        })
        .expect(201);
      const checklist = await http
        .get('/v1/me/checklist')
        .set(me.auth)
        .expect(200);
      expect(checklist.body).toEqual({
        firstTransaction: true,
        firstGoal: false,
        budget: false,
        completed: false,
      });
    });
  });

  describe('profile', () => {
    it('updates name, language and time zone', async () => {
      const me = await newUser('ru');
      const res = await http
        .patch('/v1/me')
        .set(me.auth)
        .send({
          displayName: 'Асадбек',
          language: 'uz',
          timezone: 'Europe/Moscow',
        })
        .expect(200);
      expect(res.body).toMatchObject({
        displayName: 'Асадбек',
        language: 'uz',
        timezone: 'Europe/Moscow',
      });

      // Category names follow the language.
      const categories = await http
        .get('/v1/categories')
        .query({ type: 'expense' })
        .set(me.auth)
        .expect(200);
      expect(
        categories.body.find(
          (c: { id: string }) => c.id === systemCategoryId('expense', 'food'),
        ).name,
      ).toBe('Oziq-ovqat');

      const badZone = await http
        .patch('/v1/me')
        .set(me.auth)
        .send({ timezone: 'Mars/Olympus' })
        .expect(400);
      expect(badZone.body.code).toBe('validation_failed');
    });

    it('refuses a base currency change it cannot re-value, and changes nothing', async () => {
      const me = await newUser();
      const cash = randomUUID();
      await http
        .post('/v1/me/onboarding')
        .set(me.auth)
        .send({ cashAccountId: cash })
        .expect(200);
      await http
        .post('/v1/transactions')
        .set(me.auth)
        .send({
          id: randomUUID(),
          type: 'income',
          accountId: cash,
          amount: '12650000',
          occurredAt: '2026-10-10T05:00:00Z',
        })
        .expect(201);

      const res = await http
        .patch('/v1/me')
        .set(me.auth)
        .send({ baseCurrency: 'USD' })
        .expect(422);
      expect(res.body).toMatchObject({
        code: 'exchange_rate_unavailable',
        from: ['UZS'],
        to: 'USD',
      });
      expect(
        (await http.get('/v1/me').set(me.auth).expect(200)).body.baseCurrency,
      ).toBe('UZS');
    });

    it('re-values every operation when the base currency changes', async () => {
      const me = await newUser();
      const cash = randomUUID();
      await http
        .post('/v1/me/onboarding')
        .set(me.auth)
        .send({ cashAccountId: cash })
        .expect(200);
      const op = await http
        .post('/v1/transactions')
        .set(me.auth)
        .send({
          id: randomUUID(),
          type: 'income',
          accountId: cash,
          amount: '12650000',
          occurredAt: '2026-10-10T05:00:00Z',
        })
        .expect(201);
      expect(op.body).toMatchObject({
        amountBase: '12650000',
        baseCurrency: 'UZS',
      });

      const [usd, uzs] = await Promise.all([
        prisma.currencies.findUniqueOrThrow({ where: { code: 'USD' } }),
        prisma.currencies.findUniqueOrThrow({ where: { code: 'UZS' } }),
      ]);
      const rate = await prisma.exchangeRates.create({
        data: {
          base_currency_id: usd.id,
          quote_currency_id: uzs.id,
          rate: 12650,
          rate_date: new Date('2026-10-10'),
          source: 'e2e',
        },
      });
      rateIds.push(rate.id);

      const profile = await http
        .patch('/v1/me')
        .set(me.auth)
        .send({ baseCurrency: 'usd' })
        .expect(200);
      expect(profile.body.baseCurrency).toBe('USD');
      const after = await http
        .get(`/v1/transactions/${op.body.id}`)
        .set(me.auth)
        .expect(200);
      expect(after.body).toMatchObject({
        amount: '12650000',
        currency: 'UZS',
        amountBase: '1000.00',
        baseCurrency: 'USD',
      });
    });
  });

  describe('settings', () => {
    it('reads defaults and updates any subset', async () => {
      const me = await newUser();
      const defaults = await http
        .get('/v1/me/settings')
        .set(me.auth)
        .expect(200);
      expect(defaults.body).toMatchObject({
        biometricLockEnabled: false,
        lockAfterSeconds: 60,
        hideAmounts: false,
        weekStartsOn: 1,
        monthStartsOnDay: 1,
        dailyReminderEnabled: true,
        dailyReminderTime: '21:00',
        quietHoursStart: '22:00',
        quietHoursEnd: '08:00',
        smartSaveEnabled: true,
      });

      const updated = await http
        .patch('/v1/me/settings')
        .set(me.auth)
        .send({
          hideAmounts: true,
          biometricLockEnabled: true,
          monthStartsOnDay: 10,
          dailyReminderTime: '20:30',
          smartSaveEnabled: false,
        })
        .expect(200);
      expect(updated.body).toMatchObject({
        hideAmounts: true,
        biometricLockEnabled: true,
        monthStartsOnDay: 10,
        dailyReminderTime: '20:30',
        smartSaveEnabled: false,
        quietHoursStart: '22:00',
      });

      await http
        .patch('/v1/me/settings')
        .set(me.auth)
        .send({ dailyReminderTime: '25:00' })
        .expect(400);
      await http
        .patch('/v1/me/settings')
        .set(me.auth)
        .send({ monthStartsOnDay: 0 })
        .expect(400);
    });

    it('switches the default account', async () => {
      const me = await newUser();
      const cash = randomUUID();
      const card = randomUUID();
      await http
        .post('/v1/me/onboarding')
        .set(me.auth)
        .send({ cashAccountId: cash })
        .expect(200);
      await http
        .post('/v1/accounts')
        .set(me.auth)
        .send({ id: card, name: 'Card', currency: 'UZS' })
        .expect(201);

      const res = await http
        .patch('/v1/me/settings')
        .set(me.auth)
        .send({ defaultAccountId: card })
        .expect(200);
      expect(res.body.defaultAccountId).toBe(card);
      const accounts = await http.get('/v1/accounts').set(me.auth).expect(200);
      expect(
        Object.fromEntries(
          accounts.body.map((a: { id: string; isDefault: boolean }) => [
            a.id,
            a.isDefault,
          ]),
        ),
      ).toEqual({
        [cash]: false,
        [card]: true,
      });

      await http
        .patch('/v1/me/settings')
        .set(me.auth)
        .send({ defaultAccountId: randomUUID() })
        .expect(404);
    });

    it('stores the APNs token of the calling device, moving it from an older install', async () => {
      const first = await newUser();
      const token = 'ab'.repeat(32);
      const res = await http
        .put('/v1/me/devices/current')
        .set(first.auth)
        .send({ apnsToken: token, pushEnabled: true, appVersion: '1.0.0' })
        .expect(200);
      expect(res.body).toMatchObject({
        pushEnabled: true,
        hasApnsToken: true,
        appVersion: '1.0.0',
      });

      const second = await newUser();
      await http
        .put('/v1/me/devices/current')
        .set(second.auth)
        .send({ apnsToken: token, pushEnabled: true })
        .expect(200);
      const firstDevice = await prisma.devices.findFirstOrThrow({
        where: { user_id: first.userId },
      });
      expect(firstDevice).toMatchObject({
        apns_token: null,
        push_enabled: false,
      });
    });

    it('syncs profile and settings both ways', async () => {
      const me = await newUser();
      const full = await http.get('/v1/sync/changes').set(me.auth).expect(200);
      expect(full.body.settings).toMatchObject({ hideAmounts: false });

      const pushed = await http
        .post('/v1/sync/push')
        .set(me.auth)
        .send({
          operations: [
            { opId: 's', type: 'settings.update', data: { hideAmounts: true } },
            {
              opId: 'p',
              type: 'profile.update',
              data: { displayName: 'Offline' },
            },
          ],
        })
        .expect(200);
      expect(
        pushed.body.results.map((r: { status: string }) => r.status),
      ).toEqual(['applied', 'applied']);

      const changes = await http
        .get('/v1/sync/changes')
        .query({ cursor: full.body.nextCursor })
        .set(me.auth)
        .expect(200);
      expect(changes.body.settings).toMatchObject({ hideAmounts: true });
      expect(changes.body.profile).toMatchObject({ displayName: 'Offline' });
    });
  });
});
