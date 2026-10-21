# Trips API (driver/conductor app + Trips & Audit)

Blueprint §8.4 (driver API), §10 (trip lifecycle and odometer validation), §11.1 (trip/odometer alerts),
§7.3 (jobs), §13.3 (Trips & Audit); contract §3, §5, §8. Base `/api/v1`. Source: `backend/src/modules/trips/`;
shared Zod schemas and DTO types: `backend/shared/src/schemas/trips.ts` (`@wimb/shared`). Alert creation API:
`backend/src/modules/alerts/service.ts` (`raiseAlert`, `announceAlerts`).

* `/driver/*` endpoints: drivers and conductors of an active school (area guard), **plus the bound device**:
  every request sends `X-Device-Id` with the `deviceId` used at `POST /auth/staff/login`
  (`403 DEVICE_NOT_BOUND` otherwise). Trip actions (`end`, `events`, `interrupt`) also require the trip to be
  bound to that device (`trips.device_id`): only the phone that started a trip can end it.
* A driver/conductor only sees **own** trips: started by them, or with them as driver/conductor. Anyone
  else's trip id — and every id of another school — answers `404 NOT_FOUND`.
* `/school/trips*`: school admins only. Ids of another school answer `404`.
* Every write is audited in the same transaction: `trip.start`, `trip.end`, `trip.interrupt`,
  `trip.device_events`, `device.update` (FCM token redacted), `trip.cancel`, `trip.correct_odometer`,
  `trip.reassign`, and for jobs `trip.generate`, `trip.not_started_check`, `trip.auto_close`.
* Odometer readings are km with one decimal (`0 … 9 999 999.9`, rounded to 0.1).

| Method | Path | Purpose |
|---|---|---|
| GET | `/driver/me` | Profile, school, current bus assignments with the routes each bus serves |
| GET | `/driver/home` | Today's morning/afternoon trips (status + start eligibility), running trip, announcements, config |
| POST | `/driver/devices` | FCM token, model, OS and app version of the bound device |
| POST | `/driver/trips/start` | Start a scheduled trip or a non-school trip (BP §10.2) |
| GET | `/driver/trips/active` | Running trip of the caller (resume after an app restart) |
| GET | `/driver/trips/history` | Own trips (`page`, `limit`, `from`, `to`, `status`) |
| POST | `/driver/trips/:id/end` | End with odometer + photo (BP §10.3) |
| POST | `/driver/trips/:id/events` | Device warnings → alerts |
| POST | `/driver/trips/:id/interrupt` | Breakdown: mark the running trip interrupted |
| GET | `/school/trips` | Trips list (filters, sort, pagination, `format=csv\|pdf`) |
| GET | `/school/trips/:id` | Detail: snapshots, odometer evidence with photo URLs, distances, flags, stop events, route |
| POST | `/school/trips/:id/cancel` | Cancel a scheduled or running trip |
| POST | `/school/trips/:id/correct-odometer` | Correct a reading (reason; original preserved) |
| POST | `/school/trips/:id/reassign` | Change driver/conductor of a scheduled or running trip |

The planned route and live state for the driver map (`GET /driver/trips/:id/route`), location ingestion
(`POST /driver/trips/:id/locations`) and the actual path (`GET /school/trips/:id/path`) belong to the tracking
module.

## Lifecycle (BP §10.1)

```
generate-daily-trips → scheduled ──start──► in_progress ──end──► completed
                          │                     │  └─ interrupt (stays in_progress until end/cancel)
                          │ not started          ├──► auto_closed  (stale-trip-closer)
                          ▼                      └──► cancelled    (school admin)
                        missed  (trip-not-started-check)        scheduled ──cancel──► cancelled
```
Non-school trips have no schedule: they are created `in_progress` by the start call (`tripType: 'non_school'`,
`purpose` required, only when `allowNonSchoolTrips`).

## Trip configuration (`TripConfig`)

Returned by `/driver/home`, `/driver/trips/active` and the start call.

