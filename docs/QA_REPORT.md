# QA report — overnight audit, fixes and go-live (2026-10-18 → 19)

Honest summary of what was checked before deployment, what was fixed, what passed, and what is still
open. Everything below was verified with commands; nothing was tried on real Vercel or Render (those
need your accounts).

**Latest state:** §7 (final completion pass) has the newest features and gate results. §5 is the current
list of open items. §3 and §4 record the earlier audit run and the go-live step.

## 1. How it was done

An automated pipeline ran one area at a time on an 8 GB machine: **audit → independent verification
(reproduce or refute) → fix with regression tests → area gates**, then deployment prep, a full gate run
on the final code, and the go-live step on Neon and S3.

| Track | What was audited | Findings | Confirmed (crit / major / minor) | Fix items |
|---|---|---|---|---|
| neon | pooler safety, Neon readiness, S3 privacy, WebPay | 3 | 3 (1 / 1 / 1) | 12 |
| security | auth, sessions, uploads, rate limits, tenant boundaries, headers | 9 | 9 (1 / 5 / 3) | 10 |
| coverage | blueprint (BP) requirements vs code, CI, privacy, observability | 14 | 14 (0 / 4 / 10) | 20 |
| scenarios | real-world trip life cycle: restarts, GPS spikes, breakdowns, offline queues | 8 | 8 (0 / 4 / 4) | 9 |
| mobile | driver + parent apps: sessions, background tracking, permissions, release builds | 10 | 10 (0 / 2 / 8) | 10 |
| web | every admin page incl. phone width, icons, error recovery, reports | 13 | 12 (0 / 2 / 10) | 18 |
| known | issues carried over from earlier runs | 13 | 11 (0 / 1 / 10) | 12 |
| **total** | | **70** | **67 (2 / 19 / 46)**, 3 refuted | **91** |

Earlier the same evening two focused runs fixed the **Super Admin 401 loop** (token lost on a dev hot
reload, socket not reconnecting after an API restart) and the remaining session issues (refresh cookie
cleared on 5xx, "school inactive" message, double sign-out).

## 2. Most important fixes

**Critical**
- XLSX import decompression bomb: a 240 KB upload could add ~600 MB to the API. New zip guard inflates
  entries with hard limits (`students/import/zipGuard.ts`).
- Public Linode bucket: cannot be fixed in code — see §5 (your action). Demo files were removed from it.

**Major (all fixed)**
- Vercel + Render topology: `render.yaml`, `admin/vercel.json` (same-origin `/api` rewrite so the
  `SameSite=Strict` refresh cookie works, SPA fallback, CSP), `db:bootstrap`, `npm run release`,
  `scripts/check-deploy-config.mjs`, CI workflow, docs.
- Security: another school could claim a parent by phone and sign them out everywhere (now per-school
  scope); `TRUST_PROXY` guarded in production; per-IP login limiter; anonymous ingest no longer bypasses
  the global limiter; JWT key rotation with key ids.
- Trips: daily trip generation no longer skipped after a restart at 00:05 (cursor in Postgres); today's
  trip can be restored after the 00:05 run; a single GPS spike no longer fakes a stop arrival;
  parents are notified when a trip is interrupted or cancelled; "bus left school" uses the school's
  geofence radius.
- Fuel totals no longer add litres, kg and kWh together; fuel and cost-per-km reports use odometer
  distance.
- Mobile: driver session lost mid-trip by a refresh race (cross-isolate lock); iOS significant-change
  relaunch; release builds refuse `http`/empty API URLs and debug signing; clock-drift handling (app
  side); harsh-driving detection; background retry; launcher icons.
- Web: detail pages at phone width, missing icons, lists stuck in error state, institution-type labels.
- Neon collation made name sorting case-sensitive (fixed with ICU collations in a migration).

## 3. Gates of the audit run (2026-10-19, before the final completion pass; newer results in §7)

