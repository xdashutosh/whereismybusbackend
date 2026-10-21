# Routes API (`routes` module)

Directional, depot-owned routes built from the permanent stop catalogue, with **versioned**
ordered stop sequences (FRD §5; ARCHITECTURE §2 rule 5, §3.2, §6, §15). Base path `/api/v1`.
All endpoints require an **admin** access token; other roles → `403 FORBIDDEN`, anonymous →
`401 UNAUTHENTICATED`.

**Scope** (§6): DEPOT_ADMIN — routes of their depot; REGION_ADMIN — depots of their region;
STATE_ADMIN — depots of their state; SYSTEM_ADMIN — all. A route outside scope requested by id →
`404 NOT_FOUND`; an explicit `regionId`/`depotId` filter or a target `depotId` outside scope →
`403 OUT_OF_SCOPE`. Every mutation is audited (entity type `ROUTE`) in the same transaction.

**Model rules**
- Direction is explicit (`OUTBOUND` / `INBOUND`); the opposite direction is a separate route,
  linked through `pairRouteId` (both ways).
- Codes are upper-cased (`335E`, `KBS-1A`) and unique per **state + code + direction**
  (`409 DUPLICATE`, `details: { field: "code", constraint: "routes_state_code_direction_key" }`).
- A version is immutable: ≥ 2 distinct ACTIVE stops, `seq` 1..n, distances and planned offsets
  never decrease, stop 1 has distance 0 and offset 0. Trips and schedules reference the version
  they were created with — editing the stops creates version n+1 and never rewrites history.
- Saving a route version marks its stops **established** (stops module rules).

**Geometry** (shared by create, preview, new versions, reverse and the seed)
- `distanceFromOriginM`: running sum of haversine legs, each rounded to whole metres.
- `plannedOffsetMin` (minutes from trip start to arrival): stop 1 = 0; provided offsets are kept
  (must not decrease); a missing offset **between** two known ones is interpolated by distance;
  a missing offset **after** the last known one is `known + round(km / speed · 60) + dwell`, with
  `speed = routes.defaultAvgSpeedKmph` (20) and 1 minute of dwell at every intermediate stop
  passed. With no offsets at all: `round(cumulativeKm / speed · 60) + (i − 1)` for stop `i ≥ 2`.
- `offsetSource` (preview): `ORIGIN | PROVIDED | INTERPOLATED | DEFAULT`.
- `polyline`: `[[lat, lng], …]` in stop order.

## Route DTO (list rows; detail adds more)

```json
{
  "id": "41a…",
  "code": "335E", "name": "Kempegowda Bus Station – Whitefield ITPL",
  "direction": "OUTBOUND", "serviceType": "ORDINARY", "status": "ACTIVE",
  "depotId": "5c2…", "depotName": "Shantinagar", "depotCode": "SHN",
  "regionId": "77d…", "regionName": "Bengaluru Urban", "stateId": "1b7…", "stateName": "Karnataka", "timezone": "Asia/Kolkata",
  "currentVersionId": "9fe…", "currentVersionNo": 1,
  "originStopId": "8d0c…", "originStopName": "Kempegowda Bus Station (Majestic)",
  "destinationStopId": "e31…", "destinationStopName": "Whitefield ITPL",
  "totalDistanceM": 20000, "totalDurationMin": 75, "stopCount": 10,
  "pairRouteId": "52b…", "pairRouteCode": "335E", "pairRouteName": "Whitefield ITPL – Kempegowda Bus Station",
  "pairRouteDirection": "INBOUND", "pairRouteStatus": "ACTIVE",
  "createdBy": "a91…", "createdByName": "Depot Admin SHN",
  "createdAt": "2026-10-16T05:30:00.000Z", "updatedAt": "2026-10-17T07:00:00.000Z"
}
```

---

## GET /admin/routes

ONE SQL query (rows + names + total), cached 60 s in `admin:routes`.

