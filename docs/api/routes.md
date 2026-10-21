# Routes, stops & schedules API

Blueprint §6.2 (routes, stops, bus_route_assignments, trip_schedules), §8.3 (Routes/Stops, Schedules), §13.3
(Routes & Stops, Schedules screens); contract §2 (routing), §3, §5. Base `/api/v1`. Source:
`backend/src/modules/routes/`; shared Zod schemas and DTO types: `backend/shared/src/schemas/routes.ts` (`@wimb/shared`).

* **School admins only** (`/school/*` area guard + route guard). Drivers, conductors and parents get `403`.
* Ids of another school answer `404 NOT_FOUND` on every endpoint (also ids inside bodies: `busId`, `routeId`);
  `school_id` in a body is ignored (the school always comes from the token).
* Every write is audited in the same transaction: `route.create|update|delete|polyline_recompute`,
  `stop.create|update|delete|reorder`, `route.assign_bus|unassign_bus`, `trip_schedule.create|update|delete`.
* Creates accept `Idempotency-Key` (`POST /school/routes`, `POST …/stops`, `POST /school/trip-schedules`).
* Times are school-local `HH:mm`; weekdays are ISO numbers (`1` = Monday … `7` = Sunday); validity dates of
  schedules are inclusive `YYYY-MM-DD`; assignment windows are half-open timestamps (`validTo` exclusive).

| Method | Path | Purpose |
|---|---|---|
| GET | `/school/routes` | List (filters, sort, pagination, `format=csv`) |
| POST | `/school/routes` | Create |
| GET | `/school/routes/:id` | Detail: route + ordered stops + buses + planned path + warnings |
| PATCH | `/school/routes/:id` | Edit (partial) |
| DELETE | `/school/routes/:id` | Soft delete |
| POST | `/school/routes/:id/recompute-polyline` | Recompute the planned path (Google Routes or straight line) |
| GET | `/school/routes/:id/stops` | Live stops in order |
| POST | `/school/routes/:id/stops` | Add a stop (append or insert at a position) |
| GET | `/school/routes/:id/stops/:stopId` | One stop |
| PATCH | `/school/routes/:id/stops/:stopId` | Edit a stop |
| DELETE | `/school/routes/:id/stops/:stopId` | Soft delete a stop (positions close up) |
| PUT | `/school/routes/:id/stops/reorder` | New order of all stops |
| POST | `/school/routes/:id/assign-bus` | Assign a bus to the route (history kept) |
| POST | `/school/routes/:id/unassign-bus` | End a bus assignment |
| GET | `/school/routes/:id/bus-assignments` | Assignment history of one route (`format=csv`) |
| GET | `/school/bus-route-assignments` | Assignment history across routes/buses (`format=csv`) |
| GET | `/school/trip-schedules` | List schedules (filters, sort, pagination, `format=csv`) |
| POST | `/school/trip-schedules` | Create a schedule |
| GET | `/school/trip-schedules/:id` | One schedule |
| PATCH | `/school/trip-schedules/:id` | Edit a schedule |
| DELETE | `/school/trip-schedules/:id` | Soft delete a schedule |

## Route object

```json
{
  "id": "0199f2a4-…", "code": "R1", "name": "Bellandur – HSR Layout (pick-up)", "direction": "morning",
  "description": "Demo route (seed)", "isActive": true,
  "stopCount": 8, "firstStopTime": "07:00", "lastStopTime": "07:35",
  "buses": [{ "busId": "…", "busCode": "R1", "busName": "Route 1 Bus", "registrationNo": "KA01AB1201", "assignmentId": "…", "validFrom": "2026-09-18T03:00:00.000Z" }],
  "activeScheduleCount": 1, "studentCount": 24,
  "polylineSource": "straight", "polylineComputedAt": "2026-10-18T03:10:00.000Z", "distanceM": 12650, "durationS": 2070,
  "hasActiveTrip": false, "createdAt": "…", "updatedAt": "…"
}
```
`buses` = buses assigned **now**; `activeScheduleCount` = active schedules still valid today or later;
`studentCount` = students with a current assignment on the route; `polylineSource`: `google` | `straight` | `null`.

## `GET /school/routes`

