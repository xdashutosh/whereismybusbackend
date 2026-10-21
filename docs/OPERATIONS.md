# Operations — CI, local services, load tests, observability

Companion to `docs/DEPLOYMENT.md` (Vercel + Render + Neon + Linode). BP §17 asks for a CI pipeline,
a `local` environment (Postgres + PostGIS, object storage), k6 load tests and metrics. This page
covers what the repository provides and how to use it, and lists what is still missing (§5).

## 1. CI — each repository's `.github/workflows/ci.yml`

The platform is four independent repositories (`backend`, `admin`, `driverapp`, `parentapp`), each with its own
workflow that only uses paths inside that repository. Each runs on every push to `main`, every pull request and
on demand.

**backend** (this repo; jobs run in parallel):

| Job | Steps |
|---|---|
| `deploy-config` | `node scripts/check-render-config.mjs` + `--self-test` (render.yaml and ci.yml against the backend code; fails if Docker files come back) and `node --test scripts/load/sio.test.js` |
| `shared` | `shared/` (vendored `@wimb/shared`): `npm ci --include=dev --ignore-scripts` → `npm run typecheck` (source + tests) → `npm test` (vitest unit tests of the enums, Zod schemas and helpers) → `npm run build` |
| `backend` | PostGIS 18 service container (CI database only) → `npm ci --include=dev` (like Render; postinstall builds the vendored `shared/`) → `npm run lint` → `npm run typecheck` → **tenant isolation + RLS suites** (`integration.isolation`, `schema.rls`, `db.tenant`; BP §4.9, fail fast) → full `npm test` → **migration dry-run** (every migration on an empty database, a second `migrate` that must be a no-op, `migrate:status`) → `npm run build` → `npm audit --omit=dev` |

**admin** (one job): `node scripts/check-vercel-config.mjs` + `--self-test` → `npm ci --include=dev` (same as the
Vercel `installCommand`; postinstall builds the vendored `shared/`) → `npm run typecheck` (`tsc -b`) → `npm run lint`
→ `npm test` (vitest) → `npm --prefix shared test` → `npm run build` (no `VITE_API_BASE_URL`, like Vercel) →
`npm audit --omit=dev`.

**driverapp** and **parentapp** (each): matrix `.`, `packages/core`, `packages/map_kit`: `flutter pub get` →
`flutter analyze` → `flutter test` (Flutter 3.38.3 stable), then a debug APK smoke build (`flutter build apk --debug`,
no secrets).

Notes:
- The test database in CI is `whereismybus_test` on the service container (`localhost`): the harness
  refuses any database whose name lacks `test` or whose host is not local, so CI can never reach Neon.
  No secrets are needed: tests use local storage, no Redis, the console SMS provider and fixed keys.
- Node is pinned to the same version as `NODE_VERSION` in `render.yaml`; the check script enforces it,
  and it also fails when the backend job calls an `npm run` script that does not exist, stops running
  lint/typecheck/tests/build, or installs differently from Render.
- Deploys are not run from CI. Render (backend repo) and Vercel (admin repo) deploy the default branch
  themselves; turn on **Render → service → Settings → Auto-Deploy: "After CI checks pass"** and, in GitHub,
  branch protection with each repo's jobs as required checks, so a red build never goes live.
- Mobile distribution (BP §17: Firebase App Distribution / TestFlight / Play internal testing) needs
  signing keys and store accounts; it is a manual release step (each app's README, "Building a release APK",
  and `tool/verify_release_signing.sh` in each app repo).

After editing the backend workflow or `render.yaml` run `node scripts/check-render-config.mjs` (and `--self-test` after editing the script).

## 2. Local services

No containers are needed. The backend runs natively against PostgreSQL with PostGIS; Redis is not needed
(rate limits, live state, pub/sub, the Socket.IO adapter and jobs use their in-process implementations, the
same ones production uses in single-instance mode).

- **Day-to-day development** uses the Neon demo database `whereismybus_dev` (`backend/.env.local`:
  `DB_NAME=whereismybus_dev`, `ALLOW_REMOTE_DEV_DB=true`, `STORAGE_DRIVER=local`). The Render demo deployment
  uses the same database.
- **Tests and a private local database**: install PostgreSQL with PostGIS (e.g. Homebrew `postgresql@17` +
  `postgis`), start it on a free port such as 54329 and point the backend at it with explicit URLs:

```
DATABASE_URL=postgresql://postgres@localhost:54329/whereismybus_local
DATABASE_APP_URL=postgresql://wimb_app:<any local password>@localhost:54329/whereismybus_local
TEST_DATABASE_URL=postgresql://postgres@localhost:54329/whereismybus_test
STORAGE_DRIVER=local
```

then `cd backend && npm run migrate && npm run db:setup-roles && npm run seed && npm run dev`
(demo accounts: `docs/SEED_DATA.md`). The test harness creates the test database itself and refuses any name
without `test` or any non-local host.

Object storage stays on `STORAGE_DRIVER=local` (files under `backend/storage/`). Check S3 behaviour against the
real private bucket with `node scripts/check-s3-private.mjs` (in the backend repo) (`docs/DEPLOYMENT.md` §2).

## 3. Health checks

