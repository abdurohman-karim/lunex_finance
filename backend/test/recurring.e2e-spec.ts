import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { localDate } from '../src/common/dates.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { systemCategoryId } from '../src/database/reference-data.js';
import { uuidV5 } from '../src/database/uuid.js';
import { firstOnOrAfter } from '../src/finance/recurrence.js';
import { RecurringService } from '../src/finance/recurring/recurring.service.js';
import { UsersService } from '../src/users/users.service.js';
import {
  resetRateLimits,
  signUp,
  type TestSession,
} from './support/session.js';

const SUBSCRIPTIONS = systemCategoryId('expense', 'subscriptions');
const SALARY = systemCategoryId('income', 'salary');

// "Now" is fixed for the hourly job: 19 October 2026, 14:00 in Tashkent.
const NOW = new Date('2026-10-19T09:00:00Z');

describe('Recurring payments (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  let recurring: RecurringService;
  const userIds: string[] = [];

  async function setup() {
    const session = await signUp(http, 'ru');
    userIds.push(session.userId);
    const account = randomUUID();
    await http
      .post('/v1/accounts')
      .set(session.auth)
      .send({
        id: account,
        name: 'Card',
        currency: 'UZS',
        initialBalance: '1000000',
      })
      .expect(201);
    return { session, account };
  }

  const netflix = (
    account: string,
    overrides: Record<string, unknown> = {},
  ) => ({
    id: randomUUID(),
    title: 'Netflix',
    type: 'expense',
    amount: '99000',
    accountId: account,
    categoryId: SUBSCRIPTIONS,
    frequency: 'monthly',
    startOn: '2026-01-15',
    isSubscription: true,
    ...overrides,
  });

  async function balance(session: TestSession, id: string) {
    const res = await http.get('/v1/accounts').set(session.auth).expect(200);
    return res.body.find((a: { id: string }) => a.id === id).currentBalance;
  }

  /** A rule whose runs are already due on NOW. */
  async function dueRule(
    session: TestSession,
    account: string,
    nextRunOn: string,
    autoCreate = true,
  ) {
    const res = await http
      .post('/v1/recurring')
      .set(session.auth)
      .send(netflix(account, { autoCreate }))
      .expect(201);
    await prisma.recurringRules.update({
      where: { id: res.body.id },
      data: { next_run_on: new Date(nextRunOn) },
    });
    return res.body.id as string;
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
    recurring = app.get(RecurringService);
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

  it('starts a rule from today: past runs of an existing payment are not repeated', async () => {
    const { session, account } = await setup();
    const res = await http
      .post('/v1/recurring')
      .set(session.auth)
      .send(netflix(account))
      .expect(201);
    const today = localDate(new Date(), 'Asia/Tashkent');
    expect(res.body).toMatchObject({
      title: 'Netflix',
      amount: '99000',
      currency: 'UZS',
      frequency: 'monthly',
      interval: 1,
      dayOfMonth: null,
      startOn: '2026-01-15',
      endOn: null,
      nextRunOn: firstOnOrAfter(
        {
          frequency: 'monthly',
          interval: 1,
          dayOfMonth: null,
          startOn: '2026-01-15',
        },
        today,
      ),
      autoCreate: false,
      remindDaysBefore: 1,
      isSubscription: true,
      isActive: true,
    });

    // The same id again is the same rule.
    await http
      .post('/v1/recurring')
      .set(session.auth)
      .send({ ...netflix(account), id: res.body.id, title: 'Other' })
      .expect(201)
      .then((again) => expect(again.body.title).toBe('Netflix'));

    // A new payment day moves the next run; the list has the rule once.
    const moved = await http
      .patch(`/v1/recurring/${res.body.id}`)
      .set(session.auth)
      .send({ dayOfMonth: 1, startOn: '2026-12-01' })
      .expect(200);
    expect(moved.body.nextRunOn).toBe('2026-12-01');
    const list = await http.get('/v1/recurring').set(session.auth).expect(200);
    expect(list.body.map((r: { id: string }) => r.id)).toEqual([res.body.id]);
  });

  it('creates the due runs of a rule that makes its operations, each once', async () => {
    const { session, account } = await setup();
    const id = await dueRule(session, account, '2026-08-15');

    expect(await recurring.runDue(NOW, session.userId)).toEqual({
      created: 3,
      paused: 0,
    });
    const runs = await prisma.transactions.findMany({
      where: { recurring_rule_id: id },
      orderBy: { occurred_at: 'asc' },
    });
    expect(runs.map((t) => t.id)).toEqual(
      ['2026-08-15', '2026-09-15', '2026-10-15'].map((date) =>
        uuidV5(`recurring:${id}:${date}`),
      ),
    );
    expect(
      runs.every((t) => t.source === 'recurring' && t.note === 'Netflix'),
    ).toBe(true);
    expect(await balance(session, account)).toBe('703000');
    const rule = await prisma.recurringRules.findUniqueOrThrow({
      where: { id },
    });
    expect(rule.next_run_on.toISOString().slice(0, 10)).toBe('2026-11-15');

    // The hourly job again, or the same runs after a crash, create nothing new.
    await prisma.recurringRules.update({
      where: { id },
      data: { next_run_on: new Date('2026-09-15') },
    });
    expect(await recurring.runDue(NOW, session.userId)).toEqual({
      created: 0,
      paused: 0,
    });
    expect(await balance(session, account)).toBe('703000');
  });

  it('pauses a rule whose account can no longer take its operations', async () => {
    const { session, account } = await setup();
    const id = await dueRule(session, account, '2026-10-15');
    await http
      .patch(`/v1/accounts/${account}`)
      .set(session.auth)
      .send({ isArchived: true })
      .expect(200);

    expect(await recurring.runDue(NOW, session.userId)).toEqual({
      created: 0,
      paused: 1,
    });
    const rule = await prisma.recurringRules.findUniqueOrThrow({
      where: { id },
    });
    expect(rule.is_active).toBe(false);
  });

  it('records and skips the runs of a reminder', async () => {
    const { session, account } = await setup();
    const id = await dueRule(session, account, '2026-10-15', false);
    expect((await recurring.runDue(NOW, session.userId)).created).toBe(0);

    const transactionId = randomUUID();
    const record = () =>
      http
        .post(`/v1/recurring/${id}/record`)
        .set(session.auth)
        .send({ transactionId, date: '2026-10-15', amount: '105000' })
        .expect(200);
    const recorded = await record();
    expect(recorded.body).toMatchObject({
      rule: { nextRunOn: '2026-11-15' },
      transaction: {
        id: transactionId,
        amount: '105000',
        categoryId: SUBSCRIPTIONS,
        note: 'Netflix',
        source: 'recurring',
      },
    });
    // A resent «Записать» charges once.
    await record();
    expect(await balance(session, account)).toBe('895000');

    const skipped = await http
      .post(`/v1/recurring/${id}/skip`)
      .set(session.auth)
      .send({ date: '2026-11-15' })
      .expect(200);
    expect(skipped.body.nextRunOn).toBe('2026-12-15');
    // An older day does not move the next run back.
    await http
      .post(`/v1/recurring/${id}/skip`)
      .set(session.auth)
      .send({ date: '2026-10-15' })
      .expect(200)
      .then((res) => expect(res.body.nextRunOn).toBe('2026-12-15'));
  });

  it('syncs rules both ways and makes missed runs at sync', async () => {
    const { session, account } = await setup();
    const id = randomUUID();
    const pushed = await http
      .post('/v1/sync/push')
      .set(session.auth)
      .send({
        operations: [
          {
            opId: 'r1',
            type: 'recurring.create',
            // The app sends ids in capitals.
            data: {
              ...netflix(account.toUpperCase(), {
                id: id.toUpperCase(),
                autoCreate: true,
              }),
              categoryId: SUBSCRIPTIONS.toUpperCase(),
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
    expect(full.body.recurringRules).toEqual([
      expect.objectContaining({ id, title: 'Netflix', autoCreate: true }),
    ]);

    // Due runs the hourly job has not made yet come with the next sync.
    await prisma.recurringRules.update({
      where: { id },
      data: { next_run_on: new Date('2026-09-15') },
    });
    const next = await http
      .get('/v1/sync/changes')
      .query({ cursor: full.body.nextCursor })
      .set(session.auth)
      .expect(200);
    expect(
      next.body.transactions.map((t: { id: string }) => t.id).sort(),
    ).toEqual(
      ['2026-09-15', '2026-10-15']
        .map((date) => uuidV5(`recurring:${id}:${date}`))
        .sort(),
    );
    expect(next.body.recurringRules).toEqual([
      expect.objectContaining({ id, nextRunOn: '2026-11-15' }),
    ]);

    await http
      .post('/v1/sync/push')
      .set(session.auth)
      .send({
        operations: [
          {
            opId: 'r2',
            type: 'recurring.update',
            id,
            data: { isActive: false },
          },
          { opId: 'r3', type: 'recurring.delete', id },
        ],
      })
      .expect(200);
    const last = await http
      .get('/v1/sync/changes')
      .query({ cursor: next.body.nextCursor })
      .set(session.auth)
      .expect(200);
    expect(last.body.recurringRules).toEqual([
      expect.objectContaining({
        id,
        isActive: false,
        deletedAt: expect.any(String),
      }),
    ]);
    await http
      .get('/v1/recurring')
      .set(session.auth)
      .expect(200)
      .then((res) => expect(res.body).toEqual([]));
  });

  it('checks accounts, categories, dates and amounts', async () => {
    const { session, account } = await setup();
    const other = await setup();
    const refuse = (body: Record<string, unknown>, code?: string) =>
      http
        .post('/v1/recurring')
        .set(session.auth)
        .send(body)
        .expect(400)
        .then((res) => code && expect(res.body.code).toBe(code));

    await refuse(netflix(account, { categoryId: SALARY }), 'invalid_category');
    await refuse(netflix(other.account), 'invalid_account');
    await refuse(netflix(account, { amount: '99000.5' }), 'too_many_decimals');
    await refuse(netflix(account, { endOn: '2025-12-31' }));
    await refuse(netflix(account, { interval: 0 }));
    await http
      .post('/v1/recurring')
      .set(session.auth)
      .send(
        netflix(account, {
          title: 'Зарплата',
          type: 'income',
          categoryId: SALARY,
          frequency: 'monthly',
          dayOfMonth: 31,
          isSubscription: false,
        }),
      )
      .expect(201);
    await http
      .patch(`/v1/recurring/${randomUUID()}`)
      .set(session.auth)
      .send({ title: 'x' })
      .expect(404);
  });
});