| Gate | Result |
|---|---|
| backend typecheck · lint · build | pass |
| backend full test suite (fresh local DB) | **146 files / 1457 tests pass** |
| db:reset + db:setup-roles + seed ×2 (idempotent) | pass — 26 migrations, 4 schools, 156 students, 100 trips |
| API boot + trip simulator + live fleet + parent tracking (OTP from log, no SMS) | pass |
| frontend typecheck · lint · tests · vite build | pass — **372 tests** |
| shared/ (vendored @wimb/shared) typecheck (source + tests) · unit tests · build | pass — **11 files / 180 tests** |
| flutter analyze (core, map_kit, driver_app, parent_app) | no issues |
| flutter test | pass — core 82, map_kit 24, driver_app 132, parent_app 58 |
| flutter build web (both apps, https API URL) | pass |
| npm audit --omit=dev (backend, frontend) | 0 vulnerabilities |
| clean-clone Vercel build + Render build (`NODE_ENV=production`) | pass |
| split-origin emulation (Vercel-like proxy + API): sign-in, reload keeps session, CSV, upload, socket, CSP | 10 / 10 |
| docs/release step sanity after its own changes: backend typecheck + build, frontend build + 372 tests + lint, flutter analyze (driver, parent), deploy-config check + self-test | pass |

## 4. Go-live on Neon and S3 (done)

