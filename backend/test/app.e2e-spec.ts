import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { MaintenanceProcessor } from '../src/queue/maintenance.processor.js';
import { EMAIL_CODE_RETENTION_MS } from '../src/queue/queue.constants.js';

// Needs the services from compose.yaml: `docker compose up -d` and `npm run db:deploy`.
describe('Lunex backend (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health answers without touching dependencies', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200, { status: 'ok' });
  });

  it('GET /health/ready reports Postgres and Redis up', async () => {
    const res = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.info).toMatchObject({
      database: { status: 'up' },
      redis: { status: 'up' },
    });
  });

  it('serves the API under /v1 only', async () => {
    await request(app.getHttpServer()).get('/v1/health').expect(404);
  });

  it('sets security headers', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('purges email login codes past the retention window only', async () => {
    const prisma = app.get(PrismaService);
    const now = new Date();
    const email = `e2e-${randomUUID()}@lunex.test`;
    const old = await prisma.emailVerifications.create({
      data: {
        email,
        code_hash: 'x',
        expires_at: new Date(now.getTime() - EMAIL_CODE_RETENTION_MS - 60_000),
      },
    });
    const fresh = await prisma.emailVerifications.create({
      data: {
        email,
        code_hash: 'x',
        expires_at: new Date(now.getTime() - 60_000),
      },
    });

    try {
      await app.get(MaintenanceProcessor).purgeExpiredEmailCodes(now);

      const left = await prisma.emailVerifications.findMany({
        where: { email },
      });
      expect(left.map((v) => v.id)).toEqual([fresh.id]);
      expect(left.map((v) => v.id)).not.toContain(old.id);
    } finally {
      await prisma.emailVerifications.deleteMany({ where: { email } });
    }
  });

  it('has the reference data seeded', async () => {
    const prisma = app.get(PrismaService);
    const [currencies, systemCategories, settings] = await Promise.all([
      prisma.currencies.count(),
      prisma.categories.count({ where: { user_id: null } }),
      prisma.appSettings.findUnique({ where: { key: 'monetization_enabled' } }),
    ]);
    expect(currencies).toBeGreaterThanOrEqual(5);
    expect(systemCategories).toBeGreaterThanOrEqual(19);
    expect(settings?.value).toBe(false);
  });
});