```json
{ "movingIntervalS": 10, "stoppedIntervalS": 90, "movingSpeedKmh": 4, "stoppedAfterS": 60, "minIntervalS": 10,
  "latePointsWindowHours": 24, "odometerGalleryAllowed": false, "allowNonSchoolTrips": false, "allowBackupDriverStart": true,
  "odometerMismatchThresholdKm": 5, "odometerGpsVariancePct": 15, "odometerGpsMinKm": 2, "tripNotStartedGraceMin": 10,
  "staleTripCloseHours": 3, "harshDrivingEnabled": false }
```
Intervals are the school's effective values (platform defaults where the school has none); `movingIntervalS`
never goes below the 10-s floor.

## Driver trip object (`DriverTrip`)

```json
{ "id": "01a1…", "tripType": "school", "direction": "morning", "tripDate": "2026-10-19", "status": "in_progress",
  "busId": "…", "busCode": "R1", "busRegistrationNo": "KA01AB1234", "routeId": "…", "routeCode": "R1", "routeName": "Bellandur – HSR Layout",
  "driverStaffId": "…", "driverName": "Ravi Kumar", "conductorStaffId": "…", "conductorName": "Lakshmi Devi", "purpose": null,
  "plannedStartAt": "2026-10-19T01:30:00.000Z", "startedAt": "2026-10-19T01:32:10.000Z", "endedAt": null,
  "startOdometer": 48091.6, "endOdometer": null, "distanceOdometerKm": null, "distanceGpsKm": null,
  "interruptedAt": null, "cancelReason": null, "closeReason": null, "onThisDevice": true }
```
`onThisDevice`: the trip is bound to the phone making the request. Bus, route and staff names are snapshots taken
when the trip was generated/started (later renames do not change history).

## `GET /driver/home`

```json
{ "date": "2026-10-19", "serverTime": "…",
  "morning": [{ "...DriverTrip": "…", "myRole": "primary_driver", "canStart": true, "blockedReason": null }],
  "afternoon": [ … ], "other": [ /* today's non-school trips of the caller */ ],
  "activeTrip": null, "announcements": [ /* AnnouncementDto, audience drivers|all */ ],
  "config": { …TripConfig }, "buses": [ /* DriverBusAssignment */ ] }
```
Trips listed: today's (school-local) trips of every bus the caller is assigned to now, plus trips the caller
started/drives/conducts. `blockedReason`: `NOT_ASSIGNED`, `NOT_SCHEDULED`, `BACKUP_START_NOT_ALLOWED`,
`BUS_UNAVAILABLE`, `BUS_BUSY`, `ALREADY_ON_TRIP`.

`GET /driver/me` → `{ user, staff (photoUrl presigned or null), school (logoUrl), assignments: [{ busId, busCode,
busName, registrationNo, busStatus, lastKnownOdometer, role, validFrom, validTo, routes: [{ routeId, code, name,
direction }] }] }`.

## `POST /driver/trips/start`

1. Upload the odometer photo first: `POST /files/upload-url` with `category: "odometer"`, `entityType: "bus"`
   (`entityId` = the bus) or `"trip"` (the scheduled trip), `metadata: { capturedAt, latitude, longitude,
   accuracyM, source: "camera" }`, PUT the bytes, `POST /files/:id/complete`.
2. Start:

```json
{ "clientStartId": "6f1c2a9e-…", "tripId": "01a1…", "busId": "01a1…",
  "odometerReading": 48091.6, "odometerFileId": "01a1…",
  "latitude": 12.9127, "longitude": 77.674, "accuracyM": 8, "deviceTime": "2026-10-19T07:02:10.000+05:30" }
```
Non-school trip: omit `tripId`, send `"tripType": "non_school"` and `"purpose": "Service at the workshop"`.

`201` (`200` with `replayed: true` when the same `clientStartId` is sent again by the same caller for the same bus —
also for **concurrent** retries: a transaction-scoped advisory lock on the `clientStartId` is taken before the
replay lookup, so parallel retries of one start wait for the first and replay it instead of answering `409`):
```json
{ "serverTime": "2026-10-19T01:32:10.512Z", "trip": { …DriverTrip, "status": "in_progress" }, "config": { …TripConfig },
  "alerts": [{ "type": "odometer_gap", "severity": "warning", "title": "Bus R2: unexplained odometer gap of 18.4 km (possible unrecorded use)" }],
  "replayed": false }
```
`serverTime` (also in the end, active and events answers, `/driver/home` and every location batch answer) is the
server clock when the answer left: the app measures its clock offset from it (BP §14.3, tracking.md "Device clock").

