# Reports & Dashboard API (BP §8.3 Reports + Dashboard, §13.3 Dashboard / Reports)

Bus-level reports with JSON, CSV and PDF output, and the school admin dashboard. Code:
`backend/src/modules/reports/` (`router.ts`, `dashboardRouter.ts`). Shared schemas and DTOs: `@wimb/shared` →
`backend/shared/src/schemas/reports.ts` (`reportQuery`, `REPORT_KINDS`, `ReportResponse`, the row types, `SchoolDashboard`,
`DASHBOARD_ALERT_GROUPS`, `REPORT_MAX_RANGE_DAYS`, `REPORT_DEFAULT_RANGE_DAYS`, `DASHBOARD_EXPIRY_WINDOW_DAYS`,
`DASHBOARD_RECENT_DAYS`).

Every endpoint requires a **school admin** of an active school (`/school/*` area guard). Drivers, conductors, parents and
super admins get `403 FORBIDDEN`; no token gets `401`. A `schoolId` / `school_id` in the query is ignored, so every
number comes from the caller's school only (RLS). Each report runs **one aggregate statement**, and the dashboard runs
one statement too. Both run in a single READ ONLY transaction.

## `GET /school/reports/{kind}`

`kind` is one of `bus-distance`, `fuel`, `maintenance`, `cost-per-km`, `service-due`, `non-school-usage` or
`trip-summary`. Any other path answers `404 NOT_FOUND`.

| Param | Meaning |
|---|---|
| `period` | `YYYY-MM-DD..YYYY-MM-DD` (one day `YYYY-MM-DD`, or an open end) — the web filter / quick-link format; fills `from` / `to` that are not given. |
| `from`, `to` | School-local calendar days (`YYYY-MM-DD`, inclusive), with `from ≤ to` and at most **366 days**. Defaults: neither given → the last **30** days ending school-local today; only `to` → the 30 days ending on `to`; only `from` → `from` to today (just `from` when it lies in the future). **service-due** has no default range: without dates it lists every schedule, and with dates it keeps schedules whose next due date falls in the range (km-only schedules then drop out). |
| `busId` | Limits the report to one bus. Deleted buses are accepted, because history stays reportable. A bus of another school answers `404 NOT_FOUND`. |
| `format` | `json` (default), `csv` or `pdf`. |

**Feature flag.** When the school's effective `reports` feature is off (school settings narrowed by the platform), every
report answers `403 FORBIDDEN` with `details { "reason": "FEATURE_DISABLED", "feature": "reports" }`. The dashboard is
not gated.

**Dates.** Trips are grouped by `trip_date`, fuel by `fuel_date` and maintenance by `service_date`. All three are
stored as the school's local date. "Today" always means today in the school's timezone (`schools.timezone`).

**Which trips count.** A trip **ran** when it started and was closed: `completed`, `auto_closed`, or `cancelled` after it
had started. Its distance is the odometer distance, or the GPS distance when no odometer distance was recorded.
Bus-level reports list every non-deleted bus, so idle buses show zeros. Deleted buses appear only when they have
activity in the range.

**How fuel and cost-per-km measure distance.** Trips miss dead-head and depot runs, but the fills cover every kilometre
driven. So `fuel` and `cost-per-km` take the distance from the **fuel-log odometer readings**, using the same
fill-to-fill method as the Fuel page mileage (`GET /school/fuel-logs/mileage-trend`, [fuel.md](fuel.md)). A fill's
distance is its reading minus its mileage base, which is the earlier fill of the bus with the highest reading. The base
may lie before the range. The fuel burnt over that distance is every fill after the base up to this fill, including
fills without a reading.

* `odometerKm` (*Odometer km between fills*) = Σ fill-to-fill distance of the fills in the range. It is null when no
  fill in the range has a distance, meaning fewer than two odometer readings.
* `tripKm` (*Trip km*) = distance of the trips that ran (see above).
* `distanceKm` = `odometerKm`, or `tripKm` when `odometerKm` is null. `distanceSource` says which one: `odometer` |
  `trips` | null (no distance).
