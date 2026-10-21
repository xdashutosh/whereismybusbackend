# Deployment — index and reference

Production = **Vercel** (web admin) + **Render** (one native Node web service: API, Socket.IO and jobs; no
Docker, no Redis) + **Neon** PostgreSQL 18 +
**Linode** Object Storage + **WebPay Services** SMS + **Google Maps Platform** (+ optional Firebase push).

| Read | When |
|---|---|
| [../MORNING_CHECKLIST.md](../MORNING_CHECKLIST.md) | the short list of what you must do by hand, with the expected result of each step |
| [DEPLOY_VERCEL_RENDER.md](DEPLOY_VERCEL_RENDER.md) | **the step-by-step first deploy** (GitHub → Render Blueprint → Vercel → CORS → smoke test → first Super Admin → first school) |
| this page | the reference behind it: topology, every environment key (§11), Neon, single-instance mode, S3, Google, SMS, push, monitoring, security (§16), mobile release (§7), alternatives (§10) |
| [OPERATIONS.md](OPERATIONS.md) | CI, local services, health checks, load tests, observability gaps |
| [PRIVACY.md](PRIVACY.md) | DPDP roles, DPA, privacy policy URL for the store listings |
| [QA_REPORT.md](QA_REPORT.md) | what was tested before go-live and the known limitations |

**Current deployment target (demo):** the Render Blueprint points at the seeded Neon database
`whereismybus_dev` (4 schools, 24 buses, 156 students, 100 trips; 30 migrations), shared with local
development. `whereismybus` (empty production database with the go-live Super Admin) and `whereismybus_test`
(Neon test subset) also exist. Every Render start runs `npm run release` first, so any pending migration is
applied before the API listens. Switching to a clean database for real schools: DEPLOY_VERCEL_RENDER.md §14.

## Topology

```
 Browser ──https──► Vercel  (admin/dist, SPA)                        Flutter apps
   │                  │  /api/*  ── rewrite (same origin) ──┐            │ https + wss
   │                  │                                     ▼            ▼
   └──── wss (Socket.IO, bearer token) ───────────────► Render web "whereismybus-api"  (native Node, ONE instance:
                                                            │     HTTP + Socket.IO + in-process jobs, SINGLE_INSTANCE=true)
                                                            ├── Neon PostgreSQL 18, us-east-1, -pooler host (owner + wimb_app roles)
                                                            ├── Linode Object Storage in-maa-1 (PRIVATE bucket, presigned URLs only)
                                                            └── WebPay Services SMS (OTP route) · Google Routes API · FCM
```

Four independent repositories, checked out side by side in one workspace folder (paths here are written from
it): `backend/` (this repo, Render), `admin/` (Vercel), `driverapp/`, `parentapp/` (Flutter).
Deployment files: `backend/render.yaml` (Render Blueprint at the backend repo root, one web service, no
`rootDir`), `admin/vercel.json` (Vercel project config at the admin repo root), `admin/.env.production.example`,
`driverapp/env/prod.example.json` and `parentapp/env/prod.example.json`,
`backend/scripts/check-render-config.mjs` (checks render.yaml and CI against the backend code, and that no
Docker files exist), `admin/scripts/check-vercel-config.mjs` (the Vercel half),
`backend/scripts/check-s3-private.mjs` (proves the bucket is private).

Why the web app calls the API through Vercel: the web refresh token lives in the httpOnly cookie
`wimb_rt` (`SameSite=Strict`, path `/api/v1/auth`, `backend/src/modules/auth/policy.ts`). `vercel.app`
and `onrender.com` are both on the Public Suffix List, so `*.vercel.app` → `*.onrender.com` is
**cross-site** and the browser would never send that cookie: every reload or 15-minute token expiry
would sign the user out. Proxying `/api/*` keeps the API same-origin, so the Strict cookie works and
no CORS preflight is needed. Socket.IO cannot go through a Vercel rewrite (no WebSocket proxying); it
connects to Render directly and authenticates with the bearer access token, which needs no cookie.

---

## 1. Order of work

