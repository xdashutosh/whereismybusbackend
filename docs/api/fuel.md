# Fuel API

Blueprint §6.2 (`fuel_logs`), §8.3 (Fuel/Maintenance), §13.3 (Fuel: log, bill image, per-bus mileage trends);
contract §5. Base `/api/v1`. Source: `backend/src/modules/fuel/`; shared Zod schemas and DTO types:
`backend/shared/src/schemas/fuel.ts` (`@wimb/shared`).

* **School admins only** (`/school/*` area guard + route guard). Drivers, conductors and parents get `403`,
  no token `401`.
* Ids of another school answer `404 NOT_FOUND` on every endpoint (logs, buses, files); `school_id` / `schoolId`
  in a body is ignored (the school always comes from the token).
* Every write is audited in the same transaction: `fuel_log.create`, `fuel_log.update` (changed fields only),
  `fuel_log.delete`. When the write produced warnings, the audit row's `new` carries their codes.
* `POST /school/fuel-logs` accepts `Idempotency-Key`.
* Deleting is soft (`deleted_at`); the bill file stays for audit. Logs of a deleted bus stay readable and editable,
  but a log can only be created for, or moved to, a live bus.
* The bill is uploaded first through the files module (`POST /files/upload` on the web, `upload-url` + `complete`
  on mobile — see [files.md](files.md)) with category **`fuel_bill`** and either `entityType: "bus"` + the bus id
  (before the log exists) or `entityType: "fuel_log"` + the log id (replacing the bill later). The returned id goes
  into `billFileId`. Download it with `GET /files/:id/url`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/school/fuel-logs` | List (filters, sort, pagination, totals, `format=csv`) |
| POST | `/school/fuel-logs` | Create (`201`, response carries `warnings`) |
| GET | `/school/fuel-logs/:id` | Detail |
| PATCH | `/school/fuel-logs/:id` | Correct (partial; response carries `warnings`) |
| DELETE | `/school/fuel-logs/:id` | Soft delete |
| GET | `/school/fuel-logs/mileage-trend?busId=` | One bus: every fill with distance, km/l, cost/km, plus totals and months |
| GET | `/school/fuel-logs/mileage-summary` | One row per bus with fills in the period (`format=csv`) |

## Fuel log object

```json
{
  "id": "01a14e1b-0ed2-7823-ac2c-a128f4ab4376",
  "busId": "01a14e1a-…", "busCode": "R2", "busRegistrationNo": "KA01AC2318",
  "fuelDate": "2026-09-10", "odometer": 58884.3, "litres": 116.01, "cost": 10278.13, "pricePerLitre": 88.6,
  "fuelType": "diesel", "unit": "L", "station": "HP, Bannerghatta Road", "notes": null,
  "bill": null,
  "distanceKm": 1166.6, "spanLitres": 201.95, "spanCost": 17886.94, "kmPerLitre": 5.78, "costPerKm": 15.33,
  "odometerFlags": [],
  "createdBy": "01a14e19-…", "createdByName": "Meera Iyer",
  "createdAt": "2026-09-10T12:00:00.000Z", "updatedAt": "2026-09-10T12:00:00.000Z"
}
```

* `litres` is litres for diesel/petrol, **kg** for CNG and **kWh** for electric buses; `unit` (`L` | `kg` | `kWh`,
  `FUEL_UNITS` / `fuelUnitOf` in `@wimb/shared`) says which — from the log's fuel type, else the bus's.
* `fuelType` defaults to the bus's fuel type when the create body omits it.

### Mileage (fill-to-fill, full tank)

* **Mileage base** of a fill = the earlier fuel log of the same bus with the **highest** reading (ordered by
  `fuelDate`, then entry time). A fill without a reading, or with a mistyped lower one, never becomes a base.
* `distanceKm` = `odometer − base reading` (null for the first reading, a fill without a reading, or a reading not
  above the base).
* `spanLitres` / `spanCost` = litres / cost of **every** fill after the base up to this one — fills without a
  reading included, because their fuel was burnt over the same distance.
* `kmPerLitre = distanceKm / spanLitres`, `costPerKm = spanCost / distanceKm`.

In the example the 3 September fill had no reading, so the 10 September fill measures from 28 August
(1166.6 km) and burns both fills' fuel (85.94 + 116.01 L) → 5.78 km/l.

### Odometer checks (non-blocking)

A bus's readings come from fuel logs, maintenance logs and trip odometer evidence (`trips.start_odometer` /
`end_odometer`). They must not decrease. Days are compared as calendar days, so readings on the same day are
never compared with each other. Each reading is compared with its **nearest** neighbours only: the previous reading
(the latest earlier day, the highest reading of that day) and the next one (the earliest later day, the lowest
reading of that day). A single mistyped entry therefore flags itself and one neighbour, never the whole history.

* `odometerFlags` (lists and details): `below_previous`, `above_next`. Both sides of a decrease are flagged,
  because either reading may be the wrong one.
* `warnings` (create / update responses only; the log **is saved**):

| Code | When | `details` |
|---|---|---|
| `ODOMETER_BELOW_PREVIOUS` | reading lower than the previous reading | `odometer, previousReading, previousDate, previousSource` (`fuel_log` \| `maintenance_log` \| `trip`) |
| `ODOMETER_ABOVE_NEXT` | reading higher than the next reading (a back-dated entry) | `odometer, nextReading, nextDate, nextSource` |
| `ODOMETER_BELOW_BUS` | lower than the bus's `lastKnownOdometer`, although the log is dated after that reading was recorded, and that odometer is above the previous reading | `odometer, busOdometer, busReadingDate` |
| `POSSIBLE_DUPLICATE` | another live log of the bus on the same day with the same litres | `fuelLogId, fuelDate, litres` |

```json
{ "code": "ODOMETER_BELOW_PREVIOUS",
  "message": "The odometer reading 1,000 km is lower than 61,877 km recorded on 2026-10-17 (a trip).",
  "details": { "odometer": 1000, "previousReading": 61877, "previousDate": "2026-10-17", "previousSource": "trip" } }
