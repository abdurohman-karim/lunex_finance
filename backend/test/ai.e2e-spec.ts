import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AiService } from '../src/ai/ai.service.js';
import {
  ClaudeClient,
  type ClaudeReply,
  ClaudeUnavailableError,
} from '../src/ai/claude.client.js';
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

/** Tuesday 20 October 2026, 11:00 in Tashkent. */
const NOW = new Date('2026-10-20T06:00:00Z');

/** Claude as the tests want it: an answer with tokens, or a failure. */
class FakeClaude {
  available = true;
  failure: ClaudeUnavailableError | null = null;
  calls = 0;

  async complete(): Promise<ClaudeReply> {
    this.calls += 1;
    // A moment for parallel requests to overlap.
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (this.failure) throw this.failure;
    return {
      text: 'ok',
      model: 'claude-test',
      usage: { inputTokens: 120, outputTokens: 30 },
    };
  }
}

describe('AI usage and limits (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  let ai: AiService;
  const claude = new FakeClaude();
  let originalMonetization: unknown;
  const userIds: string[] = [];

  const ask = (
    s: TestSession,
    feature: 'assistant' | 'parse_input' | 'receipt' | 'insight' = 'assistant',
    now = NOW,
  ) =>
    ai.ask(
      s.userId,
      feature,
      {
        tier: 'smart',
        system: 'test',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
      },
      now,
    );

  const rows = (s: TestSession) =>
    prisma.aiUsageDaily.findMany({
      where: { user_id: s.userId },
      orderBy: [{ usage_date: 'asc' }, { feature: 'asc' }],
    });

  async function setMonetization(enabled: boolean) {
    await prisma.appSettings.update({
      where: { key: 'monetization_enabled' },
      data: { value: enabled },
    });
    app.get(AppSettingsService).invalidate();
  }

  /** Free: monetization on and the trial over. */
  async function freeUser() {
    const session = await signUp(http, 'ru', { ai: true });
    userIds.push(session.userId);
    await prisma.subscriptions.updateMany({
      where: { user_id: session.userId },
      data: { expires_at: new Date('2026-01-01') },
    });
    return session;
  }

  async function newUser() {
    const session = await signUp(http, 'ru', { ai: true });
    userIds.push(session.userId);
    return session;
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
    ai = app.get(AiService);
    await resetRateLimits(app);
    originalMonetization = (
      await prisma.appSettings.findUniqueOrThrow({
        where: { key: 'monetization_enabled' },
      })
    ).value;
  });

  afterEach(async () => {
    claude.failure = null;
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

  it('shows the day against the limits', async () => {
    const session = await newUser();
    const res = await http.get('/v1/ai/usage').set(session.auth).expect(200);
    expect(res.body.available).toBe(true);
    expect(res.body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Monetization off: Pro for everyone.
    expect(res.body.features).toEqual([
      { feature: 'assistant', used: 0, limit: 50, remaining: 50 },
      { feature: 'parse_input', used: 0, limit: 100, remaining: 100 },
      { feature: 'receipt', used: 0, limit: 30, remaining: 30 },
      { feature: 'insight', used: 0, limit: null, remaining: null },
    ]);
    expect(new Date(res.body.resetsAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('gives Free 5 assistant messages a day and counts their tokens', async () => {
    await setMonetization(true);
    const session = await freeUser();
    for (let i = 0; i < 5; i++) await ask(session);
    await expect(ask(session)).rejects.toMatchObject({
      status: 429,
      response: {
        code: 'ai_limit_reached',
        feature: 'assistant',
        limit: 5,
        resetsAt: '2026-10-20T19:00:00.000Z',
      },
    });
    const [row] = await rows(session);
    expect(row).toMatchObject({
      feature: 'assistant',
      requests: 5,
      input_tokens: 600,
      output_tokens: 150,
    });

    // The next day in Tashkent starts again.
    await ask(session, 'assistant', new Date('2026-10-20T19:30:00Z'));
    expect((await rows(session)).map((r) => r.requests)).toEqual([5, 1]);
  });

  it('does not count a request the model failed', async () => {
    const session = await newUser();
    // Today, as the usage endpoint reads it.
    const now = new Date();
    await ask(session, 'assistant', now);

    claude.failure = new ClaudeUnavailableError('failed', 'down');
    await expect(ask(session, 'assistant', now)).rejects.toMatchObject({
      status: 502,
      response: { code: 'ai_failed' },
    });
    claude.failure = new ClaudeUnavailableError('not_configured', 'no key');
    await expect(ask(session, 'assistant', now)).rejects.toMatchObject({
      status: 503,
      response: { code: 'ai_unavailable' },
    });

    const [row] = await rows(session);
    // Both failures are counted for the admin panel's monitoring, not against the limit.
    expect(row).toMatchObject({ requests: 1, input_tokens: 120, failed: 2 });
    const res = await http.get('/v1/ai/usage').set(session.auth).expect(200);
    expect(res.body.features[0]).toMatchObject({ used: 1, remaining: 49 });
  });

  it('holds the limit when requests come at once', async () => {
    await setMonetization(true);
    const session = await freeUser();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => ask(session)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect(
      results.filter(
        (r) =>
          r.status === 'rejected' &&
          (r.reason as { status?: number }).status === 429,
      ),
    ).toHaveLength(3);
    expect((await rows(session))[0].requests).toBe(5);
  });

  it('keeps voice and receipts for Pro and counts insights without a cap', async () => {
    await setMonetization(true);
    const session = await freeUser();
    const before = claude.calls;
    await expect(ask(session, 'parse_input')).rejects.toMatchObject({
      status: 403,
      response: { code: 'pro_required', feature: 'voice_input' },
    });
    await expect(ask(session, 'receipt')).rejects.toMatchObject({
      status: 403,
      response: { code: 'pro_required', feature: 'receipt_scan' },
    });
    expect(claude.calls).toBe(before);

    for (let i = 0; i < 3; i++) await ask(session, 'insight');
    expect(await rows(session)).toEqual([
      expect.objectContaining({ feature: 'insight', requests: 3 }),
    ]);
  });

  it('sends nothing to Claude before the user allows it, and forgets when they take it back', async () => {
    const session = await signUp(http, 'ru');
    userIds.push(session.userId);
    const settings = await http
      .get('/v1/me/settings')
      .set(session.auth)
      .expect(200);
    expect(settings.body).toMatchObject({
      aiConsent: false,
      aiConsentAt: null,
    });
    const before = claude.calls;

    await expect(ask(session)).rejects.toMatchObject({
      response: { code: 'ai_consent_required' },
    });
    const refused = await http
      .post('/v1/assistant/messages')
      .set(session.auth)
      .send({
        conversationId: crypto.randomUUID(),
        messageId: crypto.randomUUID(),
        text: 'Сколько я потратил?',
      })
      .expect(403);
    expect(refused.body).toMatchObject({ code: 'ai_consent_required' });
    // Phrases are still read, by the server's own rules.
    const parsed = await http
      .post('/v1/ai/parse')
      .set(session.auth)
      .send({ text: 'кофе 25 тысяч' })
      .expect(200);
    expect(parsed.body.source).toBe('rules');
    expect(claude.calls).toBe(before);
    expect(await rows(session)).toEqual([]);

    const allowed = await http
      .patch('/v1/me/settings')
      .set(session.auth)
      .send({ aiConsent: true })
      .expect(200);
    expect(allowed.body.aiConsent).toBe(true);
    // Allowed again: the first moment stays.
    const again = await http
      .patch('/v1/me/settings')
      .set(session.auth)
      .send({ aiConsent: true })
      .expect(200);
    expect(again.body.aiConsentAt).toBe(allowed.body.aiConsentAt);
    await ask(session);
    expect(claude.calls).toBe(before + 1);

    const revoked = await http
      .patch('/v1/me/settings')
      .set(session.auth)
      .send({ aiConsent: false })
      .expect(200);
    expect(revoked.body).toMatchObject({ aiConsent: false, aiConsentAt: null });
    await expect(ask(session)).rejects.toMatchObject({
      response: { code: 'ai_consent_required' },
    });
  });
});