Validations, all in **one transaction** (BP §10.2):

| Rule | Error |
|---|---|
| Body shape (UUIDs, reading range, coordinates, `deviceTime` ISO, `tripId` for school trips, `purpose` for non-school) | `400 VALIDATION_ERROR` |
| Caller active, school active (session/tenant checks) | `401` / `403 SCHOOL_INACTIVE` |
| `X-Device-Id` = the session's bound device | `403 DEVICE_NOT_BOUND` |
| Active staff profile | `403 FORBIDDEN` `reason: NO_STAFF_PROFILE` |
| Bus exists (else `404`) and is `active` | `409 INVALID_STATE` `reason: BUS_UNAVAILABLE` |
| Caller assigned to the bus now (`primary_driver`, `backup_driver`, `conductor`, `backup_conductor`) | `403` `reason: NOT_ASSIGNED` |
| Backup drivers only with `allowBackupDriverStart` | `403` `reason: BACKUP_START_NOT_ALLOWED` |
| School trip: exists (else `404`), belongs to `busId` (`400`, field `busId`), is `scheduled`, dated today (school-local) | `409 TRIP_ALREADY_ACTIVE` (`TRIP_IN_PROGRESS`) / `409 INVALID_STATE` (`NOT_SCHEDULED`, `NOT_TODAY`) |
| Non-school trips only with `allowNonSchoolTrips` | `403` `reason: NON_SCHOOL_TRIPS_DISABLED` |
| No other running trip for the bus / for the caller | `409 TRIP_ALREADY_ACTIVE` `reason: BUS_BUSY` / `ALREADY_ON_TRIP` (+ `tripId`) |
| Photo: uploaded `odometer` file of this school, uploaded by the caller, attached to this bus or trip, never used before, `source: camera` unless `odometerGalleryAllowed` | `400` field `odometerFileId` |
| `clientStartId` reused for another bus/trip/caller | `409 CONFLICT` `reason: CLIENT_START_ID_REUSED` |

Recorded: server start time, device time, coordinates, reading, the device (`trips.device_id`), the starter
(`started_by`); evidence row (`trip_odometer_evidence` kind `start`) with the file's SHA-256, capture time/GPS
and source. Who drives: a driver who starts becomes `driverStaffId` (backup drivers included); a conductor who
starts becomes `conductorStaffId` and the planned driver stays (cleared when that driver is on another running
trip).

Start-time odometer flags (BP §10.2 rule 4 / §10.3 rule 4) — the trip still starts:

| Condition | Alert | Severity |
|---|---|---|
| reading < previous closed trip's end, < `buses.last_known_odometer`, or < the highest reading recorded on another started trip of the bus (start or end reading of running / completed / auto-closed trips — an auto-closed trip has no end reading; cancelled trips are not a baseline because their readings cannot be corrected) | `odometer_decrease` (`odometer_decrease:{tripId}:start`, details `highestRecordedOdometer`, `highestRecordedTripId`) | critical |
| reading − previous end > `odometerMismatchThresholdKm` | `odometer_gap` (`odometer_gap:{tripId}`) | warning; critical above 4 × threshold |

## `POST /driver/trips/:id/end`

```json
{ "odometerReading": 48102.4, "odometerFileId": "01a1…", "latitude": 12.9338, "longitude": 77.6228, "accuracyM": 6,
  "deviceTime": "2026-10-19T07:48:02.000+05:30", "pendingPoints": 3 }
```
`200`:
```json
{ "serverTime": "…", "trip": { …DriverTrip, "status": "completed", "endOdometer": 48102.4, "distanceOdometerKm": 10.8, "distanceGpsKm": 10.5 },
  "alerts": [], "acceptPointsUntil": "2026-10-20T02:18:02.000Z", "replayed": false }
```

