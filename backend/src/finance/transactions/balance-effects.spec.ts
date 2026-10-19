import { localDate } from '../../common/dates.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  type BalanceMovement,
  balanceEffects,
  netEffects,
} from './balance-effects.js';
import { decodeCursor, encodeCursor } from './cursor.js';

const d = (value: number) => new Prisma.Decimal(value);
const plain = (effects: Map<string, Prisma.Decimal>) =>
  Object.fromEntries([...effects].map(([id, delta]) => [id, delta.toNumber()]));

const expense = (account: string, amount: number): BalanceMovement => ({
  type: 'expense',
  account_id: account,
  amount: d(amount),
  transfer_account_id: null,
  transfer_amount: null,
});

describe('balanceEffects', () => {
  it('adds income and subtracts expenses', () => {
    expect(
      plain(balanceEffects({ ...expense('a', 100), type: 'income' })),
    ).toEqual({ a: 100 });
    expect(plain(balanceEffects(expense('a', 100)))).toEqual({ a: -100 });
  });

  it('moves a transfer between accounts in their own currencies', () => {
    const transfer: BalanceMovement = {
      type: 'transfer',
      account_id: 'usd',
      amount: d(10),
      transfer_account_id: 'uzs',
      transfer_amount: d(126500),
    };
    expect(plain(balanceEffects(transfer))).toEqual({ usd: -10, uzs: 126500 });
  });
});

describe('netEffects', () => {
  it('applies only the difference when an amount changes', () => {
    expect(plain(netEffects(expense('a', 100), expense('a', 130)))).toEqual({
      a: -30,
    });
  });

  it('moves the whole effect when the account changes', () => {
    expect(plain(netEffects(expense('a', 100), expense('b', 100)))).toEqual({
      a: 100,
      b: -100,
    });
  });

  it('flips the sign when an expense becomes income', () => {
    expect(
      plain(
        netEffects(expense('a', 50), { ...expense('a', 50), type: 'income' }),
      ),
    ).toEqual({
      a: 100,
    });
  });

  it('reverts on delete, re-applies on restore, and skips no-op edits', () => {
    expect(plain(netEffects(expense('a', 70), null))).toEqual({ a: 70 });
    expect(plain(netEffects(null, expense('a', 70)))).toEqual({ a: -70 });
    expect(netEffects(expense('a', 70), expense('a', 70)).size).toBe(0);
  });
});

describe('history cursor', () => {
  it('round-trips', () => {
    const cursor = {
      occurredAt: new Date('2026-10-19T08:00:00.000Z'),
      id: 'abc',
    };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('rejects garbage', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow(/malformed/);
  });
});

describe('localDate', () => {
  it('uses the user time zone for the calendar day', () => {
    const lateEveningUtc = new Date('2026-10-19T20:30:00Z');
    expect(localDate(lateEveningUtc, 'UTC')).toBe('2026-10-19');
    expect(localDate(lateEveningUtc, 'Asia/Tashkent')).toBe('2026-10-20');
  });
});
