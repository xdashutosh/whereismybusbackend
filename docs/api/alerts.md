# Alerts API (BP §11.1, §7.3, §13.3 Alerts)

School admin alert inbox with a review, escalate and close workflow, the admin bell socket room, and the two daily
scan jobs that raise document and maintenance alerts. Other modules raise alerts through
`backend/src/modules/alerts/service.ts` (`raiseAlert`, `announceAlerts`, `closeAlertByKey`). Shared schemas and DTOs:
`@wimb/shared` → `backend/shared/src/schemas/alerts.ts` (`alertListQuery`, `alertActionBody`, `AlertDto`,
`AlertListMeta`, `AlertNewEvent`, `AlertUpdatedEvent`, `ALERT_UPDATED_EVENT`, `REQUIRED_BUS_DOCUMENT_TYPES`,
`SERVICE_DUE_LEAD_DAYS`, `SERVICE_DUE_LEAD_KM`).

Every endpoint requires a **school admin** of an active school (`/school/*` area guard). An alert id from another
school answers `404 NOT_FOUND`. A `school_id` / `schoolId` sent in a body or query is ignored.

## Alert catalogue

| `alertType` | Raised by | Severity |
|---|---|---|
| `trip_not_started`, `trip_auto_closed` | trip jobs | warning |
| `odometer_gap`, `odometer_decrease`, `odometer_gps_mismatch`, `non_school_trip` | trip start / end | see [trips.md](trips.md) |
| `speeding`, `route_deviation`, `long_stop`, `gps_disabled`, `low_battery`, `no_network` | tracking | warning |
| `harsh_driving` | driver app `harsh_braking` / `harsh_acceleration` / `harsh_cornering` events (`POST /driver/trips/:id/events`) while the school enables it | warning |
| `location_permission` | driver app `location_permission_denied` event (tracking stopped until the driver allows location again); the gap detector while the permission is denied; closed by the system on `location_permission_restored` | critical |
| `clock_drift` | location ingestion / device events whose device clock is off by more than 60 s (timestamps corrected; rejected beyond 24 h), or the app's `clock_drift` event — one per trip (`clock_drift:{tripId}`) | warning; critical when rejected |
| `doc_expiring` | `document-expiry-scan` | warning; critical when the reminder is 7 days or less |
| `doc_expired` | `document-expiry-scan` | critical |
| `doc_missing` | `document-expiry-scan` | warning |
| `service_due` | `maintenance-due-scan` | warning while due soon; critical once overdue |

Workflow: **open → reviewed** (note required) **→ escalated / closed**. An open alert may also be escalated or
closed directly, and an escalated alert can then be closed. Closed alerts are final.

## AlertDto

```json
{
  "id": "019a…", "alertType": "doc_expiring", "severity": "warning", "status": "escalated",
  "title": "Insurance of bus R1 expires in 20 days (2026-11-07)",
  "entityType": "bus_document", "entityId": "019a…",
  "busId": "019a…", "busCode": "R1",
  "tripId": null, "tripDate": null, "tripDirection": null, "tripStatus": null, "routeCode": null,
  "staffId": null, "staffName": null,
  "details": { "source": "bus_document", "docType": "insurance", "expiryDate": "2026-11-07", "daysToExpiry": 20,
               "threshold": 30, "thresholds": [1, 7, 15, 30, 60], "localDate": "2026-10-18", "busCode": "R1",
               "subject": "bus_document:019a…" },
  "escalation": {
    "escalatedAt": "2026-10-18T05:12:09.120Z", "escalatedBy": "019a…", "recipientCount": 2,
    "deliveries": [
      { "channel": "email", "userId": "019a…", "name": "Meera Iyer", "target": "meera@greenwood.example", "status": "sent", "reason": null, "attemptedAt": "…" },
      { "channel": "push", "userId": "019a…", "name": "Meera Iyer", "target": "Meera Iyer", "status": "skipped", "reason": "NO_DEVICES", "attemptedAt": "…" },
      { "channel": "sms", "userId": null, "name": "Transport head", "target": "+91******2345", "status": "skipped", "reason": "SMS_NOT_SUPPORTED", "attemptedAt": null }
    ]
  },
  "resolvedAt": null,
  "reviewedBy": "019a…", "reviewedByName": "Anita Rao", "reviewedAt": "…", "reviewNote": "Renewal requested",
  "escalatedBy": "019a…", "escalatedByName": "Anita Rao", "escalatedAt": "…",
  "closedBy": null, "closedByName": null, "closedAt": null,
  "createdAt": "…", "updatedAt": "…"
}
```

