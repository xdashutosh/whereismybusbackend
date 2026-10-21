# Drivers API (`drivers` module, incl. documents)

Module `drivers` · base path `/api/v1` · contract: ARCHITECTURE §3.3, §3.6, §4, §5, §6, §13, §17 "Drivers" /
"Documents", §24, §25 · FRD §6 · source `backend/src/modules/drivers/` (`documents.*.js` = documents
sub-component, also serving bus documents and archived import sources).

Roles: every admin role; drivers/passengers get `403 FORBIDDEN`. Scope as for buses: depot admin → own depot,
region admin → depots of the region, state admin → depots of the state, system admin → all. By id outside
scope → `404`; `depotId`/`regionId` filters or target depots outside scope → `403 OUT_OF_SCOPE`. Every mutation
is audited in the same transaction (`driver.*`, `driverAttendance.upsert`, `document.*`).

Natural keys: `employeeCode` (case-insensitive, stored upper-case, `^[A-Z0-9][A-Z0-9_./-]{0,39}$`, e.g.
`DRV-SHN-001`), `licenseNo` (upper-case without spaces, 5–25 of `A-Z 0-9 / -`). `phone` is stored without
spaces/dashes/brackets (7–15 digits, optional `+`); `email` lower-case; `bloodGroup` one of
`A+ A- B+ B- AB+ AB- O+ O-` (`"b +ve"` is accepted as `B+`). Statuses: `ACTIVE`, `ON_LEAVE`, `SUSPENDED`, `INACTIVE`.

**Driver logins** (§6): only this module provisions `DRIVER` users — `username` = employee code,
`must_change_password = true`, scope = the driver's depot. The driver signs in with the employee code
(`POST /auth/login { identifier: "DRV-SHN-001", password }`) and must change the temporary password before
any other endpoint answers (`403 PASSWORD_CHANGE_REQUIRED`). Temporary passwords are returned **once** and
never stored in plain text, logged or audited.

## Driver DTO (list item)

```json
{ "id": "ad7c…", "depotId": "…", "depotCode": "SHN", "depotName": "Shanthinagar", "regionId": "…", "regionName": "Bengaluru",
  "employeeCode": "DRV-SHN-003", "fullName": "Suresh Reddy", "phone": "9845200321", "email": null,
  "licenseNo": "KA0120090000111", "licenseExpiry": "2026-10-26", "licenseExpired": false,
  "dateOfJoining": "2008-04-01", "status": "ACTIVE", "hasLogin": true, "username": "DRV-SHN-003",
  "createdAt": "…Z", "updatedAt": "…Z" }
```

`hasLogin` = a linked user exists **and** is active.

## GET /admin/drivers

| Query | Meaning |
|---|---|
| `page`, `pageSize` | default 1 / 20, max 100 |
| `sort` | `fullName` (default), `employeeCode`, `status`, `licenseExpiry`, `dateOfJoining`, `depotName`, `regionName`, `createdAt`, `updatedAt` |
| `q` | name, employee code (substring, case-insensitive), phone or licence number (spaces/dashes ignored) |
| `status` | list (`status=ACTIVE,ON_LEAVE`) |
| `licenseExpiringWithinDays` | 0–3650: licence expiring on or before today + N (expired included) |
| `hasLogin` | `true` / `false` |
| `regionId`, `depotId` | narrow inside scope |
| `format` | `json` or `csv` (max 10 000 rows, `drivers.csv`: `Employee Code, Full Name, Depot, Region, Status, Phone, Email, Licence No, Licence Expiry, Date of Joining, Has Login`; formula guard applied) |

One SQL query per page; cached 60 s in `admin:drivers` (invalidated by every driver/login/import write).

## POST /admin/drivers

```json
{ "depotId": "…", "employeeCode": "drv-shn-001", "fullName": "Ramesh Kumar", "phone": "+91 98450 12345",
  "email": "ramesh@example.com", "licenseNo": "KA01 20110012345", "licenseExpiry": "2030-05-31",
  "dateOfBirth": "1984-02-11", "dateOfJoining": "2010-06-01", "bloodGroup": "B+", "address": "…",
  "emergencyContact": "…", "status": "ACTIVE", "createLogin": true, "initialPassword": "Optional1" }
```

