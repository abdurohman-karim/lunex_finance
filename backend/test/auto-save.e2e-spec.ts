import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { AutoSaveService } from '../src/auto-save/auto-save.service.js';
import { AppSettingsService } from '../src/common/app-settings.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { uuidV5 } from '../src/database/uuid.js';
import { UsersService } from '../src/users/users.service.js';
import {
  resetRateLimits,
  signUp,
  type TestSession,
} from './support/session.js';

/** Tuesday 20 October 2026, 11:00 in Tashkent; the rules below were due on Monday. */
const NOW = new Date('2026-10-20T06:00:00Z');

describe('Auto-save (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  let autoSave: AutoSaveService;
  let originalMonetization: unknown;
  const userIds: string[] = [];

  async function setup(balance = '10000000', target = '10000000') {
    const session = await signUp(http, 'ru');
    userIds.push(session.userId);
    const card = randomUUID();
    await http
      .post('/v1/accounts')
      .set(session.auth)
      .send({
        id: card,
        name: 'Card',
        currency: 'UZS',
        initialBalance: balance,
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
    return { session, card, goalId: goal.body.id as string };
  }

  const rule = (s: TestSession, body: Record<string, unknown>, status = 201) =>
    http
      .post('/v1/auto-save')
      .set(s.auth)
      .send({ id: randomUUID(), ...body })
      .expect(status);

  const operation = async (
    s: TestSession,
    accountId: string,
    type: 'income' | 'expense',
    amount: string,
  ) =>
    (
      await http
        .post('/v1/transactions')
        .set(s.auth)
        .send({
          id: randomUUID(),
          type,
          accountId,
          amount,
          occurredAt: new Date().toISOString(),
        })
        .expect(201)
    ).body.id as string;

  async function balance(s: TestSession, id: string) {
    const res = await http.get('/v1/accounts').set(s.auth).expect(200);
    return res.body.find((a: { id: string }) => a.id === id).currentBalance;
  }

  const contributions = (goalId: string) =>
    prisma.goalContributions.findMany({
      where: { goal_id: goalId, deleted_at: null },
      orderBy: { created_at: 'asc' },
    });

  const notices = (s: TestSession) =>
    prisma.notifications.findMany({
      where: {
        user_id: s.userId,
        type: { in: ['auto_save_done', 'auto_save_skipped'] },
      },
      orderBy: { created_at: 'asc' },
    });

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
    autoSave = app.get(AutoSaveService);
    await resetRateLimits(app);
    originalMonetization = (
      await prisma.appSettings.findUniqueOrThrow({
        where: { key: 'monetization_enabled' },
      })
    ).value;
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

  it('sets a fixed amount aside on its day, once, from the morning', async () => {
    const { session, card, goalId } = await setup();
    const created = await rule(session, {
      goalId,
      type: 'fixed_schedule',
      sourceAccountId: card,
      amount: '100000',
      frequency: 'weekly',
      weekday: 1,
    });
    expect(created.body).toMatchObject({
      type: 'fixed_schedule',
      amount: '100000',
      currency: 'UZS',
      frequency: 'weekly',
      weekday: 1,
      isActive: true,
    });
    await prisma.autoSaveRules.update({
      where: { id: created.body.id },
      data: { next_run_on: new Date('2026-10-19') },
    });

    // 07:00 in Tashkent: yesterday's run is overdue, so it goes now.
    expect(
      (await autoSave.runDue(new Date('2026-10-20T02:00:00Z'), session.userId))
        .saved,
    ).toBe(1);
    expect((await autoSave.runDue(NOW, session.userId)).saved).toBe(0);
    const [saved] = await contributions(goalId);
    expect(saved).toMatchObject({
      id: uuidV5(`auto-save:${created.body.id}:2026-10-20`),
      method: 'auto_save',
      auto_save_rule_id: created.body.id,
      source_account_id: card,
    });
    expect(saved.amount.toString()).toBe('100000');
    expect(await balance(session, card)).toBe('9900000');
    const next = await prisma.autoSaveRules.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(next.next_run_on?.toISOString().slice(0, 10)).toBe('2026-10-26');
    const [notice] = await notices(session);
    expect(notice).toMatchObject({
      type: 'auto_save_done',
      title: '📱 «Телефон»: +100 000 сум',
      body: 'Отложено по расписанию.',
    });
  });

  it('sets a share of every income and the change of every expense aside', async () => {
    const { session, card, goalId } = await setup('1000000');
    const share = await rule(session, {
      goalId,
      type: 'percent_of_income',
      sourceAccountId: card,
      percent: 10,
    });
    const change = await rule(session, {
      goalId,
      type: 'round_up',
      sourceAccountId: card,
      roundTo: '5000',
    });

    const salary = await operation(session, card, 'income', '8000000');
    expect((await autoSave.onOperation(session.userId, salary)).saved).toBe(1);
    // Again (a retried job) changes nothing.
    expect((await autoSave.onOperation(session.userId, salary)).saved).toBe(0);
    const lunch = await operation(session, card, 'expense', '47000');
    expect((await autoSave.onOperation(session.userId, lunch)).saved).toBe(1);
    const exact = await operation(session, card, 'expense', '50000');
    expect((await autoSave.onOperation(session.userId, exact)).saved).toBe(0);

    const saved = await contributions(goalId);
    expect(
      saved.map((c) => [c.method, c.amount.toString(), c.auto_save_rule_id]),
    ).toEqual([
      ['auto_save', '800000', share.body.id],
      ['round_up', '3000', change.body.id],
    ]);
    // 1 000 000 + 8 000 000 − 47 000 − 50 000 − 800 000 − 3 000
    expect(await balance(session, card)).toBe('8100000');
    // Quiet notices, one a day per rule.
    expect((await notices(session)).map((n) => n.body)).toEqual([
      'Отложено 10 % от дохода.',
      'Отложена сдача от покупки.',
    ]);
  });

  it('skips when the account is short and tells the user; never saves past the target', async () => {
    const short = await setup('1000');
    const weekly = await rule(short.session, {
      goalId: short.goalId,
      type: 'fixed_schedule',
      sourceAccountId: short.card,
      amount: '100000',
      frequency: 'daily',
    });
    await prisma.autoSaveRules.update({
      where: { id: weekly.body.id },
      data: { next_run_on: new Date('2026-10-20') },
    });
    expect((await autoSave.runDue(NOW, short.session.userId)).skipped).toBe(1);
    expect(await contributions(short.goalId)).toEqual([]);
    const [notice] = await notices(short.session);
    expect(notice).toMatchObject({
      type: 'auto_save_skipped',
      title: '📱 «Телефон»: взнос пропущен',
      body: 'На счёте «Card» не хватило 100 000 сум.',
    });

    // 950 000 of 1 000 000 saved: the next 100 000 brings only the 50 000 left.
    const almost = await setup('10000000', '1000000');
    await http
      .post(`/v1/goals/${almost.goalId}/contributions`)
      .set(almost.session.auth)
      .send({ id: randomUUID(), type: 'deposit', amount: '950000' })
      .expect(201);
    const last = await rule(almost.session, {
      goalId: almost.goalId,
      type: 'fixed_schedule',
      sourceAccountId: almost.card,
      amount: '100000',
      frequency: 'daily',
    });
    await prisma.autoSaveRules.update({
      where: { id: last.body.id },
      data: { next_run_on: new Date('2026-10-20') },
    });
    await autoSave.runDue(NOW, almost.session.userId);
    const goal = await prisma.goals.findUniqueOrThrow({
      where: { id: almost.goalId },
    });
    expect(goal.saved_amount.toString()).toBe('1000000');
    expect(goal.status).toBe('completed');
    expect(await balance(almost.session, almost.card)).toBe('9950000');

    // The goal is reached: the rule stops at its next run.
    await prisma.autoSaveRules.update({
      where: { id: last.body.id },
      data: { next_run_on: new Date('2026-10-20') },
    });
    expect((await autoSave.runDue(NOW, almost.session.userId)).paused).toBe(1);
    expect(
      (
        await prisma.autoSaveRules.findUniqueOrThrow({
          where: { id: last.body.id },
        })
      ).is_active,
    ).toBe(false);
  });

  it('checks fields, accounts and Lunex Pro', async () => {
    const { session, card, goalId } = await setup();
    const other = await setup();
    await rule(
      session,
      {
        goalId,
        type: 'round_up',
        sourceAccountId: other.card,
        roundTo: '1000',
      },
      400,
    );
    await rule(
      session,
      {
        goalId,
        type: 'percent_of_income',
        sourceAccountId: card,
        percent: 150,
      },
      400,
    );
    await rule(
      session,
      { goalId, type: 'round_up', sourceAccountId: card, roundTo: '1000.5' },
      400,
    );
    const created = await rule(session, {
      goalId,
      type: 'round_up',
      sourceAccountId: card,
      roundTo: '1000',
    });
    await http
      .patch(`/v1/auto-save/${created.body.id}`)
      .set(session.auth)
      .send({ amount: '5000' })
      .expect(400)
      .then((res) => expect(res.body.code).toBe('field_not_allowed'));
    await http
      .patch(`/v1/auto-save/${created.body.id}`)
      .set(session.auth)
      .send({ roundTo: '10000', isActive: false })
      .expect(200)
      .then((res) =>
        expect(res.body).toMatchObject({ roundTo: '10000', isActive: false }),
      );

    // Without Pro (the trial over, monetization on): no new rules, no resuming.
    await setMonetization(true);
    await prisma.subscriptions.updateMany({
      where: { user_id: session.userId },
      data: { expires_at: new Date('2026-01-01') },
    });
    await rule(
      session,
      { goalId, type: 'round_up', sourceAccountId: card, roundTo: '1000' },
      403,
    );
    await http
      .patch(`/v1/auto-save/${created.body.id}`)
      .set(session.auth)
      .send({ isActive: true })
      .expect(403);
    await setMonetization(false);

    await http
      .delete(`/v1/auto-save/${created.body.id}`)
      .set(session.auth)
      .expect(204);
    await http
      .get('/v1/auto-save')
      .query({ goalId })
      .set(session.auth)
      .expect(200)
      .then((res) => expect(res.body).toEqual([]));
  });

  it('syncs rules both ways', async () => {
    const { session, card, goalId } = await setup();
    const id = randomUUID();
    const pushed = await http
      .post('/v1/sync/push')
      .set(session.auth)
      .send({
        operations: [
          {
            opId: 'a1',
            type: 'autoSave.create',
            // The app sends ids in capitals.
            data: {
              id: id.toUpperCase(),
              goalId: goalId.toUpperCase(),
              type: 'percent_of_income',
              sourceAccountId: card.toUpperCase(),
              percent: 12.5,
            },
          },
        ],
      })
      .expect(200);
    expect(pushed.body.results[0]).toMatchObject({ status: 'applied' });
    const full = await http
      .get('/v1/sync/changes')
      .set(session.auth)
      .expect(200);
    expect(full.body.autoSaveRules).toEqual([
      expect.objectContaining({ id, goalId, percent: '12.5', isActive: true }),
    ]);

    await http
      .post('/v1/sync/push')
      .set(session.auth)
      .send({ operations: [{ opId: 'a2', type: 'autoSave.delete', id }] })
      .expect(200);
    const next = await http
      .get('/v1/sync/changes')
      .query({ cursor: full.body.nextCursor })
      .set(session.auth)
      .expect(200);
    expect(next.body.autoSaveRules).toEqual([
      expect.objectContaining({ id, deletedAt: expect.any(String) }),
    ]);
  });
});
