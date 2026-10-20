import { defineConfig } from 'vitest/config';
import { e2eDatabaseUrl } from './test/support/e2e-database.js';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // A database of the tests' own, created, migrated and seeded before the run.
    globalSetup: ['./test/support/e2e-database.ts'],
    // Files share one database and flip global app_settings, so they run one after another.
    fileParallelism: false,
    // Process env wins over .env, so these fixed test values apply on every machine and in CI.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: e2eDatabaseUrl(),
      LOG_LEVEL: 'silent',
      JWT_ACCESS_SECRET: 'test-access-secret-test-access-secret',
      AUTH_CODE_PEPPER: 'test-code-pepper-test-code-pepper-xx',
      APPLE_CLIENT_IDS: 'uz.lunex.test',
      GOOGLE_CLIENT_IDS: 'google-test-client',
      TELEGRAM_BOT_TOKEN: '123456:test-token',
      PUBLIC_URL: 'https://api.lunex.test',
      EMAIL_PROVIDER: 'console',
      PUSH_PROVIDER: 'log',
      // Jobs of the tests stay away from a development server's workers on the same Redis.
      QUEUE_PREFIX: 'lunex-e2e',
      // No calls to the Central Bank from tests; they hand in rates of their own.
      CBU_RATES_URL: '',
      // Tests read their own writes right away.
      SYNC_LAG_MS: '0',
    },
  },
});
