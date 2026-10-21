# Where Is My Bus — API reference

Base URL: `/api/v1` (health probes `GET /healthz`, `GET /readyz` and Prometheus metrics `GET /metrics` — bearer
`METRICS_TOKEN`, see [`DEPLOYMENT.md`](DEPLOYMENT.md) §15 — at the root). JSON bodies are camelCase.
Contract: [`ARCHITECTURE.md`](ARCHITECTURE.md) §5. Every module documents its endpoints with request/response
examples in `docs/api/<module>.md`.

| Module | Document | Areas |
|---|---|---|
| Auth | [api/auth.md](api/auth.md) | sign-in for all four principals, TOTP, OTP, refresh (30-s grace window for a rotated token re-presented by the same client/device), logout, change password, `/auth/me` (incl. `consentRequired` and legal links), device binding, public `/auth/legal` and `/auth/school/branding?code=` |
| Files | [api/files.md](api/files.md) | presigned uploads (mobile), proxied uploads (web), completion, signed download URLs |
| Audit | [api/audit.md](api/audit.md) | school and platform audit trails (filters, pagination, CSV) |
| Platform (Super Admin) | [api/platform.md](api/platform.md) | schools (onboarding, profile, logo, activate/deactivate, delete, admin password reset), subscriptions and plan limits, platform settings (incl. `legal.privacy_url`, `legal.terms_url`, `legal.consent_version`), health, usage |
| School | [api/school.md](api/school.md) | school profile, settings (intervals, alerts, features, location retention, privacy / terms links and consent version override), parent-visibility matrix, holidays, announcements |
| Users (school admins) | [api/users.md](api/users.md) | school admin accounts: create, edit, reset access, activate/deactivate, delete |
| Buses | [api/buses.md](api/buses.md) | fleet CRUD, images, staff assignment and history, bus documents (replace/history, visibility, verify) |
| Staff | [api/staff.md](api/staff.md) | drivers and conductors: profiles, app logins (password/PIN), documents, assignment history, parent preview |
| Routes | [api/routes.md](api/routes.md) | routes, stops (ordering), planned polylines, bus ↔ route assignments, trip schedules |
| Students & parents | [api/students.md](api/students.md) | students, parents, parent links, bus/route/stop assignments (single and bulk), CSV/XLSX imports |
| Trips | [api/trips.md](api/trips.md) | driver/conductor app (`/driver/me`, `/driver/home`, start with odometer photo, end, resume, history, device events incl. `location_permission_denied` / `_restored` and `clock_drift`, interrupt, device refresh; every answer carries `serverTime`); admin trips list (CSV, `period`), detail with odometer evidence and `timeline` (lifecycle + device events), cancel, odometer correction, reassignment; trip jobs and odometer alerts |
| Tracking | [api/tracking.md](api/tracking.md) | location ingestion (`/driver/trips/:id/locations`, 10-s floor, offline backfill, device clock correction via `sentAt` / stored offset), the driver's planned route, live fleet (`/school/fleet/live`), trip path (planned vs actual), socket rooms `trip:{id}` / `school:{id}:fleet` and live events, ETA, trip finalizer |
| Alerts | [api/alerts.md](api/alerts.md) | alert inbox (`/school/alerts`: filters, counts per status, CSV), review / escalate (e-mail + push to alert recipients) / close, admin bell room `school:{id}:alerts` (`alert:new`, `alert:updated`), `document-expiry-scan` and `maintenance-due-scan` jobs, daily `alert-email-digest` (school `emailDigest` feature) |
| Notifications | [api/notifications.md](api/notifications.md) | parent trip notifications engine (trip started, left school, approaching / arrived at stop, delayed, not started; in-app inbox + push + SMS per school feature, exactly once), announcement fan-out to parents and drivers, school notification log (`/school/notifications`, filters, CSV), `notification:new` in `actor:{id}` |
| Parent | [api/parent.md](api/parent.md) | parent app: children grouped by school, privacy consent per school (`/parent/consent`), tracking snapshot + ETA + trip `phase` / `phaseReason`, bus and driver/conductor cards (parent-visibility matrix), parent file URLs, notification preferences per child and direction, devices (FCM), inbox, socket room `child:{studentId}:live` (`child:live`) |
| Fuel | [api/fuel.md](api/fuel.md) | fuel logs (`/school/fuel-logs`: CRUD, bill file, filters, litres/cost totals, CSV), fill-to-fill mileage (`/mileage-trend` per bus, `/mileage-summary` per bus JSON/CSV), non-blocking odometer warnings |
| Maintenance | [api/maintenance.md](api/maintenance.md) | maintenance logs (`/school/maintenance-logs`: CRUD, invoice file, next due date/km, due state, cost totals, CSV), service due list (`/school/maintenance-logs/due`), `maintenance-due-refresh` job |
| Reports & dashboard | [api/reports.md](api/reports.md) | bus-level reports (`/school/reports/{bus-distance\|fuel\|maintenance\|cost-per-km\|service-due\|non-school-usage\|trip-summary}`, school-local date ranges, JSON/CSV/PDF with the school logo header, `reports` feature flag), school dashboard (`/school/dashboard`) |
| Privacy | [api/privacy.md](api/privacy.md) | public legal links (`/auth/legal`) and school branding (`/auth/school/branding?code=`), parent consent per school (`/parent/consent`, re-consent after a version bump), per-person export and irreversible erasure of a student or parent (`/school/privacy/{students\|parents}/:id/{export\|erase}`) |

