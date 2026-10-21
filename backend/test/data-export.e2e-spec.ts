import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { systemCategoryId } from '../src/database/reference-data.js';
import { UsersService } from '../src/users/users.service.js';
import {
  resetRateLimits,
  signUp,
  type TestSession,
} from './support/session.js';
import { unzip } from './support/unzip.js';

const MARKET = systemCategoryId('expense', 'market');

/** A file that starts like a JPEG; nothing here decodes it. */
const jpeg = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(4096, 7),
]);

describe('Export of all data (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  const userIds: string[] = [];

  async function user() {
    const session = await signUp(http, 'ru');
    userIds.push(session.userId);
    return session;
  }

  async function account(session: TestSession, name: string) {
    const id = randomUUID();
    await http
      .post('/v1/accounts')
      .set(session.auth)
      .send({ id, name, currency: 'UZS', initialBalance: '0' })
      .expect(201);
    return id;
  }

  /** The archive as bytes: supertest leaves an application/zip body alone. */
  const download = (session: TestSession) =>
    http
      .get('/v1/me/export')
      .set(session.auth)
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (chunk: Buffer) => chunks.push(chunk));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    http = request(app.getHttpServer());
    prisma = app.get(PrismaService);
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

  it('gives a user everything of theirs and nothing else', async () => {
    const me = await user();
    const other = await user();
    const cash = await account(me, 'Наличные');
    await account(other, 'Чужой счёт');
    const transaction = randomUUID();
    await http
      .post('/v1/transactions')
      .set(me.auth)
      .send({
        id: transaction,
        type: 'expense',
        accountId: cash,
        amount: '86500',
        categoryId: MARKET,
        merchant: 'Korzinka',
        note: 'Продукты',
        source: 'receipt_scan',
        occurredAt: '2026-10-20T09:30:00.000Z',
      })
      .expect(201);
    const photo = randomUUID();
    await http
      .put(`/v1/attachments/${photo}`)
      .set(me.auth)
      .field('transactionId', transaction)
      .attach('file', jpeg, {
        filename: 'receipt.jpg',
        contentType: 'image/jpeg',
      })
      .expect(200);
    await prisma.devices.updateMany({
      where: { user_id: me.userId },
      data: { apns_token: `secret-push-token-${me.userId}` },
    });

    const res = await download(me).expect(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="lunex-export-\d{4}-\d{2}-\d{2}\.zip"$/,
    );
    expect(res.headers['cache-control']).toBe('no-store');

    const files = unzip(res.body as Buffer);
    expect([...files.keys()]).toEqual(['data.json', `receipts/${photo}.jpg`]);
    expect(files.get(`receipts/${photo}.jpg`)).toEqual(jpeg);

    const text = files.get('data.json')!.toString('utf8');
    const data = JSON.parse(text);
    expect(data).toMatchObject({
      format: 'lunex-export',
      version: 1,
      user: { id: me.userId, language: 'ru', baseCurrency: 'UZS' },
      signInMethods: [{ provider: 'telegram' }],
      accounts: [{ id: cash, name: 'Наличные', currency: 'UZS' }],
      transactions: [
        {
          id: transaction,
          type: 'expense',
          amount: '86500',
          currency: 'UZS',
          amountBase: '86500',
          categoryId: MARKET,
          merchant: 'Korzinka',
          note: 'Продукты',
          source: 'receipt_scan',
          occurredAt: '2026-10-20T09:30:00.000Z',
          deletedAt: null,
        },
      ],
      attachments: [
        {
          id: photo,
          transactionId: transaction,
          mimeType: 'image/jpeg',
          file: `receipts/${photo}.jpg`,
        },
      ],
    });
    expect(data.settings).toMatchObject({
      dailyReminderTime: '21:00',
      quietHoursStart: '22:00',
    });
    expect(data.devices[0]).not.toHaveProperty('apnsToken');
    expect(data.attachments[0]).not.toHaveProperty('storageKey');
    expect(
      data.systemCategories.find((c: { id: string }) => c.id === MARKET),
    ).toMatchObject({ key: 'market', labels: { ru: 'Супермаркет' } });
    // Nothing of anyone else, and no secrets.
    expect(text).not.toContain(other.userId);
    expect(text).not.toContain('Чужой счёт');
    expect(text).not.toContain('secret-push-token');
    expect(text).not.toMatch(/"userId"|"tokenHash"|"codeHash"/);
  });

  it('takes a sign-in and a few archives an hour', async () => {
    await http.get('/v1/me/export').expect(401);
    const me = await user();
    for (let i = 0; i < 5; i++) await download(me).expect(200);
    const refused = await http.get('/v1/me/export').set(me.auth).expect(429);
    expect(refused.body).toMatchObject({ code: 'rate_limited' });
  });
});
