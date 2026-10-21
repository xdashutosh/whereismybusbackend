# Parent API

Blueprint §4.6 (parent across schools), §8.5 (parent catalogue), §9.3/§9.4/§9.5 (parent live data, status,
ETA), §11.2 (notifications), §13.3 (visibility matrix), §15 (parent app), Appendix B; contract §4, §7, §9
(in-app inbox). Base `/api/v1`. Source: `backend/src/modules/parent/`; shared types:
`backend/shared/src/schemas/parent.ts` (`@wimb/shared`: `ParentChildrenResponse`, `ParentTrackingSnapshot`,
`ParentBusDetails`, `ParentStaffResponse`, `NotificationPreferencesDto`, `notificationPreferencesBody`,
`parentDeviceBody`, `ParentDeviceDto`, `parentNotificationsQuery`, `ParentNotificationDto`, `ChildLiveEvent`,
`PARENT_SOCKET_EVENTS`).

| Method | Path | `X-School-Id` | Purpose |
|---|---|---|---|
| GET | `/parent/children` | — | every linked child, grouped by school |
| GET | `/parent/children/:studentId/tracking` | required | live snapshot for the Track Bus map |
| GET | `/parent/children/:studentId/bus` | required | bus details filtered by the visibility matrix |
| GET | `/parent/children/:studentId/staff` | required | driver/conductor cards filtered by the matrix |
| GET | `/parent/files/:fileId/url` | required | short-lived URL of a file the parent may see |
| GET / PUT | `/parent/children/:studentId/notification-preferences` | required | per-direction toggles |
| POST | `/parent/devices` | — | register the phone and its FCM token |
| GET | `/parent/notifications` | — | in-app inbox (all schools) |
| POST | `/parent/notifications/:id/read` | — | mark one as read |
| POST | `/parent/notifications/read-all` | — | mark every unread one as read |
| Socket | `child:{studentId}:live` | — | live feed of the child's bus (`child:live` events) |
| GET | `/parent/consent` | — | consent state per school (privacy module, [privacy.md](privacy.md)) |
| POST | `/parent/consent` | required | accept the school's current consent version ([privacy.md](privacy.md)) |

## Access rules (BP §4.6, §15.3, Appendix B)

* Every `/parent/*` call needs a parent access token (`401` without one, `403 FORBIDDEN` for any other role).
* **Per-child calls carry `X-School-Id`.** The server accepts it only when the parent has an **active link** in
  that school (`parent_children_index()`: active parent account, active school profile, active student, school
  not deleted), then checks that the school is active and within its plan, and runs the request in that school's
  tenant context as role `parent` (RLS + the restrictive `parent_scope` policies).
  * Missing or malformed header → `400 VALIDATION_ERROR`.
  * A school without an active link → `403 FORBIDDEN`. A suspended or deactivated school → `403 SCHOOL_INACTIVE`.
* A student who is not linked to the caller **in that school** — another parent's child, a child of another school
  sent with this school's header, an unknown id — answers `404 NOT_FOUND`. Existence is never revealed.
* Tracking, bus and staff need a **current assignment** of the child (school-local today; `valid_to` exclusive).
  * Without one: `404 NOT_FOUND` with `details.reason = "NO_ASSIGNMENT"`. The child stays on the home list without
    directions.
  * Every call reads the assignment afresh, so a reassignment moves access **immediately**: the next call shows the
    new bus, and the old bus's data and files are refused.
* Parents are strictly read-only on school data. Their only writes are their own notification preferences, their
  devices and inbox read markers. Each write is audited (actor = the parent).
* Responses are DTOs only. They never carry raw rows, internal ids of other children, battery/network data,
  licence numbers, addresses or identity documents (BP §7.2, §16).

## `GET /parent/children`

No `X-School-Id`: the list spans every school with an active link. Each school is read in the parent's own
tenant context. Schools that are suspended, deleted or outside their plan are left out (every per-child call
would be refused for them). Schools are sorted by name, children by name, directions morning first.

