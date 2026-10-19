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

const FOOD = systemCategoryId('expense', 'food');

describe('Sync (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  const userIds: string[] = [];

  async function newUser() {
    const session = await signUp(http, 'ru');
    userIds.push(session.userId);
    return session;
  }

  const pull = (
    session: TestSession,
    query: Record<string, string | number> = {},
  ) => http.get('/v1/sync/changes').query(query).set(session.auth).expect(200);

  const push = (session: TestSession, operations: unknown[]) =>
    http
      .post('/v1/sync/push')
      .set(session.auth)
      .send({ operations })
      .expect(200);

  /** Pulls until hasMore is false; returns everything received and the final cursor. */
  async function pullAll(session: TestSession, cursor?: string, limit = 500) {
    const received = {
      accounts: [] as any[],
      categories: [] as any[],
      transactions: [] as any[],
      profiles: [] as any[],
    };
    let pages = 0;
    for (;;) {
      const res = await pull(session, cursor ? { cursor, limit } : { limit });
      pages++;
      received.accounts.push(...res.body.accounts);
      received.categories.push(...res.body.categories);
      received.transactions.push(...res.body.transactions);
      if (res.body.profile) received.profiles.push(res.body.profile);
      cursor = res.body.nextCursor;
      if (!res.body.hasMore) return { ...received, cursor: cursor!, pages };
    }
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

  it('gives a new device the profile and every system category on a full sync', async () => {
    const me = await newUser();
    const full = await pullAll(me);
    expect(full.profiles).toHaveLength(1);
    expect(full.profiles[0]).toMatchObject({
      id: me.userId,
      language: 'ru',
      baseCurrency: 'UZS',
    });
    expect(full.categories.filter((c) => c.isSystem)).toHaveLength(19);
    expect(full.accounts).toEqual([]);
    expect(full.transactions).toEqual([]);

    // Nothing changed since: the next pull is empty.
    const again = await pull(me, { cursor: full.cursor });
    expect(again.body).toMatchObject({
      profile: null,
      accounts: [],
      categories: [],
      transactions: [],
      hasMore: false,
    });
  });

  it('applies an offline queue in order and reports each operation', async () => {
    const me = await newUser();
    const { cursor } = await pullAll(me);
    const cash = randomUUID();
    const coffee = randomUUID();
    const lunch = randomUUID();

    const res = await push(me, [
      {
        opId: 'op1',
        type: 'account.create',
        data: {
          id: cash,
          name: 'Наличные',
          currency: 'UZS',
          initialBalance: '100000',
        },
      },
      {
        opId: 'op2',
        type: 'category.create',
        data: {
          id: coffee,
          type: 'expense',
          name: 'Кофе',
          icon: 'cup.and.saucer',
          color: '#AC8E68',
          parentId: FOOD,
        },
      },
      {
        opId: 'op3',
        type: 'transaction.create',
        data: {
          id: lunch,
          type: 'expense',
          accountId: cash,
          amount: '30000',
          categoryId: coffee,
          occurredAt: new Date().toISOString(),
        },
      },
      {
        opId: 'op4',
        type: 'transaction.update',
        id: lunch,
        data: { amount: '35000' },
      },
      {
        opId: 'op5',
        type: 'category.update',
        id: FOOD,
        data: { isArchived: true },
      },
    ]);
    expect(
      res.body.results.map((r: { opId: string; status: string }) => [
        r.opId,
        r.status,
      ]),
    ).toEqual([
      ['op1', 'applied'],
      ['op2', 'applied'],
      ['op3', 'applied'],
      ['op4', 'applied'],
      ['op5', 'applied'],
    ]);
    expect(res.body.results[3].record).toMatchObject({
      id: lunch,
      amount: '35000',
    });

    const changes = await pullAll(me, cursor);
    expect(changes.accounts).toEqual([
      expect.objectContaining({
        id: cash,
        currentBalance: '65000',
        isDefault: true,
      }),
    ]);
    expect(changes.transactions).toEqual([
      expect.objectContaining({ id: lunch, amount: '35000' }),
    ]);
    expect(changes.categories.map((c) => c.id)).toHaveLength(2);
    expect(changes.categories.map((c) => c.id)).toEqual(
      expect.arrayContaining([coffee, FOOD]),
    );
    expect(changes.categories.find((c) => c.id === FOOD)).toMatchObject({
      isArchived: true,
    });
  });

  it('is safe to resend a batch after a lost response', async () => {
    const me = await newUser();
    const cash = randomUUID();
    const batch = [
      {
        opId: 'a',
        type: 'account.create',
        data: {
          id: cash,
          name: 'Cash',
          currency: 'UZS',
          initialBalance: '50000',
        },
      },
      {
        opId: 'b',
        type: 'transaction.create',
        data: {
          id: randomUUID(),
          type: 'expense',
          accountId: cash,
          amount: '10000',
          occurredAt: new Date().toISOString(),
        },
      },
      {
        opId: 'c',
        type: 'transaction.create',
        data: {
          id: randomUUID(),
          type: 'income',
          accountId: cash,
          amount: '5000',
          occurredAt: new Date().toISOString(),
        },
      },
    ];
    await push(me, batch);
    const resent = await push(me, batch);
    expect(
      resent.body.results.every(
        (r: { status: string }) => r.status === 'applied',
      ),
    ).toBe(true);

    const account = await prisma.accounts.findUniqueOrThrow({
      where: { id: cash },
    });
    expect(account.current_balance.toString()).toBe('45000');
  });

  it('rejects bad operations without blocking the rest of the queue', async () => {
    const me = await newUser();
    const cash = randomUUID();
    const res = await push(me, [
      {
        opId: 'ok1',
        type: 'account.create',
        data: { id: cash, name: 'Cash', currency: 'UZS' },
      },
      {
        opId: 'bad-shape',
        type: 'transaction.create',
        data: { id: 'not-a-uuid' },
      },
      {
        opId: 'bad-rule',
        type: 'transaction.create',
        data: {
          id: randomUUID(),
          type: 'expense',
          accountId: cash,
          amount: '100',
          categoryId: systemCategoryId('income', 'salary'),
          occurredAt: new Date().toISOString(),
        },
      },
      { opId: 'unknown', type: 'goal.create', data: {} },
      {
        opId: 'ok2',
        type: 'transaction.create',
        data: {
          id: randomUUID(),
          type: 'expense',
          accountId: cash,
          amount: '100',
          occurredAt: new Date().toISOString(),
        },
      },
    ]);
    expect(
      res.body.results.map(
        (r: { opId: string; status: string; code?: string }) => [
          r.opId,
          r.status,
          r.code,
        ],
      ),
    ).toEqual([
      ['ok1', 'applied', undefined],
      ['bad-shape', 'rejected', 'validation_failed'],
      ['bad-rule', 'rejected', 'invalid_category'],
      ['unknown', 'rejected', 'validation_failed'],
      ['ok2', 'applied', undefined],
    ]);
  });

  it('pages through large changes without gaps or duplicates', async () => {
    const me = await newUser();
    const cash = randomUUID();
    const ids = Array.from({ length: 7 }, () => randomUUID());
    await push(me, [
      {
        opId: 'acc',
        type: 'account.create',
        data: { id: cash, name: 'Cash', currency: 'UZS' },
      },
      ...ids.map((id, i) => ({
        opId: `t${i}`,
        type: 'transaction.create',
        data: {
          id,
          type: 'income',
          accountId: cash,
          amount: String(1000 + i),
          occurredAt: new Date().toISOString(),
        },
      })),
    ]);

    const all = await pullAll(me, undefined, 3);
    expect(all.pages).toBeGreaterThan(2);
    // Exactly the created ids, each once: no gaps and no duplicates across pages.
    expect(all.transactions).toHaveLength(ids.length);
    expect(all.transactions.map((t) => t.id)).toEqual(
      expect.arrayContaining(ids),
    );
  });

  it('sends deletions as tombstones and default-account moves on both accounts', async () => {
    const me = await newUser();
    const first = randomUUID();
    const second = randomUUID();
    const spend = randomUUID();
    await push(me, [
      {
        opId: '1',
        type: 'account.create',
        data: { id: first, name: 'One', currency: 'UZS' },
      },
      {
        opId: '2',
        type: 'account.create',
        data: { id: second, name: 'Two', currency: 'UZS' },
      },
      {
        opId: '3',
        type: 'transaction.create',
        data: {
          id: spend,
          type: 'expense',
          accountId: first,
          amount: '500',
          occurredAt: new Date().toISOString(),
        },
      },
    ]);
    const { cursor } = await pullAll(me);

    await push(me, [
      { opId: '4', type: 'transaction.delete', id: spend },
      {
        opId: '5',
        type: 'account.update',
        id: second,
        data: { isDefault: true },
      },
    ]);
    const changes = await pullAll(me, cursor);
    expect(changes.transactions).toEqual([
      expect.objectContaining({ id: spend, deletedAt: expect.any(String) }),
    ]);
    const byId = Object.fromEntries(
      changes.accounts.map((a) => [a.id, a.isDefault]),
    );
    expect(byId).toEqual({ [first]: false, [second]: true });
  });

  it("never shows another user's changes and records the device sync time", async () => {
    const me = await newUser();
    const stranger = await newUser();
    await push(stranger, [
      {
        opId: 'x',
        type: 'account.create',
        data: { id: randomUUID(), name: 'Secret', currency: 'UZS' },
      },
    ]);
    const mine = await pullAll(me);
    expect(mine.accounts).toEqual([]);
    expect(mine.categories.every((c) => c.isSystem)).toBe(true);

    const device = await prisma.devices.findFirstOrThrow({
      where: { user_id: me.userId },
    });
    expect(device.last_sync_at).not.toBeNull();
  });

  it('refuses a malformed cursor', async () => {
    const me = await newUser();
    const res = await http
      .get('/v1/sync/changes')
      .query({ cursor: 'garbage' })
      .set(me.auth)
      .expect(400);
    expect(res.body.code).toBe('invalid_cursor');
  });
});
