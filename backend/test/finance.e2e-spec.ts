import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { AppSettingsService } from '../src/common/app-settings.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { systemCategoryId } from '../src/database/reference-data.js';
import { UsersService } from '../src/users/users.service.js';
import {
  resetRateLimits,
  signUp,
  type TestSession,
} from './support/session.js';

describe('Accounts and categories (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  let originalMonetization: unknown;
  const userIds: string[] = [];

  async function newUser(language: 'uz' | 'ru' | 'en' = 'ru') {
    const session = await signUp(http, language);
    userIds.push(session.userId);
    return session;
  }

  async function setMonetization(enabled: boolean) {
    await prisma.appSettings.update({
      where: { key: 'monetization_enabled' },
      data: { value: enabled },
    });
    app.get(AppSettingsService).invalidate();
  }

  /** A bare expense row, enough to make an account or category "used". */
  async function addTransaction(
    userId: string,
    accountId: string,
    categoryId?: string,
  ) {
    const account = await prisma.accounts.findUniqueOrThrow({
      where: { id: accountId },
    });
    await prisma.transactions.create({
      data: {
        id: randomUUID(),
        user_id: userId,
        account_id: accountId,
        type: 'expense',
        amount: 25000,
        amount_base: 25000,
        currency_id: account.currency_id,
        category_id: categoryId,
        occurred_at: new Date(),
      },
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
    originalMonetization = (
      await prisma.appSettings.findUniqueOrThrow({
        where: { key: 'monetization_enabled' },
      })
    ).value;
    await setMonetization(false);
  });

  afterAll(async () => {
    try {
      await setMonetization(originalMonetization as boolean);
      const users = app.get(UsersService);
      for (const id of userIds) await users.purgeUser(id);
    } finally {
      await app.close();
    }
  });

  describe('accounts', () => {
    let me: TestSession;
    const cashId = randomUUID();

    beforeAll(async () => {
      me = await newUser();
    });

    it('creates the first account as the default one', async () => {
      const res = await http
        .post('/v1/accounts')
        .set(me.auth)
        .send({
          id: cashId,
          name: 'Наличные',
          currency: 'uzs',
          initialBalance: 1500000,
          icon: 'banknote',
          color: '#30d158',
        })
        .expect(201);
      expect(res.body).toMatchObject({
        id: cashId,
        name: 'Наличные',
        type: 'cash',
        currency: 'UZS',
        initialBalance: '1500000',
        currentBalance: '1500000',
        color: '#30D158',
        isDefault: true,
        isArchived: false,
        sortOrder: 0,
      });
    });

    it('treats a repeated create with the same id as the same account', async () => {
      await http
        .post('/v1/accounts')
        .set(me.auth)
        .send({ id: cashId, name: 'Другое имя', currency: 'UZS' })
        .expect(201);
      const list = await http.get('/v1/accounts').set(me.auth).expect(200);
      expect(list.body.map((a: { id: string }) => a.id)).toEqual([cashId]);
      expect(list.body[0].name).toBe('Наличные');
    });

    it('validates currency and precision', async () => {
      const tiyin = await http
        .post('/v1/accounts')
        .set(me.auth)
        .send({
          id: randomUUID(),
          name: 'X',
          currency: 'UZS',
          initialBalance: '10.5',
        })
        .expect(400);
      expect(tiyin.body.code).toBe('too_many_decimals');

      const unknown = await http
        .post('/v1/accounts')
        .set(me.auth)
        .send({ id: randomUUID(), name: 'X', currency: 'XYZ' })
        .expect(400);
      expect(unknown.body.code).toBe('currency_not_supported');
    });

    it('shifts the current balance when the opening balance changes', async () => {
      await addTransaction(me.userId, cashId);
      // Simulate the 25 000 expense already applied to the cached balance.
      await prisma.accounts.update({
        where: { id: cashId },
        data: { current_balance: 1475000 },
      });

      const res = await http
        .patch(`/v1/accounts/${cashId}`)
        .set(me.auth)
        .send({ initialBalance: '2000000' })
        .expect(200);
      expect(res.body).toMatchObject({
        initialBalance: '2000000',
        currentBalance: '1975000',
      });
    });

    it('locks the currency and refuses deletion once the account has operations', async () => {
      const currency = await http
        .patch(`/v1/accounts/${cashId}`)
        .set(me.auth)
        .send({ currency: 'USD' })
        .expect(409);
      expect(currency.body.code).toBe('currency_locked');

      const del = await http
        .delete(`/v1/accounts/${cashId}`)
        .set(me.auth)
        .expect(409);
      expect(del.body.code).toBe('account_in_use');
    });

    it('applies Free limits once monetization is on and the trial is over', async () => {
      const user = await newUser();
      const create = (name: string, id = randomUUID()) =>
        http
          .post('/v1/accounts')
          .set(user.auth)
          .send({ id, name, currency: 'USD', initialBalance: '12.50' });

      const first = (await create('Card').expect(201)).body;
      await create('Savings').expect(201);

      await setMonetization(true);
      await prisma.subscriptions.updateMany({
        where: { user_id: user.userId },
        data: { expires_at: new Date(Date.now() - 60_000) },
      });
      try {
        const third = await create('Third').expect(403);
        expect(third.body).toMatchObject({
          code: 'free_limit_reached',
          resource: 'accounts',
          limit: 2,
        });

        // Archiving frees a slot, and the default moves to the next account.
        const archived = await http
          .patch(`/v1/accounts/${first.id}`)
          .set(user.auth)
          .send({ isArchived: true })
          .expect(200);
        expect(archived.body.isDefault).toBe(false);
        await create('Third').expect(201);

        const list = await http.get('/v1/accounts').set(user.auth).expect(200);
        expect(
          list.body.find((a: { name: string }) => a.name === 'Savings')
            .isDefault,
        ).toBe(true);

        // Bringing the archived one back would make three active accounts.
        const back = await http
          .patch(`/v1/accounts/${first.id}`)
          .set(user.auth)
          .send({ isArchived: false })
          .expect(403);
        expect(back.body.code).toBe('free_limit_reached');
      } finally {
        await setMonetization(false);
      }
    });

    it('reorders, deletes unused accounts and reports tombstones to sync', async () => {
      const user = await newUser();
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      for (const [i, id] of ids.entries()) {
        await http
          .post('/v1/accounts')
          .set(user.auth)
          .send({ id, name: `A${i}`, currency: 'UZS' })
          .expect(201);
      }
      const since = new Date().toISOString();

      const reordered = await http
        .put('/v1/accounts/order')
        .set(user.auth)
        .send({ ids: [ids[2], ids[0], ids[1]] })
        .expect(200);
      expect(reordered.body.map((a: { id: string }) => a.id)).toEqual([
        ids[2],
        ids[0],
        ids[1],
      ]);

      await http
        .put('/v1/accounts/order')
        .set(user.auth)
        .send({ ids: [randomUUID()] })
        .expect(400);

      await http.delete(`/v1/accounts/${ids[1]}`).set(user.auth).expect(204);
      const list = await http.get('/v1/accounts').set(user.auth).expect(200);
      expect(list.body.map((a: { id: string }) => a.id)).not.toContain(ids[1]);

      const changes = await http
        .get('/v1/accounts')
        .query({ updatedSince: since })
        .set(user.auth)
        .expect(200);
      const tombstone = changes.body.find(
        (a: { id: string }) => a.id === ids[1],
      );
      expect(tombstone.deletedAt).not.toBeNull();
    });

    it("hides other users' accounts", async () => {
      const stranger = await newUser();
      await http
        .patch(`/v1/accounts/${cashId}`)
        .set(stranger.auth)
        .send({ name: 'Mine' })
        .expect(404);
      const reuse = await http
        .post('/v1/accounts')
        .set(stranger.auth)
        .send({ id: cashId, name: 'Mine', currency: 'UZS' })
        .expect(409);
      expect(reuse.body.code).toBe('id_conflict');
    });
  });

  describe('categories', () => {
    const food = systemCategoryId('expense', 'food');
    const salary = systemCategoryId('income', 'salary');

    it('lists system categories in the user language with all translations', async () => {
      const user = await newUser('ru');
      const res = await http
        .get('/v1/categories')
        .query({ type: 'expense' })
        .set(user.auth)
        .expect(200);
      expect(res.body).toHaveLength(12);
      expect(res.body[0]).toMatchObject({
        id: food,
        key: 'food',
        name: 'Еда',
        translations: { uz: 'Oziq-ovqat', ru: 'Еда', en: 'Food' },
        icon: 'fork.knife',
        isSystem: true,
        isArchived: false,
      });
    });

    it('creates own subcategories one level deep', async () => {
      const user = await newUser();
      const coffeeId = randomUUID();
      const created = await http
        .post('/v1/categories')
        .set(user.auth)
        .send({
          id: coffeeId,
          type: 'expense',
          name: 'Кофе',
          icon: 'cup.and.saucer',
          color: '#ac8e68',
          parentId: food,
        })
        .expect(201);
      expect(created.body).toMatchObject({
        name: 'Кофе',
        parentId: food,
        isSystem: false,
        key: null,
        color: '#AC8E68',
      });

      const duplicate = await http
        .post('/v1/categories')
        .set(user.auth)
        .send({
          id: randomUUID(),
          type: 'expense',
          name: 'кофе',
          icon: 'cup.and.saucer',
          color: '#AC8E68',
          parentId: food,
        })
        .expect(409);
      expect(duplicate.body.code).toBe('category_name_taken');

      const tooDeep = await http
        .post('/v1/categories')
        .set(user.auth)
        .send({
          id: randomUUID(),
          type: 'expense',
          name: 'Латте',
          icon: 'cup.and.saucer',
          color: '#AC8E68',
          parentId: coffeeId,
        })
        .expect(400);
      expect(tooDeep.body.code).toBe('invalid_parent');

      const wrongType = await http
        .post('/v1/categories')
        .set(user.auth)
        .send({
          id: randomUUID(),
          type: 'expense',
          name: 'Бонус',
          icon: 'gift',
          color: '#AC8E68',
          parentId: salary,
        })
        .expect(400);
      expect(wrongType.body.code).toBe('invalid_parent');
    });

    it('lets users archive and reorder system categories only for themselves', async () => {
      const user = await newUser();
      const other = await newUser();
      const transport = systemCategoryId('expense', 'transport');

      const rename = await http
        .patch(`/v1/categories/${food}`)
        .set(user.auth)
        .send({ name: 'Пища' })
        .expect(403);
      expect(rename.body.code).toBe('system_category_readonly');

      const archived = await http
        .patch(`/v1/categories/${food}`)
        .set(user.auth)
        .send({ isArchived: true })
        .expect(200);
      expect(archived.body.isArchived).toBe(true);

      await http
        .put('/v1/categories/order')
        .set(user.auth)
        .send({ ids: [transport, food] })
        .expect(200);
      const mine = await http
        .get('/v1/categories')
        .query({ type: 'expense' })
        .set(user.auth)
        .expect(200);
      expect(mine.body.slice(0, 2).map((c: { id: string }) => c.id)).toEqual([
        transport,
        food,
      ]);

      const theirs = await http
        .get('/v1/categories')
        .query({ type: 'expense' })
        .set(other.auth)
        .expect(200);
      expect(theirs.body[0]).toMatchObject({ id: food, isArchived: false });
    });

    it('reports preference changes to sync', async () => {
      const user = await newUser();
      const since = new Date().toISOString();
      await http
        .patch(`/v1/categories/${food}`)
        .set(user.auth)
        .send({ isArchived: true })
        .expect(200);
      const changes = await http
        .get('/v1/categories')
        .query({ updatedSince: since })
        .set(user.auth)
        .expect(200);
      expect(changes.body.map((c: { id: string }) => c.id)).toEqual([food]);
    });

    it('deletes unused own categories and protects used or system ones', async () => {
      const user = await newUser();
      const parentId = randomUUID();
      const childId = randomUUID();
      const usedId = randomUUID();
      const make = (id: string, name: string, parent?: string) =>
        http
          .post('/v1/categories')
          .set(user.auth)
          .send({
            id,
            type: 'expense',
            name,
            icon: 'tag',
            color: '#FF9F0A',
            parentId: parent,
          })
          .expect(201);
      await make(parentId, 'Хобби');
      await make(childId, 'Книги', parentId);
      await make(usedId, 'Спорт');

      const accountId = randomUUID();
      await http
        .post('/v1/accounts')
        .set(user.auth)
        .send({ id: accountId, name: 'Cash', currency: 'UZS' })
        .expect(201);
      await addTransaction(user.userId, accountId, usedId);

      expect(
        (
          await http
            .delete(`/v1/categories/${parentId}`)
            .set(user.auth)
            .expect(409)
        ).body.code,
      ).toBe('category_has_children');
      expect(
        (
          await http
            .delete(`/v1/categories/${usedId}`)
            .set(user.auth)
            .expect(409)
        ).body.code,
      ).toBe('category_in_use');
      expect(
        (await http.delete(`/v1/categories/${food}`).set(user.auth).expect(403))
          .body.code,
      ).toBe('system_category_readonly');

      await http.delete(`/v1/categories/${childId}`).set(user.auth).expect(204);
      await http
        .delete(`/v1/categories/${parentId}`)
        .set(user.auth)
        .expect(204);
      const list = await http
        .get('/v1/categories')
        .query({ type: 'expense' })
        .set(user.auth)
        .expect(200);
      expect(list.body.map((c: { id: string }) => c.id)).not.toContain(
        parentId,
      );
    });
  });
});