| Query | Description |
|---|---|
| `regionId`, `depotId` | scope selectors (must lie inside scope → else `403 OUT_OF_SCOPE`); omitted = whole scope |
| `status` | `DRAFT, ACTIVE, INACTIVE` (comma separated) |
| `direction` | `OUTBOUND, INBOUND` |
| `serviceType` | `ORDINARY, EXPRESS, DELUXE, AC, ELECTRIC, NIGHT` |
| `q` | code or name substring |
| `stopId` | routes whose **current** version uses the stop |
| `sort` | `code` (default), `name, direction, status, serviceType, depotName, totalDistanceM, totalDurationMin, createdAt, updatedAt` (`-` = desc) |
| `page`, `pageSize` | pagination (1–100) |
| `format` | `csv` → CSV (same filters/sort, ≤ 10 000 rows) |

```http
GET /api/v1/admin/routes?direction=OUTBOUND&q=335&sort=code
```
```json
{ "success": true, "data": [ { "id": "41a…", "code": "335E", "direction": "OUTBOUND", "depotName": "Shantinagar", "stopCount": 10, "…": "…" } ],
  "meta": { "page": 1, "pageSize": 20, "total": 1, "totalPages": 1 } }
```
CSV columns: `Code, Name, Direction, Service type, Status, Depot, Region, Origin, Destination,
Stops, Distance (km), Duration (min), Version, Paired route, Updated at` — formula-injection
guarded (cells starting with `= + - @`, TAB, CR get a leading `'`).

## POST /admin/routes/preview

Route-builder live preview: **no writes**. Accepts the create body (only `stops` is required) plus
an optional `avgSpeedKmph` (5–120) override.

```json
{ "stops": [ { "stopId": "8d0c…" }, { "stopId": "b77…" }, { "stopId": "e31…", "plannedOffsetMin": 25 } ] }
```
```json
{
  "success": true,
  "data": {
    "stops": [
      { "seq": 1, "stopId": "8d0c…", "code": "BLR-KBS", "name": "Kempegowda Bus Station (Majestic)", "nameLocal": null,
        "lat": 12.9772, "lng": 77.5713, "classification": "MAJOR",
        "distanceFromOriginM": 0, "segmentDistanceM": 0, "plannedOffsetMin": 0, "offsetSource": "ORIGIN" },
      { "seq": 2, "stopId": "b77…", "code": "BLR-CRP", "name": "Corporation Circle", "…": "…",
        "distanceFromOriginM": 2046, "segmentDistanceM": 2046, "plannedOffsetMin": 9, "offsetSource": "INTERPOLATED" },
      { "seq": 3, "stopId": "e31…", "code": "BLR-MGR", "name": "MG Road", "…": "…",
        "distanceFromOriginM": 5480, "segmentDistanceM": 3434, "plannedOffsetMin": 25, "offsetSource": "PROVIDED" }
    ],
    "totalDistanceM": 5480,
    "totalDurationMin": 25,
    "polyline": [[12.9772, 77.5713], [12.9667, 77.5874], [12.9756, 77.6066]],
    "avgSpeedKmph": 20
  }
}
```
Errors (`400 VALIDATION_ERROR`, `details[].path`): fewer than 2 stops (`stops`), a repeated stop
(`stops[1].stopId`), unknown/deleted/inactive stop (`stops[i].stopId`), first offset ≠ 0
(`stops[0].plannedOffsetMin`), decreasing offset (`stops[i].plannedOffsetMin`).

## POST /admin/routes

```json
{
  "depotId": "5c2…",
  "code": "335E",
  "name": "Kempegowda Bus Station – Whitefield ITPL",
  "direction": "OUTBOUND",
  "serviceType": "ORDINARY",
  "status": "ACTIVE",
  "stops": [ { "stopId": "8d0c…" }, { "stopId": "b77…", "plannedOffsetMin": 8 }, { "stopId": "e31…" } ],
  "pairRouteId": null,
  "notes": "Initial alignment"
}
```
- `depotId` defaults to the caller's depot (DEPOT_ADMIN); required above depot level; must be in
  scope. `serviceType` default `ORDINARY`; `status` `DRAFT` or `ACTIVE` (default).
- Stops may come from any depot/state (global catalogue) but must be ACTIVE and not deleted.
- `pairRouteId` (optional): a route in scope with the **opposite** direction that is not paired
  with another route (`400` / `409 CONFLICT`); both routes are linked.
- One transaction: route + version 1 + all route_stops + totals + stop establishment (one
  statement), audit `route.create`.

