# School Bus Tracking Platform — Implementation Contract (v2)

**Binding for every agent and every line of code.**
Functional and technical source of truth: [`School_Bus_Tracking_Technical_Blueprint.md`](School_Bus_Tracking_Technical_Blueprint.md) (a copy lives next to this file in `docs/`, cited as **BP §n**).

> **Four independent repositories.** The platform is split into four git repositories, checked out side by side
> in one workspace folder: `backend/` (this repo: API, migrations, docs), `admin/` (React admin web),
> `driverapp/` and `parentapp/` (Flutter). Paths in these docs are written from that workspace folder, so
> `backend/src/…` is `src/…` in this repo and `admin/vercel.json` is `vercel.json` in the admin repo.
This contract resolves the blueprint's open choices, records the client's hard constraints and lists every deliberate deviation. Where this contract and the blueprint disagree, **this contract wins**; where this contract is silent, **the blueprint wins**. Product name in UIs: **"Where Is My Bus"**.

---

## 0. Client constraints (non-negotiable)

1. Backend **Node.js + Express**, database **PostgreSQL** (production: **Neon PostgreSQL 18** through its PgBouncer pooler), web **React + Vite**, mobile apps **Flutter**.
2. Web admin UI must look like a **professional SAP application** → SAP UI5 Web Components for React, theme **SAP Horizon**, Fiori floorplans (overrides the blueprint's "MUI or shadcn/ui").
3. **Google Maps** everywhere (web admin, driver app, parent app) and **Google routing** for planned route polylines.
4. Object storage = the client's **Linode Object Storage** (S3-compatible) bucket, which may be shared → every key starts with `S3_KEY_PREFIX` (`whereismybus/`).
5. Credentials live only in `backend/.env` (git-ignored). Never print, log, copy or commit them.

## 1. Product suite and repository layout

| # | Deliverable | Folder | Users |
|---|---|---|---|
| 1 | Super Admin panel (`/platform/*`) | `admin/` repo | Platform owner (us) |
| 2 | School Admin panel (`/school/*`) — same codebase, different route tree and layout | `admin/` repo | School staff admins |
| 3 | Driver/Conductor app | `driverapp/` repo | Drivers, conductors |
| 4 | Parent app | `parentapp/` repo | Parents (guardians) |
| 5 | Backend: REST API + Socket.IO + background worker | `backend/` | All of the above |

Students never log in (they are school-managed records). There is no public/anonymous access to any school data.

```
whereismybus/                                   workspace folder (not a repo) holding the four repos
  backend/                                      REPO: TypeScript, Express 5, pg, Socket.IO, jobs (Render)
    render.yaml                                 Render Blueprint (repo root, no rootDir)
    docs/ARCHITECTURE.md                        this contract (+ the blueprint copy, BP)
    docs/API.md + docs/api/<module>.md          API reference (request/response examples)
    docs/SEED_DATA.md                           demo tenants, accounts, codes, flows
    shared/                                     vendored @wimb/shared: enums, Zod DTO schemas, API types (tsc → dist)
    migrations/NNN_*.sql                        SQL migrations (source of truth; BP suggests infra/db/migrations)
    src/{app.ts, server.ts (API+Socket.IO), worker.ts (jobs), socket.ts}
    src/{config, db, middleware, modules/<module>, jobs, shared}
    tests/                                      vitest + supertest against real Postgres (RLS on)
  admin/                                        REPO: React 19 + Vite + TypeScript + UI5 (platform + school panels; Vercel)
    shared/                                     vendored @wimb/shared (identical copy of backend/shared)
  driverapp/                                    REPO: Flutter app  (applicationId com.whereismybus.driver)
    packages/core/  packages/map_kit/           vendored Dart packages (identical copies in parentapp)
  parentapp/                                    REPO: Flutter app  (applicationId com.whereismybus.parent)
    packages/core/  packages/map_kit/           vendored Dart packages (identical copies in driverapp)
```
`backend` and `admin` each vendor `@wimb/shared` in their own `shared/` folder and depend on it via `"file:./shared"`; `postinstall` builds it and each consumer's `prebuild`/`pretest`/`pretypecheck` rebuilds it. Keep both copies identical (`node scripts/check-shared-sync.mjs ../admin` in the backend repo). Each Flutter app vendors `packages/core` (Dart: API client, auth/session, models, theme, i18n, utils) and `packages/map_kit` (Dart: Google Map widgets, polyline, animated bus marker, ETA chips) and depends on them via `path:` dependencies (no melos needed); keep the two apps' copies identical.

## 2. Technology decisions (resolving BP §3.2)

| Concern | Decision |
|---|---|
| Backend language | **TypeScript** (strict). Dev `tsx watch`, build `tsc` → `dist/`, start `node dist/server.js` / `node dist/worker.js`. |
| HTTP | Express 5 (async errors propagate), helmet, cors allow-list, cookie-parser, compression off for Socket.IO/SSE paths |
| Validation | **Zod** everywhere (schemas from `@wimb/shared` where they are shared with the web); unknown keys stripped |
| DB access | `pg` + parameterised raw SQL in repositories (BP allows "Knex + raw SQL"); one `withTenant(ctx, fn)` entry point (§4) |
| DB features | PostgreSQL 14–18, **PostGIS** (Neon supports it), `citext`, `pgcrypto`, `btree_gist`; **RLS with FORCE** on every tenant table |
| Cache / live state / pub-sub / rate limits / queues | **Redis** (`ioredis`) when `REDIS_URL` is set — required in production unless `SINGLE_INSTANCE=true` (exactly one API instance; the Render Blueprint). Without Redis (local dev, tests, single-instance production) the same interfaces fall back to in-process implementations (memory cache/live store/rate-limit store, EventEmitter pub/sub, in-process job runner). Never call Redis directly from modules — use the `shared/kv`, `shared/pubsub`, `jobs` interfaces. |
| Jobs | **BullMQ** (Redis) or in-process scheduler fallback behind one `jobs` interface (repeatable cron jobs per school timezone + on-demand jobs like `trip-finalizer`, `points.persist`). Worker entry `src/worker.ts` (multi-instance setups only; refused when `SINGLE_INSTANCE=true`); in dev and single-instance production the API process runs jobs in-process (`JOBS_IN_PROCESS=true`). |
| Realtime | **Socket.IO** (+ `@socket.io/redis-adapter` when Redis is present); polling fallback endpoints exist for every live view |
| Passwords | **argon2id** via `@node-rs/argon2` (prebuilt, no native compile) |
| Super Admin 2FA | TOTP (`otplib`), enrolment + verification; required at login once enabled (seeded super admin enrolls on first login) |
| Tokens | JWT access 15 min (`sub`, `role`, `school_id` (null for super admin/parent), `sid`) + opaque rotating refresh tokens hashed in `sessions` (family reuse detection) — BP §5.2 |
| Parent OTP | 6-digit OTP, hashed; policy from env: expiry `SMS_OTP_EXPIRY_MIN` (10), attempts `SMS_OTP_MAX_ATTEMPTS` (5), resend cooldown `SMS_OTP_RESEND_SECONDS` (60), per-phone daily cap `SMS_OTP_DAILY_CAP` (10) and global daily circuit breaker `SMS_OTP_GLOBAL_DAILY_CAP` (2000), plus per-IP limits; identical responses for unknown numbers. **SMS provider: WebPay Services** (`SMS_PROVIDER=webpayservices`): HTTP GET `SMS_API_URL` with `username`, `apikey`, `apirequest=Text`, `sender`, `mobile` (10-digit Indian number), `message` (the DLT template `SMS_OTP_MESSAGE` with `{otp}` filled — must match the registered template exactly), `route` (`OTP`), `TemplateID` (`SMS_DLT_TEMPLATE_ID`), `format=JSON`; balance via `apirequest=CreditCheck` (platform health warns below `SMS_LOW_BALANCE_THRESHOLD`). `console` provider prints OTPs to the log (development only). In non-production, real SMS go only to `SMS_DEV_ALLOWED_NUMBERS`; others are printed. Optional parent password fallback (BP §5.1). |
| Push | **FCM** via `firebase-admin` when `FIREBASE_SERVICE_ACCOUNT_B64` is set; otherwise the push channel is a logged no-op. Parents also get an **in-app notification inbox** (stored), so everything works without FCM. SMS/WhatsApp channels are feature-flagged adapters (BP §11.2). |
| Email | SMTP (`nodemailer`) when configured, else logged (welcome mails, reset links) |
| Files | Private S3 (Linode) with `S3_KEY_PREFIX`; key `whereismybus/schools/{school_id}/{category}/{entity_id}/{uuid}.{ext}`. **Mobile** uploads use presigned PUT (BP §12). **Web** uploads go through the API (multipart → server → S3), so the shared bucket needs no CORS change. Downloads always via short-lived presigned GET (60–300 s). `local` storage driver for tests/dev. Thumbnails + EXIF stripping with `sharp`. |
| Maps (web) | `@vis.gl/react-google-maps` with `VITE_GOOGLE_MAPS_API_KEY` (+ optional `VITE_GOOGLE_MAPS_MAP_ID` for advanced markers). Without a key the map component shows a clear "Google Maps key not configured" panel and the rest of the page still works. |
| Maps (mobile) | `google_maps_flutter` (Android/iOS keys injected from build config; web key in `web/index.html` placeholder) wrapped by `map_kit`. |
| Routing / ETA | Planned route polylines from **Google Routes API** (`computeRoutes`, stops as intermediates) with `GOOGLE_MAPS_SERVER_KEY`; without the key the polyline is the straight-line path through the stops (flagged `polylineSource: 'straight'`). ETA v1 per BP §9.5 (no paid call per update); ETA v2 (Routes API every N minutes, cached) behind a setting. |
| Reports | CSV (streaming, formula-injection guard) and PDF (`pdfkit`) |
| Web stack | React 19 + Vite + TS, React Router 7, TanStack Query 5, Zustand, React Hook Form + Zod, **UI5 AnalyticalTable** (instead of TanStack Table), `socket.io-client`, `@vis.gl/react-google-maps`. The existing frontend foundation (shell, list report, object page, providers, API client) is reused and adapted. |
| Mobile stack | Flutter 3.38, Riverpod, go_router, dio, freezed + json_serializable, geolocator, flutter_foreground_task, camera (live capture only for odometer), drift (+ `sqlcipher_flutter_libs` on Android/iOS; plain sqlite fallback on web/test), flutter_secure_storage, connectivity_plus, battery_plus, permission_handler, workmanager, socket_io_client, firebase_core/firebase_messaging (initialised only when Firebase options are provided via `--dart-define`), flutter_local_notifications, intl (English + Hindi). |
| Tests | Backend vitest + supertest on real Postgres **as the RLS-restricted app role**; web vitest + Playwright (system Chrome via `playwright-core`); Flutter `flutter test` + `flutter analyze`. |

## 3. Database connectivity (Neon / PgBouncer / PG 14–18)

- Two DB roles: **owner** (`DB_USER`, runs migrations, owns tables) and **app role** (`DB_APP_USER`/`DB_APP_PASSWORD`, `LOGIN NOBYPASSRLS`, not owner) used by the API and worker at runtime. `npm run db:setup-roles` (run as owner) creates/updates the app role from env and grants `SELECT, INSERT, UPDATE, DELETE` on tenant/platform tables, `USAGE` on sequences, `EXECUTE` on the SECURITY DEFINER functions, and **INSERT/SELECT only** on `audit_logs` (BP §6.2). Default privileges make future tables covered.
- Tests create a dedicated app role in the local test cluster and run every HTTP test through it, so RLS is exercised for real.
- PgBouncer transaction pooling ⇒ tenant context uses **transaction-local** `set_config(..., true)` inside `withTenant` (safe through the pooler); no session state outside transactions, no `LISTEN/NOTIFY`, migrations serialised with `pg_advisory_xact_lock`, one transaction per migration, no `CONCURRENTLY`.
- Generated columns always `STORED` (PG 18 defaults to VIRTUAL; the PostGIS `geom` column in BP §6.2 is STORED).
- Type parsers: `DATE` and `TIME` stay strings, `INT8`/`NUMERIC` → `Number`, `timestamptz` → ISO strings in DTOs.
- Never rely on the session TimeZone: compute local dates with `(now() AT TIME ZONE $tz)::date`; every school has an IANA `timezone` (default `Asia/Kolkata`).
- Round-trip discipline: one query per list endpoint (joins/CTEs for display names), bulk single-statement writes (`unnest`, multi-row `VALUES`, `INSERT … SELECT`), batched seeds. Set all three tenant settings in **one** `SELECT set_config(…), set_config(…), set_config(…)` statement.
- `location_points` is range-partitioned by month (BP §6.3); the `partition-maintenance` job creates the next partitions ahead of time and drops expired ones per retention; a DEFAULT partition catches points outside the pre-created months (moved into their month when it is created; the job alerts in the log).

## 4. Multi-tenancy implementation (BP §4 — all three layers mandatory)

- `school_id` comes **only** from the verified token (staff/admins) or the validated `X-School-Id` header (parents, after the server confirms an active child link in that school). Bodies/URLs never grant authority; unknown `school_id` keys are stripped by Zod.
- `withTenant({ schoolId, actorId, role }, fn)` opens a transaction, sets `app.school_id`, `app.actor_id`, `app.actor_role` with one statement, runs `fn(tx)`, commits. Repositories receive `tx` only — never the global pool. Read-only requests use `BEGIN READ ONLY`. Single-statement SECURITY DEFINER calls made before any tenant is known (login lookups, refresh, session loading, OTP, `parent_children_index` for `X-School-Id`) go through the one db-layer helper `definerQuery()` (`backend/src/db/definer.ts`) instead of a `withTenant` transaction (deviation 8).
- `getPool(tenant)` resolves the pool (all tenants `shared` today; `dedicated` tenants get their own pool later — BP §4.7). Never import a global pool inside repositories.
- RLS: a migration helper `apply_tenant_rls(table)` enables + forces RLS and creates `tenant_isolation` (`USING`/`WITH CHECK school_id = NULLIF(current_setting('app.school_id', true), '')::uuid`) on **every** table with `school_id`; narrower parent policies per BP §4.3 (students, student_parents, assignments, trips, buses/staff visibility views). A test fails if any `school_id` table lacks RLS + FORCE.
- `schools`: RLS allows `actor_role = 'super_admin'` (all rows) or `id = app.school_id` (own school). `platform_users`, `platform_settings`: super admin only (policy on `actor_role`). `parent_accounts`: own row (`id = app.actor_id`) or school admins of a school where that parent is linked (via `school_parents`) — schools **read** it only; it is a global identity shared across schools, so its phone changes only through `school_update_parent_phone()` (parent linked to the caller's school alone) and a trigger limits ordinary updates to display name, language, password hash and sign-in counters.
- SECURITY DEFINER functions (owned by the owner role, `SET search_path`, minimal columns, no row data leakage): login lookups per login type (BP §4.5), OTP lookup, `platform_health_counts()` (counts only — BP §4.4), `active_school_ids()` and `school_timezones()` for the worker (the worker then processes each school inside `withTenant`), `parent_children_index(parent_id)` returning (school_id, student_id) pairs for `/parent/children` (BP §4.6).
- Super Admin requests carry no `app.school_id` ⇒ zero tenant rows by construction; no impersonation.
- Deactivated/suspended school ⇒ `resolveTenant` blocks logins, API calls, ingestion, socket joins and file URLs (BP App. C).
- Cache keys, Redis keys, socket rooms, job payloads and logs always include `school_id` (BP §16).

## 5. API conventions

- Base `/api/v1`; health `GET /healthz` (liveness) and `GET /readyz` (DB + Redis-if-configured + migrations) at the root.
- JSON bodies **camelCase** (DB stays snake_case; repositories map). Exception: the compact location payload keeps BP §9.1 keys (`t, lat, lng, spd, hdg, acc, bat, net, mv`).
- Envelopes: success `{ "success": true, "data": …, "meta": { "page", "limit", "total", "totalPages" } }` (meta only on lists); error `{ "success": false, "error": { "code", "message", "details", "requestId" } }` (BP §7.2 fields inside `error`).
- Error codes: `VALIDATION_ERROR` 400, `UNAUTHENTICATED` 401, `TOKEN_EXPIRED` 401, `TOTP_REQUIRED` 401, `PASSWORD_CHANGE_REQUIRED` 403, `FORBIDDEN` 403, `SCHOOL_INACTIVE` 403, `DEVICE_NOT_BOUND` 403, `NOT_FOUND` 404 (also for cross-tenant ids), `CONFLICT` 409, `DUPLICATE` 409, `INVALID_STATE` 409, `TRIP_ALREADY_ACTIVE` 409, `ODOMETER_INVALID` 422, `RATE_LIMITED` 429 (+`Retry-After`), `PAYLOAD_TOO_LARGE` 413, `UNSUPPORTED_FILE` 415, `INTERNAL_ERROR` 500, `SERVICE_UNAVAILABLE` 503.
- Pagination `page` (≥1) + `limit` (1–100, default 20); whitelisted `sort` (`field` / `-field`); explicit filters; `?format=csv` on admin lists/reports (and `pdf` on reports).
- Idempotency: `client_start_id` on trip start, `ON CONFLICT DO NOTHING` for location batches, `Idempotency-Key` header on uploads and other creates (BP §7.2). Never blindly retry non-idempotent calls.
- Audit: every write calls `audit.log(tx, { action, entityType, entityId, old, new })` in the same transaction; secrets redacted; `audit_logs` is insert-only for the app role.
- Soft delete (`deleted_at`) per BP §7.2; deleting buses/routes with active trips is blocked.

## 6. Authentication specifics (BP §5)

| Login | Endpoint | Rules |
|---|---|---|
| Super Admin | `POST /auth/platform/login` | email + password (+ TOTP once enrolled). `POST /auth/platform/totp/setup` (returns otpauth URI + QR data URL) and `/totp/verify`. Seed creates one super admin whose TOTP is not yet enrolled; first login forces enrolment. |
| School Admin | `POST /auth/school/login` | email (globally unique) + password; lockout after N failures with cooldown; `must_change_password` forces `POST /auth/change-password`. |
| Driver/Conductor | `POST /auth/staff/login` | `schoolCode` + phone or username + password or PIN + `device {deviceId, platform, model, appVersion}` → device row bound to the session; location/trip calls from another device → `DEVICE_NOT_BOUND`. |
| Parent | `POST /auth/parent/otp/request`, `/otp/verify` | phone (E.164) + OTP; only phones registered by a school (parent created by a School Admin or CSV import) can log in; unknown numbers get the same response shape (no enumeration). Optional password fallback endpoint. |
| All | `POST /auth/refresh`, `/auth/logout`, `/auth/logout-all`, `/auth/change-password`, `GET /auth/me` | Web refresh token in an httpOnly secure cookie (`wimb_rt`, `X-WIMB-Client: web` header required); mobile in the body + secure storage. Deactivating a user/school revokes sessions. |

## 7. Realtime (BP §8.6, §9)

Socket.IO namespace `/rt`, JWT in the handshake `auth`. Rooms: `school:{schoolId}:fleet` (school admins), `trip:{tripId}` (school admins of that school; parents with an active assignment to that bus + direction), `child:{studentId}:live` (linked parents), `school:{schoolId}:alerts` (admin bell). Every `join` re-checks authorization server-side. Parent rooms are coalesced to ≥ 10 s per trip (reduced rate while stopped). Events: `live:position`, `live:status`, `trip:status`, `alert:new`, `notification:new`.

## 8. Background jobs (BP §7.3)

All jobs of BP §7.3 are implemented (`generate-daily-trips` at 00:05 school-local time, `trip-not-started-check`, `document-expiry-scan`, `stale-trip-closer`, `location-gap-detector`, `trip-finalizer`, `partition-maintenance`, `maintenance-due-scan`, `session-cleanup`) plus `points-persist` (batched location inserts). Each job iterates `active_school_ids()` and works per school inside `withTenant`; every job is idempotent and exported as a plain function for tests. A **school holiday calendar** (`school_holidays`) suppresses trip generation and false "not started" alerts (BP §19 #10, §20 #4).

## 9. Scope decisions

**In scope (MVP)**: everything in BP §2–§17 for the five deliverables, plus these BP §20 items because they are cheap and protect the business: per-school **feature flags** (`school_settings.features`), **holiday calendar**, **announcements** (school → drivers/parents), **app version gating** (`min_supported_version` per app in platform settings, enforced by a header check), basic **subscription limits** (`school_subscriptions`: plan, max buses/students, valid_until, modules; enforced in `resolveTenant`/create endpoints), usage aggregates for the Super Admin (counts only), parent **in-app notification inbox**, `schools.institution_type` (`school` / `college` / `university`, display only).
**Out of scope (explicitly later)**: student boarding/attendance, billing/payments, odometer OCR, break-glass support access (absent by design), WhatsApp delivery (adapter interface only), dedicated-tenant migration tooling (design hooks only: `tenant_mode`, `getPool(tenant)`).

## 10. Web admin (BP §13) — SAP Fiori rules

- One SPA, two layouts: **Platform** (`/platform/*`, own login with TOTP) and **School** (`/school/*`, own login, school name/logo in the ShellBar). Role guards on routes; the server enforces everything.
- UI5 Web Components for React, theme SAP Horizon, compact density; floorplans: List Report (DynamicPage + FilterBar + AnalyticalTable with server-side sort/filter/pagination, CSV export) and Object Page (header facets + sections); Wizards for guided creation (school onboarding, CSV import with dry-run preview, schedule creation); IllustratedMessage empty/error states; MessageStrip/Toast feedback; semantic ObjectStatus colours.
- Google Maps for: live fleet (markers per bus, freshness colours, side panel), route & stop editor (click to place, drag, reorder, arrival-radius slider, planned polyline preview from the backend), trip detail (planned vs actual path, stop events), school location picker.
- Live data via Socket.IO (TanStack Query cache updates), polling fallback.
- Parent-visibility matrix editor with a **live preview** of the parent's view (BP §13.3).
- The existing frontend foundation is reused: rename/rework its areas (old passenger/driver web areas are removed — drivers and parents use the Flutter apps).

## 11. Mobile apps (BP §14, §15)

- `packages/core`, vendored in each Flutter app (dio client with refresh + device headers + `X-School-Id` support, secure token storage, session state, error mapping, models (freezed), theme (Fiori-inspired Material 3: Horizon blue `#0070F2`), i18n en/hi, common widgets), `app/packages/map_kit` (Google Map wrapper, polyline decode, animated bus marker that never shows positions that were not received, stop/school markers, freshness chip).
- **Driver app**: BP §14 flows (school code login, first-login password change, home with today's morning/afternoon trips + announcements, pre-trip checks, live-camera odometer capture with timestamp/GPS overlay, start → foreground-service tracking with the moving/stopped interval governor (hard 10-s floor), active trip screen with offline queue counter, end trip with photo, history, profile, non-school trip when allowed, resume via `/driver/trips/active`, local alerts for GPS off / no network / low battery / mock location).
- **Parent app**: BP §15 flows (phone + OTP login, home with child cards grouped by school with branding, track bus map with animated marker + planned polyline + child's stop + school marker + status chip + ETA + "Last updated", bus details and driver/conductor cards filtered by visibility, notification preferences per child and direction, inbox, settings/language/logout, deep links from push).
- Verification here: `flutter analyze` (zero issues), `flutter test`, `flutter build web` for both apps (background location/camera/sqlcipher paths are guarded so web builds compile). No Android/iOS builds on this machine.

## 12. Quality gates

- Backend: `npm run lint`, `npm run typecheck`, `npm test` (fresh test DB, app role, RLS forced). Mandatory suites: tenant isolation for **every** endpoint/socket room/file route (BP §4.9), RLS coverage, auth (4 login types, refresh rotation, device binding, OTP limits, TOTP), trip lifecycle + odometer rules + alerts (BP §10), ingestion throttling/backfill/dedupe (BP §9), ETA math, notification and alert dedupe, jobs, file authorization, parent visibility DTOs.
- Web: `npm run build` (tsc + vite), lint, vitest, Playwright screenshots of every page reviewed for SAP Fiori quality.
- Mobile: analyze, test, web build for both apps.
- End-to-end: seed → school admin configures → driver starts trip (odometer) → points → admin live fleet + parent tracking/ETA → notifications → end trip → odometer/GPS validation + alerts.

## 13. Environment (`backend/.env`; precedence: process env > `.env.local` > `.env`)

Existing keys stay (DB_*, TEST_DB_NAME, AWS_*/S3_*, STORAGE_DRIVER, JWT, CORS, etc.). New keys:
```
DB_APP_USER=wimb_app            # runtime role (NOBYPASSRLS); created by npm run db:setup-roles
DB_APP_PASSWORD=<generated>
REDIS_URL=                       # required in production; empty = in-process fallbacks
JOBS_IN_PROCESS=true             # dev: run jobs inside the API process
SMS_PROVIDER=webpayservices      # webpayservices | console
SMS_API_URL / SMS_API_USERNAME / SMS_API_KEY / SMS_SENDER_ID / SMS_ROUTE=OTP / SMS_DLT_TEMPLATE_ID
SMS_OTP_MESSAGE="… {otp} …"     # exact DLT template text
SMS_OTP_EXPIRY_MIN=10  SMS_OTP_MAX_ATTEMPTS=5  SMS_OTP_RESEND_SECONDS=60  SMS_OTP_DAILY_CAP=10  SMS_OTP_GLOBAL_DAILY_CAP=2000
SMS_DEV_ALLOWED_NUMBERS=          # non-production: only these E.164 numbers get real SMS
SMS_LOW_BALANCE_THRESHOLD=500
FIREBASE_SERVICE_ACCOUNT_B64=    # FCM; empty = push disabled (in-app inbox still works)
GOOGLE_MAPS_SERVER_KEY=          # Routes API for planned polylines / ETA v2
TOTP_ISSUER="Where Is My Bus"
PLATFORM_ADMIN_EMAIL=superadmin@example.com   # seed
METRICS_TOKEN=                   # bearer token of GET /metrics (Prometheus text); empty = endpoint off (404)
SENTRY_DSN= SENTRY_ENVIRONMENT= SENTRY_RELEASE=   # optional API + worker error reporting (scrubbed); empty = off
```
Web: `admin/.env.local` → `VITE_GOOGLE_MAPS_API_KEY`, `VITE_GOOGLE_MAPS_MAP_ID` (optional), `VITE_SOCKET_URL` (prod: the Render API origin), `VITE_API_BASE_URL` (unset on Vercel — `/api/*` is rewritten same-origin; absolute only for a same-site API host), optional `VITE_SENTRY_DSN` (web error reports, lazy-loaded, scrubbed of tokens and personal data). Mobile: `--dart-define=API_BASE_URL=… --dart-define=GOOGLE_MAPS_KEY=… [--dart-define=FIREBASE_*]`; Android/iOS map keys via Gradle `manifestPlaceholders` / iOS `AppDelegate` reading build settings (documented in each app README).

## 14. Demo data (`npm run seed`; documented in `docs/SEED_DATA.md`)

Fictional tenants in different states: **Greenwood International School** (`GWIS-BLR`, Bengaluru, Karnataka), **Sunrise Public School** (`SUNRISE-JPR`, Jaipur, Rajasthan), **Lakeview Academy** (`LAKEVIEW-HYD`, Hyderabad, Telangana) and **Riverside College** (`RIVERSIDE-COK`, Kochi, Kerala, `institution_type=college`). Per tenant: school admin(s); 6–10 buses (codes R1…, state-appropriate registrations, documents with some expiring); morning + afternoon routes with 8–12 real-locality stops each and expected times; drivers + conductors with profiles/licences/documents and app logins; 30–60 students with per-direction assignments; parents (phones) — including one parent with children in **two** schools; schedules Mon–Sat; holidays; announcements; a few historical trips with odometer evidence, alerts, fuel and maintenance logs so reports and dashboards are populated. Super admin `superadmin@example.com`. Passwords default to `SEED_DEFAULT_PASSWORD` or `Wimb@12345`; parent OTPs are printed by the console SMS provider.

## 15. Build ownership (parallel agents)

Agents own module folders (`backend/src/modules/<m>`, their migrations in reserved ranges, seeds `src/db/seeds/NN_<m>.ts`, tests `tests/<m>*.test.ts`, docs `docs/api/<m>.md`) and never edit shared files without the integrator. Migration ranges: `001–099` core/tenancy/auth/platform · `100–199` school/users/staff · `200–299` buses/files · `300–399` routes/stops/schedules · `400–499` students/parents · `500–599` trips/tracking · `600–699` alerts/notifications · `700–799` fuel/maintenance/reports/announcements. Stop only the processes you started (by PID/port), never by name.

## 16. Deviations from the blueprint (deliberate)

1. UI library: **SAP UI5 Web Components** (client requirement) instead of MUI/shadcn; tables use UI5 AnalyticalTable instead of TanStack Table.
2. DB access: `pg` + raw SQL with `withTenant` instead of Drizzle/Knex.
3. Repository layout: four independent repositories (`backend`, `admin`, `driverapp`, `parentapp`) instead of one pnpm-workspaces monorepo with `apps/*`; `@wimb/shared` is vendored into `backend/shared` and `admin/shared` (`file:./shared` dependencies), the Dart packages `core`/`map_kit` are vendored into each Flutter app (`path:` dependencies instead of melos); migrations in `backend/migrations`.
4. Web uploads are proxied through the API (no bucket CORS changes on the shared Linode bucket); mobile uploads use presigned PUT.
5. Redis/BullMQ/Socket.IO-adapter are optional in local dev/tests (in-process fallbacks behind the same interfaces); production requires them unless `SINGLE_INSTANCE=true` (one instance, `JOBS_IN_PROCESS=true`), which is how Render runs it.
6. Additions: parent in-app inbox, `institution_type`, holiday calendar, announcements, version gating, subscription limits (from BP §20).
7. React 19 (BP lists 18) — already in use; no behavioural difference.
8. Pre-authentication SECURITY DEFINER lookups (one statement each, no tenant yet) run through `definerQuery()` in `backend/src/db/definer.ts` on the shared app pool instead of inside `withTenant`; it is the only SQL outside `src/db` without a tenant context, and repositories still never import a pool.
9. Hosting (BP §17 containers behind Nginx): managed platforms instead — web on Vercel (static SPA; `/api/*` rewritten same-origin to the API so the `SameSite=Strict` refresh cookie works, SPA fallback for deep links), the API on Render as one native Node web service in single-instance mode (`render.yaml`: no Docker, no Redis, no worker; `npm run release && npm start` runs migrations + `db:setup-roles` + bootstrap at every start), Neon pooler, a **private** Linode bucket. Socket.IO connects to the API origin directly (`VITE_SOCKET_URL`). Details and checks: `docs/DEPLOYMENT.md`, `backend/scripts/check-render-config.mjs`.
10. Local environment (BP §17 docker-compose: Postgres+PostGIS, Redis, MinIO): no containers — a native PostgreSQL + PostGIS (or the Neon demo database), no Redis (in-process fallbacks), local files with `STORAGE_DRIVER=local`. CI (each repo's own `.github/workflows/ci.yml`) runs lint → typecheck → tenant isolation suites → full tests → migration dry-run → build for the backend, typecheck → lint → tests → build for the admin web, analyze → tests → debug APK build for each Flutter app and its vendored packages, plus typecheck → unit tests → build for the vendored `shared/`; deploys stay with Render/Vercel after CI passes. k6 ingest + fan-out script in `backend/scripts/load/`. Details: `docs/OPERATIONS.md`; privacy roles and retention: `docs/PRIVACY.md`.