```

## GET /school/fuel-logs

Query: `page`, `limit` (1–100, default 20), `sort`, `q`, `format=csv` (`pdf` → 400), `busId`,
`fuelType` (comma list of `diesel,petrol,cng,electric,hybrid,other`), `from` / `to` (inclusive `YYYY-MM-DD`;
`from > to` → 400) or `period=<from>..<to>` (the web filter format; explicit `from` / `to` win), `flagged` (`true`: only logs with an odometer flag, `false`: only clean ones), `hasBill`.
`q` searches bus code, registration, station and notes.

Sort fields: `fuelDate` (default `-fuelDate`), `busCode`, `odometer`, `litres`, `cost`, `pricePerLitre`,
`kmPerLitre`, `station`, `createdAt`, `updatedAt` (`-field` = descending, at most 3, nulls last). Anything else → 400.

```json
{ "success": true, "data": [ { "…": "fuel log objects" } ],
  "meta": { "page": 1, "limit": 20, "total": 156, "totalPages": 8, "totals": { "fills": 156, "cost": 945978.69, "unit": "L", "quantity": 11804.58, "litres": 11804.58,
                "byUnit": [ { "unit": "L", "fills": 156, "quantity": 11804.58, "cost": 945978.69, "avgPricePerUnit": 80.14 } ] } } }
```

`meta.totals` sums **every** match of the filters, not only the page; it is `null` on a page past the end.
Quantities of different units are never added together: `byUnit` has one entry per unit present (in `L`, `kg`, `kWh`
order). `unit` / `quantity` are filled only when all matches share one unit (else `null`); `litres` is a deprecated
alias of `quantity` kept for older clients. `fills` and `cost` always cover every match.
CSV (`fuel-logs.csv`, UTF-8 BOM, formula-injection guard, at most 10,000 rows) has these columns: Date, Bus, Registration,
Odometer (km), Litres, Cost, Price per litre, Fuel type, Station, Distance since last fill (km), km per litre,
Cost per km, Odometer flags, Bill attached, Notes, Entered by, Created (UTC).

## POST /school/fuel-logs

```json
{ "busId": "01a14e1a-…", "fuelDate": "2026-10-17", "odometer": 61950.5, "litres": 92.4, "cost": 8214.36,
  "fuelType": "diesel", "station": "Indian Oil, Hosur Road", "billFileId": "01a14e1b-…", "notes": "Full tank" }
