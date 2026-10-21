# Platform (Super Admin) API

Blueprint §2.2, §4.4, §8.2, §13.2, §20; contract §4, §9. Base `/api/v1`. Source: `backend/src/modules/platform/`.

* **Super Admin only.** Every path under `/platform/*` requires a `super_admin` access token (TOTP-enrolled
  sign-in, see `auth.md`). School admins, drivers, conductors and parents get `403 FORBIDDEN`; no token → `401`.
* **Never school data.** Requests run in the platform database context (`withPlatform`: no `app.school_id`), so
  row-level security returns zero rows from every tenant table. The Super Admin works with the schools registry,
  subscriptions, global settings, a school's **admin accounts** (create / reset access only) and **counts**
  (SECURITY DEFINER functions `platform_health_counts()`, `school_usage_counts()`). There is no impersonation.
* Every write is audited in the **platform** audit log (`GET /platform/audit-logs`, audit module) in the same
  transaction. Temporary passwords are never logged, audited or stored in clear.
* `GET /platform/audit-logs` is documented in `audit.md`.

## Schools

### School object

```json
{
  "id": "01a14ba0-e0d6-7e65-bbbd-8735a68fb6bf",
  "code": "LAKEVIEW-HYD",
  "name": "Lakeview Academy",
  "institutionType": "school",
  "status": "active",
  "statusReason": null,
  "address": "6-3-1090, Raj Bhavan Road, Somajiguda",
  "city": "Hyderabad", "state": "Telangana", "pincode": "500082",
  "contact": { "name": "Kavya Reddy", "phone": "+914023350000", "email": "office@lakeview.example" },
  "brandColor": "#0B5394",
  "location": { "lat": 17.423908, "lng": 78.458282 },
  "geofenceRadiusM": 150,
  "timezone": "Asia/Kolkata",
  "tenantMode": "shared",
  "dbConnectionRef": null,
  "logoFileId": null,
  "deleted": false,
  "deletedAt": null,
  "createdBy": "01a14b9f-…",
  "createdAt": "2026-10-18T02:18:00.123Z",
  "updatedAt": "2026-10-18T02:18:00.123Z"
}
```
`status`: `active` · `suspended` · `inactive`. `institutionType`: `school` · `college` · `university` (display only).
`tenantMode`: `shared` (default) or `dedicated` (BP §4.7 hook — accepted only with a `dbConnectionRef` whose
database pool is registered in the API, otherwise `409 INVALID_STATE`).

### `GET /platform/schools`

Query: `q` (name, code or city), `status` (comma list), `institutionType` (comma list), `includeDeleted=true`,
`page`, `limit` (1–100), `sort` (`name` default, `code`, `city`, `state`, `status`, `createdAt`, `updatedAt`;
prefix `-` for descending), `format=csv`.

```json
{
  "success": true,
  "data": [
    { "id": "…", "code": "GWIS-BLR", "name": "Greenwood International School", "status": "active", "…": "…",
      "subscription": { "plan": "standard", "status": "active", "validUntil": null, "maxBuses": 50, "maxStudents": 2000 } }
  ],
  "meta": { "page": 1, "limit": 20, "total": 4, "totalPages": 1 }
}
```
Soft-deleted schools are hidden unless `includeDeleted=true`. CSV columns: code, name, type, status, city, state,
contact, plan, validity, limits, timezone, tenant mode, deleted/created timestamps.

### `POST /platform/schools`

Creates the school **with its initial school admin in one transaction** (BP App. A): school → `school_settings`
defaults (trigger) → school admin (`must_change_password = true`) → subscription → platform audit. The welcome
e-mail is sent after commit.

```json
{
  "name": "Lakeview Academy",
  "code": "lakeview-hyd",
  "institutionType": "school",
  "address": "6-3-1090, Raj Bhavan Road, Somajiguda",
  "city": "Hyderabad", "state": "Telangana", "pincode": "500082",
  "contact": { "name": "Kavya Reddy", "phone": "040 2335 0000", "email": "office@lakeview.example" },
  "brandColor": "#0B5394",
  "location": { "lat": 17.423908, "lng": 78.458282 },
  "geofenceRadiusM": 200,
  "timezone": "Asia/Kolkata",
  "admin": { "name": "Kavya Reddy", "email": "admin@lakeview.example", "phone": "98490 00300", "delivery": "show" },
  "subscription": { "plan": "standard", "maxBuses": 12, "maxStudents": 900, "validUntil": "2027-03-31", "modules": { "sms": false } }
}
```
* `code` is upper-cased (2–32 letters, digits, dashes) and is the drivers' sign-in school code. Phones accept any
  usual spelling and are stored in E.164.
