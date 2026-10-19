import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

/** Money crosses the API as a decimal string ("150000", "12.50"); numbers are accepted from clients. */
export const moneySchema = z
  .union([z.number(), z.string().trim()])
  .transform((value) => (typeof value === 'number' ? String(value) : value))
  .pipe(
    z
      .string()
      .regex(/^-?\d{1,16}(\.\d{1,2})?$/, 'Up to 16 digits and 2 decimals'),
  );

export const positiveMoneySchema = moneySchema.refine(
  (value) => Number(value) > 0,
  'Must be greater than zero',
);

/** Free text where an empty string means "none". */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value));

/** SF Symbol name, e.g. `fork.knife` */
export const sfSymbolSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(\.[a-z0-9]+)*$/, 'An SF Symbol name');

export const hexColorSchema = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, 'A color like #0A84FF')
  .transform((value) => value.toUpperCase());

export const uuidParamSchema = z.uuid();

/** `?updatedSince=` for incremental sync: also returns deleted records as tombstones. */
export const listQuerySchema = z.object({
  updatedSince: z.iso
    .datetime({ offset: true })
    .transform((value) => new Date(value))
    .optional(),
});

export const reorderSchema = z.object({
  ids: z
    .array(z.uuid())
    .min(1)
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, 'ids must be unique'),
});

/** Rejects "12.5" for a currency without minor units (UZS), as the app could not show it. */
export function assertCurrencyPrecision(
  amount: string,
  currency: { code: string; decimals: number },
): void {
  const fraction = amount.split('.')[1]?.replace(/0+$/, '') ?? '';
  if (fraction.length > currency.decimals) {
    throw new BadRequestException({
      code: 'too_many_decimals',
      message: `${currency.code} amounts allow ${currency.decimals} decimal places`,
      currency: currency.code,
    });
  }
}
