# Maintenance API

Blueprint §6.2 (`maintenance_logs`), §7.3 (`maintenance-due-scan`), §8.3 (Fuel/Maintenance), §13.3 (Maintenance:
log, invoice, next due, due list); contract §5, §8. Base `/api/v1`. Source: `backend/src/modules/maintenance/`;
shared Zod schemas and DTO types: `backend/shared/src/schemas/maintenance.ts` (`@wimb/shared`).

* **School admins only** (`/school/*` area guard + route guard). Drivers, conductors and parents get `403`,
  no token `401`.
* Ids of another school answer `404 NOT_FOUND` on every endpoint (logs, buses, files); `school_id` in a body is
  ignored.
* Every write is audited in the same transaction: `maintenance_log.create`, `maintenance_log.update` (changed
  fields only), `maintenance_log.delete`. Warning codes, if any, go into the audit row's `new`.
* `POST /school/maintenance-logs` accepts `Idempotency-Key`.
* Soft delete (`deleted_at`); the invoice file is kept. Logs of a deleted bus stay readable and editable, but a log
  can only be created for, or moved to, a live bus.
* The invoice is uploaded first through the files module ([files.md](files.md)) with category
  **`maintenance_invoice`** and `entityType: "bus"` + the bus id, or `entityType: "maintenance_log"` + the log id.
  The returned id goes into `invoiceFileId`. Download it with `GET /files/:id/url`.
* After every create, delete and changing update (after commit), the queue job **`maintenance-due-refresh`**
  re-runs the alerts module's `maintenance-due-scan` for the school. Logging the service resolves its `service_due`
  alert, and a new next-due date raises one, without waiting for the 06:45 daily scan (see [alerts.md](alerts.md)).

| Method | Path | Purpose |
|---|---|---|
| GET | `/school/maintenance-logs` | List (filters incl. due state, sort, pagination, cost total, `format=csv`) |
| POST | `/school/maintenance-logs` | Create (`201`, response carries `warnings`) |
| GET | `/school/maintenance-logs/:id` | Detail |
| PATCH | `/school/maintenance-logs/:id` | Correct (partial; response carries `warnings`) |
| DELETE | `/school/maintenance-logs/:id` | Soft delete |
| GET | `/school/maintenance-logs/due` | Service due list (`format=csv`) |

## Maintenance log object

```json
{
  "id": "01a14e1b-…", "busId": "01a14e1a-…", "busCode": "R2", "busRegistrationNo": "KA01AC2318", "busOdometer": 61877,
  "serviceType": "Oil change", "serviceDate": "2026-08-15", "cost": 4501, "odometer": 56627.9,
  "vendor": "Bommanahalli Auto Works", "notes": "Engine oil 15W-40 and oil filter",
  "invoice": null,
  "nextDueDate": "2026-10-14", "nextDueKm": 62627.9,
  "dueStatus": "overdue", "daysToDue": -4, "kmToDue": 750.9,
  "odometerFlags": [],
  "createdBy": "01a14e19-…", "createdByName": "Meera Iyer",
  "createdAt": "2026-08-15T12:00:00.000Z", "updatedAt": "2026-08-15T12:00:00.000Z"
}
```

`invoice` is like the fuel bill: `{ id, fileName, contentType, sizeBytes, hasThumbnail }` or `null`.
`busOdometer` = `buses.last_known_odometer`, which trips keep current. `daysToDue` counts from today in the school's
timezone. `kmToDue = nextDueKm − busOdometer`. Both are negative when overdue.

### Due state (`dueStatus`)

These are the rules of `maintenance-due-scan` (lead window `SERVICE_DUE_LEAD_DAYS = 7`, `SERVICE_DUE_LEAD_KM = 500`
from the alerts schemas):