* `kmQuantity` / `kmCost` = the fuel burnt over `distanceKm`. With `odometer` it is the span quantity / cost of those
  fills; with `trips` it is every fill in the range. Both are null without a distance, so a bus with fuel but no km
  never skews the per-km totals.
* `kmPerUnit` = `distanceKm / kmQuantity` (one unit only). `fuelCostPerKm` = `kmCost / distanceKm`. For an odometer
  distance these equal the Fuel page's km/l and ₹/km for the same bus and period. Totals: Σ `kmCost` / Σ `distanceKm`.
* `cost` / `fuelCost` stay the cost of all fills dated in the range. `costPerKm` = (`kmCost` + maintenance cost) /
  `distanceKm`.
* The PDF prints `distanceKm` and `distanceSource`. JSON and CSV also carry both measurements.

Errors: `400 VALIDATION_ERROR` for a bad date, `from > to`, a range over 366 days (the resolved default range is checked
too), a bad `busId` or an unknown `format`.

### JSON response

```json
{
  "success": true,
  "data": {
    "report": "fuel",
    "title": "Fuel",
    "range": { "from": "2026-10-08", "to": "2026-10-18" },
    "busId": null,
    "timezone": "Asia/Kolkata",
    "generatedAt": "2026-10-18T08:12:40.511Z",
    "columns": [
      { "key": "busCode", "label": "Bus", "type": "text" },
      { "key": "registrationNo", "label": "Registration", "type": "text" },
      { "key": "fuelType", "label": "Fuel type", "type": "text" },
      { "key": "units", "label": "Unit", "type": "list" },
      { "key": "fills", "label": "Fills", "type": "int" },
      { "key": "litres", "label": "Litres", "type": "decimal" },
      { "key": "kg", "label": "CNG kg", "type": "decimal" },
      { "key": "kwh", "label": "kWh", "type": "decimal" },
      { "key": "cost", "label": "Cost", "type": "money" },
      { "key": "avgPricePerUnit", "label": "Avg price / unit", "type": "money" },
      { "key": "odometerKm", "label": "Odometer km between fills", "type": "km" },
      { "key": "tripKm", "label": "Trip km", "type": "km" },
      { "key": "distanceKm", "label": "Distance km", "type": "km" },
      { "key": "distanceSource", "label": "Distance from", "type": "text" },
      { "key": "kmPerUnit", "label": "Km / unit", "type": "decimal" },
      { "key": "fuelCostPerKm", "label": "Fuel cost / km", "type": "money" },
      { "key": "lastFillDate", "label": "Last fill", "type": "date" }
    ],
    "rows": [
      { "busId": "019a…", "busCode": "R1", "registrationNo": "KA01AB1001", "fuelType": "diesel", "busDeleted": false,
        "fills": 2, "units": ["L"], "litres": 60, "kg": 0, "kwh": 0, "litresCost": 5800, "kgCost": 0, "kwhCost": 0, "cost": 5800,
        "avgPricePerUnit": 96.67, "odometerKm": 500, "tripKm": 70.5, "distanceKm": 500, "distanceSource": "odometer",
        "kmQuantity": 20, "kmCost": 2000, "kmPerUnit": 25, "fuelCostPerKm": 4, "lastFillDate": "2026-10-16" },
      { "busId": "019a…", "busCode": "R2", "registrationNo": "KA01AB1002", "fuelType": "diesel", "busDeleted": false,
        "fills": 1, "units": ["L"], "litres": 10, "kg": 0, "kwh": 0, "litresCost": 1000, "kgCost": 0, "kwhCost": 0, "cost": 1000,
        "avgPricePerUnit": 100, "odometerKm": null, "tripKm": 0, "distanceKm": 0, "distanceSource": null,
        "kmQuantity": null, "kmCost": null, "kmPerUnit": null, "fuelCostPerKm": null, "lastFillDate": "2026-10-15" }
    ],
    "totals": { "fills": 3, "litres": 70, "kg": 0, "kwh": 0, "litresCost": 6800, "kgCost": 0, "kwhCost": 0, "cost": 6800,
                "odometerKm": 500, "tripKm": 70.5, "distanceKm": 500, "kmCost": 2000, "fuelCostPerKm": 4,
                "avgPricePerLitre": 97.14, "avgPricePerKg": null, "avgPricePerKwh": null, "kmPerLitre": 25, "kmPerKg": null, "kmPerKwh": null,
                "avgPricePerUnit": 97.14, "kmPerUnit": 25 },
    "truncated": false
  }
}
```