Required: `employeeCode`, `fullName`, `phone`, `licenseNo`, `licenseExpiry`. `depotId` defaults to the
caller's depot (required for higher admins). `dateOfJoining` must be after `dateOfBirth`. `initialPassword`
(≥ 8 chars, a letter and a digit) is only allowed with `createLogin: true`; without it a 12-character
temporary password is generated. Response `201` = detail DTO; when a login was created, `login` also carries:

```json
"login": { "hasLogin": true, "username": "DRV-SHN-001", "isActive": true, "mustChangePassword": true,
           "lastLoginAt": null, "temporaryPassword": "q7JmT2xkRw4P", "passwordGenerated": true }
```

(`temporaryPassword` is `null` when `initialPassword` was supplied.) Errors: `400`, `403 OUT_OF_SCOPE`,
`409 DUPLICATE` with `details.field` = `employeeCode` (driver code or a **non-driver** user already owning
that username) or `licenseNo`. An orphaned, unlinked DRIVER user with the same username is re-used.

## GET /admin/drivers/:id

List fields plus `dateOfBirth, bloodGroup, address, emergencyContact, userId, stateId, stateName, timezone, today` and:

```json
{ "license": { "expiry": "2026-10-26", "expired": false, "expiringSoon": true },
  "photoUrl": "https://…presigned… (or /api/v1/admin/documents/<id>/download/file?token=… with local storage)",
  "photoUrlExpiresAt": "2026-10-17T08:51:00.000Z",
  "currentTrip": null, "nextTrip": { "id": "…", "status": "SCHEDULED", "routeCode": "500D", "…": "see buses.md" },
  "stats": { "tripsCompleted30d": 2, "onTimePercent30d": 50, "upcomingTrips": 1,
             "attendanceThisMonth": { "month": "2026-10", "PRESENT": 6, "ABSENT": 0, "LEAVE": 0, "OFF": 1 } },
  "documentCount": 2,
  "login": { "hasLogin": true, "username": "DRV-SHN-003", "isActive": true, "mustChangePassword": false, "lastLoginAt": null },
  "permissions": { "canEdit": true, "canChangeStatus": true, "canDelete": true, "deleteMode": "HARD", "canManageLogin": true,
                   "canDisableLogin": true, "canRecordAttendance": true, "canManageDocuments": true } }
```

`onTimePercent30d` = share of trips completed in the last 30 days that started no later than planned start +
`trips.autoDelayGraceMinutes` (`null` without completed trips). `documentCount` excludes the photo. One SQL
query (+ the cached setting).

## PATCH /admin/drivers/:id

