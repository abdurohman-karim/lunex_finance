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

    /** `console` prints login codes to the log and is refused in production */
    EMAIL_PROVIDER: z.enum(['console', 'resend']).default('console'),
    RESEND_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    /** Sender, e.g. `Lunex Finance <no-reply@your-domain>`; the domain must be verified in Resend */
    EMAIL_FROM: z.preprocess(emptyToUndefined, z.string().optional()),
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