Query: `page`, `limit` (1–100, default 20), `sort` (`code,direction` default; `name`, `direction`, `isActive`,
`stopCount`, `firstStopTime`, `distanceM`, `studentCount`, `createdAt`, `updatedAt`; prefix `-` for descending),
`q` (code, name, description), `direction=morning,afternoon`, `isActive`, `hasBus` (any bus assigned now),
`busId` (routes this bus serves now), `format=csv` (`routes.csv`, same filters, up to 10 000 rows).

## `POST /school/routes` · `PATCH /school/routes/:id`

```json
{ "code": "R3", "name": "Whitefield Express", "direction": "morning", "description": "Via ITPL", "isActive": true }
```
`code` (1–40) + `direction` is unique per school among live routes (`409 DUPLICATE`; the same code may exist in the
other direction — a morning and an afternoon `R1`). Responses carry the **route detail** (below); create → `201`.
PATCH takes any subset (at least one field). Rules:

* `direction` changes only while no schedule or student assignment references the route (`409 CONFLICT`,
  `details: { schedules, studentAssignments }`) — create a new route instead.
* `isActive: false` is refused while a trip is in progress on the route (`409 INVALID_STATE`, `details.activeTripId`)
  or active schedules use it (`409 CONFLICT`, `details.schedules`). Inactive routes get no new schedules or buses.

## `GET /school/routes/:id` — route detail

Route object plus:
```json
{
  "polylineEncoded": "o~pmAy}nyM…",
  "stops": [{ "id": "…", "routeId": "…", "sequence": 1, "name": "Kaikondrahalli Lake", "code": "A1", "landmark": null,
              "latitude": 12.9127, "longitude": 77.674, "expectedTime": "07:00", "arrivalRadiusM": 100, "studentCount": 3,
              "createdAt": "…", "updatedAt": "…" }],
  "school": { "latitude": 12.933756, "longitude": 77.62275 },
  "activeTripId": null,
  "warnings": ["polyline_straight"]
}
```
`warnings` (editor hints, never blocking): `too_few_stops` (< 2 stops), `expected_times_out_of_order` (expected
times decrease along the sequence), `polyline_missing` (≥ 2 path points but no stored path), `polyline_straight`
(the stored path is the straight-line fallback).

## `DELETE /school/routes/:id`

Soft delete → `200 { "id": "…", "deleted": true }`. Refused while a trip is in progress on the route
(`409 INVALID_STATE`) or while current/future student assignments or active schedules use it (`409 CONFLICT`,
`details: { studentAssignments, schedules }`). Effects in the same transaction: open bus assignments are closed,
remaining (inactive/expired) schedules are soft-deleted, not-yet-started trips of the route from today on are
cancelled (`cancel_reason = "Route deleted"`). Stops, trips and history are kept; the code becomes reusable.

## Planned path — `POST /school/routes/:id/recompute-polyline`

The path runs through the live stops in sequence order. The **school** (when its location is set) is appended as
the destination of a morning route and prepended as the origin of an afternoon route, unless the last/first stop
already lies within 150 m of it. With `GOOGLE_MAPS_SERVER_KEY` the backend calls the Google Routes API
(`computeRoutes`, DRIVE, stops as intermediates, > 27 points chunked); without a key — or when Google fails (for
example `403` while the Routes API is not enabled) — it stores the straight line through the points, flagged
`polylineSource: "straight"`. Once the key is configured and the API enabled, the next recompute (or stop change)
stores `"google"` automatically. The provider call never runs inside a database transaction; the result is stored
only if the stops did not change meanwhile.

**Automatic refresh:** adding, deleting or reordering stops and changing a stop's coordinates recompute the path
right after the change is committed (the stop response already contains the refreshed route). Renaming a stop or
changing its time/radius does not. When the path drops below two points it is cleared. A change of the school
location is not propagated — recompute the routes afterwards.

Response `200`:
```json
{
  "route": { "…route detail…": "" },
  "routing": {
    "source": "straight", "fallbackReason": "no_api_key", "distanceM": 12650, "durationS": 2070, "includesSchool": true,
    "legs": [{ "fromStopId": "…", "toStopId": "…", "distanceM": 1450, "durationS": 237 },
             { "fromStopId": "…", "toStopId": null, "distanceM": 900, "durationS": 147 }]
  }
}
```
`fallbackReason`: `no_api_key` | `api_error` | `too_few_points` | `null` (Google). A `null` stop id in a leg is the
school. Errors: fewer than two path points → `409 INVALID_STATE`; stops changed during the computation →
`409 CONFLICT` (retry).

