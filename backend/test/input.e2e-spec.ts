import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import {
  ClaudeClient,
  type ClaudeReply,
  type ClaudeRequest,
  ClaudeUnavailableError,
} from '../src/ai/claude.client.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { AppSettingsService } from '../src/common/app-settings.service.js';
import { localDate } from '../src/common/dates.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { systemCategoryId } from '../src/database/reference-data.js';
import { UsersService } from '../src/users/users.service.js';
import {
  resetRateLimits,
  signUp,
  type TestSession,
} from './support/session.js';

const CAFE = systemCategoryId('expense', 'cafe');
const TRANSPORT = systemCategoryId('expense', 'transport');
const SALARY = systemCategoryId('income', 'salary');

/** Claude off, or answering with what the test hands it; it keeps the last prompt. */
class FakeClaude {
  available = false;
  reply = '';
  failure: ClaudeUnavailableError | null = null;
  lastRequest: ClaudeRequest | null = null;

  async complete(request: ClaudeRequest): Promise<ClaudeReply> {
    this.lastRequest = request;
    if (this.failure) throw this.failure;
    return {
      text: this.reply,
      model: 'claude-haiku-test',
      usage: { inputTokens: 500, outputTokens: 80 },
    };
  }
}

describe('Voice and text input (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  const claude = new FakeClaude();
  let originalMonetization: unknown;
  const userIds: string[] = [];
  const today = () => localDate(new Date(), 'Asia/Tashkent');

  async function user() {
    const session = await signUp(http, 'ru', { ai: true });
    userIds.push(session.userId);
    return session;
  }

  const parse = (auth: TestSession['auth'], text: string, status = 200) =>
    http.post('/v1/ai/parse').set(auth).send({ text }).expect(status);

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
    await resetRateLimits(app);
    originalMonetization = (
      await prisma.appSettings.findUniqueOrThrow({
        where: { key: 'monetization_enabled' },
      })
    ).value;
  });

  afterEach(async () => {
    claude.available = false;
    claude.failure = null;
    claude.reply = '';
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

  it('reads a phrase by rules without the AI, uncounted', async () => {
    const session = await user();
    const res = await parse(session.auth, 'обед 40 000 и такси 15 000');
    expect(res.body).toMatchObject({
      source: 'rules',
      text: 'обед 40 000 и такси 15 000',
    });
    expect(res.body.operations).toEqual([
      expect.objectContaining({
        type: 'expense',
        amount: '40000',
        note: 'Обед',
        date: today(),
      }),
      expect.objectContaining({
        amount: '15000',
        categoryId: TRANSPORT,
        note: 'Такси',
      }),
    ]);
    expect(
      await prisma.aiUsageDaily.count({ where: { user_id: session.userId } }),
    ).toBe(0);
    await parse(session.auth, '', 400);
  });

  it('asks Claude with the user’s categories and keeps what holds up', async () => {
    const session = await user();
    const own = randomUUID();
    await http
      .post('/v1/categories')
      .set(session.auth)
      .send({
        id: own,
        type: 'expense',
        name: 'Кофейня',
        icon: 'cup.and.saucer',
        color: '#557A95',
      })
      .expect(201);
    claude.available = true;
    claude.reply = JSON.stringify({ operations: [] });
    await parse(session.auth, 'x');
    const prompt = claude.lastRequest!.system;
    const ref = (name: string) =>
      prompt
        .split('\n')
        .find((line) => line.includes(name))!
        .split(' ')[0];
    expect(prompt).toContain(`Today is ${today()}`);
    expect(claude.lastRequest!.tier).toBe('fast');

    claude.reply = `Sure: ${JSON.stringify({
      operations: [
        {
          type: 'expense',
          amount: 25000,
          currency: null,
          category: ref('Кофейня'),
          date: today(),
          note: 'Капучино',
          confidence: 0.9,
        },
        {
          type: 'income',
          amount: '8 000 000',
          category: ref('Зарплата'),
          date: '2026-01-01',
          note: 'Зарплата',
        },
        // A category of the other type and an unknown one are dropped; the amount stays.
        {
          type: 'expense',
          amount: 3,
          currency: 'usd',
          category: ref('Зарплата'),
          date: '2999-01-01',
          note: '',
        },
        { type: 'expense', amount: -5, category: null },
      ],
    })}`;
    const res = await parse(
      session.auth,
      'капучино 25 тысяч, зарплата 8 млн и 3 доллара',
    );
    expect(res.body.source).toBe('ai');
    expect(res.body.operations).toEqual([
      {
        type: 'expense',
        amount: '25000',
        currency: null,
        categoryId: own,
        date: today(),
        note: 'Капучино',
        confidence: 0.9,
      },
      // Too far back: today.
      expect.objectContaining({
        type: 'income',
        amount: '8000000',
        categoryId: SALARY,
        date: today(),
        confidence: 0.8,
      }),
      expect.objectContaining({
        amount: '3',
        currency: 'USD',
        categoryId: null,
        date: today(),
        note: null,
      }),
    ]);
    const usage = await prisma.aiUsageDaily.findMany({
      where: { user_id: session.userId },
    });
    expect(usage).toEqual([
      expect.objectContaining({
        feature: 'parse_input',
        requests: 2,
        input_tokens: 1000,
      }),
    ]);
  });

  it('falls back to the rules when Claude fails or answers nonsense', async () => {
    const session = await user();
    claude.available = true;
    claude.failure = new ClaudeUnavailableError('failed', 'down');
    const failed = await parse(session.auth, 'кофе 25 тысяч');
    expect(failed.body).toMatchObject({
      source: 'rules',
      operations: [
        expect.objectContaining({ amount: '25000', categoryId: CAFE }),
      ],
    });
    // The failed call gave its place back.
    expect(
      await prisma.aiUsageDaily.findMany({
        where: { user_id: session.userId },
      }),
    ).toEqual([expect.objectContaining({ requests: 0 })]);

    claude.failure = null;
    claude.reply = 'I could not understand.';
    expect((await parse(session.auth, 'taksi 30 ming')).body).toMatchObject({
      source: 'rules',
      operations: [
        expect.objectContaining({ amount: '30000', categoryId: TRANSPORT }),
      ],
    });
  });

  it('reads by rules once the day’s AI limit is used up', async () => {
    const session = await user();
    await prisma.appSettings.update({
      where: { key: 'ai_daily_limit_parse' },
      data: { value: 1 },
    });
    app.get(AppSettingsService).invalidate();
    try {
      claude.available = true;
      claude.reply = JSON.stringify({
        operations: [
          { type: 'expense', amount: 1000, category: null, note: 'Хлеб' },
        ],
      });
      expect((await parse(session.auth, 'хлеб 1000')).body.source).toBe('ai');
      expect((await parse(session.auth, 'хлеб 1000')).body).toMatchObject({
        source: 'rules',
        operations: [expect.objectContaining({ amount: '1000', note: 'Хлеб' })],
      });
    } finally {
      await prisma.appSettings.update({
        where: { key: 'ai_daily_limit_parse' },
        data: { value: 100 },
      });
      app.get(AppSettingsService).invalidate();
    }
  });

  it('is Lunex Pro, and the operations save with their source', async () => {
    const session = await user();
    const account = randomUUID();
    await http
      .post('/v1/accounts')
      .set(session.auth)
      .send({ id: account, name: 'Cash', currency: 'UZS', initialBalance: '0' })
      .expect(201);
    for (const source of ['voice', 'text_ai']) {
      const res = await http
        .post('/v1/transactions')
        .set(session.auth)
        .send({
          id: randomUUID(),
          type: 'expense',
          accountId: account,
          amount: '25000',
          categoryId: CAFE,
          source,
          occurredAt: new Date().toISOString(),
        })
        .expect(201);
      expect(res.body.source).toBe(source);
    }

    await setMonetization(true);
    await prisma.subscriptions.updateMany({
      where: { user_id: session.userId },
      data: { expires_at: new Date('2026-01-01') },
    });
    const refused = await parse(session.auth, 'кофе 25 тысяч', 403);
    expect(refused.body).toMatchObject({
      code: 'pro_required',
      feature: 'voice_input',
    });
  });
});
