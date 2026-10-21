# Users API: administrative accounts

Module `users` · base path `/api/v1` · contract: ARCHITECTURE §6 · source `backend/src/modules/users/`.

Roles allowed: `REGION_ADMIN`, `STATE_ADMIN`, `SYSTEM_ADMIN`. A `DEPOT_ADMIN` has no user-management
authority and gets `403 FORBIDDEN`.

## Guardrails (all enforced server-side)

1. **Strictly lower roles.** REGION_ADMIN manages `DEPOT_ADMIN`s; STATE_ADMIN manages `REGION_ADMIN` and
   `DEPOT_ADMIN`; SYSTEM_ADMIN manages everyone, including other system admins, passengers and drivers.
2. **Scope containment.** The target user, and any new scope assigned to them, must lie inside the
   caller's scope. Users outside the caller's authority behave as if they did not exist (`404 NOT_FOUND`);
   assigning a depot, region or state outside your scope returns `403 OUT_OF_SCOPE`.
3. **No self-escalation.** Nobody changes their own `role`, scope (`stateId/regionId/depotId`), `isActive`
   or `mustChangePassword` (`403 FORBIDDEN`). Your own `fullName`, `email` and `phone` can be edited.
4. **Last system admin.** The last active SYSTEM_ADMIN can be neither deactivated nor demoted
   (`409 CONFLICT`, `details.reason = "LAST_SYSTEM_ADMIN"`). Concurrent changes are serialised with a
   transaction-scoped advisory lock.
5. **Session revocation.** A change of role, scope or status, or a password reset, bumps `token_version`
   (outstanding access tokens stop working at once) and revokes every refresh token.
6. Accounts created here are administrative only. **Driver logins** are provisioned by the drivers
   module; **passengers** register themselves. For PASSENGER accounts SYSTEM may change
   `fullName, email, phone, isActive, mustChangePassword`; for DRIVER accounts only `isActive` and
   `mustChangePassword` (other fields: `400 VALIDATION_ERROR`, "managed through the drivers module").

Scope column per role: `DEPOT_ADMIN` → `depotId`, `REGION_ADMIN` → `regionId`, `STATE_ADMIN` → `stateId`,
`SYSTEM_ADMIN` → none. The parent levels are derived automatically. Sending a scope field that does not
belong to the role returns `400 VALIDATION_ERROR` on that field. Inactive targets are refused too.

## User DTO

```json
{ "id": "ec70…", "fullName": "Electronic City Depot Admin", "email": "depot.ecity@example.com", "phone": null,
  "username": null, "role": "DEPOT_ADMIN",
  "stateId": "aba9…", "stateName": "Karnataka", "regionId": "512d…", "regionName": "Bengaluru South",
  "depotId": "2710…", "depotName": "Electronic City",
  "isActive": true, "mustChangePassword": false, "lastLoginAt": null,
  "createdAt": "…Z", "updatedAt": "…Z", "driverId": null, "driverEmployeeCode": null }
```
Details and mutation responses add
`permissions: { canEdit, canChangeRole, canChangeScope, canDeactivate, canResetPassword }`.
Password hashes, token versions and failure counters are never returned.

---

## GET /admin/users

Query: `page, pageSize, sort (fullName|email|role|isActive|lastLoginAt|createdAt; default fullName), q`
(name, e-mail, phone or username contains), `role` (comma separated), `stateId`, `regionId`, `depotId`,
`isActive`.

- Default `role` filter: the roles you may manage (SYSTEM: the four admin roles). SYSTEM can list
  `role=PASSENGER,DRIVER`.
- Asking for a role you cannot manage returns `403 FORBIDDEN`. A `stateId/regionId/depotId` outside your
  scope returns `403 OUT_OF_SCOPE`.

```json
{ "success": true, "data": [ { …user DTO… } ], "meta": { "page": 1, "pageSize": 20, "total": 6, "totalPages": 1 } }
```

## GET /admin/users/:id

A user you may manage, or yourself. Anyone else returns `404 NOT_FOUND`.

## POST /admin/users

```json
{ "fullName": "Jayanagar Depot Admin", "email": "depot.jayanagar@example.com", "phone": "+91 98450 00001",
  "role": "DEPOT_ADMIN", "depotId": "…JYN depot id…" }
```

Optional: `password` (must satisfy the policy) and `mustChangePassword` (default `true`). Without a
`password` a **one-time temporary password** is generated and `mustChangePassword` is forced to `true`.

`201` (`Cache-Control: no-store`):

```json
{ "success": true,
  "data": { "user": { …user DTO…, "permissions": { … } }, "temporaryPassword": "kP7@xr2MvQ9nTb" } }
```

`temporaryPassword` is `null` when a password was supplied. It is shown only once: it is never stored in
clear and never audited. The new user signs in and must change it (`403 PASSWORD_CHANGE_REQUIRED`
elsewhere until they do). Audited as `user.create`.

| Error | When |
|---|---|
| `400 VALIDATION_ERROR` | invalid field; `role` not an admin role; missing, extra or inactive scope target |
| `403 FORBIDDEN` | role not strictly below yours |
| `403 OUT_OF_SCOPE` | target depot, region or state outside your scope |
| `409 DUPLICATE` | `details.field` = `email` or `phone` |

## PATCH /admin/users/:id

Any of `{ fullName, email, phone, role, stateId, regionId, depotId, isActive, mustChangePassword }`.

- **Role change**: the new role must be strictly below yours and the matching scope field must be sent,
  for example `{ "role": "REGION_ADMIN", "regionId": "…" }`.
- **Scope change** keeping the role: send just the role's scope field, for example `{ "depotId": "…" }`.
- Audit action: `user.deactivate` / `user.activate` for a pure status change, otherwise `user.update`.
  `before`/`after` hold only the changed fields.

`200` returns the user DTO with `permissions`.

| Error | When |
|---|---|
| `403 FORBIDDEN` | changing your own role, scope or status; assigning a role at or above yours |
| `403 OUT_OF_SCOPE` | new scope outside yours |
| `404 NOT_FOUND` | user outside your authority |
| `409 CONFLICT` | last active SYSTEM_ADMIN |
| `409 DUPLICATE` | e-mail or phone taken |

## POST /admin/users/:id/reset-password

Body `{}`. For users you may manage (not yourself: use `POST /auth/change-password`).

`200` (`Cache-Control: no-store`):

```json
{ "success": true, "data": { "userId": "…", "temporaryPassword": "Qm4#hT8xWvR2pa", "mustChangePassword": true } }
```

The temporary password replaces the old one, `mustChangePassword` is set, the failure counter is cleared,
and every session and pending reset link of the user is revoked. Audited as `user.resetPassword` (without
the password).
