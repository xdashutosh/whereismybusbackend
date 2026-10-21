# School API (profile, settings, holidays, announcements)

Blueprint §8.3 (Profile/Settings), §13.3 (Settings), §20 #2/#4/#6; contract §8/§9. Base `/api/v1`.
Source: `backend/src/modules/school/`. Shared schemas/DTOs: `backend/shared/src/schemas/school.ts`
(`@wimb/shared`: `schoolSettingsBody`, `parentVisibilityBody`, `DEFAULT_PARENT_VISIBILITY`,
`PARENT_VISIBILITY_FIELDS`, `createHolidayBody`, `createAnnouncementBody`, `SchoolSettingsDto`, …).

Every endpoint: **school admin** of an active school (token → school; `school_id` in bodies is ignored).
Drivers, conductors, parents → `403`; another school's ids → `404`. Every write is audited in the
same transaction (`GET /school/audit-logs`).

## Profile

### `GET /school/profile`

```json
{ "success": true, "data": {
  "id": "01a1…", "code": "GWIS-BLR", "name": "Greenwood International School", "institutionType": "school",
  "address": "14, 80 Feet Road, Koramangala 4th Block", "city": "Bengaluru", "state": "Karnataka", "pincode": "560034",
  "contactName": "Meera Iyer", "contactPhone": "+918041234567", "contactEmail": "office@greenwood.example",
  "logoFileId": "01a1…", "logoUrl": "https://…signed (300 s)…", "brandColor": "#1B7F3B",
  "location": { "lat": 12.933756, "lng": 77.62275 }, "geofenceRadiusM": 150, "timezone": "Asia/Kolkata",
  "status": "active",
  "subscription": { "plan": "standard", "status": "active", "maxBuses": 50, "maxStudents": 2000, "validFrom": "2026-06-01", "validUntil": null },
  "createdAt": "…", "updatedAt": "…" } }
```

### `PATCH /school/profile`

Any subset of: `name`, `address`, `city`, `state`, `pincode`, `contactName`, `contactPhone` (any
spelling → E.164), `contactEmail`, `logoFileId`, `brandColor` (`#RRGGBB`), `location` (`{ lat, lng }`
or `null`), `geofenceRadiusM` (20–5000), `timezone` (IANA). `""`/`null` clears optional fields.

```json
{ "contactPhone": "98450 12345", "location": { "lat": 12.9698, "lng": 77.75 }, "logoFileId": "01a1…" }
```
→ `200` with the profile. Rules:
* `code` is the staff sign-in code and **never changes** (`400`, `details[0].path = "code"`);
  `status`, `institutionType` and tenant fields are platform-controlled and silently ignored.
* Logo: upload first with `POST /files/upload` (`category=school_logo`, no `entityId`), then send its
  id. The file must be an uploaded `school_logo` of this school, otherwise `400` (`path: logoFileId`).
  `null` removes the logo. `/auth/me` returns the signed `school.logoUrl` for every member of the school.
* A timezone change is applied to the request context immediately (school-local dates, jobs).
* Emits `school.profile_changed` `{ schoolId, changedFields }` after commit.

## Settings

### `GET /school/settings`

```json
{ "success": true, "data": {
  "allowNonSchoolTrips": false, "allowBackupDriverStart": true, "odometerGalleryAllowed": false,
  "odometerMismatchThresholdKm": 5, "odometerGpsVariancePct": 15, "odometerGpsMinKm": 2,
  "tripNotStartedGraceMin": 10, "tripDelayThresholdMin": 10, "staleTripCloseHours": null,
  "stopDurationAlertMin": 10, "speedLimitKmh": 50, "enableSpeedingAlert": true,
  "enableHarshDrivingAlert": false, "enableRouteDeviationAlert": false, "routeDeviationM": 300,
  "approachingStopMinutes": 5, "notifyTripNotStarted": true,
  "alertRecipients": [
    { "userId": "01a1…", "name": null, "email": null, "phone": null, "minSeverity": "warning", "alertTypes": null },
    { "userId": null, "name": "Transport manager", "email": null, "phone": "+919845000999", "minSeverity": "critical", "alertTypes": ["speeding", "route_deviation"] }
  ],
  "locationMovingIntervalS": null, "locationStoppedIntervalS": null, "movingSpeedKmh": null, "stoppedAfterS": null,
  "documentReminderDays": null, "locationRetentionMonths": null,
  "privacyPolicyUrl": null, "termsUrl": null, "consentVersion": null,
  "features": { "sms": false, "whatsapp": false, "emailDigest": false, "etaV2": false, "routeDeviation": true,
                "speeding": true, "harshDriving": false, "reports": true, "announcements": true },
  "effective": { "movingIntervalS": 10, "stoppedIntervalS": 90, "movingSpeedKmh": 4, "stoppedAfterS": 60,
                 "documentReminderDays": [60, 30, 15, 7, 1], "staleTripCloseHours": 3, "locationRetentionMonths": 12,
                 "features": { "sms": false, "routeDeviation": true, "announcements": true, "…": "…" } },
  "platformDefaults": { "movingIntervalS": 10, "stoppedIntervalS": 90, "movingSpeedKmh": 4, "stoppedAfterS": 60,
                        "documentReminderDays": [60, 30, 15, 7, 1], "staleTripCloseHours": 3, "locationRetentionMonths": 12,
                        "features": { "etaV2": false, "routeDeviation": true, "speeding": true, "harshDriving": false,
                                      "reports": true, "announcements": true, "sms": false, "whatsapp": false, "emailDigest": true } },
  "legal": { "effective": { "privacyUrl": "https://whereismybus.example.com/privacy", "termsUrl": null, "consentVersion": "1" },
             "platform":  { "privacyUrl": "https://whereismybus.example.com/privacy", "termsUrl": null, "consentVersion": "1" } },
  "updatedAt": "…", "updatedBy": "01a1…" } }
```