```json
{ "success": true, "data": {
  "generatedAt": "2026-10-19T02:01:10.000Z",
  "schools": [ {
    "schoolId": "…", "schoolName": "Greenwood International School", "institutionType": "school",
    "logoUrl": "https://…signed…", "brandColor": "#0070F2", "timezone": "Asia/Kolkata",
    "children": [ {
      "studentId": "…", "fullName": "Aarav Sharma", "className": "5", "section": "A", "photoUrl": null,
      "directions": [ {
        "direction": "morning", "busId": "…", "busCode": "R1", "routeId": "…", "routeCode": "R1", "routeName": "Route 1",
        "stop": { "id": "…", "name": "HSR Layout BDA Complex", "sequence": 3, "lat": 12.9116, "lng": 77.6474, "expectedTime": "07:25:00" },
        "nextAt": "2026-10-19T01:55:00.000Z", "nextDate": "2026-10-19",
        "trip": { "id": "…", "status": "in_progress", "plannedStartAt": "…", "startedAt": "…", "endedAt": null },
        "status": "on_route", "phase": "running", "phaseReason": null
      } ]
    } ]
  } ] } }
```

* `directions` lists the child's **current** assignments. It is empty when no bus is assigned (the "no bus
  assigned" empty state).
* `trip` is today's school trip of that bus and direction: the running one first, else the next scheduled one,
  else the latest. It is `null` when none was generated (holiday, no schedule). `status` is the BP §9.4 status for
  the child's stop (see below), or `null` without a trip. `phase` / `phaseReason`: the trip phase (see below;
  `no_trip` without a trip) — e.g. a card "Trip interrupted: Flat tyre".
* `nextAt` / `nextDate` give the next pickup (morning) or drop (afternoon) at the child's stop:
  * while today's trip is `scheduled`/`in_progress`: the stop's timetable instant today, else the trip's planned
    start;
  * otherwise: the next day (within 14 days) served by an active schedule of the bus in that direction, skipping
    school holidays that cover the direction, at the stop's expected time (else the schedule's start time).
* `logoUrl` / `photoUrl` are presigned GETs (300 s).

## `GET /parent/children/:studentId/tracking`

Query: `direction` = `morning` | `afternoon` (optional). Without it, the server picks the direction that matters
now: the running trip, else today's next open trip, else the earliest upcoming pickup/drop, else morning.

```json
{ "success": true, "data": {
  "serverTime": "2026-10-19T02:01:10.000Z",
  "studentId": "…", "firstName": "Aarav",
  "school": { "id": "…", "name": "Greenwood International School", "lat": 12.9337, "lng": 77.6227 },
  "direction": "morning",
  "bus": { "id": "…", "code": "R1" },
  "route": { "id": "…", "code": "R1", "name": "Route 1" },
  "stop": { "id": "…", "name": "HSR Layout BDA Complex", "sequence": 3, "lat": 12.9116, "lng": 77.6474, "expectedTime": "07:25:00", "arrivalRadiusM": 100 },
  "trip": { "id": "…", "status": "in_progress", "tripDate": "2026-10-19", "plannedStartAt": "…", "startedAt": "…", "endedAt": null },
  "status": { "status": "on_route", "reason": null, "etaAt": "2026-10-19T02:05:52.000Z", "etaMinutes": 5,
              "plannedAt": "2026-10-19T01:55:00.000Z", "delayMin": 11, "lastUpdatedAt": "2026-10-19T02:01:02.000Z", "stopPassed": false,
              "phase": "running", "phaseReason": null, "interruptedAt": null },
  "position": { "lat": 12.9203, "lng": 77.6391, "hdg": 140, "spd": 28.5, "t": "2026-10-19T02:01:02.000Z" },
  "motion": "moving", "freshness": "live", "lastUpdatedAt": "2026-10-19T02:01:02.000Z",
  "eta": { "quality": "good",
           "childStop": { "stopId": "…", "sequence": 3, "name": "HSR Layout BDA Complex", "remainingM": 1333, "etaAt": "…", "plannedAt": "…", "delayMin": 11 },
           "nextStop":  { "stopId": "…", "sequence": 2, "name": "Agara Lake", "remainingM": 333, "etaAt": "…", "plannedAt": "…", "delayMin": 9 },
           "destinationEtaAt": "…" },
  "planned": { "polyline": "…encoded…", "polylineSource": "straight",
               "stops": [ { "id": "…", "sequence": 1, "name": "…", "lat": 12.9, "lng": 77.6 } ] },
  "room": "child:…:live",
  "pollAfterS": 10 } }
```

