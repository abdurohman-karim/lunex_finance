# Lunex Finance — backend

REST API for the Lunex Finance iOS app, which lives in its own repository, [lunex_app](https://github.com/abdurohman-karim/lunex_app). Production: `https://api.lunex.my/v1` (see `../deploy/`). NestJS 12 (ESM), Prisma 7 with the `pg` driver adapter, PostgreSQL 18, Redis 8 + BullMQ, Sentry.

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
| `GET /v1/auth/providers` | `{ apple, google, telegram, email }` — which sign-in methods this server has configured |
| `POST /v1/auth/apple` | `{ identityToken, nonce, displayName?, device, language? }` — `nonce` is the raw value; the token must carry its SHA-256 |
| `POST /v1/auth/google` | `{ idToken, device, language? }` |
| `POST /v1/auth/telegram` | `{ authData, device, language? }` — the Telegram Login payload, checked against `TELEGRAM_BOT_TOKEN` |
| `GET /v1/auth/telegram/start` | the app opens it in `ASWebAuthenticationSession`: redirects to Telegram's login page, which returns to `/v1/auth/telegram/callback`; that page hands `#tgAuthResult=…` to `lunex://auth/telegram`. Needs `TELEGRAM_BOT_TOKEN` and `PUBLIC_URL` (the bot's domain in @BotFather) |
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

## Onboarding, profile and settings

| Endpoint | |
| --- | --- |
| `POST /v1/me/onboarding` | `{ cashAccountId, language?, baseCurrency?, timezone?, focus?, monthlyIncomeEstimate?, firstGoal? }` → `{ profile, account, goal, checklist }`; every step optional, safe to repeat |
| `GET /v1/me/checklist` | «Первые шаги»: `firstTransaction`, `firstGoal`, `budget`, `completed` (the widget item is tracked by the app) |
| `PATCH /v1/me` | `displayName`, `language`, `baseCurrency`, `timezone` (IANA), `monthlyIncomeEstimate`, `onboardingFocus` |
| `GET` / `PATCH /v1/me/settings` | lock and `lockAfterSeconds`, `hideAmounts`, `weekStartsOn`, `monthStartsOnDay`, `defaultAccountId`, reminder time, quiet hours (`HH:MM`), notification toggles, haptics |
| `PUT /v1/me/devices/current` | `{ apnsToken?, pushEnabled?, model?, osVersion?, appVersion? }` for the calling device |

- Onboarding creates the cash account («Naqd pul» / «Наличные» / «Cash» in the base currency) unless accounts already came from another device, then the first goal, then marks onboarding done.
- Changing the base currency re-values every operation's `amountBase` at the rate of its date, the income estimate and current budgets at today's rate — all or nothing: a missing rate answers 422 `exchange_rate_unavailable` and nothing changes.
- An APNs token moves with a reinstall: another device that had it stops getting pushes.
- Profile and settings sync too: streams `profile` and `settings`, operations `profile.update` and `settings.update`.

## Lunex Pro

`GET /v1/me/access` returns the plan, its source (`monetization_off`, `trial`, `app_store`, `promo`, or `null` on Free), the trial, the Pro features and the limits. The app calls it on launch and on return from background.

- While `app_settings.monetization_enabled` is `false` everyone has Pro and nothing is locked; the trial is still recorded from sign-up.
- Once it is `true`, Pro needs a subscription that is `active` or in `grace_period` and not expired; otherwise the Free limits apply (`free_max_accounts`, `free_max_goals`, `ai_daily_limit_free`, two months of analytics).
- Settings are cached for 10 seconds per instance, so a change reaches every instance within that time.
- In feature code: `@RequiresPro('auto_save')` on a route (403 `pro_required`), and `entitlements.assertCanCreate(userId, 'accounts' | 'active_goals')` before creating or re-activating a capped record (403 `free_limit_reached`). Archived accounts and paused goals do not count; records above the cap stay readable.
- An hourly maintenance job marks ended subscriptions `expired`.

## Accounts and categories

Shared conventions: ids are UUIDs generated by the app, so `POST` with an id that already exists returns that record (safe offline retries); money is a decimal string (`"150000"`, `"12.50"`) and must fit the currency's precision (`too_many_decimals`); `GET …?updatedSince=<ISO>` returns changed records including deleted ones (`deletedAt`) for sync; `PUT …/order { ids }` stores drag-and-drop order.