* `busCode` falls back to the trip's bus snapshot. `tripDate`, `tripDirection`, `tripStatus` and `routeCode` come from
  the linked trip. `staffName` is the driver or conductor profile.
* `details` holds what the producer recorded (readings, distances, thresholds and so on), without `escalation`.
* `reviewNote` is the latest note from any action.
* `resolvedAt` is set when the **system** closed the alert because its cause went away (`details.resolution` is
  `resolved` or `superseded`). Those alerts have `closedBy: null` and an explanatory `reviewNote`.
* Delivery `status` values:
  * `pending`: queued.
  * `sent`: accepted by SMTP or FCM.
  * `logged`: SMTP is not configured, so the e-mail was written to the server log.
  * `failed`: retried by the job.
  * `skipped`: the channel was unavailable. `reason` is one of `PUSH_DISABLED`, `NO_DEVICES`, `SMS_NOT_SUPPORTED` or `RECIPIENT_INACTIVE`.

## `GET /school/alerts`

Query (all optional):

| Param | Meaning |
|---|---|
| `status` | comma list of `open,reviewed,escalated,closed` |
| `type` | comma list of alert types |
| `severity` | comma list of `info,warning,critical` |
| `entityType` | comma list of `bus,trip,staff,bus_document,staff_document,maintenance_log,device` |
| `from`, `to` | school-local calendar days (`YYYY-MM-DD`, inclusive) of `createdAt`; `from ≤ to` |
| `period` | `YYYY-MM-DD..YYYY-MM-DD` (or one day / an open end) — fills `from` / `to` when they are not given |
| `busId`, `tripId`, `staffId` | one record (`staffId` = staff profile id) |
| `q` | text in the title, bus code or staff name |
| `sort` | `createdAt` (default `-createdAt`), `updatedAt`, `severity`, `status` (open, escalated, reviewed, closed), `type`, `busCode` |
| `page`, `limit` | pagination (limit 1–100, default 20) |
| `format` | `csv` streams every match (max 10,000 rows), no pagination |

`200`:
```json
{ "success": true, "data": [ <AlertDto>, … ],
  "meta": { "page": 1, "limit": 20, "total": 3, "totalPages": 1,
            "counts": { "open": 2, "reviewed": 1, "escalated": 1, "closed": 7 } } }
```
`counts` applies every filter **except** `status`, so it works for status tabs and the bell badge
(`?status=open&limit=5&sort=-createdAt`). `total` is the number of matches for the requested statuses. One SQL round
trip. Invalid filters return `400 VALIDATION_ERROR`.

CSV columns: Raised (UTC), Type, Severity, Status, Title, Bus, Staff, Trip date, Direction, Route, Reviewed by,
Reviewed (UTC), Note, Escalated by, Escalated (UTC), Closed by (`System` for automatic resolution), Closed (UTC).

## `GET /school/alerts/:id`

`200` → AlertDto · `404` for an unknown id or another school's id · `400` for an id that is not a UUID.

## `PATCH /school/alerts/:id`

```json
{ "action": "review", "note": "Renewal requested from the insurer" }
{ "action": "escalate", "note": "Still not renewed" }
{ "action": "close" }
```

| Action | Allowed from | Effect |
|---|---|---|
| `review` | `open`, `reviewed` | `note` **required** (≤ 1000); sets `reviewedBy`/`reviewedAt`; a reviewed alert can be re-reviewed to edit the note |
| `escalate` | `open`, `reviewed` | optional note; sets `escalatedBy`/`escalatedAt`, stores the delivery plan in `escalation` and queues the notifications |
| `close` | `open`, `reviewed`, `escalated` | optional note; sets `closedBy`/`closedAt` |

`200` → the updated AlertDto.

Errors:
* `400` for a missing note on `review` or an unknown action.
* `404` for an id of another school.
* `409 INVALID_STATE` when the action is not allowed from the current status (`details { status, action }`). This
  covers every action on a closed alert.
* `409 CONFLICT` when escalating a reviewed alert whose cause was raised again as a new open alert in the meantime
  (`alerts_dedupe`).