* `status` is tracking's `parentStatus()` for **this child's stop** (BP §9.4), with the school's
  `trip_delay_threshold_min` and `trip_not_started_grace_min`:

  | `status.status` | When | `reason` |
  |---|---|---|
  | `not_started` | trip scheduled, within the grace period; trip cancelled; no trip today | `null` · `TRIP_CANCELLED` · `NO_TRIP_TODAY` |
  | `delayed` | not started past the grace period (or `missed`); running with the ETA to the child's stop later than the threshold | `NOT_STARTED_PAST_GRACE` · `ETA_LATE` |
  | `on_route` / `bus_stopped` | running with a live fix, moving / stopped | `null` |
  | `arrived_at_stop` | the bus is inside the child's stop radius | `null` |
  | `bus_stopped` (interrupted) | the driver marked the running trip interrupted (breakdown, BP §10.4); `status.interrupted: true`, no ETA | `TRIP_INTERRUPTED` |
  | `location_unavailable` | running, but the driver app lost the location permission (it reported `location_permission_denied`); no fix yet; or the newest fix **arrived** longer ago than the staleness threshold (server clock — a wrong phone clock does not count) or the gap detector flagged the trip | `LOCATION_PERMISSION_DENIED` · `NO_POSITION_YET` · `STALE_POSITION` |
  | `completed` | trip completed / auto-closed | `null` · `AUTO_CLOSED` |

* `status.phase` — the trip **phase**, independent of the live picture:

  | `phase` | When | `phaseReason` |
  |---|---|---|
  | `no_trip` | no trip today for this bus and direction (holiday, no schedule) | `null` |
  | `scheduled` | today's trip has not started | `null` |
  | `running` | the trip is in progress | `null` |
  | `interrupted` | in progress, but the driver reported a breakdown (`POST /driver/trips/:id/interrupt` or the `trip_interrupted` device event); `status.interruptedAt` = when | the driver's reason, as entered |
  | `completed` | completed or auto-closed | `null` |
  | `cancelled` | the school cancelled it (before or during the run) | the school's cancel reason |
  | `missed` | never started | `null` |

  `phaseReason` is the reason text as the driver / school entered it, trimmed to 200 characters (the driver app should
  say that parents of the bus see it). The same fields are in every `child:live` event's `status`. A parent is also
  notified of an interruption / cancellation (`trip_interrupted` / `trip_cancelled`, per-child and per-direction
  toggles in the notification preferences, default on — see notifications.md).
* `position` is the newest **received** fix (never interpolated, no battery/network). It stays visible while
  the status is `location_unavailable` with a stale fix ("Last updated" shows its age), and is `null` once the
  trip is no longer running (a completed trip never shows its last position).
* `freshness` is `live` | `stale` | `none`; `lastUpdatedAt` is the fix time.
* `eta` is quality-gated (BP §9.5): `quality: 'unavailable'` carries no times. `childStop` is `null` once the bus
  has passed the child's stop. `nextStop` is the next stop of the route.
* `planned.polyline` is the route's stored encoded polyline (`polylineSource` `google` or `straight`). A route
  without a stored polyline gets the flagged straight line through its stops and the school
  (`polylineSource: 'straight'`); it switches to Google automatically once the routes module stores one.
* `school.lat/lng` and `stop` are the map markers. `room` is the socket room to join; `pollAfterS` is the polling
  fallback interval (10 s while a trip runs and the bus moves, 60 s otherwise).
* `404 NOT_FOUND` + `details.reason = "NO_ASSIGNMENT"` when the child has no current assignment (in the requested
  direction).

## `GET /parent/children/:studentId/bus`

Query: `direction` (optional, same default as tracking). The bus of the child's current assignment, built by the
buses module's `parentBusView()` from `school_settings.parent_visibility.bus` (BP §13.3).

