# Stops API (`stops` module)

Permanent stop master data (FRD §4; ARCHITECTURE §3.2, §6, §7, §14). Base path `/api/v1`.
Every endpoint needs an access token (`Authorization: Bearer …`) of an **admin** role
(`DEPOT_ADMIN`, `REGION_ADMIN`, `STATE_ADMIN`, `SYSTEM_ADMIN`); other roles get `403 FORBIDDEN`,
anonymous callers `401 UNAUTHENTICATED`.

The stop catalogue is **global**: every admin can read every stop of every state. Writes follow
the authority rules below. Errors use the standard envelope
`{ "success": false, "error": { "code", "message", "details?", "requestId" } }`.

## Authority rules

**Established** = referenced by any route version (`isReferenced`) **or** older than
`stops.graceEditHours` (default 24 h). Both values are returned on every stop
(`isEstablished` is the effective flag).

| Stop | DEPOT_ADMIN | REGION_ADMIN | STATE_ADMIN | SYSTEM_ADMIN |
|---|---|---|---|---|
| Create | ✓ unless `stops.depotAdminCreateEnabled=false` (`RESTRICTED_BY_SYSTEM`) | ✓ | ✓ | ✓ |
| Edit / delete **non-established** | stops created by own depot | stops created by a depot of own region | stops of own state | ✓ |
| Edit / delete **established** | change request only | change request only | stops of own state, `reason` required; `RESTRICTED_BY_SYSTEM` when `stops.stateAdminEditEnabled` (edit) / `stops.stateAdminDeleteEnabled` (delete, deactivate) is `false` | ✓, `reason` required |
| Request a change (established stops) | ✓ (any stop) | ✓ (any stop) | – | – |
| Review change requests | – | – | requests on stops of own state | ✓ |

Without authority a mutation answers `403 FORBIDDEN`. Deactivation (`status: INACTIVE`) uses
the delete/deactivate authority; any other field uses the edit authority.

## Stop DTO

```json
{
  "id": "8d0c7d0e-6f43-4a0c-9d55-2f9a8c0b1e11",
  "code": "STP-000042",
  "name": "Kempegowda Bus Station (Majestic)",
  "nameLocal": "ಕೆಂಪೇಗೌಡ ಬಸ್ ನಿಲ್ದಾಣ",
  "lat": 12.9772,
  "lng": 77.5713,
  "classification": "MAJOR",
  "landmark": "Opposite KSR Bengaluru City railway station",
  "address": null,
  "stateId": "1b7…", "stateName": "Karnataka", "stateCode": "KA",
  "createdByDepotId": "5c2…", "createdByDepotName": "Shantinagar", "createdByDepotCode": "SHN",
  "createdBy": "a91…", "createdByName": "Depot Admin SHN",
  "status": "ACTIVE",
  "isReferenced": true,
  "isEstablished": true,
  "deletedAt": null,
  "version": 3,
  "createdAt": "2026-10-16T05:12:44.120Z",
  "updatedAt": "2026-10-17T07:40:02.881Z",
  "routeCount": 8
}
```

- `code` is generated (`STP-000001` …) and never changes; seeded stops use natural codes (`BLR-KBS`).
- `routeCount` = routes whose **current** version uses the stop (list and detail).
- `distanceM` (metres) is present in lists filtered by `lat`/`lng`.
- `version` is the optimistic-lock counter required by `PATCH`.

---

## GET /admin/stops

Paginated, cached 60 s (namespace `admin:stops`, invalidated by every stop write). One SQL query.

| Query | Description |
|---|---|
| `q` | code / name / local name substring (case-insensitive) **or** trigram similarity on the name (typos) |
| `classification` | `MAJOR`, `MINOR` (comma separated) |
| `status` | `ACTIVE`, `INACTIVE` (comma separated) |
| `stateId`, `createdByDepotId` | exact filters (the catalogue is global, so no scope restriction) |
| `establishedOnly` | `true` → only effectively established stops |
| `lat`, `lng`, `radiusMeters` | proximity filter (`radiusMeters` 1–50 000, default 1 000); adds `distanceM` |
| `includeDeleted` | `true` → also soft-deleted stops. **STATE_ADMIN / SYSTEM_ADMIN only** (`403 FORBIDDEN` otherwise) |
| `sort` | one of `code, name, classification, status, stateName, depotName, createdAt, updatedAt, routeCount, distance` (needs `lat/lng`), `relevance` (needs `q`); prefix `-` for descending. Default: `distance` with `lat/lng`, `relevance` with `q`, otherwise `name` |
| `page`, `pageSize` | 1…, 1–100 (default 20) |
| `format` | `csv` → CSV download (same filters/sort, max 10 000 rows) |

