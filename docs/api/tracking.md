# Live tracking API

Blueprint §9 (live tracking engine), §8.3 (live fleet, trip path), §8.6 (Socket.IO), §7.3 (jobs); contract §3,
§5, §7, §8. Base `/api/v1`. Source: `backend/src/modules/tracking/`; shared types: `backend/shared/src/schemas/tracking.ts`
(`@wimb/shared`: `locationIngestBody`, `LocationIngestResult`, `TripLiveState`, `FleetLiveResponse`,
`TripPathResponse`, `DriverTripRouteResponse`, `ParentTripStatus`).

| Method | Path | Who |
|---|---|---|
| POST | `/driver/trips/:id/locations` | driver / conductor of the trip, on the trip's start device |
| GET | `/driver/trips/:id/route` | driver / conductor of the trip (bound device) |
| GET | `/school/fleet/live` | school admin |
| GET | `/school/trips/:id/path` | school admin |

Ids of another school answer `404` everywhere; `school_id` in bodies is ignored.

## `POST /driver/trips/:id/locations` (BP §9.1)

Headers: `Authorization`, `X-Device-Id` (the device the session is bound to). Body — the compact keys of BP §9.1
(`device_id` or `deviceId`, 1–500 points) and, optionally, `sentAt` (or `sent_at`):

```json
{ "device_id": "my-phone-uid", "sentAt": "2026-10-19T07:31:10.900Z",
  "points": [ { "t": "2026-10-19T07:31:10.000Z", "lat": 12.9352, "lng": 77.6245,
                "spd": 31.2, "hdg": 270, "acc": 8, "bat": 74, "net": "4g", "mv": true } ] }
```
`200`:
```json
{ "success": true, "data": { "serverTime": "2026-10-19T07:31:11.204Z", "nextIntervalS": 10, "tripStatus": "in_progress",
                             "accepted": 1, "dropped": 0, "backfilled": 0, "clockDrift": "none", "clockOffsetMs": null } }
```
* `nextIntervalS` — the school's moving interval (≥ 10 s) while the server sees the bus moving, the stopped
  interval (default 90 s) once it is stopped; the app retunes its governor from it.
* `tripStatus` — the app stops tracking when it is no longer `in_progress` (cancelled / auto-closed / completed).
* `serverTime` — the server clock; the app measures its own clock offset from it (also in `/driver/home`, the
  start / end / active / events answers).
* `clockDrift` / `clockOffsetMs` — see **Device clock** below. `dropped` includes points rejected for the clock.

### Device clock (BP §14.3 anti-tamper — device-time vs server-time drift)

Every timestamp is put on the server clock before the rules below (`src/modules/tracking/clock.ts`). The offset
(server − device, ms) of a batch comes from, in order:

1. `sentAt` — the time the batch was sent, **on the same clock as the points' `t`**, stamped right before each
   attempt (a retry with a stale `sentAt` would look like a drift) → `serverTime − sentAt`;
2. the newest point is fresh on the server clock (≤ 60 s behind, ≤ 2 min ahead) → the clock is right (a stored
   offset is dropped: the driver fixed the clock);
3. the offset found earlier for this trip (live state) while it still fits (corrected newest point ≤ 60 s ahead);
4. running trips only: **every** point of the batch predates the trip window, or **every** point is more than
   2 min in the future — impossible with a correct clock → the newest point is taken as just recorded
   (`serverTime − newest`). Late backfill of an ended trip is never inferred.