1. Make the bucket private (§2) and keep the credentials in `backend/.env` only (§16).
2. Neon is ready (§3): the Blueprint uses the seeded demo database `whereismybus_dev`.
3. Render: one click — the **Deploy to Render** button in the backend README.md, or New → Blueprint (§4) — fill the
   `sync: false` values (`backend/.env.render.local`, Render's "Add from .env"), deploy, note the API URL,
   e.g. `https://whereismybus-api.onrender.com`.
4. Put that URL into `admin/vercel.json` if it differs, then create the Vercel project (§5).
5. Set `CORS_ORIGINS` / `APP_PUBLIC_URL` on Render to the final Vercel origin (restarts automatically).
6. Smoke test (§8), Super Admin sign-in (§3.3), demo or onboard a school (DEPLOY_VERCEL_RENDER.md §10).
7. Mobile release builds against the Render URL (§7).

CI (`.github/workflows/ci.yml`) should be green before a deploy: set Render's Auto-Deploy to **After CI
checks pass** and protect the default branch with the CI jobs as required checks. Before pushing a change to
`render.yaml` or CI run:

```
node backend/scripts/check-render-config.mjs             # exit 0 = consistent
node backend/scripts/check-render-config.mjs --self-test # proves every check catches its regression
```

## 2. Linode Object Storage — private bucket (blocking)

BP §12 and contract §Files: **private bucket only, no public ACLs; files are never public**. Uploads go
through the API (web) or presigned PUT (mobile); downloads are short-lived presigned GET URLs.

**Current problem.** `node scripts/check-s3-private.mjs` (writes and deletes one probe object under
`whereismybus/_probe/`) reported on 2026-10-19: anonymous GET, LIST and PUT all succeed, bucket ACL
`AllUsers READ` + `AllUsers WRITE`, bucket policy `PublicReadGetObject`. The bucket is **shared with about
65 other projects' folders**, so changing its ACL may break their public URLs.

Recommended — a dedicated bucket (nothing has to move: the production prefix is empty):

1. Linode Cloud Manager → Object Storage → **Create Bucket**, region `in-maa-1` (Chennai), e.g.
   `whereismybus-prod`. New buckets are private (ACL **Private**, no policy). Never enable public read.
2. **Access Keys → Create Access Key → Limited Access**: Read/Write on that bucket only.
3. Set `AWS_BUCKET_NAME`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` on Render and in `backend/.env`
   (keep `S3_ENDPOINT=https://in-maa-1.linodeobjects.com`, `S3_KEY_PREFIX=whereismybus/`).
4. **Revoke the old access key** (it was shared in chat and can read every project in the old bucket).
5. `node scripts/check-s3-private.mjs` must print `Bucket is private`.

Alternative — lock down the shared bucket (only if nothing else depends on its public URLs): bucket →
**Access** → ACL **Private**, then delete the policy (`s3cmd delpolicy s3://<bucket>`). Re-run the check.

**Key layout.** Every object key starts with `S3_KEY_PREFIX` (`whereismybus/`), then
`schools/{schoolId}/…` — a school's files never share a prefix with another school's.

**CORS.** Not needed for the web admin (uploads go through the API; images are plain `<img>` loads of
presigned URLs, allowed by the CSP `img-src`) nor for the native apps (a presigned PUT from Android/iOS is
not a browser request). Only if you publish the Flutter apps **as web builds** do they PUT to presigned
URLs from a browser; then add a bucket CORS rule: `AllowedOrigin` = those app origins, `AllowedMethod`
`PUT` (+ `GET`), `AllowedHeader` `content-type` and `x-amz-*`, `ExposeHeader` `ETag`, `MaxAgeSeconds` 3000.

**Lifecycle for `*.part`.** A presigned upload is staged at `<key>.part` until `POST /files/:id/complete`
moves it. The hourly `files-staging-cleanup` job (in the API process) deletes `.part` objects older than 24 hours. As a
backstop, add a bucket lifecycle rule that expires objects under `whereismybus/` whose key ends in
`.part` after 2 days (Linode lifecycle rules match by prefix; if suffix filters are not available, rely on
the job and check the bucket monthly with a listing of `*.part`). Never expire the whole prefix.

## 3. Neon PostgreSQL 18

Use the **pooler** host (`…-pooler.us-east-1.aws.neon.tech`, PgBouncer transaction mode) for `DB_HOST`.
The backend is pooler-safe: tenant context is transaction-local (`set_config(…, true)`), advisory locks
are transaction-scoped, no session state, no LISTEN/NOTIFY, no named prepared statements.
Databases: `whereismybus_dev` (seeded demo data: the Render Blueprint **and** local dev), `whereismybus`
(empty production database for real schools later), `whereismybus_test` (Neon test subset). Never touch `neondb` / `postgres`.

### 3.1 Roles
- **Owner** (`DB_USER`/`DB_PASSWORD`, the Neon project role): runs migrations, `db:setup-roles`,
  `db:bootstrap`, seeds. Never used for requests.
- **App** (`DB_APP_USER`, `wimb_app`, + `DB_APP_PASSWORD`): `LOGIN NOBYPASSRLS`, used by the API for every request, so row-level security applies to all tenant data. **Let `db:setup-roles`
  create it** — never in the Neon console (console roles join `neon_superuser`, which `setupRoles`
  refuses). Production refuses to start without an app role distinct from the owner.
- The app role is per Neon **branch**, so `whereismybus`, `whereismybus_dev` and `whereismybus_test`
  share `wimb_app` and its password. For a separate runtime credential, move dev/test to another Neon
  branch or project.

### 3.2 Migrations on every start
Render's start command is `npm run release && npm start`; `release` =
`node dist/db/migrate.js up && node dist/db/setupRoles.js && node dist/db/bootstrap.js`. Running it at start
(not as a pre-deploy step) also works on Render's Free plan. All three are idempotent and take a few seconds
when nothing is pending (`No pending migrations`, `already exists (unchanged)`); a failing release never starts
the API. The API refuses to boot while a migration is pending, and `/readyz` lists pending migrations. Never
edit a migration that already ran (checksum mismatch) — add a new one. Always run `db:setup-roles` after
`migrate` (new tables need the app role's grants). Manual equivalent from your Mac (owner credentials in
`backend/.env`, with `backend/.env.local` moved aside so it cannot switch the database):
`cd backend && NODE_ENV=production SINGLE_INSTANCE=true JOBS_IN_PROCESS=true npm run migrate &&
NODE_ENV=production SINGLE_INSTANCE=true JOBS_IN_PROCESS=true npm run db:setup-roles`.

### 3.3 First Super Admin (`npm run db:bootstrap`)
Inserts missing `platform_settings` defaults and creates the Super Admin `PLATFORM_ADMIN_EMAIL` **only
if no platform user has that e-mail**, with `PLATFORM_ADMIN_INITIAL_PASSWORD`, a forced password change
and TOTP not enrolled. It never changes a used admin and never adds demo data. When the only platform user
is the never-used placeholder `superadmin@example.com`, it moves that account to `PLATFORM_ADMIN_EMAIL`
instead (keeping its password). Production refuses the placeholder e-mail itself. On the demo database
see DEPLOY_VERCEL_RENDER.md §3 step 4.

### 3.4 Backups, restore and branches
- Neon keeps a point-in-time restore window (plan-dependent; check Project → Settings → History
  retention and raise it to at least 7 days for production).
- **Test a restore before onboarding real schools**: Neon console → Branches → create a branch from a
  past timestamp → connect with `psql` → check counts → delete the branch.
- Use a branch for risky migrations: branch production, run `npm run migrate` against the branch,
  check, then deploy. Restoring = resetting the main branch from a point in time (Neon "Restore").
- Weekly logical export as an extra copy: `pg_dump --format=custom` with the owner URL, stored outside
  Neon (encrypted).

### 3.5 Rotating database passwords
- Owner: Neon console → Roles → reset password → update `DB_PASSWORD` in `backend/.env` and on Render.
- App role: generate `openssl rand -hex 32`, set `DB_APP_PASSWORD` in `backend/.env` and on Render, then
  redeploy — the start command's `db:setup-roles` runs `ALTER ROLE … PASSWORD` with the new value.
  (Locally: `npm run db:setup-roles` against each Neon database that the role serves.)

## 4. Render (backend)

### 4.1 The Blueprint (`render.yaml`)

One resource, no Docker, no Key Value/Redis, no worker, no environment groups:

| Resource | Type | Commands |
|---|---|---|
| `whereismybus-api` | Web Service, native **Node** runtime (`NODE_VERSION` 24.11.1), region Virginia (next to Neon us-east-1), plan `starter`, `numInstances: 1`, no `rootDir` (render.yaml is at the backend repo root) | build: `npm ci --include=dev && npm run build` · start: `npm run release && npm start` · health check `/healthz` · auto-deploy on |

- No `rootDir`: the backend repo is self-contained (its `shared/` copy is vendored and built by
  `postinstall`/`prebuild`) and `render.yaml` sits at its root, so Render builds the whole repo.
- `--include=dev` because TypeScript is a dev dependency and `NODE_ENV=production` would skip it.
- `/healthz` = liveness (the process listens only after config, app-role and migration checks pass);
  `/readyz` (DB + migrations; `redis` reported as `skipped`) is for monitoring.
- Secrets are `sync: false`: Render asks for them once when the Blueprint is created.
  `backend/.env.render.local` (git-ignored) holds exactly those keys for Render's **Add from .env**.
- `JWT_ACCESS_SECRET` is entered, not generated: local development and Render share the demo database,
  and TOTP secrets in it are encrypted with a key derived from this value (§11.4).

### 4.2 Single-instance mode (no Redis)
`SINGLE_INSTANCE=true` (requires `JOBS_IN_PROCESS=true`) lets production run without `REDIS_URL`. The API
then uses its in-process implementations — the same ones local development uses without Redis — for rate
limits, live bus state, idempotency, pub/sub, the Socket.IO adapter and the job scheduler/queues. The start
log warns once: `single-instance mode: run exactly one instance; live state and rate limits reset on restart`.

- **Exactly one instance**: never scale out or enable autoscaling (each instance would have its own state
  and run every scheduled job). `npm run start:worker` refuses to start in this mode.
- A restart or deploy clears live positions, rate-limit counters and queued jobs (live state rebuilds
  within seconds from new GPS points; schedules re-register at boot).
- Without `SINGLE_INSTANCE`, production still refuses to start without `REDIS_URL`. Scaling beyond one
  instance later = add a Redis (`REDIS_URL`), a worker process with `JOBS_IN_PROCESS=false`, and drop
  `SINGLE_INSTANCE`.

### 4.3 SMS allow-list for demos
`SMS_ALLOWLIST_ONLY=true` (set in `render.yaml`) applies `SMS_DEV_ALLOWED_NUMBERS` in production too: only
those numbers get a real SMS; for any other number the OTP is written to the server log and WebPay is not
called. The start log warns once. Set it to `false` before real parents use the system.

## 5. Vercel (web admin)

1. Vercel → **Add New → Project** → import the **admin** repository → **Root Directory = the repo root**
   (self-contained: its `shared/` copy is inside it). Install (`npm ci --include=dev`; postinstall builds
   `./shared`), build commands and output come from `vercel.json` at the admin repo root.
2. Environment variables (Production and Preview; Vite bakes them in at build time — redeploy after a
   change): `VITE_API_BASE_URL` = `/api/v1` or unset, `VITE_SOCKET_URL` = the Render API origin,
   `VITE_GOOGLE_MAPS_API_KEY`, optional `VITE_GOOGLE_MAPS_MAP_ID` (details in §11).
3. `admin/vercel.json`, in order: `/api/:path*` → `https://whereismybus-api.onrender.com/api/:path*`,
   then everything except `/assets/*` → `/index.html` (SPA deep links). If Render gave the service another
   hostname, change that destination **and** the CSP `connect-src` (`https://…` + `wss://…`), then run
   `node scripts/check-vercel-config.mjs` in the admin repo (rewrite destinations cannot read environment variables).
4. Headers: CSP (Google Maps, UI5 fonts, Socket.IO to Render, Linode presigned images), HSTS,
   `nosniff`, `X-Frame-Options: DENY`, strict referrer policy; `index.html` and SPA routes `no-cache`;
   hashed `/assets/*` cached for a year; `/api` never cached by the CDN.
5. After the first deploy set `CORS_ORIGINS` and `APP_PUBLIC_URL` on Render to the production origin.
   Preview deployments: REST works through the rewrite; the live socket needs the preview origin in
   `CORS_ORIGINS` or a `CORS_ORIGIN_PATTERNS` regex.

## 6. Client IPs and `TRUST_PROXY`

`TRUST_PROXY=1`: Express trusts exactly one hop — Render's load balancer. Higher values are refused by the
check script: phones, sockets and direct callers of `*.onrender.com` pass one proxy only, so `2` would let
a client choose the IP its per-IP limits and audit entries use.

Trade-off of the Vercel rewrite: web requests reach Render from Vercel's egress IPs, so for web traffic
`req.ip` is a Vercel address. Mitigations in the code: signed-in requests are rate-limited **per account**
(`globalBucket`, `backend/src/middleware/rateLimits.ts`), refresh per refresh token; sign-in is protected
by the per-account lockout (5 failures → 15 min), the login limiter (IP + e-mail), per-phone OTP limits and
the global daily SMS cap. The per-network `loginIp` limiter (30 failures / 15 min) is shared by web users
behind one Vercel IP. Audit-log IPs of web actions show a Vercel address; mobile and socket traffic shows
real IPs. Custom domains (§9) remove the trade-off.

## 7. Mobile apps — release notes

**Build-time configuration** (`--dart-define`, never hard-coded; template `env/prod.example.json` in each app
repo → copy to `env/prod.json`, git-ignored):

```bash
cd driverapp             # then the same in parentapp
cp env/prod.example.json env/prod.json      # API_BASE_URL=https://whereismybus-api.onrender.com, GOOGLE_MAPS_KEY=…
flutter build appbundle --release --dart-define-from-file=env/prod.json   # Android → Play Console
flutter build ipa       --release --dart-define-from-file=env/prod.json   # iOS → App Store Connect (Mac + Xcode)
```

`API_BASE_URL` is the origin without `/api/v1`. A release build whose `API_BASE_URL` is empty or not
`https` refuses to start with a configuration message. Mobile clients send the refresh token in the body,
so they do not depend on the cookie.

**Signing.** Release tasks fail without `android/key.properties` (upload keystore); keep the keystore and
its passwords outside the repo and backed up — losing it means a new Play listing unless Play App Signing
is enabled (enable it). iOS: distribution certificate + provisioning profiles in Xcode.
Application IDs: `com.whereismybus.driver`, `com.whereismybus.parent`.

**Driver app permissions and store policies.**
- Android: `ACCESS_FINE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE` +
  `FOREGROUND_SERVICE_LOCATION`, `POST_NOTIFICATIONS`, `CAMERA`, `WAKE_LOCK`. The app asks in the order
  notifications → location while in use → (after an **in-app prominent disclosure**) all the time.
- Google Play: fill in the **background location declaration** (core feature: "tracks the school bus
  only during an active trip so parents and the school see its position") with a short video of the
  disclosure and a trip; the **foreground service type** declaration (location); the Data safety form
  (precise location, phone number, photos — collected, shared with the school, encrypted in transit).
- iOS: `NSLocationWhenInUseUsageDescription`, `NSLocationAlwaysAndWhenInUseUsageDescription`,
  `NSCameraUsageDescription` and background mode *location updates* — App Review expects the texts to
  say tracking happens only during trips. A significant-change fallback relaunches tracking after the
  OS kills the app.
- Both stores need the **privacy policy URL** (PRIVACY.md) and a test account for review (a demo school
  on a separate staging setup, never real children's data).

**Parent app:** no background location; push notifications (optional Firebase, §14), phone number + OTP
sign-in (store reviewers need a test number whose OTP you can give them — use a password-fallback
test account instead).

## 8. Post-deploy smoke test

1. `https://<api>.onrender.com/healthz` → `status: ok`; `/readyz` → ready (DB and migrations; `redis`
   `skipped`). The start log shows the release step (migrations, roles, bootstrap), the two expected
   warnings (single-instance mode, SMS allow-list) and `HTTP + Socket.IO listening`.
2. `https://<app>.vercel.app/api/v1/auth/me` → JSON `401` from the API (not a Vercel 404); opening
   `https://<app>.vercel.app/school/trips` directly → the sign-in page.
3. Sign in as a school admin, **reload** → still signed in (`wimb_rt` cookie on the Vercel host, path
   `/api/v1/auth`, `HttpOnly`, `Secure`, `SameSite=Strict`).
4. Start a trip from the driver app → the bus moves on `/school/live-fleet`; DevTools → WS shows
   `wss://<api>.onrender.com/socket.io/…` with 101.
5. Upload a bus photo and an 8–10 MB document from the web. Vercel may cap proxied bodies at ~4.5 MB; a
   413 means: keep web uploads smaller or use custom domains (§9).
6. Parent app: OTP to a number in `SMS_DEV_ALLOWED_NUMBERS` arrives by SMS; any other number's code is in
   the Render log (§4.3).
7. `node backend/scripts/check-s3-private.mjs` → `Bucket is private`.
8. Audit-log IPs as described in §6.

## 9. Option B — custom domains (recommended once you own a domain)

`app.example.com` → Vercel and `api.example.com` → Render are **same-site**, so the browser sends the
Strict cookie on direct calls, uploads go straight to Render (no proxy body limit) and every IP is real.

- Vercel: `VITE_API_BASE_URL=https://api.example.com/api/v1`, `VITE_SOCKET_URL=https://api.example.com`
  (dashboard, never a committed file), add `https://api.example.com wss://api.example.com` to the CSP
  `connect-src`. Keep the `/api` rewrite (the `*.vercel.app` URL keeps working).
- Render: custom domain on `whereismybus-api`; `CORS_ORIGINS=https://app.example.com`,
  `APP_PUBLIC_URL=https://app.example.com`, `TRUST_PROXY=1` (unchanged).
- Mobile: rebuild with `API_BASE_URL=https://api.example.com`. Google browser key: add the new referrer.

`admin/scripts/check-vercel-config.mjs` refuses an absolute `VITE_API_BASE_URL` committed into the repo — set it in Vercel.

## 10. Alternative hosts

The backend is a plain Node 24 app: any host that runs Node works with the same commands as Render —
`npm ci --include=dev && npm run build`, then `npm run release && npm start` with the environment of §11
(keys outside the repo). Put a TLS reverse proxy with WebSocket upgrade in front, set `TRUST_PROXY=1` (one
proxy hop), and keep one instance with `SINGLE_INSTANCE=true` unless you add Redis (§4.2). The web app is
static: any CDN/static host works if it supports the `/api` rewrite and the SPA fallback.

## 11. Environment checklist (every key)

Where: **R** = Render service `whereismybus-api` (**R·fixed** = value already in `render.yaml`,
**R·secret** = `sync: false`, you paste it once, **R·auto** = set by Render, **R·add** = not in
`render.yaml`, add it on Render when you need it), **V** = Vercel
project env, **F** = Flutter `--dart-define` (`env/prod.json`), **local** = `backend/.env` /
`.env.local` only. Templates: `backend/.env.example`, `admin/.env.production.example`,
`driverapp/env/prod.example.json`, `parentapp/env/prod.example.json`. Production refuses to boot on unsafe values (the deploy log lists them).

### 11.1 Backend — runtime and web

| Key | Meaning | Production value | Where |
|---|---|---|---|
| `NODE_ENV` | mode; `npm start` forces production | `production` | R·fixed |
| `NODE_VERSION` | Render's Node runtime | `24.11.1` | R·fixed |
| `PORT` | HTTP port | set by Render | R·auto |
| `CORS_ORIGINS` | bare origins allowed for CORS + Socket.IO | the Vercel origin(s), e.g. `https://whereismybus.vercel.app` | R·secret |
| `CORS_ORIGIN_PATTERNS` | optional anchored regexes (Vercel previews) | empty, or `^https://whereismybus-[a-z0-9-]+-team\.vercel\.app$` | R·add |
| `APP_PUBLIC_URL` | web URL used in e-mailed links | same as the Vercel origin | R·secret |
| `TRUST_PROXY` | proxy hops trusted for the client IP | `1` (never more, §6) | R·fixed |
| `ALLOW_REMOTE_DEV_DB` | lets a non-production backend use a remote DB | unset in production; `true` locally for the Neon dev DB | local |
| `LOG_LEVEL` | pino level | `info` | R·fixed |
| `DEFAULT_TIMEZONE` | default school time zone | `Asia/Kolkata` | R·fixed |
| `JOBS_IN_PROCESS` | run jobs inside the API | `true` | R·fixed |
| `SINGLE_INSTANCE` | production without Redis: one instance, in-process state (§4.2); requires `JOBS_IN_PROCESS=true` | `true` | R·fixed |
| `RATE_LIMIT_ENABLED` | rate limiting (refused `false` in production) | `true` | R·fixed |
| `REDIS_URL` | optional Redis (multi-instance setups only); without it production needs `SINGLE_INSTANCE=true` | **unset** | not used |

### 11.2 Database (Neon)

| Key | Meaning | Production value | Where |
|---|---|---|---|
| `DB_HOST` | Neon **pooler** host | `…-pooler.us-east-1.aws.neon.tech` | R·secret |
| `DB_PORT` · `DB_NAME` · `DB_SSL` · `DB_POOL_MAX` | connection settings | `5432` · `whereismybus_dev` (demo data) · `true` · `10` | R·fixed |
| `DB_SSL_REJECT_UNAUTHORIZED` | verify the server certificate | default `true` | default |
| `DB_USER` / `DB_PASSWORD` | **owner** role (migrations, roles, bootstrap) | Neon project role — rotate (§16) | R·secret |
| `DB_APP_USER` / `DB_APP_PASSWORD` | runtime **app role** (`LOGIN NOBYPASSRLS`) | `wimb_app` / `openssl rand -hex 32` | R·secret |
| `DATABASE_URL` / `DATABASE_APP_URL` | URL alternatives to the `DB_*` keys | leave unset on Render | local |
| `TEST_DATABASE_URL` · `TEST_DATABASE_APP_URL` · `TEST_DB_NAME` | test harness DB (name must contain `test`) | never set in production | local |

### 11.3 Files (Linode Object Storage)

| Key | Meaning | Production value | Where |
|---|---|---|---|
| `STORAGE_DRIVER` | `s3` or `local` (refused `local` in production) | `s3` | R·fixed (local dev: `local`) |
| `S3_PROVIDER` · `AWS_REGION` · `S3_ENDPOINT` | provider, region, endpoint | `linode` · `in-maa-1` · `https://in-maa-1.linodeobjects.com` | R·fixed |
| `S3_KEY_PREFIX` | prefix of every key | `whereismybus/` | R·fixed |
| `AWS_BUCKET_NAME` | bucket | the **private** dedicated bucket (§2) | R·secret |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | limited access key for that bucket only | new key — rotate (§16) | R·secret |
| `STORAGE_LOCAL_DIR` | root of the local driver | unset (default `backend/storage`) | local |

### 11.4 Auth

| Key | Meaning | Production value | Where |
|---|---|---|---|
| `JWT_ACCESS_SECRET` | signs access tokens **and** derives the keys that encrypt TOTP secrets and sign local-storage links | the value in `backend/.env` (local dev shares the demo database); **keep it stable forever** (see below) | R·secret |
| `JWT_ACCESS_KEYS` / `JWT_ACTIVE_KID` | optional signing-key rotation: `kid:secret` pairs (≥ 32 chars) + the kid that signs | unset until you rotate | R (add when rotating) |
| `ACCESS_TOKEN_TTL` · `REFRESH_TOKEN_TTL_DAYS` | token lifetimes | `15m` · `30` | R·fixed |
| `TOTP_ISSUER` | name shown in authenticator apps | `Where Is My Bus` | R·fixed |
| `PLATFORM_ADMIN_EMAIL` | first Super Admin e-mail (bootstrap; in production it refuses the placeholder `superadmin@example.com` and the release step fails) | the real Super Admin e-mail — `backend/.env` still holds the placeholder, so do **not** copy it from there; an e-mail with no account only logs a warning | R·secret |
| `PLATFORM_ADMIN_INITIAL_PASSWORD` | bootstrap password for a new Super Admin | unset; add for one start only when creating a new admin | R·add |
| `SEED_DEFAULT_PASSWORD` | demo seed password | never in production | local |

`JWT_ACCESS_SECRET` must never change once Super Admins have enrolled TOTP: TOTP secrets are encrypted
with a key derived from it (`backend/src/shared/crypto.ts`), so a new value makes every enrolled
authenticator unusable (Super Admin locked out). Keep the value from
`backend/.env` in your password manager. To rotate **token signing** without that impact,
use `JWT_ACCESS_KEYS` + `JWT_ACTIVE_KID`: add the new `kid:secret`, switch `JWT_ACTIVE_KID`, remove the
old kid after one `ACCESS_TOKEN_TTL` (15 min). Kid-less tokens keep verifying with `JWT_ACCESS_SECRET`.

### 11.5 SMS (WebPay Services), push, e-mail, Google

| Key | Meaning | Production value | Where |
|---|---|---|---|
| `SMS_PROVIDER` | `webpayservices` or `console` (refused `console` in production) | `webpayservices` | R·fixed |
| `SMS_API_URL` · `SMS_API_USERNAME` · `SMS_API_KEY` | WebPay HTTP API (https) and account | from WebPay — rotate the key (§16) | R·secret |
| `SMS_SENDER_ID` · `SMS_ROUTE` | DLT sender header; route | your header · `OTP` | R·secret · R·fixed |
| `SMS_DLT_TEMPLATE_ID` · `SMS_OTP_MESSAGE` | DLT template id; text with `{otp}` — **must equal the registered template exactly** | from the DLT portal | R·secret |
| `SMS_OTP_EXPIRY_MIN` · `SMS_OTP_MAX_ATTEMPTS` · `SMS_OTP_RESEND_SECONDS` · `SMS_OTP_DAILY_CAP` · `SMS_OTP_GLOBAL_DAILY_CAP` | OTP policy | `10` · `5` · `60` · `10` · `2000` (keep the expiry equal to the minutes in the template) | R·fixed |
| `SMS_LOW_BALANCE_THRESHOLD` | platform health warns below this OTP-route credit balance | `500` | R·fixed |
| `SMS_DEV_ALLOWED_NUMBERS` | numbers that get real SMS outside production, and in production while `SMS_ALLOWLIST_ONLY=true` | the demo phone(s), e.g. `+919812345678` | R·secret |
| `SMS_ALLOWLIST_ONLY` | demo mode: the allow-list applies in production too; other numbers' OTPs go to the log (§4.3) | `true` for demos, `false` for real schools | R·fixed |
| `FIREBASE_SERVICE_ACCOUNT_B64` | base64 of the Firebase service-account JSON; empty = no push (inbox still works) | optional (§14) | R·add |
| `SMTP_HOST` · `SMTP_PORT` · `SMTP_USER` · `SMTP_PASS` · `MAIL_FROM` | e-mail; empty host = e-mails only logged | optional · `587` | R·add |
| `GOOGLE_MAPS_SERVER_KEY` | Routes API (planned route polylines, ETAs); empty/403 = straight-line fallback | server key restricted to Routes API (§12) | R·secret |

### 11.6 Web admin (Vercel)

| Key | Meaning | Production value | Where |
|---|---|---|---|
| `VITE_API_BASE_URL` | REST base | `/api/v1` or unset — **never** the onrender.com URL | V |
| `VITE_SOCKET_URL` | Socket.IO origin | `https://whereismybus-api.onrender.com` | V |
| `VITE_GOOGLE_MAPS_API_KEY` | Maps JavaScript API browser key | key restricted by HTTP referrer | V |
| `VITE_GOOGLE_MAPS_MAP_ID` | optional Map ID | empty or your Map ID | V |
| `VITE_SENTRY_DSN` | optional Sentry error tracking for the web admin; empty = off (the SDK is not even downloaded). Reports carry no user, cookies, headers, bodies or query strings, and tokens, passwords, OTP codes, e-mail addresses and phone numbers are filtered out; 4xx answers and offline errors are not reported. The DSN is public by design. CSP `connect-src` allows `https://*.sentry.io`; add a self-hosted Sentry host there | empty, or the Sentry project's DSN (`https://<key>@o<org>.ingest.<region>.sentry.io/<project>`) | V |
| `VITE_SENTRY_ENVIRONMENT` | optional Sentry environment name | unset (= `production`), or e.g. `preview` for the Preview environment | V |
| `VITE_PROXY_TARGET` · `VITE_PORT` | Vite dev server only | not used on Vercel | local |

### 11.7 Flutter apps (`--dart-define`)

| Define | Meaning | Production value | Where |
|---|---|---|---|
| `API_BASE_URL` | backend origin (no `/api/v1`); release builds require `https` | `https://whereismybus-api.onrender.com` | F |
| `SOCKET_URL` | Socket.IO origin (defaults to `API_BASE_URL`) | unset | F |
| `GOOGLE_MAPS_KEY` | Maps SDK key (Dart + native) | app key restricted to package/SHA-1 and bundle ID | F (or `MAPS_API_KEY` in `android/local.properties`, `GOOGLE_MAPS_API_KEY` in `ios/Flutter/Secrets.xcconfig`) |
| `FIREBASE_API_KEY` · `FIREBASE_APP_ID` · `FIREBASE_MESSAGING_SENDER_ID` · `FIREBASE_PROJECT_ID` · `FIREBASE_STORAGE_BUCKET` · `FIREBASE_AUTH_DOMAIN` · `FIREBASE_IOS_BUNDLE_ID` | Firebase options for push | optional (§14); set them together | F |

### 11.8 Observability

All optional; nothing breaks without them. Added in the final completion pass: `METRICS_TOKEN`, `SENTRY_DSN`,
`SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` (backend, below) and `VITE_SENTRY_DSN` / `VITE_SENTRY_ENVIRONMENT` (web
admin, §11.6). No other environment keys were added; the privacy policy / terms links and the consent version are
platform settings edited in the Super Admin panel (Global settings → Privacy & legal), not environment keys.

| Key | Meaning | Production value | Where |
|---|---|---|---|
| `METRICS_TOKEN` | bearer token of `GET /metrics` on the API (Prometheus text format, §15); 24+ characters without spaces; empty = the endpoint answers `404` | `openssl rand -hex 32`, also stored in the scraper's config | R·add |
| `SENTRY_DSN` | Sentry DSN for error reports of the API (`https://<key>@<org>.ingest.sentry.io/<project>`); empty = disabled, nothing is sent; `https://` required in production | the backend project's DSN (a separate project from the web's `VITE_SENTRY_DSN`) | R·add |
| `SENTRY_ENVIRONMENT` | environment tag of the reports (letters, digits, `.`, `-`, `_`); default = `NODE_ENV` | default | R·add |
| `SENTRY_RELEASE` | optional release tag (no spaces or `/`), e.g. a git commit sha | empty, or the deployed commit | R·add |

Never reported: request bodies, cookies, query strings, headers other than user agent / content type / request id /
app name and version, the client IP, values under secret or personal-data keys (passwords, tokens, OTPs, phone,
e-mail, names, addresses …) and phone numbers, e-mail addresses, IPs and tokens inside messages
(`backend/src/shared/sentry.ts`). Tests never report (Sentry is forced off under `NODE_ENV=test`).

## 12. Google Maps Platform

Google Cloud Console → APIs & Services (one project, billing enabled, budget alert set):

1. **Enable**: Maps JavaScript API (web admin), Maps SDK for Android, Maps SDK for iOS (apps), **Routes
   API** (backend: road-following planned routes and ETAs via `directions/v2:computeRoutes`).
   **Current state:** the server key in `backend/.env` gets **HTTP 403** from the Routes API (API not
   enabled or not allowed for that key), so the backend uses its **straight-line fallback**: routes are
   drawn stop to stop and flagged `source: 'straight'` (`fallbackReason: 'api_error'`), ETAs use an
   assumed urban speed. Everything works, just less accurately. Enabling Routes API fixes it; existing
   routes pick up road geometry when their stops change or with `POST /school/routes/:id/recompute-polyline`.
2. **Browser key** (`VITE_GOOGLE_MAPS_API_KEY`): HTTP-referrer restriction `https://<app>.vercel.app/*`
   (+ custom domain); API restriction Maps JavaScript API. Use a separate key for `localhost`.
3. **App keys** (`GOOGLE_MAPS_KEY`): Android apps (package `com.whereismybus.driver` /
   `com.whereismybus.parent` + SHA-1 of the **Play App Signing** certificate and of your upload key) and
   iOS apps (bundle IDs); API restriction Maps SDK for Android / iOS.
4. **Server key** (`GOOGLE_MAPS_SERVER_KEY`): API restriction **Routes API only** (Render has no fixed
   egress IP on standard plans, so restrict by API, not IP). Never ship it in a client.
5. The key that was shared in chat must be deleted and replaced by these restricted keys (§16).

## 13. WebPay Services SMS (parent OTP)

- **Route**: OTP route (`SMS_ROUTE=OTP`). Credits are per route — only **OTP-route credits** are used;
  top up that balance. The Super Admin's platform health (`GET /platform/health`, dashboard) shows the
  balance from WebPay's CreditCheck and flags it **low** below `SMS_LOW_BALANCE_THRESHOLD` (500); check it
  weekly or after each school onboarding (a provider "low SMS balance" reply is also logged).
- **DLT (TRAI)**: the sender header, the entity and the content template must be registered on the DLT
  portal. `SMS_OTP_MESSAGE` must equal the registered template **character for character**, with
  `{otp}` where the template has its variable; `SMS_DLT_TEMPLATE_ID` is that template's id. A mismatch
  makes operators drop the SMS silently. If the text mentions minutes, keep it equal to
  `SMS_OTP_EXPIRY_MIN` (startup warns otherwise).
- **Limits** (fixed in `render.yaml`): 10-minute expiry, 5 attempts, 60 s resend cooldown, 10 OTPs per
  phone per day, global circuit breaker of 2000 real sends per day (raise it as schools grow).
- **Production sends real SMS to every number.** `SMS_DEV_ALLOWED_NUMBERS` applies only outside
  production; never run demo seeds (real-looking +91 numbers) against production.
- Parents can also set a password in the app (password fallback) if SMS delivery is a problem.

## 14. Push notifications (Firebase Cloud Messaging) and e-mail

Optional. Without Firebase the in-app inbox still receives every notice; with it, phones get pushes.

1. Firebase console → create a project → add Android apps `com.whereismybus.driver` and
   `com.whereismybus.parent`, and the two iOS apps (upload an APNs auth key under Cloud Messaging).
2. Backend: Project settings → Service accounts → generate a private key → `base64 -i sa.json` → paste
   into `FIREBASE_SERVICE_ACCOUNT_B64` on Render → delete `sa.json` (never commit it).
3. Apps: pass the `FIREBASE_*` defines (§11.7) in `env/prod.json`; native config files
   (`google-services.json`, `GoogleService-Info.plist`) are not needed and are git-ignored.
4. E-mail (`SMTP_*`, `MAIL_FROM`): any SMTP provider (port 587, STARTTLS) with SPF/DKIM set for the
   sender domain. Without it, e-mails are only written to the log.

## 15. Monitoring

- **Render**: health check `/healthz` restarts a dead API; add an external uptime monitor (e.g. every
  1–5 min) on `https://<api>/readyz` (DB, migrations) with e-mail/SMS alerts. Render dashboard:
  CPU/memory, deploy and service logs; enable notifications for failed deploys.
- **Neon**: monitoring tab (connections, compute, storage); alert on storage growth (GPS history is
  partitioned monthly and purged by the retention job).
- **Memory**: in single-instance mode live state lives in the API process; watch its memory in the Render
  dashboard (the in-process store is capped at 100 000 entries).
- **Application**: Super Admin dashboard → platform health (API, DB, jobs heartbeat, SMS balance);
  structured JSON logs (pino) in Render; audit logs per school and for the platform.
- **Web admin errors (optional)**: set `VITE_SENTRY_DSN` on Vercel (§11.6) and redeploy; crash reports
  arrive in Sentry tagged `app=web_admin` with release `whereismybus-web@<version>`, scrubbed of personal
  data and tokens.
- **API errors (optional)**: set `SENTRY_DSN` (§11.8) on Render; unexpected 5xx responses, job
  failures (job name + attempt), unhandled rejections and crashes are reported, tagged `role=api`, scrubbed of
  personal data and secrets. Without the DSN nothing is sent and nothing breaks.
- **Metrics**: set `METRICS_TOKEN` (§11.8) and scrape `https://<api>/metrics` with
  `Authorization: Bearer <METRICS_TOKEN>` (Prometheus, Grafana Agent/Alloy, Grafana Cloud or any OpenMetrics
  scraper; every 15–60 s). Families (labelled `process="api"`; jobs run in the API process): `wimb_http_requests_total`
  `{method,route,status}` and `wimb_http_request_duration_seconds` `{method,route}` (route = the Express pattern,
  never ids), `wimb_socket_connections` / `wimb_socket_connections_total`, `wimb_job_runs_total` `{job,outcome}` and
  `wimb_job_duration_seconds` `{job}`, `wimb_ingest_points_total`, `wimb_sms_sends_total` `{kind,outcome}`,
  `process_uptime_seconds`, `process_resident_memory_bytes`, `nodejs_heap_used_bytes`,
  `nodejs_eventloop_lag_p99_seconds`. Counters restart at 0 on each deploy
  (use `rate()` / `increase()`). Suggested alerts: 5xx rate, p95 latency of the ingest route
  (`/api/v1/driver/trips/:id/locations`), job failures, SMS `failed` outcomes, ingest rate dropping to 0 during
  school hours.
- **Not built yet**: Sentry for the Flutter apps. Load-test numbers: `scripts/load/` (OPERATIONS.md §4).

## 16. Security checklist (before the first real school)

1. **Rotate every credential that was pasted into chat** during development, then update `backend/.env`
   and Render:
   - **Neon** owner password (console → Roles → reset) and the app role password (§3.5);
   - **Linode S3** access key → new limited key on the new private bucket, revoke the old one (§2);
   - **WebPay** API key (WebPay panel → regenerate) → `SMS_API_KEY`;
   - **Google** Maps key → delete it, create the restricted browser/app/server keys (§12);
   - `JWT_ACCESS_SECRET` only **before** anyone enrols TOTP on the demo database (it is shared by
     local dev and Render; change it in both places together).
2. Bucket private: `node backend/scripts/check-s3-private.mjs` → `Bucket is private`.
3. **Super Admin TOTP**: enrol at the first sign-in on the owner's phone, change the initial password;
   keep `PLATFORM_ADMIN_INITIAL_PASSWORD` unset after that.
   Store the TOTP recovery path (a second Super Admin on another person's phone is the safest recovery).
4. **Real schools get a clean database**, not the demo one (DEPLOY_VERCEL_RENDER.md §14); never run
   demo seeds against it (`npm run seed` refuses production without `--force` — never force it).
   Switch `SMS_ALLOWLIST_ONLY` to `false` at the same time.
5. `JWT_ACCESS_SECRET` saved in a password manager and never regenerated (§11.4).
6. `git status` before every commit: no `.env`, `.env.local`, password file, `env/prod.json`, keystore
   or service-account JSON (all git-ignored). The repository on GitHub is **public**: secrets only ever
   live in `backend/.env*` (git-ignored) and on Render.
7. API on exactly one instance (`SINGLE_INSTANCE=true`), `TRUST_PROXY=1`, rate limits on.
8. Google keys restricted, Neon PITR retention ≥ 7 days and a tested restore (§3.4).
9. Privacy: DPA with each school, privacy policy and terms URLs published and set in Super Admin → Global
   settings → Privacy & legal (`legal.privacy_url`, `legal.terms_url`; the apps' consent screen and sign-in
   links use them), consent version set (PRIVACY.md §6–§7). Per-person export and erasure are in the school
   admin's student and parent pages.