```http
GET /api/v1/admin/stops?q=majestic&classification=MAJOR&page=1&pageSize=20
```
```json
{
  "success": true,
  "data": [ { "id": "8d0c…", "code": "BLR-KBS", "name": "Kempegowda Bus Station (Majestic)", "lat": 12.9772, "lng": 77.5713,
              "classification": "MAJOR", "status": "ACTIVE", "isEstablished": true, "routeCount": 8, "stateName": "Karnataka",
              "createdByDepotName": "Shantinagar", "…": "…" } ],
  "meta": { "page": 1, "pageSize": 20, "total": 1, "totalPages": 1 }
}
```

Proximity:
```http
GET /api/v1/admin/stops?lat=12.9716&lng=77.5946&radiusMeters=800
```
```json
{ "success": true, "data": [ { "code": "BLR-CRP", "name": "Corporation Circle", "distanceM": 641, "…": "…" } ],
  "meta": { "page": 1, "pageSize": 20, "total": 1, "totalPages": 1 } }
```

CSV (`?format=csv`): `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="stops.csv"`,
UTF-8 BOM, CRLF. Columns: `Code, Name, Local name, Latitude, Longitude, Classification, Status,
Established, Routes, State, Created by depot, Landmark, Address, Created at, Deleted at`. Any
cell starting with `= + - @`, TAB or CR is prefixed with `'` (formula-injection guard).

Errors: `400 VALIDATION_ERROR` (bad enum, `lat` without `lng`, `radiusMeters` without
coordinates, unknown sort, `sort=distance` without coordinates), `403 FORBIDDEN` (`includeDeleted`
below state level).

## GET /admin/stops/check-nearby

Advisory duplicate check for the map pin while creating/moving a stop. Registered before
`/admin/stops/:id`.

| Query | Description |
|---|---|
| `lat`, `lng` | required |
| `radiusMeters` | 1–5 000, default `stops.duplicateRadiusMeters` (50) |
| `excludeStopId` | ignore this stop (when moving an existing stop) |

```http
GET /api/v1/admin/stops/check-nearby?lat=12.9772&lng=77.5714
```
```json
{
  "success": true,
  "data": {
    "lat": 12.9772, "lng": 77.5714, "radiusMeters": 50,
    "nearby": [ { "id": "8d0c…", "code": "BLR-KBS", "name": "Kempegowda Bus Station (Majestic)", "lat": 12.9772, "lng": 77.5713,
                  "classification": "MAJOR", "status": "ACTIVE", "distanceM": 11 } ]
  }
}
```
Only ACTIVE, non-deleted stops are considered; nearest first, at most 20.

## POST /admin/stops

```json
{
  "name": "Domlur",
  "nameLocal": "ದೊಮ್ಮಲೂರು",
  "lat": 12.9610,
  "lng": 77.6387,
  "classification": "MINOR",
  "landmark": "Domlur flyover",
  "address": null,
  "depotId": "5c2…",
  "acknowledgeNearby": false
}
```
- `lat`/`lng` are **mandatory** (map pin). `classification` defaults to `MINOR`.
- `depotId` defaults to the caller's depot (DEPOT_ADMIN); **required** for region/state/system
  admins and must lie inside the caller's scope (`403 OUT_OF_SCOPE`). The stop's state is the
  creating depot's state.
- If ACTIVE stops lie within `stops.duplicateRadiusMeters`, the request fails with
  `409 DUPLICATE_STOP` unless `acknowledgeNearby: true`. The check and the insert are serialised
  with a transaction-scoped advisory lock (concurrent creations at the same spot cannot both pass).
- Audited (`stop.create`); caches `stops` and `admin:stops` invalidated after commit.

`201 Created` (`Location: /api/v1/admin/stops/{id}`) — the stop DTO plus `permissions`.

```json
{ "success": false, "error": { "code": "DUPLICATE_STOP",
  "message": "1 active stop(s) already exist within 50 m. Re-submit with acknowledgeNearby=true to create it anyway.",
  "details": { "radiusMeters": 50, "nearby": [ { "id": "…", "code": "STP-000041", "name": "Domlur", "distanceM": 23, "…": "…" } ] },
  "requestId": "…" } }
```
Other errors: `400 VALIDATION_ERROR` (missing coordinates, unknown fields, `depotId` missing),
`403 OUT_OF_SCOPE`, `403 RESTRICTED_BY_SYSTEM` (depot admin while
`stops.depotAdminCreateEnabled=false`).