| Value | When |
|---|---|
| `completed` | a newer live log of the **same bus and service type** exists (type compared case-insensitively, trimmed; newer = later service date, then entry time) |
| `none` | no `nextDueDate` and no `nextDueKm` |
| `overdue` | `nextDueDate` before today, **or** bus odometer ≥ `nextDueKm` |
| `due_soon` | `nextDueDate` within 7 days (today included), **or** bus odometer within 500 km of `nextDueKm` |
| `scheduled` | otherwise |

### Odometer checks (non-blocking)

These are the same rules as fuel logs ([fuel.md](fuel.md#odometer-checks-non-blocking)). Readings from fuel logs,
maintenance logs and trips are compared with their nearest neighbours by calendar day. Lists show
`odometerFlags` (`below_previous`, `above_next`), and writes return
`warnings`: `ODOMETER_BELOW_PREVIOUS`, `ODOMETER_ABOVE_NEXT`, `ODOMETER_BELOW_BUS`, and `POSSIBLE_DUPLICATE`. The
duplicate warning means another live log of the bus has the same service type on the same day; its `details` are
`maintenanceLogId, serviceDate, serviceType`. The log is always saved.

## GET /school/maintenance-logs

Query: `page`, `limit`, `sort`, `q`, `format=csv` (`pdf` → 400), `busId`, `serviceType` (exact, case-insensitive),
`dueStatus` (comma list of `overdue,due_soon,scheduled,completed,none`), `from` / `to` (service date, inclusive) or `period=<from>..<to>`,
`flagged`, `hasInvoice`. `q` searches service type, vendor, notes, bus code and registration.

Sort fields: `serviceDate` (default `-serviceDate`), `busCode`, `serviceType`, `cost`, `odometer`, `vendor`,
`nextDueDate`, `nextDueKm`, `dueStatus` (urgency: overdue, due_soon, scheduled, none, completed), `createdAt`,
`updatedAt`.

`meta` adds `totals: { cost }` over every match (`null` on a page past the end). CSV (`maintenance-logs.csv`) has
these columns: Service date, Bus, Registration, Service type, Cost, Odometer (km), Vendor, Next due date, Next due (km),
Due status, Days to due, km to due, Odometer flags, Invoice attached, Notes, Entered by, Created (UTC).

## POST /school/maintenance-logs

```json
{ "busId": "01a14e1a-…", "serviceType": "Oil change", "serviceDate": "2026-10-17", "cost": 4850, "odometer": 61870,
  "vendor": "Bommanahalli Auto Works", "notes": "Engine oil and filter", "invoiceFileId": "01a14e1b-…",
  "nextDueDate": "2026-12-16", "nextDueKm": 67870 }
```

| Field | Rule |
|---|---|
| `busId` | required; a live bus of the school (`404`) |
| `serviceType` | required text 1–100 (trimmed). Suggested values: `MAINTENANCE_SERVICE_TYPES` in `@wimb/shared` (General service, Oil change, Brake inspection, Tyre replacement, Tyre rotation, Battery replacement, Air filter, Coolant flush, Clutch overhaul, Wheel alignment, AC service, Body repair, Fire extinguisher refill, Speed governor calibration, GPS device check) |
| `serviceDate` | required `YYYY-MM-DD`, not after today (school timezone) |
| `cost` | optional `0 … 9,999,999.99` or `null` |
| `odometer` | optional `0 … 9,999,999.9` km or `null` |
| `vendor` ≤ 200 · `notes` ≤ 2000 | optional (`""` → null) |
| `invoiceFileId` | optional: an uploaded `maintenance_invoice` of this school, uploaded for this bus or this log, not attached to another live log (same errors as the fuel bill; concurrent links are refused by the unique index `maintenance_logs_invoice_file_uq`, migration 700 → `409 CONFLICT`) |
| `nextDueDate` | optional; must be **after** `serviceDate` (`400`, path `nextDueDate`) |
| `nextDueKm` | optional; must be **above** `odometer` when both are set (`400`, path `nextDueKm`) |

Response `201`: the log plus `"warnings": […]`.

## PATCH /school/maintenance-logs/:id

Any subset of the fields (at least one). The date and km rules are re-checked against the **stored** values, so
moving `serviceDate` past `nextDueDate`, or raising `odometer` above `nextDueKm`, is rejected even when the other
field is not in the body. `null` clears an optional field.

## DELETE /school/maintenance-logs/:id

`200 { "id": "…", "deleted": true }`.

## GET /school/maintenance-logs/due

The list holds the **latest** live log of each bus + service type (case-insensitive) for live buses in service
(`active`, `maintenance`), when that log has a next due date or km. This is exactly the set
`maintenance-due-scan` raises `service_due` alerts for (overdue → critical, due soon → warning).

Query: `status` (comma list of `overdue,due_soon,scheduled`; default `overdue,due_soon`), `busId`, `q` (service type,
vendor, bus code, registration), `page`, `limit`, `sort`, `format=csv`. Sort fields: `status` (urgency), `nextDueDate`,
`daysToDue`, `nextDueKm`, `kmToDue`, `busCode`, `serviceType`, `lastServiceDate`. The default is
`status,nextDueDate,kmToDue`.

```json
{ "success": true, "data": [
  { "maintenanceLogId": "…", "busId": "…", "busCode": "R2", "registrationNo": "KA01AC2318", "busStatus": "active", "busOdometer": 61877,
    "serviceType": "Oil change", "lastServiceDate": "2026-08-15", "lastServiceOdometer": 56627.9, "vendor": "Bommanahalli Auto Works",
    "nextDueDate": "2026-10-14", "nextDueKm": 62627.9, "daysToDue": -4, "kmToDue": 750.9, "status": "overdue", "reason": "date" },
  { "maintenanceLogId": "…", "busCode": "R6", "busStatus": "maintenance", "serviceType": "General service",
    "nextDueDate": null, "nextDueKm": 103955.6, "kmToDue": -400, "status": "overdue", "reason": "km", "…": "…" },
  { "maintenanceLogId": "…", "busCode": "R2", "serviceType": "Tyre rotation", "nextDueKm": 62177, "kmToDue": 300, "status": "due_soon", "reason": "km", "…": "…" }
], "meta": { "page": 1, "limit": 20, "total": 6, "totalPages": 1 } }
```

`reason` says what makes the item due: `date` or `km`, with the date winning when both apply. It is `null` for
`scheduled`. CSV (`maintenance-due.csv`) has these columns: Status, Reason, Bus, Registration, Bus status, Service type,
Next due date, Days to due, Next due (km), Bus odometer (km), km to due, Last service, Last service odometer (km), Vendor.

## Job

| Job | Kind | Payload | What it does |
|---|---|---|---|
| `maintenance-due-refresh` | queue (3 attempts, 5 s backoff, concurrency 1) | `{ schoolId }` | `maintenanceDueScan({ schoolId })` from the alerts module (idempotent reconcile); exported as `maintenanceDueRefresh()` for tests |

## Seed data

`src/db/seeds/78_fleet_ops.ts` adds a year of history per demo bus. That covers general service, oil change, brakes,
tyre rotation, fire extinguisher, speed governor, CNG kit / cylinder for R3, and EV service / battery checks for R5.
The latest services give a due list with every state:

* R2 oil change: overdue (date)
* R3 CNG kit service: overdue (date)
* R6 general service: overdue (km). R6 is in the workshop with a clutch overhaul.
* R5 battery health check: due soon (date)
* R1 general service: due soon (date)
* R2 tyre rotation: due soon (km)
* Everything else is scheduled.

The latest paid service of each bus has a generated PDF invoice. The seed runs before `80_alerts`, whose real
`maintenance-due-scan` then raises the six matching `service_due` alerts per school (three critical for the overdue items, three warning for the due-soon ones).
