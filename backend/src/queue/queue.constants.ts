export const MAINTENANCE_QUEUE = 'maintenance';

export const MaintenanceJob = {
  PurgeExpiredEmailCodes: 'purge-expired-email-codes',
  PurgeDeletedAccounts: 'purge-deleted-accounts',
  ExpireSubscriptions: 'expire-subscriptions',
  /** Hourly: morning suggestions for users at 08:00 local time, and expiry of unanswered ones */
  SmartSaveHourly: 'smart-save-hourly',
  /** Hourly: operations of recurring payments that create themselves, up to each user's today */
  RecurringHourly: 'recurring-hourly',
} as const;

/** Expired email login codes are kept this long for auditing attempts, then deleted. */
export const EMAIL_CODE_RETENTION_MS = 24 * 60 * 60 * 1000;
