# Lunex Finance — backend

REST API for the Lunex Finance iOS app. NestJS 12 (ESM), Prisma 7 with the `pg` driver adapter, PostgreSQL 18, Redis 8 + BullMQ, Sentry.

The product spec and the database schema live in Coddle (see `../AGENTS.md`). `prisma/schema.prisma` is exported from the Coddle schema; change the schema there first, then here.

## Run locally

```bash
cp .env.example .env          # then fill JWT_ACCESS_SECRET and AUTH_CODE_PEPPER (openssl rand -base64 48)
docker compose up -d --wait   # Postgres on :5442, Redis on :6390
npm install                   # also generates Prisma Client
npm run db:deploy             # apply migrations
npm run db:seed               # currencies, system categories, app settings
npm run start:dev
```

- `GET /health` — liveness
- `GET /health/ready` — Postgres and Redis checks
- Everything else is served under `/v1` and needs `Authorization: Bearer <access token>`, except `/v1/auth/*`.

With `EMAIL_PROVIDER=console` the email login code is printed to the server log.

## Auth

| Endpoint | |
| --- | --- |
| `POST /v1/auth/apple` | `{ identityToken, nonce, displayName?, device, language? }` — `nonce` is the raw value; the token must carry its SHA-256 |
| `POST /v1/auth/google` | `{ idToken, device, language? }` |
| `POST /v1/auth/telegram` | `{ authData, device, language? }` — the Telegram Login payload, checked against `TELEGRAM_BOT_TOKEN` |
| `POST /v1/auth/email/start` | `{ email, language? }` → 202; 6-digit code, 10 min, resend after 60 s, 10 per day |
| `POST /v1/auth/email/verify` | `{ email, code, device, language? }`; 5 wrong attempts lock the code |
| `POST /v1/auth/refresh` | `{ refreshToken }` → new pair; a reused token revokes every session of that device |
| `POST /v1/auth/logout` | `{ refreshToken }` |
| `GET /v1/me` | profile |
| `POST /v1/me/identities` | link a sign-in method: `{ provider, ...credential }` |
| `DELETE /v1/me/identities/:provider` | unlink (never the last one) |
| `DELETE /v1/me/sessions` | sign out on all devices |
| `DELETE /v1/me` | delete the account; signing in within 30 days restores it, then a daily job purges it |

- `device` is `{ id, model?, osVersion?, appVersion? }`; `id` is a UUID the app keeps in the Keychain.
- Sign-in responses: `{ user, isNewUser, accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt }`. Access tokens live 15 minutes, refresh tokens 60 days.
- A new account gets user settings and a 30-day Lunex Pro trial (`app_settings.trial_days`).
- A sign-in whose provider returns a **verified** email that already belongs to an account is linked to that account.
- Errors carry a stable `code` (`invalid_code`, `refresh_token_reused`, `identity_in_use`, `last_identity`, `rate_limited`, …) for the app to localise.

## Lunex Pro

`GET /v1/me/access` returns the plan, its source (`monetization_off`, `trial`, `app_store`, `promo`, or `null` on Free), the trial, the Pro features and the limits. The app calls it on launch and on return from background.

- While `app_settings.monetization_enabled` is `false` everyone has Pro and nothing is locked; the trial is still recorded from sign-up.
- Once it is `true`, Pro needs a subscription that is `active` or in `grace_period` and not expired; otherwise the Free limits apply (`free_max_accounts`, `free_max_goals`, `ai_daily_limit_free`, two months of analytics).
- Settings are cached for 10 seconds per instance, so a change reaches every instance within that time.
- In feature code: `@RequiresPro('auto_save')` on a route (403 `pro_required`), and `entitlements.assertCanCreate(userId, 'accounts' | 'active_goals')` before creating or re-activating a capped record (403 `free_limit_reached`). Archived accounts and paused goals do not count; records above the cap stay readable.
- An hourly maintenance job marks ended subscriptions `expired`.

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