* `admin.password` is optional: omitted → a 14-character temporary password is generated. Chosen passwords follow
  the auth rules (8–128 characters, a letter and a digit).
* `admin.delivery`: `show` (default) returns a **generated** password once in the response; `email` sends it with
  the welcome e-mail (the invitation). If that e-mail cannot be delivered (no SMTP), the password is returned in
  the response instead so it is never lost.
* `subscription` is optional: default plan `standard`, 25 buses, 1500 students, no end date.
* Bodies never grant another school: unknown keys such as `school_id` are ignored.

`201` (`Cache-Control: no-store`, `Location: /api/v1/platform/schools/{id}`):
```json
{
  "success": true,
  "data": {
    "school": { "id": "…", "code": "LAKEVIEW-HYD", "…": "…", "logoUrl": null, "logoThumbnailUrl": null },
    "admin": { "id": "…", "name": "Kavya Reddy", "email": "admin@lakeview.example", "phone": "+919849000300", "mustChangePassword": true },
    "subscription": { "id": "…", "plan": "standard", "status": "active", "maxBuses": 12, "maxStudents": 900, "modules": { "sms": false },
                      "validFrom": "2026-10-18", "validUntil": "2027-03-31", "notes": null, "createdBy": "…", "createdAt": "…", "updatedAt": "…" },
    "credentials": { "delivery": "show", "passwordGenerated": true, "emailDelivered": false, "temporaryPassword": "Hk7mQ2xPa9TzRb" }
  }
}
```
Errors: `400 VALIDATION_ERROR` (field paths such as `code`, `timezone`, `location.lat`, `admin.email`,
`admin.password`), `409 DUPLICATE` (`code` or `admin.email` already used — nothing is created),
`409 INVALID_STATE` (dedicated tenant without a registered database). Retrying a create is safe: the second
attempt answers `409 DUPLICATE` on `code`.

### `GET /platform/schools/:id`

The school object plus `logoUrl` / `logoThumbnailUrl` (signed, 300 s), its admin accounts, the current
subscription and **counts only**:
```json
{
  "success": true,
  "data": {
    "id": "…", "code": "GWIS-BLR", "…": "…",
    "logoUrl": "https://…signed…", "logoThumbnailUrl": "https://…signed…",
    "admins": [{ "id": "…", "name": "Meera Iyer", "email": "admin@greenwood.example", "phone": "+919845000100",
                 "isActive": true, "mustChangePassword": false, "lastLoginAt": "…", "createdAt": "…" }],
    "subscription": { "plan": "standard", "status": "active", "maxBuses": 50, "maxStudents": 2000, "…": "…" },
    "usage": { "buses": 6, "students": 48, "staff": 14, "parents": 41, "routes": 4, "activeTrips": 2,
               "tripsLast30Days": 96, "lastActivityAt": "2026-10-18T03:11:42.000Z" }
  }
}
```
Soft-deleted schools stay readable here (`deleted: true`). Unknown id → `404`.

### `PATCH /platform/schools/:id`

Any subset of: `name`, `code`, `institutionType`, `address`, `city`, `state`, `pincode`, `contact`
(`name`/`phone`/`email`, `null` or `""` clears), `brandColor`, `location` (`null` clears), `geofenceRadiusM`,
`timezone`, `tenantMode`, `dbConnectionRef`. `status` is not editable here (use activate/deactivate). Returns the
school object with logo URLs. The audit entry stores only the changed fields. A changed code or timezone takes
effect for sign-in and jobs immediately (cached school state is evicted). Deleted school → `409 INVALID_STATE`
(`details.reason = SCHOOL_DELETED`).

### Logo — `POST /platform/schools/:id/logo` · `DELETE /platform/schools/:id/logo`

Multipart upload, field `file` (JPEG, PNG or WebP, ≤ 5 MB; validated by magic bytes, re-encoded without
EXIF/GPS, WebP thumbnail). Files only exist inside a school's scope, so the logo is stored under that school
(`…/schools/{school_id}/school_logo/{school_id}/{uuid}.{ext}`, files row with `uploaderType: platform_user`) and
linked through `schools.logo_file_id`; a replaced logo is retired. The school's own users see it as their
school logo (`/auth/me`, `GET /files/:id/url`).