| Endpoint | |
| --- | --- |
| `GET /v1/accounts` | active accounts with `currentBalance` and `isDefault` |
| `POST /v1/accounts` | `{ id, name, type?, currency, initialBalance?, icon?, color?, includeInTotal? }`; Free limit `accounts` |
| `PATCH /v1/accounts/:id` | any field, `isArchived`, `isDefault: true`; un-archiving checks the Free limit |
| `DELETE /v1/accounts/:id` | only when nothing refers to it (`account_in_use`), otherwise archive |
| `GET /v1/categories?type=` | system + own categories, `name` in the user's language, `translations` for system ones |
| `POST /v1/categories` | `{ id, type, name, icon, color, parentId? }` — subcategories are one level deep and of the parent's type |
| `PATCH /v1/categories/:id` | own: `name`, `icon`, `color`, `parentId`, `isArchived`; system: only `isArchived` |
| `DELETE /v1/categories/:id` | own and unused only (`category_in_use`, `category_has_children`) |

- The first account becomes the default (preselected in quick add); archiving or deleting it moves the default to the next account.
- An account's currency is locked once it has operations (`currency_locked`); changing `initialBalance` shifts `currentBalance` by the same amount.
- System categories are shared rows; each user's order and archiving of them live in `category_preferences`.

## Exchange rates

- The Central Bank of Uzbekistan's rates (`CBU_RATES_URL`, JSON) load into `exchange_rates` against the sum at 00:10, 09:10 and 15:10 Tashkent and once when the server starts; a run also fills in any of the last 10 days still missing (a day off gets the last working day's rate). A rate CBU corrects is updated, unchanged ones are left alone. An empty `CBU_RATES_URL` turns loading off.
- A rate for a day is the latest on or before it, at most 7 days old: direct, inverse, or through the sum (`rateOn`, checked on `shared/formula-cases/fx.json`, which the app shares). An operation counts by the UTC date of `occurredAt`.
- Sync sends the app the last 40 days of rates on a full pull and new or corrected ones after (`exchangeRates`: `{ base, quote, rate, date }`), so it converts on the device, offline too.

## Transactions

| Endpoint | |
| --- | --- |
| `GET /v1/transactions` | history, newest first: `type`, `accountId` (both sides of transfers), `categoryId` (with subcategories), `from`, `to`, `q` (note, merchant, category name or exact amount like `25 000`), `cursor`, `limit` → `{ items, nextCursor, days }` |
| `GET /v1/transactions/frequent-categories?type=expense` | category ids for the quick-add grid: most used in 90 days, then most recent |
| `GET /v1/transactions/:id` | one operation, deleted ones included |
| `POST /v1/transactions` | `{ id, type, accountId, amount, categoryId?, transferAccountId?, transferAmount?, fxRate?, note?, merchant?, occurredAt, source? }` |
| `PATCH /v1/transactions/:id` | any field; changing `type` clears fields that no longer fit |
| `DELETE /v1/transactions/:id` | soft delete, balances restored |
| `POST /v1/transactions/:id/restore` | undo of a delete |

- Every write moves `accounts.current_balance` in the same database transaction, with a row lock on the operation: income adds, expense subtracts, a transfer moves `amount` out and `transferAmount` in. Edits apply only the difference.
- A repeated `POST` with the same id returns the first result and never charges twice.
- `amountBase` is the amount in the user's base currency at the rate of the operation date: direct, inverse or through UZS, at most 7 days old. Without such a rate the API answers 422 `exchange_rate_unavailable` and the app may pass `fxRate` (or `transferAmount` for transfers).
- `days` gives income and expense per calendar day (user time zone, base currency) for every day in the page, computed over the whole day with the same filters. Transfers are not counted.
- Archived accounts accept no new operations; operations already on them stay editable.

## Budget

`GET /v1/budget/current` — the current budget month in the base currency: period, income (actual, planned, basis), expenses (before today, today), savings, rollover, upcoming recurring payments, `available`, `dailyLimit`, `safeToSpendToday`, `state` (`ok`, `overspent`, `no_income`), spending by category and `incomplete` when a foreign amount had no rate.

