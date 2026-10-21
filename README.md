# Where Is My Bus — backend

Multi-tenant SaaS for private schools, colleges and universities to track **their own** buses. Parents see
the live bus and an ETA for their child's stop, transport admins run trips, fleet records and alerts, and
the operator (Super Admin) onboards and manages institutions. **This repository is the backend**: REST API
`/api/v1`, Socket.IO live updates, jobs, PostgreSQL migrations and seeds, and the project documentation (`docs/`).

TypeScript (strict) · Express 5 · PostgreSQL 14–18 (+ PostGIS, RLS **FORCE**) · Socket.IO · BullMQ /
in-process jobs. Production database: **Neon PostgreSQL 18 behind PgBouncer transaction pooling**.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/xdashutosh/whereismybusbackend)

The button deploys this repository from `render.yaml` (at the repo root, no `rootDir`): one native Node web
service (no Docker, no Redis), the seeded Neon demo database `whereismybus_dev`, and the secrets you paste once
(`.env.render.local`, Render's "Add from .env"). Step by step: [docs/DEPLOY_VERCEL_RENDER.md](docs/DEPLOY_VERCEL_RENDER.md).

Sources of truth: [`docs/School_Bus_Tracking_Technical_Blueprint.md`](docs/School_Bus_Tracking_Technical_Blueprint.md)
(**BP**) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (**contract**, wins on conflicts). `docs/archive/` is
superseded — ignore it.

## The four repositories

| Repository | What | Hosting |
|---|---|---|
| **backend** (this repo) — `https://github.com/xdashutosh/whereismybusbackend` | API + Socket.IO + jobs, migrations, seeds, trip simulator, docs | Render |
| **admin** — `https://github.com/<you>/whereismybus-admin` | Web admin: Super Admin (`/platform/*`) + School Admin (`/school/*`) panels; React 19, Vite, SAP UI5 | Vercel |
| **driverapp** — `https://github.com/<you>/whereismybus-driverapp` | Driver/conductor app (Flutter, `com.whereismybus.driver`) | APK / stores |
| **parentapp** — `https://github.com/<you>/whereismybus-parentapp` | Parent app (Flutter, `com.whereismybus.parent`) | APK / stores |

Locally they sit side by side in one workspace folder (`backend/`, `admin/`, `driverapp/`, `parentapp/`); the docs
write paths from that folder (`backend/src/…` = `src/…` here). `shared/` is a **vendored** copy of `@wimb/shared`
(enums, Zod DTO schemas, API types) that the admin repo carries too — keep both identical
(`node scripts/check-shared-sync.mjs ../admin`; see [shared/README.md](shared/README.md)).

```
                      ┌──────────────────────────── Vercel ─────────────────────────────┐
 Browser (admins) ───►│ admin repo: dist/ (SPA, CSP, cache headers)                      │
     │                │  /api/*  ── same-origin rewrite ──────────────┐                   │
     │                └───────────────────────────────────────────────┼───────────────────┘
     │ wss (Socket.IO, bearer token)                                  ▼
     │                ┌──────────────────────────── Render (Virginia) ─────────────────┐
     └───────────────►│ whereismybus-api     Express 5 REST /api/v1 + Socket.IO          │◄── Driver / Parent apps
                      │ one native Node instance (SINGLE_INSTANCE): jobs, live state and │    (https + wss, Flutter)
                      │ rate limits in process, no Redis, no Docker                      │
                      └──────┬──────────────┬──────────────┬──────────────┬─────────────┘
                             ▼              ▼              ▼              ▼
              Neon PostgreSQL 18   Linode Object    WebPay Services   Google Routes API
              us-east-1, pooler,   Storage in-maa-1 SMS (OTP route)   (+ Maps JS / SDKs in
              RLS + PostGIS        prefix whereismybus/                the clients) · FCM push
```

Why the rewrite: the web refresh token is an httpOnly `SameSite=Strict` cookie and `*.vercel.app` →
`*.onrender.com` is cross-site, so REST goes through Vercel; WebSockets cannot, so Socket.IO connects to
Render directly with the access token. Details: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Quick start

Requirements: Node 24 (≥ 20.11). A local PostgreSQL with PostGIS is only needed for the test suite (or if you
prefer a local dev database). Redis is not needed (in-process fallbacks).

**Configuration files (git-ignored — never commit them):** `.env` (real credentials: Neon owner + app role,
Linode S3, WebPay SMS, Google, JWT), `.env.local` (local overrides loaded on top, e.g. the dev database,
`ALLOW_REMOTE_DEV_DB=true`, `STORAGE_DRIVER=local`, `TEST_DATABASE_URL` on a **local** Postgres),
`.env.render.local` (exactly the `sync: false` values Render asks for) and `.superadmin-initial-password.local`.
Template with every key: `.env.example`. Precedence: real env vars > `.env.local` > `.env`.

```bash
npm ci                                  # postinstall builds the vendored shared/
npm run migrate && npm run db:setup-roles   # always both (setup-roles re-applies grants for new tables)
npm run dev                             # API + Socket.IO + jobs (in process) on http://localhost:4000
npm run seed                            # optional demo data on a local database (docs/SEED_DATA.md)
```

The admin panel (admin repo, `npm run dev` on `:5173`) proxies `/api` and `/socket.io` to `:4000`; the Flutter
apps call it with `--dart-define=API_BASE_URL=http://localhost:4000` (Android emulator: `http://10.0.2.2:4000`).
Demo logins (dev database only): [docs/SEED_DATA.md](docs/SEED_DATA.md) — password `Wimb@12345`
(`SEED_DEFAULT_PASSWORD`); parent OTPs are printed in the API log when the number is not in
`SMS_DEV_ALLOWED_NUMBERS`.

**Test:** `npm run typecheck` · `npm run lint` · `npm test` (vitest against a **local** Postgres + PostGIS, e.g.
`TEST_DATABASE_URL=postgresql://postgres@localhost:54329/whereismybus_test npm test`; the name must contain
`test`, the suite wipes it) · `npm run build` · `npm --prefix shared test` · deployment config:
`node scripts/check-render-config.mjs` (+ `--self-test`, `--env-file .env.render.local`) ·
`node scripts/check-s3-private.mjs`. CI (`.github/workflows/ci.yml`) runs all of it on every push and pull
request against a PostGIS service container ([docs/OPERATIONS.md](docs/OPERATIONS.md) §1).

**Trip simulator** (drives seeded drivers through the real driver API so the live map moves):
`npx tsx scripts/simulate-trips.ts --base http://localhost:4000/api/v1 --school GWIS-BLR --drivers gwis.driver,gwis.basavaraj --force-start`.

**Deploy:** Render Blueprint from `render.yaml` (button above). Startup runs `npm run release && npm start`
(migrate → db:setup-roles → db:bootstrap, then the API), so no pre-deploy step is needed. Keep exactly one
instance (`SINGLE_INSTANCE=true`). Guides: [docs/DEPLOY_VERCEL_RENDER.md](docs/DEPLOY_VERCEL_RENDER.md) (step by
step), [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) (reference), [docs/OPERATIONS.md](docs/OPERATIONS.md),
[docs/PRIVACY.md](docs/PRIVACY.md), [docs/QA_REPORT.md](docs/QA_REPORT.md), [docs/API.md](docs/API.md) +
[docs/api/](docs/api/).

**Troubleshooting**

| Symptom | Fix |
|---|---|
| API refuses to start: `Database schema is not up to date` / `/readyz` lists pending migrations | `npm run migrate && npm run db:setup-roles` (always both). |
| `permission denied for table …` at runtime | A migration ran without `npm run db:setup-roles`; run it. |
| API refuses a remote database in development | `ALLOW_REMOTE_DEV_DB=true` in `.env.local`. |
| Route shows a straight line | No Google Routes API access (key missing or API not enabled → 403); the backend falls back to straight lines and flags them (docs/DEPLOYMENT.md §12). |
| Backend tests refuse to run | The test database name must contain `test` and be on a local server; never point `TEST_DATABASE_URL` at Neon. |

---

# Module builder guide

This part is the guide for **module builders**: it explains the platform you build on and the rules
every module follows.

## 1. Commands

| Script | What it does |
|---|---|
| `npm run dev` | API + Socket.IO with `tsx watch src/server.ts` (jobs in-process when `JOBS_IN_PROCESS=true`) |
| `npm run worker` | Job worker (`tsx src/worker.ts`) |
| `npm run build` | Builds `@wimb/shared`, then `tsc -p tsconfig.build.json` → `dist/` |
| `npm start` / `npm run start:worker` | `node dist/server.js` / `node dist/worker.js` with `NODE_ENV=production` |
| `npm run typecheck` · `npm run lint` | `tsc --noEmit` (src + tests, then `scripts/*.ts` via `scripts/tsconfig.json`) · typescript-eslint (type-aware, scripts included) |
| `npm test` | vitest (sequential files) against a real local Postgres, as the RLS-restricted app role |
| `npm run migrate` / `migrate:status` | Apply / list `migrations/NNN_*.sql` as the **owner** (`-- --test` targets the test DB) |
| `npm run db:setup-roles` | Create/align the app role and (re)apply all grants — **run after every migrate** |
| `npm run seed` | Run `src/db/seeds/NN_*.ts` in order (refuses production without `--force`, and a non-localhost database unless `--force` / `ALLOW_REMOTE_DEV_DB=true`) |
| `npm run db:reset` | Dev only, **localhost only**: drop schema → migrate → setup-roles (`-- --seed` to seed) |

`typecheck`, `lint`, `test` and `build` first build the vendored `shared/` (`scripts/build-shared.mjs`
installs its dev dependencies on first use).

## 2. Configuration

`src/config` validates every key of contract §13 with zod. Precedence: **process env > `.env.local` >
`.env`**. `.env` holds real production credentials — never print, copy or commit values;
`.env.local` points development at a local database. `.env.example` lists every key.

* **Owner connection** (`DATABASE_URL` | `DB_HOST/DB_USER/DB_PASSWORD/DB_NAME`): migrations, seeds,
  `db:setup-roles`, test harness. Never used for requests.
* **App connection** (`DATABASE_APP_URL` | owner location + `DB_APP_USER`/`DB_APP_PASSWORD`): API,
  sockets and worker, as a `LOGIN NOBYPASSRLS` role. Development without app credentials falls back to
  the owner (logged warning); production refuses.
* Test equivalents: `TEST_DATABASE_URL` | `DB_*` + `TEST_DB_NAME`, `TEST_DATABASE_APP_URL` | derived.
* Production refuses: missing/short `JWT_ACCESS_SECRET`, missing app role or app role = owner, no
  `REDIS_URL`, empty `CORS_ORIGINS`, `STORAGE_DRIVER=local`, `SMS_PROVIDER=console`,
  `RATE_LIMIT_ENABLED=false`, incomplete Firebase settings.
* SMS / parent OTP (`SMS_*`, see §15): with `SMS_PROVIDER=webpayservices` (any mode) the config
  requires an https `SMS_API_URL`, `SMS_API_USERNAME`, `SMS_API_KEY`, `SMS_SENDER_ID`, `SMS_ROUTE`, a
  numeric `SMS_DLT_TEMPLATE_ID` and an `SMS_OTP_MESSAGE` containing `{otp}`; the OTP policy keys are
  range-checked; `SMS_DEV_ALLOWED_NUMBERS` is normalised to E.164. Startup logs a warning
  (`config.warnings`) when the message mentions a minutes value other than `SMS_OTP_EXPIRY_MIN`.
  `NODE_ENV=test` always uses the console provider.
* Observability (all optional): `METRICS_TOKEN` (≥ 24 characters, no spaces) enables `GET /metrics`;
  `SENTRY_DSN` (a valid DSN, `https://` in production) enables Sentry for the API and the worker, with
  `SENTRY_ENVIRONMENT` (default `NODE_ENV`) and `SENTRY_RELEASE`. Sentry is always off under `NODE_ENV=test`.
* A non-production API/worker refuses a **remote** database unless `ALLOW_REMOTE_DEV_DB=true`
  (`config/serveGuard.ts`). `redactedSummary()` is the only way to log configuration.

Local development database (example): Postgres 17 + PostGIS on `localhost:54329`:
```
DATABASE_URL=postgresql://postgres@localhost:54329/whereismybus_dev
DATABASE_APP_URL=postgresql://wimb_app:<local password>@localhost:54329/whereismybus_dev
DB_APP_USER=wimb_app
DB_APP_PASSWORD=<local password>
STORAGE_DRIVER=local
```
then `npm run migrate && npm run db:setup-roles && npm run seed && npm run dev`.

**Current setup (since the go-live step, 2026-10-19):** `.env.local` points development at the
Neon database **`whereismybus_dev`** (already migrated and seeded with the demo data) and contains only
overrides, no secrets: `DB_NAME=whereismybus_dev`, `ALLOW_REMOTE_DEV_DB=true`, `NODE_ENV=development`,
`STORAGE_DRIVER=local`, an empty `SMS_DEV_ALLOWED_NUMBERS` (OTP codes go to the API log) and
`TEST_DATABASE_URL` on a local Postgres (the test suite wipes its database and must never run against
Neon by accident). Everything else comes from `.env`. Just run `npm run dev`. Neon is in the
US (≈ 250–300 ms per query from India), so local requests feel slower than on Render. Seeded logins on
a remote database must change the demo password at first sign-in. Never point `.env.local` at the
production database `whereismybus`.

## 3. Layout

```
src/
  app.ts            Express factory (no side effects)      server.ts   HTTP + Socket.IO (+ jobs in dev)
  socket.ts         Socket.IO /rt server                   worker.ts   job consumers + schedules
  health.ts         GET /healthz, GET /readyz              lifecycle.ts boot checks, graceful shutdown
  config/           env schema, owner/app connections, serve guard
  db/               pool.ts (pools, type parsers, getPool) · tenant.ts (withTenant…) · migrate.ts
                    seed.ts + seeds/NN_<module>.ts · reset.ts · setupRoles.ts
  middleware/       requestId, authenticate, resolveTenant, authorize, rateLimits, idempotency,
                    versionGate, errorHandler, notFound (barrel: middleware/index.ts)
  modules/<name>/   one folder per BP §7.1 module; router.ts mounted by modules/index.ts
  jobs/             job definitions, in-process + BullMQ backends, school-timezone scheduling
  shared/           errors, envelope, validate, pagination, logger, csv, pdf, crypto, tokens,
                    sessions, kv, pubsub, rateLimitStore, idempotency, storage, uploads, geo,
                    routing, notifications/, realtime, events, audit, phone, version, redis,
                    requestContext, metrics + httpMetrics (/metrics), sentry (optional reporting)
migrations/         NNN_snake_case.sql (owner; one transaction per file)
tests/              *.test.ts + helpers/ (globalSetup, db, auth, testEnv)
```

## 4. Module anatomy

Modules own `src/modules/<m>/` and follow **routes → controller → service → repository**
(+ `schemas.ts`), BP §7.1. The router declares full sub-paths under `/api/v1`.

```ts
// src/modules/buses/router.ts
import { Router } from 'express';
import { guards, idempotency } from '../../middleware/index.js';
import { validate } from '../../shared/validate.js';
import * as controller from './controller.js';
import { busListQuery, createBusBody } from './schemas.js';

export const router: Router = Router();
router.get('/school/buses', ...guards.schoolAdmin(), validate({ query: busListQuery }), controller.list);
router.post('/school/buses', ...guards.schoolAdmin(), idempotency(), validate({ body: createBusBody }), controller.create);
```

```ts
// src/modules/buses/controller.ts — HTTP only: read req.valid, call the service, send an envelope.
import type { Request, Response } from 'express';
import { created, list as sendList } from '../../shared/envelope.js';
import { validated } from '../../shared/validate.js';
import * as service from './service.js';

export async function list(req: Request, res: Response) {
  const { items, meta } = await service.list(req, validated(req, 'query'));
  sendList(res, items, meta);
}
export async function create(req: Request, res: Response) {
  created(res, await service.create(req, validated(req, 'body')));
}
```

```ts
// src/modules/buses/service.ts — business rules + transaction boundary + audit.
import type { Request } from 'express';
import { withRequestTenant } from '../../middleware/index.js';
import { audit } from '../../shared/audit.js';
import { listMeta, parsePagination, parseSort } from '../../shared/pagination.js';
import * as repo from './repository.js';

export async function list(req: Request, q: BusListQuery) {
  const { page, limit, offset } = parsePagination(q);
  const { orderBy } = parseSort(q.sort, { allowed: { code: 'b.code', createdAt: 'b.created_at' }, defaultSort: 'code', tiebreaker: 'b.id' });
  return withRequestTenant(req, async (tx) => {            // GET → BEGIN READ ONLY
    const { rows, total } = await repo.page(tx, { status: q.status, limit, offset, orderBy });
    return { items: rows.map(repo.toDto), meta: listMeta({ page, limit, total }) };
  });
}

export async function create(req: Request, body: CreateBus) {
  return withRequestTenant(req, async (tx) => {
    const bus = await repo.insert(tx, body);               // school_id = current_setting(...)
    await audit.log(tx, { action: 'bus.create', entityType: 'bus', entityId: bus.id, new: bus });
    return repo.toDto(bus);
  });
}
```

```ts
// src/modules/buses/repository.ts — SQL only; receives `tx`, never a pool.
import type { Tx } from '../../db/tenant.js';
import { pagedQuery } from '../../shared/pagination.js';

export function page(tx: Tx, f: { status?: string; limit: number; offset: number; orderBy: string }) {
  return pagedQuery<BusRow>(tx, {
    select: 'b.id, b.code, b.registration_no, b.status, b.created_at',
    from: 'from buses b',
    where: 'b.deleted_at is null and ($1::text is null or b.status = $1)',
    params: [f.status ?? null],
    orderBy: f.orderBy, limit: f.limit, offset: f.offset,
  });
}
export async function insert(tx: Tx, b: CreateBus) {
  return tx.one<BusRow>(
    `insert into buses (school_id, code, registration_no)
     values (nullif(current_setting('app.school_id', true), '')::uuid, $1, $2) returning *`,
    [b.code, b.registrationNo],
  );
}
```

Rules:
* **`school_id` comes only from `req.tenant`** (token for staff/admins, validated `X-School-Id` for
  parents). Never read it from bodies/params; zod strips unknown keys. Insert it with
  `current_setting('app.school_id', true)` or `tx.ctx.schoolId`.
* Every DB access goes through `withRequestTenant(req, fn)` / `withTenant(ctx, fn)` /
  `withPlatform` / `withSystem` / `withSchoolSystem`. Repositories take `tx: Tx` only.
* Cross-tenant ids → `NOT_FOUND` (RLS returns no row; use `assertFound`).
* Round trips: one query per list (joins/CTEs for display names), bulk single-statement writes
  (`unnest`, multi-row `VALUES`, `INSERT … SELECT`).
* JSON is camelCase (`camelizeRow` / explicit `toDto`), DB is snake_case. Dates: `DATE`/`TIME` are
  strings, `timestamptz` arrives as an ISO string, `INT8`/`NUMERIC` as numbers.
* Local dates: `(now() at time zone $tz)::date` with `req.tenant.timezone` — never the session TZ.
* Soft delete with `deleted_at`; deleting buses/routes with active trips is blocked.
* Register the module router in `src/modules/index.ts` (already done for all 18 BP modules).

## 5. Tenancy, authentication and the SQL contract with the core schema

Request pipeline: `requestId → pino-http → helmet → cors → global rate limit → cookie-parser →
json(1 MB) → versionGate → module router (authenticate → resolveTenant → authorize → validate →
[idempotency] → controller) → notFound → errorHandler`.

* **`authenticate()`** verifies the HS256 access JWT (`sub`, `role`, `school_id`, `sid`, `typ`) and
  reloads session + actor **on every request** (never cached). It sets `req.auth: AuthContext`
  `{ sessionId, ownerType, actorId, role, schoolId, deviceId, actorName, mustChangePassword,
  tokenExpiresAt }` and blocks everything except `/auth/change-password|logout|logout-all|me|refresh`
  while `mustChangePassword` is set (`allowPasswordChange: true` on auth routes).
  **Key rotation (BP §16):** set `JWT_ACCESS_KEYS` (`kid1:secret1,kid2:secret2` or a JSON object;
  each secret ≥ 32 chars) and `JWT_ACTIVE_KID`. New tokens carry the active `kid` header and are
  verified by kid; kid-less tokens fall back to `JWT_ACCESS_SECRET`. To rotate: add the new kid,
  switch `JWT_ACTIVE_KID`, and remove the old kid after one access-token TTL (15 min). Keep
  `JWT_ACCESS_SECRET` unchanged — it also derives the keys for secrets at rest (`shared/crypto.ts`).
* **`resolveTenant()`** sets `req.tenant: { schoolId, timezone, tenantMode, dbConnectionRef }`:
  staff/admins from the token; parents from `X-School-Id` + an active child link; super admins → 403.
  The school must be active and not deleted (`SCHOOL_INACTIVE`); school state is cached 15 s and
  evicted on `events.emit('school.status_changed', …)`. `registerSubscriptionCheck(fn)` adds plan
  checks (throw an `AppError` to reject).
* **`authorize(...roles)`** is the role gate; ownership checks live in services; RLS is the backstop.
* **Guards** (`middleware/guards.ts`): mount `guards.platform()`, `guards.schoolAdmin()`,
  `guards.staff()`, `guards.parent()`, `guards.schoolMember()` or `guards.school(...roles)` (authenticate →
  role gate → resolveTenant) instead of composing middleware. **Area guards** run before every module
  router: `/platform/*` super admin, `/school/*` school admin + tenant, `/driver/*` driver/conductor +
  tenant, `/parent/*` parent (per-child routes add `guards.parent()` for `X-School-Id`). Authentication and
  tenant resolution are memoized per request, so area + route guards cost one session load.
* **Auth module exports** (`modules/auth/index.ts`): `requireBoundDevice()` (after `guards.staff()`; sets
  `req.boundDevice`, `403 DEVICE_NOT_BOUND` for another device — compare `req.boundDevice.id` with
  `trips.device_id`), `revokeAllSessions(tx, ownerType, ownerId, reason)` (deactivation/reset; then
  `realtime.disconnectSessions(ids)` after commit), `newPassword` (zod password rules). API: `docs/api/auth.md`.
* Device binding: `req.auth.deviceId` is the session's device row id; trip/location services compare
  it with `trips.device_id` and throw `deviceNotBound()`.

The core schema (migrations `001`–`015`, see §17) provides the SECURITY DEFINER functions the
infrastructure and the modules call. All are owned by the owner role, `SET search_path = public,
pg_temp`, return minimal columns, are revoked from PUBLIC and granted to the app role by
`db:setup-roles`. Role-guarded ones raise `42501` (→ `FORBIDDEN`) for other `app.actor_role`s.

| Function | Caller / guard | Returns |
|---|---|---|
| `auth_session_actor(p_session_id)` | `shared/sessions.ts` (no context) | `session_id, owner_type, owner_id, school_id, device_id, revoked_at, expires_at, actor_active, actor_role, actor_name, must_change_password` |
| `auth_session_by_refresh(p_refresh_hash)` | auth refresh (no context) | `session_id, family_id, owner_type, owner_id, school_id, device_id, client, expires_at, rotated_at, revoked_at` |
| `auth_platform_login(email)` · `auth_school_admin_login(email)` · `auth_staff_login(school_code, phone_or_username)` · `auth_parent_login(phone)` | auth (no context) | id + password/PIN hash, lockout fields, `must_change_password`, TOTP fields (platform), school status (school logins), `has_active_link` (parent) |
| `otp_request(phone, purpose, code_hash, ttl_s, cooldown_s, max_attempts, ip)` | auth (no context; read-write tx) | `status` `issued`\|`cooldown`, `retry_after_s`, `expires_at` |
| `otp_verify(phone, purpose, code_hash)` | auth | `status` `ok`\|`invalid`\|`locked`\|`expired`\|`not_found`, `attempts_left` |
| `parent_children_index(p_parent_id)` | `resolveTenant`, `/parent/children` | `(school_id, student_id)` of active links |
| `parent_notifications_mark_read(ids uuid[] = null)` | parent context | rows marked (inbox spans schools) |
| `ensure_parent_account(phone, display_name)` | `school_admin`/`system` in a school context | the global `parent_accounts.id` (created when new); link it with `school_parents` **in the same transaction** (an advisory lock per phone, shared with `school_update_parent_phone`, is held until commit — migration 015) |
| `school_update_parent_phone(parent_id, phone)` | `school_admin`/`system` in a school context | corrects the phone of a parent linked **only** to the caller's school (`P0002` → `NOT_FOUND` when not linked here, `P0001` → `INVALID_STATE` when shared with another school, `23505` → `DUPLICATE`) — the only way to change `parent_accounts.phone` |
| `school_parent_sign_in_state()` | `school_admin`/`system` in a school context | `(parent_account_id, has_signed_in, is_locked)` flags of the parents linked to the caller's school (never timestamps/counters) |
| `school_clear_parent_lockout(parent_id)` | `school_admin`/`system` | clears a failed-sign-in lock of a parent linked to the caller's school → cleared? (`P0002` otherwise) |
| `parent_self_password_hash()` | the parent's own context | own password hash (change-password check, `hasPassword`) |
| `parent_record_login_failure(id, count, lock, max, minutes)` | the parent's own pre-auth context / `system` | lockout mirror for the parent password fallback → `locked_until` |
| `school_local_date(school_id)` | any (date defaults) | today in the school's timezone |
| `active_school_ids()` · `school_timezones()` | worker (no context) | active, non-deleted schools |
| `platform_health_counts()` · `school_usage_counts(school_id)` | `super_admin`/`system` | counts only |
| `platform_school_admins(school_id)` · `platform_create_school_admin(school_id, name, email, password_hash, phone)` · `platform_reset_school_admin_password(school_id, user_id, password_hash)` | `super_admin` | a school's admin accounts only (reset forces a change and revokes sessions) |
| `platform_revoke_school_sessions(school_id, reason)` | `super_admin`/`system` (deactivation) | sessions revoked |
| `session_cleanup(retention)` | `system` (session-cleanup job) | rows deleted (sessions, OTPs, idempotency keys) |
| `create_location_partitions(from, months)` · `drop_location_partitions(before)` | `system` (partition-maintenance) | partition names (new ones get RLS + FORCE; rows waiting in the DEFAULT partition move into the new month; never drops the current month) |
| `location_partition_maintenance(months_ahead)` | `system` (partition-maintenance job) | `created[]`, `dropped[]` (retention = platform setting `location.retention_months`), `default_rows`, `retention_months`, `school_rows_purged` (points deleted for schools with a shorter `school_settings.location_retention_months`, migration 800), `device_event_coords_purged` (device-event coordinates cleared at each school's cutoff, migration 926) |
| `location_retention_cutoffs()` | `system` (partition-maintenance job) | one row per school: `school_id`, effective `retention_months` (least of the platform maximum and the school override), `cutoff` (first day of the month, UTC) — migration 926 |

Calls that run **before** any tenant is known (login lookups, refresh, session loading, OTP,
`parent_children_index` for `X-School-Id`) are single statements made through
`definerQuery(sql, params)` from `src/db/definer.ts`: one round trip on the shared app pool, only
`select … from <function>(…)`, `42883` → `503`. It is the only SQL outside `src/db` that runs without a
tenant context; repositories and services never import a pool (contract §4, deviation 8).

**`parent_accounts` column privileges** (migration 015, `COLUMN_RESTRICTED_TABLES` in `db/setupRoles.ts`):
the app role may SELECT only `id, phone, display_name, preferred_language, is_active, created_at,
updated_at` and UPDATE only the columns the guard trigger allows; it has no INSERT/DELETE. This holds in
every context (school admin, system, the parent itself): `password_hash`, `failed_login_count`,
`locked_until` and the global `last_login_at` are reachable only through the four scoped functions
above. Never `select *` from `parent_accounts`.

`resolveTenant` reads `schools(id, status, deleted_at, timezone, tenant_mode, db_connection_ref)` inside
the school's own context (policy `id = app.school_id`); `versionGate` reads
`platform_settings['min_supported_version']`. Platform defaults live in `src/db/platformDefaults.ts`
(identical to migration 002; public rows are readable by every authenticated context).

Contexts (`src/db/tenant.ts`): every helper runs `BEGIN [READ ONLY]`, **one**
`select set_config('app.school_id',…,true), set_config('app.actor_id',…,true),
set_config('app.actor_role',…,true)`, `fn(tx)`, `COMMIT` (rollback on error; broken connections are
destroyed). Settings are transaction-local, so nothing leaks through PgBouncer.

| Helper | Context |
|---|---|
| `withTenant(ctx, fn, opts)` | explicit `{ schoolId, actorId, role }`; opts `readOnly`, `isolationLevel`, `maxRetries` (40001/40P01), `tenant`, `pool` |
| `withRequestTenant(req, fn, opts)` | request context; GET/HEAD default to READ ONLY; dedicated tenants routed by `getPool(tenant)` |
| `withPlatform({ actorId }, fn)` | `actor_role = super_admin`, no school → zero tenant rows by construction |
| `withSystem(fn)` | `actor_role = system`, no school — bootstrap/definer calls |
| `withSchoolSystem(schoolId, fn)` | one school, system actor — jobs |

## 6. Shared helpers (reference)

| Path | Main exports |
|---|---|
| `shared/errors.ts` | `AppError`, `isAppError`, factories `validationError unauthenticated tokenExpired totpRequired passwordChangeRequired forbidden schoolInactive deviceNotBound appUpdateRequired notFound conflict duplicate invalidState tripAlreadyActive odometerInvalid payloadTooLarge unsupportedFile internalError serviceUnavailable`, `rateLimited(seconds)`, `fieldError(path,msg)`, `assertFound(v)` |
| `shared/envelope.ts` | `ok`, `created`, `accepted`, `list(res, items, meta)`, `noContent`, `envelope` |
| `shared/validate.ts` | `validate({ params, query, body })` → `req.valid`, `validated<T>(req, part)`, `parseOrThrow`, `zodIssuesToDetails` |
| `shared/pagination.ts` | `parsePagination`, `parseSort`, `listMeta`, `pagedQuery(tx, spec)`, `buildPagedQuery`, `escapeLike`, `MAX_EXPORT_ROWS` |
| `shared/logger.ts` | `logger`, `childLogger`, `createLogger`, `httpSerializers`, `sanitizeUrl`, `REDACT_PATHS` |
| `shared/requestContext.ts` | `getRequestContext`, `runWithRequestContext`, `updateRequestContext` |
| `shared/audit.ts` | `audit.log(tx, { action, entityType, entityId, old, new })`, `redactSecrets`, `changedFields` |
| `shared/csv.ts` | `createCsvWriter(res, { fileName, columns })`, `toCsv`, `guardCell`, `csvField` |
| `shared/pdf.ts` | `renderPdf({ title, subtitle, meta, columns, rows, landscape })`, `sendPdf(res, file, opts)`, `drawTable` |
| `shared/crypto.ts` | `hashPassword`, `verifyPassword`, `verifyAgainstDummy`, `generateOpaqueToken`, `hashToken`, `generateRefreshToken`, `generateNumericOtp`, `hashOtp`, `safeEqual`, `hmacSign`, `encryptSecret`/`decryptSecret`, `generateTotpSecret`, `totpUri`, `totpQrDataUrl`, `verifyTotp` |
| `shared/tokens.ts` | `signAccessToken({ actorId, role, schoolId, sessionId }, { key? })`, `verifyAccessToken(token, { keys? })`, `activeSigningKey`, `bearerFrom`, `ownerTypeOfRole` |
| `shared/sessions.ts` | `loadSessionFromDb`, `isSessionUsable`, `mapSessionRow`, types `SessionRecord`, `SessionLoader` |
| `shared/kv.ts` | `kv` (`get set setIfAbsent del incr decr ttlMs deleteByPrefix`), `kvKey(...)`, `getJson`, `setJson`, `cached(key, ttl, loader)`, `createMemoryKv`, `createRedisKv` |
| `shared/pubsub.ts` | `pubsub` (`publish`, `subscribe → unsubscribe`), `createMemoryPubSub`, `createRedisPubSub` |
| `shared/rateLimitStore.ts` | `rateLimitStore.hit(limiter, key, limit, windowSec)`, `reset` |
| `shared/idempotency.ts` | `idempotencyStore.begin/complete/release`, `requestHash`, `IDEMPOTENCY_KEY_RE` |
| `shared/storage.ts` | `storage.schoolObjectKey`, `schoolIdOfKey`, `keyFor`, `putObject`, `getUploadUrl` (presigned PUT), `getDownloadUrl` (presigned GET, 60–300 s), `headObject`, `getObjectStream`, `deleteObject(Quietly)`, `verifyLocalToken`, `contentDisposition`, `sanitizeFileName` |
| `shared/uploads.ts` | `uploadSingle(kind)` → `req.upload`, `inspectFile`, `sniffFileType`, `processImage` (EXIF strip + thumbnail), `UPLOAD_KINDS` (`PHOTO ODOMETER DOCUMENT IMPORT`) |
| `shared/geo.ts` | `haversineMeters`, `withinRadius`, `bearingDeg`, `encodePolyline`, `decodePolyline`, `cumulativeDistances`, `polylineLengthM`, `projectOnPolyline`, `boundingBox`, `boundsOf`, `roundCoord` |
| `shared/routing.ts` | `computeRoute(stops)` → `{ polyline, distanceM, durationS, legs, source: 'google'\|'straight', fallbackReason? }`, `straightLineRoute`, `chunkWaypoints` |
| `shared/notifications/` | `channels.push.send({ tokens, title, body, data })`, `channels.sms.sendOtp(to, otp)` / `sendText(to, text, { templateId })` / `checkBalance()` / `sendsRealSms(to)`, `channels.email.send`, `smsStatus()`; factories `createPushChannel createSmsChannel createWebpaySms createConsoleSms createEmailChannel` |
| `shared/systemStatus.ts` | `registerStatusCheck(name, fn)`, `getSystemStatus()` → `{ level: 'ok'\|'warn'\|'error', checks }` — operational signals for the platform health view (not readiness); `sms` is registered by `shared/notifications` |
| `shared/realtime.ts` | `registerRoom(pattern, authorizer)`, `realtime.emit(room, event, payload)`, `realtime.disconnectSessions`, `realtime.disconnectSchool`, `realtime.revalidateActors(actorIds)`, `rooms.*` builders |
| `shared/events.ts` | `events.on/emit/emitAndWait` over the augmentable `AppEvents` map |
| `shared/phone.ts` · `shared/version.ts` | `normalizePhone`, `maskPhone`, `phoneE164()` · `parseVersion`, `compareVersions` |
| `shared/metrics.ts` | `appMetrics()` (process registry: `httpRequests`, `httpDuration`, `socketConnections(Total)`, `jobRuns`, `jobDuration`, `ingestPoints`, `smsSends`, process gauges), `MetricsRegistry` / `Counter` / `Gauge` / `Histogram`, `instrumentJob(def, { onFailure })`, `instrumentSms(channel)`, `instrumentSocketNamespace(nsp)`, `setMetricsProcess('worker')`, `startSnapshotPublisher(kv)` / `readWorkerSnapshot(kv)` (worker → API through the KV store). Label values must stay bounded (patterns, job names, fixed outcomes — never ids or personal data) |
| `shared/httpMetrics.ts` | `httpMetrics()` middleware (route pattern label), `metricsHandler({ token, kv })` for `GET /metrics`, `routeLabel(req)` |
| `shared/sentry.ts` | `initSentry({ role })` (no-op without `SENTRY_DSN`), `captureError(err, ctx)`, `reportJobFailure`, `flushSentry`, `closeSentry`, `scrubEvent` / `scrubString` / `isPiiKey` (what may leave the process) |
| `db/definer.ts` | `definerQuery(sql, params, { unavailableMessage })` — pre-authentication SECURITY DEFINER calls (see §5) |
| `db/pool.ts` | `getAppPool`, `getOwnerPool`, `getPool(tenant)`, `registerDedicatedPool`, `closePools`, `ping`, `PG_ERROR`, `isPgError`, `camelizeRow(s)`, `toCamel` |
| `middleware/index.ts` | everything listed in §5 plus `rateLimits`, `createLimiter`, `idempotency`, `versionGate`, `registerConstraintError`, `toAppError` |

## 7. Errors

Throw `AppError`s (factories above); everything else is mapped by `errorHandler`: zod →
`VALIDATION_ERROR`; `23505` → `DUPLICATE`; `23503` → `CONFLICT` (still referenced) or
`VALIDATION_ERROR`; `23P01`/`40001`/`40P01` → `CONFLICT`; `22xxx`/`23502`/`23514` →
`VALIDATION_ERROR` (incl. `22023` raised by core functions); `42501` (RLS `WITH CHECK`) and `25006` →
`FORBIDDEN`; `P0001` → `INVALID_STATE`; `P0002` (core functions: unknown record) → `NOT_FOUND`;
connection loss/`57014` and a row outside every partition (`details.reason = NO_PARTITION`, retryable)
→ `SERVICE_UNAVAILABLE`; multer → `PAYLOAD_TOO_LARGE`/`VALIDATION_ERROR`.
Map named constraints to friendly codes once at module load:
`registerConstraintError('one_open_assignment', 'CONFLICT', 'The student already has an assignment.')`
(`one_active_trip_per_bus` → `TRIP_ALREADY_ACTIVE` is built in). 500s never expose internals in
production. Version gating adds `APP_UPDATE_REQUIRED` (426) to the contract codes.

## 8. Validation and shared schemas

Request schemas live in `src/modules/<m>/schemas.ts`; schemas the web app also uses go to
`shared/src/schemas/<m>.ts` (the vendored `@wimb/shared`; copy the change to the admin repo's `shared/`; re-exported from `schemas/index.ts`) and are imported from
`@wimb/shared`. Reusable primitives: `uuid() isoDate() hhmm() isoDateTime() latitude() longitude()
text() optionalText() email() timeZone() semver() queryInt() queryBool() queryEnumList()
listQueryShape exportFormat idParams`, enums (`ROLES DIRECTIONS TRIP_STATUSES ALERT_TYPES …`),
`locationPoint/locationBatch` (BP §9.1 compact keys) and `deviceInfo`. `validate()` duck-types zod
schemas, so schemas from `@wimb/shared` work although that package carries its own zod copy.

## 9. Lists, exports, reports

`?page=&limit=&sort=` (limit 1–100, default 20; `sort=field,-other` whitelisted via `parseSort`),
meta `{ page, limit, total, totalPages }` via `listMeta`. `?format=csv` streams with
`createCsvWriter` (formula guard, BOM, `MAX_EXPORT_ROWS`), `?format=pdf` uses `sendPdf`.

## 10. Audit

`await audit.log(tx, { action: '<entity>.<verb>', entityType, entityId, old, new })` inside the
same transaction as the write. `school_id`, actor id and actor type come from `tx.ctx`; ip, user
agent and actor name from the request context; secrets are redacted recursively by key **words**
(camelCase/snake_case split: password, secret, token, otp, pin, hash, totp, private key, api key,
authorization, cookie, …), so business fields such as `pincode` or `passengerCount` stay readable. Use `changedFields(old, new)` for compact updates. `audit_logs` is
INSERT/SELECT-only for the app role.

## 11. Jobs

```ts
// src/modules/trips/jobs.ts
import { defineQueueJob, defineSchoolCronJob } from '../../jobs/index.js';
import { withSchoolSystem } from '../../db/tenant.js';

export async function generateDailyTrips({ schoolId, localDate }: SchoolCronPayload) {   // exported → tests call it
  await withSchoolSystem(schoolId, async (tx) => { /* idempotent INSERT … ON CONFLICT DO NOTHING */ });
}
export const generateDailyTripsJob = defineSchoolCronJob({ name: 'generate-daily-trips', cron: '5 0 * * *', handler: generateDailyTrips });
export const tripFinalizerJob = defineQueueJob<{ schoolId: string; tripId: string }>({
  name: 'trip-finalizer', attempts: 5, backoffMs: 5000,
  handler: ({ schoolId, tripId }) => withSchoolSystem(schoolId, (tx) => finalize(tx, tripId)),
});
```
Add the definitions to `JOB_DEFINITIONS` in `src/jobs/index.ts` (it starts with the core jobs of
`src/jobs/core.ts`: `partition-maintenance`, daily 02:15 UTC and once whenever a process starts its
schedules — creates location_points months ahead, drops expired ones, logs an alert when rows sit in the
DEFAULT partition; `session-cleanup`, daily 03:30 UTC — `session_cleanup('30 days')` removes expired /
revoked sessions, stale OTP codes and expired idempotency records (TOTP enrolment challenges are KV keys
with a TTL); `files-staging-cleanup`, hourly at :40 UTC — deletes `<key>.part` staging objects of presigned
uploads older than 24 h under `<S3_KEY_PREFIX>schools/`, at most 5000 per run). Enqueue from services **after
commit**: `await jobs.enqueue('trip-finalizer', { schoolId, tripId }, { jobId: tripId })` (`jobId`
deduplicates). Kinds: `defineCronJob` (one global schedule, UTC unless `timezone`),
`defineSchoolCronJob` (pattern evaluated in **each school's timezone**; an every-minute dispatcher
reads `school_timezones()` and enqueues `{ schoolId, timezone, scheduledFor, localDate }` with a
deterministic job id; it remembers the last dispatched minute in `kv` and catches up on late or missed
ticks for up to 6 h, so a backlog never skips a school-local run), `defineQueueJob` (on demand; `concurrency`, `attempts`, `backoffMs`).
Backends: BullMQ when `REDIS_URL` is set (queues under prefix `wimb`), otherwise in-process (croner
timers + async queues with retries and jobId dedupe). Consumers/schedules start in `worker.ts`, or in
the API when `JOBS_IN_PROCESS=true`. Handlers must be idempotent and include `school_id` in payloads.

## 12. KV, cache, pub/sub, rate limits, idempotency

* `kv` — Redis or in-memory with identical semantics. Keys always include `school_id` for tenant
  data: `kvKey('live', schoolId, tripId)`. `cached(key, ttl, loader)` is a single-flight read-through
  cache (never cache authorization decisions).
* `pubsub` — cross-process messages (Redis pub/sub or in-process), JSON, asynchronous delivery.
* Rate limits — `rateLimits.global` is app-wide (location ingestion is exempt); mount the named ones on
  routes: `login` (failures only, IP + identifier), `otpRequestPhone`, `otpRequestIp`, `otpVerify`,
  `refresh` (per refresh token = per session, 30 / 15 min) + `refreshIp` (per-IP ceiling 3000 / 15 min, sized
  for school offices and carrier NAT), `passwordChange`, `totpVerify`, `upload`. Custom: `createLimiter({ name, limit,
  windowSec, key, failuresOnly })`. Counters live in `kv` (global across instances with Redis) and are
  incremented atomically **before** the handler runs; `failuresOnly` limiters refund the slot when the
  response is a success, so parallel bursts can never exceed the budget. A handler may also mark an
  expected `≥ 400` answer as **not a failure** with `markNotFailure(res)` (`middleware/rateLimits.ts`), which
  refunds the slot like a success. The auth module does this only for next steps of a sign-in: the Super
  Admin enrolment challenge and `401 TOTP_REQUIRED` with `details.reason = TOTP_CODE_MISSING` (errors tagged
  with `lockout.nextStep()`, matched by object identity, never by message). Wrong passwords, PINs, OTPs and
  TOTP codes (`TOTP_CODE_INVALID`) still count. Never mark credential failures.
* `idempotency()` — mount after `authenticate`/`resolveTenant` on creates and uploads
  (`Idempotency-Key`, 24 h replay, scoped by principal + school). A client disconnect keeps the claim:
  the handler finishes, its response is stored, and the retry gets `409 IDEMPOTENCY_IN_PROGRESS`, then
  the replay. Trip start uses `client_start_id`,
  location batches `ON CONFLICT DO NOTHING` (contract §5).

## 13. Files and storage

Keys: `storage.schoolObjectKey({ schoolId, category, entityId, extension })` →
`<S3_KEY_PREFIX>schools/{school_id}/{category}/{entity_id}/{uuid}.{ext}` (categories in
`FILE_CATEGORIES`). Always cross-check `storage.schoolIdOfKey(key) === req.tenant.schoolId`.
* **Web uploads** are proxied: `uploadSingle('DOCUMENT')` (magic-byte sniffing, size limits) →
  `processImage()` for parent-visible images (EXIF/GPS stripped, thumbnail) → `storage.putObject()`.
* **Mobile uploads** use presigned PUT to a **staging** key (`storage.uploadStagingKey(key)`, never
  served); `POST /files/:id/complete` validates it, stores the validated bytes under a fresh key and
  deletes the staging object, so a replayed URL cannot alter a file:
  `storage.getUploadUrl(key, { contentType, contentLength })` (stale staging objects are removed by the
  `files-staging-cleanup` job; `storage.listObjects(prefix)` pages through a prefix)
  (the local driver needs `localPath`, an API route the files module serves with
  `verifyLocalToken(token, 'upload')`). Odometer originals are stored untouched (evidence).
* **Downloads** only via `storage.getDownloadUrl(key, { fileName })` (60–300 s) after authorization;
  never expose keys. Tests always use the local driver with keys under `whereismybus-test/`, rooted
  in a private per-run temp folder (`STORAGE_LOCAL_DIR`, set by the test globalSetup and deleted in
  its teardown), so test uploads never accumulate in `storage/`.
* The **files module** implements all of this (`docs/api/files.md`): `POST /files/upload-url`,
  `POST /files/upload`, `POST /files/:id/complete`, `GET /files/:id/url`. Business endpoints receive a
  `fileId` and link it (`*_file_id` columns). Extend a category with
  `registerFileHooks(category, { authorizeUpload, authorizeRead, parentRead })` from
  `modules/files/hooks.ts`; **parents can read a file only through a `parentRead` hook** that applies
  `school_settings.parent_visibility` (the school logo hook is built in). Signed URLs for keys you have
  already authorized: `signedDownload(req, key)` / `optionalSignedUrl(req, key)` in `modules/files/urls.ts`.
* **Retention** (BP §12): raw location points are kept for the platform setting
  `location.retention_months` (the maximum, public so schools can read it) or for the school's shorter
  `locationRetentionMonths` override (`PUT /school/settings`; null = platform value; a value above the
  platform maximum is refused, and a later platform reduction caps the effective value). The
  `partition-maintenance` job drops platform-expired month partitions and deletes the older points of
  overriding schools; before that it stores the simplified path of every trip about to lose its points that has
  none yet (`tracking/retention.ts`, `trips.summary.path.retainedAt`), and it clears device-event coordinates
  (`trip_device_events`) at each school's cutoff (`location_retention_cutoffs()`, migration 926). **Replaced documents and uploaded files are kept for audit** (product decision):
  a replaced staff/bus document stays as history (`is_current = false`), a deleted one is soft-deleted,
  and their files are never purged.

## 14. Realtime

Namespace `/rt`; JWT in `auth.token`. Sockets auto-join `actor:{id}`, `session:{sid}` and
`school:{id}:members`; `school:{id}:fleet` and `school:{id}:alerts` (school admins of that school) are
built in. Modules register their rooms and emit from any process:
```ts
registerRoom('trip:{tripId}', async (principal, { tripId }) => canWatchTrip(principal, tripId));
await realtime.emit(rooms.trip(tripId), SOCKET_EVENTS.LIVE_POSITION, payload);
await realtime.disconnectSessions(sessionIds);   // logout / deactivation
await realtime.disconnectSchool(schoolId);        // suspension
```
Every `join` reloads the **live session** of the socket (session id unrevoked/unexpired, actor active,
owner/role/school unchanged — not the 15-minute handshake JWT), re-checks the school and runs the
authorizer; `UNAUTHENTICATED`/`SCHOOL_INACTIVE` also disconnect. After an HTTP refresh a client may send
`auth:refresh` `{ token }` (ack `{ ok, sessionId, tokenExpiresAt }`): the socket adopts the new session of the
**same** principal (another account/role/school → `FORBIDDEN`, bad token → `UNAUTHENTICATED`, socket kept).
Parent principals carry no school: authorizers of parent rooms (`trip:`, `child:`) must check that the
room's school is active themselves. Memberships are also **re-checked after the join**: call
`realtime.revalidateActors([userOrParentId])` after commit whenever a change narrows what someone may watch (a
child moved to another bus or losing its assignment, crew removed by a reassignment); every API instance re-runs
the authorizers of that principal's joined rooms, removes the socket from rooms it may no longer watch and emits
`room:revoked` `{ room, reason }` (`SOCKET_EVENTS.ROOM_REVOKED`). A periodic sweep (`ROOM_REVALIDATE_INTERVAL_MS`,
5 min) re-checks every socket, which covers validity windows that simply expire. An authorizer that **throws**
(transient failure) keeps an existing membership until the next check; return `false` only for a real denial. Emits travel over
`pubsub` and each API instance relays them to its local sockets (Redis adapter installed when
`REDIS_URL` is set). Parent coalescing (≥ 10 s per trip) is the tracking module's job.

## 15. Notifications, routing, geo

`channels.push` (FCM or logged no-op; returns `invalidTokens` to prune), `channels.sms`
(WebPay Services or console, below), `channels.email` (SMTP or log).

**SMS — WebPay Services** (`SMS_PROVIDER=webpayservices`, `shared/notifications/sms.ts`):
* Send: `GET SMS_API_URL?username=…&apikey=…&apirequest=Text&sender=SMS_SENDER_ID&mobile=<10 digits>
  &message=<percent-encoded text>&route=SMS_ROUTE&TemplateID=SMS_DLT_TEMPLATE_ID&format=JSON`.
  OTP text = `SMS_OTP_MESSAGE` with `{otp}` replaced (must match the DLT template exactly).
* Indian numbers only: `+91XXXXXXXXXX` → `XXXXXXXXXX`; any other number resolves
  `{ delivered: false, error: 'UNSUPPORTED_NUMBER' }` without calling the API.
* `SMS_API_URL` must be `https://`, without a `#fragment` or embedded `user:pass@` (config refuses both).
* 10-s timeout (AbortController). Sending is not idempotent, so at most one retry and only when the
  connection was never established (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ENETUNREACH`,
  `EHOSTUNREACH`, `UND_ERR_CONNECT_TIMEOUT`); a timeout, a connection lost mid-request or any provider
  response is never retried (WebPay may already have sent and billed it). Only `status: "success"`
  (or `type: "success"` when there is no `status`, and never with a contradicting `type: "error"`)
  counts as delivered; any other answer is a failure (`PROVIDER_REJECTED`, `INVALID_RESPONSE`, `HTTP_ERROR`); "Low SMS Balance"
  → `LOW_BALANCE` with an error-level log. Results carry error codes, never the provider's text.
* Logs never contain the API key, the API username, the message text or the OTP; phones are masked;
  provider messages are scrubbed (key, username, message/template text and code removed — raw,
  percent- and form-encoded, longest first — and long digit runs masked).
* Non-production: only numbers in `SMS_DEV_ALLOWED_NUMBERS` get a real SMS; any other number takes the
  console path (code printed to the log, flagged "not in SMS_DEV_ALLOWED_NUMBERS"). Production sends to
  every number, unless `SMS_ALLOWLIST_ONLY=true` (demo deployments, e.g. the Render Blueprint): then the
  allow-list applies in production too, and startup logs one warning.
* `checkBalance()` → `{ balance, low, threshold, checkedAt, cached, error? }` via
  `apirequest=CreditCheck&route=SMS_ROUTE` (5-minute cache, failures cached 1 minute; warning log when
  `balance < SMS_LOW_BALANCE_THRESHOLD`). Registered as the `sms` check in `shared/systemStatus.ts`:
  the **platform module** should read `getSystemStatus()` (or `smsStatus()` from
  `shared/notifications`) for the Super Admin health view.
* `console` (development only; refused in production): prints the rendered message to the log.

**Parent OTP policy** (auth module, `otp.ts`; `config.sms.otp`): expiry `SMS_OTP_EXPIRY_MIN`,
attempts `SMS_OTP_MAX_ATTEMPTS`, resend cooldown `SMS_OTP_RESEND_SECONDS` (also returned as
`expiresInSeconds` / `resendAfterSeconds`), per-phone daily cap `SMS_OTP_DAILY_CAP` per Asia/Kolkata
calendar day (KV `auth:otp-daily:<day>:<hash>`, identical for unknown numbers → `429 RATE_LIMITED`,
`details.reason = OTP_DAILY_CAP`, `Retry-After` until local midnight), global circuit breaker
`SMS_OTP_GLOBAL_DAILY_CAP` counted atomically on real provider sends (KV `sms:otp-global-sends:<day>`;
once reached: one error log per day and a generic `503 SERVICE_UNAVAILABLE` for every number). Checks
that exist only for registered numbers never change the answer (enumeration): the DB cooldown inside
`otp_request` (hit when the KV cooldown was lost or expired first) and losing the breaker race after
the registration lookup both return the normal `202` without sending. The SMS is sent asynchronously,
so delivery failures are logged and never change the response.
`computeRoute(stops)` returns Google Routes polylines (stops as intermediates, >27 stops chunked) or
a flagged straight line (`source: 'straight'`, `fallbackReason`). `projectOnPolyline` gives progress,
remaining distance and deviation for ETA v1 (BP §9.5).

## 16. Tests

* `npm test` runs every `tests/**/*.test.ts` sequentially (`fileParallelism: false`). `globalSetup`
  resolves the test database (must contain `test`, must be local), creates it if missing, drops and
  recreates schema `public`, applies all migrations as the owner and provisions the dedicated
  **`wimb_test_app`** role (`LOGIN NOBYPASSRLS`) with the real grants. Runtime code (`getAppPool`,
  `withTenant`, HTTP tests) therefore runs **under RLS**.
* Use a private database per agent/branch:
  `TEST_DATABASE_URL=postgresql://postgres@localhost:54329/whereismybus_test_<name> npm test`.
* Go-live check on the hosted Neon test database: `node tests/qa/neon/run-neon.mjs [file,file…]` runs a
  representative subset (tenancy/RLS, auth, tracking, trips, files, collation) against `TEST_DB_NAME`
  from `.env` (must contain `test`; secrets are masked in the output) and resets only that
  database's `public` schema.
* Helpers: `tests/helpers/db.ts` (`ownerQuery` for fixtures, `appPool`, `truncateAll`, `closeDb`),
  `tests/helpers/auth.ts` (`createSessionStore()` — real JWTs over an in-memory `SessionLoader` for
  middleware/socket unit tests), `tests/helpers/testEnv.ts` (test env: local storage, no Redis/SMTP/
  Google/Firebase, console SMS with every WebPay credential blanked and a pinned OTP policy, rate
  limits off unless `RATE_LIMIT_ENABLED=true`, `ALLOW_REMOTE_DEV_DB=false` even when `.env.local`
  sets it, so the remote-database guards are always exercised). SMS provider tests inject a fake `fetchImpl`
  (`tests/sms.webpay.test.ts`); no test may call the real SMS API.
* Module suites (contract §12) use **two-school fixtures**: create School A and School B with identical
  codes (`R1`, `Stop 1`, same names) through owner inserts or the module's own service, sign real
  sessions through the auth module, then assert for **every** endpoint that A's token with B's ids
  returns 404, that bodies carrying `school_id` are ignored, that parents switch schools only through
  `X-School-Id`, that socket joins and file URLs across schools are refused, and that the app role
  without context sees zero rows. Job handlers are called directly (exported functions).
* `afterAll(closeDb)` in every file that touches the database.

## 17. Migrations and the core schema

* `migrations/NNN_snake_case.sql`, one transaction per file, applied in order under
  `pg_advisory_xact_lock`; applied files are immutable (checksum); no `BEGIN/COMMIT`, no
  `CONCURRENTLY`. Reserved ranges (contract §15): `001–099` core/tenancy/auth/platform ·
  `100–199` school/users/staff · `200–299` buses/files · `300–399` routes/stops/schedules ·
  `400–499` students/parents · `500–599` trips/tracking · `600–699` alerts/notifications ·
  `700–799` fuel/maintenance/reports/announcements.
* **The full BP §6.2 schema already exists** (001–014; 015 adds the parent-identity privacy functions): platform users/settings, schools (+
  institution type, tenant/storage hooks), subscriptions, school settings (+ `features`,
  `parent_visibility`), holidays, announcements, users, staff + documents, parent accounts + school
  parents, students + links + assignments, buses + images + documents + staff/route assignments,
  routes, stops (`geom` STORED), schedules, trips, odometer evidence, `location_points` (monthly
  partitions), stop events, alerts, fuel/maintenance logs, notification preferences/events, parent
  inbox, devices, sessions, OTP codes, files, idempotency keys, audit logs. Module migrations only
  add what their module still needs — e.g. `900` (refresh-token grace window: encrypted successor token on the
  rotated session row), `901` (privacy: `legal.*` platform settings + school overrides, `school_legal_terms()`,
  `public_school_branding()`, `parent_consents` with `parent_accept_consent()`, erasure markers and the
  `school_redact_parent_consents()` / `school_erase_parent_account()` functions), `925` (`trip_device_events`: every driver-app device event of a
  trip, the trip timeline; alert types `location_permission` and `clock_drift`) and `926` (location retention
  end to end: `location_retention_cutoffs()`, device-event coordinates purged with the GPS history).
* Conventions (catalog tests enforce most): `uuid_v7()` keys, `timestamptz`, `citext` emails, enums as
  `text + CHECK` mirroring `@wimb/shared`, generated columns `STORED`, **composite tenant foreign keys**
  `(school_id, x_id) → x(school_id, id)` (every referenced tenant table has `unique (school_id, id)`),
  an index leading with `school_id` for list screens, `apply_updated_at(table)` for `updated_at`.
  Name-like text columns (`…name`, `…title`, `…code`, `…label`, `…_snapshot`, plus a few other
  human-entered values) use the ICU collation `en-US-x-icu` (migration `850`): the Neon databases default
  to code-point `C.UTF-8`, which would sort `Zara` before `aarav`. Migration 850 converts columns that
  exist when it runs; a later migration adding such a column must declare `collate "en-US-x-icu"`
  (`tests/qa/collation.test.ts` fails otherwise).
  Validity windows are half-open: `valid_from` inclusive, `valid_to` **exclusive** (`NULL` = open);
  an omitted `student_assignments.valid_from` / `school_subscriptions.valid_from` becomes the row's
  school-local date (trigger; never `current_date`, which follows the session TimeZone);
  `school_holidays.end_date` and `trip_schedules.valid_to` are inclusive calendar days.
* **Every new table with `school_id` must call `select apply_tenant_rls('t');` and
  `select apply_parent_scope('t', '<predicate>' [, writable]);`** (`'false'` hides it from parents,
  `'true'` = school-wide read-only). `tests/schema.rls.test.ts` fails otherwise. Parent predicates may
  sub-select other RLS tables (their policies apply — e.g. `bus_id in (select b.id from buses b)`).
* RLS model: `tenant_isolation` (school), platform policies (`schools`: super admin all / own school
  read, profile-only update guarded by a trigger; `platform_users`/`platform_settings`: super admin,
  public settings readable; `parent_accounts`: own row or linked school; `school_subscriptions`:
  super admin writes; `audit_logs`: school rows + platform rows for super admins, readable only by
  admins/jobs), `own_rows` for school-less sessions/devices/idempotency keys and the parent inbox — `parent_accounts`
  is a global identity: schools READ the parents linked to them but never update it (phone corrections via
  `school_update_parent_phone`), and a column guard trigger limits ordinary updates to `display_name`,
  `preferred_language`, `password_hash` and the sign-in counters,
  `self_or_admin` (drivers/conductors see only their own sessions/devices), restrictive
  `parent_scope`. `definer_access` (targets only the owner role) lets SECURITY DEFINER functions
  through FORCE RLS; owner sessions (seeds) get the same only with `actor_role = 'system'`
  (the seed runner's default context) — the app role can never use it.
* Constraint names to map with `registerConstraintError`: `one_active_trip_per_bus` (built in),
  `one_active_trip_per_driver`, `one_active_trip_per_conductor`, `trips_client_start_id_key`,
  `trips_schedule_date_uq`, `one_primary_driver`, `bus_staff_assignments_no_overlap` (23P01),
  `one_open_assignment`, `student_assignments_no_overlap` (23P01), `stops_route_sequence_uq` (23P01,
  deferrable — reorders in one statement work), `alerts_dedupe`, `notification_events_dedupe` (per
  student), `notification_events_trip_dedupe` (trip-level events, `student_id` NULL),
  `bus_documents_one_current`, `staff_documents_one_current`, `users_admin_email_uq`,
  `users_staff_phone_uq`, `users_staff_username_uq`, `buses_code_uq`, `buses_registration_uq`,
  `routes_code_uq`, `students_admission_uq`, `trip_odometer_evidence_one_per_kind`.
* Never grant in migrations — `npm run db:setup-roles` grants the app role on whatever exists
  (INSERT/SELECT-only `audit_logs`, SELECT-only `schema_migrations` and extension tables, EXECUTE on
  routines except the owner-only `apply_*` helpers, SECURITY DEFINER functions revoked from PUBLIC)
  and sets default privileges; run it after every `npm run migrate` (deploy step; tests do it).
* Tests: `tests/helpers/factories.ts` has a factory per table, `twoSchoolFixture()` (two schools with
  identical codes/names — R1, Route 1, Stop 1, Aarav Sharma — bus R2 unrelated to the parent, and a
  parent linked in both schools) and `contexts.*` builders for `withTenant`. `truncateAll({ keep })`
  never touches `spatial_ref_sys`.

## 18. Operations

* Deployment (Render Blueprint `render.yaml` at the repo root: ONE native Node web service, no
  `rootDir`, `SINGLE_INSTANCE=true` — no Docker, no Redis, no worker; the Neon demo database
  `whereismybus_dev`; Vercel for the web app; private Linode bucket): `docs/DEPLOY_VERCEL_RENDER.md` and
  `docs/DEPLOYMENT.md`. Check the config with `node scripts/check-render-config.mjs` (`--self-test`,
  `--env-file .env.render.local`) and the bucket with `node scripts/check-s3-private.mjs`.
* CI (`.github/workflows/ci.yml`), local PostgreSQL + PostGIS (no containers), k6 load tests
  (`scripts/load/`) and observability: `docs/OPERATIONS.md`. Privacy roles, retention and data requests
  (export, erasure, consent — `docs/api/privacy.md`): `docs/PRIVACY.md`.
* API: `npm start` (HTTP + Socket.IO; with `JOBS_IN_PROCESS=true` also the jobs). Render runs
  `npm run release && npm start`. Production without `REDIS_URL` needs `SINGLE_INSTANCE=true`
  (+ `JOBS_IN_PROCESS=true`): one instance, in-process state, one startup warning. Worker (multi-instance
  setups with Redis only; refused in single-instance mode): `npm run start:worker`. Both refuse to boot when a
  migration is pending (checked as the app role) and shut down gracefully on SIGINT/SIGTERM (jobs →
  sockets/HTTP → storage/email → pools → Redis, bounded by 20 s).
* `GET /healthz` (liveness, no I/O) and `GET /readyz` (app-pool ping, Redis ping when configured,
  pending migrations) at the root. `GET /metrics` (root, bearer `METRICS_TOKEN`, `404` without it): Prometheus
  text format for the API (plus a separate worker's snapshot, when one runs; DEPLOYMENT.md §15). Unexpected 5xx, job failures and
  crashes go to Sentry when `SENTRY_DSN` is set (scrubbed; DEPLOYMENT.md §11.8). Non-fatal signals (SMS credit balance) live in
  `getSystemStatus()` for the platform module.
* SMS credits: OTPs consume credits on the WebPay Services **OTP route** (`SMS_ROUTE=OTP`). Watch the
  `SMS balance is low` warning / `sms` status check and recharge before it reaches zero ("Low SMS
  Balance" makes every send fail with `LOW_BALANCE`). `SMS_OTP_GLOBAL_DAILY_CAP` bounds the worst-case
  daily spend; when it trips, parents get `503` until local midnight (raise the cap and restart, or
  wait).
* Logs are pino JSON with `requestId`, `schoolId`, `actorId`, `role` bindings; auth headers, cookies,
  passwords, OTPs, tokens and connection strings are redacted.
