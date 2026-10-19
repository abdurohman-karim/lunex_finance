# Lunex Finance — backend

REST API for the Lunex Finance iOS app. NestJS 12 (ESM), Prisma 7 with the `pg` driver adapter, PostgreSQL 18, Redis 8 + BullMQ, Sentry.

The product spec and the database schema live in Coddle (see `../AGENTS.md`). `prisma/schema.prisma` is exported from the Coddle schema; change the schema there first, then here.

## Run locally

```bash
cp .env.example .env
docker compose up -d --wait   # Postgres on :5442, Redis on :6390
npm install                   # also generates Prisma Client
npm run db:deploy             # apply migrations
npm run db:seed               # currencies, system categories, app settings
npm run start:dev
```

- `GET /health` — liveness
- `GET /health/ready` — Postgres and Redis checks
- Everything else is served under `/v1`.

## Checks

```bash
npm run typecheck
npm run lint
npm test            # unit
npm run test:e2e    # needs compose services, migrations and seed
```

## Database

- `npm run db:migrate -- --name <change>` — create a migration from `prisma/schema.prisma` (development).
- `npm run db:deploy` — apply migrations (CI, production).
- `npm run db:seed` — idempotent; updates currencies and system categories, but only inserts missing `app_settings` keys so values changed by an administrator are kept.
- System category ids are UUID v5 of `category:<type>:<key>` (`src/database/reference-data.ts`), identical on every environment and in the iOS app.

## Production

`npm run start:prod` runs `node --import ./dist/instrument.js dist/main` so Sentry instruments ESM modules. Sentry is off unless `SENTRY_DSN` is set; request bodies, cookies, DB query data and AI prompts are never sent.
