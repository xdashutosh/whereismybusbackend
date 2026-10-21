# Geo API: states, regions, depots

Module `geo` · base path `/api/v1` · contract: ARCHITECTURE §3.1, §6 · source `backend/src/modules/geo/`.

The administrative hierarchy is **State → Region → Depot**. Every endpoint needs a bearer token of an
admin role (`DEPOT_ADMIN`, `REGION_ADMIN`, `STATE_ADMIN`, `SYSTEM_ADMIN`); other roles get `403 FORBIDDEN`.

| Capability | DEPOT_ADMIN | REGION_ADMIN | STATE_ADMIN | SYSTEM_ADMIN |
|---|---|---|---|---|
| Read tree and lists | own depot path | own region | own state | all |
| Create/update states | – | – | – | ✓ |
| Create/update regions | – | – | in own state | ✓ |
| Create depots | – | – | in own state | ✓ |
| Update depots | – | in own region (cannot move) | in own state (can move between its regions) | ✓ |

Rules applied to every endpoint:

- A record outside your scope requested **by id** returns `404 NOT_FOUND`, so its existence is not
  revealed. A `stateId`/`regionId` **filter** outside your scope returns `403 OUT_OF_SCOPE`.
- Codes are upper-cased natural keys: 1–32 characters from `A–Z 0–9 - _`, starting with a letter or
  digit. State codes and depot codes are unique platform-wide; region codes are unique within their state.
  A clash returns `409 DUPLICATE` (`details.constraint`).
- Regions never move between states, and depots only move between regions of the **same state**.
  Stops are state-scoped master data, so cross-state moves would break route integrity.
- **Deactivation** is guarded with `409 IN_USE`: a state needs all its regions inactive; a region needs
  all its depots inactive; a depot needs no active DEPOT_ADMIN or DRIVER accounts and no upcoming
  (`SCHEDULED|DELAYED|ACTIVE|SUSPENDED`) trips. A record can only be re-activated while its parent is active.
- Every write is audited in the same transaction (`state.create|update`, `region.create|update`,
  `depot.create|update`, before/after holding only the changed fields). The cached `geo` directory
  (tree, display names, timezones) is invalidated after commit.
- Lists: `page` (default 1), `pageSize` (1–100, default 20), `sort` (`field` / `-field`, whitelisted),
  `q` (code or name contains). The response is `{ success, data: [...], meta: { page, pageSize, total, totalPages } }`.

---

## GET /admin/geo/tree

Query: `activeOnly=true|false` (default false). Returns the scope-limited tree for region/depot selectors:

```json
{
  "success": true,
  "data": [
    { "id": "aba9…", "code": "KA", "name": "Karnataka", "timezone": "Asia/Kolkata", "isActive": true,
      "regions": [
        { "id": "e5b8…", "code": "BLR-C", "name": "Bengaluru Central", "isActive": true,
          "depots": [ { "id": "43bb…", "code": "KGR", "name": "Kengeri", "isActive": true },
                      { "id": "2813…", "code": "SHN", "name": "Shantinagar", "isActive": true } ] },
        { "id": "512d…", "code": "BLR-S", "name": "Bengaluru South", "isActive": true, "depots": [ … ] },
        { "id": "…", "code": "MYS", "name": "Mysuru", "isActive": true, "depots": [ … ] } ] }
  ]
}
```

A DEPOT_ADMIN gets one state containing one region containing their depot. A REGION_ADMIN gets their
region with all its depots, a STATE_ADMIN their state, and SYSTEM every state. Nodes are sorted by name.

## States

### GET /admin/states
Query: `page, pageSize, sort (code|name|isActive|createdAt; default name), q, isActive`. Non-system admins
see only their own state.

```json
{ "success": true,
  "data": [ { "id": "aba9…", "code": "KA", "name": "Karnataka", "timezone": "Asia/Kolkata", "isActive": true,
              "createdAt": "…Z", "updatedAt": "…Z", "regionCount": 3, "depotCount": 5 } ],
  "meta": { "page": 1, "pageSize": 20, "total": 1, "totalPages": 1 } }
```

### GET /admin/states/:id
Same fields, plus `permissions: { canEdit, canCreateRegion }`. Outside scope: `404`.

### POST /admin/states (SYSTEM)
```json
{ "code": "tn", "name": "Tamil Nadu", "timezone": "Asia/Kolkata", "isActive": true }
```
`timezone` must be a valid IANA zone (default `DEFAULT_TIMEZONE`). `201` returns the state (`code: "TN"`).

