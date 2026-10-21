import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { ClaudeClient, type ClaudeReply } from '../src/ai/claude.client.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { AppSettingsService } from '../src/common/app-settings.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { systemCategoryId } from '../src/database/reference-data.js';
import { InsightsService } from '../src/insights/insights.service.js';
import { UsersService } from '../src/users/users.service.js';
import {
  resetRateLimits,
  signUp,
  type TestSession,
} from './support/session.js';

const FOOD = systemCategoryId('expense', 'food');
const TRANSPORT = systemCategoryId('expense', 'transport');
const GIFTS = systemCategoryId('expense', 'gifts');
const SALARY = systemCategoryId('income', 'salary');

/** Amounts come with no-break spaces, as the app shows them. */
const plain = (text: string | null | undefined) =>
  (text ?? '').replace(/[\u00A0\u202F]/g, ' ');

/** Sunday 18 October 2026, 19:20 in Tashkent. */
const SUNDAY_EVENING = new Date('2026-10-18T14:20:00Z');
/** Tuesday 20 October 2026, 12:20 in Tashkent: day 20 of 31. */
const TUESDAY_NOON = new Date('2026-10-20T07:20:00Z');

/** Claude off, or answering with the JSON the writer asks for. */
class FakeClaude {
  available = false;
  replies: string[] = [];

  async complete(): Promise<ClaudeReply> {
    return {
      text: this.replies.shift() ?? '{}',
      model: 'claude-test',
      usage: { inputTokens: 300, outputTokens: 60 },
    };
  }
}

