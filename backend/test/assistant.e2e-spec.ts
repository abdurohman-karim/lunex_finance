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
import { addDays, localDate } from '../src/common/dates.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { systemCategoryId } from '../src/database/reference-data.js';
import { UsersService } from '../src/users/users.service.js';
import {
  resetRateLimits,
  signUp,
  type TestSession,
} from './support/session.js';

const CAFE = systemCategoryId('expense', 'cafe');

type Step = (request: ClaudeRequest) => Partial<ClaudeReply>;

/** Claude played from a script: each call takes the next step and keeps the request. */
class ScriptedClaude {
  available = true;
  failure: ClaudeUnavailableError | null = null;
  script: Step[] = [];
  requests: ClaudeRequest[] = [];

  async complete(request: ClaudeRequest): Promise<ClaudeReply> {
    this.requests.push(structuredClone(request));
    if (this.failure) throw this.failure;
    const step = this.script.shift() ?? (() => say('Хорошо.'));
    const reply = step(request);
    return {
      text: reply.text ?? '',
      content: reply.content,
      stopReason: reply.stopReason ?? 'end_turn',
      model: 'claude-sonnet-test',
      usage: { inputTokens: 1000, outputTokens: 100 },
    };
  }
}

const say = (text: string): Partial<ClaudeReply> => ({
  text,
  content: [{ type: 'text', text, citations: null }],
  stopReason: 'end_turn',
});

/** A tool call as the API returns it (only the fields the server reads). */
const toolUse = (name: string, input: Record<string, unknown>, id?: string) =>
  ({
    type: 'tool_use',
    id: id ?? `toolu_${randomUUID()}`,
    name,
    input,
  }) as unknown as NonNullable<ClaudeReply['content']>[number];

const use = (
  name: string,
  input: Record<string, unknown>,
): Partial<ClaudeReply> => ({
  text: '',
  stopReason: 'tool_use',
  content: [toolUse(name, input)],
});

/** The ref the prompt gives a category, by one of its names. */
const ref = (request: ClaudeRequest, name: string) =>
  request.system
    .split('\n')
    .find((line) => line.includes(name))!
    .split(' ')[0];

/** What the server answered to the model's look-ups in that request. */
const toolResults = (request: ClaudeRequest) =>
  request.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.flatMap((block) =>
          block.type === 'tool_result'
            ? [
                {
                  error: block.is_error === true,
                  // The server always sends a tool's result as JSON text.
                  body: JSON.parse(block.content as string) as Record<
                    string,
                    unknown
                  >,
                },
              ]
            : [],
        )
      : [],
  );

const plain = (text: string) => text.replace(/\s/g, ' ');

