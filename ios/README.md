# Lunex Finance — iOS

SwiftUI app for iOS 18+, Swift 6 (strict concurrency). The product spec and build plan live in Coddle (see `../AGENTS.md`); the API is `../backend`.

## Layout

```
ios/
├── project.yml              XcodeGen spec (Lunex.xcodeproj is generated, not committed)
├── Lunex/                   app shell: LunexApp.swift, assets
└── Packages/LunexKit/       everything else, testable on the Mac with `swift test`
    ├── LunexCore            API client, session & Keychain, money, SwiftData records
    ├── LunexLocalization    uz / ru / en strings (Localizable.xcstrings), runtime language switch
    └── LunexUI              design system (Design/), root view, tabs and screens
```

## Run

```bash
brew install xcodegen
cd ios && xcodegen generate
open Lunex.xcodeproj           # scheme Lunex, any iPhone simulator
```

Start the backend first (`cd backend && docker compose up -d && npm run start:dev`): Debug builds talk to `http://localhost:3000/v1`, which the simulator reaches on the Mac. Simulators need the iOS platform: `xcodebuild -downloadPlatform iOS` (or Xcode → Settings → Components).

## Checks

```bash
cd ios/Packages/LunexKit && swift test        # core and localization tests, no simulator needed
cd ios && xcodebuild -project Lunex.xcodeproj -scheme Lunex \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

## Notes

- **Design**: monochrome UI; colour only in data (rings, bars, charts). Tokens and components live in `LunexUI/Design/` and mirror the «Lunex Finance» design system artifact (https://claude.ai/artifact/Uwry4rx2GgWQjLbdez5hiy); screen mockups: https://claude.ai/artifact/NV8tGNs452WRWgmiZrCCRh. Use `LunexColor.*`, `.lunexText(.style)`, `LunexTheme.Spacing/Radius/Size`, `.buttonStyle(.lunex(.primary))`; no raw colours or system fonts in screens.

- **Configuration** comes from build settings in `project.yml` through Info.plist: `LUNEX_API_BASE_URL` (Release is empty until the production API exists) and `LUNEX_SENTRY_DSN` (Sentry is off without it; reports carry no PII).
- **Session**: the access token lives in memory, the refresh token and the device id in the Keychain. Concurrent requests share one refresh; a revoked refresh token signs the user out, a failed refresh while offline does not. The last profile is cached so the app opens signed in offline.
- **Language** is the app's own choice (uz / ru / en), independent of the system, and switches instantly: views read strings through `Localizer`. Add strings to `LunexLocalization/Resources/Localizable.xcstrings` in all three languages — a test fails otherwise.
- **Dates** go to the API as UTC ISO 8601 with exact milliseconds (`LunexJSON`); money as decimal strings into `Decimal`, never `Double`.
- **Local data**: SwiftData schema `LunexSchemaV1` mirrors accounts, categories, operations, goals, contributions and settings, plus the offline queue (`PendingOperation`) and the sync cursor. V1 is still edited in place until the first release; a store that no longer opens is removed and refilled by the next sync. After the release, new versions go through `LunexMigrationPlan`.
- **Sync** (`LunexCore/Sync`): screens change records locally and `SyncEngine.enqueue` the matching operation (`SyncOperation.make("transaction.create", recordId:, data:)`, shaped like the REST body). A sync sends the queue (`POST /v1/sync/push`, up to 100 at a time), then downloads changes since the stored cursor (`GET /v1/sync/changes`) page by page. A record with a change still queued is not overwritten by a pull. A refused create removes its local record; other refusals trigger a full download; a whole batch the server keeps refusing is dropped after 5 tries. Syncs run after sign-in and onboarding, when the app becomes active, on pull-to-refresh, after `enqueue` and when the network comes back. Signing out wipes the store. Settings show the state, the last sync time and what is still waiting.
- **Onboarding** (`LunexUI/Features/Onboarding`): a signed-in user whose profile is not onboarded gets six skippable steps (language, base currency, focus, monthly income, first goal from a template, notifications). The answers go in one `POST /v1/me/onboarding`, which also opens the «Наличные» account; ids for that account and the goal are made once, so a retry creates nothing twice.
- **Sign-in** (`LunexUI/Features/Auth`): the welcome screen asks `GET /v1/auth/providers` and does not open a method the server has off.
  - *Email*: a 6-digit code, sent as soon as all digits are in (typed or filled from Mail). With the backend's `EMAIL_PROVIDER=console` the code is in the server log.
  - *Apple*: `SignInWithAppleButton` with a nonce; the entitlement comes from `project.yml`. Bundle id `uz.lunex.finance` must be in the backend's `APPLE_CLIENT_IDS`; on a device it needs your Apple team.
  - *Google*: OAuth with PKCE in `ASWebAuthenticationSession`, no SDK. Set `LUNEX_GOOGLE_CLIENT_ID` in `project.yml` to the iOS OAuth client id and add the same id to the backend's `GOOGLE_CLIENT_IDS`.
  - *Telegram*: the app opens `/v1/auth/telegram/start`; Telegram returns to the server, which hands the result to `lunex://auth/telegram`. Needs the backend's `TELEGRAM_BOT_TOKEN` and `PUBLIC_URL` (the bot's domain in @BotFather), so it does not work against `localhost`.
