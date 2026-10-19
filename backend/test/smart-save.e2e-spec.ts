import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { SmartSaveService } from '../src/smart-save/smart-save.service.js';
import { UsersService } from '../src/users/users.service.js';
import {
  resetRateLimits,
  signUp,
  type TestSession,
} from './support/session.js';

// "Now" is fixed: 19 October 2026, 14:00 in Tashkent; 13 days left in October, today included.
const NOW = new Date('2026-10-19T09:00:00Z');

describe('Smart Save (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  let smartSave: SmartSaveService;
  const userIds: string[] = [];

  /** A user with a cash account (the default one) and October income. */
  async function setup(income = '3900000', target = '10000000') {
    const session = await signUp(http, 'ru');
    userIds.push(session.userId);
    const cash = randomUUID();
    await http
      .post('/v1/accounts')
      .set(session.auth)
      .send({ id: cash, name: 'Cash', currency: 'UZS' })
      .expect(201);
    await http
      .post('/v1/transactions')
      .set(session.auth)
      .send({
        id: randomUUID(),
        type: 'income',
        accountId: cash,
        amount: income,
        occurredAt: '2026-10-01T05:00:00Z',
      })
      .expect(201);
    const goal = await http
      .post('/v1/goals')
      .set(session.auth)
      .send({
        id: randomUUID(),
        title: 'Телефон',
        templateKey: 'phone',
        targetAmount: target,
      })
      .expect(201);
    return { session, cash, goalId: goal.body.id as string };
  }

  async function balance(session: TestSession, id: string) {
    const res = await http.get('/v1/accounts').set(session.auth).expect(200);
    return res.body.find((a: { id: string }) => a.id === id).currentBalance;
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
    smartSave = app.get(SmartSaveService);
    await resetRateLimits(app);
  });

  afterAll(async () => {
    try {
      const users = app.get(UsersService);
      for (const id of userIds) await users.purgeUser(id);
    } finally {
      await app.close();
    }
  });

  it('suggests half of the free money per day with an explanation', async () => {
    const { session, goalId, cash } = await setup();
    const today = await smartSave.today(session.userId, NOW);
    expect(today.status).toBe('available');
    expect(today.suggestion).toMatchObject({
      forDate: '2026-10-19',
      status: 'pending',
      goal: { id: goalId, title: 'Телефон', emoji: '📱' },
      amount: '150000',
      currency: 'UZS',
      explanation: {
        baseCurrency: 'UZS',
        monthIncome: '3900000',
        monthExpenses: '0',
        freeMoney: '3900000',
        daysLeft: 13,
        perDay: '300000',
        sharePercent: 50,
        goalRemaining: '10000000',
        accountId: cash,
        accountBalance: '3900000',
        cappedBy: null,
      },
    });
    // The suggestion lives until the end of the day in Tashkent.
    expect(today.suggestion!.expiresAt.toISOString()).toBe(
      '2026-10-19T19:00:00.000Z',
    );

    // Opening the card again refreshes the same suggestion instead of adding another.
    const again = await smartSave.today(session.userId, NOW);
    expect(again.suggestion!.id).toBe(today.suggestion!.id);
  });

  it('explains why there is nothing to suggest', async () => {
    const noGoal = await signUp(http);
    userIds.push(noGoal.userId);
    expect((await smartSave.today(noGoal.userId, NOW)).status).toBe('no_goal');

    const broke = await setup('20000');
    const result = await smartSave.today(broke.session.userId, NOW);
    expect(result).toMatchObject({
      status: 'too_small',
      suggestion: null,
      explanation: { freeMoney: '20000' },
    });
  });

  it('never suggests more than the goal needs or the account holds', async () => {
    const nearlyThere = await setup('3900000', '40000');
    expect(
      (await smartSave.today(nearlyThere.session.userId, NOW)).suggestion,
    ).toMatchObject({
      amount: '40000',
      explanation: { cappedBy: 'goal_remaining' },
    });

    const thin = await setup();
    // Most of the money moves to another account: the default one keeps 50 000.
    const card = await otherAccount(thin.session);
    await http
      .post('/v1/transactions')
      .set(thin.session.auth)
      .send({
        id: randomUUID(),
        type: 'transfer',
        accountId: thin.cash,
        transferAccountId: card,
        amount: '3850000',
        occurredAt: '2026-10-02T05:00:00Z',
      })
      .expect(201);
    expect(
      (await smartSave.today(thin.session.userId, NOW)).suggestion,
    ).toMatchObject({
      amount: '50000',
      explanation: { cappedBy: 'account_balance' },
    });
  });

  async function otherAccount(session: TestSession) {
    const id = randomUUID();
    await http
      .post('/v1/accounts')
      .set(session.auth)
      .send({ id, name: 'Card', currency: 'UZS' })
      .expect(201);
    return id;
  }

  it('accepts once a day, moving the money into the goal', async () => {
    const { session, goalId, cash } = await setup();
    const { suggestion } = await smartSave.today(session.userId, NOW);

    const accepted = await smartSave.accept(
      session.userId,
      suggestion!.id,
      undefined,
      NOW,
    );
    expect(accepted).toMatchObject({
      suggestion: { status: 'accepted', acceptedAmount: '150000' },
      goal: { id: goalId, savedAmount: '150000' },
      contribution: { method: 'smart_save', amount: '150000', accountId: cash },
      newMilestones: [],
    });
    expect(await balance(session, cash)).toBe('3750000');

    // A repeated tap returns the same result and moves nothing.
    const again = await smartSave.accept(
      session.userId,
      suggestion!.id,
      undefined,
      NOW,
    );
    expect(again.contribution.id).toBe(accepted.contribution.id);
    expect(await balance(session, cash)).toBe('3750000');

    expect((await smartSave.today(session.userId, NOW)).status).toBe(
      'already_saved',
    );
  });

  it('lets the user lower the amount, but not raise it', async () => {
    const { session } = await setup();
    const { suggestion } = await smartSave.today(session.userId, NOW);
    await expect(
      smartSave.accept(session.userId, suggestion!.id, '200000', NOW),
    ).rejects.toMatchObject({
      response: { code: 'amount_too_high' },
    });
    const lowered = await smartSave.accept(
      session.userId,
      suggestion!.id,
      '100000',
      NOW,
    );
    expect(lowered).toMatchObject({
      suggestion: { acceptedAmount: '100000' },
      goal: { savedAmount: '100000' },
    });
  });

  it('recalculates on accept and reports a lower amount instead of taking it', async () => {
    const { session, cash } = await setup();
    const { suggestion } = await smartSave.today(session.userId, NOW);
    await http
      .post('/v1/transactions')
      .set(session.auth)
      .send({
        id: randomUUID(),
        type: 'expense',
        accountId: cash,
        amount: '1300000',
        occurredAt: '2026-10-15T05:00:00Z',
      })
      .expect(201);

    await expect(
      smartSave.accept(session.userId, suggestion!.id, undefined, NOW),
    ).rejects.toMatchObject({
      response: {
        code: 'amount_changed',
        expected: '150000',
        actual: '100000',
        suggestion: { amount: '100000' },
      },
    });
    // The refreshed suggestion is accepted as is.
    const accepted = await smartSave.accept(
      session.userId,
      suggestion!.id,
      undefined,
      NOW,
    );
    expect(accepted.goal.savedAmount).toBe('100000');
  });

  it('declines for the day and refuses stale suggestions', async () => {
    const { session } = await setup();
    const { suggestion } = await smartSave.today(session.userId, NOW);
    const declined = await smartSave.decline(
      session.userId,
      suggestion!.id,
      NOW,
    );
    expect(declined.status).toBe('declined');
    expect((await smartSave.today(session.userId, NOW)).status).toBe(
      'declined',
    );

    const other = await setup();
    const yesterday = await smartSave.today(
      other.session.userId,
      new Date('2026-10-18T09:00:00Z'),
    );
    await expect(
      smartSave.accept(
        other.session.userId,
        yesterday.suggestion!.id,
        undefined,
        NOW,
      ),
    ).rejects.toMatchObject({
      response: { code: 'suggestion_expired' },
    });
    const { expired } = await smartSave.expireSuggestions(NOW);
    expect(expired).toBeGreaterThanOrEqual(1);
  });

  it('prepares suggestions in the morning of each user', async () => {
    const morning = await setup();
    const afternoon = await setup();
    // 09:00 UTC is 08:00 in a UTC−1 zone and 14:00 in Tashkent.
    await prisma.users.update({
      where: { id: morning.session.userId },
      data: { timezone: 'Etc/GMT+1' },
    });

    await smartSave.prepareMorningSuggestions(NOW);
    const count = (userId: string) =>
      prisma.smartSaveSuggestions.count({ where: { user_id: userId } });
    expect(await count(morning.session.userId)).toBe(1);
    expect(await count(afternoon.session.userId)).toBe(0);
  });

  it('works over HTTP', async () => {
    const { session } = await setup();
    const today = await http
      .get('/v1/smart-save/today')
      .set(session.auth)
      .expect(200);
    expect(today.body.status).toMatch(/available|too_small|no_spare_money/);
    if (today.body.status === 'available') {
      const declined = await http
        .post(`/v1/smart-save/${today.body.suggestion.id}/decline`)
        .set(session.auth)
        .expect(200);
      expect(declined.body.status).toBe('declined');
    }
    await http
      .post(`/v1/smart-save/${randomUUID()}/accept`)
      .set(session.auth)
      .send({})
      .expect(404);
  });
});