| Rule (BP §10.3) | Result |
|---|---|
| Trip of the caller (else `404`), `in_progress` (else `409 INVALID_STATE` `NOT_IN_PROGRESS`), started on this device | `403 DEVICE_NOT_BOUND` |
| end < start | `422 ODOMETER_INVALID` `{ startOdometer, endOdometer }` (hard reject, trip unchanged) |
| Live camera photo (same checks as the start, attached to the trip or its bus) | `400` field `odometerFileId` |
| `distanceOdometerKm = end − start`; `distanceGpsKm` from the trip's location points (null with fewer than 2 usable points) | stored |
| `\|odo − gps\| / max(odo, gps) > odometerGpsVariancePct` **and** `\|odo − gps\| ≥ odometerGpsMinKm` | `odometer_gps_mismatch` (warning, `odometer_gps_mismatch:{tripId}`) |
| No usable GPS data (fewer than 2 points — GPS kept off) and `odo ≥ odometerGpsMinKm` | `odometer_gps_mismatch` (warning, `odometer_gps_mismatch:{tripId}:no_gps`, details `{ reason: "no_gps_data", odometerKm, gpsKm: null, gpsPoints, pendingPoints }`); the trip-finalizer closes it (audited `alert.auto_close`) when late points later give the trip a GPS distance, and then runs the regular comparison |
| end < `buses.last_known_odometer` | `odometer_decrease` (critical, `…:end`) |
| Non-school trip | `non_school_trip` (info feed) |
| Then | `buses.last_known_odometer = end`, status `completed`, `trip-finalizer` queued after commit |

Retrying with the same reading and photo returns the completed trip (`replayed: true`); a different end of a
completed trip is `409`. The end is accepted even if the final location batch failed: points of the trip are
accepted for 24 h after the close (`acceptPointsUntil`, tracking ingestion). Every close of a running trip
(end, auto-close, cancellation while running) records `trips.closed_at` (migration 500): for an auto-closed trip
`ended_at` is its last fix, `closed_at` the moment stale-trip-closer closed it — late points and the 24-h window
use `closed_at`.

GPS distance: the default provider sums PostGIS segment lengths between consecutive points of the trip,
ignoring points with accuracy worse than 100 m and segments implying more than 150 km/h; the tracking module
replaces it (`registerGpsDistanceProvider`) with its filtered track. The trip-finalizer can re-run the
comparison once late points arrived (`gpsMismatchAlert`, same dedupe key → one alert per trip).

## Other driver endpoints

* `GET /driver/trips/active` → `{ serverTime, trip: DriverTrip | null, config }` — the caller's running trip, also when it
  is bound to another phone (`onThisDevice: false`, the app then shows "running on another phone").
* `GET /driver/trips/history?page=&limit=&from=&to=&status=` → list of `DriverTrip` (own trips, newest first;
  `scheduled` trips only when `status` asks for them).
