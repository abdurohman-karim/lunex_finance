import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { systemCategoryId } from '../src/database/reference-data.js';
import { NotificationPlanner } from '../src/notifications/notification-planner.service.js';
import {
  type NotifyInput,
  NotificationsService,
} from '../src/notifications/notifications.service.js';
import {
  type PushMessage,
  type PushResult,
  PushSender,
} from '../src/notifications/push-sender.js';
import { SmartSaveService } from '../src/smart-save/smart-save.service.js';
import { UsersService } from '../src/users/users.service.js';
import {
  resetRateLimits,
  signUp,
  type TestSession,
} from './support/session.js';

const FOOD = systemCategoryId('expense', 'food');
const TRANSPORT = systemCategoryId('expense', 'transport');

/**
 * Pushes are tested in March 2030: rows due then are not touched by the queue or the 5-minute
 * sweep, which run on the real clock, so each test delivers them itself.
 * A wall-clock time in Tashkent (UTC+5) on Monday 4 March 2030, or another day.
 */
const at = (time: string, day = '2030-03-04') =>
  new Date(`${day}T${time}:00+05:00`);

/** Tokens the stand-in APNs answers by: dead… is gone, b0b0… is busy, others work. */
const token = (prefix = '') =>
  (prefix + randomUUID().replace(/-/g, '')).padEnd(64, '0');

class FakeSender extends PushSender {
  readonly sent: PushMessage[] = [];

  async send(message: PushMessage): Promise<PushResult> {
    if (message.token.startsWith('dead')) {
      return { status: 'invalid_token', reason: 'Unregistered' };
    }
    if (message.token.startsWith('b0b0')) {
      return { status: 'retry', reason: 'TooManyRequests' };
    }
    this.sent.push(message);
    return { status: 'ok' };
  }

  to(apnsToken: string) {
    return this.sent.filter((message) => message.token === apnsToken);
  }
}

