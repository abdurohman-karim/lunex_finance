import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { BudgetService } from '../src/budget/budget.service.js';
import { AppSettingsService } from '../src/common/app-settings.service.js';
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
    // September leaves 100 000: 400 000 earned, 300 000 spent.
    await add(session, account, {
      type: 'income',
      amount: '400000',
      occurredAt: '2026-09-02T04:00:00Z',
    });
    await add(session, account, {
      type: 'expense',
      amount: '300000',
      occurredAt: '2026-09-10T04:00:00Z',
    });
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

  describe('plans', () => {
    const NOVEMBER = new Date('2026-11-03T09:00:00Z');

    async function coffee(session: TestSession) {
      const id = randomUUID();
      await http
        .post('/v1/categories')
        .set(session.auth)
        .send({
          id,
          type: 'expense',
          name: 'Кофе',
          icon: 'cup.and.saucer',
          color: '#8C7B6B',
          parentId: FOOD,
        })
        .expect(201);
      return id;
    }

    it('repeats the plan in the next month and carries what was left', async () => {
      const { session, account } = await setup();
      const cup = await coffee(session);
      await add(session, account, {
        type: 'income',
        amount: '6000000',
        occurredAt: '2026-10-01T04:00:00Z',
      });
      await add(session, account, {
        type: 'expense',
        amount: '1000000',
        categoryId: FOOD,
        occurredAt: '2026-10-05T04:00:00Z',
      });
      await add(session, account, {
        type: 'expense',
        amount: '200000',
        categoryId: cup,
        occurredAt: '2026-10-06T04:00:00Z',
      });

      const october = await budget.setPlan(
        session.userId,
        {
          plannedIncome: '6000000',
          totalLimit: null,
          savingsTarget: '500000',
          rolloverEnabled: true,
          categoryLimits: [
            { categoryId: FOOD, limit: '1500000', alertThresholdPct: 80 },
          ],
        },
        NOW,
      );
      expect(october).toMatchObject({
        mode: 'planned',
        savingsTarget: '500000',
        rolloverEnabled: true,
        // September had nothing to carry
        rollover: '0',
        // The limit of «Еда» counts its subcategory «Кофе»
        categoryLimits: [
          {
            categoryId: FOOD,
            limit: '1500000',
            spent: '1200000',
            alertThresholdPct: 80,
          },
        ],
      });

      const november = await budget.current(session.userId, NOVEMBER);
      expect(november).toMatchObject({
        period: { start: '2026-11-01', end: '2026-11-30' },
        mode: 'planned',
        income: { planned: '6000000' },
        savingsTarget: '500000',
        rolloverEnabled: true,
        // October: 6 000 000 earned − 1 200 000 spent, nothing saved
        rollover: '4800000',
        categoryLimits: [{ categoryId: FOOD, limit: '1500000', spent: '0' }],
      });

      // An October expense added later changes what November carries.
      await add(session, account, {
        type: 'expense',
        amount: '300000',
        categoryId: TRANSPORT,
        occurredAt: '2026-10-15T04:00:00Z',
      });
      expect((await budget.current(session.userId, NOVEMBER)).rollover).toBe(
        '4500000',
      );
      expect(
        await prisma.budgets.count({ where: { user_id: session.userId } }),
      ).toBe(2);
    });

    it('takes the plan over HTTP and from the sync queue', async () => {
      const { session } = await setup();
      const res = await http
        .put('/v1/budget/current')
        .set(session.auth)
        .send({ plannedIncome: '4000000', totalLimit: '3000000' })
        .expect(200);
      expect(res.body).toMatchObject({
        mode: 'planned',
        income: { planned: '4000000' },
        totalLimit: '3000000',
        savingsTarget: '0',
        rolloverEnabled: false,
        categoryLimits: [],
      });

      // The app sends ids in capitals.
      const operation = {
        opId: 'b1',
        type: 'budget.set',
        data: {
          plannedIncome: null,
          totalLimit: null,
          savingsTarget: '200000',
          categoryLimits: [
            { categoryId: TRANSPORT.toUpperCase(), limit: '400000' },
          ],
        },
      };
      const push = () =>
        http
          .post('/v1/sync/push')
          .set(session.auth)
          .send({ operations: [operation] })
          .expect(200);
      const pushed = await push();
      expect(pushed.body.results[0]).toMatchObject({ status: 'applied' });

      const current = await http
        .get('/v1/budget/current')
        .set(session.auth)
        .expect(200);
      expect(current.body).toMatchObject({
        totalLimit: null,
        savingsTarget: '200000',
        categoryLimits: [
          { categoryId: TRANSPORT, limit: '400000', alertThresholdPct: 80 },
        ],
      });
      // A resent queue sets the same plan again.
      expect((await push()).body.results[0]).toMatchObject({
        status: 'applied',
      });
      expect(
        await prisma.budgetCategoryLimits.count({
          where: { budget: { user_id: session.userId } },
        }),
      ).toBe(1);
    });

    it('accepts only expense categories of the account, once each', async () => {
      const { session } = await setup();
      const refuse = (categoryLimits: unknown[], code: string) =>
        http
          .put('/v1/budget/current')
          .set(session.auth)
          .send({ categoryLimits })
          .expect(400)
          .then((res) => expect(res.body.code).toBe(code));
      await refuse([{ categoryId: SALARY, limit: '100' }], 'invalid_category');
      await refuse(
        [{ categoryId: randomUUID(), limit: '100' }],
        'invalid_category',
      );
      await refuse(
        [
          { categoryId: FOOD, limit: '100' },
          { categoryId: FOOD, limit: '200' },
        ],
        'duplicate_category',
      );
      await http
        .put('/v1/budget/current')
        .set(session.auth)
        .send({ totalLimit: '0' })
        .expect(400);
    });

    it('keeps category limits and carrying for Lunex Pro once monetization is on', async () => {
      const settings = app.get(AppSettingsService);
      const setting = await prisma.appSettings.findUniqueOrThrow({
        where: { key: 'monetization_enabled' },
      });
      const { session } = await setup();
      try {
        await prisma.appSettings.update({
          where: { key: 'monetization_enabled' },
          data: { value: true },
        });
        settings.invalidate();
        await prisma.subscriptions.updateMany({
          where: { user_id: session.userId, source: 'trial' },
          data: { expires_at: new Date(Date.now() - 60_000) },
        });

        const limits = await http
          .put('/v1/budget/current')
          .set(session.auth)
          .send({ categoryLimits: [{ categoryId: FOOD, limit: '100000' }] })
          .expect(403);
        expect(limits.body).toMatchObject({
          code: 'pro_required',
          feature: 'category_limits',
        });
        const rollover = await http
          .put('/v1/budget/current')
          .set(session.auth)
          .send({ rolloverEnabled: true })
          .expect(403);
        expect(rollover.body.feature).toBe('budget_rollover');
        // The rest of the plan is free.
        await http
          .put('/v1/budget/current')
          .set(session.auth)
          .send({ plannedIncome: '5000000', savingsTarget: '1000000' })
          .expect(200);
      } finally {
        await prisma.appSettings.update({
          where: { key: 'monetization_enabled' },
          data: { value: setting.value as boolean },
        });
        settings.invalidate();
      }
    });

    it('suggests limits from the average of the last three months', async () => {
      const { session, account } = await setup();
      const cup = await coffee(session);
      for (const month of ['07', '08', '09']) {
        await add(session, account, {
          type: 'income',
          amount: '5000000',
          occurredAt: `2026-${month}-02T04:00:00Z`,
        });
        await add(session, account, {
          type: 'expense',
          amount: '300000',
          categoryId: FOOD,
          occurredAt: `2026-${month}-12T04:00:00Z`,
        });
      }
      await add(session, account, {
        type: 'expense',
        amount: '30000',
        categoryId: cup,
        occurredAt: '2026-08-14T04:00:00Z',
      });
      await add(session, account, {
        type: 'expense',
        amount: '100000',
        categoryId: TRANSPORT,
        occurredAt: '2026-09-20T04:00:00Z',
      });
      // This month and older months do not count.
      await add(session, account, {
        type: 'expense',
        amount: '999000',
        categoryId: FOOD,
        occurredAt: '2026-10-03T04:00:00Z',
      });
      await add(session, account, {
        type: 'expense',
        amount: '999000',
        categoryId: FOOD,
        occurredAt: '2026-06-20T04:00:00Z',
      });

      expect(await budget.suggestions(session.userId, NOW)).toEqual({
        months: 3,
        currency: 'UZS',
        income: '5000000',
        // (900 000 + 30 000 + 100 000) / 3 = 343 333 → up to 344 000
        expenses: '344000',
        categories: [
          // «Кофе» counts in «Еда»: 930 000 / 3
          { categoryId: FOOD, amount: '310000' },
          // 100 000 / 3 = 33 333 → 34 000
          { categoryId: TRANSPORT, amount: '34000' },
        ],
      });

      const fresh = await setup();
      expect(await budget.suggestions(fresh.session.userId, NOW)).toEqual({
        months: 0,
        currency: 'UZS',
        income: null,
        expenses: null,
        categories: [],
      });
      await http
        .get('/v1/budget/suggestions')
        .set(fresh.session.auth)
        .expect(200);
    });
  });
});