```

| Field | Rule |
|---|---|
| `busId` | required; a live bus of the school (`404` otherwise) |
| `fuelDate` | required `YYYY-MM-DD`, **not after today** in the school's timezone (`400`, path `fuelDate`) |
| `odometer` | optional, `0 … 9,999,999.9` km, or `null` |
| `litres` | required, `> 0` and `≤ 5000` (stored with 2 decimals) |
| `cost` | required, `0 … 9,999,999.99` |
| `fuelType` | optional enum or `null`; omitted = the bus's fuel type |
| `station` | optional text ≤ 200 · `notes` optional ≤ 2000 (`""` → null) |
| `billFileId` | optional: an **uploaded** `fuel_bill` of this school (`404`), uploaded for this bus or this log (`400`, path `billFileId`, also for another category), not attached to another live log (`409 CONFLICT`, `details.attachedTo`; two concurrent requests linking the same file are serialised by the unique index `fuel_logs_bill_file_uq` — migration 700 — so the loser also gets `409 CONFLICT`, `details.constraint`; a soft-deleted log releases its bill); an unfinished upload → `409 INVALID_STATE` |

Response `201`: the fuel log object plus `"warnings": […]`.

## PATCH /school/fuel-logs/:id

Any subset of the create fields (at least one, otherwise `400`); `billFileId: null` removes the bill; `busId`
moves the log to another live bus. The date and file rules apply to changed values. Response `200`: the log with
fresh `warnings`.

## DELETE /school/fuel-logs/:id

`200 { "id": "…", "deleted": true }`. A deleted log answers `404` afterwards.

## GET /school/fuel-logs/mileage-trend

Query: `busId` (required; a bus of the school, deleted ones included), `from`, `to`. Distances measure from
the mileage base even when the base lies before `from`.

```json
{ "success": true, "data": {
  "bus": { "id": "…", "code": "R2", "registrationNo": "KA01AC2318", "fuelType": "diesel", "lastKnownOdometer": 61877 },
  "from": null, "to": null,
  "totals": { "fills": 23, "litres": 2255.82, "cost": 199018.26, "distanceKm": 12379.8, "kmPerLitre": 5.76, "costPerKm": 15.32, "avgPricePerLitre": 88.22 },
  "points": [ { "fuelLogId": "…", "fuelDate": "2026-09-10", "odometer": 58884.3, "litres": 116.01, "cost": 10278.13,
                "distanceKm": 1166.6, "spanLitres": 201.95, "spanCost": 17886.94, "kmPerLitre": 5.78, "costPerKm": 15.33, "odometerFlags": [] } ],
  "monthly": [ { "month": "2026-09", "fills": 5, "litres": 507.23, "cost": 44970.22, "distanceKm": 2906.5, "kmPerLitre": 5.73, "costPerKm": 15.47, "avgPricePerLitre": 88.66 } ]
} }
```

Group totals: `kmPerLitre = Σ distanceKm / Σ spanLitres` and `costPerKm = Σ spanCost / Σ distanceKm`, over the fills
of the group that have a distance. `avgPricePerLitre = Σ cost / Σ litres`. Points are in date order, at most 10,000.

## GET /school/fuel-logs/mileage-summary

Query: `from`, `to`, `q` (bus code / registration), `format=csv`. Returns a JSON array, one row per bus with fills in
the period: `busId, busCode, registrationNo, fuelType, fills, litres, cost, distanceKm, kmPerLitre, costPerKm,
avgPricePerLitre, firstFuelDate, lastFuelDate, flaggedLogs`. CSV: `fuel-mileage.csv`.

## Seed data

`src/db/seeds/78_fleet_ops.ts` adds about five months of fills per demo bus R1–R6, with city prices and stations,
CNG in kg, depot charging in kWh for the electric van, and R6 stopping 18 days ago while it is in the workshop.
Readings are continuous and end below the first trip reading of seed 70. The only exceptions are one deliberate typo
on **R4** (900 km too low; it and the fill before it are flagged) and one **R2** fill without a reading. The latest
fill of each bus has a generated PDF bill.