```json
{ "success": true, "data": {
  "school": { "id": "…", "name": "Greenwood International School" },
  "studentId": "…", "direction": "morning",
  "bus": { "id": "…", "code": "R1", "displayName": "Route 1 Bus", "vehicleType": "bus", "makeModel": "Tata Starbus",
           "color": "Yellow", "capacity": null, "registrationNo": "KA 01 AB 1234",
           "images": [ { "fileId": "…", "caption": "Front", "url": "https://…signed…", "thumbnailUrl": "https://…signed…" } ],
           "documents": [ { "docType": "insurance", "title": "Insurance", "expiryDate": "2027-03-31", "expiryStatus": "valid", "fileId": null } ] },
  "route": { "id": "…", "code": "R1", "name": "Route 1" } } }
```

| Matrix flag (`bus.*`) | Default | Effect |
|---|---|---|
| `capacity` | off | `capacity` is `null` when off |
| `plate` | on | `registrationNo` is `null` when off |
| `images` | on | `images` is empty when off |
| `insurance_status` / `fitness_status` | on | the document's validity is listed (also needs the document's own `visible_to_parents_status`) |
| `insurance_file` / `fitness_file` | off | `fileId` is set (also needs the document's own `visible_to_parents_file`) |

Other document types follow the document's own flags alone. Only **current, verified** documents are ever listed
(pending, rejected and replaced versions are left out). Never returned: internal notes and anything outside this
DTO (operational status, odometer readings, maintenance and fuel data).

## `GET /parent/children/:studentId/staff`

Query: `direction` (optional). Without it, one entry per distinct bus of the child's current assignments; with it,
only that direction's bus. Cards come from the staff module's `parentStaffForBus()`: staff currently assigned to
the bus, primary driver first, then conductor, then backups.

```json
{ "success": true, "data": {
  "school": { "id": "…", "name": "Greenwood International School" }, "studentId": "…",
  "buses": [ { "busId": "…", "busCode": "R1", "direction": "morning", "staff": [
    { "id": "…", "role": "primary_driver", "staffType": "driver", "fullName": "Ramesh Kumar",
      "photo": { "fileId": "…", "url": "https://…signed…", "thumbnailUrl": "https://…signed…" },
      "phone": null, "email": null,
      "experience": { "years": 12, "summary": "…", "joiningDate": "2019-06-01" },
      "licence": { "expiryDate": "2029-01-31", "expiryStatus": "valid", "verificationStatus": "verified" },
      "verification": { "identity": "verified", "policeVerification": "verified" }, "documents": [] } ] } ] } }
```

The matrix sections `driver` / `conductor` decide each field (`photo`, `phone`, `email`, `experience`,
`licenceValidity`, `licenceFile`, `verification`, `characterCertStatus`, `training`, …). Never returned: address,
emergency contacts, identity numbers or documents, licence numbers, login details. A document's validity and file
reach parents only when it is current and verified.

## `GET /parent/files/:fileId/url`

Query: `variant` = `original` | `thumbnail`, `ttl` = 60–300 s (default 120), `disposition` = `inline` |
`attachment` (same as `GET /files/:id/url`). Answer: `{ url, expiresAt, contentType, fileName, variant }`.

A parent reads a file only through a category `parentRead` hook, which applies the visibility matrix **and**
checks that the file belongs to the child's current bus or its assigned staff. The `files` parent RLS policy is
the backstop. Anything else answers `404 NOT_FOUND` (existence is never revealed).

| Category | Readable when |
|---|---|
| `bus_image` | the image belongs to a bus a linked child is currently assigned to, and `bus.images` is on |
| `bus_document` | that bus's current verified document with the school file flag (insurance/fitness) and the document's own file flag |
| `staff_photo` | staff currently assigned to that bus, and the `photo` flag of their staff type is on |
| `staff_document` | a current verified, non-identity document of that staff whose matrix and document file flags allow it |
| `student_photo` | the photo of one of the caller's own linked children |
| `school_logo` | the logo of the school in `X-School-Id` |

A reassignment refuses the old bus's files at once (the next call checks the new assignment).

## `GET` / `PUT /parent/children/:studentId/notification-preferences`

Per child, per direction, per parent (BP §11.2). A missing row means every toggle is on. Any linked child may hold
preferences for both directions (no assignment needed: a bus may be assigned later).

```json
{ "success": true, "data": {
  "studentId": "…",
  "morning":   { "tripStarted": true, "busLeftSchool": true, "approachingStop": true, "arrivedAtStop": true, "tripDelayed": true, "tripNotStarted": true,
                 "tripInterrupted": true, "tripCancelled": true },
  "afternoon": { "tripStarted": false, "busLeftSchool": true, "approachingStop": true, "arrivedAtStop": true, "tripDelayed": true, "tripNotStarted": true,
                 "tripInterrupted": true, "tripCancelled": true },
  "updatedAt": "2026-10-19T02:01:10.000Z" } }
```

`PUT` body: any subset, merged over the current values, e.g. `{ "afternoon": { "tripStarted": false } }`.
* Non-boolean values → `400 VALIDATION_ERROR`. Unknown keys (`schoolId`, `parentAccountId`, `studentId`, typos) are
  stripped (contract §4: bodies never grant authority); a body left without any known toggle → `400`.
* One multi-row upsert for both directions; audited as `notification_preferences.update` (old/new of the changed
  directions only). A body that changes nothing returns the current values without a write.
* Another parent of the same child keeps its own settings.
* The notifications module reads them through `effectivePreferences(tx, studentId, direction, parentIds)`
  (exported from `modules/parent/index.ts`).

## `POST /parent/devices`

Registers or refreshes the phone and its FCM token. No `X-School-Id`: parent devices are school-less rows
(`devices.school_id` NULL, `owner_type = 'parent_account'`; RLS limits a parent to its own rows).

```json
{ "deviceId": "a1b2c3d4-…", "platform": "android", "fcmToken": "…", "model": "Pixel 8", "osVersion": "15", "appVersion": "1.0.0" }
```
→ `200` `{ "id": "…", "deviceId": "a1b2c3d4-…", "platform": "android", "model": "Pixel 8", "osVersion": "15", "appVersion": "1.0.0", "hasFcmToken": true, "lastSeenAt": "…" }`

* `fcmToken`: a string sets it, `null` clears it (push off on this phone), omitted keeps it. The token never
  appears in responses or audit logs (`hasFcmToken` only).
* A session that signed in without a device descriptor is **bound** to the registered device
  (`sessions.device_id`), so push goes only to devices with a live session. A session already bound to another
  device → `403 DEVICE_NOT_BOUND` (sign in again on this phone).
* A revoked or untrusted device keeps its state and never stores a token.
* Audited as `device.register` / `device.update`.

## In-app inbox

`GET /parent/notifications` — query `page`, `limit` (1–100, default 20), `unread` (`true`/`false`), `studentId`.
Spans every school (no `X-School-Id`); newest first.

```json
{ "success": true,
  "data": [ { "id": "…", "schoolId": "…", "studentId": "…", "tripId": "…", "kind": "approaching_stop",
              "title": "Bus R1 is almost there", "body": "Bus R1 is about 4 minutes away from Aarav's stop.",
              "data": { "type": "approaching_stop", "screen": "track", "schoolId": "…", "studentId": "…", "tripId": "…", "direction": "afternoon" },
              "readAt": null, "createdAt": "…" } ],
  "meta": { "page": 1, "limit": 20, "total": 14, "totalPages": 1, "unreadCount": 3 } }
```

* `kind`: a BP §11.2 event (`trip_started`, `bus_left_school`, `approaching_stop`, `arrived_at_stop`,
  `trip_delayed`, `trip_not_started`, `trip_interrupted`, `trip_cancelled`), `announcement` or `system`. `data` is the deep-link payload (announcements:
  `{ "type": "announcement", "screen": "announcement", "schoolId", "announcementId" }`). Texts carry only the
  child's first name and the bus code (lock-screen safe; English or Hindi per the parent's language) — see
  [notifications.md](notifications.md).