`GET /healthz` (liveness, no I/O) and `GET /readyz` (app-role DB ping, Redis ping only when `REDIS_URL` is set —
`skipped` on Render —, no pending migrations) on the API origin; Render uses `/healthz` as its health check. For uptime monitoring point an external checker
(Render's own notifications, UptimeRobot, Better Stack…) at `https://<api>/readyz` and at the Vercel origin.

## 4. Load tests — `scripts/load/ingest.k6.js`

BP §17: "k6 scripts for ingest and socket fan-out before onboarding the first large school". Install k6
(<https://grafana.com/docs/k6/latest/set-up/install-k6/>) on the machine that runs the test, not on the servers.

**Never run it against production with real parents**: the fixes move real buses on parents' maps and
trigger stop arrivals and notifications. Use a staging deployment (same `render.yaml`, its own Neon
database seeded with the demo data) or a local stack.

1. Start one trip per driver you want to load, with the simulator (it uses the same device id as the k6
   script), and stop it once it prints `trip … started`:
   ```
   cd backend && npx tsx scripts/simulate-trips.ts --base https://<staging-api>/api/v1 --school GWIS-BLR \
     --drivers gwis.driver,gwis.basavaraj,gwis.manjunath --force-start --pin 1234
   ```
2. Run k6 (one ingest VU per driver, one fix every 10 s like the app; optional watcher VUs hold Socket.IO
   connections as the school admin on `school:{id}:fleet`):
   ```
   k6 run scripts/load/ingest.k6.js -e BASE_URL=https://<staging-api> -e SCHOOL_CODE=GWIS-BLR \
     -e DRIVERS=gwis.driver,gwis.basavaraj,gwis.manjunath -e PIN=1234 \
     -e ADMIN_EMAIL=admin@greenwood.example -e ADMIN_PASSWORD=<password> -e WATCHERS=50 -e DURATION=5m
   ```

| Variable | Default | Meaning |
|---|---|---|
| `BASE_URL` | `http://localhost:4000` | API origin (no `/api/v1`) |
| `SCHOOL_CODE`, `DRIVERS`, `PIN` / `PASSWORD` | `GWIS-BLR`, `gwis.driver`, — / `Wimb@12345` | driver sign-in |
| `VUS_PER_TRIP` | `1` | more VUs per trip: extra fixes are dropped by the 10-s floor but still exercise auth and classification |
| `INTERVAL_S`, `SPEED_KMH` | `10`, `30` | send interval and simulated speed |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `WATCHERS` | —, —, `10` | fan-out watchers (only with `ADMIN_EMAIL`) |
| `DURATION` | `5m` | keep it under 15 min: watcher sockets authenticate once with a 15-min access token |
| `P95_MS` | `500` | threshold for `http_req_duration{name:ingest}` p95 |
| `APP_VERSION` | `1.0.0` | sent as `X-App-Version`; raise it if `min_supported_version.driver_app` is higher |

Results: `http_req_duration{name:ingest}` (ingest latency, threshold p95 < `P95_MS`), `wimb_ingest_ok`
(> 99 % 200 with the trip still running), `wimb_ingest_points_accepted` / `_dropped`,
`wimb_socket_join_ok`, `wimb_fanout_live_position` (events received by all watchers) and
`wimb_fanout_lag_ms` (event arrival minus the server's `receivedAt`; it includes clock skew between the k6
machine and the server, so run k6 on a host with NTP).

Rate limits: production keeps `RATE_LIMIT_ENABLED=true` (global 600 requests/min per IP; 120 ingest
requests/min per session). From one k6 machine stay under ~90 trips at a 10-s interval, or run the staging
API with `RATE_LIMIT_ENABLED=false` (only possible outside production) to measure raw capacity. The BP
capacity sketch (50 schools × 40 buses at 6 fixes/min) is about 200 ingest requests/s.

`scripts/load/sio.js` holds the Socket.IO wire framing used by the script (k6 has no Socket.IO client);
`node --test scripts/load/sio.test.js` covers it, and the whole flow (driver sign-in with the simulator's
device, running trip, ingest, admin socket join, `live:position` fan-out) was checked against a local backend.

## 5. Observability — current state and gaps

In place: structured pino logs (`requestId`, `schoolId`, `userId`, `module`; secrets redacted), `/healthz`
and `/readyz`, job outcomes in the logs, the SMS balance check in the platform system status, audit logs.

Web admin error tracking (BP §16) is built and optional: `VITE_SENTRY_DSN` on Vercel loads `@sentry/react`
lazily and sends crash reports scrubbed of personal data and tokens (`admin/src/monitoring/`, DEPLOYMENT.md §11.6).

API error tracking (BP §16) is built and optional: `SENTRY_DSN` on Render (`backend/src/shared/sentry.ts`,
`@sentry/core` with a fetch transport — no OpenTelemetry auto-instrumentation): unexpected 5xx, job failures,
unhandled rejections and crashes, scrubbed of personal data and secrets; disabled (a no-op) without the DSN and
always in tests (DEPLOYMENT.md §11.8).

Metrics (BP §17) are built: `GET /metrics` on the API (Prometheus text format, bearer `METRICS_TOKEN`; `404` when the
token is unset) with HTTP request counters and latency histograms per route pattern, Socket.IO connections, job
runs/failures/durations (jobs run in the API process on Render), accepted
ingest points, SMS sends by outcome and process memory / event-loop lag (`backend/src/shared/metrics.ts`,
`httpMetrics.ts`; families and suggested alerts in DEPLOYMENT.md §15).

Not yet built (application code, outside this page's scope):
- **Error tracking** for both Flutter apps (`sentry_flutter`), enabled only when its dart-define is set. Until then,
  use the store consoles' crash reports.
- **More metrics (BP §17)**: queue lag, active trips, push success rate and DB pool connections are not exported
  yet (the platform health page shows queue and DB state); add them to `appMetrics()` when needed.