* `columns` lists every row field in display order, with its `type`: `text | int | decimal | money | km | percent | date
  | datetime | list`. The CSV header and the PDF table use the same list.
* `totals` sums the summable columns and recomputes ratio columns from those sums (for example cost / litres), so it never
  averages averages. Reports without totals (`service-due`) return `{}`.
* Rows are not paginated: bus-level reports have one row per bus. At most **10 000** rows are returned, and
  `truncated: true` tells you the cap was hit.
* A ratio is `null` when its divisor is 0 (no distance, no litres, no priced service).
* Times (`datetime`) are ISO instants in JSON. CSV and PDF print them in the school's timezone.

### Reports and their rows

| Report | One row per | Fields (besides `busId`, `busCode`, `registrationNo`, `busDeleted`) | Totals |
|---|---|---|---|
| `bus-distance` | bus | `busStatus`, `trips` (ran), `schoolTrips`, `nonSchoolTrips`, `activeDays`, `odometerKm`, `gpsKm`, `distanceKm`, `avgKmPerTrip`, `firstTripDate`, `lastTripDate` | sums + `avgKmPerTrip` |
| `fuel` | bus | `fuelType`, `units[]`, `fills`, `litres` / `kg` / `kwh` (+ `litresCost` / `kgCost` / `kwhCost`), `cost`, `avgPricePerUnit`, `odometerKm`, `tripKm`, `distanceKm`, `distanceSource`, `kmQuantity`, `kmCost`, `kmPerUnit`, `fuelCostPerKm`, `lastFillDate` (deleted fuel logs ignored; distance as described above) | sums + ratios, per-unit `avgPricePer{Litre,Kg,Kwh}` / `kmPer{Litre,Kg,Kwh}` |
| `maintenance` | bus | `services`, `totalCost`, `avgCost` (priced services only), `unpricedServices`, `serviceTypes[]`, `lastServiceDate`, `lastServiceType`, `nextDueDate` (earliest next due date of the latest log of each service type, regardless of range) | sums + `avgCost` |
| `cost-per-km` | bus | `odometerKm`, `tripKm`, `distanceKm`, `distanceSource`, `kmQuantity`, `kmCost`, `fuelCost`, `maintenanceCost`, `totalCost`, `fuelCostPerKm`, `maintenanceCostPerKm`, `costPerKm` (distance as described above) | sums + ratios |
| `service-due` | bus × service type | `maintenanceLogId`, `serviceType`, `status` (`overdue` \| `due_soon` \| `scheduled`), `dueBy` (`date` \| `km` \| null), `lastServiceDate`, `lastServiceOdometer`, `vendor`, `nextDueDate`, `daysToDue`, `nextDueKm`, `currentOdometer`, `kmToDue` | none |
| `non-school-usage` | non-school trip (newest first) | `tripId`, `tripDate`, `driverName`, `conductorName`, `purpose`, `status`, `startedAt`, `endedAt`, `durationMin`, `startOdometer`, `endOdometer`, `distanceKm`, `alerts` | `durationMin`, `distanceKm`, `alerts` |
| `trip-summary` | bus | `trips` (all trips of the range), `schoolTrips`, `completed`, `autoClosed`, `missed`, `cancelled`, `inProgress`, `scheduled` (school trips by status), `nonSchoolTrips`, `onTimeStarts`, `lateStarts`, `avgStartDelayMin`, `completionRatePct`, `distanceKm` (trips that ran), `alerts` (alerts linked to the bus's trips) | sums + `completionRatePct` |

* **service-due** follows the `maintenance-due-scan` rule ([alerts.md](alerts.md)). Only the latest non-deleted log per
  bus and service type (case-insensitive) counts, and only for buses in service (`active` / `maintenance`). The status
  is computed as of the school-local today:
  * `overdue`: the next due date has passed, or the bus odometer has reached the next due km.
  * `due_soon`: due within `SERVICE_DUE_LEAD_DAYS` (7) days or `SERVICE_DUE_LEAD_KM` (500) km.
  * `scheduled`: anything else.

  Rows are ordered overdue, then due soon, then scheduled; within each group the nearest due comes first.
* **trip-summary**:
  * A school trip started **on time** when it started within the school's grace minutes
    (`tripNotStartedGraceMin`, default 10) of its planned start; otherwise it was **late**.
  * `avgStartDelayMin` is the average minutes started after the planned start. Early starts count as 0.
  * `completionRatePct` = completed / (completed + auto-closed + missed). Cancelled trips are left out.

### CSV (`format=csv`)

`200 text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="fuel-report-2026-10-08_2026-10-18.csv"`
(service-due without dates: `service-due-report-<today>.csv`), `Cache-Control: no-store`. The file is streamed with a
UTF-8 BOM and CRLF rows, and starts with one header row of the column labels; datetime labels carry the timezone, e.g.
`Started (Asia/Kolkata)`.

* Numbers stay raw: no grouping, and the decimals as computed.
* Lists are joined with `; `.
* Datetimes are printed as `YYYY-MM-DD HH:mm` in the school's timezone.
* The file has no totals row.
* **Formula guard:** a text cell starting with `=`, `+`, `-`, `@`, TAB or CR gets a leading `'`. For example, the purpose
  `=HYPERLINK("…")` is written as `"'=HYPERLINK(""…"")"`.

```
Bus,Registration,Fuel type,Unit,Fills,Litres,CNG kg,kWh,Cost,Avg price / unit,Odometer km between fills,Trip km,Distance km,Distance from,Km / unit,Fuel cost / km,Last fill
R1,KA01AB1001,diesel,L,2,60,0,0,5800,96.67,500,70.5,500,odometer,25,4,2026-10-16
R2,KA01AB1002,diesel,L,1,10,0,0,1000,100,,0,0,,,,2026-10-15
```

### PDF (`format=pdf`)

`200 application/pdf`, attachment named like the CSV with `.pdf`. Landscape A4, drawn with pdfkit and the shared
paginated table (`shared/pdf.ts` `drawTable`).

* **Header:** the school's logo (when one is uploaded under the school's own storage prefix; it is converted to PNG and
  skipped if it cannot be read), then the school name, `<Title> report`, and one line with the period, bus (`All buses`
  or the bus code), generation time in the school's timezone and school code. The report's description follows.