```
curl -X POST /api/v1/platform/schools/{id}/logo -H "Authorization: Bearer …" -F "file=@logo.png;type=image/png"
```
```json
{ "success": true, "data": { "logoFileId": "…", "logoUrl": "https://…signed…", "logoThumbnailUrl": "https://…signed…" } }
```
`DELETE` unlinks and retires the logo (idempotent) → `{ "logoFileId": null, "logoUrl": null, "logoThumbnailUrl": null }`.
Errors: `400` no file, `413` too large, `415` not an image.

## Lifecycle

### `POST /platform/schools/:id/deactivate`

```json
{ "status": "inactive", "reason": "Contract ended" }      // status: inactive (default) | suspended; body optional
```
One transaction: status change + **every session of the school's users revoked** + platform audit
(`school.deactivate` / `school.suspend`). After commit:
* cached school state is evicted → sign-in (`403 SCHOOL_INACTIVE`), token refresh, every school/driver/parent
  API call for that school, location ingestion, socket joins and signed file URLs are refused;
* every socket of the school is disconnected (`realtime.disconnectSchool` + the revoked session ids);
* parents whose **only** active school this was are signed out (their sessions revoked through the auth module and
  disconnected); sign-in codes are no longer sent to them; parents with children in another active school stay signed in,
  but `X-School-Id` of the closed school answers `403 SCHOOL_INACTIVE`.

```json
{
  "success": true,
  "data": {
    "school": { "id": "…", "status": "inactive", "statusReason": "Contract ended", "…": "…" },
    "sessions": { "userSessionsRevoked": 17, "parentsSignedOut": 38, "parentSessionsRevoked": 41, "complete": true }
  }
}
```
Idempotent (repeating it re-runs the revocation; `complete: false` means the post-commit parent clean-up failed
and was logged — repeat the call).

### `POST /platform/schools/:id/activate`

```json
{ "reason": "Renewed" }      // optional
```
→ `{ "school": { …, "status": "active" }, "warnings": [] }`. Users sign in again (their old sessions stay revoked).
`warnings` contains `SUBSCRIPTION_EXPIRED` or `SUBSCRIPTION_CANCELLED` when the plan still blocks the school.
Idempotent.

### `DELETE /platform/schools/:id`

Soft delete (`deleted_at`), only for a school that is not active (`409 INVALID_STATE`, `details.reason =
SCHOOL_ACTIVE` → deactivate first). Optional body `{ "reason": "Duplicate onboarding" }`. Revokes sessions like
deactivation. The school disappears from lists (unless `includeDeleted=true`), stays readable by id, and every
further change answers `409 INVALID_STATE` (`SCHOOL_DELETED`). The code stays reserved.

### `POST /platform/schools/:id/admin/reset-password`

Resets **a school admin's access only** (BP §2.2).
```json
{ "userId": "…", "password": "optional chosen password", "delivery": "show" }    // body optional
```
`userId` defaults to the school's first active admin (only admins of that school; anything else → `404`). New
temporary password (generated unless given), forced change at next sign-in, lockout cleared, every session of that
admin revoked and its sockets disconnected; the admin is notified by e-mail (with the password when
`delivery = email`). `Cache-Control: no-store`.
```json
{
  "success": true,
  "data": {
    "admin": { "id": "…", "name": "Meera Iyer", "email": "admin@greenwood.example", "mustChangePassword": true, "…": "…" },
    "sessionsRevoked": 2,
    "credentials": { "delivery": "show", "passwordGenerated": true, "emailDelivered": false, "temporaryPassword": "q8ZlB3xM2hTnPa" }
  }
}
```

## Subscriptions (BP §20 #1)

### `GET /platform/schools/:id/subscription`

```json
{
  "success": true,
  "data": {
    "current": { "id": "…", "plan": "premium", "status": "active", "maxBuses": 20, "maxStudents": 2500,
                 "modules": { "sms": true, "whatsapp": false }, "validFrom": "2026-10-18", "validUntil": "2027-10-18",
                 "notes": "Annual contract", "createdBy": "…", "createdAt": "…", "updatedAt": "…" },
    "usage": { "buses": { "used": 6, "limit": 20, "remaining": 14, "reached": false },
               "students": { "used": 410, "limit": 2500, "remaining": 2090, "reached": false } },
    "history": [ { "…": "newest first, up to 20 rows" } ]
  }
}
```