- The month starts on `user_settings.month_starts_on_day` (payday; 29–31 move to the last day of short months) and days are counted in the user's time zone.
- `available` = max(planned, actual income) + rollover − max(savings target, saved to goals) − expenses before today − recurring expenses still due this month.
- `dailyLimit` = `available` ÷ days left including today, the smaller one when a total limit is set, never below zero, rounded down to the currency's precision. `safeToSpendToday` = `dailyLimit` − today's expenses.
- Without a budget for the month (`mode: auto`) the planned income is the onboarding estimate (`users.monthly_income_estimate`). The math is a pure function (`src/budget/budget-math.ts`), shared with Smart Save later.

## Goals

| Endpoint | |
| --- | --- |
| `GET /v1/goals/templates` | phone, car, home, travel, education, emergency fund, wedding, gadget — emoji, color, localised name |
| `GET /v1/goals?status=` | by priority, with `progress`, `remaining`, `milestones` and `schedule` (`perDay/perWeek/perMonth`, `status`: `on_track`, `behind`, `ahead`) |
| `POST /v1/goals` | `{ id, title, templateKey?, emoji?, color?, targetAmount, currency?, deadline?, linkedAccountId? }`; Free limit `active_goals` |
| `PATCH /v1/goals/:id` | fields, `status` (`active`, `paused`, `completed`, `archived`), `isPrimary: true` |
| `PUT /v1/goals/order` | drag-and-drop priority |
| `DELETE /v1/goals/:id` | empty goals only (`goal_has_money`) |
| `POST /v1/goals/:id/contributions` | `{ id, type: deposit\|withdrawal, amount, accountId?, accountAmount?, note? }` → `{ goal, contribution, newMilestones, completed }` |
| `DELETE /v1/goals/:id/contributions/:cid` | undo |
| `GET /v1/goals/:id/contributions` | history, newest first, cursor paging |

- Money moves with each contribution, in one database transaction under a goal row lock: a deposit takes it from `accountId` and puts it into the goal's savings account (`linkedAccountId`, same currency as the goal) or into the goal itself; a withdrawal does the reverse. Money already in the savings account is only earmarked. An account in another currency pays `accountAmount`, given or converted at today's rate.
- `newMilestones` (25/50/75/100) are recorded once per goal for the celebration. Reaching the target completes the goal: deposits stop (`goal_completed`), withdrawals still work. Undoing a deposit that brings the goal below its target makes it active again.
- One primary goal: the first goal, or the one marked `isPrimary`; when it is completed, archived or deleted, the next live goal by priority takes over.
- Creating, resuming or reopening a goal checks the Free limit of active goals; paused goals do not count.
- Goals and contributions sync through `/v1/sync` (streams `goals`, `goalContributions`; operations `goal.create|update|delete|reorder`, `goal.contribute`, `goal.contribution.delete` with `goalId`).

## Auto-save

Rules (Lunex Pro) that move money into a goal by themselves, from a source account; amounts are in that account's currency and converted into the goal's at the day's rate.

| Endpoint | |
| --- | --- |
| `GET /v1/auto-save?goalId=` | the rules |
| `POST /v1/auto-save` | `{ id, goalId, sourceAccountId, type, … }`: `fixed_schedule` with `amount`, `frequency` (daily, weekly, monthly), `weekday` 1–7 / `dayOfMonth`; `percent_of_income` with `percent`; `round_up` with `roundTo` |
| `PATCH /v1/auto-save/:id` | the type's own fields, `sourceAccountId`, `isActive` (resuming needs Pro) |
| `DELETE /v1/auto-save/:id` | contributions it made stay |

- `fixed_schedule` runs from 09:00 local on its day (queue `auto-save`, hourly `run-due`); days missed while the server was down do not pile up.
- `percent_of_income` sets aside its share of every income to the source account, `round_up` the change of rounding every expense from it up to the step (47 000 to 5 000 → 3 000), right after the operation is saved (`operation` job).
- A contribution never goes past the goal's target; with too little money on the account it is skipped and `auto_save_skipped` is pushed. A reached, archived or deleted goal, or a gone account, stops the rule. Contribution ids come from the rule and the day or operation, so nothing is set aside twice.
- Each run that saves pushes a quiet `auto_save_done` (no sound, passive), once a day per rule; both are outside the daily limit and follow «Этапы и сроки целей». Rules sync as `autoSaveRules` and change through `autoSave.create|update|delete`.

