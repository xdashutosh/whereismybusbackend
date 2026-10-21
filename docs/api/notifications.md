# Notifications API and engine (BP §11.2, §7.3; contract §2, §9)

The notifications module turns trip and tracking events into **parent notifications**. Each one is stored in the
parent's in-app inbox and sent by push (FCM), plus SMS or WhatsApp where the school has paid for those channels. The
module also fans **school announcements** out to parents and drivers, and serves the school admin's notification
log. Source: `backend/src/modules/notifications/`. Shared types: `@wimb/shared` →
`backend/shared/src/schemas/notifications.ts` (`schoolNotificationListQuery`, `NotificationEventDto`,
`ChannelOutcome`, `NotificationDeepLink`, `NotificationNewEvent`, `NOTIFICATION_KINDS`, `NOTIFICATION_LANGUAGES`)
and `enums.ts` (`NOTIFICATION_EVENTS`, `NOTIFICATION_CHANNELS`, `NOTIFICATION_STATUSES`).

The parent-facing endpoints live in the parent module ([parent.md](parent.md)):

* notification preferences: `GET/PUT /parent/children/:studentId/notification-preferences`
* push devices: `POST /parent/devices`
* the inbox: `GET /parent/notifications`, `POST /parent/notifications/:id/read`, `POST /parent/notifications/read-all`

