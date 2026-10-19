import { validateEnv } from './env.js';

const required = {
  DATABASE_URL: 'postgresql://lunex:lunex@localhost:5442/lunex',
  REDIS_URL: 'redis://localhost:6390',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  AUTH_CODE_PEPPER: 'b'.repeat(32),
};

describe('validateEnv', () => {
  it('applies defaults when only required variables are set', () => {
    expect(validateEnv(required)).toEqual({
      ...required,
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      SENTRY_DSN: undefined,
      SENTRY_TRACES_SAMPLE_RATE: 0,
      APPLE_CLIENT_IDS: [],
      GOOGLE_CLIENT_IDS: [],
      TELEGRAM_BOT_TOKEN: undefined,
      EMAIL_PROVIDER: 'console',
      RESEND_API_KEY: undefined,
      EMAIL_FROM: undefined,
    });
  });

  it('coerces numbers from strings', () => {
    const env = validateEnv({
      ...required,
      PORT: '8080',
      SENTRY_TRACES_SAMPLE_RATE: '0.2',
    });
    expect(env.PORT).toBe(8080);
    expect(env.SENTRY_TRACES_SAMPLE_RATE).toBe(0.2);
  });

  it('treats an empty SENTRY_DSN as not set', () => {
    expect(
      validateEnv({ ...required, SENTRY_DSN: '' }).SENTRY_DSN,
    ).toBeUndefined();
  });

  it('splits comma-separated client ids', () => {
    const env = validateEnv({
      ...required,
      APPLE_CLIENT_IDS: 'uz.lunex.app, uz.lunex.web ,',
    });
    expect(env.APPLE_CLIENT_IDS).toEqual(['uz.lunex.app', 'uz.lunex.web']);
  });

  it('rejects a missing DATABASE_URL', () => {
    const { DATABASE_URL: _, ...rest } = required;
    expect(() => validateEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-Postgres DATABASE_URL', () => {
    expect(() =>
      validateEnv({ ...required, DATABASE_URL: 'mysql://localhost/lunex' }),
    ).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-Redis REDIS_URL', () => {
    expect(() =>
      validateEnv({ ...required, REDIS_URL: 'http://localhost:6379' }),
    ).toThrow(/REDIS_URL/);
  });

  it('rejects short auth secrets', () => {
    expect(() =>
      validateEnv({ ...required, JWT_ACCESS_SECRET: 'short' }),
    ).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('requires an API key and sender for the resend provider', () => {
    expect(() =>
      validateEnv({ ...required, EMAIL_PROVIDER: 'resend' }),
    ).toThrow(/RESEND_API_KEY[\s\S]*EMAIL_FROM/);
  });

  it('refuses the console mailer in production', () => {
    expect(() => validateEnv({ ...required, NODE_ENV: 'production' })).toThrow(
      /EMAIL_PROVIDER/,
    );
  });
});