Then: |offset| ≤ `CLOCK_DRIFT_TOLERANCE_MS` (60 s, `@wimb/shared`, same as the app) → timestamps untouched
(`clockDrift: "none"`); up to `CLOCK_DRIFT_MAX_CORRECTION_MS` (24 h) → every `t` shifted by the offset and stored
on the server clock (`"corrected"`, `clockOffsetMs` set; the offset is kept for the trip's next batches); beyond →
the batch is dropped (`"rejected"`, `accepted: 0`). The first corrected or rejected batch of a trip raises one
**`clock_drift`** alert (`warning`; `critical` when rejected; `dedupe_key clock_drift:{tripId}`, details `offsetMs`,
`action`, `source` = `sent_at` / `stored` / `inferred`, `via: "locations"`). A new driver app that already corrects its
own timestamps sends server-aligned `t` and `sentAt`, so its offset stays within the tolerance.

| Check (in order) | Error |
|---|---|
| Access token, user active | `401 UNAUTHENTICATED` |
| School active, plan valid | `403 SCHOOL_INACTIVE` |
| Role driver/conductor | `403 FORBIDDEN` |
| `X-Device-Id` = the session's device; body `device_id` (when sent) = that device | `403 DEVICE_NOT_BOUND` |
| Trip of this school | `404 NOT_FOUND` |
| Caller started the trip, or is its driver or conductor (after an admin reassigns a running trip, the phone that started it keeps sending — same rule as the trips module) | `403 FORBIDDEN` |
| Session device = `trips.device_id` (the phone that started the trip; a second phone is refused) | `403 DEVICE_NOT_BOUND` |
| Trip `in_progress` — or `completed`/`auto_closed` less than 24 h after its close (`trips.closed_at`; late backfill of points recorded up to 2 min after the close — for an auto-closed trip that includes the offline queue of the outage that caused the close, whose `ended_at` is the last fix) | `409 INVALID_STATE` `details.tripStatus` |
| Body shape | `400 VALIDATION_ERROR` |
| More than 120 requests per minute per session (only when rate limits are on) | `429 RATE_LIMITED` |

Point rules:
* **Hard 10-s floor**: a live point (newer than the newest accepted live point of the trip) is dropped when it is
  less than **9 s** (10 s minus clock jitter) after the previous accepted live point — within a batch and
  across requests. The reference survives a live-state loss (taken from `trips.last_point_at`).
* **Forward-dated fixes**: when the newest live point was recorded more than 5 s ahead of the server clock at its
  arrival (wrong device time), points recorded after that arrival still count as live, so one bogus timestamp never
  freezes the marker; `trips.last_point_at` never moves beyond the server time. A device whose clock runs ahead
  consistently keeps the 10-s floor (measured in its own time).
* **Backfill**: points older than the newest live point (offline queue) are accepted, sorted and de-duplicated
  (same timestamp twice → one), thinned with the same 9-s spacing, stored with `is_backfilled = true` (also live
  points that arrive more than 2 min after they were recorded). The floor is also enforced against the points
  **already stored**: a backfill point closer than 9 s to a stored point of the trip is dropped synchronously (so
  `accepted` / `dropped` are exact for a replayed or shifted offline queue), and the insert re-checks it under a
  per-trip advisory lock (`ON CONFLICT (trip_id, recorded_at) DO NOTHING` for exact replays) — re-sending or
  shifting a window can never add rows beyond the floor.
* Dropped (after the clock correction above): points more than 2 min in the future, more than 10 min before the
  trip start, after the end (+2 min).
* Accuracy is not a reason to drop: fixes worse than 50 m do not change the moving/stopped state, fixes worse
  than 100 m are ignored by geofences/checks/ETA and by the GPS distance.

Pipeline (BP §9.2): the request authorizes (one read-only transaction), classifies the batch and updates the live
state under a per-trip lock, queues **`points-persist`** and answers. The job inserts the batch in **one** multi-row
statement into the monthly `location_points` partitions (+ `trips.last_point_at`, `points_count`) and runs the
per-point analytics of the live points.

### Live state (`kv live:{schoolId}:{tripId}`, TTL 24 h)

Newest point, moving/stopped (median of the last 3 accurate speed samples > `movingSpeedKmh` = moving; ≤ for
`stoppedAfterS` = stopped; first fast sample → moving), freshness, route progress/deviation, current stop, visited
stops and the ETA. Public shape `TripLiveState`:

```json
{ "tripId": "…", "busId": "…", "routeId": "…", "direction": "morning", "tripStatus": "in_progress",
  "point": { "t": "…", "lat": 12.93, "lng": 77.62, "spd": 28, "hdg": 10, "acc": 6, "bat": 71, "net": "4g", "mv": true },
  "receivedAt": "…", "motion": "moving", "stoppedSince": null, "freshness": "live", "ageS": 4, "locationUnavailable": false,
  "locationPermissionDenied": false, "clockOffsetMs": null,
  "progressM": 2310, "distanceFromRouteM": 12,
  "currentStop": null, "visitedStopIds": ["…", "…"],
  "eta": { "computedAt": "…", "quality": "good", "reason": null, "speedKmh": 24.5, "destinationEtaAt": "…",
           "stops": [ { "stopId": "…", "sequence": 3, "name": "HSR Layout 27th Main", "remainingM": 940,
                        "etaAt": "…", "plannedAt": "…", "delayMin": 2.5 } ] } }
```
`freshness`: `live` while the newest point **arrived** at most 3 × the expected interval ago (30 s moving / 270 s
stopped by default), then `stale` (= "Location unavailable"); `none` before the first point. Freshness and `ageS`
are measured from `receivedAt` (the server clock), not from the point's own `t`, so a phone whose clock is wrong is
never shown as stale (BP §14.3); "Last updated" still shows `point.t`.
`locationPermissionDenied`: the app reported `location_permission_denied` (`POST /driver/trips/:id/events`) and no
fix or `location_permission_restored` came since — `locationUnavailable` is `true` at once (`live:status
location_unavailable`; parent status reason `LOCATION_PERMISSION_DENIED`). `clockOffsetMs`: the offset applied to the
trip's timestamps (school views; `null` in trip-room payloads, like battery and network).

### Per-point analytics (worker)

* **Stops**: entering a stop's `arrival_radius_m` (nearest unvisited stop) writes `trip_stop_events.arrived_at`
  (+ closest approach `distance_m`); leaving `1.25 × radius` writes `departed_at` and `dwell_s`. One row per trip and
  stop (`source = 'live'`; manual rows are never overwritten).
* **School geofence** (200 m): first exit after being inside → event `tracking.left_school`.
* **Checks** (alerts through `modules/alerts/service.ts` `raiseAlert`, deduplicated while open, `entity = trip`):

| Alert | Condition | Gate | `dedupe_key` |
|---|---|---|---|
| `speeding` | 3 consecutive fixes above `speed_limit_kmh` | `enable_speeding_alert` + feature `speeding` + limit set | `speeding:{tripId}` |
| `route_deviation` | 3 consecutive fixes farther than `route_deviation_m` from the planned polyline | `enable_route_deviation_alert` + feature `routeDeviation` | `route_deviation:{tripId}` |
| `long_stop` | stopped ≥ `stop_duration_alert_min` outside every stop geofence (×1.25) and the school | always (threshold per school) | `long_stop:{tripId}:{stoppedSinceMs}` |

### ETA v1 (BP §9.5)

Projection of the fix onto the planned polyline (`polyline_encoded`, or the straight path through the stops and
the school when none is stored) → remaining distance along the polyline to every upcoming stop ÷ an exponentially
weighted speed (time constant 3 min, floor 10 km/h, ceiling 70 km/h, 20 km/h without history) + 30 s dwell per
intermediate stop. Beyond the next stop the estimate is blended with the timetable's segment durations
(`stops.expected_time`): weight of the physical estimate 1 up to 1 km ahead, falling to 0.6 at 9 km.
Quality: `unavailable` (no ETA) for `NO_ROUTE`, `NO_POSITION`, `STALE_POSITION` (older than the freshness limit),
`LOW_ACCURACY` (> 100 m), `OFF_ROUTE` (> max(300 m, `route_deviation_m`)); `degraded` for accuracy 50–100 m or
`NO_SPEED_HISTORY`. Stops already visited, the current stop and stops passed without entering the geofence are not
listed. `delayMin` = ETA − timetable.

### ETA v2 (BP §9.5 optional; school feature `etaV2`)

In force when the school's effective `etaV2` feature is on (school flag, platform `features.eta_v2` — off by
default — and plan module `eta_v2`) **and** `GOOGLE_MAPS_SERVER_KEY` is set. The points-persist worker, after the
per-trip lock and outside any transaction (the ingest request never waits), asks the Google Routes API
(`TRAFFIC_AWARE`, DRIVE) for the drive time from the newest position through the upcoming stops (at most 25) and the
route end — at most **once every 3 minutes per trip** across instances (kv claim). The cumulative drive seconds are
cached under `eta-v2:{schoolId}:{tripId}` for 6 minutes. While that snapshot is fresh, every ETA computation keeps the
v1 quality gating, `remainingM` and stop list but sets `etaAt` = position time + drive time + 30 s dwell per stop
served before, recomputes `delayMin` and `destinationEtaAt`, and adds `"source": "v2"` to `eta` (absent for v1).
Without the key, with the feature off, or when Google fails (for example `403` while the Routes API is not enabled
on the Google project) ETA v1 stays in force and Google is asked again only after the 3-minute interval.