This module writes the inbox rows and emits `notification:new`.

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/school/notifications` | school admin | the school's parent notification log (filters, sort, `format=csv`) |

## Triggers (parents)

| `eventType` | Trigger (event consumed) | Recipients |
|---|---|---|
| `trip_started` | `trip.status_changed` to `in_progress` (school trip with a direction) | students assigned to the trip's bus + direction on the trip date |
| `bus_left_school` | `tracking.left_school`: first exit from the school geofence after being inside it. Morning: the bus leaves school. Afternoon: first departure from school. | same |
| `approaching_stop` | `tracking.eta_updated`: ETA to the child's stop ≤ `approachingStopMinutes` (school setting, default 5). Good or degraded ETA quality only. | students of those stops |
| `arrived_at_stop` | `tracking.stop_arrived`: the bus entered the child's stop geofence | students of that stop |
| `trip_delayed` | `tracking.eta_updated`: the stop's predicted time is later than its timetable time by **more than** `tripDelayThresholdMin`. Good ETA quality only, so a cold start never reports a false delay. | students of those stops |
| `trip_not_started` | `trip.not_started` from the `trip-not-started-check` job. Only when the school enabled `notifyTripNotStarted`, which is checked again at dispatch. | students assigned to the bus + direction |
| `trip_interrupted` | `trip.interrupted`: the driver marked the running trip interrupted (breakdown, BP §10.4). | students assigned to the bus + direction |
| `trip_cancelled` | `trip.status_changed` to `cancelled` from `in_progress` or from today's `scheduled` trip. Cancellations caused by school holidays or schedule edits are excluded. | students assigned to the bus + direction |

`trip_interrupted` and `trip_cancelled` (`TRIP_NOTICE_EVENTS` in `@wimb/shared`; `PARENT_TRIP_EVENTS` = all parent trip
events) use the same pipeline, inbox, dedupe and per-direction preferences (`tripInterrupted`, `tripCancelled`).

How recipients are chosen:

* A student counts when active, not deleted, and assigned to the trip's bus + direction on the trip date (half-open
  validity window `valid_from ≤ date < valid_to`).
* A parent counts when the student link is active, the school-parent link is active, and the parent account is
  active.
* The engine reads `notification_preferences` (per parent, per child, per direction) with **one query for all
  students**. A missing row means every toggle is on, the same as `effectivePreferences` /
  `DEFAULT_NOTIFICATION_TOGGLES` in the parent module.
* A parent with children in several schools hears only about the child on the trip's school bus. Every statement
  runs in that school's context, so RLS applies.

Gating, applied before anything is claimed:

* Non-school trips are ignored.
* `trip_started` needs an `in_progress` trip.
* Stop and school events also accept a trip that has just ended (`completed`, `auto_closed`).
* `trip_not_started` needs a `scheduled` or `missed` trip.
* `trip_interrupted` needs an `in_progress` (or meanwhile `cancelled`) trip, else `TRIP_NOT_RUNNING`; `trip_cancelled`
  needs a `cancelled` trip, else `TRIP_NOT_CANCELLED`.
* Signals older than these limits are dropped (`STALE_SIGNAL`), so a late job never buzzes a lock screen:

| Event | Maximum signal age |
|---|---|
| `trip_started` | 30 min |
| `bus_left_school` | 15 min |
| `approaching_stop` | 5 min |
| `arrived_at_stop` | 10 min |
| `trip_delayed` | 10 min |
| `trip_not_started` | 30 min |
| `trip_interrupted` | 60 min |
| `trip_cancelled` | 60 min |

## Dedupe, idempotency and delivery

**Listeners only queue work.** Each event becomes one job, `notifications-dispatch`, with 3 attempts and a 2 s
backoff. The job id is deterministic per (event, trip, stop set), so duplicate events collapse into one job.

**ETA updates are pre-filtered.** They arrive with every live batch, so each candidate (trip, event, stop) is
claimed once with an atomic `kv` marker (12 h TTL, keys include `school_id`) before anything is queued.

**`notification_events` decides what has been sent.** Each run, in one transaction:

1. Claims one row per student with `INSERT … ON CONFLICT ON CONSTRAINT notification_events_dedupe DO NOTHING`
   (`UNIQUE (trip_id, student_id, event_type)`).
2. Writes the inbox rows only for the students it claimed (`parent_notifications_event_uq` = one entry per event
   and parent).

A retry, or a run racing it, claims nothing and sends nothing. Each event therefore reaches a given parent at most
once per trip and student, `approaching_stop` included.

**Students nobody will hear about are recorded as `skipped`.** The `error` is `PREFERENCES_OFF` (every parent opted
out) or `NO_PARENTS`. Re-enabling a toggle mid-trip never replays an old event.

**External channels go out after commit.** The event row then moves to `sent` with `payload.channels`, the outcome
per channel. Push is at most once: if the process crashes between commit and delivery, the event stays `queued`
with its inbox entries stored, and no lock-screen alert is ever duplicated.

### Channels (BP §11.2 `NotificationChannel`; contract §2)

| Channel | Used when | Notes |
|---|---|---|
| `in_app` | always | inbox row + socket `notification:new` to `actor:{parentAccountId}` |
| `push` | FCM configured (`FIREBASE_SERVICE_ACCOUNT_B64`) **and** platform setting `modules.push` ≠ false | tokens of the parent's trusted, unrevoked phones that still have a live session (parent active and linked to the school), read for all parents of a run in **one statement** through the SECURITY DEFINER function `notification_parent_push_tokens(parent_ids)` (migration 600; school system context only — parents' devices are school-less rows that RLS `own_rows` shows only to the parent). One multicast per (event, language). Tokens FCM reports as invalid are cleared with `notification_clear_parent_tokens(tokens)` (parents linked to that school only). Skips are recorded as `PUSH_DISABLED`, `MODULE_DISABLED` or `NO_DEVICES`. |
| `sms` | the school's effective `features.sms` (school flag narrowed by platform `modules.sms`) | WebPay Services through `channels.sms.sendText`. Needs a DLT template id per text, registered with `configureNotificationDeps({ smsTemplateId })`. Without one, the provider reports its own error code. |
| `whatsapp` | the school's effective `features.whatsapp` **and** an installed adapter | out of MVP scope (contract §9): the default adapter is unavailable (`NOT_AVAILABLE`). A deployment plugs one in with `configureNotificationDeps({ whatsapp })`. |
| `email` | not used for parents | admin mail stays with `channels.email` |

`notification_events.channel` holds the main channel: `push` when push was attempted, otherwise `in_app`.

### Templates (lock-screen safe; English + Hindi)

Messages carry **only the child's first name and the bus code**, plus a rounded minute count for `approaching_stop`
and `trip_delayed`. They never include the surname, class, stop name, address, driver or coordinates.

* The language follows `parent_accounts.preferred_language` (`hi`, otherwise `en`).
* Titles are cut at 65 characters and bodies at 178.
* A missing name becomes "your child" / "आपके बच्चे".

| Event | English title | English body |
|---|---|---|
| `trip_started` | Bus R1 has started | The morning trip of bus R1 for Aarav has started. |
| `bus_left_school` | Bus R1 left school | Bus R1 (Aarav's morning bus) has left the school. |
| `approaching_stop` | Bus R1 is almost there | Bus R1 is about 4 minutes away from Aarav's stop. |
| `arrived_at_stop` | Bus R1 has arrived | Bus R1 has reached Aarav's stop. |
| `trip_delayed` | Bus R1 is running late | Bus R1 is running about 12 minutes late for Aarav's stop. |
| `trip_not_started` | Bus R1 has not started | The morning trip of bus R1 for Aarav has not started yet. |
| `trip_interrupted` | Bus R1 trip interrupted | The morning trip of bus R1 for Aarav has been interrupted. The school will share an update. |
| `trip_cancelled` | Bus R1 trip cancelled | The morning trip of bus R1 for Aarav has been cancelled by the school. |

Hindi example: `trip_started` → "बस R1 चल पड़ी है" / "Aarav की सुबह की बस R1 की यात्रा शुरू हो गई है।". The full set is in
`templates.ts`, and `tests/notifications.templates.test.ts` pins every text.

### Deep links

The same deep link goes into the inbox row's `data`, the push data (string values only) and the socket payload:

```json
{ "type": "approaching_stop", "screen": "track", "schoolId": "…", "studentId": "…", "tripId": "…", "direction": "morning" }
```

Announcements use `{ "type": "announcement", "screen": "announcement", "schoolId": "…", "announcementId": "…" }`.
The app opens the Track screen of that child, selecting the school with `X-School-Id`.

### Socket `notification:new` (room `actor:{id}`)

```json
{ "id": "0192…", "schoolId": "…", "kind": "arrived_at_stop", "title": "Bus R1 has arrived",
  "body": "Bus R1 has reached Aarav's stop.", "data": { "type": "arrived_at_stop", "screen": "track", "…": "…" },
  "createdAt": "2026-10-19T07:31:12.000Z" }
