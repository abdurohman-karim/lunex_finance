import { Injectable, Logger } from '@nestjs/common';
import {
  addDays,
  asDbDate,
  type CalendarDate,
  localDate,
} from '../common/dates.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { ChangesPage, SyncPosition } from '../sync/sync-window.js';
import { CbuClient, type CbuRate } from './cbu.client.js';
import { PIVOT_CURRENCY } from './fx-math.js';

/** Days back the loader fills in when a day is missing (a server that was down, a new install). */
export const BACKFILL_DAYS = 10;
/** What a first sync sends: operations older than this are already converted by the server. */
export const SYNC_RATE_DAYS = 40;

/** A rate as the app keeps it: 1 `base` = `rate` `quote` from `date`. */
export interface ExchangeRateDto {
  base: string;
  quote: string;
  rate: string;
  date: CalendarDate;
}

/** Loads the Central Bank's daily rates into `exchange_rates` and hands them to the app. */
@Injectable()
export class FxRatesService {
  private readonly logger = new Logger(FxRatesService.name);
  /** Days off ask for a rate set before them; each is asked once per run of the server. */
  private readonly asked = new Set<CalendarDate>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly cbu: CbuClient,
  ) {}

  /** Today's rates and any of the last days still missing; a rate CBU corrected is updated. */
  async refresh(now = new Date()): Promise<{ stored: number; days: number }> {
    if (!this.cbu.enabled) return { stored: 0, days: 0 };
    const today = localDate(now, 'Asia/Tashkent');
    let stored = await this.store(await this.cbu.rates());
    let days = 1;

    const known = new Set(
      (
        await this.prisma.exchangeRates.findMany({
          where: {
            rate_date: { gte: asDbDate(addDays(today, -BACKFILL_DAYS)) },
          },
          select: { rate_date: true },
          distinct: ['rate_date'],
        })
      ).map((row) => row.rate_date.toISOString().slice(0, 10)),
    );
    for (let back = 1; back <= BACKFILL_DAYS; back++) {
      const day = addDays(today, -back);
      if (known.has(day) || this.asked.has(day)) continue;
      this.asked.add(day);
      stored += await this.store(await this.cbu.rates(day));
      days++;
    }
    if (stored > 0) this.logger.log(`Stored ${stored} exchange rates`);
    return { stored, days };
  }

  /** New and corrected rates since the app's position; a first sync gets the last weeks'. */
  async changes(
    after: SyncPosition | null,
    horizon: Date,
    now = new Date(),
  ): Promise<ChangesPage<ExchangeRateDto>> {
    const rows = await this.prisma.exchangeRates.findMany({
      where: {
        updated_at: {
          lte: horizon,
          ...(after ? { gt: after.updatedAt } : {}),
        },
        ...(after
          ? {}
          : {
              rate_date: {
                gte: asDbDate(addDays(localDate(now, 'UTC'), -SYNC_RATE_DAYS)),
              },
            }),
      },
      include: {
        baseCurrency: { select: { code: true } },
        quoteCurrency: { select: { code: true } },
      },
      orderBy: [{ updated_at: 'asc' }, { id: 'asc' }],
    });
    const last = rows.at(-1);
    return {
      items: rows.map((row) => ({
        base: row.baseCurrency.code,
        quote: row.quoteCurrency.code,
        rate: row.rate.toString(),
        date: row.rate_date.toISOString().slice(0, 10),
      })),
      last: last ? { updatedAt: last.updated_at, id: String(last.id) } : null,
    };
  }

  /** Rates of the currencies the app has, against the sum; unchanged ones are left alone. */
  private async store(rates: CbuRate[]): Promise<number> {
    const currencies = await this.prisma.currencies.findMany({
      select: { id: true, code: true },
    });
    const ids = new Map(currencies.map((c) => [c.code, c.id]));
    const pivot = ids.get(PIVOT_CURRENCY);
    if (pivot === undefined) return 0;
    let stored = 0;
    for (const rate of rates) {
      const base = ids.get(rate.code);
      if (base === undefined || base === pivot) continue;
      // Timestamps from here, in UTC like Prisma's, whatever the database's time zone.
      const now = new Date();
      stored += await this.prisma.$executeRaw`
        INSERT INTO exchange_rates
          (base_currency_id, quote_currency_id, rate, rate_date, source, created_at, updated_at)
        VALUES (${base}, ${pivot}, ${new Prisma.Decimal(rate.rate)},
          ${asDbDate(rate.date)}::date, 'cbu', ${now}, ${now})
        ON CONFLICT (base_currency_id, quote_currency_id, rate_date)
        DO UPDATE SET rate = EXCLUDED.rate, updated_at = EXCLUDED.updated_at
        WHERE exchange_rates.rate <> EXCLUDED.rate`;
    }
    return stored;
  }
}