## Parent status (`parentStatus`, BP §9.4)

`parentStatus(trip, liveState, studentStop, { delayThresholdMin, notStartedGraceMin })` from
`modules/tracking/index.ts` (for the parent module) → `ParentTripStatus { status, reason, etaAt, etaMinutes,
plannedAt, delayMin, lastUpdatedAt, stopPassed }`:

| Status | Rule |
|---|---|
| `completed` | trip `completed` / `auto_closed` (`reason: AUTO_CLOSED`) |
| `not_started` | `scheduled`, planned start + grace not passed; `cancelled` (`reason: TRIP_CANCELLED`) |
| `delayed` | `scheduled` past planned start + grace, or `missed` (`NOT_STARTED_PAST_GRACE`); ETA to the child's stop later than its timetable + `trip_delay_threshold_min` (`ETA_LATE`) |
| `location_unavailable` | `in_progress` without a fresh point (`STALE_POSITION`, `NO_POSITION_YET`) |
| `arrived_at_stop` | the bus is inside the child's stop geofence |
| `bus_stopped` / `on_route` | `in_progress`, fresh point, stopped / moving |

The ETA is returned only when the live ETA quality is not `unavailable`. `stopPassed` = the child's stop was
visited and the bus left it.

## `GET /driver/trips/:id/route`