- **`whereismybus` (production)**: 26 migrations (the 4 added by the final completion pass, §7, are **not** on
  Neon yet — Render's pre-deploy step applies them on the first deploy), app role `wimb_app` (`NOBYPASSRLS`), first Super Admin
  (forced password change, TOTP not enrolled; password only in `backend/.superadmin-initial-password.local`),
  12 platform settings, **0 schools / students / trips — no demo data**. Re-running is a no-op.
- **`whereismybus_dev`**: demo data (4 schools, 24 buses, 156 students, 221 parents) for local dev;
  `backend/.env.local` points `npm run dev` at it with local file storage.
- **Neon test subset** on `whereismybus_test`: 16 files / 158 tests pass (~50 min at ~270 ms/round trip).
- **S3 through the real API**: 33 / 33 checks (web upload + thumbnail, mobile presigned upload,
  checksums, `whereismybus/schools/{id}/` keys, deletes). 206 demo objects removed from the bucket.
- **Live smoke**: `/healthz` ok, `/readyz` ready; simulator moved a bus on the live fleet and in parent
  tracking; production web build behind a Vercel stand-in: 48 API calls, 0 errors, 0 CSP errors.

## 5. Known limitations and open items (honest list)

Current as of the final completion pass (§7). Items finished in that pass were moved to §7.2.

**Needs you (no code can fix it)**
1. **Linode bucket is publicly readable/writable** (shared with ~65 other folders). Create a dedicated
   private bucket + limited key (DEPLOYMENT.md §2). Blocking for real data.
2. **Credentials were pasted into chat** (Neon, S3, WebPay, Google): rotate them (DEPLOYMENT.md §16).
3. **Google Routes API returns 403** for the current key → routes are straight lines between stops and
   ETAs use an assumed speed. Enable Routes API + restricted keys (DEPLOYMENT.md §12).
4. Not yet run on real Vercel/Render: run the smoke test (DEPLOYMENT.md §8) after the first deploy.
5. **4 new migrations are not on Neon yet** (`900_refresh_grace`, `901_privacy`, `925_trip_device_events`,
   `926_location_retention_end_to_end`). Render's pre-deploy step (`npm run release`) applies them to
   production on the first deploy. For local development run `cd backend && npm run migrate && npm run
   db:setup-roles` once; it targets the dev database set in `backend/.env.local`. Until then the local API
   refuses to start ("Database schema is not up to date").
6. **`PLATFORM_ADMIN_EMAIL` in `backend/.env` is still the placeholder `superadmin@example.com`.** In
   production `db:bootstrap` refuses that value, so the Render release step would fail if it were copied there.
   Set the real Super Admin e-mail in `backend/.env` and on Render (MORNING_CHECKLIST.md step 4).

**Hosting trade-offs**
7. Vercel may cap proxied uploads at ~4.5 MB (web documents allow 10 MB) — not confirmed; custom
   domains remove it. Through the rewrite, web audit-log IPs show Vercel addresses and the per-network
   login limiter is shared by web users (per-account lockout still applies).
8. Render Key Value **free** plan has no persistence; use a paid plan for real schools. API and worker
   need paid instances (or single-service mode with `JOBS_IN_PROCESS=true`).
9. Neon is in the US: ~250 ms per request from India. Consider moving Neon + Render to Singapore together.
10. The Neon app role `wimb_app` is shared by the prod, dev and test databases (same branch).

**Features not finished (follow-ups; nothing breaks without them)**
11. Driver app: does not send the optional `sentAt` with location and event batches, and does not report
    `clock_drift` device events (it only shows a local warning). The server still corrects clocks with a stored or
    inferred offset and every driver answer carries `serverTime` (docs/api/tracking.md "Device clock").
12. Web: the trip detail page does not show `TripDetail.timeline` (trip lifecycle + driver-app device events) yet;
    the alerts inbox has labels for the new `location_permission` and `clock_drift` alerts.
13. Web: no button to sign **another** person out of every device (API exists:
    `POST /school/{staff|admins|parents}/:id/sessions/revoke`). Signing out the admin's own devices works.
14. Parent app: a consent version change made while the app is open is picked up only at the next start or
    reconnect (no `/auth/me` refresh when the app returns to the foreground). The consent screen shows school
    avatars in the default colour (`GET /parent/consent` has no `brandColor`; cosmetic).
15. Fuel mileage trend and summary (`/school/fuel-logs/mileage-trend`, `/mileage-summary`) still return single-unit
    totals; the web shows the bus's fuel unit and hides km per unit when units are mixed. The fuel log list and the
    fuel report are per unit.
16. Erasure does not rewrite earlier audit rows (the audit log is insert-only), bulk CSV import / generated report
    files, or 24-hour idempotency replay records (documented in PRIVACY.md §6 and docs/api/privacy.md).
17. Observability: queue lag, active trips, push success rate and DB pool size are not exported as metrics yet
    (OPERATIONS.md §5); no Sentry for the Flutter apps (web Sentry is optional via `VITE_SENTRY_DSN`).
18. ETA for a child whose stop was already passed is `null` (by design).

**Fixed during this docs/release step:** the web settings forms allowed 30–300 s for the "interval while
stopped", which the API rejects outside 60–120 s — both forms now use 60–120 s; the staff parent preview
now labels the `NOT_VERIFIED` reason instead of showing the raw code.

## 6. Docs/release step (earlier run)

Rewrote `README.md`, made `docs/DEPLOYMENT.md` the deployment index with an every-key environment
checklist, added this report and `MORNING_CHECKLIST.md`, removed leftover workflow scripts and test
storage folders from the repo, extended `.gitignore`, ran `git init` (nothing committed) and proved with
`git check-ignore` that `backend/.env`, `.env.local` files, the Super Admin password file, signing and
Maps key files are ignored and that no secret value appears in any file Git would add (~1,420 files,
~10 MB). API reference brought up to date: session revoke endpoints and shared-parent rules
(`staff.md`, `users.md`, `students.md`), `NOT_VERIFIED`, trip interrupted/cancelled notices and
preferences (`notifications.md`, `parent.md`), per-unit fuel totals (`fuel.md`), dashboard quick-link
format (`reports.md`), per-school retention and the 60–120 s stopped interval (`school.md`,
`platform.md`, `PRIVACY.md`); `JWT_ACCESS_SECRET` must stay stable (TOTP encryption) is now stated in
`render.yaml`, `backend/.env.example` and the deployment docs.

## 7. Final completion pass (2026-10-19)

Four work lanes (two backend lanes, web, mobile) finished the follow-ups from the earlier §5, then one gate run
covered the combined code on a fresh private local database. Neon, the real bucket and real SMS were not used
(`STORAGE_DRIVER=local`, `SMS_PROVIDER=console`, OTP codes read from the API log).

### 7.1 New database migrations (not on Neon yet)

| Migration | What it adds |
|---|---|
| `900_refresh_grace` | 30-second refresh-token grace window (encrypted successor token on the session) |
| `901_privacy` | `parent_consents` table + `parent_accept_consent()`, `legal.*` platform settings, erasure columns and functions |
| `925_trip_device_events` | `trip_device_events` table (RLS, hidden from parents) for the trip timeline |
| `926_location_retention_end_to_end` | `location_retention_cutoffs()`, saved simplified paths before purges, device-event coordinate purge |

All four are additive and were applied twice on scratch databases without errors. Production (Neon
`whereismybus`) is still at 26 migrations: Render's pre-deploy step applies the four on the first deploy. Local
development: `cd backend && npm run migrate && npm run db:setup-roles` once (it targets the dev database set in
`backend/.env.local`).

### 7.2 What was finished (moved out of §5)

| Area | Server | Web admin | Apps |
|---|---|---|---|
| **Privacy (BP §16)** | legal links (platform `legal.privacy_url` / `legal.terms_url` / `legal.consent_version`, per-school override), parent consent per school with re-consent after a version bump (`GET/POST /parent/consent`, `consentRequired` in `/auth/me`), per-person export (`wimb.privacy-export` v1) and irreversible erasure (`POST /school/privacy/{students\|parents}/:id/erase`, `{"confirm":"ERASE"}`) — `docs/api/privacy.md` | "Privacy & legal" group on Global settings, legal tab in School settings, export / erase buttons on the student and parent pages (typed confirmation), links on the sign-in pages and in the school account menu | parent consent screen (blocks the app until accepted; 409 `CONSENT_VERSION_CHANGED` re-asks), privacy links on sign-in, parent Settings and driver Profile (English + Hindi) |
| **School branding** | public `GET /auth/school/branding?code=` (active schools only, 404 otherwise, 120 / 15 min per IP, 60 s cache, freshly signed logo URL) | school sign-in page shows logo, name and links | driver sign-in shows the school's logo/initials, name, type and links ~0.5 s after a valid code |
| **Refresh grace window** | a rotated refresh token re-presented within 30 s by the same client/device returns the same successor; reuse detection outside the window unchanged (`docs/api/auth.md`) | — | fixes the mobile refresh race at the source |
| **Clock drift (server)** | device timestamps put on the server clock (`sentAt`, else stored / inferred offset; ≤ 60 s ignored, ≤ 24 h corrected, beyond rejected), freshness counted from arrival, one `clock_drift` alert per trip, `serverTime` on every driver answer | alert labels | device-events answer also updates the app's clock offset |
| **Lost location permission** | `location_permission_denied` / `_restored` events, critical `location_permission` alert auto-closed on restore, immediate "Location unavailable" (`LOCATION_PERMISSION_DENIED` for parents), `trip_device_events` + `timeline` in `GET /school/trips/:id` | alert labels and dashboard `tripOps` group | driver app sends the new events (via the offline queue) instead of `gps_disabled` |
| **Trip phase for parents** | `phase` / `phaseReason` / `interruptedAt` in the tracking snapshot and `child:live`, `phase` per `/parent/children` direction | — | "Trip interrupted: <reason>" banner, "Trip cancelled: <reason>", per-child / per-direction notice toggles, inbox icons |
| **Retention end to end** | effective per-school cutoff, simplified path saved in `trips.summary.path` before points are purged, device-event coordinates purged at the cutoff | per-school retention field (earlier run) | — |
| **Date ranges** | `period=<from>..<to>` accepted by trips, fuel and maintenance logs, alerts and every report (explicit `from` / `to` win) | dashboard links already used it | — |
| **Observability** | `GET /metrics` (Prometheus, bearer `METRICS_TOKEN`, 404 when unset; worker metrics merged through Redis), optional Sentry for API and worker (`SENTRY_DSN`, `@sentry/core` 10.75.3, scrubbed, off in tests) | optional `VITE_SENTRY_DSN` (earlier run) | — |

Tests added include `privacy.legal`, `privacy.consent`, `privacy.dsr`, `observability`, `qa/refreshRace` (14 cases)
and `qa/coverage.clockDrift`; `backend/tests-pre/` was removed (its probes now pass inside the main suite).

### 7.3 Final gates (combined code, fresh private local database)

| Gate | Result |
|---|---|
| backend typecheck · lint · build | pass (no `tests-pre` folder left) |
| backend full test suite | **156 files / 1557 tests pass**, 0 failed |
| db:reset + db:setup-roles + seed ×2 (+ a third seed) | pass — 30 migrations, grants on 50 tables; the third seed left all 48 table counts unchanged (idempotent) |
| API boot from `dist` (`JOBS_IN_PROCESS=true`, local storage, console SMS) | `/healthz` ok, `/readyz` ready (no pending migrations), no error lines in the log |
| trip simulator + live fleet + parent tracking | pass — 12 `live:position` + 6 `live:status` on the admin fleet room in 120 s; parent (OTP from the log) got 14 `child:live`; parent position matched the fleet point |
| `GET /metrics` | 401 without / with a wrong token, 200 with the token (418 lines incl. `wimb_http_requests_total`, `wimb_socket_connections`) |
| `GET /auth/school/branding` | 200 for `GWIS-BLR`, 404 for an unknown code |
| frontend typecheck · lint · tests · vite build | pass — **48 files / 436 tests**, oxlint 0 diagnostics |
| shared/ (vendored @wimb/shared) build · typecheck · tests | pass — 11 files / 180 tests |
| flutter analyze (core, map_kit, driver_app, parent_app) | no issues |
| flutter test | pass — core 93, map_kit 24, driver_app 142, parent_app 79 |
| flutter build web (both apps, release) | pass |
| `node scripts/check-deploy-config.mjs` | OK (render.yaml web + worker + Key Value, `SameSite=strict`, CI jobs, compose) |
| npm audit --omit=dev (backend, frontend) | 0 vulnerabilities |

The mobile lane also checked the parent app live at 390×844 against a private local backend: first-login consent,
consent after a version bump, and an interrupted trip on the home card and tracking screen (profile web build,
because release builds refuse a non-https API URL). The driver sign-in branding was covered by widget tests and a
curl of the live endpoint, not a live browser run. The Playwright run of the web pages used a scratch script that
is not part of the repository; repository coverage is the vitest suites.

### 7.4 Notes from this pass (honest)

- Earlier failures between lanes (lane B's suite run saw 8 failures from lane A's then-unfinished fixtures) were
  resolved before the final gates; the combined run above is green.
- One lane stopped its smoke-test server with `pkill -f "tsx src/server.ts"` (matches by command line, not PID).
  `npm run dev` (`tsx watch`) does not match that pattern, and nothing was listening on port 4000 afterwards, but
  that was not checked beforehand.
- `db:setup-roles` on the private local Postgres (port 54329) set the cluster-wide local role `wimb_app` to the
  local test password. This affects only that local cluster, never Neon.
- `backend/storage/whereismybus/schools/` (git-ignored) still holds ~196 folders (~130 MB) of seed photos written
  by private test databases over several runs. They may include files of the Neon dev database, whose uploads use
  local storage, so they were not deleted in bulk. The four folders known to belong only to a dropped test
  database were removed. If you do not need local demo photos, delete the folder by hand; seeding recreates it.
- Docs updated in this pass: `docs/api/privacy.md` (new), `API.md`, `api/{auth,platform,school,audit,parent,trips,
  tracking,alerts,reports,fuel,maintenance,notifications}.md`, `PRIVACY.md`, `OPERATIONS.md`, `DEPLOYMENT.md`
  (§11.8, §15), `DEPLOY_VERCEL_RENDER.md`, `ARCHITECTURE.md` §13, the backend and app READMEs, `README.md`,
  `MORNING_CHECKLIST.md` and this report.
- Nothing was committed; `git status --porcelain --ignored` shows `backend/.env`, both `.env.local` files and
  `backend/.superadmin-initial-password.local` as ignored, and no file Git would add contains a value from them.