## GET /admin/stops/:id

Stop DTO plus:

```json
{
  "success": true,
  "data": {
    "id": "8d0c…", "code": "BLR-KBS", "name": "Kempegowda Bus Station (Majestic)", "…": "…",
    "routeCount": 2,
    "routes": [
      { "routeId": "41a…", "code": "335E", "name": "Kempegowda Bus Station – Whitefield ITPL", "direction": "OUTBOUND",
        "status": "ACTIVE", "serviceType": "ORDINARY", "depotId": "5c2…", "depotName": "Shantinagar",
        "versionId": "9fe…", "versionNo": 1, "seq": 1 }
    ],
    "pendingChangeRequests": [
      { "id": "c13…", "type": "UPDATE", "status": "PENDING", "reason": "Board shows a different name",
        "proposed": { "name": "Majestic Bus Station" }, "requestedBy": "a91…", "requestedByName": "Depot Admin SHN",
        "requestedByDepotId": "5c2…", "requestedByDepotName": "Shantinagar", "createdAt": "2026-10-17T06:02:11.512Z" }
    ],
    "permissions": { "canEdit": false, "canDelete": false, "canRequestChange": true, "requiresReason": true, "restrictedBySystem": false }
  }
}
```
- `routes` lists routes whose **current** version uses the stop.
- `permissions` are computed by the same rules the mutations enforce (never cached).
- Soft-deleted stops are returned to STATE/SYSTEM admins only (`404 NOT_FOUND` for others).
- Errors: `400 VALIDATION_ERROR` (malformed id), `404 NOT_FOUND`.

## PATCH /admin/stops/:id

```json
{
  "name": "Kempegowda Bus Station",
  "lat": 12.97735,
  "lng": 77.57121,
  "classification": "MAJOR",
  "status": "ACTIVE",
  "reason": "GPS survey correction",
  "acknowledgeNearby": false,
  "version": 3
}
```
- Every field is optional except `version` (the `version` the client last read). A mismatch →
  `409 STALE_VERSION` with `details.currentVersion`. At least one field must change.
- Editable fields: `name, nameLocal, lat, lng, classification, landmark, address, status`.
- `reason` is **required** for established stops (`400 VALIDATION_ERROR`, path `reason`).
- **Coordinate correction**: moving a stop re-checks nearby duplicates (`409 DUPLICATE_STOP`
  unless `acknowledgeNearby: true`) and, when the stop is referenced, recomputes
  `distance_from_origin_m` of every **current** route version containing it plus the routes'
  `total_distance_m` in the same transaction (one statement). Planned offsets and historical
  versions are left untouched (trips that ran on them are history). The response lists the
  recomputed routes.
- Audited (`stop.update`, changed fields only in before/after, `reason`); caches `stops`,
  `admin:stops` and — when route data changed or the stop belongs to route versions — `routes`,
  `admin:routes`, `search` and `routeVersion:{id}` are invalidated after commit.

`200 OK` — stop DTO plus `permissions` and `recomputedRoutes`:
```json
{ "success": true, "data": { "id": "8d0c…", "version": 4, "lat": 12.97735, "lng": 77.57121, "…": "…",
  "recomputedRoutes": [ { "routeId": "41a…", "versionId": "9fe…", "totalDistanceM": 20004 } ],
  "permissions": { "canEdit": true, "canDelete": true, "canRequestChange": false, "requiresReason": true, "restrictedBySystem": false } } }
```
Errors: `400 VALIDATION_ERROR`, `403 FORBIDDEN` (no authority — established stops need a change
request), `403 RESTRICTED_BY_SYSTEM`, `404 NOT_FOUND` (unknown or deleted), `409 STALE_VERSION`,
`409 DUPLICATE_STOP`.

## DELETE /admin/stops/:id

Soft delete (`deleted_at` set, status `INACTIVE`); stops are never hard-deleted.
Body (optional) `{ "reason": "Stop removed after road widening" }` — or `?reason=` for clients
that cannot send a DELETE body. `reason` is required for established stops.

