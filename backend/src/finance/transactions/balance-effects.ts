import { Prisma } from '../../generated/prisma/client.js';
import type { TransactionType } from '../../generated/prisma/enums.js';

type Decimal = Prisma.Decimal;

export interface BalanceMovement {
  type: TransactionType;
  account_id: string;
  amount: Decimal;
  transfer_account_id: string | null;
  transfer_amount: Decimal | null;
}

/**
 * How one operation moves account balances: income adds, expense subtracts,
 * a transfer takes `amount` from one account and adds `transfer_amount` to the other.
 */
export function balanceEffects(
  movement: BalanceMovement,
): Map<string, Decimal> {
  const effects = new Map<string, Decimal>();
  const add = (accountId: string, delta: Decimal) =>
    effects.set(
      accountId,
      (effects.get(accountId) ?? new Prisma.Decimal(0)).plus(delta),
    );

  switch (movement.type) {
    case 'income':
      add(movement.account_id, movement.amount);
      break;
    case 'expense':
      add(movement.account_id, movement.amount.negated());
      break;
    case 'transfer':
      add(movement.account_id, movement.amount.negated());
      if (movement.transfer_account_id) {
        add(
          movement.transfer_account_id,
          movement.transfer_amount ?? movement.amount,
        );
      }
      break;
  }
  return effects;
}

/** Net change between two states of an operation (`before` undone, `after` applied); zero deltas dropped. */
export function netEffects(
  before: BalanceMovement | null,
  after: BalanceMovement | null,
): Map<string, Decimal> {
  const net = new Map<string, Decimal>();
  const merge = (effects: Map<string, Decimal>, sign: 1 | -1) => {
    for (const [accountId, delta] of effects) {
      net.set(
        accountId,
        (net.get(accountId) ?? new Prisma.Decimal(0)).plus(delta.times(sign)),
      );
    }
  };
  if (before) merge(balanceEffects(before), -1);
  if (after) merge(balanceEffects(after), 1);
  for (const [accountId, delta] of net) {
    if (delta.isZero()) net.delete(accountId);
  }
  return net;
}
