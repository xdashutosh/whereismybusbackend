# Users API (school admins)

Blueprint §2.1 ("first admin by the Super Admin, then other school admins"), §5.4, §8.3 (Admin users),
§13.3 (Users & Roles); contract §6. Base `/api/v1`. Source: `backend/src/modules/users/`.
Drivers and conductors are managed by the staff module (`/school/staff`, `POST /:id/credentials`).

Every endpoint: **school admin** of an active school; another school's admin id (or a driver's id) →
`404`; drivers, conductors and parents → `403`. Writes are audited (`school_admin.*`); passwords are
never written to the audit log.

## Admin object

```json
{ "id": "01a1…", "fullName": "Arjun Nair", "email": "transport@greenwood.example", "phone": "+919845000110",
  "isActive": true, "mustChangePassword": true, "locked": false, "lastLoginAt": null, "passwordChangedAt": null,
  "isSelf": false, "createdBy": "01a1…", "createdAt": "…", "updatedAt": "…" }
```
`locked` = temporarily locked after too many failed sign-ins; `isSelf` marks the caller's own account.

## `GET /school/admins`

| Query | Meaning |
|---|---|
| `page`, `limit` | pagination |
| `sort` | `fullName` (default), `email`, `createdAt`, `lastLoginAt`, `isActive` |
| `status` | `active` · `inactive` · `all` (default: all) |
| `q` | name, e-mail or phone contains |
| `format` | `json` · `csv` (`school-admins.csv`) |

Deleted admins are never listed.

## `POST /school/admins`

No `Idempotency-Key` replay (the response can carry a temporary password, which a replay store would keep
for 24 h): a retry answers `409 DUPLICATE` on `email`; a lost password is replaced with `reset-access`.
The response is sent with `Cache-Control: no-store`.

```json
{ "fullName": "Arjun Nair", "email": "transport@greenwood.example", "phone": "98450 00110" }
```
Optional `password` (≥ 8 characters with a letter and a digit). Without it the server generates a
temporary password. `201`:
```json
{ "success": true, "data": {
  "admin": { "id": "01a1…", "fullName": "Arjun Nair", "email": "transport@greenwood.example", "mustChangePassword": true, "…": "…" },
  "temporaryPassword": "Kmtp-Wqra-4827" } }
```
* `temporaryPassword` is shown **once** (`null` when the caller chose the password). The account must
  change it at the first sign-in (`POST /auth/school/login` → `mustChangePassword: true`, then
  `POST /auth/change-password`).
* A welcome e-mail goes to the new admin (SMTP, or the log in development) with the sign-in link
  (`APP_PUBLIC_URL/school/login`) and — only when generated — the temporary password.
* The e-mail is the global sign-in identifier: one already used by any school admin account (any
  school) → `409 DUPLICATE` (the other school is never named). It becomes free again when that account
  is deleted.

## `GET /school/admins/:id` · `PATCH /school/admins/:id`

`PATCH`: any of `fullName`, `email`, `phone` (`""`/`null` clears the phone). Audit `school_admin.update`
with before/after values.

## `POST /school/admins/:id/deactivate`

```json
{ "reason": "Moved to another campus" }
```
→ `200` with the admin (`isActive: false`) plus `revokedSessions`. In one transaction every session of
the account is revoked; after commit its sockets are disconnected. Sign-in is refused (`403`, "This
account has been deactivated"). Deactivation never deletes history. Already inactive → `200`, no change.
* Your own account → `403 FORBIDDEN` (`details.reason = "SELF"`).
* The school always keeps at least one active admin → `409 INVALID_STATE`
  (`details.reason = "LAST_ACTIVE_ADMIN"`). All active admin rows are locked first, so two admins
  deactivating each other at the same moment can never both succeed.

## `POST /school/admins/:id/activate`

→ `200` with the admin (`isActive: true`). Already active → `200`, no change.

## `POST /school/admins/:id/reset-access`

Body optional: `{ "password": "Temp#2026x" }`. → `200` (`Cache-Control: no-store`):
```json
{ "success": true, "data": { "admin": { "id": "01a1…", "mustChangePassword": true, "locked": false, "…": "…" },
                             "temporaryPassword": "Hqvz-Ptsa-5392", "revokedSessions": 2 } }
```
Sets the temporary password (generated unless given), forces a change at the next sign-in, clears a
sign-in lockout, revokes every session and disconnects the sockets. The admin receives a reset
e-mail. Your own account → `403` (use `POST /auth/change-password`).

## `POST /school/admins/:id/sessions/revoke` — sign out all devices

No body. Revokes every session of that admin and disconnects its sockets, without changing the password, lockout or
status (audited as `school_admin.sessions_revoke`). → `200 { "id": "…", "revokedSessions": 3 }`. Your own account →
`403` with `details.reason: "SELF"` (use `POST /auth/logout-all`).

## `DELETE /school/admins/:id`

→ `200 { "id": "…", "deleted": true }`. Soft delete (`deleted_at`, inactive), sessions revoked and sockets disconnected, history kept;
the e-mail can be used again. Your own account → `403`; the last active admin → `409 INVALID_STATE`.

## Errors

| Status | When |
|---|---|
| `400 VALIDATION_ERROR` | invalid name/e-mail/phone/password, malformed id |
| `403 FORBIDDEN` | not a school admin; acting on your own account (deactivate, reset, delete, sessions/revoke) |
| `404 NOT_FOUND` | unknown id, another school's admin, a driver/conductor id |
| `409 DUPLICATE` | e-mail already used by a school admin account |
| `409 INVALID_STATE` | would leave the school without an active admin |
