import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { CalendarDate } from '../common/dates.js';
import type { Env } from '../config/env.js';
import { Prisma } from '../generated/prisma/client.js';

/** 1 `code` = `rate` sum, in effect from `date`. */
export interface CbuRate {
  code: string;
  rate: string;
  date: CalendarDate;
}

const rowSchema = z.object({
  Ccy: z.string().length(3),
  Nominal: z.string().regex(/^\d+$/),
  Rate: z.string().regex(/^\d+(\.\d+)?$/),
  Date: z.string().regex(/^\d{2}\.\d{2}\.\d{4}$/),
});

/** CBU's JSON: `{ Ccy, Nominal, Rate, Date: "dd.mm.yyyy", … }` per currency; bad rows are skipped. */
export function parseCbuRates(body: unknown): CbuRate[] {
  if (!Array.isArray(body)) throw new Error('CBU answered with no list');
  return body.flatMap((item) => {
    const row = rowSchema.safeParse(item);
    if (!row.success || row.data.Nominal === '0') return [];
    const [day, month, year] = row.data.Date.split('.');
    return [
      {
        code: row.data.Ccy,
        rate: new Prisma.Decimal(row.data.Rate)
          .dividedBy(row.data.Nominal)
          .toDecimalPlaces(10)
          .toFixed(),
        date: `${year}-${month}-${day}`,
      },
    ];
  });
}

/** The Central Bank of Uzbekistan's published rates (https://cbu.uz). */
@Injectable()
export class CbuClient {
  constructor(private readonly config: ConfigService<Env, true>) {}

  get enabled(): boolean {
    return this.config.get('CBU_RATES_URL', { infer: true }) !== '';
  }

  /** Rates in effect on a day (on a day off — the last ones set before it); today's without one. */
  async rates(day?: CalendarDate): Promise<CbuRate[]> {
    const base = this.config.get('CBU_RATES_URL', { infer: true });
    const url = day ? `${base}/all/${day}/` : `${base}/`;
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`CBU answered ${response.status} for ${url}`);
    }
    return parseCbuRates(await response.json());
  }
}
