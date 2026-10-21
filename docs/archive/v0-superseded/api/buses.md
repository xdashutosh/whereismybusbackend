# Buses API (`buses` module)

Module `buses` · base path `/api/v1` · contract: ARCHITECTURE §3.3, §4, §6, §13, §17 "Buses" / "Documents",
§24, §25 · FRD §6 · source `backend/src/modules/buses/` (bus documents use the documents sub-component in
`backend/src/modules/drivers/documents.*.js`, see [drivers.md](drivers.md#documents)).

Roles: every admin role (`DEPOT_ADMIN`, `REGION_ADMIN`, `STATE_ADMIN`, `SYSTEM_ADMIN`); drivers and
passengers get `403 FORBIDDEN`. Scope (§6): a depot admin sees and manages only their depot, a region admin
the depots of their region, a state admin the depots of their state, a system admin everything.
A bus outside your scope requested by id returns `404 NOT_FOUND`; a `depotId`/`regionId` filter or a target
depot outside your scope returns `403 OUT_OF_SCOPE`. Every mutation writes an audit row in the same
transaction (`bus.*`, `busMaintenance.*`, `busFuel.*`, `document.*`).

Registration numbers are normalised to upper case without spaces, dots or dashes
(`"ka-01 f.1234"` → `KA01F1234`, 4–15 letters/digits); fleet numbers are trimmed and upper-cased and are
unique per depot.

## Bus DTO (list item)

```json
{ "id": "9d55…", "depotId": "6597…", "depotCode": "ECY", "depotName": "Electronic City",
  "regionId": "7690…", "regionName": "Bengaluru",
  "registrationNo": "KA51F3008", "fleetNo": "ECY-108", "make": "Ashok Leyland", "model": "Circuit H",
  "capacity": 50, "busType": "ORDINARY", "fuelType": "HYBRID", "manufactureYear": 2023, "status": "MAINTENANCE",
  "insuranceExpiry": "2027-12-07", "fitnessExpiry": "2027-12-23", "permitExpiry": "2028-10-14",
  "odometerKm": 231400, "nextComplianceExpiry": "2027-12-07",
  "createdAt": "2026-10-17T08:44:34.112Z", "updatedAt": "2026-10-17T08:44:34.112Z" }
```

Enumerations (`GET /meta/enums`): `busTypes` ORDINARY, EXPRESS, DELUXE, AC, SLEEPER, ELECTRIC, MINI ·
`fuelTypes` DIESEL, CNG, ELECTRIC, HYBRID, PETROL · `busStatuses` ACTIVE, MAINTENANCE, INACTIVE.
`nextComplianceExpiry` = earliest of insurance / fitness / permit expiry (dates are local to the state).

## GET /admin/buses

| Query | Meaning |
|---|---|
| `page`, `pageSize` | default 1 / 20, max 100 |
| `sort` | `registrationNo` (default), `fleetNo`, `status`, `busType`, `fuelType`, `capacity`, `make`, `model`, `manufactureYear`, `odometerKm`, `insuranceExpiry`, `fitnessExpiry`, `permitExpiry`, `nextComplianceExpiry`, `depotName`, `regionName`, `createdAt`, `updatedAt`; `-` prefix = descending; other fields → `400` |
| `q` | registration (spaces/dashes ignored), fleet number, make or model (substring, case-insensitive) |
| `status`, `busType`, `fuelType` | comma separated or repeated (`status=ACTIVE,MAINTENANCE`) |
| `expiringWithinDays` | 0–3650: insurance, fitness **or** permit expiring on or before today + N (already expired included) |
| `regionId`, `depotId` | narrow inside your scope (`403 OUT_OF_SCOPE` outside) |
| `format` | `json` (default) or `csv` |

Response: list envelope with the DTO above and `meta: { page, pageSize, total, totalPages }`. One SQL query
(rows + names + total). Pages are cached 60 s in `admin:buses`; every bus write (including imports and
records) invalidates the namespace after commit.

`?format=csv` streams the same filtered/sorted list (max 10 000 rows, `buses.csv`, UTF-8 BOM, CRLF) with
columns `Registration No, Fleet No, Depot, Region, Status, Bus Type, Fuel Type, Make, Model, Capacity,
Manufacture Year, Odometer (km), Insurance Expiry, Fitness Expiry, Permit Expiry`. Cells starting with
`= + - @`, TAB or CR are prefixed with `'`.

## POST /admin/buses

```json
{ "depotId": "6597…", "registrationNo": "KA 01 F 1234", "fleetNo": "shn-12", "make": "Tata Motors",
  "model": "Starbus", "capacity": 42, "busType": "AC", "fuelType": "CNG", "manufactureYear": 2021,
  "status": "ACTIVE", "insuranceExpiry": "2027-03-31", "fitnessExpiry": null, "permitExpiry": null,
  "odometerKm": 15000, "notes": "Spare for 500D" }
```

Only `registrationNo` is required. `depotId` defaults to the caller's depot and is required for
region/state/system admins (`400`). `capacity` 1–200, `manufactureYear` 1950–next year, `odometerKm` ≥ 0,
dates `YYYY-MM-DD`; unknown keys → `400`. Response `201` with the **detail DTO** (below).
Errors: `400 VALIDATION_ERROR` (`details[].path` per field), `403 OUT_OF_SCOPE` (depot),
`409 DUPLICATE` with `details: { field: "registrationNo" | "fleetNo", constraint }`.

## GET /admin/buses/:id

Detail DTO = list fields plus:

```json
{ "notes": "Spare for 500D", "stateId": "…", "stateName": "Karnataka", "timezone": "Asia/Kolkata", "today": "2026-10-17",
  "photoUrl": null, "photoUrlExpiresAt": null,
  "compliance": { "insurance": { "expiry": "2026-10-29", "expired": false, "expiringSoon": true },
                  "fitness": { "expiry": "2027-06-03", "expired": false, "expiringSoon": false },
                  "permit": { "expiry": null, "expired": false, "expiringSoon": false } },
  "currentTrip": { "id": "…", "status": "ACTIVE", "serviceDate": "2026-10-17",
                   "plannedStart": "2026-10-17T08:30:00.000Z", "plannedEnd": "2026-10-17T09:30:00.000Z",
                   "actualStart": "2026-10-17T08:33:00.000Z", "delayMinutes": 0,
                   "routeId": "…", "routeCode": "500D", "routeName": "Majestic – Electronic City", "direction": "OUTBOUND",
                   "busId": "…", "busRegistrationNo": "KA01F1234", "busFleetNo": "SHN-12",
                   "driverId": "…", "driverName": "Ramesh Kumar", "driverEmployeeCode": "DRV-SHN-001" },
  "nextTrip": { "…": "same shape" },
  "counts": { "upcomingTrips": 1, "completedTrips": 14, "maintenanceRecords": 3, "fuelRecords": 7, "documents": 2 },
  "documentCount": 2,
  "maintenanceDue": { "recordId": "…", "type": "INSPECTION", "nextDueDate": "2026-10-27", "lastServiceDate": "2026-09-27", "overdue": false },
  "permissions": { "canEdit": true, "canChangeStatus": true, "canDelete": false, "deleteMode": "SOFT",
                   "canManageRecords": true, "canManageDocuments": true } }
```

- `currentTrip`: the ACTIVE trip (or a SUSPENDED one that had started); `nextTrip`: earliest not-started
  trip (SCHEDULED/DELAYED, or SUSPENDED before start) whose window has not ended. Both `null` when none.
- `expiringSoon` = within 30 days. `maintenanceDue`: for each maintenance type the latest record wins; the
  earliest `nextDueDate` among them is reported.
- `photoUrl`: short-lived link (5 min) to the latest live `PHOTO` document of the bus, else `null`.
- `permissions.canDelete` is false while upcoming trips exist; `deleteMode` is `SOFT` once the bus was ever
  used by a trip/schedule, otherwise `HARD`. One SQL query.

## PATCH /admin/buses/:id

Any create field (all optional, at least one) plus `acknowledgeFutureTrips` (boolean). `depotId` moves the
bus (target depot must be in scope; its documents follow). Response `200` with the detail DTO.

**IN_USE rule** — changing `status` to `MAINTENANCE`/`INACTIVE`, or moving the bus to another depot, while
upcoming not-started trips exist is refused unless `acknowledgeFutureTrips: true` (trips stay assigned;
reassign them through the trips module). Setting `ACTIVE` never needs it. The bus row is locked
(`FOR UPDATE`) for the check.

```json
{ "success": false, "error": { "code": "IN_USE", "message": "The bus has upcoming trips. Reassign them or confirm the status change with acknowledgeFutureTrips=true.",
  "details": { "count": 2, "trips": [ { "tripId": "…", "serviceDate": "2026-10-18", "plannedStart": "2026-10-18T02:30:00.000Z",
               "plannedEnd": "2026-10-18T03:30:00.000Z", "status": "SCHEDULED", "routeCode": "500D", "routeName": "…" } ] },
  "requestId": "…" } }
```

`details.trips` holds the next 20 trips. With acknowledgement the audit row's `after` carries
`acknowledgedFutureTrips: <count>`.

## DELETE /admin/buses/:id

- upcoming trips exist → `409 IN_USE` (same details);
- the bus was ever referenced by trips, schedules or assignment history → **soft delete**: status `INACTIVE`
  (`bus.deactivate`); response `{ "id": "…", "mode": "SOFT", "status": "INACTIVE" }`;
- never referenced → **hard delete** (maintenance/fuel rows cascade, documents soft-deleted and their objects
  removed after commit; `bus.delete`); response `{ "id": "…", "mode": "HARD", "status": null }`.

## GET /admin/buses/:id/trips?when=current|upcoming|past

`when` defaults to `upcoming`; `page`/`pageSize`. `current` = ACTIVE (or started-then-suspended), `upcoming`
= not started and not over (ascending by planned start), `past` = completed, cancelled, or not started and
over (descending). Items:

```json
{ "id": "…", "scheduleId": "…", "serviceDate": "2026-10-18", "plannedStart": "…Z", "plannedEnd": "…Z",
  "status": "SCHEDULED", "statusBeforeSuspend": null, "delayMinutes": 0, "delayReason": null,
  "actualStart": null, "actualEnd": null, "cancelReason": null, "suspendReason": null,
  "routeId": "…", "routeCode": "500D", "routeName": "…", "direction": "OUTBOUND", "serviceType": "ORDINARY",
  "busId": "…", "busRegistrationNo": "KA01F1234", "busFleetNo": "SHN-12",
  "driverId": "…", "driverName": "Ramesh Kumar", "driverEmployeeCode": "DRV-SHN-001",
  "depotId": "…", "depotName": "Shanthinagar", "timezone": "Asia/Kolkata" }
```

## GET /admin/buses/:id/availability?from&to

`from`/`to`: ISO-8601 instants, or `YYYY-MM-DD` local dates (`from` = start of day, `to` = end of that day,
state timezone). Defaults: `from` = now, `to` = `from` + 24 h; `to` must be after `from`; at most 31 days.

```json
{ "busId": "…", "registrationNo": "KA01F1234", "fleetNo": "SHN-12", "status": "ACTIVE", "timezone": "Asia/Kolkata",
  "from": "2026-10-19T08:00:00.000Z", "to": "2026-10-19T14:00:00.000Z", "available": false, "reasons": ["CONFLICT"],
  "busyWindows": [ { "tripId": "…", "serviceDate": "2026-10-19", "start": "2026-10-19T09:00:00.000Z", "end": "2026-10-19T10:00:00.000Z",
                     "status": "SCHEDULED", "routeCode": "500D", "routeName": "…" } ],
  "freeWindows": [ { "start": "2026-10-19T08:00:00.000Z", "end": "2026-10-19T09:00:00.000Z" },
                   { "start": "2026-10-19T10:00:00.000Z", "end": "2026-10-19T14:00:00.000Z" } ] }
```

Busy windows = trips in `SCHEDULED/DELAYED/ACTIVE/SUSPENDED` overlapping the range (same predicate as the
exclusion constraint). `reasons`: `STATUS_MAINTENANCE` / `STATUS_INACTIVE`, `CONFLICT`. `freeWindows` is empty
when the bus is not ACTIVE. Informational only — schedule/trip creation re-checks transactionally.

## Maintenance records

### GET /admin/buses/:id/maintenance
`page`/`pageSize`; newest service first. `meta` additionally carries `nextDue` (same shape as
`maintenanceDue` in the detail, or `null`).

```json
{ "success": true,
  "data": [ { "id": "…", "busId": "…", "serviceDate": "2026-10-17", "type": "SERVICE", "description": "Periodic service",
              "odometerKm": 5000, "cost": 1234.57, "vendor": "Depot workshop", "nextDueDate": "2027-01-15",
              "createdBy": "…", "createdByName": "Shanthinagar Depot Admin", "createdAt": "…Z" } ],
  "meta": { "page": 1, "pageSize": 20, "total": 3, "totalPages": 1,
            "nextDue": { "recordId": "…", "type": "INSPECTION", "nextDueDate": "2026-11-06", "lastServiceDate": "2026-10-07", "overdue": false } } }
```

### POST /admin/buses/:id/maintenance
`{ serviceDate (YYYY-MM-DD, not in the future), type (SERVICE|REPAIR|INSPECTION|TYRE|OTHER), description?,
odometerKm?, cost? (≥ 0, rounded to 2 decimals), vendor?, nextDueDate? (≥ serviceDate) }` → `201` with the
record plus `nextDue`. A higher `odometerKm` raises the bus odometer (never lowers it).

### PATCH /admin/buses/:id/maintenance/:recordId · DELETE /admin/buses/:id/maintenance/:recordId
PATCH: any field (at least one), same rules (the combined `nextDueDate ≥ serviceDate` is re-checked) →
`200` record + `nextDue`. DELETE → `204`. A record of another bus or outside scope → `404`.

## Fuel records

### GET /admin/buses/:id/fuel
`page`/`pageSize`; newest fill first. `meta.summary` covers the last 30 days (computed in the same query):

```json
"meta": { "page": 1, "pageSize": 2, "total": 4, "totalPages": 2,
          "summary": { "days": 30, "fills": 3, "totalCost": 14000,
                       "byUnit": [ { "unit": "KG", "fills": 1, "quantity": 20, "cost": 0 },
                                   { "unit": "LITRE", "fills": 2, "quantity": 150.26, "cost": 14000 } ] } }
```

Items: `{ id, busId, filledAt, quantity, unit, cost, odometerKm, station, createdBy, createdByName, createdAt }`.

### POST /admin/buses/:id/fuel
`{ filledAt (ISO-8601, not more than 5 min in the future), quantity (> 0), unit (LITRE|KG|KWH), cost?, odometerKm?, station? }`
→ `201` record. PATCH `/admin/buses/:id/fuel/:recordId` (any field) → `200`; DELETE → `204`.

## Bus documents

### GET /admin/buses/:id/documents
`page`, `pageSize`, `sort` (`createdAt` default `-createdAt`, `kind`, `validUntil`, `fileName`), `kind`
(list). Items are the [document DTO](drivers.md#document-dto) with `expired` / `expiringSoon` (30 days)
computed from `validUntil` in the depot's timezone.

### POST /admin/buses/:id/documents (multipart/form-data)
Fields: `file` (one file, ≤ 10 MB, **JPEG/PNG/WEBP/PDF detected by magic bytes**), `kind`
(`RC`, `INSURANCE`, `FITNESS`, `PERMIT`, `PHOTO`, `OTHER`), `validUntil?` (`YYYY-MM-DD`), `notes?` (≤ 500).
→ `201` document DTO. Stored under `whereismybus/buses/{busId}/{docId}-{safeName}`; the object is written
first, the row inserted in a transaction, and the object deleted again if the transaction fails.
Errors: `400` (missing file/kind, bad date), `404` (bus outside scope), `413 PAYLOAD_TOO_LARGE`,
`415 UNSUPPORTED_FILE`. The latest live `PHOTO` becomes the bus `photoUrl`.

Delete and download are shared with drivers: `DELETE /admin/documents/:docId`,
`GET /admin/documents/:docId/download` — see [drivers.md › Documents](drivers.md#documents).

## Caching

| Namespace | TTL | Content | Invalidated by |
|---|---|---|---|
| `admin:buses` | 60 s | `GET /admin/buses` pages | every bus write (create/update/delete, maintenance/fuel writes, bus imports) |

Detail, trips, availability and records are read live (they contain trip state). Authorization is never cached.

## Internal service API (for other modules)

`src/modules/buses/service.js`:

| Function | Description |
|---|---|
| `invalidateBusesCache()` | bumps `admin:buses`; call after committing a write that changes bus list data |
| `getBrief(scope, id, { client })` | `{ id, depotId, registrationNo, fleetNo, status, busType, timezone }` inside scope, else `NOT_FOUND` |
| `DUPLICATE_FIELDS` | constraint → field/message map for friendly `DUPLICATE` errors |

`src/modules/buses/fleetCommon.js` (shared by buses/drivers, usable by schedules/trips/dashboard):
`WHEN_PREDICATES` (`current` / `upcoming` / `past` SQL on alias `t`), `futureTrips(client, { resource: 'BUS'|'DRIVER', id, limit })`
(the IN_USE report), `busyWindows({ resource, id, from, to })`, `listResourceTrips(...)`, `resolveRange(query, tz)`,
`freeWindows(busy, from, to)`, `expiryFlags(date, today)`, `isoUtc(expr)`.
`src/modules/buses/schemas.js` exports `normaliseRegistration` / `normaliseFleetNo` (also used by imports).
