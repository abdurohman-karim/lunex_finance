import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import {
  ClaudeClient,
  type ClaudeReply,
  type ClaudeRequest,
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

const MARKET = systemCategoryId('expense', 'market');
const STORAGE = process.env.STORAGE_DIR!;

/** A file that starts like a JPEG; nothing here decodes it. */
const jpeg = (fill = 1) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(2048, fill),
  ]);

class FakeClaude {
  available = false;
  reply = '';
  lastRequest: ClaudeRequest | null = null;

  async complete(request: ClaudeRequest): Promise<ClaudeReply> {
    this.lastRequest = request;
    return {
      text: this.reply,
      model: 'claude-haiku-test',
      usage: { inputTokens: 1600, outputTokens: 60 },
    };
  }
}

describe('Receipts and attachments (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  const claude = new FakeClaude();
  let originalMonetization: unknown;
  const userIds: string[] = [];

  async function user() {
    const session = await signUp(http, 'ru');
    userIds.push(session.userId);
    return session;
  }

  /** An account and one expense on it. */
  async function expense(session: TestSession) {
    const account = randomUUID();
    await http
      .post('/v1/accounts')
      .set(session.auth)
      .send({ id: account, name: 'Cash', currency: 'UZS', initialBalance: '0' })
      .expect(201);
    const transaction = randomUUID();
    await http
      .post('/v1/transactions')
      .set(session.auth)
      .send({
        id: transaction,
        type: 'expense',
        accountId: account,
        amount: '86500',
        categoryId: MARKET,
        merchant: 'Korzinka',
        source: 'receipt_scan',
        occurredAt: new Date().toISOString(),
      })
      .expect(201);
    return transaction;
  }

  const upload = (
    session: TestSession,
    id: string,
    transactionId: string,
    file = jpeg(),
    type = 'image/jpeg',
  ) =>
    http
      .put(`/v1/attachments/${id.toUpperCase()}`)
      .set(session.auth)
      .field('transactionId', transactionId.toUpperCase())
      .field(
        'receipt',
        JSON.stringify({
          source: 'device',
          amount: '86500',
          currency: 'UZS',
          date: '2026-10-21',
          merchant: 'Korzinka',
          confidence: 0.9,
        }),
      )
      .attach('file', file, { filename: 'receipt.jpg', contentType: type });

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
    claude.reply = '';
    await setMonetization(originalMonetization as boolean);
  });

  afterAll(async () => {
    try {
      const users = app.get(UsersService);
      for (const id of userIds) await users.purgeUser(id);
      await rm(STORAGE, { recursive: true, force: true });
    } finally {
      await app.close();
    }
  });

  it('keeps the photo with its operation, once per id, and syncs it', async () => {
    const session = await user();
    const transaction = await expense(session);
    const before = await prisma.transactions.findUniqueOrThrow({
      where: { id: transaction },
    });
    const id = randomUUID();

    const res = await upload(session, id, transaction).expect(200);
    expect(res.body).toMatchObject({
      id,
      transactionId: transaction,
      mimeType: 'image/jpeg',
      sizeBytes: 2052,
      ocrStatus: 'done',
      receipt: { source: 'device', amount: '86500', merchant: 'Korzinka' },
    });
    // Sent again (a retry): the same photo, not a second one.
    await upload(session, id, transaction, jpeg(2)).expect(200);
    expect(
      await prisma.transactionAttachments.count({
        where: { transaction_id: transaction },
      }),
    ).toBe(1);

    const file = await http
      .get(`/v1/attachments/${id}`)
      .set(session.auth)
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (chunk: Buffer) => chunks.push(chunk));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(file.headers['content-type']).toBe('image/jpeg');
    expect(file.headers['cache-control']).toContain('immutable');
    expect((file.body as Buffer).equals(jpeg())).toBe(true);

    // The operation changed with it, so sync brings it to the other devices.
    const after = await prisma.transactions.findUniqueOrThrow({
      where: { id: transaction },
    });
    expect(after.updated_at > before.updated_at).toBe(true);
    const changes = await http
      .get('/v1/sync/changes')
      .set(session.auth)
      .expect(200);
    const synced = changes.body.transactions.find(
      (t: { id: string }) => t.id === transaction,
    );
    expect(synced.attachments).toEqual([
      {
        id,
        mimeType: 'image/jpeg',
        sizeBytes: 2052,
        ocrStatus: 'done',
        createdAt: expect.any(String),
      },
    ]);

    // The id belongs to this photo of this operation.
    const other = await expense(session);
    await upload(session, id, other).expect(409);
  });

  it('refuses what is not a photo of the user’s own operation', async () => {
    const session = await user();
    const stranger = await user();
    const transaction = await expense(session);

    const notImage = await upload(
      session,
      randomUUID(),
      transaction,
      Buffer.from('%PDF-1.7 not a photo'),
      'image/jpeg',
    ).expect(422);
    expect(notImage.body.code).toBe('unsupported_file');
    const noFile = await http
      .put(`/v1/attachments/${randomUUID()}`)
      .set(session.auth)
      .field('transactionId', transaction)
      .expect(422);
    expect(noFile.body.code).toBe('file_required');
    const badReceipt = await http
      .put(`/v1/attachments/${randomUUID()}`)
      .set(session.auth)
      .field('transactionId', transaction)
      .field('receipt', '{not json')
      .attach('file', jpeg(), {
        filename: 'r.jpg',
        contentType: 'image/jpeg',
      });
    expect(badReceipt.status).toBe(400);

    // Someone else's operation and photo are not there for this user.
    const theirs = await upload(stranger, randomUUID(), transaction).expect(
      404,
    );
    expect(theirs.body.code).toBe('transaction_not_found');
    const mine = randomUUID();
    await upload(session, mine, transaction).expect(200);
    await http.get(`/v1/attachments/${mine}`).set(stranger.auth).expect(404);
    await http.delete(`/v1/attachments/${mine}`).set(stranger.auth).expect(404);

    // Five photos to an operation at most.
    for (let i = 0; i < 4; i++) {
      await upload(session, randomUUID(), transaction).expect(200);
    }
    const sixth = await upload(session, randomUUID(), transaction).expect(422);
    expect(sixth.body.code).toBe('too_many_attachments');
    const files = await readdir(join(STORAGE, session.userId));
    expect(files.filter((name) => !name.endsWith('.part'))).toHaveLength(5);
  });

  it('removes a photo by the API or the sync queue, file and all', async () => {
    const session = await user();
    const transaction = await expense(session);
    const first = randomUUID();
    const second = randomUUID();
    await upload(session, first, transaction).expect(200);
    await upload(session, second, transaction).expect(200);

    await http.delete(`/v1/attachments/${first}`).set(session.auth).expect(204);
    const pushed = await http
      .post('/v1/sync/push')
      .set(session.auth)
      .send({
        operations: [
          { opId: 'a1', type: 'attachment.delete', id: second },
          // Resent: already gone, still fine.
          { opId: 'a2', type: 'attachment.delete', id: second },
        ],
      })
      .expect(200);
    expect(
      pushed.body.results.map((r: { status: string }) => r.status),
    ).toEqual(['applied', 'applied']);
    expect(
      await prisma.transactionAttachments.count({
        where: { transaction_id: transaction },
      }),
    ).toBe(0);
    expect(await readdir(join(STORAGE, session.userId))).toEqual([]);
    await http.get(`/v1/attachments/${first}`).set(session.auth).expect(404);
  });

  it('adds photos in Lunex Pro, keeps showing them after', async () => {
    const session = await user();
    const transaction = await expense(session);
    const id = randomUUID();
    await upload(session, id, transaction).expect(200);

    await setMonetization(true);
    await prisma.subscriptions.updateMany({
      where: { user_id: session.userId },
      data: { expires_at: new Date('2026-01-01') },
    });
    const refused = await upload(session, randomUUID(), transaction).expect(
      403,
    );
    expect(refused.body).toMatchObject({
      code: 'pro_required',
      feature: 'receipt_scan',
    });
    await http.get(`/v1/attachments/${id}`).set(session.auth).expect(200);
    const read = await http
      .post('/v1/ai/receipt')
      .set(session.auth)
      .attach('file', jpeg(), { filename: 'r.jpg', contentType: 'image/jpeg' })
      .expect(403);
    expect(read.body.feature).toBe('receipt_scan');
  });

  it('deletes the photos with the account', async () => {
    const session = await signUp(http, 'ru');
    const transaction = await expense(session);
    await upload(session, randomUUID(), transaction).expect(200);
    await app.get(UsersService).purgeUser(session.userId);
    await expect(readdir(join(STORAGE, session.userId))).rejects.toThrow();
  });

  it('reads an unsure receipt with Claude and keeps what holds up', async () => {
    const session = await user();
    const today = localDate(new Date(), 'Asia/Tashkent');

    const unavailable = await http
      .post('/v1/ai/receipt')
      .set(session.auth)
      .field('text', 'KORZINKA\nJAMI 86 500,00')
      .attach('file', jpeg(), { filename: 'r.jpg', contentType: 'image/jpeg' })
      .expect(503);
    expect(unavailable.body.code).toBe('ai_unavailable');

    claude.available = true;
    claude.reply = JSON.stringify({ category: null });
    await http
      .post('/v1/ai/receipt')
      .set(session.auth)
      .field('text', 'KORZINKA\nJAMI 86 500,00')
      .attach('file', jpeg(), { filename: 'r.jpg', contentType: 'image/jpeg' })
      .expect(200);
    const request = claude.lastRequest!;
    expect(request.tier).toBe('fast');
    const ref = request.system
      .split('\n')
      .find((line) => line.includes('Супермаркет'))!
      .split(' ')[0];
    const content = request.messages[0].content as {
      type: string;
      source?: { media_type: string; data: string };
      text?: string;
    }[];
    expect(content[0]).toMatchObject({
      type: 'image',
      source: { media_type: 'image/jpeg', data: jpeg().toString('base64') },
    });
    expect(content[1].text).toContain('JAMI 86 500,00');

    claude.reply = `Here: ${JSON.stringify({
      amount: '86 500,00',
      currency: 'uzs',
      date: today,
      merchant: ' OOO "KORZINKA" ',
      category: ref,
      confidence: 0.95,
    })}`;
    const read = await http
      .post('/v1/ai/receipt')
      .set(session.auth)
      .attach('file', jpeg(), { filename: 'r.jpg', contentType: 'image/jpeg' })
      .expect(200);
    expect(read.body).toEqual({
      source: 'ai',
      amount: '86500',
      currency: 'UZS',
      date: today,
      merchant: 'OOO "KORZINKA"',
      categoryId: MARKET,
      confidence: 0.95,
    });

    // A date ahead, a nonsense total: left out.
    claude.reply = JSON.stringify({ amount: -3, date: '2999-01-01' });
    const doubtful = await http
      .post('/v1/ai/receipt')
      .set(session.auth)
      .attach('file', jpeg(), { filename: 'r.jpg', contentType: 'image/jpeg' })
      .expect(200);
    expect(doubtful.body).toMatchObject({ amount: null, date: null });

    const usage = await prisma.aiUsageDaily.findMany({
      where: { user_id: session.userId },
    });
    expect(usage).toEqual([
      expect.objectContaining({ feature: 'receipt', requests: 3 }),
    ]);

    // Claude cannot read HEIC: the app sends JPEG.
    const heic = await http
      .post('/v1/ai/receipt')
      .set(session.auth)
      .attach('file', Buffer.from('0000ftypheic'), {
        filename: 'r.heic',
        contentType: 'image/heic',
      })
      .expect(422);
    expect(heic.body.code).toBe('unsupported_file');
  });
});
