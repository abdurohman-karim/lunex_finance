import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';

type Decimal = Prisma.Decimal;

/** CBU publishes every rate against the sum, so cross rates go through UZS. */
export const PIVOT_CURRENCY = 'UZS';

/**
 * CBU publishes on working days; a week covers weekends and holidays.
 * An older rate would silently mis-value the operation, so it counts as missing.
 */
export const MAX_RATE_AGE_DAYS = 7;

/**
 * Exchange rates from `exchange_rates`: the latest one on or before the date, at most a week old.
 * Rates are loaded daily from the Central Bank (build plan step «мультивалютность»).
 */
@Injectable()
export class FxService {
  constructor(private readonly prisma: PrismaService) {}

  /** How many `to` one `from` buys on `date`; null when no rate is known. */
  async rate(
    fromId: number,
    toId: number,
    date: Date,
  ): Promise<Decimal | null> {
    if (fromId === toId) {
      return new Prisma.Decimal(1);
    }
    const direct = await this.stored(fromId, toId, date);
    if (direct) return direct;

    const inverse = await this.stored(toId, fromId, date);
    if (inverse) return new Prisma.Decimal(1).dividedBy(inverse);

    const pivot = await this.prisma.currencies.findUnique({
      where: { code: PIVOT_CURRENCY },
    });
    if (!pivot || pivot.id === fromId || pivot.id === toId) {
      return null;
    }
    const [fromPivot, toPivot] = await Promise.all([
      this.rate(fromId, pivot.id, date),
      this.rate(toId, pivot.id, date),
    ]);
    return fromPivot && toPivot ? fromPivot.dividedBy(toPivot) : null;
  }

  private async stored(
    baseId: number,
    quoteId: number,
    date: Date,
  ): Promise<Decimal | null> {
    const row = await this.prisma.exchangeRates.findFirst({
      where: {
        base_currency_id: baseId,
        quote_currency_id: quoteId,
        rate_date: {
          lte: date,
          gte: new Date(date.getTime() - MAX_RATE_AGE_DAYS * 86_400_000),
        },
      },
      orderBy: { rate_date: 'desc' },
    });
    return row?.rate ?? null;
  }
}