```

`id` is the inbox entry id for parents and `null` for driver notices, which have no inbox row.

## Announcements (BP §20 #6; contract §9)

The school module ([school.md](school.md)) emits two events after commit, and this module delivers them:

* `announcement.published` on create
* `announcement.changed` on edit or delete

| Action | When | Effect |
|---|---|---|
| deliver | published with `publishedAt` ≤ now (+5 s skew), `publishedAt` moved to now, or the audience edited (a widened audience reaches its new segment) | **Parents** (audience `parents` / `all`): one inbox entry each, for active parents with at least one active linked student, plus push in the parent's language. **Drivers and conductors** (audience `drivers` / `all`): push to their signed-in phones, plus `notification:new` in their personal room. |
| deliver (scheduled) | `publishedAt` in the future | no job is held: the per-minute `announcement-sweep` delivers it once due (at most about 1 min late). It survives restarts of the in-process backend. |
| refresh | title, body or audience edited | rewrites the stored inbox text with no second push. If the audience no longer includes parents, their entries are removed; if a live announcement whose parents segment was already delivered addresses parents again (`parents → drivers → all`), the entries come back, inbox only (the parents were pushed once already). Audited as `announcement.inbox_refresh` `{ entries, removed, restored }`. |
| withdraw | announcement deleted | removes the parents' inbox entries. Audited as `announcement.inbox_withdraw`. |

* **Exactly once per audience segment.** A transaction-scoped advisory lock per announcement plus the audit
  marker `announcement.deliver` (actor `notifications`, `new_values.segments` = the segments that run delivered:
  `parents`, `drivers`) guard delivery. A run delivers only the segments of the current audience that no marker
  covers yet, so widening `drivers → all` later reaches the parents once and never re-pushes the drivers.
  Concurrent and retried runs, and runs with nothing left, answer `ALREADY_DELIVERED`. (Markers written before
  segments existed count the segments of their recorded `audience`.)
* **Skipped deliveries** answer `WITHDRAWN`, `EXPIRED`, `NOT_DUE`, `NOT_FOUND` (also another school's id), or
  `FEATURE_DISABLED` when `features.announcements` is off.
* **Lock-screen text:**
  * the title is generic ("New notice from school" / "स्कूल से नई सूचना")
  * the body is the announcement's title
  * the inbox keeps the school-written title and body (200 / 2000 characters)
* **Channels:** push and in-app only. Announcements never use SMS or WhatsApp.
* **Driver app:** lists notices from `GET /driver/home` ([trips.md](trips.md)). GPS-off, poor-connectivity and
  low-battery notices are local alerts in the app (BP §11.2), and the server raises the matching admin alerts
  ([tracking.md](tracking.md)).

## `GET /school/notifications`

The school's parent notification log: who was told what, on which channel, and why an event was skipped. It returns
one row per (trip, student, event).

Query parameters:

| Parameter | Values |
|---|---|
| `page`, `limit` | `limit` 1–100, default 20 |
| `sort` | `createdAt` (default `-createdAt`), `tripDate`, `eventType`, `status`, `studentName` |
| `tripId`, `studentId` | uuid |
| `eventType` | comma list of `NOTIFICATION_EVENTS` |
| `status` | comma list of `queued`, `sent`, `failed`, `skipped` |
| `direction` | `morning` or `afternoon` |
| `from`, `to` | trip dates, inclusive |
| `q` | student name or bus code |
| `format` | `json` or `csv`; `pdf` answers `400` |

```json
{ "success": true,
  "data": [ {
    "id": "0192…", "tripId": "0192…", "tripDate": "2026-10-19", "direction": "morning", "busCode": "R1",
    "studentId": "0192…", "studentName": "Aarav Kumar Sharma", "eventType": "trip_started",
    "channel": "push", "status": "sent", "recipients": 2,
    "channels": {
      "in_app": { "status": "sent", "targets": 2, "delivered": 2 },
      "push": { "status": "sent", "targets": 2, "delivered": 1 },
      "sms": { "status": "skipped", "targets": 0, "delivered": 0, "error": "FEATURE_DISABLED" },
      "whatsapp": { "status": "skipped", "targets": 0, "delivered": 0, "error": "FEATURE_DISABLED" } },
    "error": null, "sentAt": "2026-10-19T07:02:03.120Z", "createdAt": "2026-10-19T07:02:03.010Z" } ],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 } }
