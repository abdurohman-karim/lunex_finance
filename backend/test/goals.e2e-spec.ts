import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { AppSettingsService } from '../src/common/app-settings.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { UsersService } from '../src/users/users.service.js';
import {
  resetRateLimits,
  signUp,
  type TestSession,
} from './support/session.js';

describe('Goals (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  let originalMonetization: unknown;
  const userIds: string[] = [];

  async function newUser() {
    const session = await signUp(http, 'ru');
    userIds.push(session.userId);
    return session;
  }

  async function account(
    s: TestSession,
    name: string,
    currency = 'UZS',
    initialBalance = '0',
  ) {
    const id = randomUUID();
    await http
      .post('/v1/accounts')
      .set(s.auth)
      .send({ id, name, currency, initialBalance })
      .expect(201);
    return id;
  }

  async function balance(s: TestSession, id: string) {
    const res = await http.get('/v1/accounts').set(s.auth).expect(200);
    return res.body.find((a: { id: string }) => a.id === id)
      .currentBalance as string;
  }

  async function goal(s: TestSession, body: Record<string, unknown> = {}) {
    const res = await http
      .post('/v1/goals')
      .set(s.auth)
      .send({
        id: randomUUID(),
        title: 'Цель',
        targetAmount: '10000000',
        ...body,
      })
      .expect(201);
    return res.body;
  }

  const contribute = (
    s: TestSession,
    goalId: string,
    body: Record<string, unknown>,
  ) =>
    http
      .post(`/v1/goals/${goalId}/contributions`)
      .set(s.auth)
      .send({ id: randomUUID(), type: 'deposit', ...body });

  async function setMonetization(enabled: boolean) {
    await prisma.appSettings.update({
      where: { key: 'monetization_enabled' },
      data: { value: enabled },
    });
    app.get(AppSettingsService).invalidate();
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
    await setMonetization(false);
  });

  afterAll(async () => {
    try {
      await setMonetization(originalMonetization as boolean);
      const users = app.get(UsersService);
      for (const id of userIds) await users.purgeUser(id);
    } finally {
      await app.close();
    }
  });

  it('offers templates in the user language', async () => {
    const me = await newUser();
    const res = await http.get('/v1/goals/templates').set(me.auth).expect(200);
    expect(res.body).toHaveLength(8);
    expect(res.body[0]).toMatchObject({
      key: 'phone',
      emoji: '📱',
      name: 'Телефон',
    });
  });

  it('creates a goal from a template; the first one is primary', async () => {
    const me = await newUser();
    const first = await goal(me, {
      title: 'Новый iPhone',
      templateKey: 'phone',
      deadline: '2099-12-31',
    });
    expect(first).toMatchObject({
      title: 'Новый iPhone',
      emoji: '📱',
      color: '#0A84FF',
      currency: 'UZS',
      savedAmount: '0',
      remaining: '10000000',
      progress: 0,
      status: 'active',
      isPrimary: true,
      milestones: [],
      deadline: '2099-12-31',
    });
    expect(first.schedule).toMatchObject({ status: 'on_track' });

    const second = await goal(me, { title: 'Отпуск' });
    expect(second).toMatchObject({
      isPrimary: false,
      emoji: '🎯',
      schedule: null,
      priority: 1,
    });

    const past = await http
      .post('/v1/goals')
      .set(me.auth)
      .send({
        id: randomUUID(),
        title: 'X',
        targetAmount: '100',
        deadline: '2001-01-01',
      })
      .expect(400);
    expect(past.body.code).toBe('deadline_in_past');
  });

  it('moves money on deposits, marks milestones once and completes the goal', async () => {
    const me = await newUser();
    const cash = await account(me, 'Наличные', 'UZS', '20000000');
    const phone = await goal(me, { title: 'Телефон' });
    const trip = await goal(me, { title: 'Поездка' });

    const first = await contribute(me, phone.id, {
      amount: '2500000',
      accountId: cash,
    }).expect(201);
    expect(first.body).toMatchObject({
      newMilestones: [25],
      completed: false,
      goal: { savedAmount: '2500000', progress: 25 },
      contribution: {
        type: 'deposit',
        amount: '2500000',
        accountId: cash,
        accountAmount: '2500000',
        method: 'manual',
      },
    });
    expect(await balance(me, cash)).toBe('17500000');

    const second = await contribute(me, phone.id, {
      amount: '3500000',
      accountId: cash,
    }).expect(201);
    expect(second.body.newMilestones).toEqual([50]);

    const last = await contribute(me, phone.id, {
      amount: '4000000',
      accountId: cash,
    }).expect(201);
    expect(last.body).toMatchObject({
      newMilestones: [75, 100],
      completed: true,
      goal: {
        status: 'completed',
        progress: 100,
        isPrimary: false,
        milestones: [25, 50, 75, 100],
      },
    });
    expect(last.body.goal.completedAt).not.toBeNull();
    expect(await balance(me, cash)).toBe('10000000');

    // The next live goal takes over as primary; a reached goal takes no more deposits.
    expect(
      (await http.get(`/v1/goals/${trip.id}`).set(me.auth).expect(200)).body
        .isPrimary,
    ).toBe(true);
    const more = await contribute(me, phone.id, {
      amount: '1',
      accountId: cash,
    }).expect(409);
    expect(more.body.code).toBe('goal_completed');
  });

  it('does not count a retried deposit twice', async () => {
    const me = await newUser();
    const cash = await account(me, 'Cash', 'UZS', '1000000');
    const g = await goal(me);
    const body = {
      id: randomUUID(),
      type: 'deposit',
      amount: '300000',
      accountId: cash,
    };
    await http
      .post(`/v1/goals/${g.id}/contributions`)
      .set(me.auth)
      .send(body)
      .expect(201);
    const again = await http
      .post(`/v1/goals/${g.id}/contributions`)
      .set(me.auth)
      .send(body)
      .expect(201);
    expect(again.body).toMatchObject({
      goal: { savedAmount: '300000' },
      newMilestones: [],
    });
    expect(await balance(me, cash)).toBe('700000');
  });

  it('withdraws to an account, never more than saved, and undoes contributions', async () => {
    const me = await newUser();
    const cash = await account(me, 'Cash', 'UZS', '5000000');
    const g = await goal(me, { targetAmount: '1000000' });
    const deposit = await contribute(me, g.id, {
      amount: '1000000',
      accountId: cash,
    }).expect(201);
    expect(deposit.body.goal.status).toBe('completed');

    const tooMuch = await contribute(me, g.id, {
      type: 'withdrawal',
      amount: '1000001',
      accountId: cash,
    }).expect(409);
    expect(tooMuch.body.code).toBe('insufficient_goal_funds');

    // Taking money out of a reached goal (to buy the thing) is allowed.
    await contribute(me, g.id, {
      type: 'withdrawal',
      amount: '400000',
      accountId: cash,
    }).expect(201);
    expect(await balance(me, cash)).toBe('4400000');

    // The deposit cannot be undone while part of it is already withdrawn…
    const blocked = await http
      .delete(`/v1/goals/${g.id}/contributions/${deposit.body.contribution.id}`)
      .set(me.auth)
      .expect(409);
    expect(blocked.body.code).toBe('insufficient_goal_funds');

    // …while undoing a withdrawal returns the money and the goal stays reached.
    const extra = await contribute(me, g.id, {
      type: 'withdrawal',
      amount: '100000',
      accountId: cash,
    }).expect(201);
    const undone = await http
      .delete(`/v1/goals/${g.id}/contributions/${extra.body.contribution.id}`)
      .set(me.auth)
      .expect(200);
    expect(undone.body).toMatchObject({
      savedAmount: '600000',
      status: 'completed',
    });
    expect(await balance(me, cash)).toBe('4400000');
  });

  it('reopens a reached goal when a deposit is undone', async () => {
    const me = await newUser();
    const cash = await account(me, 'Cash', 'UZS', '2000000');
    const g = await goal(me, { targetAmount: '1000000' });
    const done = await contribute(me, g.id, {
      amount: '1000000',
      accountId: cash,
    }).expect(201);
    const reopened = await http
      .delete(`/v1/goals/${g.id}/contributions/${done.body.contribution.id}`)
      .set(me.auth)
      .expect(200);
    expect(reopened.body).toMatchObject({
      status: 'active',
      savedAmount: '0',
      isPrimary: true,
      milestones: [25, 50, 75, 100],
    });
    expect(await balance(me, cash)).toBe('2000000');
  });

  it('keeps money in the savings account and converts other currencies', async () => {
    const me = await newUser();
    const cash = await account(me, 'Cash', 'UZS', '3000000');
    const savings = await account(me, 'Копилка', 'UZS', '0');
    const dollars = await account(me, 'USD', 'USD', '500');
    const g = await goal(me, { linkedAccountId: savings });

    await contribute(me, g.id, { amount: '1000000', accountId: cash }).expect(
      201,
    );
    expect([await balance(me, cash), await balance(me, savings)]).toEqual([
      '2000000',
      '1000000',
    ]);

    // Money already in the savings account is only earmarked.
    await contribute(me, g.id, { amount: '200000', accountId: savings }).expect(
      201,
    );
    expect(await balance(me, savings)).toBe('1000000');

    const usd = await contribute(me, g.id, {
      amount: '1265000',
      accountId: dollars,
      accountAmount: '100',
    }).expect(201);
    expect(usd.body.contribution).toMatchObject({
      accountAmount: '100.00',
      accountCurrency: 'USD',
    });
    expect([await balance(me, dollars), await balance(me, savings)]).toEqual([
      '400.00',
      '2265000',
    ]);

    const noRate = await contribute(me, g.id, {
      amount: '1000',
      accountId: dollars,
    }).expect(422);
    expect(noRate.body.code).toBe('exchange_rate_unavailable');

    const wrongCurrency = await http
      .post('/v1/goals')
      .set(me.auth)
      .send({
        id: randomUUID(),
        title: 'X',
        targetAmount: '100',
        linkedAccountId: dollars,
      })
      .expect(400);
    expect(wrongCurrency.body.code).toBe('invalid_linked_account');
  });

  it('manages primary, priority, pause and archive', async () => {
    const me = await newUser();
    const a = await goal(me, { title: 'A' });
    const b = await goal(me, { title: 'B' });
    const c = await goal(me, { title: 'C' });

    await http
      .patch(`/v1/goals/${b.id}`)
      .set(me.auth)
      .send({ isPrimary: true })
      .expect(200);
    const order = await http
      .put('/v1/goals/order')
      .set(me.auth)
      .send({ ids: [c.id, b.id, a.id] })
      .expect(200);
    expect(order.body.map((g: { title: string }) => g.title)).toEqual([
      'C',
      'B',
      'A',
    ]);
    expect(
      order.body.find((g: { id: string }) => g.id === b.id).isPrimary,
    ).toBe(true);

    // Archiving the primary goal hands the role to the next live goal by priority.
    await http
      .patch(`/v1/goals/${b.id}`)
      .set(me.auth)
      .send({ status: 'archived' })
      .expect(200);
    const afterArchive = await http.get('/v1/goals').set(me.auth).expect(200);
    expect(
      afterArchive.body
        .filter((g: { isPrimary: boolean }) => g.isPrimary)
        .map((g: { title: string }) => g.title),
    ).toEqual(['C']);

    const paused = await http
      .patch(`/v1/goals/${c.id}`)
      .set(me.auth)
      .send({ status: 'paused' })
      .expect(200);
    expect(paused.body).toMatchObject({ status: 'paused', isPrimary: true });

    const archivedPrimary = await http
      .patch(`/v1/goals/${b.id}`)
      .set(me.auth)
      .send({ isPrimary: true })
      .expect(409);
    expect(archivedPrimary.body.code).toBe('goal_not_active');

    const back = await http
      .patch(`/v1/goals/${b.id}`)
      .set(me.auth)
      .send({ status: 'active' })
      .expect(200);
    expect(back.body).toMatchObject({ status: 'active', archivedAt: null });
  });

  it('applies the Free limit of active goals', async () => {
    const me = await newUser();
    const goals = [await goal(me), await goal(me), await goal(me)];
    await setMonetization(true);
    await prisma.subscriptions.updateMany({
      where: { user_id: me.userId },
      data: { expires_at: new Date(Date.now() - 60_000) },
    });
    try {
      const fourth = await http
        .post('/v1/goals')
        .set(me.auth)
        .send({ id: randomUUID(), title: 'Ещё', targetAmount: '100' })
        .expect(403);
      expect(fourth.body).toMatchObject({
        code: 'free_limit_reached',
        resource: 'active_goals',
        limit: 3,
      });

      await http
        .patch(`/v1/goals/${goals[0].id}`)
        .set(me.auth)
        .send({ status: 'paused' })
        .expect(200);
      await goal(me, { title: 'Ещё' });
      const resume = await http
        .patch(`/v1/goals/${goals[0].id}`)
        .set(me.auth)
        .send({ status: 'active' })
        .expect(403);
      expect(resume.body.code).toBe('free_limit_reached');
    } finally {
      await setMonetization(false);
    }
  });

  it('deletes only empty goals', async () => {
    const me = await newUser();
    const cash = await account(me, 'Cash', 'UZS', '1000');
    const full = await goal(me);
    const empty = await goal(me);
    await contribute(me, full.id, { amount: '500', accountId: cash }).expect(
      201,
    );
    expect(
      (await http.delete(`/v1/goals/${full.id}`).set(me.auth).expect(409)).body
        .code,
    ).toBe('goal_has_money');
    await http.delete(`/v1/goals/${empty.id}`).set(me.auth).expect(204);
    await http.get(`/v1/goals/${empty.id}`).set(me.auth).expect(404);
  });

  it('pages the contribution history', async () => {
    const me = await newUser();
    const g = await goal(me);
    for (let i = 1; i <= 3; i++)
      await contribute(me, g.id, { amount: String(i * 1000) }).expect(201);
    const page1 = await http
      .get(`/v1/goals/${g.id}/contributions`)
      .query({ limit: 2 })
      .set(me.auth)
      .expect(200);
    const page2 = await http
      .get(`/v1/goals/${g.id}/contributions`)
      .query({ limit: 2, cursor: page1.body.nextCursor })
      .set(me.auth)
      .expect(200);
    const amounts = [...page1.body.items, ...page2.body.items].map(
      (c: { amount: string }) => c.amount,
    );
    expect(amounts).toEqual(['3000', '2000', '1000']);
    expect(page2.body.nextCursor).toBeNull();
  });

  it('syncs goals and contributions, including undo', async () => {
    const me = await newUser();
    const goalId = randomUUID();
    const contributionId = randomUUID();
    const pushed = await http
      .post('/v1/sync/push')
      .set(me.auth)
      .send({
        operations: [
          {
            opId: 'g',
            type: 'goal.create',
            data: { id: goalId, title: 'Синк', targetAmount: '1000' },
          },
          {
            opId: 'c',
            type: 'goal.contribute',
            goalId,
            data: { id: contributionId, type: 'deposit', amount: '250' },
          },
        ],
      })
      .expect(200);
    expect(
      pushed.body.results.map((r: { status: string }) => r.status),
    ).toEqual(['applied', 'applied']);
    expect(pushed.body.results[1].record.newMilestones).toEqual([25]);

    const full = await http.get('/v1/sync/changes').set(me.auth).expect(200);
    expect(full.body.goals).toEqual([
      expect.objectContaining({ id: goalId, savedAmount: '250' }),
    ]);
    expect(full.body.goalContributions).toEqual([
      expect.objectContaining({ id: contributionId, deletedAt: null }),
    ]);

    await http
      .post('/v1/sync/push')
      .set(me.auth)
      .send({
        operations: [
          {
            opId: 'u',
            type: 'goal.contribution.delete',
            goalId,
            id: contributionId,
          },
        ],
      })
      .expect(200);
    const changes = await http
      .get('/v1/sync/changes')
      .query({ cursor: full.body.nextCursor })
      .set(me.auth)
      .expect(200);
    expect(changes.body.goals).toEqual([
      expect.objectContaining({ id: goalId, savedAmount: '0' }),
    ]);
    expect(changes.body.goalContributions).toEqual([
      expect.objectContaining({
        id: contributionId,
        deletedAt: expect.any(String),
      }),
    ]);
  });
});
