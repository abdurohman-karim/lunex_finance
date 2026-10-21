import { fileURLToPath } from 'node:url';
import { INestApplication, RequestMethod } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';

export const API_PREFIX = 'v1';

/** The admin panel: static files next to `src` and `dist`, served at /admin. */
export const ADMIN_PANEL_DIR = fileURLToPath(
  new URL('../admin', import.meta.url),
);

/** Shared by main.ts and e2e tests so both serve the same routes. */
export function configureApp(app: INestApplication): void {
  app.use(helmet());
  app.setGlobalPrefix(API_PREFIX, {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });
  (app as NestExpressApplication).useStaticAssets(ADMIN_PANEL_DIR, {
    prefix: '/admin/',
    // Always the panel just deployed.
    setHeaders: (response) => response.setHeader('Cache-Control', 'no-cache'),
  });
  app.enableShutdownHooks();
}