* **Table:** column widths fit the content, and headers wrap only between words. The header row repeats on every page.
  Statuses are humanised (`due_soon` → `Due soon`) and numbers use en-IN grouping (`9,300.00`).
* **Totals:** a **Total** row is added when the report has totals.
* **Footer:** `Where Is My Bus · <school>` with `Page n of N`.
* `non-school-usage` leaves the conductor and odometer columns out of the PDF; CSV and JSON keep them.
* An empty result prints "No data for the selected filters."

## `GET /school/dashboard`

Today's operations for the school, computed for the school-local day.

```json
{
  "success": true,
  "data": {
    "localDate": "2026-10-18",
    "timezone": "Asia/Kolkata",
    "generatedAt": "2026-10-18T08:15:02.004Z",
    "buses": { "total": 5, "active": 2, "maintenance": 1, "inactive": 1, "retired": 1, "onTripNow": 2 },
    "trips": {
      "activeNow": 2,
      "today": { "total": 8, "upcoming": 2, "notStarted": 2, "inProgress": 1, "completed": 2, "autoClosed": 0, "cancelled": 1, "nonSchool": 1 }
    },
    "alerts": {
      "open": 7,
      "critical": 3,
      "byGroup": {
        "expiry": { "open": 2, "critical": 1, "recent": 3 },
        "odometer": { "open": 1, "critical": 1, "recent": 2 },
        "safety": { "open": 2, "critical": 0, "recent": 2 },
        "tripOps": { "open": 1, "critical": 0, "recent": 1 },
        "service": { "open": 1, "critical": 1, "recent": 1 }
      },
      "latest": [
        { "id": "019a…", "alertType": "doc_expired", "severity": "critical", "status": "open", "title": "Insurance of bus R1 expired on 2026-10-17",
          "busId": "019a…", "busCode": "R1", "createdAt": "2026-10-18T08:14:01.000Z" }
      ]
    },
    "documents": { "expired": 2, "expiringSoon": 3, "windowDays": 30 },
    "odometer": { "discrepancyTripsRecent": 2, "recentDays": 7 },
    "people": { "students": 4, "unassignedStudents": 3, "drivers": 2, "conductors": 1, "parents": 2 },
    "quickLinks": [
      { "key": "liveFleet", "label": "Live fleet", "path": "/school/live-fleet", "count": 2, "state": "positive" },
      { "key": "trips", "label": "Today’s trips", "path": "/school/trips?period=2026-10-18..2026-10-18", "count": 8, "state": "critical" },
      { "key": "alerts", "label": "Open alerts", "path": "/school/alerts?status=open,escalated", "count": 7, "state": "negative" },
      { "key": "buses", "label": "Buses", "path": "/school/buses", "count": 5, "state": "negative" },
      { "key": "maintenance", "label": "Service due", "path": "/school/maintenance", "count": 1, "state": "negative" },
      { "key": "students", "label": "Unassigned students", "path": "/school/students?unassigned=true", "count": 3, "state": "critical" },
      { "key": "reports", "label": "Reports", "path": "/school/reports", "count": null, "state": "none" }
    ]
  }
}
```