* `POST /driver/trips/:id/events` — the app reports warnings, batched (1–50) while offline:
  ```json
  { "sentAt": "…",
    "events": [{ "type": "low_battery", "occurredAt": "…", "batteryPct": 12 },
               { "type": "gps_disabled", "occurredAt": "…", "latitude": 12.93, "longitude": 77.62 },
               { "type": "location_permission_denied", "occurredAt": "…", "permission": "denied_forever" }] }
  ```
  `type`: `gps_disabled` → `gps_disabled` alert, `low_battery` → `low_battery`, `no_network` → `no_network`
  (warning), `mock_location` → critical `gps_disabled` ("mock location detected"), `trip_interrupted` → the
  interrupt action (`message` = reason). `harsh_braking` / `harsh_acceleration` / `harsh_cornering` (phone motion
  sensors; optional `gForce` 0–8 and `speedKmh` 0–250) → `harsh_driving` warning ("Bus R1: harsh braking (0.62 g)")
  only while `config.harshDrivingEnabled` is true (school `enableHarshDrivingAlert` **and** effective feature
  `harshDriving`: platform `features.harsh_driving`, off by default, and plan module `harsh_driving`); otherwise
  they are accepted and audited without an alert (and not kept in the timeline). One open alert per trip and type
  (`{type}:{tripId}`). Accepted while the trip runs and for 24 h after it ended.
  * **Location permission** (its own fault, not `gps_disabled`): `location_permission_denied` (optional
    `permission`: `denied`, `denied_forever`, `while_in_use` — background tracking impossible —, `always`) → a
    **critical `location_permission`** alert ("Bus R1: location permission denied on the driver's phone — tracking
    stopped", `dedupe_key location_permission:{tripId}`) and, for a running trip, "Location unavailable" at once
    (live state `locationPermissionDenied`, `live:status location_unavailable`, parent status reason
    `LOCATION_PERMISSION_DENIED`; the gap detector later deduplicates into the same alert).
    `location_permission_restored` → that alert is closed by the system (audited `alert.auto_close`, `alert:updated`
    action `resolve`) and the live flag is cleared; the next fix clears "Location unavailable". Events of one batch
    are applied in time order (a denied + restored pair queued offline raises and closes the alert).
  * **`clock_drift`** (optional `clockOffsetMs`, the app's measured server − device offset) → `clock_drift` alert
    (warning; `critical` beyond 24 h; `dedupe_key clock_drift:{tripId}`, shared with the location ingestion).
  * **Device clock** (BP §14.3): `sentAt` = when the batch was sent, on the same clock as `occurredAt` (stamped right
    before each attempt). Offset beyond 60 s (up to 24 h) → every `occurredAt` is shifted onto the server clock and a
    `clock_drift` alert is raised; beyond 24 h — or, without `sentAt`, an `occurredAt` more than 2 min in the future —
    the receipt time replaces the device time (`details.deviceTimeRejected`). Without `sentAt`, a running trip whose
    whole batch predates the trip window (or lies in the future) is corrected from its newest event, like points.
  * Every kept event is stored in `trip_device_events` (migration 925) for the trip **timeline**.
  `200 { serverTime, accepted, clockOffsetMs, alerts: [{ type, severity, title }] }` (`clockOffsetMs`: the offset applied
  to this batch, else `null`).
* `POST /driver/trips/:id/interrupt` `{ "reason": "Engine overheating", "latitude"?, "longitude"? }` → the trip
  stays `in_progress` with `interruptedAt` + `closeReason`; event `trip.interrupted` (parents may be notified) and
  `trip:status` with `interrupted: true`. End it normally or the school cancels it.
* `POST /driver/devices` `{ "fcmToken"?: string|null, "platform"?, "model"?, "osVersion"?, "appVersion"? }` →
  `{ id, deviceId, platform, model, osVersion, appVersion, hasFcmToken, lastSeenAt }` for the bound device
  (`fcmToken: null` clears it). The token never appears in responses or audit logs.

## `GET /school/trips`

Query: `page`, `limit`, `sort` (`tripDate`, `plannedStartAt`, `startedAt`, `endedAt`, `status`, `busCode`,
`routeCode`, `driverName`, `distanceOdometerKm`, `distanceGpsKm`, `createdAt`; default `-tripDate,plannedStartAt`),
`period=<from>..<to>` (trip date, inclusive; `YYYY-MM-DD..YYYY-MM-DD`, one day `YYYY-MM-DD`, or an open end
`2026-10-01..` — the format of the web filter and of the dashboard quick link) or the older `from`/`to` (explicit
`from`/`to` win over `period`; a malformed period is `400` on `query.period`), `busId`, `routeId`, `driverId`, `conductorId` (staff ids), `type`
(`school,non_school`), `status` (comma list), `direction`, `flagged` (true = with alerts), `q` (bus, registration,
route, driver, conductor, purpose), `format=csv` (all matching rows up to 10 000, UTC timestamps) or `format=pdf`
(`trips.pdf`, landscape A4, same filters and rows: date, type/direction, status, bus, route or purpose, crew,
started/ended in the school's timezone, odometer km (`*` = corrected), GPS km, alert types; page numbers).

Item (`TripListItem`): the `DriverTrip` fields without `onThisDevice`, plus `odometerCorrected`, `interrupted`,
`alertCount`, `openAlertCount`, `alertTypes`.

## `GET /school/trips/:id` (`TripDetail`)

List fields plus `scheduleId`, `startDeviceTime`, `endDeviceTime`, `start`/`end` coordinates, `deviceId`,
`startedBy`/`endedBy`/`cancelledBy` (`{ id, name }`), `cancelReason`, `closeReason`, `interruptedAt`, `lastPointAt`,
`pointsCount`, `odometerCorrection`, `summary`/`finalizedAt` (trip-finalizer), and:

```json
"evidence": [{ "id": "…", "kind": "start", "reading": 48091.6, "fileId": "…", "photoUrl": "https://…signed…", "thumbnailUrl": null,
               "capturedAt": "…", "receivedAt": "…", "latitude": 12.9127, "longitude": 77.674, "accuracyM": 6,
               "sha256": "9f86…", "source": "camera", "deviceId": "…", "recordedBy": "…", "recordedByName": "Ravi Kumar" }],
"flags": [{ "id": "…", "type": "odometer_gap", "severity": "warning", "status": "open", "title": "…", "createdAt": "…" }],
"stopEvents": [{ "stopId": "…", "stopName": "Agara Lake", "sequence": 4, "expectedTime": "07:15", "arrivedAt": "…", "departedAt": "…", "dwellS": 45, "distanceM": 18, "source": "live" }],
"route": { "id": "…", "code": "R1", "name": "…", "direction": "morning", "polyline": "…", "polylineSource": "straight", "stops": [ …StopDto ] }
```
Evidence photo URLs are presigned GETs (≤ 300 s) of the original files, side by side for start and end.

`timeline` (`TripTimelineEntry[]`, oldest first; lifecycle first on equal times) — the trip lifecycle merged with every
device event the app reported (`trip_device_events`, migration 925); stop arrivals stay in `stopEvents`:

```json
"timeline": [
  { "at": "…", "kind": "trip_started", "event": null, "severity": "info", "title": "Trip started", "note": null, … },
  { "at": "…", "kind": "device_event", "event": "location_permission_denied", "severity": "critical",
    "title": "Location permission denied — tracking stopped", "note": null, "deviceOccurredAt": "…", "receivedAt": "…",
    "clockOffsetMs": null, "latitude": 12.93, "longitude": 77.62, "batteryPct": null, "permission": "denied", "alertId": "…" },
  { "at": "…", "kind": "device_event", "event": "location_permission_restored", "severity": "info", "title": "Location permission restored", … },
  { "at": "…", "kind": "trip_interrupted", "event": null, "severity": "critical", "title": "Trip interrupted (breakdown)", "note": "Flat tyre", … },
  { "at": "…", "kind": "trip_ended", "event": null, "severity": "info", "title": "Trip ended", … } ]
```
`kind`: `trip_started`, `trip_interrupted` (note = reason), `trip_ended`, `trip_auto_closed`, `trip_cancelled` (note =
cancel reason), `device_event` (`event` = the `DEVICE_EVENT_TYPES` value). Device event times are on the server clock
(`clockOffsetMs` = correction applied, `deviceOccurredAt` = what the phone sent). `alertId` = the alert the event raised
or was deduplicated into. Coordinates of device events are cleared with the location history at the school's
retention cutoff (the event stays).

## Admin actions

All return the updated `TripDetail`.

* `POST /school/trips/:id/cancel` `{ "reason": "Bus breakdown" }` — `scheduled` or `in_progress` only (a running
  trip gets `endedAt`; the app learns it from the next location response / `trip:status`). Otherwise `409`.
* `POST /school/trips/:id/correct-odometer` `{ "kind": "start" | "end", "reading": 48102.4, "reason": "Driver typed an extra digit" }`
  — `start` for running/closed trips, `end` for `completed`/`auto_closed` (enter the missing end reading of an
  auto-closed trip). The driver's readings stay in `odometerCorrection.original` and the evidence rows are never
  changed; each correction is appended to `odometerCorrection.history` (`kind, from, to, reason, by, byName, at`).
  `distanceOdometerKm` is recomputed; an end correction of the bus's latest closed trip also updates
  `buses.last_known_odometer`; the GPS comparison runs again. end < start → `422 ODOMETER_INVALID`; same value →
  `400`.
* `POST /school/trips/:id/reassign` `{ "driverId"?: uuid|null, "conductorId"?: uuid|null, "reason": "…" }` —
  `scheduled` or `in_progress`; staff must exist (`404`), have the right type (`400`), be active (`409`) and, for a
  running trip, not be on another running trip (`409 TRIP_ALREADY_ACTIVE` `STAFF_BUSY`). A running trip keeps a
  driver. Name snapshots follow; the trip stays bound to the device that started it: the user who started it keeps
  sending locations, ending it and watching `trip:{tripId}` from that phone (ingestion and the socket room accept
  the starter like the driver/conductor). Crew members removed by the reassignment (and who did not start the trip)
  have their `trip:{tripId}` membership re-checked after commit and receive `room:revoked`.

## Jobs (contract §8)

All are school-cron jobs (the dispatcher runs them per active school in the school's timezone); handlers are
exported from `src/modules/trips/jobs.ts`.

| Job | Schedule (school-local) | What it does |
|---|---|---|
| `generate-daily-trips` | `5 0 * * *` | One `scheduled` trip per active, non-deleted schedule running that date (ISO weekday, inclusive validity) with an `active` bus and an active route; skipped on holidays (`all` or the direction). Snapshots of bus, route, driver and conductor (assignments valid at the planned start); `plannedStartAt = (date + planned_start_time) AT TIME ZONE school.timezone`. `ON CONFLICT (schedule_id, trip_date) DO NOTHING` (idempotent; a cancelled trip is never re-created). |
| `trip-not-started-check` | every minute | Scheduled trips on a holiday added after generation → `cancelled` ("School holiday: …"). Planned start + `tripNotStartedGraceMin` passed (within 24 h) → `trip_not_started` alert once per trip and event `trip.not_started` when `notifyTripNotStarted`. Planned start + max(180, grace + 30) min passed, or an earlier date → `missed`. |
| `stale-trip-closer` | every 5 minutes | Running trips whose last point (or start) is older than `staleTripCloseHours` → `auto_closed` (`endedAt` = last point or start, `closedAt` = now), GPS distance stored, `trip_auto_closed` alert, `trip-finalizer` queued. |

## Events and realtime

* In-process (`shared/events`, after commit): `trip.status_changed` `{ schoolId, tripId, busId, routeId, tripType,
  direction, tripDate, status, previousStatus, interrupted, at, reason }` (start, end, cancel, missed, auto-close,
  holiday cancellation), `trip.not_started`, `trip.interrupted`, `trip.reassigned`, `trip.location_permission`
  `{ schoolId, tripId, state: denied | restored, at }` (tracking live state), `alert.raised` (every new alert).
* Socket.IO: `trip:status` `{ tripId, busId, status, previousStatus, interrupted, at, reason }` to
  `school:{schoolId}:fleet` and `trip:{tripId}`; `alert:new` `{ id, type, severity, title, tripId, busId, entityType,
  entityId, createdAt }` to `school:{schoolId}:alerts`.
* Jobs: `trip-finalizer` `{ schoolId, tripId }` (job id `trip-finalizer-{tripId}`) after an end or auto-close
  (defined by the tracking module, registered in `JOB_DEFINITIONS`).

## Seed data (`src/db/seeds/70_trips.ts`)

Per demo school: the last five school days of trips generated from the schedules (buses R1/R2, morning and
afternoon), completed with continuous readings ending at each bus's last known odometer, start/end evidence
photos (rendered JPEGs in the storage driver), GPS distances, and the anomalies R2 morning 3 days ago
(`odometer_gap`), R1 morning 2 days ago (`odometer_gps_mismatch`), R1 afternoon 4 days ago (`auto_closed`,
`trip_auto_closed`), R2 afternoon yesterday (`missed`, `trip_not_started`), and a non-school trip of R1 yesterday
evening (`non_school_trip`). Today's trips are generated as well. History is only added to schools without
closed trips, so re-running the seed changes nothing. Seed `75_tracking` adds the location history of these trips
(see [tracking.md](tracking.md#seed-data-srcdbseeds75_trackingts)).
