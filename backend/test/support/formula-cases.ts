import { readFileSync } from 'node:fs';
import { Prisma } from '../../src/generated/prisma/client.js';

/**
 * Examples in `shared/formula-cases/` at the repository root. The iOS app's repository
 * (lunex_app) keeps the same files at the same path for `FormulaCasesTests.swift`: both
 * sides must give the same figures, so a change here goes there too.
 */
const directory = new URL('../../../shared/formula-cases/', import.meta.url);

export function formulaCases<T>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`${name}.json`, directory), 'utf8'),
  ) as T;
}

/** Money in the files is a string, so no float rounding gets in the way. */
export type Money = string;

export function money(value: Money): Prisma.Decimal;
export function money(value: Money | null): Prisma.Decimal | null;
export function money(value: Money | null): Prisma.Decimal | null {
  return value === null ? null : new Prisma.Decimal(value);
}

/** `253846`, `33.33`, `-400000`: a sum written the same way however it was computed. */
export function plain(value: Prisma.Decimal | Money): string {
  return new Prisma.Decimal(value).toFixed();
}
