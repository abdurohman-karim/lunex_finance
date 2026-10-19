import { INestApplication, RequestMethod } from '@nestjs/common';
import helmet from 'helmet';

export const API_PREFIX = 'v1';

/** Shared by main.ts and e2e tests so both serve the same routes. */
export function configureApp(app: INestApplication): void {
  app.use(helmet());
  app.setGlobalPrefix(API_PREFIX, {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });
  app.enableShutdownHooks();
}
