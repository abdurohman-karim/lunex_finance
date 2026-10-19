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
const TRANSPORT = systemCategoryId('expense', 'transport');
const SALARY = systemCategoryId('income', 'salary');

// A rate on a fixed old date, so it never leaks into real lookups; removed in afterAll.
const RATE_DATE = new Date('2001-01-01T00:00:00Z');
const RATE_DAY = '2001-01-02T10:00:00Z';

describe('Transactions (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  const userIds: string[] = [];
  let rateId: bigint | undefined;

  let me: TestSession;
  let cash: string;
  let card: string;
  let dollars: string;

  async function account(
    session: TestSession,
    name: string,
    currency: string,
    initialBalance: string,
  ) {
    const id = randomUUID();
    await http
      .post('/v1/accounts')
      .set(session.auth)
      .send({ id, name, currency, initialBalance })
      .expect(201);
    return id;
  }

  async function balances(...ids: string[]) {
    const res = await http.get('/v1/accounts').set(me.auth).expect(200);
    const byId = new Map(
      res.body.map((a: { id: string; currentBalance: string }) => [
        a.id,
        a.currentBalance,
      ]),
    );
    return ids.map((id) => byId.get(id));
  }

  function add(body: Record<string, unknown>, session = me) {
    return http
      .post('/v1/transactions')
      .set(session.auth)
      .send({
        id: randomUUID(),
        occurredAt: new Date().toISOString(),
        ...body,
      });
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

    me = await signUp(http, 'ru');
    userIds.push(me.userId);
    cash = await account(me, 'Наличные', 'UZS', '1000000');
    card = await account(me, 'Карта', 'UZS', '500000');
    dollars = await account(me, 'Доллары', 'USD', '100');

    const [usd, uzs] = await Promise.all([
      prisma.currencies.findUniqueOrThrow({ where: { code: 'USD' } }),
      prisma.currencies.findUniqueOrThrow({ where: { code: 'UZS' } }),
    ]);
    rateId = (
      await prisma.exchangeRates.create({
        data: {
          base_currency_id: usd.id,
          quote_currency_id: uzs.id,
          rate: 12650,
          rate_date: RATE_DATE,
          source: 'e2e',
        },
      })
    ).id;
  });

  afterAll(async () => {
    try {
      if (rateId !== undefined)
        await prisma.exchangeRates.delete({ where: { id: rateId } });
      const users = app.get(UsersService);
      for (const id of userIds) await users.purgeUser(id);
    } finally {
      await app.close();
    }
  });

  describe('balances', () => {
    it('subtracts an expense and adds income', async () => {
      const spent = await add({
        type: 'expense',
        accountId: cash,
        amount: '25000',
        categoryId: FOOD,
        note: 'Обед',
      }).expect(201);
      expect(spent.body).toMatchObject({
        type: 'expense',
        amount: '25000',
        currency: 'UZS',
        amountBase: '25000',
        baseCurrency: 'UZS',
        fxRate: '1',
        categoryId: FOOD,
        note: 'Обед',
        source: 'quick_add',
      });
      await add({
        type: 'income',
        accountId: cash,
        amount: 8000000,
        categoryId: SALARY,
      }).expect(201);
      expect(await balances(cash)).toEqual(['8975000']);
    });

    it('does not charge twice when the same create is retried', async () => {
      const id = randomUUID();
      const body = {
        id,
        type: 'expense',
        accountId: card,
        amount: '10000',
        occurredAt: new Date().toISOString(),
      };
      await http.post('/v1/transactions').set(me.auth).send(body).expect(201);
      await http.post('/v1/transactions').set(me.auth).send(body).expect(201);
      expect(await balances(card)).toEqual(['490000']);
    });

    it('moves money between accounts with a transfer', async () => {
      const res = await add({
        type: 'transfer',
        accountId: cash,
        transferAccountId: card,
        amount: '100000',
      }).expect(201);
      expect(res.body).toMatchObject({
        transferAccountId: card,
        transferAmount: '100000',
        categoryId: null,
      });
      expect(await balances(cash, card)).toEqual(['8875000', '590000']);
    });

    it('converts transfers between currencies with the stored rate', async () => {
      const res = await add({
        type: 'transfer',
        accountId: dollars,
        transferAccountId: cash,
        amount: '10',
        occurredAt: RATE_DAY,
      }).expect(201);
      expect(res.body).toMatchObject({
        amount: '10.00',
        currency: 'USD',
        transferAmount: '126500',
        transferCurrency: 'UZS',
        amountBase: '126500',
        fxRate: '12650',
      });
      expect(await balances(dollars, cash)).toEqual(['90.00', '9001500']);
    });

    it('asks for a rate when none is known', async () => {
      const missing = await add({
        type: 'expense',
        accountId: dollars,
        amount: '5',
      }).expect(422);
      expect(missing.body).toMatchObject({
        code: 'exchange_rate_unavailable',
        from: 'USD',
        to: 'UZS',
      });

      const withRate = await add({
        type: 'expense',
        accountId: dollars,
        amount: '5',
        fxRate: '12700',
      }).expect(201);
      expect(withRate.body).toMatchObject({
        amountBase: '63500',
        fxRate: '12700',
      });
    });

    it('applies only the difference on edit and follows an account change', async () => {
      const created = await add({
        type: 'expense',
        accountId: card,
        amount: '20000',
        categoryId: TRANSPORT,
      }).expect(201);
      const before = await balances(card, cash);

      await http
        .patch(`/v1/transactions/${created.body.id}`)
        .set(me.auth)
        .send({ amount: '35000' })
        .expect(200);
      expect(await balances(card)).toEqual([String(Number(before[0]) - 15000)]);

      await http
        .patch(`/v1/transactions/${created.body.id}`)
        .set(me.auth)
        .send({ accountId: cash })
        .expect(200);
      // The card gets back the original 20 000 too: it no longer holds the operation at all.
      expect(await balances(card, cash)).toEqual([
        String(Number(before[0]) + 20000),
        String(Number(before[1]) - 35000),
      ]);
    });

    it('turns an expense into income with a fitting category', async () => {
      const created = await add({
        type: 'expense',
        accountId: card,
        amount: '1000',
        categoryId: FOOD,
      }).expect(201);
      const before = Number((await balances(card))[0]);

      const wrong = await http
        .patch(`/v1/transactions/${created.body.id}`)
        .set(me.auth)
        .send({ type: 'income', categoryId: FOOD })
        .expect(400);
      expect(wrong.body.code).toBe('invalid_category');

      const income = await http
        .patch(`/v1/transactions/${created.body.id}`)
        .set(me.auth)
        .send({ type: 'income' })
        .expect(200);
      expect(income.body).toMatchObject({ type: 'income', categoryId: null });
      expect(Number((await balances(card))[0])).toBe(before + 2000);
    });

    it('reverts on delete and re-applies on undo', async () => {
      const created = await add({
        type: 'expense',
        accountId: card,
        amount: '7000',
      }).expect(201);
      const after = Number((await balances(card))[0]);

      await http
        .delete(`/v1/transactions/${created.body.id}`)
        .set(me.auth)
        .expect(204);
      await http
        .delete(`/v1/transactions/${created.body.id}`)
        .set(me.auth)
        .expect(204);
      expect(Number((await balances(card))[0])).toBe(after + 7000);

      const restored = await http
        .post(`/v1/transactions/${created.body.id}/restore`)
        .set(me.auth)
        .expect(200);
      expect(restored.body.deletedAt).toBeNull();
      expect(Number((await balances(card))[0])).toBe(after);
    });
  });

  describe('validation', () => {
    it.each([
      [{ type: 'expense', amount: '12.5' }, 400, 'too_many_decimals'],
      [
        { type: 'expense', amount: '100', categoryId: SALARY },
        400,
        'invalid_category',
      ],
      [{ type: 'transfer', amount: '100' }, 400, 'transfer_account_required'],
      [
        {
          type: 'transfer',
          amount: '100',
          categoryId: FOOD,
          transferAccountId: randomUUID(),
        },
        400,
        'category_not_allowed',
      ],
      [
        { type: 'expense', amount: '100', occurredAt: '2099-01-01T00:00:00Z' },
        400,
        'occurred_in_future',
      ],
      [{ type: 'expense', amount: '0' }, 400, 'validation_failed'],
    ])('refuses %j', async (body, status, code) => {
      const res = await add({ accountId: cash, ...body }).expect(status);
      expect(res.body.code).toBe(code);
    });

    it('refuses the same account on both sides of a transfer', async () => {
      const res = await add({
        type: 'transfer',
        accountId: cash,
        transferAccountId: cash,
        amount: '1',
      }).expect(400);
      expect(res.body.code).toBe('same_account');
    });

    it('accepts no new operations on an archived account', async () => {
      const old = await account(me, 'Старая', 'UZS', '0');
      await http
        .patch(`/v1/accounts/${old}`)
        .set(me.auth)
        .send({ isArchived: true })
        .expect(200);
      const res = await add({
        type: 'expense',
        accountId: old,
        amount: '100',
      }).expect(409);
      expect(res.body.code).toBe('account_archived');
    });

    it("keeps other users' operations and accounts out of reach", async () => {
      const stranger = await signUp(http);
      userIds.push(stranger.userId);
      const mine = await add({
        type: 'expense',
        accountId: cash,
        amount: '100',
      }).expect(201);
      await http
        .get(`/v1/transactions/${mine.body.id}`)
        .set(stranger.auth)
        .expect(404);
      await http
        .patch(`/v1/transactions/${mine.body.id}`)
        .set(stranger.auth)
        .send({ amount: '1' })
        .expect(404);
      const foreign = await add(
        { type: 'expense', accountId: cash, amount: '100' },
        stranger,
      ).expect(400);
      expect(foreign.body.code).toBe('invalid_account');
    });
  });

  describe('history', () => {
    let user: TestSession;
    let wallet: string;
    let coffee: string;

    beforeAll(async () => {
      user = await signUp(http, 'ru');
      userIds.push(user.userId);
      wallet = await account(user, 'Кошелёк', 'UZS', '0');
      coffee = randomUUID();
      await http
        .post('/v1/categories')
        .set(user.auth)
        .send({
          id: coffee,
          type: 'expense',
          name: 'Кофе',
          icon: 'cup.and.saucer',
          color: '#AC8E68',
          parentId: FOOD,
        })
        .expect(201);

      const day = (iso: string) => new Date(iso).toISOString();
      const ops = [
        {
          type: 'income',
          amount: '5000000',
          categoryId: SALARY,
          occurredAt: day('2026-10-01T05:00:00Z'),
        },
        {
          type: 'expense',
          amount: '30000',
          categoryId: FOOD,
          note: 'Плов',
          occurredAt: day('2026-10-01T08:00:00Z'),
        },
        {
          type: 'expense',
          amount: '18000',
          categoryId: coffee,
          merchant: 'Bon!',
          occurredAt: day('2026-10-02T04:00:00Z'),
        },
        {
          type: 'expense',
          amount: '12000',
          categoryId: TRANSPORT,
          note: 'Такси',
          occurredAt: day('2026-10-02T19:30:00Z'),
        },
        {
          type: 'expense',
          amount: '25000',
          categoryId: FOOD,
          occurredAt: day('2026-10-03T09:00:00Z'),
        },
      ];
      for (const op of ops) {
        await add({ accountId: wallet, ...op }, user).expect(201);
      }
    });

    const list = (query: Record<string, string | number>) =>
      http.get('/v1/transactions').query(query).set(user.auth).expect(200);

    it('lists newest first with day totals in the user time zone', async () => {
      const res = await list({});
      expect(res.body.items.map((t: { amount: string }) => t.amount)).toEqual([
        '25000',
        '12000',
        '18000',
        '30000',
        '5000000',
      ]);
      // 19:30 UTC on Oct 2 is 00:30 on Oct 3 in Tashkent.
      expect(res.body.days).toEqual([
        { date: '2026-10-03', income: '0', expense: '37000' },
        { date: '2026-10-02', income: '0', expense: '18000' },
        { date: '2026-10-01', income: '5000000', expense: '30000' },
      ]);
      expect(res.body.nextCursor).toBeNull();
    });

    it('pages with a cursor', async () => {
      const first = await list({ limit: 2 });
      expect(first.body.items).toHaveLength(2);
      const second = await list({ limit: 2, cursor: first.body.nextCursor });
      const third = await list({ limit: 2, cursor: second.body.nextCursor });
      const amounts = [
        ...first.body.items,
        ...second.body.items,
        ...third.body.items,
      ].map((t: { amount: string }) => t.amount);
      expect(amounts).toEqual(['25000', '12000', '18000', '30000', '5000000']);
      expect(third.body.nextCursor).toBeNull();
    });

    it('filters by type, category with subcategories and period', async () => {
      expect((await list({ type: 'income' })).body.items).toHaveLength(1);
      const food = await list({ categoryId: FOOD });
      expect(food.body.items.map((t: { amount: string }) => t.amount)).toEqual([
        '25000',
        '18000',
        '30000',
      ]);
      const period = await list({
        from: '2026-10-02T00:00:00Z',
        to: '2026-10-02T23:59:59Z',
      });
      expect(period.body.items).toHaveLength(2);
    });

    it('searches notes, merchants, category names and amounts', async () => {
      const amounts = async (q: string) =>
        (await list({ q })).body.items.map((t: { amount: string }) => t.amount);
      expect(await amounts('плов')).toEqual(['30000']);
      expect(await amounts('bon')).toEqual(['18000']);
      expect(await amounts('кофе')).toEqual(['18000']);
      expect(await amounts('Транспорт')).toEqual(['12000']);
      expect(await amounts('25 000')).toEqual(['25000']);
    });

    it('suggests the most used categories first', async () => {
      const res = await http
        .get('/v1/transactions/frequent-categories')
        .query({ type: 'expense' })
        .set(user.auth)
        .expect(200);
      expect(res.body.categoryIds[0]).toBe(FOOD);
      expect(res.body.categoryIds).toEqual(
        expect.arrayContaining([coffee, TRANSPORT]),
      );
    });
  });
});
