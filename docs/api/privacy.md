# Privacy API — legal links, school branding, parent consent, export and erasure

Blueprint §16 ("Privacy law": parental consent, retention, deletion/export on request; "Store policies":
privacy policy URL per app), §13.1 (school branding on the sign-in page); [`../PRIVACY.md`](../PRIVACY.md) for
the roles and retention. Base `/api/v1`. Source: `backend/src/modules/privacy/`, migration
`backend/migrations/901_privacy.sql`; shared schemas and types: `backend/shared/src/schemas/privacy.ts`
(`@wimb/shared`).

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/auth/legal` | public | Platform privacy policy / terms links and the consent version |
| GET | `/auth/school/branding?code=` | public | Branding + legal links of an **active** school (sign-in screens) |
| GET | `/parent/consent` | parent | Consent state for every school the parent has an active child link in |
| POST | `/parent/consent` | parent + `X-School-Id` | Accept that school's current consent version |
| GET | `/school/privacy/students/:id/export` | school admin | Everything the school holds about one student (JSON) |
| POST | `/school/privacy/students/:id/erase` | school admin | Irreversible anonymisation of one student |
| GET | `/school/privacy/parents/:id/export` | school admin | Everything the school holds about one parent (JSON) |
| POST | `/school/privacy/parents/:id/erase` | school admin | Irreversible anonymisation of one parent within the school |

Ids of another school answer `404 NOT_FOUND`; drivers, conductors and parents get `403` on `/school/privacy/*`.
Parents are identified by the school's own parent id (`school_parents.id`, as in [students.md](students.md)); the
global parent account id never appears in any response.

## Legal links and consent version

Three platform settings (Super Admin, `PUT /platform/settings`, see [platform.md](platform.md)) with a per-school
override in `PUT /school/settings` (school admin, see [school.md](school.md)):

| Platform key | School field | Value |
|---|---|---|
| `legal.privacy_url` | `privacyPolicyUrl` | `https://` URL (max 500 characters) or `null` |
| `legal.terms_url` | `termsUrl` | `https://` URL or `null` |
| `legal.consent_version` | `consentVersion` | 1–32 letters, digits, `.`, `-`, `_` (default `"1"`) |

A school field set to `null` uses the platform value. Anything that is not an `https://` URL is refused with
`400 VALIDATION_ERROR` (the database refuses it too). **Changing the consent version** (platform or school) makes
`consentRequired` true again for every parent of the affected schools.

Where the apps find the links:

| Screen | Source |
|---|---|
| Parent app sign-in (no school yet), web `/platform/login` and `/school/login` without a known school code | `GET /auth/legal` |
| Driver app sign-in (school code typed) / web `/school/login?code=` (also `/login?school=`, or the code typed into the optional field) | `GET /auth/school/branding?code=` |
| Driver app Profile, web shell (school account menu) | `GET /auth/me` → `school.privacyUrl`, `school.termsUrl` |
| Parent app Settings, consent screen | `GET /auth/me` → `schools[].school.privacyUrl/termsUrl`, or `GET /parent/consent` |

### GET /auth/legal

Public, rate limited per IP (`publicLookup`: 120 / 15 min, shared with the branding lookup), `Cache-Control: public, max-age=60`.

```json
{ "success": true, "data": { "privacyUrl": "https://whereismybus.example.com/privacy", "termsUrl": null, "consentVersion": "1" } }
```

### GET /auth/school/branding?code=GWIS-BLR

Public, same rate limit and caching. `code` is case-insensitive (`gwis-blr` works); a malformed code → `400`.
Unknown, suspended, inactive and deleted schools all answer the same `404 NOT_FOUND` (no state oracle).

```json
{
  "success": true,
  "data": {
    "name": "Greenwood International School",
    "code": "GWIS-BLR",
    "logoUrl": "https://…signed, valid 5 minutes…",
    "brandColor": "#0A6ED1",
    "institutionType": "school",
    "privacyUrl": "https://greenwood.example.edu/privacy",
    "termsUrl": "https://whereismybus.example.com/terms"
  }
}
```

No ids, contacts or addresses are returned. The lookup is cached in the API process for 60 s (dropped early when
the school's status, profile or settings or a `legal.*` platform setting change); the logo URL is signed on every
request, so a cached answer never contains an expired link.

Web admin screens: Super Admin **Global settings → Privacy & legal** (the three platform keys) and School Admin
**School settings → Privacy & legal** (`/school/settings?tab=privacy`: the overrides with "Use platform value" and the
values in force). Both ask for confirmation before saving a change of the consent version in force.

## Parent consent

Each school is the data fiduciary for its children (DPDP Act s.9), so consent is recorded **per school**: one
record per school, parent and version, with the time, the links in force, the app name/version (`X-App-Name`,
`X-App-Version`), IP address and user agent. Records are written only through the API (a database function
checks the parent context and the active child link); parents read only their own, school admins read their
school's (export), nobody can change or delete them (erasure only nulls the IP address and user agent).

The API does **not** block other parent calls without consent: the parent app shows the consent screen (what is
collected, why, who sees it, links) whenever `consentRequired` is true — in the sign-in response and
`GET /auth/me` (`user.consentRequired`, per school `schools[].consent`) or `GET /parent/consent`.

### GET /parent/consent

No `X-School-Id` needed. `Cache-Control: no-store`.

```json
{
  "success": true,
  "data": {
    "consentRequired": true,
    "schools": [
      {
        "schoolId": "0193…", "schoolName": "Greenwood International School",
        "requiredVersion": "2", "acceptedVersion": "1", "acceptedAt": "2026-06-02T04:10:11.000Z",
        "consentRequired": true,
        "privacyUrl": "https://greenwood.example.edu/privacy", "termsUrl": null
      }
    ]
  }
}
```

`acceptedVersion` is the accepted record of the required version when there is one, otherwise the latest accepted
version (`null` = never). Reverting to a version the parent already accepted needs no new consent.

### POST /parent/consent

Headers: `X-School-Id` of a school with an active child link (else `400` / `403`). Body (unknown keys → `400`):

```json
{ "version": "2" }
```

→ `200` with that school's entry (as in the list above, `consentRequired: false`). Accepting the same version again
is idempotent (one record, one audit row `privacy.consent_accept` in the school's log with version and app). A
version that is no longer the school's current one → `409 CONFLICT`
`details { "reason": "CONSENT_VERSION_CHANGED", "requiredVersion": "3" }`: show the new text and accept that.

## Per-person export (school admins)

`GET /school/privacy/students/:id/export` and `GET /school/privacy/parents/:id/export` (`id` = the school's parent
id) also work for soft-deleted and erased records. Every export is audited (`privacy.export`, with the number of
items per section only). `Cache-Control: no-store`. The document is the `data` of the usual envelope; save it as
`privacy-export-<type>-<id>.json`.

```json
{
  "format": "wimb.privacy-export",
  "formatVersion": 1,
  "generatedAt": "2026-10-19T06:30:00.000Z",
  "school": { "id": "0193…", "code": "GWIS-BLR", "name": "Greenwood International School" },
  "subject": { "type": "student", "id": "0193…" },
  "data": { … sections below … },
  "notes": ["Times are ISO-8601 instants in UTC; dates … are school-local calendar dates; validTo is exclusive.", "…"]
}
```

**Student** sections:

| Section | Content |
|---|---|
| `profile` | `id, admissionNo, fullName, className, section, rollNo, notes, photoFileId, isActive, deletedAt, erasedAt, createdAt, updatedAt` |
| `files` | photos and other files filed under the student: `id, category, mime, sizeBytes, originalName, status, createdAt` (content via `GET /files/:id/url`) |
| `parents` | linked parents: `parentId, fullName, phone, email, relation, isPrimary, linkedAt` |
| `assignments` | every assignment row (history): `id, studentId, direction, validFrom, validTo, bus { id, code, registrationNo }, route { code, name }, stop { id, name }, createdAt` |
| `notificationPreferences` | per linked parent and direction: `parentId, studentId, direction, tripStarted, busLeftSchool, approachingStop, arrivedAtStop, tripDelayed, tripNotStarted, updatedAt` |
| `inbox` | in-app notifications about the child (every parent's copy): `id, parentId, studentId, tripId, kind, title, body, createdAt, readAt` |
| `notificationEvents` | what was sent about the child: `id, tripId, eventType, channel, status, createdAt, sentAt` |
| `consentRecords` | consent of the linked parents: `parentId, version, acceptedAt, privacyUrl, termsUrl, appName, appVersion` |
| `trips` | `{ total, truncated, items[] }` — school trips of the assigned bus in the assignment's direction and validity window, newest first, at most 5,000: `studentId, tripId, tripDate, direction, status, busCode, route { code, name }, plannedStartAt, startedAt, endedAt, stopEvent { stopName, arrivedAt, departedAt, dwellSeconds }` (the stop event at the child's stop) |

**Parent** sections: `profile` (`id, fullName, phone, email, relation, alternatePhone, displayName,
preferredLanguage, isActive, firstSignedInAt, deletedAt, erasedAt, createdAt, updatedAt`), `children`
(`studentId, admissionNo, fullName, className, section, relation, isPrimary, linkedAt`), `assignments` and `trips`
of those children (as above), `notificationPreferences`, `inbox` (the parent's inbox in this school), `consent`
(`requiredVersion, acceptedVersion, acceptedAt, consentRequired`) and `consentRecords` (as above plus `ip`,
`userAgent`, `redactedAt`).

Not part of the export: raw GPS points (they describe the bus, not the child — summarised by the trip rows), the
school's audit log, and anything other schools hold about the same parent.

Web admin: **Export data** on the Student and Parent object pages (header action and the *Data privacy* section)
saves this document under that name.

## Erasure (school admins)

`POST /school/privacy/students/:id/erase` and `POST /school/privacy/parents/:id/erase`. **Irreversible.** Body:

```json
{ "confirm": "ERASE", "reason": "Parent's written request of 2026-10-18" }
```

`confirm` must be exactly `ERASE` (else `400`); `reason` (optional, ≤ 500 characters) is stored in the audit row.
A second erase of the same record → `409 INVALID_STATE`. Response:

```json
{ "success": true, "data": { "subjectType": "student", "id": "0193…", "erasedAt": "2026-10-19T06:31:00.000Z", "filesDeleted": 1 } }
```

| | Student | Parent (within the school) |
|---|---|---|
| Anonymised | name → `Erased student`; admission no., class, section, roll no., notes, photo cleared; inactive + soft-deleted | name → `Erased parent`; e-mail, relation, alternate phone, first sign-in cleared; inactive + removed |
| Deleted | parent links (and their notification preferences), in-app inbox rows about the child, the photo files (object storage + file registry `status = deleted`) | links to children (and preferences), the parent's inbox in this school |
| Scrubbed | `notification_events.payload` of the child | IP address and user agent of the consent records (version and time stay as evidence) |
| Global identity | — (students exist in one school only) | phone → unique `+999…` placeholder, display name and password removed, account deactivated, every session revoked (sockets disconnected), push tokens and pending OTP codes removed — **only when no other school has a live link to the parent**; otherwise the other school's data and the parent's sign-in stay untouched |
| Kept (aggregate / audit integrity) | the row id (pseudonymous), assignment history (bus / route / stop / dates; open ones end today), trips, stop events, GPS points, alerts, reports, the audit trail | the row id, trips, the audit trail |

Web admin: **Erase personal data** on the Student and Parent object pages opens a dialog that lists what is erased and
what is kept (the "Kept" row above), offers the export first, takes the optional reason and enables the action only
once `ERASE` is typed; afterwards the page shows the result (time, files deleted) instead of the record, which now
answers `404`.

The response is identical whether or not the parent's global identity was anonymised, so it never reveals that
another school knows the number. Every erasure is audited as `privacy.erase` with counts only (links removed,
notifications deleted, files deleted, consents redacted, the optional reason) — no personal data. Older audit
rows are not rewritten (the audit log is insert-only); bulk files that mention many people (CSV imports, generated
reports) are not rewritten either. A parent registered again later with the same number is a new registration.