Each action writes an audit row (`alert.review` / `alert.escalate` / `alert.close`, old and new status, note,
`recipientCount`). After commit it emits `alert:updated` to `school:{id}:alerts` and the in-process `alert.updated`
event.

### Escalation recipients

Recipients are the school's `alertRecipients` (`PUT /school/settings`, see [school.md](school.md)). A recipient
matches when the alert severity is at least its `minSeverity` (default `warning`) and, if it has `alertTypes`, the
alert type is in that list. For each matching recipient:

* **School admin** (`userId`): an e-mail to the admin's address and a push to the admin's signed-in devices: FCM
  tokens of trusted, unrevoked devices in this school that are bound to a **live session** (unrevoked, unexpired)
  of that admin — the same rule as announcement pushes, because device rows keep their token after sign-out. An
  admin with no such device is recorded as `skipped` / `NO_DEVICES`. An admin who is no longer active is recorded
  as `skipped` / `RECIPIENT_INACTIVE`.
* **E-mail contact**: an e-mail. Addresses are deduplicated across recipients.
* **Phone contact**: recorded as `skipped` / `SMS_NOT_SUPPORTED`. Alert SMS would need their own DLT template, so
  escalations use e-mail and push.

The `alert-escalation` queue job (job id `alert-escalation-{alertId}`, 4 attempts) delivers outside any transaction
and stores the results in `escalation.deliveries`:

* Recipients are **re-checked on every run** (first run and retries): a delivery for a user who is no longer an
  active, non-deleted school admin of this school (deactivated, deleted or demoted after the escalation) becomes
  `skipped` / `RECIPIENT_INACTIVE` — neither the e-mail nor the push goes out. Plain e-mail contacts are unaffected.
* One run per alert at a time: a run holds a kv claim `alert-escalation:{schoolId}:{alertId}` (120 s TTL), so a
  second worker or a stalled-job recovery never sends the same delivery twice.
* FCM tokens reported invalid are cleared.
* A failed SMTP delivery makes the job retry. Only deliveries that are `pending` or `failed` are sent again, so a
  recipient never gets the same escalation twice.
* Each run writes an `alert.notify` audit row (counts per status).

The e-mail subject is `[Where Is My Bus] Escalated <severity> alert: <title>`. The body gives the school, type,
severity, bus, staff, trip, the raise time in the school timezone, who escalated it and the note, plus a link to
`APP_PUBLIC_URL/school/alerts?alert=<id>`. The push carries `data { type: "alert", schoolId, alertId }`.

## Socket.IO: `school:{schoolId}:alerts`

The room is built into `backend/src/socket.ts`: school admins of that (active) school only. Drivers, conductors,
parents, other schools and malformed names are refused (`join` ack `{ ok: false }`).

| Event | Payload |
|---|---|
| `alert:new` | `{ id, type, severity, title, tripId, busId, entityType, entityId, createdAt }`, sent for every new alert (any producer) |
| `alert:updated` | `{ id, type, severity, status, action, updatedAt }`, where `action` is `review`, `escalate`, `close` (admin) or `resolve` (the system closed it) |

## Jobs

Both scans are `school-cron` jobs that run in each school's timezone inside `withSchoolSystem`. They are idempotent
and exported for tests (`documentExpiryScan`, `maintenanceDueScan` in `modules/alerts/jobs.ts`; payload
`{ schoolId, localDate? }`).

### State reconciliation (both scans)

Each run computes the alerts that should exist on the school-local day, then converges the inbox:

* **Raise** desired keys that have no *live* alert. Live means open, reviewed or escalated, or closed by an admin and
  not yet resolved. All new alerts go in one bulk insert on the `alerts_dedupe` index.
* **Resolve** live alerts whose key is no longer desired:
  * The cause went away, or a later stage replaced it (`superseded`).
  * Open, reviewed and escalated ones are closed by the system (`closedBy` null, `reviewNote` gives the reason).
  * Every resolved alert gets `details.resolvedAt`.

Consequences:
* Repeated scans never duplicate an alert.
* An alert an admin closed stays closed while its cause persists.
* The same cause raises a new alert if it comes back after being resolved.

Runs for one school are serialised with an advisory lock. Each run that changes anything writes one `alert.scan`
audit row (`raised`, `closed`, `resolved`, ids).

### `document-expiry-scan` (06:30 school-local)