### `PUT /platform/schools/:id/subscription`

```json
{ "plan": "premium", "status": "active", "maxBuses": 20, "maxStudents": 2500, "validFrom": "2026-10-18",
  "validUntil": "2027-10-18", "modules": { "sms": true, "whatsapp": false }, "notes": "Annual contract" }
```
`plan` required; `status` `active` (default) · `expired` · `cancelled`; `maxBuses` / `maxStudents` `null` =
unlimited (default); `validUntil` inclusive school-local date, `null` = open-ended; `validFrom` defaults to the
school-local date; `modules` keys: `push`, `sms`, `whatsapp`, `email`, `email_digest`, `reports`, `announcements`,
`eta_v2`, `route_deviation`, `speeding`, `harsh_driving` (missing key = allowed). The active row is updated in
place; re-activating after a cancellation/expiry starts a new row (history kept). Audited as
`school.subscription_update` / `school.subscription_create`. Returns the same shape as `GET`.

**Enforcement**
* Every school-scoped request (`resolveTenant`) of a school whose current plan is `cancelled`, `expired` or past
  `validUntil` (school-local date) → `403 SCHOOL_INACTIVE` with `details.reason` `SUBSCRIPTION_CANCELLED` /
  `SUBSCRIPTION_EXPIRED` (+ `validUntil`). Schools without any subscription row are not limited. State is cached
  15 s per API instance and evicted at once on the instance that changed it.
* Create endpoints check the limits inside their transaction (see *For module builders*): exceeding them →
  `403 FORBIDDEN`, `details = { reason: "SUBSCRIPTION_LIMIT", resource: "buses" | "students", limit, used, adding }`.
  Lowering a limit below the current usage is allowed; it only blocks new creates.
* `modules` set to `false` switch the matching school features off (`effective.features` of `GET /school/settings`,
  checked by every feature gate: reports → `403 FEATURE_DISABLED`, announcements, SMS/WhatsApp notifications, e-mail
  digest, ETA v2, route deviation / speeding / harsh driving alerts). `push` is not gated (default channel).

## Global settings — `GET /platform/settings` · `PUT /platform/settings`

`GET` lists every setting: `[{ "key", "value", "description", "isPublic", "updatedBy", "updatedAt" }]`.
`PUT` takes any subset of the known keys (unknown keys → `400`); object-valued keys merge the given fields:

| Key | Value | Rule |
|---|---|---|
| `location.moving_interval_s` | `10` | integer 10–300 (hard floor 10 s) |
| `location.stopped_interval_s` | `90` | integer 60–120 (BP §9.1), ≥ moving interval |
| `location.moving_speed_kmh` | `4` | 0.5–30 |
| `location.stopped_after_s` | `60` | integer 15–600 |
| `location.stale_after_s` | `45` | integer 15–900 |
| `location.retention_months` | `12` | integer 1–60 (partition retention; **public** — schools read it as the maximum for their own `locationRetentionMonths`) |
| `docs.expiry_reminder_days` | `[60, 30, 15, 7, 1]` | 1–10 unique integers 1–365 (stored descending) |
| `trips.stale_close_hours` | `3` | integer 1–48 |
| `trips.late_points_hours` | `24` | integer 1–168 |
| `min_supported_version` | `{ "driver_app": "1.0.0", "parent_app": "1.0.0" }` | semver per app (`driver_app`, `parent_app`, `web_admin`); enforced by the version gate (`426 APP_UPDATE_REQUIRED`) |
| `modules` | `{ "push": true, "sms": false, "whatsapp": false, "email": true }` | booleans |
| `features` | `{ "eta_v2": false, "route_deviation": true, "speeding": true, "harsh_driving": false, "reports": true, "announcements": true }` | booleans (schools can only narrow them) |
| `legal.privacy_url` | `null` | `https://` URL (≤ 500 characters) or `null`; **public** — privacy policy link of the apps and the web panel (schools may override, [privacy.md](privacy.md)) |
| `legal.terms_url` | `null` | `https://` URL or `null`; **public** — terms of use link |
| `legal.consent_version` | `"1"` | 1–32 letters, digits, `.`, `-`, `_`; **public** — version of the parent consent text: changing it asks every parent to consent again (schools may override) |

