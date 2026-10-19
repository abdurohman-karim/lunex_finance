import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Files share one database and flip global app_settings, so they run one after another.
    fileParallelism: false,
    // Process env wins over .env, so these fixed test values apply on every machine and in CI.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      JWT_ACCESS_SECRET: 'test-access-secret-test-access-secret',
      AUTH_CODE_PEPPER: 'test-code-pepper-test-code-pepper-xx',
      APPLE_CLIENT_IDS: 'uz.lunex.test',
      GOOGLE_CLIENT_IDS: 'google-test-client',
      TELEGRAM_BOT_TOKEN: '123456:test-token',
      EMAIL_PROVIDER: 'console',
      // Tests read their own writes right away.
      SYNC_LAG_MS: '0',
    },
  },
});
