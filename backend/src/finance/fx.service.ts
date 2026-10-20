import { Injectable } from '@nestjs/common';
import { addDays, asDbDate, type CalendarDate } from '../common/dates.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { MAX_RATE_AGE_DAYS, PIVOT_CURRENCY, rateOn } from './fx-math.js';

type Decimal = Prisma.Decimal;

export { MAX_RATE_AGE_DAYS, PIVOT_CURRENCY } from './fx-math.js';

/**
 * Exchange rates from `exchange_rates` (the Central Bank's, loaded by FxRatesService): the
 * latest one on or before the date, at most a week old (`rateOn`).
 */
@Injectable()
export class FxService {
  private currencies?: Promise<Map<number, string>>;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * How many `to` one `from` buys on a day; null when no rate is known. An instant counts
   * by its UTC date, as the app does.
   */
  async rate(
    fromId: number,
    toId: number,
    date: Date | CalendarDate,
  ): Promise<Decimal | null> {
    if (fromId === toId) return new Prisma.Decimal(1);
    const day =
      typeof date === 'string' ? date : date.toISOString().slice(0, 10);
    const codes = await this.codes();
    const from = codes.get(fromId);
    const to = codes.get(toId);
    if (!from || !to) return null;
    const pivot = [...codes].find(([, code]) => code === PIVOT_CURRENCY)?.[0];
    const ids = [fromId, toId, ...(pivot === undefined ? [] : [pivot])];
    const rows = await this.prisma.exchangeRates.findMany({
      where: {
        base_currency_id: { in: ids },
        quote_currency_id: { in: ids },
        rate_date: {
          gte: asDbDate(addDays(day, -MAX_RATE_AGE_DAYS)),
          lte: asDbDate(day),
        },
      },
      select: {
        base_currency_id: true,
        quote_currency_id: true,
        rate: true,
        rate_date: true,
      },
    });
    return rateOn(
      rows.map((row) => ({
        base: codes.get(row.base_currency_id)!,
        quote: codes.get(row.quote_currency_id)!,
        rate: row.rate,
        date: row.rate_date.toISOString().slice(0, 10),
      })),
      from,
      to,
      day,
    );
  }

  private codes(): Promise<Map<number, string>> {
    this.currencies ??= this.prisma.currencies
      .findMany({ select: { id: true, code: true } })
      .then((rows) => new Map(rows.map((row) => [row.id, row.code])));
    return this.currencies;
  }
}