`201 Created` (`Location`) with the **route detail** (below).
Errors: `400 VALIDATION_ERROR`, `403 OUT_OF_SCOPE`, `409 DUPLICATE`, `409 CONFLICT`.

## GET /admin/routes/:id

```json
{
  "success": true,
  "data": {
    "id": "41a…", "code": "335E", "direction": "OUTBOUND", "…": "all route DTO fields",
    "stops": [
      { "seq": 1, "stopId": "8d0c…", "code": "BLR-KBS", "name": "Kempegowda Bus Station (Majestic)", "nameLocal": null,
        "lat": 12.9772, "lng": 77.5713, "classification": "MAJOR", "status": "ACTIVE", "isDeleted": false,
        "distanceFromOriginM": 0, "plannedOffsetMin": 0 }
    ],
    "polyline": [[12.9772, 77.5713], [12.9667, 77.5874]],
    "pairRoute": { "id": "52b…", "code": "335E", "name": "Whitefield ITPL – Kempegowda Bus Station", "direction": "INBOUND", "status": "ACTIVE" },
    "versions": [
      { "id": "9fe…", "versionNo": 1, "notes": "Seeded network", "createdBy": null, "createdByName": null,
        "createdAt": "2026-10-16T05:30:00.000Z", "isCurrent": true, "stopCount": 10,
        "totalDistanceM": 20000, "totalDurationMin": 75, "tripCount": 42, "scheduleCount": 3 }
    ],
    "counts": { "activeSchedules": 3, "upcomingTrips": 18, "pendingTrips": 19, "totalTrips": 42, "versionCount": 1 },
    "permissions": { "canEdit": true, "canEditStops": true, "canReverse": false, "canDeactivate": false, "canActivate": false, "canDelete": false }
  }
}
```
- `stops` = the **current** version (served from the immutable `routeVersion:{id}` cache).
- `counts.upcomingTrips` = non-terminal trips starting in the future; `pendingTrips` = all
  non-terminal trips (`SCHEDULED, DELAYED, ACTIVE, SUSPENDED`) — these block deactivation/deletion.
- `permissions` mirror the mutation rules (`canReverse` false once paired; `canDeactivate` /
  `canDelete` false while `pendingTrips > 0`).
- `404 NOT_FOUND` outside scope.

## PATCH /admin/routes/:id

```json
{ "name": "Majestic – ITPL (via Old Airport Road)", "serviceType": "ELECTRIC", "status": "INACTIVE", "pairRouteId": null, "reason": "Withdrawn" }
```
- Fields: `code`, `name`, `serviceType`, `status`, `pairRouteId` (uuid to link, `null` to
  unlink both sides), `reason` (stored in the audit row). At least one field besides `reason`.
- Status transitions: `DRAFT → ACTIVE | INACTIVE`, `ACTIVE → INACTIVE`, `INACTIVE → ACTIVE`;
  anything else → `409 INVALID_STATE_TRANSITION` (`details.currentStatus`).
- **Deactivation** is blocked while non-terminal trips exist:
  ```json
  { "success": false, "error": { "code": "IN_USE",
    "message": "Route 335E still has 4 upcoming or running trip(s); cancel or move them before you deactivate it.",
    "details": { "trips": 4, "nextTrips": [ { "id": "t1…", "serviceDate": "2026-10-18", "plannedStart": "2026-10-18T02:30:00.000Z", "status": "SCHEDULED" } ] },
    "requestId": "…" } }
  ```
- **Activation** requires a current version whose stops are all ACTIVE and not deleted
  (`409 CONFLICT`, `details.stops`).
- Audited `route.update` (changed fields). `200 OK` with the route detail.
Errors: `400`, `404`, `409 DUPLICATE | IN_USE | INVALID_STATE_TRANSITION | CONFLICT`.

## PUT /admin/routes/:id/stops

Creates **version n+1** of the route.

```json
{
  "stops": [ { "stopId": "8d0c…" }, { "stopId": "b77…" }, { "stopId": "f02…" }, { "stopId": "e31…", "plannedOffsetMin": 80 } ],
  "notes": "Extended to Kadugodi; skips Domlur during flyover works",
  "applyToFutureTrips": true,
  "expectedVersionNo": 1
}
```
- Same stop/offset validation as create; the route row is locked (`FOR UPDATE`).
- `expectedVersionNo` (optional optimistic check) ≠ current → `409 STALE_VERSION`
  (`details.currentVersionNo`).
