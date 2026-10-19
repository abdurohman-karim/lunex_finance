import { validateEnv } from './env.js';

const required = {
  DATABASE_URL: 'postgresql://lunex:lunex@localhost:5442/lunex',
  REDIS_URL: 'redis://localhost:6390',
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

  it('rejects a missing DATABASE_URL', () => {
    expect(() => validateEnv({ REDIS_URL: required.REDIS_URL })).toThrow(
      /DATABASE_URL/,
    );
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
});