* `meta.unreadCount` counts every unread notification of the parent (all schools, ignoring filters).
* Rows are written by the notifications module, which also emits `notification:new` to the parent's actor room.

`POST /parent/notifications/:id/read` → the notification with `readAt` set. Idempotent (a second call returns
the same row, no new audit). Another parent's or an unknown id → `404`. Audited as `parent_notification.read`.

`POST /parent/notifications/read-all` → `{ "updated": 3 }`. Audited as `parent_notification.read_all` when it
marked anything. Both go through `parent_notifications_mark_read()` (own rows only).

## Socket room `child:{studentId}:live`

Namespace `/rt`, parent access token in `auth.token`. Join with the room name from the tracking snapshot.

**Authorization** (on every join and on every membership re-check):
* the principal is a parent, and the student is one of its **active** links (`parent_children_index`);
* the student's school is active, not deleted and within its plan (parent principals carry no school, so the
  authorizer checks it itself);
* the child has a **current assignment** (school-local today), read in the parent's tenant context under RLS.

Anything else is refused (`FORBIDDEN`). A transient failure refuses the join with `503` but keeps an existing
membership until the next check. When the child loses every assignment, `realtime.revalidateActors()` (students
module) or the 5-minute sweep removes the socket from the room and sends `room:revoked` `{ room, reason }`. A
child moved to another bus keeps the room; the feed follows the new bus at once.

