import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { APPLE_JWKS, GOOGLE_JWKS } from '../src/auth/providers/oidc.js';
import { telegramHash } from '../src/auth/providers/telegram.verifier.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { MailSender, type MailMessage } from '../src/mail/mail-sender.js';
import { REDIS } from '../src/redis/redis.module.js';
import { UsersService } from '../src/users/users.service.js';
import { createTestIdp, sha256Hex, type TestIdp } from './support/oidc-keys.js';

// Needs the services from compose.yaml with migrations and seed applied.
class CapturingMailSender extends MailSender {
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
  lastCodeFor(email: string): string {
    const message = this.sent.findLast((m) => m.to === email);
    const code = message?.text.match(/\b\d{6}\b/)?.[0];
    if (!code) throw new Error(`No code sent to ${email}`);
    return code;
  }
}

const APPLE_AUD = 'uz.lunex.test';
const GOOGLE_AUD = 'google-test-client';
const TELEGRAM_TOKEN = '123456:test-token';

describe('Auth (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  let users: UsersService;
  let idp: TestIdp;
  const mail = new CapturingMailSender();
  const createdUserIds = new Set<string>();

  const uniqueEmail = () => `e2e-${randomUUID()}@lunex.test`;
  const device = () => ({
    id: randomUUID(),
    model: 'iPhone16,2',
    osVersion: '26.0',
    appVersion: '0.1.0',
  });

  async function signInWithEmail(email: string, dev = device()) {
    await http
      .post('/v1/auth/email/start')
      .send({ email, language: 'ru' })
      .expect(202);
    // `language` on start localises the email; on verify it sets a new account's language.
    const res = await http
      .post('/v1/auth/email/verify')
      .send({
        email,
        code: mail.lastCodeFor(email),
        device: dev,
        language: 'ru',
      })
      .expect(200);
    createdUserIds.add(res.body.user.id);
    return res.body;
  }

  async function googleToken(sub: string, email: string, emailVerified = true) {
    return idp.sign(
      { sub, email, email_verified: emailVerified },
      { issuer: 'https://accounts.google.com', audience: GOOGLE_AUD },
    );
  }

  function telegramAuthData(id: number) {
    const data = {
      id,
      first_name: 'Tg',
      auth_date: Math.floor(Date.now() / 1000),
    };
    return { ...data, hash: telegramHash(data, TELEGRAM_TOKEN) };
  }

  beforeAll(async () => {
    idp = await createTestIdp();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APPLE_JWKS)
      .useValue(idp.keys)
      .overrideProvider(GOOGLE_JWKS)
      .useValue(idp.keys)
      .overrideProvider(MailSender)
      .useValue(mail)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    http = request(app.getHttpServer());
    prisma = app.get(PrismaService);
    users = app.get(UsersService);

    // Rate-limit windows persist in Redis between runs; start each run clean.
    const redis = app.get<Redis>(REDIS);
    const keys = await redis.keys('lunex:rl:*');
    if (keys.length > 0) await redis.del(...keys);
  });

  afterAll(async () => {
    for (const id of createdUserIds) {
      await users.purgeUser(id);
    }
    await app.close();
  });

  describe('email code', () => {
    it('creates an account with settings and a 30-day Pro trial', async () => {
      const email = uniqueEmail();
      const body = await signInWithEmail(email);

      expect(body.isNewUser).toBe(true);
      expect(body.user).toMatchObject({
        email,
        role: 'user',
        language: 'ru',
        baseCurrency: 'UZS',
        onboardingCompleted: false,
        identities: ['email'],
      });
      expect(body.accessToken).toEqual(expect.any(String));
      expect(body.refreshToken).toEqual(expect.any(String));

      const [settings, trial] = await Promise.all([
        prisma.userSettings.findUnique({ where: { user_id: body.user.id } }),
        prisma.subscriptions.findFirst({ where: { user_id: body.user.id } }),
      ]);
      expect(settings).not.toBeNull();
      expect(trial).toMatchObject({ source: 'trial', status: 'active' });
      const days =
        (trial!.expires_at.getTime() - trial!.started_at.getTime()) /
        86_400_000;
      expect(days).toBe(30);
    });

    it('signs the same email into the same account', async () => {
      const email = uniqueEmail();
      const first = await signInWithEmail(email);
      await prisma.emailVerifications.updateMany({
        where: { email },
        data: { created_at: new Date(Date.now() - 120_000) },
      });
      const second = await signInWithEmail(email);
      expect(second.isNewUser).toBe(false);
      expect(second.user.id).toBe(first.user.id);
    });

    it('refuses a wrong code and counts attempts', async () => {
      const email = uniqueEmail();
      await http.post('/v1/auth/email/start').send({ email }).expect(202);
      const wrong = mail.lastCodeFor(email) === '000000' ? '111111' : '000000';
      const res = await http
        .post('/v1/auth/email/verify')
        .send({ email, code: wrong, device: device() })
        .expect(400);
      expect(res.body).toMatchObject({ code: 'invalid_code', attemptsLeft: 4 });
    });

    it('locks the code after 5 wrong attempts', async () => {
      const email = uniqueEmail();
      await http.post('/v1/auth/email/start').send({ email }).expect(202);
      const right = mail.lastCodeFor(email);
      const wrong = right === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) {
        await http
          .post('/v1/auth/email/verify')
          .send({ email, code: wrong, device: device() })
          .expect(400);
      }
      const res = await http
        .post('/v1/auth/email/verify')
        .send({ email, code: right, device: device() })
        .expect(429);
      expect(res.body.code).toBe('too_many_attempts');
    });

    it('does not resend a code within a minute', async () => {
      const email = uniqueEmail();
      await http.post('/v1/auth/email/start').send({ email }).expect(202);
      const res = await http
        .post('/v1/auth/email/start')
        .send({ email })
        .expect(429);
      expect(res.body.code).toBe('resend_too_soon');
      expect(res.body.retryAfter).toBeGreaterThan(0);
    });

    it('never stores the code itself', async () => {
      const email = uniqueEmail();
      await http.post('/v1/auth/email/start').send({ email }).expect(202);
      const row = await prisma.emailVerifications.findFirstOrThrow({
        where: { email },
      });
      expect(row.code_hash).not.toContain(mail.lastCodeFor(email));
      expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('tokens', () => {
    it('protects /v1/me', async () => {
      expect((await http.get('/v1/me').expect(401)).body.code).toBe(
        'missing_access_token',
      );
      expect(
        (
          await http
            .get('/v1/me')
            .set('Authorization', 'Bearer nope')
            .expect(401)
        ).body.code,
      ).toBe('invalid_access_token');
    });

    it('returns the profile for a valid access token', async () => {
      const session = await signInWithEmail(uniqueEmail());
      const res = await http
        .get('/v1/me')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .expect(200);
      expect(res.body.id).toBe(session.user.id);
    });

    it('rotates refresh tokens and revokes the device when an old one is reused', async () => {
      const session = await signInWithEmail(uniqueEmail());
      const rotated = await http
        .post('/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(200);
      expect(rotated.body.refreshToken).not.toBe(session.refreshToken);

      const reused = await http
        .post('/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
      expect(reused.body.code).toBe('refresh_token_reused');

      // The leak response also killed the token that was issued by the rotation.
      await http
        .post('/v1/auth/refresh')
        .send({ refreshToken: rotated.body.refreshToken })
        .expect(401);
    });

    it('logs out one session', async () => {
      const session = await signInWithEmail(uniqueEmail());
      await http
        .post('/v1/auth/logout')
        .send({ refreshToken: session.refreshToken })
        .expect(204);
      await http
        .post('/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
    });

    it('logs out every device', async () => {
      const email = uniqueEmail();
      const phone = await signInWithEmail(email);
      await prisma.emailVerifications.updateMany({
        where: { email },
        data: { created_at: new Date(Date.now() - 120_000) },
      });
      const otherPhone = await signInWithEmail(email);

      await http
        .delete('/v1/me/sessions')
        .set('Authorization', `Bearer ${phone.accessToken}`)
        .expect(204);
      for (const s of [phone, otherPhone]) {
        await http
          .post('/v1/auth/refresh')
          .send({ refreshToken: s.refreshToken })
          .expect(401);
      }
    });
  });

  describe('providers and linking', () => {
    it('links Google to the account with the same verified email', async () => {
      const email = uniqueEmail();
      const byEmail = await signInWithEmail(email);
      const res = await http
        .post('/v1/auth/google')
        .send({
          idToken: await googleToken(`g-${randomUUID()}`, email),
          device: device(),
        })
        .expect(200);
      expect(res.body.isNewUser).toBe(false);
      expect(res.body.user.id).toBe(byEmail.user.id);
      expect(res.body.user.identities).toEqual(['email', 'google']);
    });

    it('does not link on an unverified email', async () => {
      const email = uniqueEmail();
      const byEmail = await signInWithEmail(email);
      const res = await http
        .post('/v1/auth/google')
        .send({
          idToken: await googleToken(`g-${randomUUID()}`, email, false),
          device: device(),
        })
        .expect(200);
      createdUserIds.add(res.body.user.id);
      expect(res.body.isNewUser).toBe(true);
      expect(res.body.user.id).not.toBe(byEmail.user.id);
      expect(res.body.user.email).toBeNull();
    });

    it('signs in with Apple and checks the nonce', async () => {
      const nonce = randomUUID();
      const identityToken = await idp.sign(
        { sub: `a-${randomUUID()}`, nonce: sha256Hex(nonce) },
        { issuer: 'https://appleid.apple.com', audience: APPLE_AUD },
      );
      const bad = await http
        .post('/v1/auth/apple')
        .send({ identityToken, nonce: randomUUID(), device: device() })
        .expect(401);
      expect(bad.body.code).toBe('invalid_nonce');

      const res = await http
        .post('/v1/auth/apple')
        .send({
          identityToken,
          nonce,
          displayName: 'Apple User',
          device: device(),
          language: 'uz',
        })
        .expect(200);
      createdUserIds.add(res.body.user.id);
      expect(res.body.user).toMatchObject({
        displayName: 'Apple User',
        identities: ['apple'],
        language: 'uz',
      });
    });

    it('signs in with Telegram and refuses tampered data', async () => {
      const id = Math.floor(Math.random() * 1e9) + 1;
      const authData = telegramAuthData(id);
      await http
        .post('/v1/auth/telegram')
        .send({
          authData: { ...authData, first_name: 'Mallory' },
          device: device(),
        })
        .expect(401);
      const res = await http
        .post('/v1/auth/telegram')
        .send({ authData, device: device() })
        .expect(200);
      createdUserIds.add(res.body.user.id);
      expect(res.body.user).toMatchObject({
        displayName: 'Tg',
        identities: ['telegram'],
        email: null,
      });
    });

    it('links and unlinks sign-in methods from settings', async () => {
      const tg = await http
        .post('/v1/auth/telegram')
        .send({
          authData: telegramAuthData(Math.floor(Math.random() * 1e9) + 1),
          device: device(),
        })
        .expect(200);
      createdUserIds.add(tg.body.user.id);
      const auth = { Authorization: `Bearer ${tg.body.accessToken}` };

      const email = uniqueEmail();
      await http.post('/v1/auth/email/start').send({ email }).expect(202);
      const linked = await http
        .post('/v1/me/identities')
        .set(auth)
        .send({ provider: 'email', email, code: mail.lastCodeFor(email) })
        .expect(200);
      expect(linked.body).toMatchObject({
        identities: ['telegram', 'email'],
        email,
      });

      await http.delete('/v1/me/identities/telegram').set(auth).expect(200);
      const last = await http
        .delete('/v1/me/identities/email')
        .set(auth)
        .expect(409);
      expect(last.body.code).toBe('last_identity');
    });

    it("refuses to link another account's identity", async () => {
      const googleSub = `g-${randomUUID()}`;
      const owner = await http
        .post('/v1/auth/google')
        .send({
          idToken: await googleToken(googleSub, uniqueEmail()),
          device: device(),
        })
        .expect(200);
      createdUserIds.add(owner.body.user.id);

      const other = await signInWithEmail(uniqueEmail());
      const res = await http
        .post('/v1/me/identities')
        .set('Authorization', `Bearer ${other.accessToken}`)
        .send({
          provider: 'google',
          idToken: await googleToken(googleSub, uniqueEmail()),
        })
        .expect(409);
      expect(res.body.code).toBe('identity_in_use');
    });

    it('validates request bodies', async () => {
      const res = await http
        .post('/v1/auth/email/start')
        .send({ email: 'not-an-email' })
        .expect(400);
      expect(res.body.code).toBe('validation_failed');
    });
  });

  describe('account deletion', () => {
    it('ends sessions, restores on sign-in within 30 days', async () => {
      const email = uniqueEmail();
      const session = await signInWithEmail(email);
      await http
        .delete('/v1/me')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .expect(204);

      const refresh = await http
        .post('/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
      expect(refresh.body.code).toBe('account_deleted');

      await prisma.emailVerifications.updateMany({
        where: { email },
        data: { created_at: new Date(Date.now() - 120_000) },
      });
      const again = await signInWithEmail(email);
      expect(again.isNewUser).toBe(false);
      expect(again.user.id).toBe(session.user.id);
      const user = await prisma.users.findUniqueOrThrow({
        where: { id: session.user.id },
      });
      expect(user.deleted_at).toBeNull();
    });

    it('purges the account and its data after 30 days', async () => {
      const email = uniqueEmail();
      const session = await signInWithEmail(email);
      await http
        .delete('/v1/me')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .expect(204);

      const in31Days = new Date(Date.now() + 31 * 86_400_000);
      const { purged } = await users.purgeDeletedAccounts(in31Days);
      expect(purged).toBeGreaterThanOrEqual(1);

      const userId = session.user.id;
      const [user, identities, devices, tokens, subscriptions] =
        await Promise.all([
          prisma.users.findUnique({ where: { id: userId } }),
          prisma.authIdentities.count({ where: { user_id: userId } }),
          prisma.devices.count({ where: { user_id: userId } }),
          prisma.refreshTokens.count({ where: { user_id: userId } }),
          prisma.subscriptions.count({ where: { user_id: userId } }),
        ]);
      expect({ user, identities, devices, tokens, subscriptions }).toEqual({
        user: null,
        identities: 0,
        devices: 0,
        tokens: 0,
        subscriptions: 0,
      });
      createdUserIds.delete(userId);
    });
  });
});
