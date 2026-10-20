export const NOTIFICATIONS_QUEUE = 'notifications';

export const NotificationJob = {
  /** One notification, right after it is created: `{ id }` */
  Deliver: 'deliver',
  /** The user's spending changed: limits crossed since the last check, `{ userId }` */
  BudgetCheck: 'budget-check',
  /** Every 5 minutes: evening reminders, payments ahead, goal deadlines, then what is due */
  Tick: 'tick',
} as const;

/** Expenses saved together (a sync of many operations) are checked once. */
export const BUDGET_CHECK_DELAY_MS = 3_000;