**Events**: `child:live` (`PARENT_SOCKET_EVENTS.CHILD_LIVE`), one per child currently assigned to the trip's bus +
direction, computed for **that child's stop**:

```json
{ "studentId": "…", "schoolId": "…", "tripId": "…", "busId": "…", "direction": "morning",
  "kind": "position", "change": null, "tripStatus": "in_progress",
  "status": { "status": "on_route", "reason": null, "etaAt": "…", "etaMinutes": 5, "plannedAt": "…", "delayMin": 11, "lastUpdatedAt": "…", "stopPassed": false, "phase": "running", "phaseReason": null, "interruptedAt": null },
  "position": { "lat": 12.9203, "lng": 77.6391, "hdg": 140, "spd": 28.5, "t": "…" },
  "motion": "moving", "freshness": "live", "eta": { "quality": "good", "childStop": { … }, "nextStop": { … }, "destinationEtaAt": "…" },
  "at": "…" }
```

* `kind`: `position` (new fix), `status` (`change` = `stop_arrived` | `stop_departed` | `location_unavailable` |
  `location_restored` | `eta` | `motion`), `trip` (`change` = the new trip status: started, cancelled, completed,
  auto-closed).
* **Coalescing**: positions and ETA refreshes are relayed at most once per trip per window, about 10 s while
  moving (9-s claim, so a regular 10-s cadence is never halved by jitter; the tracking module already coalesces
  the trip room to ≥ ~10 s) and 30 s while stopped. Discrete changes (stop arrival/departure, location
  unavailable/restored, motion, trip status) are relayed once each.
* Exactly once across API instances: each relay claims a kv key first (Redis `SET NX` in production).
* The fan-out targets are read afresh for every relayed message, so a reassignment takes effect at once.
* No battery/network data, no other children's data. The relay starts lazily with the first authorized join.
* Polling `GET …/tracking` every `pollAfterS` seconds is the fallback when the socket is unavailable.

## Audit

Parents never write school data. Their own writes are audited with the parent as actor:
`notification_preferences.update`, `device.register`, `device.update`, `parent_notification.read`,
`parent_notification.read_all`.

## Module exports (`modules/parent/index.ts`)

| Export | For |
|---|---|
| `effectivePreferences(tx, studentId, direction, parentIds)` · `DEFAULT_NOTIFICATION_TOGGLES` | notifications fan-out (missing rows = all on) |
| `childRelay` · `createChildRelay(deps)` · `CHILD_MOVING_EMIT_MS` · `CHILD_STOPPED_EMIT_MS` | the `child:live` feed (tests inject pub/sub, kv, realtime) |
| `CHILD_ROOM` · `childRoomAuthorizer(loadSchool)` · `registerParentRooms(registry)` | the room and its authorizer |
| `parentLinks(parentId)` · `usableSchool(schoolId)` | active links and the "may use this school now" check |