* `location*`, `movingSpeedKmh`, `stoppedAfterS`, `documentReminderDays`, `staleTripCloseHours`:
  `null` = platform default; `effective` holds the value in force.
* `locationRetentionMonths` (BP §12, migration 800): months of raw GPS history kept for this school. `null` = the
  platform value (`location.retention_months`, now a public platform setting). A school may keep **fewer** months,
  never more: `platformDefaults.locationRetentionMonths` is the maximum and `effective.locationRetentionMonths` =
  min(override, platform). The daily partition-maintenance job drops whole months at the platform cutoff and deletes
  this school's older points at its own cutoff (month boundaries). End to end (migration 926): before any point is
  purged, every trip about to lose its raw points that has no simplified path yet (e.g. cancelled while running) gets
  it stored in `trips.summary.path` (BP §9.6 "downsample to a simplified polyline"; the trip page keeps the driven
  path), and the coordinates of the trip's device events (`trip_device_events`, the trip timeline) are cleared at the
  same cutoff. A stale override above a lowered platform value counts as the platform value
  (`location_retention_cutoffs()`). Replaced documents and uploaded files are **not** purged — they are kept for audit
  (product decision); the trip start/end and odometer-evidence coordinates are trip evidence and stay with the trip.
* `privacyPolicyUrl`, `termsUrl`, `consentVersion` (BP §16, migration 901): the school's own privacy policy / terms
  links and parent consent text version; `null` = the platform value (`legal.*` platform settings). `legal.effective`
  holds the values in force (shown by the apps: `/auth/school/branding`, `/auth/me`, `/parent/consent`) and
  `legal.platform` the platform values behind them. **Changing `consentVersion` asks every parent of the school to
  consent again** (see [privacy.md](privacy.md)).
* **Features**: the school's own flags. A feature is in force (`effective.features`) only when the school
  enables it **and** the platform does not disable it (platform `features`; `sms` / `whatsapp` /
  `emailDigest` also need the platform notification module `sms` / `whatsapp` / `email`) **and** the school's active
  subscription does not switch it off: plan `modules` set to `false` disable `sms`, `whatsapp`, `emailDigest` (`email` or
  `email_digest`), `reports`, `announcements`, `etaV2` (`eta_v2`), `routeDeviation`, `speeding`, `harshDriving`
  (missing key = allowed). `features` keeps the school's own choice; `platformDefaults.features` shows the platform +
  plan narrowing.

### `PUT /school/settings`

Partial update — omitted fields keep their value, `null` resets an override. Ranges:

| Field | Range |
|---|---|
| `odometerMismatchThresholdKm` | 0–500 (decimal) |
| `odometerGpsVariancePct` · `odometerGpsMinKm` | 0–100 |
| `tripNotStartedGraceMin` | 0–240 (integer) |
| `tripDelayThresholdMin` · `stopDurationAlertMin` | 1–240 |
| `staleTripCloseHours` | 1–48 or `null` |
| `speedLimitKmh` | 10–150 or `null` |
| `routeDeviationM` | 50–5000 |
| `approachingStopMinutes` | 1–60 |
| `locationMovingIntervalS` | 10–300 or `null` (hard 10-s floor) |
| `locationStoppedIntervalS` | 60–120 or `null` (BP §9.1) |
| `locationRetentionMonths` | 1–60 and ≤ the platform `location.retention_months`, or `null` |
| `movingSpeedKmh` | 0.5–30 or `null` · `stoppedAfterS` 15–600 or `null` |
| `privacyPolicyUrl` · `termsUrl` | `https://` URL (≤ 500 characters) or `null` |
| `consentVersion` | 1–32 letters, digits, `.`, `-`, `_`, or `null` |
| `documentReminderDays` | 1–10 unique days (1–365), stored newest-first, or `null` |
| `features` | any subset of the flags above (merged) |
| `alertRecipients` | up to 20 (replaces the list) |
| booleans | `allowNonSchoolTrips`, `allowBackupDriverStart`, `odometerGalleryAllowed`, `enableSpeedingAlert`, `enableHarshDrivingAlert`, `enableRouteDeviationAlert`, `notifyTripNotStarted` |