```

* **Field meanings:**
  * `recipients`: parents whose preferences allowed the event.
  * `channels[c]`: `sent` (delivered to at least one target), `failed` (attempted, nothing delivered) or `skipped`
    (not attempted, with an `error` code).
  * Skipped rows carry `error` = `PREFERENCES_OFF` or `NO_PARENTS`.
* **CSV export** (`format=csv`): streamed with a BOM and the formula guard, capped at `MAX_EXPORT_ROWS`. Columns:
  Created at (UTC), Trip date, Direction, Bus, Student, Event, Status, Recipients, In-app, Push, SMS, Error, Sent at
  (UTC). A channel cell reads `sent 2/2` or `skipped 0/0 FEATURE_DISABLED`.
* **Access:**
  * school admins only: drivers and parents get `403`, anonymous callers `401`
  * one query per page
  * another school's admin sees an empty list, even when filtering by this school's trip or student ids (RLS)
* **Errors:** `400 VALIDATION_ERROR` for an unknown event or status, a malformed uuid or date, a non-whitelisted
  sort, or `format=pdf`.

## Jobs (contract §8)

| Job | Kind | Purpose |
|---|---|---|
| `notifications-dispatch` | queue (concurrency 4, 3 attempts, 2 s backoff) | one parent notification run `{ schoolId, tripId, event, stopIds?, minutesByStop?, at }` |
| `announcement-deliver` | queue (concurrency 2, 3 attempts, 5 s backoff) | `{ schoolId, announcementId, action: deliver \| refresh \| withdraw }` |
| `announcement-sweep` | cron, every minute (UTC), all active schools | delivers scheduled announcements once due, and due ones whose job was lost. Window: published within the last 24 h, unexpired, not withdrawn, with an audience segment no delivery marker covers. |

The listeners are registered in every process that can emit their events:

* the API, through `router.ts`
* the worker, through `jobs.ts`, which is listed in `src/jobs/index.ts`

In production the tracking analytics and the trip-not-started check run in the worker.

## Audit

The audited actions are `announcement.deliver` (the delivery marker), `announcement.inbox_refresh`,
`announcement.inbox_withdraw` and, for parent trip notifications, one `notification.dispatch` row per run that
claims anything (entity `trip`, actor `notifications`, `new_values { event, stopIds, claimed, notified, skipped,
inbox, channel }` — counts only, no names, phones or texts), written in the claiming transaction. The
per-student record is `notification_events`, which `GET /school/notifications` shows.

## Module surface (`modules/notifications/index.ts`)

| Export | Use |
|---|---|
| `dispatchTripEvent(payload, { nowMs?, log? })` → `{ claimed, notified, inbox, reason? }` | one idempotent run (job handler, tests, scripts) |
| `deliverAnnouncement`, `refreshAnnouncement`, `withdrawAnnouncement`, `sweepAnnouncements` | announcement actions |
| `configureNotificationDeps(patch)` → restore fn | swap adapters: `push`, `sms`, `whatsapp`, `smsTemplateId`, `realtime` (WhatsApp provider, DLT template ids, tests) |
| `selectChannels(inputs)`, `gateReason(trip, payload, nowMs)`, `etaCandidates(eta, thresholds)` | pure decision helpers |
| `renderTripMessage(event, lang, vars)`, `renderAnnouncement(lang, a)`, `firstNameOf(name)` | templates |
| `NOTIFICATION_JOB_DEFINITIONS`, `DISPATCH_JOB`, `ANNOUNCEMENT_JOB`, `ANNOUNCEMENT_SWEEP_JOB` | job registry |
