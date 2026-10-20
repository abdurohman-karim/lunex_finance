import { z } from 'zod';

const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);

/** "a, b,,c" -> ["a", "b", "c"]; unset -> [] */
const csvList = z.preprocess(
  (value) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : (value ?? []),
  z.array(z.string()),
);

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    /** Address to listen on; every interface when empty (production: 127.0.0.1, behind nginx) */
    HOST: z.preprocess(emptyToUndefined, z.string().optional()),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),

    SENTRY_DSN: z.preprocess(emptyToUndefined, z.url().optional()),
    SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),

    /** HMAC key for access tokens */
    JWT_ACCESS_SECRET: z.string().min(32),
    /** Mixed into email login code hashes so a database leak does not reveal codes */
    AUTH_CODE_PEPPER: z.string().min(32),

    /** Accepted `aud` of Apple identity tokens: the app bundle id (and a Services ID if the web ever signs in) */
    APPLE_CLIENT_IDS: csvList,
    /** Accepted `aud` of Google ID tokens: the iOS OAuth client id(s) */
    GOOGLE_CLIENT_IDS: csvList,
    /** Token of the login-only Telegram bot; Telegram sign-in is off without it */
    TELEGRAM_BOT_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
    /**
     * Public https origin of this server, e.g. `https://api.lunex.uz`. Telegram redirects back
     * to it after login, so it must be the domain set for the bot in @BotFather.
     */
    PUBLIC_URL: z.preprocess(emptyToUndefined, z.url().optional()),

    /**
     * `console` prints login codes to the log and is refused in production; `off` turns email
     * sign-in off (the app does not offer it) until a mail service is set up.
     */
    EMAIL_PROVIDER: z.enum(['console', 'resend', 'off']).default('console'),
    RESEND_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    /** Sender, e.g. `Lunex Finance <no-reply@your-domain>`; the domain must be verified in Resend */
    EMAIL_FROM: z.preprocess(emptyToUndefined, z.string().optional()),

    /**
     * `apns` sends pushes through Apple; `log` only writes them to the log (no APNs key yet);
     * `simulator` hands them to an iOS simulator with `xcrun simctl push` (a Mac, development).
     */
    PUSH_PROVIDER: z.enum(['apns', 'log', 'simulator']).default('log'),
    /** APNs auth key (Apple Developer → Keys, «Apple Push Notifications service») */
    APNS_KEY_ID: z.preprocess(emptyToUndefined, z.string().optional()),
    APNS_TEAM_ID: z.preprocess(emptyToUndefined, z.string().optional()),
    /** Contents of the .p8 file; line breaks may be written as \n */
    APNS_PRIVATE_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    /** The app's bundle id */
    APNS_TOPIC: z.string().default('uz.lunex.finance'),
    /** TestFlight and App Store builds get production tokens; Xcode debug builds sandbox ones */
    APNS_ENVIRONMENT: z.enum(['production', 'sandbox']).default('production'),
    /** `PUSH_PROVIDER=simulator`: a simulator UDID or `booted` */
    SIMULATOR_DEVICE: z.string().default('booted'),

    /** Redis key prefix of the job queues; tests use their own so a running server ignores them */
    QUEUE_PREFIX: z.string().min(1).default('lunex'),

    /**
     * Proxies in front of the server (production: Caddy, so 1). The client IP for rate limits
     * is then read from X-Forwarded-For; 0 trusts no header.
     */
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),

    /**
     * Sync returns changes only up to now minus this lag, so a write still in flight
     * with an earlier timestamp is never skipped. Longer than any database transaction.
     */
    SYNC_LAG_MS: z.coerce.number().int().min(0).max(60_000).default(5_000),
  })
  .superRefine((env, ctx) => {
    if (env.EMAIL_PROVIDER === 'resend') {
      for (const key of ['RESEND_API_KEY', 'EMAIL_FROM'] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required when EMAIL_PROVIDER=resend`,
          });
        }
      }
    }
    if (env.PUSH_PROVIDER === 'apns') {
      for (const key of [
        'APNS_KEY_ID',
        'APNS_TEAM_ID',
        'APNS_PRIVATE_KEY',
      ] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required when PUSH_PROVIDER=apns`,
          });
        }
      }
    }
    if (env.NODE_ENV === 'production' && env.PUSH_PROVIDER === 'simulator') {
      ctx.addIssue({
        code: 'custom',
        path: ['PUSH_PROVIDER'],
        message: 'PUSH_PROVIDER=simulator is for development on a Mac',
      });
    }
    if (env.NODE_ENV === 'production' && env.EMAIL_PROVIDER === 'console') {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_PROVIDER'],
        message:
          'EMAIL_PROVIDER=console would log login codes; use resend in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Used by ConfigModule: the app refuses to start with a missing or malformed variable. */
export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(
      `Invalid environment variables:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
