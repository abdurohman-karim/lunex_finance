// Sentry must initialise before anything else is imported.
// Production runs `node --import ./dist/instrument.js dist/main` so that ESM modules get traced too;
// main.ts also imports this file, and the isInitialized() guard keeps that a no-op.
import * as Sentry from '@sentry/nestjs';

try {
  // Local development keeps SENTRY_DSN in .env; real environments set it directly.
  process.loadEnvFile();
} catch {
  // No .env file: rely on the process environment.
}

const dsn = process.env.SENTRY_DSN;

if (dsn && !Sentry.isInitialized()) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
    // Financial app: amounts, login codes, tokens and AI prompts must never leave the server.
    // The SDK collects most of this by default, so every category is narrowed explicitly.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { allow: ['user-agent', 'x-app-version', 'x-request-id'] },
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      genAI: { inputs: false, outputs: false },
      stackFrameVariables: false,
    },
  });
}
