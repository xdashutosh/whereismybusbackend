# Audit API

Contract §5, blueprint §6.2 / §8.2 / §8.3 / §13.3. Base `/api/v1`. Source: `backend/src/modules/audit/`
(read endpoints) and `backend/src/shared/audit.ts` (writes).

## Writing (every module)

```ts
await audit.log(tx, { action: 'bus.update', entityType: 'bus', entityId: bus.id, ...changedFields(before, after) });
```
Same transaction as the change. `school_id`, actor id and actor type come from the transaction context;
IP, user agent, request id and actor name from the request. Keys that look like secrets (password,
token, otp, pin, hash, totp, …) are replaced by `[REDACTED]`. The app role may only INSERT and SELECT
`audit_logs` — rows cannot be changed or deleted. Actions are `<entity>.<verb>` (`auth.login`,
`file.upload`, `bus_document.replace`).

Platform-level actions (super admin) are stored with `school_id = NULL` and appear only in the platform
trail. Parent sign-ins are not stored in `audit_logs` (they would be school-less rows readable by the
Super Admin); parents' writes inside a school (e.g. notification preferences) are audited in that school.

## `GET /school/audit-logs` (school admins)

| Query | Meaning |
|---|---|
| `page`, `limit` | pagination (limit 1–100, default 20) |
| `sort` | `createdAt`, `action`, `actorName`, `entityType` (prefix `-` for descending; default `-createdAt`) |
| `actorId`, `actorType` | `user`, `platform_user`, `parent_account`, `system` |
| `action` | exact (`bus.create`) or prefix ending in `.` or `*` (`auth.*`) |
| `entityType`, `entityId` | the changed record |
| `from`, `to` | `YYYY-MM-DD` (school-local days, `to` inclusive) or ISO-8601 instants |
| `q` | text search in action, actor name and entity type |
| `format` | `json` (default) or `csv` |

```
GET /api/v1/school/audit-logs?action=auth.*&from=2026-10-01&to=2026-10-17&limit=2
```
```json
{
  "success": true,
  "data": [
    { "id": 1042, "createdAt": "2026-10-17T04:12:09.512Z", "actorType": "user", "actorId": "01a1…", "actorName": "Meera Iyer",
      "ip": "203.0.113.24", "userAgent": "Mozilla/5.0 …", "requestId": "5f0c…", "action": "auth.login",
      "entityType": "session", "entityId": "01a1…", "oldValues": null, "newValues": { "method": "password", "client": "web" } },
    { "id": 1031, "createdAt": "2026-10-16T09:01:44.008Z", "actorType": "user", "actorId": "01a1…", "actorName": null,
      "ip": "203.0.113.24", "userAgent": "…", "requestId": "…", "action": "auth.account_locked",
      "entityType": "user", "entityId": "01a1…", "oldValues": null, "newValues": { "reason": "bad_password", "lockedUntil": "2026-10-16T09:16:44.008Z" } }
  ],
  "meta": { "page": 1, "limit": 2, "total": 7, "totalPages": 4 }
}
```

`format=csv` streams `audit-log.csv` (UTF-8 BOM, formula-injection guard) with the columns
`Time (UTC), Actor type, Actor, Actor ID, Action, Entity type, Entity ID, IP, Request ID, Old values, New values`
(up to 10 000 rows). Drivers, conductors, parents and super admins get `403`.

## `GET /platform/audit-logs` (super admins)

Same query parameters and response; only platform-level rows (school creation/changes, platform sign-ins,
TOTP enrolment, …). School rows are never visible to the Super Admin (RLS).

## Auth actions

| Action | When | `newValues` |
|---|---|---|
| `auth.login` | successful sign-in | `method` (`password`, `pin`, `password+totp`, `password+totp_enrolment`), client/device |
| `auth.login_failed` | wrong password / PIN / TOTP | `reason` |
| `auth.account_locked` | the failure that locked the account | `reason`, `lockedUntil` |
| `auth.totp_enroll` | Super Admin enabled TOTP | — |
| `auth.logout`, `auth.logout_all` | sign-out | `revokedSessions` (logout-all) |
| `auth.password_change` | password changed | `initial`, `otherSessionsRevoked` |
| `auth.refresh_reuse` | a rotated refresh token was presented again (outside the 30-s grace window, or from another client/device) | `familyId` |
| `file.create`, `file.upload`, `file.reject` | files module | category, size, sha256, reason |
| `privacy.export` | a school admin exported everything about one student / parent ([privacy.md](privacy.md)) | `sections` (item count per section — no personal data) |
| `privacy.erase` | irreversible erasure of a student / parent | counts (`parentLinksRemoved`, `notificationsDeleted`, `filesDeleted`, `consentsRedacted`, …) and the optional `reason` |
| `privacy.consent_accept` | a parent accepted the school's consent version (actor = the parent) | `version`, `appName`, `appVersion` |
