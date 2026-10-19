import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { BudgetService } from '../src/budget/budget.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { systemCategoryId } from '../src/database/reference-data.js';
import { UsersService } from '../src/users/users.service.js';
import {
  resetRateLimits,
  signUp,
  type TestSession,
} from './support/session.js';

const FOOD = systemCategoryId('expense', 'food');
const TRANSPORT = systemCategoryId('expense', 'transport');
const SALARY = systemCategoryId('income', 'salary');

// "Now" is fixed: 19 October 2026, 14:00 in Tashkent. October has 13 days left, today included.
const NOW = new Date('2026-10-19T09:00:00Z');

describe('Budget (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  let budget: BudgetService;
  let uzsId: number;
  const userIds: string[] = [];

  async function setup() {
    const session = await signUp(http, 'ru');
    userIds.push(session.userId);
    const account = randomUUID();
    await http
      .post('/v1/accounts')
      .set(session.auth)
      .send({ id: account, name: 'Cash', currency: 'UZS', initialBalance: '0' })
      .expect(201);
    return { session, account };
  }

  function add(
    session: TestSession,
    account: string,
    body: Record<string, unknown>,
  ) {
    return http
      .post('/v1/transactions')
      .set(session.auth)
      .send({ id: randomUUID(), accountId: account, ...body })
      .expect(201);
  }

  async function rent(userId: string, account: string, nextRunOn: string) {
    await prisma.recurringRules.create({
      data: {
        id: randomUUID(),
        user_id: userId,
        account_id: account,
        type: 'expense',
        title: 'Аренда',
        amount: 1_500_000,
        currency_id: uzsId,
        frequency: 'monthly',
        day_of_month: 25,
        start_on: new Date('2026-01-25'),
        next_run_on: new Date(nextRunOn),
        auto_create: true,
      },
    });
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
    budget = app.get(BudgetService);
    uzsId = (
      await prisma.currencies.findUniqueOrThrow({ where: { code: 'UZS' } })
    ).id;
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

  it('works out the daily limit and what is left for today', async () => {
    const { session, account } = await setup();
    await add(session, account, {
      type: 'income',
      amount: '6000000',
      categoryId: SALARY,
      occurredAt: '2026-10-05T04:00:00Z',
    });
    await add(session, account, {
      type: 'expense',
      amount: '1200000',
      categoryId: FOOD,
      occurredAt: '2026-10-10T08:00:00Z',
    });
    // 01:00 on 19 October in Tashkent, still 18 October in UTC: counts as today.
    await add(session, account, {
      type: 'expense',
      amount: '50000',
      categoryId: TRANSPORT,
      occurredAt: '2026-10-18T20:00:00Z',
    });
    await rent(session.userId, account, '2026-10-25');

    const summary = await budget.current(session.userId, NOW);
    expect(summary).toMatchObject({
      period: {
        start: '2026-10-01',
        end: '2026-10-31',
        today: '2026-10-19',
        daysTotal: 31,
        daysLeft: 13,
      },
      currency: 'UZS',
      mode: 'auto',
      income: { actual: '6000000', planned: null, basis: '6000000' },
      expenses: { total: '1250000', beforeToday: '1200000', today: '50000' },
      upcomingRecurring: '1500000',
      balance: '4750000',
      available: '3300000',
      dailyLimit: '253846',
      safeToSpendToday: '203846',
      state: 'ok',
      incomplete: false,
    });
    expect(summary.byCategory).toEqual([
      { categoryId: FOOD, amount: '1200000' },
      { categoryId: TRANSPORT, amount: '50000' },
    ]);
  });

  it('ignores transfers and deleted operations', async () => {
    const { session, account } = await setup();
    const other = randomUUID();
    await http
      .post('/v1/accounts')
      .set(session.auth)
      .send({ id: other, name: 'Card', currency: 'UZS' })
      .expect(201);
    await add(session, account, {
      type: 'income',
      amount: '1000000',
      occurredAt: '2026-10-02T04:00:00Z',
    });
    await add(session, account, {
      type: 'transfer',
      transferAccountId: other,
      amount: '300000',
      occurredAt: '2026-10-03T04:00:00Z',
    });
    const deleted = await add(session, account, {
      type: 'expense',
      amount: '999000',
      occurredAt: '2026-10-04T04:00:00Z',
    });
    await http
      .delete(`/v1/transactions/${deleted.body.id}`)
      .set(session.auth)
      .expect(204);

    const summary = await budget.current(session.userId, NOW);
    expect(summary.expenses.total).toBe('0');
    expect(summary.available).toBe('1000000');
  });

  it('uses the onboarding income estimate before any income arrives', async () => {
    const { session } = await setup();
    await prisma.users.update({
      where: { id: session.userId },
      data: { monthly_income_estimate: 3_900_000 },
    });
    const summary = await budget.current(session.userId, NOW);
    expect(summary).toMatchObject({
      income: { actual: '0', planned: '3900000', basis: '3900000' },
      dailyLimit: '300000',
      state: 'ok',
    });
  });

  it('asks for income when nothing is known', async () => {
    const { session } = await setup();
    const summary = await budget.current(session.userId, NOW);
    expect(summary).toMatchObject({
      state: 'no_income',
      dailyLimit: '0',
      safeToSpendToday: '0',
    });
  });

  it('starts the month on payday', async () => {
    const { session, account } = await setup();
    await prisma.userSettings.update({
      where: { user_id: session.userId },
      data: { month_starts_on_day: 10 },
    });
    await add(session, account, {
      type: 'income',
      amount: '5000000',
      occurredAt: '2026-10-05T04:00:00Z',
    });
    await add(session, account, {
      type: 'income',
      amount: '6200000',
      occurredAt: '2026-10-10T04:00:00Z',
    });

    const summary = await budget.current(session.userId, NOW);
    expect(summary.period).toEqual({
      start: '2026-10-10',
      end: '2026-11-09',
      today: '2026-10-19',
      daysTotal: 31,
      daysLeft: 22,
    });
    expect(summary.income.actual).toBe('6200000');
  });

  it('applies a planned budget: total limit, savings target and rollover', async () => {
    const { session, account } = await setup();
    await add(session, account, {
      type: 'income',
      amount: '10000000',
      occurredAt: '2026-10-01T04:00:00Z',
    });
    await add(session, account, {
      type: 'expense',
      amount: '1300000',
      occurredAt: '2026-10-08T04:00:00Z',
    });
    await prisma.budgets.create({
      data: {
        id: randomUUID(),
        user_id: session.userId,
        period_start: new Date('2026-10-01'),
        period_end: new Date('2026-10-31'),
        currency_id: uzsId,
        total_limit: 2_600_000,
        savings_target: 2_000_000,
        rollover_enabled: true,
        rollover_amount: 100_000,
      },
    });

    const summary = await budget.current(session.userId, NOW);
    expect(summary).toMatchObject({
      mode: 'planned',
      savingsTarget: '2000000',
      rollover: '100000',
      totalLimit: '2600000',
      // income: (10 000 000 + 100 000 − 2 000 000 − 1 300 000) / 13 = 523 076; limit: (2 600 000 − 1 300 000) / 13 = 100 000
      dailyLimit: '100000',
    });
  });

  it('reserves money already put into goals', async () => {
    const { session, account } = await setup();
    await add(session, account, {
      type: 'income',
      amount: '2000000',
      occurredAt: '2026-10-01T04:00:00Z',
    });
    const goal = await prisma.goals.create({
      data: {
        id: randomUUID(),
        user_id: session.userId,
        title: 'Телефон',
        color: '#0A84FF',
        target_amount: 9_000_000,
        currency_id: uzsId,
      },
    });
    await prisma.goalContributions.create({
      data: {
        id: randomUUID(),
        goal_id: goal.id,
        user_id: session.userId,
        type: 'deposit',
        amount: 700_000,
        currency_id: uzsId,
        method: 'manual',
        created_at: new Date('2026-10-12T06:00:00Z'),
      },
    });

    const summary = await budget.current(session.userId, NOW);
    expect(summary).toMatchObject({
      savedToGoals: '700000',
      available: '1300000',
      dailyLimit: '100000',
    });
  });

  it('reports overspending today', async () => {
    const { session, account } = await setup();
    await add(session, account, {
      type: 'income',
      amount: '1300000',
      occurredAt: '2026-10-01T04:00:00Z',
    });
    await add(session, account, {
      type: 'expense',
      amount: '250000',
      occurredAt: '2026-10-19T06:00:00Z',
    });
    const summary = await budget.current(session.userId, NOW);
    expect(summary).toMatchObject({
      dailyLimit: '100000',
      safeToSpendToday: '-150000',
      state: 'overspent',
    });
  });

  it('serves the current month over HTTP', async () => {
    const { session } = await setup();
    const res = await http
      .get('/v1/budget/current')
      .set(session.auth)
      .expect(200);
    expect(res.body).toMatchObject({
      currency: 'UZS',
      mode: 'auto',
      state: 'no_income',
    });
    expect(res.body.period.daysLeft).toBeGreaterThanOrEqual(1);
    await http.get('/v1/budget/current').expect(401);
  });
});