Planned geometry for the driver app's active-trip map (and the simulator): `{ tripId, routeId, polyline,
polylineSource, stops: [{ id, sequence, name, lat, lng, expectedTime, arrivalRadiusM }], school, live }`. Not on the
trip → `403`; another school → `404`.

## `GET /school/fleet/live` (BP §8.3, §13.3)

Every non-deleted bus of the school (one statement) with its crew, running trip, live state (kv), today's next
scheduled trip and the last known position of idle buses. `Cache-Control: no-store`.

```json
{ "generatedAt": "…",
  "summary": { "total": 6, "onTrip": 2, "moving": 1, "stopped": 0, "locationUnavailable": 1, "idle": 3 },
  "buses": [ { "busId": "…", "busCode": "R1", "displayName": null, "registrationNo": "KA01AB1234", "busStatus": "active",
               "status": "moving", "driver": { "staffId": "…", "name": "Ravi Kumar" }, "conductor": { "staffId": "…", "name": "Lakshmi Devi" },
               "activeTrip": { "id": "…", "tripType": "school", "direction": "morning", "status": "in_progress", "routeId": "…",
                               "routeCode": "R1", "routeName": "…", "startedAt": "…", "plannedStartAt": "…", "pointsCount": 214 },
               "live": { …TripLiveState }, "nextTrip": null, "lastKnown": null } ] }
```
`status`: `moving`, `stopped`, `location_unavailable`, `awaiting_location` (trip started, no point yet), `idle`,
`maintenance`, `inactive` (inactive/retired buses). Crew = the trip's crew while a trip runs, else the current
primary driver / conductor assignment. Polling fallback for the live map (≥ 10 s); the socket room
`school:{id}:fleet` carries the same `TripLiveState` in real time.

## `GET /school/trips/:id/path` (BP §8.3, §9.6)

`?includePoints=true` adds the raw points (evenly sampled to at most 5000).

```json
{ "trip": { "id": "…", "status": "completed", "tripType": "school", "direction": "morning", "tripDate": "2026-10-19",
            "busId": "…", "busCode": "R1", "routeId": "…", "routeCode": "R1", "routeName": "…", "startedAt": "…", "endedAt": "…",
            "distanceGpsKm": 10.5, "distanceOdometerKm": 10.8, "finalizedAt": "…" },
  "planned": { "polyline": "…", "polylineSource": "straight", "stops": [ { "id": "…", "sequence": 1, "name": "…", "lat": 12.9, "lng": 77.6,
                                                                            "expectedTime": "07:10:00", "arrivalRadiusM": 100 } ],
               "school": { "lat": 12.93, "lng": 77.62 } },
  "actual": { "polyline": "…", "pointCount": 412, "simplifiedPointCount": 96, "start": { "lat": …, "lng": …, "at": "…" },
              "end": { … }, "source": "finalizer" },
  "stopEvents": [ { "stopId": "…", "stopName": "…", "sequence": 1, "arrivedAt": "…", "departedAt": "…", "dwellS": 75,
                    "distanceM": 12, "source": "live" } ],
  "summary": { …trip-finalizer summary or null }, "live": null }
