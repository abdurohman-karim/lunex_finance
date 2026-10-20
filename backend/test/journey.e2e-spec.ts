import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { systemCategoryId } from '../src/database/reference-data.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { MailSender, type MailMessage } from '../src/mail/mail-sender.js';
import { UsersService } from '../src/users/users.service.js';
import { resetRateLimits } from './support/session.js';

const { Decimal } = Prisma;

class CapturingMailSender extends MailSender {
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
  lastCodeFor(email: string): string {
    const code = this.sent
      .findLast((m) => m.to === email)
      ?.text.match(/\b\d{6}\b/)?.[0];
    if (!code) throw new Error(`No code sent to ${email}`);
    return code;
  }
}

/** The app's ids: generated on the device and sent in capitals (`UUID.uuidString`). */
const appId = () => randomUUID().toUpperCase();

/**
 * The first days of a beta tester, request by request as the iOS app makes them: email
 * sign-in, onboarding, a full sync, an offline queue, the budget, Smart Save and undo.
 * Runs on the real clock, so the figures are checked against the formulas, not fixed numbers.
 */
describe('A new user’s first day, as the app does it (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  const mail = new CapturingMailSender();
  const userIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailSender)
      .useValue(mail)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    http = request(app.getHttpServer());
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

  it('signs up by email, sets up, records money and saves into a goal', async () => {
    // Sign-in by a one-time code
    const email = `beta-${randomUUID()}@lunex.test`;
    const device = {
      id: appId(),
      model: 'iPhone18,1',
      osVersion: '27.0',
      appVersion: '0.1.0',
    };
    await http
      .post('/v1/auth/email/start')
      .send({ email, language: 'ru' })
      .expect(202);
    const signedIn = await http
      .post('/v1/auth/email/verify')
      .send({ email, code: mail.lastCodeFor(email), device, language: 'ru' })
      .expect(200);
    userIds.push(signedIn.body.user.id);
    const auth = { Authorization: `Bearer ${signedIn.body.accessToken}` };
    expect(signedIn.body.user).toMatchObject({ onboardingCompleted: false });
    const access = await http.get('/v1/me/access').set(auth).expect(200);
    expect(access.body).toMatchObject({ plan: 'pro' });

    // Onboarding: language, currency, focus, income, first goal; «Наличные» comes with it
    const cash = appId();
    const goal = appId();
    const onboarded = await http
      .post('/v1/me/onboarding')
      .set(auth)
      .send({
        language: 'ru',
        baseCurrency: 'UZS',
        timezone: 'Asia/Tashkent',
        focus: 'save',
        monthlyIncomeEstimate: '3000000',
        cashAccountId: cash,
        firstGoal: {
          id: goal,
          title: 'Телефон',
          templateKey: 'phone',
          targetAmount: '9000000',
        },
      })
      .expect(200);
    expect(onboarded.body).toMatchObject({
      profile: { onboardingCompleted: true },
      account: { id: cash.toLowerCase(), name: 'Наличные', isDefault: true },
      goal: { id: goal.toLowerCase(), isPrimary: true },
    });

    // The first full sync fills the local database
    const full = await http.get('/v1/sync/changes').set(auth).expect(200);
    expect(full.body.hasMore).toBe(false);
    expect(full.body.accounts).toEqual([
      expect.objectContaining({ id: cash.toLowerCase() }),
    ]);
    expect(full.body.goals).toEqual([
      expect.objectContaining({ id: goal.toLowerCase() }),
    ]);
    expect(
      full.body.categories.filter((c: { isSystem: boolean }) => c.isSystem),
    ).toHaveLength(19);

    // Before any income the month runs on the onboarding estimate
    const estimate = await http.get('/v1/budget/current').set(auth).expect(200);
    const daysLeft: number = estimate.body.period.daysLeft;
    expect(estimate.body).toMatchObject({
      state: 'ok',
      income: { basis: '3000000' },
      dailyLimit: new Decimal(3_000_000).div(daysLeft).floor().toFixed(),
    });

    // An offline queue: today's salary and a coffee, sent when the network is back
    const salary = appId();
    const coffee = appId();
    const now = new Date().toISOString();
    const queue = [
      {
        opId: appId(),
        type: 'transaction.create',
        data: {
          id: salary,
          type: 'income',
          accountId: cash,
          amount: '3900000',
          categoryId: systemCategoryId('income', 'salary'),
          occurredAt: now,
          source: 'quick_add',
        },
      },
      {
        opId: appId(),
        type: 'transaction.create',
        data: {
          id: coffee,
          type: 'expense',
          accountId: cash,
          amount: '50000',
          categoryId: systemCategoryId('expense', 'cafe'),
          note: 'Кофе',
          occurredAt: now,
          source: 'quick_add',
        },
      },
    ];
    const pushed = await http
      .post('/v1/sync/push')
      .set(auth)
      .send({ operations: queue })
      .expect(200);
    expect(
      pushed.body.results.map((r: { status: string }) => r.status),
    ).toEqual(['applied', 'applied']);
    // A lost response makes the app send the same queue again: nothing is counted twice.
    await http
      .post('/v1/sync/push')
      .set(auth)
      .send({ operations: queue })
      .expect(200);

    const afterQueue = await http
      .get('/v1/sync/changes')
      .query({ cursor: full.body.nextCursor })
      .set(auth)
      .expect(200);
    expect(afterQueue.body.accounts).toEqual([
      expect.objectContaining({ currentBalance: '3850000' }),
    ]);
    expect(afterQueue.body.transactions).toHaveLength(2);

    // The budget now runs on the real income
    const dailyLimit = new Decimal(3_900_000).div(daysLeft).floor();
    const budget = await http.get('/v1/budget/current').set(auth).expect(200);
    expect(budget.body).toMatchObject({
      income: { actual: '3900000', basis: '3900000' },
      expenses: { today: '50000' },
      dailyLimit: dailyLimit.toFixed(),
      safeToSpendToday: dailyLimit.minus(50_000).toFixed(),
    });

    // Smart Save: half of the free money per day, rounded down to 1000 sum
    const offer = await http.get('/v1/smart-save/today').set(auth).expect(200);
    const amount = new Decimal(3_850_000)
      .div(daysLeft)
      .times(0.5)
      .div(1000)
      .floor()
      .times(1000);
    expect(offer.body).toMatchObject({
      status: 'available',
      suggestion: {
        goal: { id: goal.toLowerCase() },
        amount: amount.toFixed(),
      },
    });
    const accepted = await http
      .post(`/v1/smart-save/${offer.body.suggestion.id}/accept`)
      .set(auth)
      .send({})
      .expect(200);
    expect(accepted.body).toMatchObject({
      contribution: { method: 'smart_save', amount: amount.toFixed() },
    });
    const done = await http.get('/v1/smart-save/today').set(auth).expect(200);
    expect(done.body.status).toBe('already_saved');

    // The saving reaches the device and is reserved in the budget
    const afterSaving = await http
      .get('/v1/sync/changes')
      .query({ cursor: afterQueue.body.nextCursor })
      .set(auth)
      .expect(200);
    expect(afterSaving.body.goals).toEqual([
      expect.objectContaining({ savedAmount: amount.toFixed() }),
    ]);
    expect(afterSaving.body.goalContributions).toEqual([
      expect.objectContaining({ method: 'smart_save' }),
    ]);
    expect(afterSaving.body.accounts).toEqual([
      expect.objectContaining({
        currentBalance: new Decimal(3_850_000).minus(amount).toFixed(),
      }),
    ]);
    const saved = await http.get('/v1/budget/current').set(auth).expect(200);
    const limitAfterSaving = new Decimal(3_900_000)
      .minus(amount)
      .div(daysLeft)
      .floor();
    expect(saved.body).toMatchObject({
      savedToGoals: amount.toFixed(),
      dailyLimit: limitAfterSaving.toFixed(),
    });

    // A swipe deletes the coffee, «Отменить» brings it back
    const remove = {
      opId: appId(),
      type: 'transaction.delete',
      id: coffee,
    };
    await http
      .post('/v1/sync/push')
      .set(auth)
      .send({ operations: [remove] })
      .expect(200);
    const deleted = await http.get('/v1/budget/current').set(auth).expect(200);
    expect(deleted.body.safeToSpendToday).toBe(limitAfterSaving.toFixed());
    await http
      .post('/v1/sync/push')
      .set(auth)
      .send({
        operations: [
          { opId: appId(), type: 'transaction.restore', id: coffee },
        ],
      })
      .expect(200);
    const restored = await http.get('/v1/budget/current').set(auth).expect(200);
    expect(restored.body.safeToSpendToday).toBe(
      limitAfterSaving.minus(50_000).toFixed(),
    );

    // The checklist: an operation and a goal are done
    const checklist = await http.get('/v1/me/checklist').set(auth).expect(200);
    expect(checklist.body).toMatchObject({
      firstTransaction: true,
      firstGoal: true,
    });
  });
});
