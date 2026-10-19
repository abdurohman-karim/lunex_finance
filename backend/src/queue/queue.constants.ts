export const MAINTENANCE_QUEUE = 'maintenance';

export const MaintenanceJob = {
  PurgeExpiredEmailCodes: 'purge-expired-email-codes',
} as const;

/** Expired email login codes are kept this long for auditing attempts, then deleted. */
export const EMAIL_CODE_RETENTION_MS = 24 * 60 * 60 * 1000;