describe('Insights (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  let insights: InsightsService;
  const claude = new FakeClaude();
  let originalMonetization: unknown;
  const userIds: string[] = [];

  async function setup() {
    const session = await signUp(http, 'ru', { ai: true });
    userIds.push(session.userId);
    await prisma.users.update({
      where: { id: session.userId },
      data: { onboarding_completed_at: new Date('2026-09-01') },
    });
    const account = randomUUID();
    await http
      .post('/v1/accounts')
      .set(session.auth)
      .send({ id: account, name: 'Cash', currency: 'UZS', initialBalance: '0' })
      .expect(201);
    return { session, account };
  }

  async function add(
    session: TestSession,
    account: string,
    type: 'income' | 'expense',
    amount: string,
    categoryId: string | null,
    occurredAt: string,
  ) {
    const res = await http
      .post('/v1/transactions')
      .set(session.auth)
      .send({
        id: randomUUID(),
        accountId: account,
        type,
        amount,
        categoryId,
        occurredAt,
      })
      .expect(201);
    return res.body.id as string;
  }

  const pushes = (s: TestSession) =>
    prisma.notifications.findMany({
      where: { user_id: s.userId, type: { in: ['weekly_report', 'insight'] } },
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
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ClaudeClient)
      .useValue(claude)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    http = request(app.getHttpServer());
    prisma = app.get(PrismaService);
    insights = app.get(InsightsService);
    await resetRateLimits(app);
    originalMonetization = (
      await prisma.appSettings.findUniqueOrThrow({
        where: { key: 'monetization_enabled' },
      })
    ).value;
  });

  afterEach(async () => {
    claude.available = false;
    claude.replies = [];
    await setMonetization(originalMonetization as boolean);
  });

  afterAll(async () => {
    try {
      const users = app.get(UsersService);
      for (const id of userIds) await users.purgeUser(id);
    } finally {
      await app.close();
    }
  });

  it('gives a tip a day, by template without the AI and in its words with it', async () => {
    const { session, account } = await setup();
    const first = await http
      .get('/v1/insights/tip')
      .set(session.auth)
      .expect(200);
    expect(first.body).toMatchObject({
      kind: 'daily_tip',
      language: 'ru',
      source: 'template',
      title: 'Добавьте доход месяца',
      payload: { situation: 'no_income' },
    });
    const again = await http
      .get('/v1/insights/tip')
      .set(session.auth)
      .expect(200);
    expect(again.body.id).toBe(first.body.id);

    // Another user, with income and the AI on.
    const other = await setup();
    await add(
      other.session,
      other.account,
      'income',
      '6000000',
      SALARY,
      new Date().toISOString(),
    );
    claude.available = true;
    claude.replies = [
      'Here you go: {"title":"Хороший старт","summary":"Лимит на день есть.","recommendation":"Отложите 10 %."}',
    ];
    const tip = await http
      .get('/v1/insights/tip')
      .set(other.session.auth)
      .expect(200);
    expect(tip.body).toMatchObject({
      source: 'ai',
      title: 'Хороший старт',
      recommendation: 'Отложите 10 %.',
    });
    const usage = await prisma.aiUsageDaily.findMany({
      where: { user_id: other.session.userId },
    });
    expect(usage).toEqual([
      expect.objectContaining({
        feature: 'insight',
        requests: 1,
        input_tokens: 300,
      }),
    ]);

    // An answer that is not the JSON asked for falls back to the template.
    claude.replies = ['Sorry, I cannot.'];
    const report = await insights.dailyTip(
      session.userId,
      new Date('2026-10-21T06:00:00Z'),
    );
    expect(report.source).toBe('template');
    void account;
  });

  it('reports the week on Sunday evening, against the week before, for Pro', async () => {
    const { session, account } = await setup();
    await add(
      session,
      account,
      'income',
      '5000000',
      SALARY,
      '2026-10-12T05:00:00Z',
    );
    await add(
      session,
      account,
      'expense',
      '300000',
      FOOD,
      '2026-10-12T07:00:00Z',
    );
    await add(
      session,
      account,
      'expense',
      '150000',
      FOOD,
      '2026-10-14T07:00:00Z',
    );
    await add(
      session,
      account,
      'expense',
      '90000',
      TRANSPORT,
      '2026-10-14T08:00:00Z',
    );
    await add(
      session,
      account,
      'expense',
      '200000',
      FOOD,
      '2026-10-06T07:00:00Z',
    );
    await add(
      session,
      account,
      'expense',
      '150000',
      TRANSPORT,
      '2026-10-07T07:00:00Z',
    );

    // Only the hour of the week's report does anything; not for Free.
    await setMonetization(true);
    await prisma.subscriptions.updateMany({
      where: { user_id: session.userId },
      data: { expires_at: new Date('2026-01-01') },
    });
    expect(await insights.runHourly(SUNDAY_EVENING, [session.userId])).toEqual({
      weekly: 0,
      monthly: 0,
      forecasts: 0,
    });
    await setMonetization(false);
    expect(
      await insights.runHourly(new Date('2026-10-18T13:20:00Z'), [
        session.userId,
      ]),
    ).toMatchObject({ weekly: 0 });
    expect(
      await insights.runHourly(SUNDAY_EVENING, [session.userId]),
    ).toMatchObject({ weekly: 1 });

    const page = await http.get('/v1/insights').set(session.auth).expect(200);
    expect(page.body.unread).toBe(1);
    const report = page.body.items[0];
    expect(report).toMatchObject({
      kind: 'weekly_report',
      periodStart: '2026-10-12',
      periodEnd: '2026-10-18',
      source: 'template',
      payload: {
        currency: 'UZS',
        income: '5000000',
        expense: '540000',
        previousExpense: '350000',
        changePercent: 54,
        categories: [
          {
            categoryId: FOOD,
            name: 'Еда',
            amount: '450000',
            previous: '200000',
            changePercent: 125,
          },
          {
            categoryId: TRANSPORT,
            name: 'Транспорт',
            amount: '90000',
            previous: '150000',
            changePercent: -40,
          },
        ],
      },
    });
    expect(plain(report.title)).toBe(
      'Неделя 12 октября – 18 октября: 540 000 сум',
    );
    expect(report.payload.days).toHaveLength(7);
    expect(report.summary).toContain('Больше всего ушло на «Еда»');
    expect((await pushes(session)).map((p) => [p.type, p.title])).toEqual([
      ['weekly_report', report.title],
    ]);

    // Made once.
    expect(
      await insights.runHourly(SUNDAY_EVENING, [session.userId]),
    ).toMatchObject({ weekly: 0 });
  });

  it('reports the budget month that ended on payday', async () => {
    const { session, account } = await setup();
    await add(
      session,
      account,
      'expense',
      '800000',
      FOOD,
      '2026-09-10T07:00:00Z',
    );
    await add(
      session,
      account,
      'expense',
      '400000',
      GIFTS,
      '2026-08-10T07:00:00Z',
    );
    // 1 October, 10:20 in Tashkent.
    const res = await insights.runHourly(new Date('2026-10-01T05:20:00Z'), [
      session.userId,
    ]);
    expect(res.monthly).toBe(1);
    const [report] = (
      await http.get('/v1/insights').set(session.auth).expect(200)
    ).body.items;
    expect(report).toMatchObject({
      kind: 'monthly_report',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      payload: {
        expense: '800000',
        previousExpense: '400000',
        changePercent: 100,
      },
    });
    expect(report.title).toMatch(/^Месяц сентябрь 2026/);
  });

  it('notes an expense over three medians of its category, once, and drops it with the expense', async () => {
    const { session, account } = await setup();
    for (const [amount, date] of [
      ['40000', '2026-09-01'],
      ['50000', '2026-09-15'],
      ['60000', '2026-10-01'],
    ]) {
      await add(
        session,
        account,
        'expense',
        amount,
        TRANSPORT,
        `${date}T07:00:00Z`,
      );
    }
    const usual = await add(
      session,
      account,
      'expense',
      '150000',
      TRANSPORT,
      '2026-10-10T07:00:00Z',
    );
    expect(await insights.checkAnomaly(session.userId, usual)).toBeNull();
    const big = await add(
      session,
      account,
      'expense',
      '400000',
      TRANSPORT,
      '2026-10-11T07:00:00Z',
    );
    const found = await insights.checkAnomaly(session.userId, big);
    expect(found).toMatchObject({
      kind: 'anomaly',
      transactionId: big,
      payload: {
        amount: '400000',
        median: '55000',
        ratio: 7.3,
        categoryName: 'Транспорт',
      },
    });
    expect(plain(found?.title)).toBe('Необычная трата: 400 000 сум');
    expect(await insights.checkAnomaly(session.userId, big)).toBeNull();
    expect((await pushes(session)).map((p) => p.type)).toEqual(['insight']);

    await http.delete(`/v1/transactions/${big}`).set(session.auth).expect(204);
    const feed = await http.get('/v1/insights').set(session.auth).expect(200);
    expect(feed.body.items.map((i: { kind: string }) => i.kind)).not.toContain(
      'anomaly',
    );
  });

  it('warns at midday when the month heads over its plan, once per verdict', async () => {
    const { session, account } = await setup();
    await add(
      session,
      account,
      'income',
      '3000000',
      SALARY,
      '2026-10-02T07:00:00Z',
    );
    await add(
      session,
      account,
      'expense',
      '1800000',
      FOOD,
      '2026-10-05T07:00:00Z',
    );
    // 1 800 000 in 20 days of 31: about 2 790 000 by the end, within 3 000 000.
    const within = await insights.budgetForecast(session.userId, TUESDAY_NOON);
    expect(within).toMatchObject({
      kind: 'budget_forecast',
      title: 'Прогноз: укладываетесь в план',
      payload: { verdict: 'within', forecast: '2790000', plan: '3000000' },
    });
    expect(await pushes(session)).toEqual([]);

    await add(
      session,
      account,
      'expense',
      '700000',
      FOOD,
      '2026-10-15T07:00:00Z',
    );
    const over = await insights.budgetForecast(session.userId, TUESDAY_NOON);
    expect(over).toMatchObject({
      payload: { verdict: 'over', forecast: '3875000', overBy: '875000' },
    });
    // 500 000 left of the plan for the 12 days from today.
    expect(plain(over?.recommendation)).toContain('41 666 сум в день');
    expect((await pushes(session)).map((p) => p.type)).toEqual(['insight']);
    expect(
      await insights.budgetForecast(session.userId, TUESDAY_NOON),
    ).toBeNull();

    // Too early in the month to tell.
    expect(
      await insights.budgetForecast(
        session.userId,
        new Date('2026-10-03T07:20:00Z'),
      ),
    ).toBeNull();
  });

  it('analyses a goal with a score for Pro, the same until its figures change', async () => {
    const { session, account } = await setup();
    await add(
      session,
      account,
      'income',
      '9000000',
      SALARY,
      new Date().toISOString(),
    );
    const goal = await http
      .post('/v1/goals')
      .set(session.auth)
      .send({
        id: randomUUID(),
        title: 'Машина',
        templateKey: 'car',
        targetAmount: '12000000',
        deadline: '2027-10-20',
      })
      .expect(201);
    const analysis = await http
      .post(`/v1/insights/goals/${goal.body.id}`)
      .set(session.auth)
      .expect(200);
    expect(analysis.body).toMatchObject({
      kind: 'goal_analysis',
      goalId: goal.body.id,
      payload: { currency: 'UZS', progress: 0, status: 'on_track' },
    });
    expect(analysis.body.score).toBeGreaterThanOrEqual(0);
    expect(analysis.body.title).toMatch(/^«Машина»: \d+ из 100$/);

    const again = await http
      .post(`/v1/insights/goals/${goal.body.id}`)
      .set(session.auth)
      .expect(200);
    expect(again.body.id).toBe(analysis.body.id);

    await http
      .post(`/v1/goals/${goal.body.id}/contributions`)
      .set(session.auth)
      .send({
        id: randomUUID(),
        type: 'deposit',
        amount: '3000000',
        accountId: account,
      })
      .expect(201);
    const moved = await http
      .post(`/v1/insights/goals/${goal.body.id}`)
      .set(session.auth)
      .expect(200);
    expect(moved.body.id).not.toBe(analysis.body.id);
    // Created today: the steady pace expects nothing yet, so any savings are ahead.
    expect(moved.body).toMatchObject({
      score: 90,
      payload: { progress: 25, status: 'ahead' },
    });

    await setMonetization(true);
    await prisma.subscriptions.updateMany({
      where: { user_id: session.userId },
      data: { expires_at: new Date('2026-01-01') },
    });
    await http
      .post(`/v1/insights/goals/${goal.body.id}`)
      .set(session.auth)
      .expect(403)
      .then((res) => expect(res.body.code).toBe('pro_required'));
  });

  it('marks insights read one by one or all at once, and pages the feed', async () => {
    const { session, account } = await setup();
    await add(
      session,
      account,
      'income',
      '1000000',
      SALARY,
      new Date().toISOString(),
    );
    await insights.dailyTip(session.userId, new Date('2026-10-18T06:00:00Z'));
    await insights.dailyTip(session.userId, new Date('2026-10-19T06:00:00Z'));
    const tip = await insights.dailyTip(
      session.userId,
      new Date('2026-10-20T06:00:00Z'),
    );

    const first = await http
      .get('/v1/insights')
      .query({ limit: 2 })
      .set(session.auth)
      .expect(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.unread).toBe(3);
    const rest = await http
      .get('/v1/insights')
      .query({ before: first.body.nextBefore })
      .set(session.auth)
      .expect(200);
    expect(rest.body.items).toHaveLength(1);
    expect(rest.body.nextBefore).toBeNull();

    await http
      .post(`/v1/insights/${tip.id}/read`)
      .set(session.auth)
      .expect(204);
    expect(
      (await http.get(`/v1/insights/${tip.id}`).set(session.auth).expect(200))
        .body.readAt,
    ).not.toBeNull();
    await http.post('/v1/insights/read').set(session.auth).expect(204);
    expect(
      (await http.get('/v1/insights').set(session.auth).expect(200)).body
        .unread,
    ).toBe(0);
    await http
      .post(`/v1/insights/${randomUUID()}/read`)
      .set(session.auth)
      .expect(404);
  });
});