- `applyToFutureTrips` (default `true`) re-points, in **two single statements**,
  not-yet-started future trips (`status IN (SCHEDULED, DELAYED)` and `planned_start > now()`) and
  `ACTIVE` schedules to the new version (their `version` counters are bumped). Started, running,
  suspended, completed, cancelled and past trips — and inactive/cancelled schedules — keep their
  version. `false` leaves every trip/schedule untouched.
- Audited `route.updateStops` (old/new version, totals, re-pointed counts). Caches: `routes`,
  `admin:routes`, `search`, stop caches, plus `tripMeta:{tripId}` / `driverSchedule:{driverId}`
  of everything re-pointed.

`200 OK`:
```json
{ "success": true, "data": {
  "route": { "id": "41a…", "currentVersionNo": 2, "stops": [ "…" ], "…": "route detail" },
  "version": { "id": "a40…", "versionNo": 2, "createdAt": "2026-10-17T08:00:00.000Z" },
  "applyToFutureTrips": true, "tripsRepointed": 18, "schedulesRepointed": 3 } }
```
Errors: `400 VALIDATION_ERROR`, `404 NOT_FOUND`, `409 STALE_VERSION`.

## GET /admin/routes/:id/versions

Newest first, paginated (`page`, `pageSize`). One query.
```json
{ "success": true, "data": [
    { "id": "a40…", "versionNo": 2, "notes": "Extended to Kadugodi", "createdBy": "a91…", "createdByName": "Depot Admin SHN",
      "createdAt": "2026-10-17T08:00:00.000Z", "isCurrent": true, "stopCount": 11, "totalDistanceM": 23110, "totalDurationMin": 80,
      "tripCount": 18, "scheduleCount": 3 },
    { "id": "9fe…", "versionNo": 1, "isCurrent": false, "stopCount": 10, "tripCount": 24, "scheduleCount": 0, "…": "…" } ],
  "meta": { "page": 1, "pageSize": 20, "total": 2, "totalPages": 1 } }
```

## GET /admin/routes/:id/versions/:versionId

```json
{ "success": true, "data": {
  "id": "9fe…", "routeId": "41a…", "versionNo": 1, "notes": "Seeded network", "createdBy": null, "createdByName": null,
  "createdAt": "2026-10-16T05:30:00.000Z", "isCurrent": false, "tripCount": 24, "scheduleCount": 0,
  "routeCode": "335E", "routeName": "Kempegowda Bus Station – Whitefield ITPL", "direction": "OUTBOUND",
  "totalDistanceM": 20000, "totalDurationMin": 75,
  "stops": [ { "seq": 1, "stopId": "8d0c…", "code": "BLR-KBS", "name": "…", "lat": 12.9772, "lng": 77.5713,
               "classification": "MAJOR", "status": "ACTIVE", "isDeleted": false, "distanceFromOriginM": 0, "plannedOffsetMin": 0 } ],
  "polyline": [[12.9772, 77.5713]] } }
```
`404 NOT_FOUND` when the route is outside scope or the version belongs to another route.

## POST /admin/routes/:id/reverse

Creates the opposite-direction route and links both through `pair_route_id`.
```json
{ "code": "335E", "name": "Whitefield ITPL – Kempegowda Bus Station", "depotId": "5c2…", "status": "ACTIVE", "useDefaultOffsets": false }
```
All fields optional:
- `code` default: the source code (allowed because the direction differs); `name` default: the
  two ends of the source name swapped (`"A – B"` → `"B – A"`, otherwise `"<name> (return)"`).
- `depotId` default: the source depot (must be in scope); `status` default: the source status
  (`DRAFT` when the source is inactive); service type copied.
- Stops = the current version reversed; distances recomputed (haversine); offsets **mirror** the
  source timings (time between two consecutive stops preserved) unless `useDefaultOffsets: true`
  (then derived from `routes.defaultAvgSpeedKmph` + dwell).
- `409 CONFLICT` when the source is already paired (`details.pairRouteId`); `409 DUPLICATE` when
  the code/direction already exists in the state.