## Conventions

**Envelopes**

```json
{ "success": true, "data": { … } }
{ "success": true, "data": [ … ], "meta": { "page": 1, "limit": 20, "total": 45, "totalPages": 3 } }
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "The request is invalid.", "details": [{ "path": "email", "message": "Must be a valid e-mail address" }], "requestId": "…" } }
```

**Headers**

| Header | Used by | Meaning |
|---|---|---|
| `Authorization: Bearer <accessToken>` | everyone | JWT access token (15 min) |
| `X-WIMB-Client: web` | web admin | refresh token travels in the httpOnly `wimb_rt` cookie instead of the body |
| `X-School-Id: <uuid>` | parent app | school of the child being viewed; accepted only with an active child link there |
| `X-Device-Id: <deviceId>` | driver app | device the session was bound to at sign-in (trip/location calls) |
| `X-App-Name`, `X-App-Version` | mobile apps | version gate (`426 APP_UPDATE_REQUIRED` below the platform minimum) |
| `Idempotency-Key` | creates/uploads | 24-h replay of the first response (`Idempotent-Replayed: true`) |

**Areas and guards.** Every path under `/platform/*` requires a Super Admin (never a school context);
`/school/*` a school admin of an active school; `/driver/*` a driver or conductor of an active school;
`/parent/*` a parent (routes for one child also require `X-School-Id`). These area guards run before
every module route; module routes then narrow roles further.

**Errors** (contract §5): `VALIDATION_ERROR` 400 · `UNAUTHENTICATED` 401 · `TOKEN_EXPIRED` 401 ·
`TOTP_REQUIRED` 401 · `PASSWORD_CHANGE_REQUIRED` 403 · `FORBIDDEN` 403 · `SCHOOL_INACTIVE` 403 ·
`DEVICE_NOT_BOUND` 403 · `NOT_FOUND` 404 (also for ids of another school) · `CONFLICT` / `DUPLICATE` /
`INVALID_STATE` / `TRIP_ALREADY_ACTIVE` 409 · `PAYLOAD_TOO_LARGE` 413 · `UNSUPPORTED_FILE` 415 ·
`ODOMETER_INVALID` 422 · `APP_UPDATE_REQUIRED` 426 · `RATE_LIMITED` 429 (+ `Retry-After`) ·
`INTERNAL_ERROR` 500 · `SERVICE_UNAVAILABLE` 503.

**Lists**: `page` (≥ 1), `limit` (1–100, default 20), `sort=field,-other` (whitelisted per endpoint),
explicit filters, `format=csv` on admin lists (`format=pdf` too on reports and the trips list). Date-range lists
(trips, fuel and maintenance logs, alerts, reports) take `period=YYYY-MM-DD..YYYY-MM-DD` as well as `from` / `to`
(explicit `from` / `to` win; a malformed `period` answers `400` on `query.period`).

**Plan limits** (school subscriptions): creating a bus or (re-)activating / importing students beyond the plan
answers `403 FORBIDDEN` with `details { "reason": "SUBSCRIPTION_LIMIT", "resource": "buses" | "students", "limit",
"used", "adding" }`; an expired or cancelled plan blocks the whole school with `403 SCHOOL_INACTIVE`
(`details.reason` `SUBSCRIPTION_EXPIRED` | `SUBSCRIPTION_CANCELLED`).

**Realtime**: Socket.IO namespace `/rt` (`auth: { token }`), rooms and the `auth:refresh` event are described in
[api/auth.md](api/auth.md#realtime-rt-and-long-lived-sockets); live tracking rooms and events (`live:position`,
`live:status`, `trip:status`, `alert:new`, `room:revoked`) in [api/tracking.md](api/tracking.md#socketio-contract-7-bp-86); the parent
room `child:{studentId}:live` (`child:live`) in [api/parent.md](api/parent.md), `alert:updated` in [api/alerts.md](api/alerts.md) and
`notification:new` in [api/notifications.md](api/notifications.md). Room
memberships are re-checked after joins too: a socket that may no longer watch a room (child unlinked or moved to
another bus, crew reassigned) leaves it and receives `room:revoked` `{ room, reason }`.

Demo accounts for trying the API locally: [`SEED_DATA.md`](SEED_DATA.md).