## Stops

### `GET /school/routes/:id/stops` · `GET /school/routes/:id/stops/:stopId`
Stop objects (see route detail), live stops only, ordered by `sequence` (always `1…n`).

### `POST /school/routes/:id/stops`
```json
{ "name": "Agara Lake", "code": "A4", "landmark": "Opp. lake gate", "latitude": 12.924, "longitude": 77.647,
  "expectedTime": "07:15", "arrivalRadiusM": 150, "sequence": 4 }
```
`name` (1–200) and coordinates are required; `code` (≤ 40, unique per route, case-insensitive → `409 DUPLICATE`),
`landmark`, `expectedTime` (`HH:mm`), `arrivalRadiusM` (20–2000, default 100 — the geofence for "arrived at stop").
`sequence` (1…n+1) inserts at that position and moves later stops down; omitted → appended. At most 60 live stops
per route (`409 INVALID_STATE`). Response `201 { "stop": {…}, "route": {…route detail…} }`.

### `PATCH /school/routes/:id/stops/:stopId`
Any subset of the create fields except `sequence` (use reorder). Response `200 { "stop", "route" }`.

### `DELETE /school/routes/:id/stops/:stopId`
Soft delete; later stops move up one position. Refused while current/future student assignments use the stop
(`409 CONFLICT`, `details.studentAssignments`). Response `200 { "id", "deleted": true, "route": {…} }`.

### `PUT /school/routes/:id/stops/reorder`
```json
{ "stopIds": ["<stop 3>", "<stop 1>", "<stop 2>"] }
```
Must list **every** live stop of the route exactly once (`400 VALIDATION_ERROR` with `Missing stop …` /
`Unknown stop …` details otherwise). Positions are rewritten in one statement; all stop writes of a route are
serialised on the route row, so concurrent edits never produce gaps or duplicate positions. Response: route detail.

## Bus ↔ route assignments

A bus may serve several routes (typically its morning and afternoon route) and a route several buses. History is
kept: assigning opens a window, unassigning closes it.

### `POST /school/routes/:id/assign-bus`
```json
{ "busId": "…", "effectiveFrom": "2026-10-18T02:30:00Z", "note": "Second bus for the crowd at Agara" }
```
`effectiveFrom` defaults to now and cannot be in the future; a back-dated window must not overlap earlier history of
the same bus + route (`409 CONFLICT`). The bus must exist (`404`) and not be retired, the route must be active
(`409 INVALID_STATE`). Re-assigning a bus that is already assigned is a no-op (`action: "unchanged"`).
```json
{ "action": "assigned",
  "assignment": { "id": "…", "busId": "…", "busCode": "R2", "busName": "Route 2 Bus", "routeId": "…", "routeCode": "R1",
                  "routeName": "…", "direction": "morning", "validFrom": "…", "validTo": null, "isCurrent": true,
                  "createdByName": "Meera Iyer", "createdAt": "…" },
  "buses": [{ "busId": "…", "busCode": "R1", "…": "" }, { "busId": "…", "busCode": "R2", "…": "" }] }
```

### `POST /school/routes/:id/unassign-bus`
`{ "busId": "…", "effectiveTo": "…" (optional, not future, not before the start), "note": "…" }` → `action:
"unassigned"`. Refused while active schedules of this bus on this route remain (`409 CONFLICT`, `details.schedules`)
and when the bus is not assigned (`409 INVALID_STATE`).

### `GET /school/routes/:id/bus-assignments` · `GET /school/bus-route-assignments`
Query: `page`, `limit`, `sort` (`-validFrom` default; `validTo`, `busCode`, `routeCode`, `createdAt`), `routeId`
(global list), `busId`, `direction`, `current` (`true` = open now), `format=csv` (`bus-route-assignments.csv`).
Items are assignment objects as above. The route-scoped variant answers `404` for an unknown route.

## Trip schedules

Recurring plan from which `generate-daily-trips` creates one trip per schedule and school-local date.