- `409 IN_USE` while the **current** version of an `ACTIVE` or `DRAFT` route uses the stop:
  ```json
  { "success": false, "error": { "code": "IN_USE",
    "message": "The stop is used by the current version of active or draft routes. Change those routes (or deactivate them) first.",
    "details": { "routes": [ { "id": "41a…", "code": "335E", "name": "Kempegowda Bus Station – Whitefield ITPL",
                               "direction": "OUTBOUND", "status": "ACTIVE", "depotId": "5c2…", "depotName": "Shantinagar" } ] },
    "requestId": "…" } }
  ```
- PENDING change requests of the stop are cancelled (`review_note: "Stop deleted"`).
- Audited (`stop.delete`).

`200 OK`:
```json
{ "success": true, "data": { "id": "8d0c…", "code": "STP-000042", "deletedAt": "2026-10-17T08:10:00.000Z", "status": "INACTIVE" } }
```
Errors: `400 VALIDATION_ERROR` (reason missing), `403 FORBIDDEN`, `403 RESTRICTED_BY_SYSTEM`
(`stops.stateAdminDeleteEnabled=false`), `404 NOT_FOUND`, `409 IN_USE`.

---

## Stop change requests

Depot and region admins cannot edit established stops; they file a change request which a state
admin of the stop's state (or a system admin) approves or rejects.

### Change request DTO
```json
{
  "id": "c13…",
  "stopId": "8d0c…", "stopCode": "BLR-KBS", "stopName": "Kempegowda Bus Station (Majestic)", "stopNameLocal": null,
  "stopLat": 12.9772, "stopLng": 77.5713, "stopClassification": "MAJOR", "stopStatus": "ACTIVE",
  "stopLandmark": "…", "stopAddress": null, "stopDeleted": false,
  "stateId": "1b7…", "stateName": "Karnataka",
  "type": "UPDATE",
  "proposed": { "name": "Majestic Bus Station" },
  "reason": "Board shows a different name",
  "status": "PENDING",
  "requestedBy": "a91…", "requestedByName": "Depot Admin SHN", "requestedByRole": "DEPOT_ADMIN",
  "requestedByDepotId": "5c2…", "requestedByDepotName": "Shantinagar",
  "reviewedBy": null, "reviewedByName": null, "reviewedAt": null, "reviewNote": null,
  "createdAt": "2026-10-17T06:02:11.512Z", "updatedAt": "2026-10-17T06:02:11.512Z",
  "permissions": { "canApprove": false, "canReject": false, "canCancel": true }
}
```
The `stop*` fields show the stop's **current** values (compare with `proposed`).
Statuses: `PENDING → APPROVED | REJECTED | CANCELLED` (terminal).

### POST /admin/stops/:id/change-requests (DEPOT_ADMIN, REGION_ADMIN)

```json
{ "type": "UPDATE", "proposed": { "name": "Majestic Bus Station", "lat": 12.97731, "lng": 77.57125 }, "reason": "Board shows a different name" }
```
```json
{ "type": "DEACTIVATE", "reason": "Stop closed for metro works" }
```
```json
{ "type": "DELETE", "reason": "Duplicate of BLR-KBS" }
```
- `type`: `UPDATE` (needs `proposed` with at least one of `name, nameLocal, lat, lng,
  classification, landmark, address`; values identical to the stop are dropped and at least one
  real change must remain), `DEACTIVATE`, `DELETE` (`proposed` must be empty).
- Only for **established**, non-deleted stops (`409 CONFLICT` otherwise — the creator can still
  edit a non-established stop directly). Any depot/region admin may request a change to any
  stop (stops are shared across depots/regions/states).
- One PENDING request per requester and stop (`409 CONFLICT`, `details.pendingRequestId`).
  `DEACTIVATE` of an inactive stop → `409 CONFLICT`.