/** Waits for what a request leaves to the background. */
async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const value = await read();
    if (done(value) || attempt === 40) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('Notifications (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  let notifications: NotificationsService;
  let planner: NotificationPlanner;
  const sender = new FakeSender();
  const userIds: string[] = [];

  async function user(language: 'uz' | 'ru' | 'en' = 'ru') {
    const session = await signUp(http, language);
    userIds.push(session.userId);
    return session;
  }

  /** The signed-in device gets a push token. */
  async function device(session: TestSession, apnsToken = token()) {
    await http
      .put('/v1/me/devices/current')
      .set(session.auth)
      .send({ apnsToken, pushEnabled: true })
      .expect(200);
    return apnsToken;
  }

  async function account(session: TestSession) {
    const id = randomUUID();
    await http
      .post('/v1/accounts')
      .set(session.auth)
      .send({ id, name: 'Card', currency: 'UZS', initialBalance: '5000000' })
      .expect(201);
    return id;
  }

  /** A budget alert due at `when`, for delivery tests. */
  async function pending(
    session: TestSession,
    when: Date,
    overrides: Partial<NotifyInput> = {},
  ) {
    const id = await notifications.notify({
      userId: session.userId,
      type: 'budget_threshold',
      dedupeKey: `test:${randomUUID()}`,
      text: { title: 'Еда: 85 % лимита', body: 'Потрачено…' },
      data: { link: 'lunex://budget' },
      scheduledAt: when,
      expiresAt: at('23:59', '2030-03-31'),
      ...overrides,
    });
    return id!;
  }

  const row = (id: string) =>
    prisma.notifications.findUniqueOrThrow({ where: { id } });

  const rowsOf = (session: TestSession, type?: string) =>
    prisma.notifications.findMany({
      where: {
        user_id: session.userId,
        ...(type ? { type: type as never } : {}),
      },
      orderBy: { created_at: 'asc' },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PushSender)
      .useValue(sender)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    http = request(app.getHttpServer());
    prisma = app.get(PrismaService);
    notifications = app.get(NotificationsService);
    planner = app.get(NotificationPlanner);
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

  it('sends to every device of the user, with the link and the time it is worth', async () => {
    const session = await user();
    const first = await device(session);
    const second = token();
    await prisma.devices.create({
      data: { user_id: session.userId, apns_token: second, push_enabled: true },
    });
    const id = await pending(session, at('12:00'));

    expect(await notifications.deliver(id, at('12:00'))).toBe('sent');
    expect(sender.to(first)).toHaveLength(1);
    expect(sender.to(second)).toHaveLength(1);
    expect(sender.to(first)[0]).toMatchObject({
      expiresAt: at('23:59', '2030-03-31'),
      payload: {
        aps: {
          alert: { title: 'Еда: 85 % лимита', body: 'Потрачено…' },
          sound: 'default',
          'thread-id': 'budget_threshold',
        },
        lunex: { id, type: 'budget_threshold', link: 'lunex://budget' },
      },
    });
    expect(await row(id)).toMatchObject({
      status: 'sent',
      sent_at: at('12:00'),
    });
    // Sent once: a second worker finds nothing to claim.
    expect(await notifications.deliver(id, at('12:01'))).toBe('busy');
  });

  it('waits out quiet hours and sends at most three a day, besides reminders', async () => {
    const session = await user();
    const phone = await device(session);

    const night = await pending(session, at('23:10'));
    expect(await notifications.deliver(night, at('23:10'))).toBe('deferred');
    expect(await row(night)).toMatchObject({
      status: 'pending',
      sent_at: null,
      scheduled_at: at('08:00', '2030-03-05'),
    });
    // Not before the end of the quiet hours.
    expect(await notifications.deliver(night, at('07:00', '2030-03-05'))).toBe(
      'busy',
    );
    expect(await notifications.deliver(night, at('08:00', '2030-03-05'))).toBe(
      'sent',
    );

    const noon = at('12:00', '2030-03-05');
    const second = await pending(session, noon);
    const third = await pending(session, noon);
    const fourth = await pending(session, noon);
    expect(await notifications.deliver(second, noon)).toBe('sent');
    expect(await notifications.deliver(third, noon)).toBe('sent');
    expect(await notifications.deliver(fourth, noon)).toBe(
      'skipped:daily_limit',
    );

    // The evening reminder the user set up comes anyway, even in quiet hours.
    const reminder = await pending(session, at('22:30', '2030-03-05'), {
      type: 'daily_reminder',
      data: { link: 'lunex://add', date: '2030-03-05' },
    });
    expect(
      await notifications.deliver(reminder, at('22:30', '2030-03-05')),
    ).toBe('sent');
    expect(sender.to(phone)).toHaveLength(4);

    // The center shows what went out and what the limit kept back, newest first.
    const center = await http
      .get('/v1/notifications')
      .set(session.auth)
      .expect(200);
    expect(center.body.unread).toBe(5);
    expect(center.body.items.map((n: { id: string }) => n.id).sort()).toEqual(
      [night, second, third, fourth, reminder].sort(),
    );
    expect(center.body.items[0]).toMatchObject({
      type: expect.any(String),
      title: expect.any(String),
      link: expect.stringMatching(/^lunex:\/\//),
      openedAt: null,
    });
    await http
      .post(`/v1/notifications/${second}/opened`)
      .set(session.auth)
      .expect(204);
    await http
      .get('/v1/notifications')
      .set(session.auth)
      .expect(200)
      .then((res) => expect(res.body.unread).toBe(4));
    await http.post('/v1/notifications/opened').set(session.auth).expect(204);
    await http
      .get('/v1/notifications')
      .query({ limit: 2 })
      .set(session.auth)
      .expect(200)
      .then((res) => {
        expect(res.body.unread).toBe(0);
        expect(res.body.items).toHaveLength(2);
        expect(res.body.nextBefore).toEqual(expect.any(String));
      });
  });

  it('skips switched-off kinds, stale pushes and users with no device; forgets dead tokens', async () => {
    const session = await user();
    await device(session);
    await http
      .patch('/v1/me/settings')
      .set(session.auth)
      .send({ budgetAlertsEnabled: false })
      .expect(200);
    const off = await pending(session, at('12:00'));
    expect(await notifications.deliver(off, at('12:00'))).toBe(
      'skipped:disabled',
    );

    const stale = await pending(session, at('12:00'), {
      type: 'goal_deadline',
      expiresAt: at('11:00'),
    });
    expect(await notifications.deliver(stale, at('12:00'))).toBe(
      'skipped:expired',
    );

    const quiet = await user();
    const kept = await pending(quiet, at('12:00'));
    expect(await notifications.deliver(kept, at('12:00'))).toBe(
      'skipped:no_device',
    );

    const gone = await user();
    await device(gone, token('dead'));
    const lost = await pending(gone, at('12:00'));
    expect(await notifications.deliver(lost, at('12:00'))).toBe(
      'skipped:no_device',
    );
    const devices = await prisma.devices.findMany({
      where: { user_id: gone.userId },
    });
    expect(devices.every((d) => d.apns_token === null && !d.push_enabled)).toBe(
      true,
    );

    const busy = await user();
    await device(busy, token('b0b0'));
    const later = await pending(busy, at('12:00'));
    expect(await notifications.deliver(later, at('12:00'))).toBe('retry');
    expect(await row(later)).toMatchObject({
      status: 'pending',
      scheduled_at: at('12:05'),
    });
  });

  it('stops pushes to a device once its session ends', async () => {
    const pushToken = async (session: TestSession) =>
      (
        await prisma.devices.findFirstOrThrow({
          where: { user_id: session.userId },
        })
      ).apns_token;

    const one = await user();
    await device(one);
    await http
      .post('/v1/auth/logout')
      .send({ refreshToken: one.refreshToken })
      .expect(204);
    expect(await pushToken(one)).toBeNull();

    const all = await user();
    await device(all);
    await http.delete('/v1/me/sessions').set(all.auth).expect(204);
    expect(await pushToken(all)).toBeNull();
  });

  it('celebrates each goal milestone once, the highest one reached', async () => {
    const session = await user();
    const card = await account(session);
    const goal = await http
      .post('/v1/goals')
      .set(session.auth)
      .send({
        id: randomUUID(),
        title: 'Телефон',
        templateKey: 'phone',
        targetAmount: '1000000',
      })
      .expect(201);
    const deposit = (amount: string) =>
      http
        .post(`/v1/goals/${goal.body.id}/contributions`)
        .set(session.auth)
        .send({ id: randomUUID(), type: 'deposit', amount, accountId: card })
        .expect(201);

    await deposit('550000');
    const half = await eventually(
      () => rowsOf(session, 'goal_milestone'),
      (rows) => rows.length > 0,
    );
    expect(half).toHaveLength(1);
    expect(half[0]).toMatchObject({
      dedupe_key: `goal_milestone:${goal.body.id}:50`,
      title: '📱 «Телефон»: 50 %',
      body: 'Накоплено 550 000 сум из 1 000 000 сум. Так держать!',
      payload: {
        link: `lunex://goals/${goal.body.id}`,
        goalId: goal.body.id,
        percent: 50,
      },
    });

    await deposit('450000');
    const all = await eventually(
      () => rowsOf(session, 'goal_milestone'),
      (rows) => rows.length > 1,
    );
    expect(all.map((n) => n.title)).toEqual([
      '📱 «Телефон»: 50 %',
      'Цель «Телефон» достигнута 📱',
    ]);
  });

  it('alerts at the threshold and over a limit, once a month each', async () => {
    const session = await user();
    const card = await account(session);
    await http
      .put('/v1/budget/current')
      .set(session.auth)
      .send({
        totalLimit: '1000000',
        categoryLimits: [{ categoryId: FOOD, limit: '100000' }],
      })
      .expect(200);
    const spend = (amount: string, categoryId = FOOD) =>
      http
        .post('/v1/transactions')
        .set(session.auth)
        .send({
          id: randomUUID(),
          type: 'expense',
          accountId: card,
          amount,
          categoryId,
          occurredAt: new Date().toISOString(),
        })
        .expect(201);
    const alerts = async () =>
      (await rowsOf(session)).filter((n) => n.type.startsWith('budget'));

    await spend('85000');
    await planner.checkBudget(session.userId);
    await planner.checkBudget(session.userId);
    let rows = await alerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'budget_threshold',
      title: 'Еда: 85 % лимита',
      body: 'Потрачено 85 000 сум из 100 000 сум в этом месяце.',
      payload: { link: 'lunex://budget', categoryId: FOOD },
    });
    expect(rows[0].dedupe_key).toMatch(
      new RegExp(
        `^budget_threshold:${session.userId}:\\d{4}-\\d{2}-\\d{2}:${FOOD}:80$`,
      ),
    );

    await spend('20000');
    await spend('700000', TRANSPORT);
    await planner.checkBudget(session.userId);
    rows = await alerts();
    expect(rows.map((n) => n.title).sort()).toEqual(
      ['Еда: 85 % лимита', 'Еда: лимит превышен', 'Бюджет месяца: 80 %'].sort(),
    );

    // The expenses themselves asked for the check: it ran in the background, adding nothing new.
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    await eventually(alerts, (all) => all.length === 3);
    expect(await alerts()).toHaveLength(3);
  });

  it('reminds in the evening only when the day has no operations', async () => {
    const empty = await user();
    const busy = await user();
    const card = await account(busy);
    for (const session of [empty, busy]) {
      await prisma.users.update({
        where: { id: session.userId },
        data: { onboarding_completed_at: new Date() },
      });
    }
    const uzs = await prisma.currencies.findUniqueOrThrow({
      where: { code: 'UZS' },
    });
    // An operation of the evening's day, made by hand in the future.
    await prisma.transactions.create({
      data: {
        id: randomUUID(),
        user_id: busy.userId,
        account_id: card,
        type: 'expense',
        amount: '1000',
        amount_base: '1000',
        currency_id: uzs.id,
        occurred_at: at('13:00'),
      },
    });
    const only = [empty.userId, busy.userId];

    // 21:00 is the default time; within the hour after it, once.
    expect(await planner.planDailyReminders(at('20:55'), only)).toBe(0);
    expect(await planner.planDailyReminders(at('21:05'), only)).toBe(1);
    expect(await planner.planDailyReminders(at('21:10'), only)).toBe(0);
    const [reminder] = await rowsOf(empty, 'daily_reminder');
    expect(reminder).toMatchObject({
      dedupe_key: `daily_reminder:${empty.userId}:2030-03-04`,
      title: 'Запишите траты дня',
      payload: { link: 'lunex://add', date: '2030-03-04' },
      expires_at: at('00:00', '2030-03-05'),
    });

    // An operation recorded before it goes out: the reminder is not needed any more.
    await device(empty);
    await prisma.transactions.create({
      data: {
        id: randomUUID(),
        user_id: empty.userId,
        account_id: await account(empty),
        type: 'income',
        amount: '1000',
        amount_base: '1000',
        currency_id: uzs.id,
        occurred_at: at('21:06'),
      },
    });
    expect(await notifications.deliver(reminder.id, at('21:07'))).toBe(
      'skipped:not_needed',
    );
  });

  it('reminds of payments ahead with «Записать», and of goal deadlines', async () => {
    const session = await user();
    const card = await account(session);
    const rule = await http
      .post('/v1/recurring')
      .set(session.auth)
      .send({
        id: randomUUID(),
        title: 'Аренда',
        type: 'expense',
        amount: '3000000',
        accountId: card,
        frequency: 'monthly',
        startOn: '2026-01-06',
        remindDaysBefore: 2,
      })
      .expect(201);
    await prisma.recurringRules.update({
      where: { id: rule.body.id },
      data: { next_run_on: new Date('2030-03-06') },
    });
    const goal = await http
      .post('/v1/goals')
      .set(session.auth)
      .send({
        id: randomUUID(),
        title: 'Отпуск',
        templateKey: 'travel',
        targetAmount: '8000000',
        deadline: '2030-03-11',
      })
      .expect(201);
    const only = [session.userId];

    // Before 09:00 nothing yet; then once.
    expect(await planner.planRecurringReminders(at('08:30'), only)).toBe(0);
    expect(await planner.planRecurringReminders(at('09:00'), only)).toBe(1);
    expect(await planner.planRecurringReminders(at('15:00'), only)).toBe(0);
    expect(await planner.planGoalDeadlines(at('09:00'), only)).toBe(1);
    expect(
      await planner.planGoalDeadlines(at('09:00', '2030-03-05'), only),
    ).toBe(0);

    const [due] = await rowsOf(session, 'recurring_due');
    expect(due).toMatchObject({
      dedupe_key: `recurring_due:${rule.body.id}:2030-03-06`,
      title: 'Аренда — 3 000 000 сум',
      body: 'Списание 6 марта. Нажмите «Записать», когда оплатите.',
      payload: {
        link: 'lunex://recurring',
        ruleId: rule.body.id,
        date: '2030-03-06',
      },
      expires_at: at('00:00', '2030-03-07'),
    });
    const [deadline] = await rowsOf(session, 'goal_deadline');
    expect(deadline).toMatchObject({
      title: '✈️ «Отпуск»: неделя до срока',
      body: 'Осталось накопить 8 000 000 сум до 11 марта.',
      payload: { link: `lunex://goals/${goal.body.id}`, goalId: goal.body.id },
    });

    // The push carries the category the app shows «Записать» for.
    const phone = await device(session);
    expect(await notifications.deliver(due.id, at('09:00'))).toBe('sent');
    expect(sender.to(phone)[0].payload).toMatchObject({
      aps: { category: 'RECURRING_DUE' },
      lunex: { ruleId: rule.body.id, date: '2030-03-06' },
    });
  });

  it('pushes the morning Smart Save with its suggestion', async () => {
    const smartSave = app.get(SmartSaveService);
    const session = await user();
    const cash = await account(session);
    await http
      .post('/v1/transactions')
      .set(session.auth)
      .send({
        id: randomUUID(),
        type: 'income',
        accountId: cash,
        amount: '3900000',
        occurredAt: '2026-10-01T05:00:00Z',
      })
      .expect(201);
    await http
      .post('/v1/goals')
      .set(session.auth)
      .send({
        id: randomUUID(),
        title: 'Телефон',
        templateKey: 'phone',
        targetAmount: '10000000',
      })
      .expect(201);
    // 09:00 UTC on 19 October 2026 is 08:00 in a UTC−1 zone.
    await prisma.users.update({
      where: { id: session.userId },
      data: { timezone: 'Etc/GMT+1' },
    });
    await smartSave.prepareMorningSuggestions(new Date('2026-10-19T09:00:00Z'));

    const [push] = await rowsOf(session, 'smart_save');
    const suggestion = await prisma.smartSaveSuggestions.findFirstOrThrow({
      where: { user_id: session.userId },
    });
    expect(push).toMatchObject({
      dedupe_key: `smart_save:${session.userId}:2026-10-19`,
      payload: {
        link: 'lunex://smart-save',
        suggestionId: suggestion.id,
        amount: suggestion.amount.toString(),
        currency: 'UZS',
      },
      expires_at: suggestion.expires_at,
    });
    expect(push.title).toMatch(/^Отложить [\d ]+ сум\?$/);
    expect(push.body).toBe(
      'Это безопасная сумма на сегодня для цели «Телефон» 📱.',
    );
  });
});