```json
{ "id": "…", "name": "R1 morning", "busId": "…", "busCode": "R1", "busName": "Route 1 Bus", "routeId": "…",
  "routeCode": "R1", "routeName": "…", "direction": "morning", "plannedStartTime": "06:50", "daysOfWeek": [1, 2, 3, 4, 5, 6],
  "validFrom": "2026-09-18", "validTo": null, "isActive": true, "estimatedDurationMin": 45, "estimatedEndTime": "07:35",
  "createdAt": "…", "updatedAt": "…" }
```

### `POST /school/trip-schedules` · `PATCH /school/trip-schedules/:id`
```json
{ "busId": "…", "routeId": "…", "direction": "morning", "name": "R1 morning", "plannedStartTime": "06:50",
  "daysOfWeek": [1, 2, 3, 4, 5, 6], "validFrom": "2026-11-01", "validTo": "2027-04-30", "isActive": true }
```
`direction` is optional and must match the route's direction (`400`, path `direction`); weekdays are de-duplicated
and sorted; `validTo` ≥ `validFrom` (both inclusive, `null` = open). PATCH takes any subset; changing `routeId`
without `direction` adopts the new route's direction. An **active** schedule needs a live, non-retired bus and an
active route (`409 INVALID_STATE`); saving it opens the bus ↔ route assignment when there is none (audited as
`route.assign_bus`).

**Same-bus overlap.** An active schedule is rejected with `409 CONFLICT` when another active schedule of the same
bus, whose validity period intersects, runs on a shared weekday within the estimated duration window
`[plannedStartTime, plannedStartTime + estimatedDurationMin)` of either schedule (windows are half-open, so
back-to-back schedules are fine; a window passing midnight collides with the next weekday's early schedules).
The estimated duration of a route is the larger of the span of its stops' expected times and the computed driving
time plus 60 s per stop, 60 minutes when neither is known, clamped to 15–240 minutes.
```json
{ "success": false, "error": { "code": "CONFLICT", "message": "Bus R1 already runs another schedule in this time window on a shared weekday.",
  "details": { "reason": "SCHEDULE_OVERLAP", "estimatedDurationMin": 40, "estimatedEndTime": "08:10",
    "conflicts": [{ "scheduleId": "…", "name": "R1 morning", "routeCode": "R1", "direction": "morning",
                    "plannedStartTime": "07:00", "estimatedEndTime": "07:40", "sharedDays": [1] }] } } }
```
Schedule writes of one bus are serialised (transaction-level advisory lock), so two concurrent requests cannot both
pass the check. Inactive schedules are ignored until they are reactivated (which re-runs the check).

**Generated trips.** Only trips still `scheduled` and dated today or later (school-local) are touched; trips in
progress and history never change. Editing bus, route, direction, time, weekdays or validity updates those trips
(bus/route/direction, planned start, bus/route snapshots; driver/conductor snapshots follow a bus change) and
cancels the ones whose date no longer matches (`cancel_reason = "Schedule changed"`); deactivating cancels them
(`"Schedule deactivated"`). The update audit entry records `tripsUpdated` / `tripsCancelled`.

### `DELETE /school/trip-schedules/:id`
Soft delete; cancels its not-yet-started trips from today on. Response `200 { "id", "deleted": true, "tripsCancelled": 1 }`.

### `GET /school/trip-schedules`
Query: `page`, `limit`, `sort` (`busCode,plannedStartTime` default; `routeCode`, `direction`, `name`, `isActive`,
`validFrom`, `validTo`, `createdAt`), `q` (name, bus code, route code/name), `busId`, `routeId`, `direction`,
`isActive`, `day` (ISO weekday), `validOn` (`YYYY-MM-DD` inside the validity), `format=csv` (`trip-schedules.csv`).

## For other modules

`backend/src/modules/routes/index.ts` exports `buildPath` / `loadPath` (planned path points incl. the school
endpoint), `listStops`, `findRoute`, `schoolLocation` and `toStopDto` — all run inside the caller's transaction.

## Demo data

Seed `50_routes` (per demo school): routes `R1` and `R2` in both directions (8 real-locality stops each, codes
`A1…A8` / `B1…B8`, expected times every 5–6 minutes; afternoon routes reverse the stops), straight-line planned
paths, bus `R1` → line 1 and `R2` → line 2, Monday–Saturday schedules (morning 10 minutes before the first pick-up,
afternoon at the school's departure time).