- Audited (`stopChangeRequest.create`); enqueues outbox event **`STOP_CHANGE_REQUESTED`**
  (`depot_id` = requester's depot) with payload
  `{ requestId, stopId, stopCode, stopName, stateId, type, status, reason, requestedBy, requestedByName, requestedByDepotId }`
  — the notification worker fans it out to the state admins of `stateId`.

`201 Created` with the change request DTO. Other roles: `403 FORBIDDEN`.

### GET /admin/stop-change-requests

Visibility: DEPOT/REGION admins see **their own** requests, STATE admins every request on stops
of their state, SYSTEM admins all.

| Query | Description |
|---|---|
| `status` | `PENDING, APPROVED, REJECTED, CANCELLED` (comma separated) |
| `type` | `UPDATE, DEACTIVATE, DELETE` |
| `stopId` | requests of one stop |
| `mine` | `true` → only requests filed by the caller |
| `sort` | `createdAt` (default `-createdAt`), `updatedAt`, `status`, `type`, `stopName`, `stopCode`, `reviewedAt` |
| `page`, `pageSize` | pagination |

```http
GET /api/v1/admin/stop-change-requests?status=PENDING
```
```json
{ "success": true, "data": [ { "id": "c13…", "stopCode": "BLR-KBS", "type": "UPDATE", "status": "PENDING", "…": "…" } ],
  "meta": { "page": 1, "pageSize": 20, "total": 1, "totalPages": 1 } }
```

### GET /admin/stop-change-requests/:id

Change request DTO with `permissions`. Requests outside the caller's visibility → `404 NOT_FOUND`.

### POST /admin/stop-change-requests/:id/approve

Body `{ "note": "Verified on site" }` (optional). STATE_ADMIN of the stop's state or SYSTEM_ADMIN.
In **one transaction**: the request becomes `APPROVED`; the change is applied —
`UPDATE` → the proposed fields (coordinate changes recompute current route versions exactly like
`PATCH`), `DEACTIVATE` → `status INACTIVE`, `DELETE` → soft delete (same `IN_USE` rule as
`DELETE /admin/stops/:id`; on `IN_USE` nothing changes and the request stays PENDING); audit rows
`stop.update`/`stop.delete` (reason `Change request {id}: {reason}`) and `stopChangeRequest.approve`;
outbox event **`STOP_CHANGE_REVIEWED`** with payload
`{ requestId, stopId, stopCode, stopName, stateId, type, status: "APPROVED", reason, requestedBy, requestedByName, requestedByDepotId, reviewNote, reviewedBy, reviewedByName, recipientUserIds: [requestedBy] }`.

Approval applies the change, so it honours the same restrictions as a direct edit: `UPDATE` needs
`stops.stateAdminEditEnabled`, `DEACTIVATE`/`DELETE` need `stops.stateAdminDeleteEnabled`
(`403 RESTRICTED_BY_SYSTEM` for state admins; system admins are never restricted).

`200 OK` — the updated request (showing the stop's new values) plus `recomputedRoutes`.
Errors: `403 FORBIDDEN` (not a reviewer of this state), `403 RESTRICTED_BY_SYSTEM`,
`404 NOT_FOUND`, `409 INVALID_STATE_TRANSITION` (`details.currentStatus`), `409 CONFLICT` (stop
deleted meanwhile), `409 IN_USE`.

### POST /admin/stop-change-requests/:id/reject

Body `{ "note": "The board will be replaced instead" }` — `note` **required**. Same reviewers,
not affected by the system restrictions. Audited (`stopChangeRequest.reject`); enqueues
`STOP_CHANGE_REVIEWED` with `status: "REJECTED"` and `reviewNote`. `200 OK` with the request.

### POST /admin/stop-change-requests/:id/cancel

Body `{ "note": "Raised by mistake" }` (optional). Only the **requester**, only while PENDING
(`403 FORBIDDEN` / `409 INVALID_STATE_TRANSITION`). Audited (`stopChangeRequest.cancel`); no
notification. `200 OK` with the request.

---

## Caching

| Namespace | TTL | Content | Invalidated by |
|---|---|---|---|
| `admin:stops` | 60 s | `GET /admin/stops` pages | every stop write, change-request write, route write |
| `stops` | 600 s | stop detail data (without permissions) | same |

Permissions and authorization decisions are never cached.

## Internal service API (for other modules)

`src/modules/stops/service.js`:

| Function | Description |
|---|---|
| `invalidateStopCaches()` | bumps `stops` + `admin:stops`; call after committing a write that changes stop data or stop usage |
| `applyStopChanges(client, req, lockedStop, changes, { reason, graceEditHours })` | applies field changes inside the caller's transaction (coordinate recomputation + audit) |
| `softDeleteStop(client, req, lockedStop, { reason, graceEditHours })` | soft delete inside the caller's transaction (`IN_USE` rule + audit) |

`src/modules/stops/permissions.js` exports the pure authority rules (`decide`, `decideReview`,
`stopPermissions`, `isEstablished`, `STOP_SETTING_KEYS`) — e.g. for the auth module's permission
hints or a dashboard.