```
`actual.source`: `finalizer` (stored simplified path), `computed` (running or not yet finalized trips: simplified
now from the stored points), `none` (fewer than 2 usable points).

## Socket.IO (contract §7, BP §8.6)

Namespace `/rt`, `auth: { token }`; join with `join { room }` (ack `{ ok }` or `{ ok: false, error: { code } }`).

| Room | Who may join | Events |
|---|---|---|
| `school:{schoolId}:fleet` (built in) | school admins of that school | `live:position` every accepted live batch, `live:status` |
| `trip:{tripId}` (this module) | school admins of the trip's school; the trip's driver/conductor and the user who started it; parents with a linked child assigned (active on the trip date) to the trip's bus **and** direction, school trips that are scheduled/running, school active with a valid plan | `live:position` coalesced to ≥ 10 s per trip (9-s jitter tolerance), `live:status`, `trip:status` (trips module) |
| `school:{schoolId}:alerts` (built in) | school admins | `alert:new` (alerts service) |

`live:position` = `{ schoolId, tripId, busId, live: TripLiveState }`; `live:status` adds `change`
(`stop_arrived`, `stop_departed`, `location_unavailable`, `location_restored`, `eta`, `motion`) and `stopId`.
**Parent-safe payloads**: in the `trip:{tripId}` room (parents) `live.point.bat`, `live.point.net` and
`live.clockOffsetMs` are always `null` — the phone's battery and network type reach the admins through the fleet room and `GET /school/fleet/live`.

Every join re-runs the authorizer against the live session, and memberships are **re-checked after joins**:
`realtime.revalidateActors(ids)` after a narrowing change (a child moved to another bus/direction or losing its
assignment — students module; crew removed by a trip reassignment — trips module; unlinking a parent disconnects its
sockets) and a periodic sweep every 5 minutes (assignment windows that expire, any out-of-band change). A socket
that may no longer watch a room leaves it and receives **`room:revoked`** `{ room, reason: "NOT_ALLOWED" }`; a
transient authorization failure (database unreachable) keeps the membership until the next check and refuses new
joins with `503 SERVICE_UNAVAILABLE`. `child:{studentId}:live` belongs to the parent module.

## Jobs (contract §8)

| Job | Kind | What |
|---|---|---|
| `points-persist` | queue (concurrency 4, 5 attempts) | batched insert + analytics of one accepted batch (no job id: a batch re-sent after a failure is queued again; the insert is idempotent and the analytics skip points they already processed) |
| `location-gap-detector` | cron, every minute, all active schools | running trips whose newest point arrived (server clock: a forward-dated or slow-clock fix counts from its arrival) more than 3 × the expected interval ago → live state `locationUnavailable` + `live:status location_unavailable` (event `tracking.location_unavailable`); from max(5 min, that limit) one alert per trip and type: `location_permission` (critical, while the app reported the permission as denied — deduplicated into that event's alert), `low_battery` (last fix ≤ 10 %), `no_network` (last network `none`/`offline`), else `gps_disabled` — `dedupe_key {type}:{tripId}`, shared with the app's own reports (`POST /driver/trips/:id/events`). New points clear the flag (`location_restored`). |
| `trip-finalizer` | queue (the trips module queues it after end / auto-close; re-queued 2 min after late backfill) | see below |
| `partition-maintenance` | core cron (02:15 UTC + at boot) | creates the current and next 2 monthly partitions (RLS forced), drops months older than `location.retention_months` (default 12), moves DEFAULT-partition rows into new months |

**trip-finalizer** (`runTripFinalizer({ schoolId, tripId })`, idempotent, closed trips only) writes `trips.summary`,
`trips.distance_gps_km`, `finalized_at`, audits `trip.finalize`, fills `trip_stop_events` the live pass missed
(`source = 'finalizer'`, e.g. backfilled stretches; live rows only gain a missing departure), re-runs the trips
module's odometer ↔ GPS comparison (`gpsMismatchAlert`, BP §10.3 rule 3) with the final distance — late points can
change it; the dedupe key `odometer_gps_mismatch:{tripId}` keeps it to one alert per trip, announced on
`school:{id}:alerts` after commit — and removes the live state. When the trip now has a GPS distance, an open
end-time "no GPS data" flag (`odometer_gps_mismatch:{tripId}:no_gps`, trips module) is closed by the system with a
review note and audited (`alert.auto_close`). `distance_gps_km` is `null` (unknown, as in the trips module's
comparison) when fewer than 2 usable fixes exist:

```json
{ "version": 1, "computedAt": "…", "durationS": 2520, "distanceGpsKm": 10.5,
  "points": { "total": 412, "kept": 405, "outliers": 7 },
  "path": { "encoded": "…", "pointCount": 96, "toleranceDeg": 0.00005 },
  "stops": { "planned": 8, "visited": 8, "missedStopIds": [], "avgDwellS": 64, "dwell": [ { "stopId": "…", "name": "…", "sequence": 1, "arrivedAt": "…", "departedAt": "…", "dwellS": 70, "source": "live" } ] },
  "deviation": { "maxM": 85, "avgM": 9, "pointsOverThreshold": 0, "longestRunOverThreshold": 0, "thresholdM": 300 },
  "speed": { "maxKmh": 52.1, "avgMovingKmh": 24.3, "limitKmh": 40, "overSpeedPoints": 4, "overSpeedEvents": 1 },
  "dataQuality": { "sufficient": true, "reasons": [], "maxGapS": 95, "avgAccuracyM": 7 },
  "flags": ["speeding"] }