```json
{ "location.moving_interval_s": 15, "docs.expiry_reminder_days": [30, 7, 1], "min_supported_version": { "driver_app": "1.2.0" } }
```
Returns every setting. Changes are audited (`platform_settings.update`, changed keys only) and published as
`platform_settings.changed` (the version gate and other caches reload).

## `GET /platform/health`

Counts only plus operational health (`Cache-Control: no-store`):
```json
{
  "success": true,
  "data": {
    "status": "ok",
    "generatedAt": "2026-10-18T03:15:00.000Z",
    "counts": { "schools": { "total": 4, "active": 4, "suspended": 0, "inactive": 0 }, "buses": 24, "activeTrips": 7,
                "tripsLast24h": 52, "students": 1630, "parents": 1402, "staff": 51 },
    "api": { "status": "ok", "environment": "production", "uptimeSeconds": 86400, "node": "v24.11.1", "memoryMb": { "rss": 182, "heapUsed": 96 } },
    "database": { "ok": true, "latencyMs": 3 },
    "redis": { "ok": true, "latencyMs": 1 },
    "queue": { "backend": "bullmq", "startedInThisProcess": false,
               "worker": { "level": "ok", "details": { "lastHeartbeatAt": "2026-10-18T03:14:00.012Z", "ageSeconds": 60, "backend": "bullmq" } },
               "jobs": [{ "name": "partition-maintenance", "kind": "cron", "runs": 0, "failures": 0, "running": 0, "queued": 0 }] },
    "checks": { "sms": { "level": "ok", "details": { "provider": "webpayservices", "balance": 4210, "threshold": 500, "low": false } },
                "jobs": { "level": "ok", "details": { "…": "…" } } }
  }
}
```
`status` is the worst of database, Redis and the system checks (`ok` · `warn` · `error`). The job worker writes a
heartbeat every minute (`platform-heartbeat` job); no heartbeat for 3 minutes → `checks.jobs.level = warn`.
`queue.jobs` counters are those of the answering process.

## `GET /platform/usage`

Per-school **counts** next to the plan limits (BP §20 #3). Query: `q`, `status`, `page`, `limit`, `sort` (`name`,
`code`, `status`, `createdAt`), `format=csv`. Deleted schools are excluded.
```json
{
  "success": true,
  "data": [{
    "school": { "id": "…", "code": "GWIS-BLR", "name": "Greenwood International School", "status": "active", "institutionType": "school" },
    "subscription": { "plan": "standard", "status": "active", "validUntil": null, "maxBuses": 50, "maxStudents": 2000 },
    "usage": { "buses": 6, "students": 48, "staff": 14, "parents": 41, "routes": 4, "activeTrips": 2, "tripsLast30Days": 96, "lastActivityAt": "…" },
    "limits": { "buses": { "used": 6, "limit": 50, "remaining": 44, "reached": false }, "students": { "used": 48, "limit": 2000, "remaining": 1952, "reached": false } }
  }],
  "meta": { "page": 1, "limit": 20, "total": 4, "totalPages": 1 }
}
```

## For module builders

```ts
import { assertSubscriptionCapacity, subscriptionAllows } from '../platform/index.js';

// Inside the create transaction, BEFORE inserting (holds a per-school advisory lock until commit):
await withRequestTenant(req, async (tx) => {
  await assertSubscriptionCapacity(tx, 'buses');            // CSV import of 40 students: (tx, 'students', 40)
  const bus = await repo.insert(tx, body);
  …
});
if (!(await subscriptionAllows(tx, 'sms'))) { /* plan switched SMS off for this school */ }
```
The `resolveTenant` subscription hook registers itself when the platform module loads (it is mounted by
`src/modules/index.ts`). Event `school.subscription_changed` (`{ schoolId }`) is emitted after a plan change.

## Demo data (`src/db/seeds/10_platform.ts`)

Adds the remaining contract §14 tenants, onboarded like `POST /platform/schools`: **Lakeview Academy**
(`LAKEVIEW-HYD`, Hyderabad, Telangana; admin `admin@lakeview.example`; plan `standard`, 12 buses / 900 students,
valid 45 days) and **Riverside College** (`RIVERSIDE-COK`, Kochi, Kerala, `institution_type = college`; admin
`admin@riverside.example`; plan `premium`, 20 buses / 2500 students, valid 1 year). Admin password: the seed
default (`SEED_DEFAULT_PASSWORD` or `Wimb@12345`). Idempotent.