## AI usage and limits

Every call to Claude goes through `AiService.ask(userId, feature, request)` (`src/ai`): Pro features first, then one of the day's requests, then the model (`claude-sonnet-5-5` for the assistant and reports, `claude-haiku-5-5` for parsing input and receipts; `ANTHROPIC_API_KEY`, `CLAUDE_MODEL_SMART|FAST`), then its tokens.

| Endpoint | |
| --- | --- |
| `GET /v1/ai/usage` | `{ available, date, resetsAt, features: [{ feature, used, limit, remaining }] }` for `assistant`, `parse_input`, `receipt`, `insight` |

- `ai_usage_daily` holds requests and input/output tokens per user, day (the user's time zone, reset at their midnight) and feature; cached input counts as input.
- Limits a day: the assistant `ai_daily_limit_free` (5) / `ai_daily_limit_pro` (50) by plan; voice/text parsing `ai_daily_limit_parse` (100) and receipts `ai_daily_limit_receipt` (30) as fair-use caps, both Lunex Pro (`voice_input`, `receipt_scan`); insights the server makes itself, none. Administrators change them in `app_settings`.
- A request takes its place before the model is called, in one statement (`INSERT … ON CONFLICT … WHERE requests < limit`), so parallel requests cannot pass the limit; a full day answers 429 `ai_limit_reached` with `limit` and `resetsAt`. A failed call gives its place back: 502 `ai_failed` (the model did not answer after the SDK's retries) or 503 `ai_unavailable` (no key).

## Insights

The server works the numbers out; Claude puts them into words in the user's language (`InsightWriter`, counted as the `insight` feature). Without `ANTHROPIC_API_KEY`, or when the answer is not the JSON asked for, a template says the same from the same facts (`source: "template"`), so an insight never waits on the AI.

| Endpoint | |
| --- | --- |
| `GET /v1/insights?before=&limit=` | the feed, newest first: `{ items, unread, nextBefore }` |
| `GET /v1/insights/tip` | today's tip, made on the first request (free) |
| `GET /v1/insights/:id` | one insight |
| `POST /v1/insights/:id/read`, `POST /v1/insights/read` | mark one or all read |
| `POST /v1/insights/goals/:id` | goal analysis (Pro `goal_analysis`): conclusion, next step, `score` 0–100 |

- An insight is `{ kind, title, summary, recommendation, score, payload, goalId, transactionId, periodStart, periodEnd, language, source, readAt }`; `payload` holds the figures and chart data (reports: income, expense, the period before, top categories with their change, spending per day).
- Lunex Pro (`ai_reports`), from the hourly `insights` job at the user's own hour: the weekly report on Sunday at 19:00 (the seven days to that day against the seven before, push `weekly_report`), last budget month's report on payday at 10:00 (push `weekly_report`, the same switch), and the budget forecast at 12:00 once 7 days of the month are gone and 3 are left — spending at the month's pace plus recurring payments due against the total limit, else the income basis less the savings target; once per month and verdict, pushed (`insight`) only when it heads over.
- Anomalies (Pro): a new expense over three medians of its category's expenses in the 90 days before (at least 3 of them), checked by the `expense` job right after it is saved; pushed once (`insight`), and it leaves the feed if the expense is deleted.
- The tip picks what matters today: no income yet, today over the limit, the primary goal behind schedule, a category over 35 % of the month's spending, the goal ahead, or simply what is safe to spend.
- Goal score: with a deadline, savings against the steady pace (on pace 85, a fifth ahead or more 100, behind in proportion); without one, 30 + 0.4 × progress + 10 per month with a deposit of the last three; reached is 100. Asked again the same day with the same figures, the same analysis comes back.
- Every insight has an id derived from what it is about (`uuidV5`), so jobs and retries make it once.

## Smart Save

| Endpoint | |
| --- | --- |
| `GET /v1/smart-save/today` | `{ status, suggestion, explanation }`; `status`: `available`, `already_saved`, `declined`, `no_goal`, `no_spare_money`, `too_small`, `insufficient_balance`, `exchange_rate_unavailable` |
| `POST /v1/smart-save/:id/accept` | `{ amount? }` — only lower than suggested → `{ suggestion, goal, contribution, newMilestones, completed }` |
| `POST /v1/smart-save/:id/decline` | «Не сегодня» |

- Amount = `smart_save_share` (50 %) × (income − expenses − recurring payments still due − already saved to goals this month) ÷ days left, converted to the goal currency and rounded down to its `rounding_step`; capped by what the goal still needs and by the default account's balance; below `min_smart_save` it is `too_small` unless it exactly finishes the goal. The goal is the primary active one, else the first by priority.
- `explanation` carries every input (income, expenses, free money, per day, share, rate, caps) for the «почему такая сумма» card.
- One suggestion a day per user, valid until local midnight. Accepting recalculates: a lower safe amount answers 409 `amount_changed` with `actual` and the refreshed suggestion, nothing is moved; a different goal answers `suggestion_changed`. Accepting twice returns the same result (the contribution id is derived from the suggestion).
- The hourly `smart-save-hourly` job prepares suggestions for users at 08:00 local time, pushes each with «Отложить» and «Не сегодня», and expires unanswered ones.

## Notifications

Pushes go through APNs to every device of the user with a token (`PUT /v1/me/devices/current { apnsToken, pushEnabled }`). Each event is a row in `notifications`, stored once by `dedupe_key`, then delivered by the rules:

| Kind | When | Opens |
| --- | --- | --- |
| `daily_reminder` | within an hour after `daily_reminder_time`, only if the day has no operations | quick add |
| `budget_threshold`, `budget_exceeded` | an expense crosses a category's `alert_threshold_pct` (default 80 %) or 100 %, or the total limit's 80 % / 100 %; once each per budget month | budget |
| `goal_milestone` | a deposit reaches 25 / 50 / 75 / 100 % (the highest one, once each) | the goal |
| `goal_deadline` | 7 days before a deadline, from 09:00, if not reached | the goal |
| `recurring_due` | a reminder-mode payment `remind_days_before` its run, from 09:00, once a run; category `RECURRING_DUE` («Записать») | payments |
| `smart_save` | the 08:00 suggestion; category `SMART_SAVE` («Отложить», «Не сегодня») | Smart Save |

- At sending: the kind must be on in the settings and the push still relevant (e.g. the payment not recorded yet); in quiet hours (`quiet_hours_start`–`end`, 22:00–08:00 by default) it waits for their end unless it would be stale by then; at most 3 a day — the evening reminder and payment reminders the user set up are not counted, and the evening reminder comes at its time even inside quiet hours. A skipped push keeps its `skip_reason`.
- Texts are in the user's language; the payload carries `lunex: { id, type, link, … }` with a `lunex://` link and what the actions need.
- A session that ends (logout, «Выйти на всех устройствах», another account signing in on the device, account deletion) clears the device's token.
- Queue `notifications`: `deliver` right after an event, `budget-check` a few seconds after expenses change (once for a burst), and `tick` every 5 minutes (reminders, payments, deadlines, then whatever is due — deferred or retried).
- `PUSH_PROVIDER`: `apns` (HTTP/2 with a provider token from the `.p8` key; `APNS_ENVIRONMENT=sandbox` for Xcode builds), `log`, or `simulator` for development — the local server hands pushes to an iOS simulator with `xcrun simctl push`.

| Endpoint | |
| --- | --- |
| `GET /v1/notifications?before=&limit=` | the notification center: `{ items: [{ id, type, title, body, link, data, createdAt, openedAt }], unread, nextBefore }` — sent pushes and those kept back by the limit, quiet hours or no device |
| `POST /v1/notifications/:id/opened` | a push or a row tapped |
| `POST /v1/notifications/opened` | the center was looked at |

## Sync

The app works offline against its local store and talks to two endpoints.

**`GET /v1/sync/changes?cursor=&limit=`** — everything that changed since `cursor` (none = full sync): `{ profile, accounts, categories, transactions, goals, goalContributions, recurringRules, autoSaveRules, exchangeRates, settings, nextCursor, hasMore, serverTime }`. Repeat with `nextCursor` while `hasMore`, then keep the cursor for next time. Records are complete and the app upserts them by id; deleted ones carry `deletedAt`.

- Streams (profile, accounts, categories, per-user category settings, transactions) page independently by `(updated_at, id)` inside one opaque cursor, up to `limit` records each.
- Changes are returned only up to `now − SYNC_LAG_MS` (5 s), so a write still committing with an earlier timestamp is never skipped. Server clocks must be NTP-synced.
- A finished pull stores `devices.last_sync_at`.

**`POST /v1/sync/push`** `{ operations: [...] }` — the offline queue, up to 100 operations applied in order through the same services as the REST API (limits, balances, validation are identical):

`account.create|update|delete|reorder`, `category.create|update|delete|reorder`, `transaction.create|update|delete|restore`, each `{ opId, type, id?, data? }` with `data` shaped like the matching REST body.

- Response `{ results: [{ opId, status: 'applied', record } | { opId, status: 'rejected', code, message, details? }] }`. A rejected operation (validation or a business rule such as `free_limit_reached`) is final — drop it from the queue and tell the user; it never blocks later operations.
- A 5xx or 429 fails the whole request; resend the same batch later. Every operation is idempotent (ids come from the app), so replays change nothing.
- Conflicts resolve as last write wins, in the order the server receives writes.

## Checks

```bash
npm run typecheck
npm run lint
npm test            # unit
npm run test:e2e    # needs compose services; uses its own database lunex_e2e (created, migrated and seeded first)
```

## Database

- `npm run db:migrate -- --name <change>` — create a migration from `prisma/schema.prisma` and regenerate Prisma Client (Prisma 7 `migrate dev` no longer does it).
- `npm run db:deploy` — apply migrations (CI, production).
- `npm run db:seed` — idempotent; updates currencies and system categories, but only inserts missing `app_settings` keys so values changed by an administrator are kept.
- System category ids are UUID v5 of `category:<type>:<key>` (`src/database/reference-data.ts`), identical on every environment and in the iOS app.

## Production

`npm run start:prod` runs `node --import ./dist/instrument.js dist/main` so Sentry instruments ESM modules. Sentry is off unless `SENTRY_DSN` is set; request bodies, cookies, DB query data and AI prompts are never sent.

## Deploy

Production runs at `https://api.lunex.my` on 79.132.143.211, a shared server managed by HestiaCP. All its projects use one PostgreSQL and one Redis, both on `127.0.0.1`: the API has the database `lunex_db` (role `lunex_db`, no one else may connect) and Redis database 10. The API runs in Docker in `/home/lunex/app` on the host network and listens on `127.0.0.1:3100` only; Hestia's nginx owns ports 80/443 and proxies `api.lunex.my` to it with a Let's Encrypt certificate it renews itself (template `deploy/hestia/lunex-api.*`). `lunex.my` is a Hestia site of the `lunex` user (`/home/lunex/web/lunex.my/public_html`).

From the repository root:

```bash
deploy/deploy.sh
```

It copies `backend/` and `deploy/` over SSH (key `~/.ssh/lunex_deploy`), runs `deploy/setup.sh` on the server — `.env` with fresh secrets, the database and its role, the Hestia domain and certificate, each only when missing — then rebuilds the image, restarts and waits for `https://api.lunex.my/health/ready`. The image (`Dockerfile`) applies migrations and the reference data on start, both safe to repeat: the seed never overwrites a value an administrator changed.

Settings live in `/home/lunex/app/.env` on the server (template `deploy/.env.example`): sign-in methods (`APPLE_CLIENT_IDS=uz.lunex.finance`; Google and Telegram are off until their settings are filled in), `EMAIL_PROVIDER` (`off` until a mail service is set up; `resend` with `RESEND_API_KEY` and `EMAIL_FROM` on a domain verified in Resend — the console mailer is refused in production) and `SENTRY_DSN`. After an edit run `docker compose up -d` there. `TRUST_PROXY=1` makes rate limits see the client's address behind nginx. Logs: `docker compose logs -f api` in `/home/lunex/app`.

The shared Redis (128 MB) evicts with `volatile-lru` (set in `/etc/redis/redis.conf` on 2026-10-20; the previous file is kept as `redis.conf.bak-2026-10-20-lunex`): when memory fills up only keys with an expiry go — other projects' caches — and the queues' keys stay. BullMQ still logs that the policy should be `noeviction`; that would make every project's cache writes fail on a full Redis instead.