```
GPS distance: fixes worse than 100 m dropped, single-point spikes (> 150 km/h in and out) dropped, steps shorter
than max(8 m, the fixes' accuracy, capped at 30 m) ignored as jitter. Path: `ST_SimplifyPreserveTopology` (≈ 5 m).
Flags only when the school enabled the feature **and** the data is sufficient (≥ 10 fixes, no gap > 15 min,
average accuracy ≤ 50 m): `route_deviation` (≥ 3 consecutive fixes beyond the threshold), `speeding` (≥ 1 run).

**GPS distance at trip end**: the module registers its filtered track as the trips module's GPS distance
provider (`registerGpsDistanceProvider`); `gpsDistanceKm(tx, tripId)` is exported too.

## Seed data (`src/db/seeds/75_tracking.ts`)

For every completed or auto-closed school trip of seed 70 (per demo school 19 trips, about 1 600–1 900 points): a
GPS track along the planned route polyline every 15 s while moving (≈ 3 m jitter, accuracy 5–12 m, battery
draining, `4g`) with a 30–90 s dwell inside each stop geofence; the odometer↔GPS mismatch trip and the auto-closed
trip stop tracking after about half of the route; bus R2's afternoon trip two days ago has a 4-fix speeding stretch
(limit + 12 km/h) with its `speeding` alert. `points_count`, `last_point_at` and `closed_at` are set and the real
trip-finalizer runs, so every trip has `summary` (simplified path, dwell, data quality, flags), `distance_gps_km` and
`trip_stop_events`. Trips that already have points are skipped (idempotent).

## Events (in-process, after commit)

`tracking.stop_arrived`, `tracking.stop_departed`, `tracking.left_school`, `tracking.eta_updated`,
`tracking.location_unavailable`, `tracking.location_restored` (payloads with `schoolId`, see `events.ts`) — for the
notifications module (approaching stop, arrived at stop, bus left school, delayed).

## Simulator

`npx tsx scripts/simulate-trips.ts --base http://localhost:4000/api/v1 --school GWIS-BLR --drivers gwis.driver,gwis.basavaraj [--force-start] [--direction morning] [--speed 30] [--dwell 75] [--gap-s 60 | --no-gap] [--pin 1234]`
signs in seeded staff, resumes the running trip or starts the next due scheduled trip (`--force-start`: the next
startable one now), uploads a generated odometer photo through `POST /files/upload-url` → PUT → `complete`, posts
points along the planned route like the app's governor (10 s moving, 90 s once stopped at a stop), simulates one
network outage (queued points sent as backfill after the live point) and ends the trip with a higher reading.
Seed schedules run Monday–Saturday: on Sundays and holidays there is no scheduled trip to start.