- Audited `route.reverse` (new route) and `route.update` (source pairing).

`201 Created` with the new route's detail (`pairRoute` = the source).

## DELETE /admin/routes/:id

Body (optional) `{ "reason": "Route retired" }`. Archive rules:
1. Non-terminal trips exist → `409 IN_USE` (same details as deactivation).
2. A `DRAFT` route that never operated (no trips, no schedules) is **removed** (versions and
   route_stops cascade; a pair link is cleared) — audit `route.delete`.
3. Any other route is **archived** (`status INACTIVE`, history kept) — audit `route.archive`.

```json
{ "success": true, "data": { "id": "41a…", "code": "335E", "deleted": false, "archived": true, "status": "INACTIVE" } }
```

---

## Caching

| Namespace | TTL | Content | Invalidated by |
|---|---|---|---|
| `admin:routes` | 60 s | `GET /admin/routes` pages | every route write |
| `routes` | 600 s | `getRouteSummary` results | every route write; stop edits that change route data |
| `routeVersion:{versionId}` | 3600 s | ordered stops of a version | never for structure (versions are immutable); bumped when a stop on that version is renamed/moved/reclassified (display data, coordinate correction) |
| `search` | 30 s | passenger search (owned by passenger) | bumped by every route write |

## Internal service API (for other modules)

Import from `src/modules/routes/internal.js` (also re-exported by `routes/service.js`). Passing a
transaction `client` bypasses the caches (reads see the caller's uncommitted rows); without it
reads are cached.

### `getRouteVersionStops(versionId, client?) → Promise<Stop[]>`
Ordered stops of a route version (ONE query, cached in `routeVersion:{versionId}`):
```js
[{ seq: 1, stopId, code: 'BLR-KBS', name, nameLocal, lat: 12.9772, lng: 77.5713, classification: 'MAJOR',
   status: 'ACTIVE', isDeleted: false, distanceFromOriginM: 0, plannedOffsetMin: 0 }, …]
```
Returns `[]` for an unknown version; throws `TypeError` for a non-UUID. This is the input for
ETA, live progress projection (`distanceFromOriginM` as the polyline cumulative), passenger trip
views and search (use each trip's own `route_version_id`).

### `getRouteSummary(routeId, client?) → Promise<RouteSummary | null>`
The route DTO above (code, name, direction, service type, status, depot/region/state names and
timezone, current version id/no, origin/destination names, totals, stop count, pair) or `null`.
Cached in `routes`.

### Other helpers
| Function | Description |
|---|---|
| `recomputeDistancesForStop(client, stopId)` | coordinate correction: recomputes distances of every current version containing the stop + route totals (one statement); returns `[{ routeId, versionId, totalDistanceM }]` |
| `versionIdsContainingStop(stopId, client?)` | every version (current or historical) using the stop |
| `markStopsEstablished(client, stopIds)` | sets `stops.is_established` (one statement) |
| `invalidateRouteCaches({ versionIds })` | bumps `routes`, `admin:routes`, `search` and the given `routeVersion:{id}` namespaces — call after COMMIT |
| `routeVersionCache(versionId)` | the namespace handle used for version stops |

`src/modules/routes/geometry.js` (pure): `computeStopSequence(stops, { avgSpeedKmph })`,
`polylineOf(stops)`, `mirroredOffsets(offsets)`, `reversedName(name)`, `sqlHaversine(...)`,
`OPPOSITE_DIRECTION`, `DWELL_MINUTES`.

## Seed data (`src/db/seeds/15_routes.js`)

Five OUTBOUND/INBOUND pairs over `10_stops` (50 stops: 40 Bengaluru, 10 Mysuru):
`335E` Kempegowda Bus Station – Whitefield ITPL (SHN), `356E` Kempegowda Bus Station – Electronic
City (ECY, EXPRESS), `222` Kengeri TTMC – Kempegowda Bus Station (KGR), `210` Banashankari –
Yeshwanthpur (JYN), `201` Mysuru City Bus Stand – Chamundi Hill Top (MYC). Idempotent (natural
keys + `ON CONFLICT DO NOTHING`), batched; routes/stops whose depot or stops are missing are
skipped with a log line.
