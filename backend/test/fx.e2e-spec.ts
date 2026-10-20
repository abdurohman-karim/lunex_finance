import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { addDays, type CalendarDate, localDate } from '../src/common/dates.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { CbuClient, type CbuRate } from '../src/finance/cbu.client.js';
import {
  BACKFILL_DAYS,
  FxRatesService,
} from '../src/finance/fx-rates.service.js';
import { UsersService } from '../src/users/users.service.js';
import { resetRateLimits, signUp } from './support/session.js';

const NOW = new Date();
const TODAY = localDate(NOW, 'Asia/Tashkent');

/** The Central Bank, as the tests want it: a dollar and a euro a day, GBP unknown to the app. */
class FakeCbu {
  enabled = true;
  usdToday = '12044.72';
  /** Days asked for; 'today' for the current rates */
  asked: string[] = [];

  async rates(day?: CalendarDate): Promise<CbuRate[]> {
    this.asked.push(day ?? 'today');
    if (!day) {
      return [
        { code: 'USD', rate: this.usdToday, date: TODAY },
        { code: 'EUR', rate: '13525.02', date: TODAY },
        { code: 'GBP', rate: '15800', date: TODAY },
      ];
    }
    return [
      { code: 'USD', rate: '12000', date: day },
      { code: 'EUR', rate: '13500', date: day },
    ];
  }
}

describe('Exchange rates (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  let rates: FxRatesService;
  const cbu = new FakeCbu();
  const userIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CbuClient)
      .useValue(cbu)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    http = request(app.getHttpServer());
    prisma = app.get(PrismaService);
    rates = app.get(FxRatesService);
    await resetRateLimits(app);
    await prisma.exchangeRates.deleteMany({ where: { source: 'cbu' } });
  });

  afterAll(async () => {
    try {
      // Other files count on a day without rates.
      await prisma.exchangeRates.deleteMany({ where: { source: 'cbu' } });
      const users = app.get(UsersService);
      for (const id of userIds) await users.purgeUser(id);
    } finally {
      await app.close();
    }
  });

  it('loads the day and fills in the missed days once; a corrected rate is updated', async () => {
    expect(await rates.refresh(NOW)).toEqual({
      stored: 2 + 2 * BACKFILL_DAYS,
      days: 1 + BACKFILL_DAYS,
    });
    expect(cbu.asked).toEqual([
      'today',
      ...Array.from({ length: BACKFILL_DAYS }, (_, i) =>
        addDays(TODAY, -i - 1),
      ),
    ]);

    // The next run asks only for today, and stores nothing unchanged.
    expect(await rates.refresh(NOW)).toEqual({ stored: 0, days: 1 });

    cbu.usdToday = '12050.00';
    expect(await rates.refresh(NOW)).toEqual({ stored: 1, days: 1 });
    const usd = await prisma.exchangeRates.findFirstOrThrow({
      where: { baseCurrency: { code: 'USD' }, rate_date: new Date(TODAY) },
    });
    expect(usd.rate.toString()).toBe('12050');
  });

  it('hands the app the last weeks of rates, then only new and corrected ones', async () => {
    const session = await signUp(http, 'ru');
    userIds.push(session.userId);
    const full = await http
      .get('/v1/sync/changes')
      .set(session.auth)
      .expect(200);
    expect(full.body.exchangeRates).toHaveLength(2 + 2 * BACKFILL_DAYS);
    expect(full.body.exchangeRates).toContainEqual({
      base: 'USD',
      quote: 'UZS',
      rate: '12050',
      date: TODAY,
    });

    const quiet = await http
      .get('/v1/sync/changes')
      .query({ cursor: full.body.nextCursor })
      .set(session.auth)
      .expect(200);
    expect(quiet.body.exchangeRates).toEqual([]);

    cbu.usdToday = '12061.30';
    await rates.refresh(NOW);
    const corrected = await http
      .get('/v1/sync/changes')
      .query({ cursor: quiet.body.nextCursor })
      .set(session.auth)
      .expect(200);
    expect(corrected.body.exchangeRates).toEqual([
      { base: 'USD', quote: 'UZS', rate: '12061.3', date: TODAY },
    ]);
  });

  it('values operations and transfers by the loaded rates', async () => {
    const session = await signUp(http, 'ru');
    userIds.push(session.userId);
    const account = async (currency: string) => {
      const id = randomUUID();
      await http
        .post('/v1/accounts')
        .set(session.auth)
        .send({ id, name: currency, currency, initialBalance: '1000' })
        .expect(201);
      return id;
    };
    const dollars = await account('USD');
    const euros = await account('EUR');

    const spent = await http
      .post('/v1/transactions')
      .set(session.auth)
      .send({
        id: randomUUID(),
        type: 'expense',
        accountId: dollars,
        amount: '10',
        occurredAt: NOW.toISOString(),
      })
      .expect(201);
    expect(spent.body).toMatchObject({
      amountBase: '120613',
      fxRate: '12061.3',
    });

    // Dollars to euros go through the sum: 100 × 12 061,30 ÷ 13 525,02.
    const moved = await http
      .post('/v1/transactions')
      .set(session.auth)
      .send({
        id: randomUUID(),
        type: 'transfer',
        accountId: dollars,
        transferAccountId: euros,
        amount: '100',
        occurredAt: NOW.toISOString(),
      })
      .expect(201);
    expect(moved.body).toMatchObject({
      transferAmount: '89.18',
      transferCurrency: 'EUR',
    });
  });
});