| Block | Meaning |
|---|---|
| `buses` | Non-deleted buses by status. `onTripNow` = buses with a trip in progress. |
| `trips.activeNow` | Trips in progress right now, whatever their date. |
| `trips.today` | Trips dated the school-local today. `notStarted` = `missed`, or still `scheduled` past planned start + the school's grace minutes (the trip-not-started rule). `upcoming` = scheduled and not yet past that point, or without a planned start. `nonSchool` counts non-school trips of any status. |
| `alerts.open` / `critical` | Unresolved alerts (`open` + `escalated`) and the critical ones among them. |
| `alerts.byGroup` | Per tile: `open` and `critical` among the unresolved alerts, and `recent` = alerts raised in the last 7 school-local days (today included), whatever their status. The tiles cover these types: `expiry` (doc_expiring, doc_expired, doc_missing), `odometer` (odometer_gap, odometer_decrease, odometer_gps_mismatch), `safety` (speeding, harsh_driving, route_deviation, long_stop), `tripOps` (trip_not_started, trip_auto_closed, gps_disabled, low_battery, no_network, non_school_trip) and `service` (service_due). |
| `alerts.latest` | The 5 most urgent unresolved alerts: critical first, then newest. |
| `documents` | Current documents in the `document-expiry-scan` scope: bus documents of buses in service, staff documents of active staff (licence scans are ignored when the profile carries a licence expiry) and the licence expiry of active drivers. `expired` = expiry before today; `expiringSoon` = expiry from today to today + 30 days. |
| `odometer.discrepancyTripsRecent` | Distinct trips with an odometer alert raised in the last 7 days. |
| `people` | Active students; `unassignedStudents` = active students without an assignment valid today in either direction. Active drivers, conductors and linked parents. |
| `quickLinks` | Web admin routes with a badge `count` and a `state` hint: `none`, `information`, `positive`, `critical` or `negative`. Date filters use `period=<from>..<to>` (school-local days); the matching API lists (`GET /school/trips`, fuel / maintenance logs, alerts, reports) accept the same `period` query next to the older `from` / `to`. The `tripOps` alert group now also counts `location_permission` and `clock_drift`. |