describe('AI assistant (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  const claude = new ScriptedClaude();
  const userIds: string[] = [];
  const today = () => localDate(new Date(), 'Asia/Tashkent');

  async function user() {
    const session = await signUp(http, 'ru', { ai: true });
    userIds.push(session.userId);
    return session;
  }

  async function account(session: TestSession) {
    const id = randomUUID();
    await http
      .post('/v1/accounts')
      .set(session.auth)
      .send({ id, name: 'Cash', currency: 'UZS', initialBalance: '0' })
      .expect(201);
    await http
      .patch('/v1/me/settings')
      .set(session.auth)
      .send({ defaultAccountId: id })
      .expect(200);
    return id;
  }

  async function expense(
    session: TestSession,
    accountId: string,
    amount: string,
    daysAgo = 0,
  ) {
    await http
      .post('/v1/transactions')
      .set(session.auth)
      .send({
        id: randomUUID(),
        type: 'expense',
        accountId,
        amount,
        categoryId: CAFE,
        note: 'Кофе',
        occurredAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
      })
      .expect(201);
  }

  const ask = (
    session: TestSession,
    text: string,
    conversationId = randomUUID(),
    messageId = randomUUID(),
    status = 200,
  ) =>
    http
      .post('/v1/assistant/messages')
      .set(session.auth)
      .send({ conversationId, messageId, text })
      .expect(status);

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
  });

  afterEach(() => {
    claude.available = true;
    claude.failure = null;
    claude.script = [];
    claude.requests = [];
  });

  afterAll(async () => {
    try {
      const users = app.get(UsersService);
      for (const id of userIds) await users.purgeUser(id);
    } finally {
      await app.close();
    }
  });

  it('answers from the user’s figures through tools, as one request', async () => {
    const session = await user();
    const cash = await account(session);
    await expense(session, cash, '45000');
    await expense(session, cash, '30000', 1);

    claude.script = [
      (r) =>
        use('spending', {
          from: addDays(today(), -6),
          to: today(),
          category: ref(r, 'Кафе'),
        }),
      () => say('За неделю на кафе ушло 75 000 сум.'),
    ];
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const res = await ask(
      session,
      'Сколько я потратил на кафе за неделю?',
      conversationId,
      messageId,
    );

    expect(res.body.conversation).toMatchObject({
      id: conversationId,
      title: 'Сколько я потратил на кафе за неделю?',
    });
    const [question, answer] = res.body.messages;
    expect(question).toMatchObject({ id: messageId, role: 'user' });
    expect(answer).toMatchObject({
      role: 'assistant',
      content: 'За неделю на кафе ушло 75 000 сум.',
      actions: [],
    });
    expect(answer.charts).toEqual([
      expect.objectContaining({
        kind: 'bars',
        title: 'Кафе и рестораны',
        currency: 'UZS',
      }),
    ]);
    expect(answer.charts[0].points).toHaveLength(7);
    expect(
      answer.charts[0].points.map((p: { value: string }) => Number(p.value)),
    ).toEqual([0, 0, 0, 0, 0, 30000, 45000]);

    // The model saw the figures worded the user's way, in its own language.
    const first = claude.requests[0];
    expect(first.tier).toBe('smart');
    expect(first.system).toContain('Answer in Russian');
    expect(first.tools?.map((t) => t.name)).toContain('propose_goal');
    const [result] = toolResults(claude.requests[1]);
    expect(result.error).toBe(false);
    expect(plain(String(result.body.total))).toBe('75 000 сум');
    expect(result.body.operations).toBe(2);

    // Two calls to the model, one message of the day.
    expect(res.body.usage).toMatchObject({
      feature: 'assistant',
      used: 1,
      limit: 50,
      remaining: 49,
    });
    const usage = await prisma.aiUsageDaily.findFirstOrThrow({
      where: { user_id: session.userId, feature: 'assistant' },
    });
    expect(usage).toMatchObject({
      requests: 1,
      input_tokens: 2000,
      output_tokens: 200,
    });

    // Sent again (no answer reached the phone): the same answer, nothing asked again.
    const again = await ask(session, 'x', conversationId, messageId);
    expect(again.body.messages[1].id).toBe(answer.id);
    expect(claude.requests).toHaveLength(2);

    // A follow-up carries the conversation so far.
    claude.script = [() => say('Вчера — 30 000 сум.')];
    await ask(session, 'А вчера?', conversationId);
    const followUp = claude.requests[2].messages;
    expect(followUp.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(followUp[1].content).toBe('За неделю на кафе ушло 75 000 сум.');
  });

  it('proposes; only the user’s confirmation does it', async () => {
    const session = await user();
    await account(session);
    claude.script = [
      () =>
        use('propose_goal', {
          title: 'Машина',
          target_amount: 120_000_000,
          deadline: addDays(today(), 365),
          emoji: '🚗',
        }),
      (r) =>
        use('propose_category_limit', {
          category: ref(r, 'Кафе'),
          amount: 500_000,
        }),
      () =>
        use('propose_recurring', {
          title: 'Netflix',
          type: 'expense',
          amount: 99_000,
          frequency: 'monthly',
          day_of_month: 5,
          is_subscription: true,
        }),
      () => say('Предлагаю цель, лимит на кафе и подписку — подтвердите.'),
    ];
    const res = await ask(session, 'Помоги накопить на машину');
    const answer = res.body.messages[1];
    expect(answer.actions).toEqual([
      expect.objectContaining({
        kind: 'create_goal',
        title: 'Машина',
        targetAmount: '120000000',
        currency: 'UZS',
        emoji: '🚗',
        status: 'proposed',
        resultId: null,
      }),
      expect.objectContaining({
        kind: 'category_limit',
        categoryId: CAFE,
        categoryName: 'Кафе и рестораны',
        limit: '500000',
        status: 'proposed',
      }),
      expect.objectContaining({
        kind: 'recurring',
        title: 'Netflix',
        amount: '99000',
        dayOfMonth: 5,
        isSubscription: true,
      }),
    ]);
    expect(
      await prisma.goals.count({ where: { user_id: session.userId } }),
    ).toBe(0);

    const decide = (index: number, decision: string) =>
      http
        .post(`/v1/assistant/messages/${answer.id}/actions/${index}`)
        .set(session.auth)
        .send({ decision })
        .expect(200);

    const goal = (await decide(0, 'confirm')).body.actions[0];
    expect(goal).toMatchObject({
      status: 'done',
      resultId: expect.any(String),
    });
    const created = await prisma.goals.findUniqueOrThrow({
      where: { id: goal.resultId },
    });
    expect(created).toMatchObject({ title: 'Машина', emoji: '🚗' });
    // Confirmed twice: still one goal.
    await decide(0, 'confirm');
    expect(
      await prisma.goals.count({ where: { user_id: session.userId } }),
    ).toBe(1);

    await decide(1, 'confirm');
    const budget = await http
      .get('/v1/budget/current')
      .set(session.auth)
      .expect(200);
    expect(budget.body.categoryLimits).toEqual([
      expect.objectContaining({ categoryId: CAFE, limit: '500000' }),
    ]);

    const declined = await decide(2, 'decline');
    expect(declined.body.actions[2].status).toBe('declined');
    expect(
      await prisma.recurringRules.count({ where: { user_id: session.userId } }),
    ).toBe(0);
    // Decided already: confirming later changes nothing.
    await decide(2, 'confirm');
    expect(
      await prisma.recurringRules.count({ where: { user_id: session.userId } }),
    ).toBe(0);
    await http
      .post(`/v1/assistant/messages/${answer.id}/actions/7`)
      .set(session.auth)
      .send({ decision: 'confirm' })
      .expect(400);
  });

  it('looks up goals, the budget, accounts, payments and operations', async () => {
    const session = await user();
    const cash = await account(session);
    await expense(session, cash, '45000');
    const goalId = randomUUID();
    await http
      .post('/v1/goals')
      .set(session.auth)
      .send({ id: goalId, title: 'Машина', targetAmount: '1000000' })
      .expect(201);
    await http
      .post(`/v1/goals/${goalId}/contributions`)
      .set(session.auth)
      .send({ id: randomUUID(), type: 'deposit', amount: '300000' })
      .expect(201);

    claude.script = [
      () => ({
        text: '',
        stopReason: 'tool_use',
        content: ['goals', 'budget', 'accounts', 'recurring', 'operations'].map(
          (name) =>
            toolUse(
              name,
              name === 'operations'
                ? { from: addDays(today(), -30), to: today(), order: 'largest' }
                : {},
              `toolu_${name}`,
            ),
        ),
      }),
      () => say('Готово.'),
    ];
    const res = await ask(session, 'Как у меня дела?');
    const results = toolResults(claude.requests[1]);
    expect(results.map((r) => r.error)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    const [goals, budget, accounts, recurring, operations] = results.map(
      (r) => r.body,
    );
    const [goal] = goals.goals as Record<string, unknown>[];
    expect(goal).toMatchObject({ title: '🎯 Машина', progressPercent: 30 });
    expect(plain(String(goal.left))).toBe('700 000 сум');
    // 300 000 in the last three months: 100 000 a month, seven months to go.
    expect(plain(String(goal.savedPerMonthLately))).toBe('100 000 сум');
    expect(goal.reachedAtThisPace).toBe(addDays(today(), Math.ceil(7 * 30.44)));
    expect(plain(String(budget.spent))).toBe('45 000 сум');
    expect(budget.safeToSpendToday).toEqual(expect.any(String));
    expect(accounts.accounts).toEqual([
      expect.objectContaining({ name: 'Cash', type: 'cash' }),
    ]);
    expect(recurring.payments).toEqual([]);
    expect(operations.operations).toEqual([
      expect.objectContaining({
        type: 'expense',
        category: 'Кафе и рестораны',
        note: 'Кофе',
        account: 'Cash',
      }),
    ]);
    // Goals come with a progress chart.
    expect(res.body.messages[1].charts).toEqual([
      expect.objectContaining({ kind: 'progress', title: 'Цели' }),
    ]);
  });

  it('hands a tool’s mistake back to the model', async () => {
    const session = await user();
    claude.script = [
      () => use('spending', { from: today(), to: today(), category: 'c999' }),
      () => say('Не нашёл такую категорию.'),
    ];
    await ask(session, 'Сколько на c999?');
    const [result] = toolResults(claude.requests[1]);
    expect(result).toEqual({
      error: true,
      body: { error: 'Unknown category ref c999' },
    });
  });

  it('a failed answer is not counted; the same message id tries again', async () => {
    const session = await user();
    const conversationId = randomUUID();
    const messageId = randomUUID();

    claude.failure = new ClaudeUnavailableError('failed', 'down');
    const failed = await ask(
      session,
      'Сколько я сэкономил?',
      conversationId,
      messageId,
      502,
    );
    expect(failed.body.code).toBe('ai_failed');
    expect(
      await prisma.aiUsageDaily.findMany({
        where: { user_id: session.userId },
      }),
    ).toEqual([expect.objectContaining({ requests: 0 })]);
    // The question stays, waiting for its answer.
    const waiting = await http
      .get(`/v1/assistant/conversations/${conversationId}/messages`)
      .set(session.auth)
      .expect(200);
    expect(waiting.body.map((m: { role: string }) => m.role)).toEqual(['user']);

    claude.failure = null;
    claude.script = [() => say('Пока ничего не отложено.')];
    const retried = await ask(
      session,
      'Сколько я сэкономил?',
      conversationId,
      messageId,
    );
    expect(retried.body.messages.map((m: { role: string }) => m.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(retried.body.usage.used).toBe(1);

    claude.available = false;
    const off = await ask(
      session,
      'Ещё вопрос',
      conversationId,
      randomUUID(),
      503,
    );
    expect(off.body.code).toBe('ai_unavailable');
  });

  it('holds the day’s limit of messages', async () => {
    const session = await user();
    await prisma.appSettings.update({
      where: { key: 'ai_daily_limit_pro' },
      data: { value: 2 },
    });
    app.get(AppSettingsService).invalidate();
    try {
      await ask(session, 'Один');
      const second = await ask(session, 'Два');
      expect(second.body.usage).toMatchObject({ used: 2, remaining: 0 });
      const third = await ask(session, 'Три', randomUUID(), randomUUID(), 429);
      expect(third.body).toMatchObject({ code: 'ai_limit_reached', limit: 2 });
    } finally {
      await prisma.appSettings.update({
        where: { key: 'ai_daily_limit_pro' },
        data: { value: 50 },
      });
      app.get(AppSettingsService).invalidate();
    }
  });

  it('keeps the history for its owner, and deletes it', async () => {
    const session = await user();
    const stranger = await user();
    const first = randomUUID();
    const second = randomUUID();
    await ask(session, 'Первый разговор', first);
    await ask(session, 'Второй разговор', second);

    const list = await http
      .get('/v1/assistant/conversations')
      .set(session.auth)
      .expect(200);
    expect(list.body.map((c: { id: string }) => c.id)).toEqual([second, first]);
    await http
      .get(`/v1/assistant/conversations/${first}/messages`)
      .set(stranger.auth)
      .expect(404);
    await ask(stranger, 'Чужой', first, randomUUID(), 409);

    await http
      .delete(`/v1/assistant/conversations/${first}`)
      .set(session.auth)
      .expect(204);
    expect(
      await prisma.aiMessages.count({ where: { conversation_id: first } }),
    ).toBe(0);
    await ask(session, 'Снова', first, randomUUID(), 404);
    const rest = await http
      .get('/v1/assistant/conversations')
      .set(session.auth)
      .expect(200);
    expect(rest.body.map((c: { id: string }) => c.id)).toEqual([second]);

    await http
      .delete('/v1/assistant/conversations')
      .set(session.auth)
      .expect(204);
    const none = await http
      .get('/v1/assistant/conversations')
      .set(session.auth)
      .expect(200);
    expect(none.body).toEqual([]);
  });
});