### PATCH /admin/states/:id (SYSTEM)
Any of `{ code, name, timezone, isActive }`, at least one. `isActive: false` with active regions returns
`409 IN_USE` with `details.activeRegions`.

## Regions

### GET /admin/regions
Query: `page, pageSize, sort (code|name|stateName|isActive|createdAt), q, isActive, stateId`. STATE admins
see the regions of their state; REGION and DEPOT admins see their own region.

```json
{ "id": "e5b8…", "stateId": "aba9…", "stateCode": "KA", "stateName": "Karnataka", "timezone": "Asia/Kolkata",
  "code": "BLR-C", "name": "Bengaluru Central", "isActive": true, "createdAt": "…Z", "updatedAt": "…Z", "depotCount": 2 }
```

### GET /admin/regions/:id
Same fields, plus `permissions: { canEdit, canCreateDepot }`.

### POST /admin/regions (STATE, SYSTEM)
```json
{ "stateId": "aba9…", "code": "BLR-N", "name": "Bengaluru North" }
```
`stateId` defaults to the STATE admin's own state and is required for SYSTEM (`400`). Another state
returns `403 OUT_OF_SCOPE`; an inactive state returns `400 VALIDATION_ERROR`.

### PATCH /admin/regions/:id (STATE in own state, SYSTEM)
Any of `{ code, name, isActive }`. `stateId` is not accepted (`400`). Deactivating while depots are active
returns `409 IN_USE` with `details.activeDepots`.

## Depots

### GET /admin/depots
Query: `page, pageSize, sort (code|name|regionName|stateName|isActive|createdAt), q, isActive, regionId, stateId`.
The scope filter is applied in SQL. A `regionId`/`stateId` outside scope returns `403 OUT_OF_SCOPE`.

```json
{ "success": true,
  "data": [ { "id": "43bb…", "regionId": "e5b8…", "regionCode": "BLR-C", "regionName": "Bengaluru Central",
              "stateId": "aba9…", "stateCode": "KA", "stateName": "Karnataka", "timezone": "Asia/Kolkata",
              "code": "KGR", "name": "Kengeri", "address": "Kengeri TTMC, Mysuru Road, Bengaluru 560060",
              "lat": 12.91337, "lng": 77.48389, "phone": "+91 80 4000 1002", "isActive": true,
              "createdAt": "…Z", "updatedAt": "…Z",
              "busCount": 0, "driverCount": 0, "routeCount": 0, "adminCount": 0 } ],
  "meta": { "page": 1, "pageSize": 1, "total": 2, "totalPages": 2 } }
```
`adminCount` counts active DEPOT_ADMIN accounts.

### GET /admin/depots/:id
Same fields, plus `permissions: { canEdit, canMove }`. Outside scope: `404`.

### POST /admin/depots (STATE in own state, SYSTEM)
```json
{ "regionId": "512d…", "code": "hsr", "name": "HSR Layout", "address": "27th Main, HSR Layout",
  "lat": 12.9116, "lng": 77.6474, "phone": "+91 80 4000 1010" }
```
`lat` and `lng` must be given together (or both omitted or null). The region must be active and inside
your scope. `201` returns the depot DTO.

### PATCH /admin/depots/:id (REGION, STATE, SYSTEM)
Any of `{ regionId, code, name, address, lat, lng, phone, isActive }` (send `null` to clear an optional
field).

- REGION admins edit depots of their own region and cannot change `regionId` (`403 OUT_OF_SCOPE`).
- STATE and SYSTEM admins may move a depot to another active region **of the same state**. Another state
  returns `400 VALIDATION_ERROR` (`path: "regionId"`). Moving carries the change to the depot's users and
  routes (hierarchy columns cascade).
- `isActive: false` returns `409 IN_USE` with `details: { activeUsers, upcomingTrips }` while either is
  non-zero.

## Errors

| Code | When |
|---|---|
| `400 VALIDATION_ERROR` | invalid body or query, unknown key, bad code or timezone, unpaired coordinates, cross-state move, inactive parent |
| `401 UNAUTHENTICATED` | missing or invalid token |
| `403 FORBIDDEN` | role not allowed for the endpoint |
| `403 OUT_OF_SCOPE` | filter or target outside your scope |
| `403 PASSWORD_CHANGE_REQUIRED` | the user must change their password first |
| `404 NOT_FOUND` | unknown id, or outside your scope |
| `409 DUPLICATE` | code already used |
| `409 IN_USE` | deactivation blocked (see above) |