Cross-field rules (on the effective values, `400` with the field path): the stopped interval must not
be shorter than the moving interval (`locationStoppedIntervalS`); speeding alerts need a speed limit
(`speedLimitKmh`).

Alert recipient: `userId` (an **active school admin of this school**) or `email` or `phone` (E.164,
normalised); `minSeverity` `info|warning|critical` (default `warning`); `alertTypes` (subset of the
alert catalogue, `null` = all). Duplicates → `400` (`alertRecipients[i]`).

```json
{ "speedLimitKmh": 50, "enableSpeedingAlert": true, "features": { "harshDriving": true },
  "alertRecipients": [{ "userId": "01a1…" }, { "email": "transport@greenwood.example", "minSeverity": "critical" }] }
```
→ `200` with the full settings. Audit `school_settings.update` (changed fields, before/after).
Emits `school.settings_changed` `{ schoolId, changedFields }` after commit.

### `GET /school/settings/parent-visibility`

```json
{ "success": true, "data": {
  "matrix": {
    "bus": { "capacity": false, "images": true, "plate": true, "insuranceStatus": true, "insuranceFile": false, "fitnessStatus": true, "fitnessFile": false },
    "driver": { "photo": true, "phone": false, "email": false, "experience": true, "licenceValidity": true, "licenceFile": false,
                "training": true, "characterCertStatus": true, "verification": true },
    "conductor": { "photo": true, "phone": false, "email": false, "experience": true, "verification": true, "characterCertStatus": true, "training": true }
  },
  "defaults": { "…": "BP §6.2 default matrix (same shape) for a 'restore defaults' action" },
  "updatedAt": "…" } }
```

### `PUT /school/settings/parent-visibility`

Any subset of sections/fields (booleans), merged over the current matrix; unknown keys are ignored.
A document file can only be visible together with its status: `bus.insuranceFile` needs
`bus.insuranceStatus`, `bus.fitnessFile` needs `bus.fitnessStatus`, `driver.licenceFile` needs
`driver.licenceValidity` (`400` with that path). → `200` with the new matrix; audit
`school_settings.parent_visibility_update` lists every changed cell. Stored in
`school_settings.parent_visibility` with snake_case keys (`insurance_status`, …).

```json
{ "driver": { "phone": true }, "bus": { "insuranceFile": true } }
```

Parent-facing modules apply the matrix with `loadParentVisibility(tx)` (below); the parent DTOs and
file hooks must hide every field that is `false`.

## Holidays