Any create field except `createLogin`/`initialPassword` (at least one), plus `acknowledgeFutureTrips`.
**IN_USE rule**: `status` → `ON_LEAVE`/`SUSPENDED`/`INACTIVE` or a depot move while upcoming not-started trips
exist → `409 IN_USE` with `details: { count, trips: [next 20 …] }` (shape in [buses.md](buses.md#patch-adminbusesid))
unless `acknowledgeFutureTrips: true`. The login follows the record: `employeeCode` → `username`, `fullName`,
depot; a depot move also bumps `token_version` and revokes refresh tokens (scope change). Response `200` detail.

## DELETE /admin/drivers/:id

Upcoming trips → `409 IN_USE`. Ever referenced by trips/schedules/assignment history → soft delete:
`status = INACTIVE`, login deactivated (token version bumped, refresh tokens revoked) →
`{ "id", "mode": "SOFT", "status": "INACTIVE", "loginDisabled": true }`. Otherwise hard delete (attendance
cascades, documents soft-deleted + objects removed after commit, login user deleted — or deactivated if
something still references it) → `{ "id", "mode": "HARD", "status": null, "loginDisabled": true|false }`.

## POST /admin/drivers/:id/login

Body `{}` or `{ "password": "Reset2026x" }`. Provisions the login when missing, otherwise resets it: new
password, `must_change_password = true`, re-activated, failed-login counter cleared, `token_version + 1`
(existing access tokens die), all refresh tokens revoked. Inactive drivers → `409 CONFLICT`.

```json
{ "success": true, "data": { "userId": "…", "username": "DRV-SHN-001", "created": false, "isActive": true,
  "mustChangePassword": true, "temporaryPassword": "q7JmT2xkRw4P", "passwordGenerated": true } }
```

Audit: `driver.loginProvision` / `driver.loginReset` (no password material).

## POST /admin/drivers/:id/login/disable

Deactivates the user, bumps `token_version`, revokes refresh tokens →
`{ "userId", "username", "isActive": false }`. No login → `409 CONFLICT`. Audit `driver.loginDisable`.

## GET /admin/drivers/:id/trips?when=current|upcoming|past

Same semantics and item shape as [buses](buses.md#get-adminbusesidtripswhencurrentupcomingpast).

## Attendance

### GET /admin/drivers/:id/attendance?from&to
Dates `YYYY-MM-DD` (state timezone). Defaults: current month up to today; with only `from`, 31 days. Max 92
days. Response:

```json
{ "driverId": "…", "timezone": "Asia/Kolkata", "from": "2026-10-01", "to": "2026-10-17",
  "summary": { "PRESENT": 6, "ABSENT": 0, "LEAVE": 0, "OFF": 1 },
  "records": [ { "id": "…", "date": "2026-10-10", "status": "PRESENT", "checkInAt": "…Z", "checkOutAt": "…Z",
                 "source": "MANUAL", "notes": null, "recordedBy": "…", "recordedByName": "…", "createdAt": "…Z", "updatedAt": "…Z" } ] }
```

### PUT /admin/drivers/:id/attendance/:date
`{ status: PRESENT|ABSENT|LEAVE|OFF, checkInAt?, checkOutAt? (≥ checkInAt), notes? }` → upsert with
`source = MANUAL`, `recordedBy` = caller (overrides an AUTO row; audited with before/after). Future dates
accept only `LEAVE`/`OFF` (up to one year ahead) — leave days make the driver unavailable. Response `200` record.

## GET /admin/drivers/:id/availability?from&to

As for [buses](buses.md#get-adminbusesidavailabilityfromto), plus `employeeCode`, `fullName` and
`leaveDates` (LEAVE attendance days within the range); `reasons` may contain `STATUS_ON_LEAVE`,
`STATUS_SUSPENDED`, `STATUS_INACTIVE`, `ON_LEAVE`, `CONFLICT`.

## Documents

Documents hold file metadata; bytes live in private object storage (S3-compatible in production, the
`local` driver in tests/dev) under `S3_KEY_PREFIX`: `drivers/{driverId}/{docId}-{safeName}`,
`buses/{busId}/{docId}-{safeName}`, `imports/{batchId}/{safeName}`. Uploads are checked by **magic bytes**
(the declared MIME type is ignored), the file name is sanitised and a SHA-256 checksum stored. Upload flow:
object first → row (+ audit) in one transaction → object deleted again if the transaction fails. Scope =
the owner's depot (`documents.depot_id`, moved with the owner); outside scope → `404`.

### Document DTO

```json
{ "id": "…", "ownerType": "DRIVER", "ownerId": "…", "depotId": "…", "kind": "LICENSE",
  "fileName": "Driving_Licence_front_.pdf", "contentType": "application/pdf", "sizeBytes": 82113,
  "checksumSha256": "9f2c…", "validUntil": "2026-10-27", "expired": false, "expiringSoon": true,
  "notes": "Renewal due", "uploadedBy": "…", "uploadedByName": "Shanthinagar Depot Admin", "createdAt": "…Z" }
```

`expired` = `validUntil` before today, `expiringSoon` = within 30 days (state timezone). The storage key is
never returned.

### GET /admin/drivers/:id/documents
`page`, `pageSize`, `sort` (`-createdAt` default, `kind`, `validUntil`, `fileName`), `kind` list filter.
Live (not deleted) documents only.

### POST /admin/drivers/:id/documents (multipart/form-data)
`file` (≤ 10 MB; JPEG, PNG, WEBP or PDF), `kind` (`LICENSE`, `ID_PROOF`, `OTHER`), `validUntil?`, `notes?`
→ `201` document DTO. Errors: `400` (no file, bad kind/date), `404`, `413 PAYLOAD_TOO_LARGE`,
`415 UNSUPPORTED_FILE`. (Bus kinds: see [buses.md](buses.md#bus-documents).)

### PUT /admin/drivers/:id/photo (multipart/form-data)
`file` (≤ 2 MB; JPEG, PNG or WEBP). Stores a new `PHOTO` document and, in the same transaction,
soft-deletes the previous photo(s); their objects are removed after commit. Audit `driver.photoUpdate`.

```json
{ "success": true, "data": { "document": { "id": "…", "kind": "PHOTO", "contentType": "image/jpeg", "…": "…" },
  "photoUrl": "…", "photoUrlExpiresAt": "2026-10-17T08:51:00.000Z" } }
```

### DELETE /admin/documents/:docId
Soft-deletes the row (audit `document.delete`), then removes the object (best effort, logged) → `204`.
Archived import sources (`IMPORT_SOURCE`) are kept for audit → `409 CONFLICT`.

### GET /admin/documents/:docId/download
→ `{ "documentId", "url", "expiresAt", "fileName", "contentType", "sizeBytes" }`. `url` is a presigned S3 GET
(5 min, `Content-Disposition: attachment`). With the local storage driver it is
`/api/v1/admin/documents/:docId/download/file?token=…`.

### GET /admin/documents/:docId/download/file?token=… (local storage driver only)
No `Authorization` header: the HMAC-signed, 5-minute token (issued only to admins whose scope covers the
owner's depot) is the authority, exactly like a presigned URL. Streams the bytes with the stored content
type, `Content-Disposition: attachment`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`.
Invalid/expired token → `403 FORBIDDEN`; token for another document, deleted document or missing token → `404`.
With the S3 driver this route always answers `404`.

## Caching

| Namespace | TTL | Content | Invalidated by |
|---|---|---|---|
| `admin:drivers` | 60 s | `GET /admin/drivers` pages | driver create/update/delete, login provision/reset/disable, driver imports |

Details, trips, attendance, availability and documents are read live. Authorization is never cached.

## Internal service API (for other modules)

`src/modules/drivers/service.js`:

| Function | Description |
|---|---|
| `invalidateDriversCache()` | bumps `admin:drivers` after a committed driver write |
| `getBrief(scope, id, { client })` | `{ id, depotId, employeeCode, fullName, status, timezone }` inside scope, else `NOT_FOUND` |
| `recordAutoAttendance(client, { driverId, date, checkInAt })` | for the trips module on trip start (§8): inserts `PRESENT`/`AUTO` for the local `date` or fills the check-in of an existing AUTO/PRESENT day; never overrides a manual LEAVE/ABSENT/OFF decision |
| `generateTemporaryPassword()` | 12-char password satisfying the §5 policy |

`src/modules/drivers/documents.service.js`:

| Function | Description |
|---|---|
| `storeWithTransaction({ ownerType, ownerId, file }, fn)` | writes the object, runs `fn(client, { docId, storageKey, row(extra) })` in one transaction, deletes the object if it fails |
| `insertDocument(client, req, values)` / `insertDocumentRow(client, values)` | insert a documents row with / without its own audit entry |
| `downloadUrlFor({ id, storageKey, fileName })` | short-lived `{ url, expiresAt }` for any storage driver |
| `listForOwner`, `uploadForOwner`, `remove`, `downloadLink`, `findLiveDocument` | the endpoint logic, reusable for other owner types |
| `softDeleteOwnerDocuments(client, ownerType, ownerId)` + `deleteObjectsQuietly(keys)` | owner removal: soft-delete rows in the transaction, remove objects after commit |

`src/modules/drivers/schemas.js` exports the normalisers (`normaliseEmployeeCode`, `normaliseLicense`,
`normalisePhone`, `normaliseBloodGroup`) and `password()` (§5 policy schema).