**Reminder thresholds** come from `school_settings.document_reminder_days`, or the platform default
`docs.expiry_reminder_days` (`[60, 30, 15, 7, 1]`).

**What is scanned:**
* **Bus documents:** current, non-deleted documents of non-deleted buses that are `active` or `maintenance`.
* **Staff documents:** current, non-deleted documents of active, non-deleted staff.
* **Driver licences:** `staff_profiles.licence_expiry_date` is the source of truth. Licence front/back documents are
  scanned only when the profile has no licence expiry date.

| Alert | Rule | Dedupe key |
|---|---|---|
| `doc_expiring` | 0 ≤ days to expiry ≤ a threshold. One alert for the **tightest** threshold reached; the next threshold supersedes it (e.g. 20 days → 30-day reminder, 14 days → 15-day reminder). The expiry day itself is `expires today`. | `doc_expiring:{docId}:{threshold}:{expiryDate}` (licence: `doc_expiring:licence:{staffId}:…`) |
| `doc_expired` | expiry date before the school-local day; supersedes the reminders | `doc_expired:{docId}:{expiryDate}` (licence: `doc_expired:licence:{staffId}:{expiryDate}`) |
| `doc_missing` | an active / maintenance bus without a current `insurance` or `fitness` document (`REQUIRED_BUS_DOCUMENT_TYPES`); an active driver with neither a licence expiry date nor a current licence document | `doc_missing:bus:{busId}:{docType}`, `doc_missing:licence:{staffId}` |

The expiry date is part of the key. A renewal (a replaced document gets a new id) or a corrected expiry date
therefore resolves the old alert, and a later threshold on the new date raises again.

Entities:
* `bus_document`: with `busId`.
* `staff_document`: with `staffId`.
* `staff`: driver licence, or a missing licence.
* `bus`: missing bus document.

### `maintenance-due-scan` (06:45 school-local)

For each bus that is `active` or `maintenance`, the scan uses the **latest** non-deleted maintenance log of each
service type (service type compared case-insensitively; latest by service date, then creation time). Its
`next_due_date` / `next_due_km` are compared with the school-local day and `buses.last_known_odometer`.

| Stage | Rule | Severity | Key |
|---|---|---|---|
| due soon | due date within 7 days (`SERVICE_DUE_LEAD_DAYS`) or odometer within 500 km (`SERVICE_DUE_LEAD_KM`) of the due km | warning | `service_due:{logId}:due_soon` |
| overdue | due date before today or odometer ≥ due km; supersedes due soon | critical | `service_due:{logId}:overdue` |

Logging the service again (a newer log of the same type) resolves the alert. Details:
`{ stage, reason: date|km, serviceType, busCode, nextDueDate, nextDueKm, odometer, daysToDue, kmToDue, localDate }`.
Entity `maintenance_log`, with `busId`.

### `alert-escalation` (queue)

Described above under [Escalation recipients](#escalation-recipients).

### `alert-email-digest` (07:00 school-local)

BP §11.2 "optional email digest". Runs only when the school's `emailDigest` feature is in force
(`effective.features.emailDigest`: school flag, platform `email` module and plan modules). One e-mail per recipient
address of the school's `alertRecipients` (an **active** school admin's own e-mail and/or an explicit e-mail; entries
sharing an address are merged): the unresolved alerts (`open`, `escalated`) matching the entry's `minSeverity` /
`alertTypes`, most urgent first (at most 40 lines, counts cover all), `[new]` for those raised in the last 24 h, and a
link to `/school/alerts?status=open,escalated`. No e-mail when nothing matches. At most once per school, school-local
day and address (kv claim `alert-digest:{schoolId}:{day}:{addressHash}`, released when the send fails, so a retry
re-sends only failures). Audited as `alert.digest` (entity `school`, counts only). Exported as
`alertEmailDigest({ schoolId, localDate? }, { channels? })` from `modules/alerts/digest.ts`.

### Demo data

`npm run seed` runs the real `documentExpiryScan` and `maintenanceDueScan` once per demo school (seed
`80_alerts`, on the app pool under RLS, for the school-local day), so a fresh database already shows the
document alerts of the seeded fleet and staff — for example Greenwood `doc_expired` for R3 fitness and R6
pollution and `doc_expiring` for R2 insurance and R4 pollution. Re-running the seed raises nothing new. See
[`../SEED_DATA.md`](../SEED_DATA.md).