The holiday calendar suppresses trip generation and "trip not started" alerts (contract §8). Dates are
school-local calendar days; `endDate` is **inclusive**. `appliesTo`: `all` (default), `morning` or
`afternoon` (only that direction's trips are skipped).

### `GET /school/holidays`

| Query | Meaning |
|---|---|
| `page`, `limit` | pagination (default 20, max 100) |
| `sort` | `startDate` (default), `endDate`, `name`, `createdAt` (`-` = descending) |
| `from`, `to` | holidays overlapping this inclusive range (`YYYY-MM-DD`) |
| `year` | calendar-year shortcut (intersected with `from`/`to`) |
| `appliesTo` | `all` · `morning` · `afternoon` |
| `q` | name contains |
| `format` | `json` (default) · `csv` (`holidays.csv`: Name, Start date, End date, Days, Applies to) |

```json
{ "success": true, "data": [
  { "id": "01a1…", "name": "Diwali break", "startDate": "2026-11-08", "endDate": "2026-11-10", "appliesTo": "all", "days": 3,
    "createdBy": "01a1…", "createdAt": "…", "updatedAt": "…" }
], "meta": { "page": 1, "limit": 20, "total": 6, "totalPages": 1 } }
```

### `POST /school/holidays` (optional `Idempotency-Key`)

```json
{ "name": "Winter break", "startDate": "2026-12-24", "endDate": "2027-01-01", "appliesTo": "all" }
```
→ `201` with the holiday. `endDate` defaults to `startDate`; it must not be before `startDate`; a
holiday spans at most 366 days (`400`, `path: endDate`). The same name (case-insensitive) starting on
the same day → `409 DUPLICATE`. Audit `holiday.create`.

### `GET /school/holidays/:id` · `PATCH /school/holidays/:id` · `DELETE /school/holidays/:id`

`PATCH` takes any subset of the create fields; the merged range is validated (moving `startDate` past
the old end moves a one-day holiday along). `DELETE` → `200 { "id", "deleted": true }` (the row is removed; the audit log keeps
its values). Audit `holiday.update` / `holiday.delete`.

## Announcements

School → drivers / parents broadcasts (BP §20 #6). Publish window `[publishedAt, expiresAt)`;
`state` is derived: `scheduled` (publishedAt in the future), `active`, `expired`. Parents see active
announcements for `parents`/`all` (RLS); drivers/conductors for `drivers`/`all`.

### `GET /school/announcements`

| Query | Meaning |
|---|---|
| `sort` | `publishedAt` (default `-publishedAt`), `expiresAt`, `title`, `createdAt`, `isPinned` |
| `state` | `scheduled,active,expired` (comma-separated) |
| `audience` | `drivers` · `parents` · `all` (exact) |
| `pinned` | `true` / `false` |
| `q` | title or body contains |
| `format` | `json` · `csv` (`announcements.csv`) |

```json
{ "success": true, "data": [
  { "id": "01a1…", "title": "Live bus tracking is now available", "body": "Track your child’s bus live …",
    "audience": "parents", "isPinned": true, "publishedAt": "2026-10-16T04:30:00.000Z", "expiresAt": null,
    "state": "active", "createdBy": "01a1…", "createdByName": "Meera Iyer", "createdAt": "…", "updatedAt": "…" }
], "meta": { "page": 1, "limit": 20, "total": 4, "totalPages": 1 } }
```

### `POST /school/announcements` (optional `Idempotency-Key`)

```json
{ "title": "Parent-teacher meeting on Saturday", "body": "Morning buses run 30 minutes later.", "audience": "all",
  "isPinned": false, "publishedAt": "2026-10-24T02:30:00Z", "expiresAt": "2026-10-26T00:00:00Z" }
```
→ `201`. `title` 1–200, `body` 1–5000, `audience` default `all`, `publishedAt` default now (a future
time schedules it), `expiresAt` optional, after `publishedAt` and in the future (`400`, `path:
expiresAt`). Requires the `announcements` feature in force (`effective.features.announcements`),
otherwise `403 FORBIDDEN` with `details: { reason: "FEATURE_DISABLED", feature: "announcements" }`.
Audit `announcement.create`.

Emits **`announcement.published`** after commit — the notifications module fans it out (push + parent
inbox, drivers' app):
```json
{ "schoolId": "01a1…", "announcementId": "01a1…", "audience": "all", "title": "…", "isPinned": false,
  "publishedAt": "2026-10-24T02:30:00.000Z", "expiresAt": "2026-10-26T00:00:00.000Z", "scheduled": true }
```
`scheduled: true` → deliver at `publishedAt`, not now.

### `GET /school/announcements/:id` · `PATCH /school/announcements/:id` · `DELETE /school/announcements/:id`

`PATCH`: any subset of the create fields (`expiresAt: null` removes the end); the merged window is
validated. `DELETE` → `200 { "id", "deleted": true }` (soft delete = withdrawn). Both emit **`announcement.changed`** (same
payload + `change: "updated" | "deleted"`, `changedFields`) so pending deliveries can be refreshed or
cancelled. Audit `announcement.update` / `announcement.delete`.

## For other modules (`backend/src/modules/school/index.ts`)

All helpers run inside the caller's transaction and read the **current** school through RLS (admin,
staff, parent or `withSchoolSystem` contexts):

| Helper | Returns |
|---|---|
| `loadSchoolSettings(tx)` | `SchoolSettingsDto` (thresholds, `effective` intervals/features, recipients) |
| `loadParentVisibility(tx)` | complete camelCase matrix (BP defaults fill gaps) — works in the parent context |
| `isFeatureEnabled(tx, key)` | feature in force (`'announcements'`, `'sms'`, `'etaV2'`, …) |
| `holidaysOn(tx, localDate, direction?)` · `isSchoolHoliday(tx, localDate, direction?)` | holidays covering a school-local date (`direction` `morning`/`afternoon`; omitted = any) |
| `visibleAnnouncements(tx, 'drivers' \| 'parents', limit = 20)` | published, unexpired announcements for that audience (pinned first) |

Events (typed in `school/events.ts`, emitted after commit): `announcement.published`,
`announcement.changed`, `school.settings_changed`, `school.profile_changed`.
