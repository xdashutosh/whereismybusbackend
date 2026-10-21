# Buses API

Blueprint §6.2 (fleet), §8.3 (Buses, Bus documents), §12 (files), §13.3 (Buses screen); contract §5, §9.
Base `/api/v1`. Source: `backend/src/modules/buses/`; shared Zod schemas and DTO types:
`backend/shared/src/schemas/buses.ts` (`@wimb/shared`).

* **School admins only** (`/school/*` area guard + route guard). Drivers, conductors and parents get `403`.
* Ids of another school answer `404 NOT_FOUND` on every endpoint; `school_id` in a body is ignored (the school
  always comes from the token).
* Every write is audited in the same transaction (`bus.create`, `bus.update`, `bus.status_change`, `bus.delete`,
  `bus.assign_staff`, `bus_image.add|update|reorder|delete`, `bus_document.create|replace|update|visibility|verify|delete`).
* Creates accept `Idempotency-Key` (`POST /school/buses`, `POST …/images`, `POST …/documents`, `PUT /school/bus-documents/:docId`).
* Files (images, document scans) are uploaded first through the files module (`POST /files/upload` on the web,
  `POST /files/upload-url` + `complete` on mobile — see [files.md](files.md)) with category `bus_image` /
  `bus_document`, `entityType: "bus"` and the bus id; the returned `fileId` is then linked here.

| Method | Path | Purpose |
|---|---|---|
| GET | `/school/buses` | List (filters, sort, pagination, `format=csv`) |
| POST | `/school/buses` | Create |
| GET | `/school/buses/:id` | Detail: bus + images + current staff + current documents |
| PATCH | `/school/buses/:id` | Edit (partial) |
| DELETE | `/school/buses/:id` | Soft delete |
| PATCH | `/school/buses/:id/status` | Change status (`active`, `maintenance`, `retired`, `inactive`) |
| GET | `/school/buses/:id/images` | Gallery |
| POST | `/school/buses/:id/images` | Link an uploaded image |
| PUT | `/school/buses/:id/images/order` | Reorder the gallery |
| PATCH | `/school/buses/:id/images/:imageId` | Caption / sort order |
| DELETE | `/school/buses/:id/images/:imageId` | Remove an image |
| POST | `/school/buses/:id/assign-staff` | Primary/backup driver, conductor, backup conductor |
| GET | `/school/buses/:id/assignment-history` | Assignment history (`format=csv`) |
| GET | `/school/buses/:id/documents` | Documents (current; `includeHistory=true` adds replaced versions) |
| POST | `/school/buses/:id/documents` | Add a document |
| GET | `/school/bus-documents/:docId` | Document + all its versions |
| PUT | `/school/bus-documents/:docId` | Replace (new current version, history kept) |
| PATCH | `/school/bus-documents/:docId` | Correct metadata of this version |
| PATCH | `/school/bus-documents/:docId/visibility` | Parent visibility flags |
| PATCH | `/school/bus-documents/:docId/verify` | Verification status |
| DELETE | `/school/bus-documents/:docId` | Soft delete |

## Bus object

```json
{
  "id": "0199f2a4-…", "code": "R1", "displayName": "Route 1 Bus", "vehicleType": "bus",
  "makeModel": "Tata Starbus Ultra", "manufactureYear": 2021, "color": "Yellow", "capacity": 40,
  "registrationNo": "KA01AB1201", "fuelType": "diesel", "status": "active",
  "lastKnownOdometer": 48210.4, "odometerUpdatedAt": "2026-10-18T02:10:00.000Z", "notes": null,
  "primaryDriverName": "Ravi Kumar", "conductorName": "Lakshmi Devi",
  "imageCount": 2, "coverThumbnailUrl": "https://…signed…", "expiredDocuments": 0, "expiringDocuments": 1,
  "hasActiveTrip": false, "createdAt": "…", "updatedAt": "…"
}
```
`vehicleType`: `bus` `mini_bus` `van` `car` `other` · `fuelType`: `diesel` `petrol` `cng` `electric` `hybrid` `other`.
`expiredDocuments` / `expiringDocuments` count **current** documents whose expiry date is before today /
within the next 30 days (school-local date). `coverThumbnailUrl` is a presigned URL (≤ 300 s) of the first image.

## `GET /school/buses`

Query: `page`, `limit` (1–100, default 20), `sort` (`code` default; `displayName`, `registrationNo`, `capacity`,
`status`, `fuelType`, `vehicleType`, `lastKnownOdometer`, `createdAt`, `updatedAt`, `-field` descending),
`q` (code, name, make/model, registration — spaces/hyphens in plates ignored), `status` (comma list),
`fuelType` (comma list), `vehicleType` (comma list), `hasPrimaryDriver` (`true|false`),
`documentStatus` (`expired|expiring`), `format=csv`.

```
GET /api/v1/school/buses?status=active,maintenance&q=ka01&sort=-capacity&page=1&limit=20
```
`200` → `{ "success": true, "data": [ <Bus>, … ], "meta": { "page": 1, "limit": 20, "total": 6, "totalPages": 1 } }`.
`format=csv` streams `buses.csv` (UTF-8 BOM, formula-injection guard, max 10 000 rows) with columns
Code, Name, Type, Registration, Capacity, Fuel, Status, Make / model, Year, Colour, Odometer (km),
Primary driver, Conductor, Expired documents, Expiring documents, On trip, Created (UTC).

## `POST /school/buses`

```json
{
  "code": "R9", "displayName": "Green Van", "vehicleType": "van", "makeModel": "Tata Winger EV",
  "manufactureYear": 2024, "color": "Green", "capacity": 14, "registrationNo": "ka-05 mn 4321",
  "fuelType": "electric", "status": "active", "lastKnownOdometer": 1200, "notes": "Spare for R5"
}
```
Required: `code` (1–40 chars, unique among the school's live buses) and `registrationNo` (stored upper-cased
without spaces, hyphens or dots → `KA05MN4321`; 4–20 letters/digits; unique per school). `capacity` 1–200,
`manufactureYear` 1980–2100, `lastKnownOdometer` ≥ 0 (sets `odometerUpdatedAt`). `201` → the Bus object.

Errors: `400` validation · `409 DUPLICATE` "A bus with this code already exists." / "A bus with this registration
number already exists." · `403 FORBIDDEN` with
`details { "reason": "SUBSCRIPTION_LIMIT", "resource": "buses", "limit": 10, "used": 10, "adding": 1 }` when the
school's active subscription limit (`max_buses`) is reached. Every non-deleted bus counts (retired ones too — the
same rule as the Super Admin usage view); delete a retired bus to free its slot. Enforced by the platform module's
`assertSubscriptionCapacity()` under a per-school lock.
The same code or plate may exist in another school.

## `GET /school/buses/:id`

`200` → the Bus object plus:
```json
{
  "activeTripId": null,
  "images": [ <BusImage>, … ],
  "staff": {
    "primaryDriver": { "assignmentId": "…", "staffId": "…", "fullName": "Ravi Kumar", "phone": "+919845000101", "validFrom": "…" },
    "backupDriver": null,
    "conductor": { "assignmentId": "…", "staffId": "…", "fullName": "Lakshmi Devi", "phone": "+919845000102", "validFrom": "…" },
    "backupConductor": null
  },
  "documents": [ <BusDocument>, … ]
}
```

## `PATCH /school/buses/:id`

Any subset of the create fields (at least one). Empty strings clear optional text. Changing `status` here follows
the rules of the status endpoint. `200` → the Bus object; the audit entry holds only the changed fields.

## `PATCH /school/buses/:id/status`

```json
{ "status": "maintenance", "reason": "Brake service" }
```
* Moving away from `active` while the bus is on a trip (`in_progress`) → `409 INVALID_STATE`
  (`details.activeTripId`).
* Leaving `retired` needs no new plan slot (a retired bus already counts towards `max_buses`).
* The same status is a no-op. `200` → the Bus object; `reason` is kept in the audit trail.

## `DELETE /school/buses/:id`

Soft delete (`deleted_at`); trips, documents, images and assignment history stay for reports and audit.
* Bus on a trip → `409 INVALID_STATE`.
* Current or future student assignments or live schedules on the bus → `409 CONFLICT`
  `details { "studentAssignments": 3, "schedules": 1 }` (move them first).
* Otherwise, in one transaction: open staff and route assignments are closed now, not-yet-started (`scheduled`)
  trips are cancelled (`cancel_reason = "Bus deleted"`), and the code/plate become free for a new bus.

`200` → `{ "success": true, "data": { "id": "…", "deleted": true } }`.

## Images

Upload the picture with the files module first (JPEG/PNG/WebP ≤ 5 MB; EXIF/GPS stripped, WebP thumbnail made):
```
curl -X POST /api/v1/files/upload -H "Authorization: Bearer …" -F category=bus_image -F entityId=<busId> -F "file=@front.jpg"
```

### `POST /school/buses/:id/images`
```json
{ "fileId": "0199f2b0-…", "caption": "Front view", "sortOrder": 0 }
```
`sortOrder` is optional (default: after the last image). `201`:
```json
{ "success": true, "data": { "id": "…", "busId": "…", "fileId": "0199f2b0-…", "caption": "Front view", "sortOrder": 0,
  "contentType": "image/jpeg", "url": "https://…signed…", "thumbnailUrl": "https://…signed…", "createdAt": "…" } }
```
`url` / `thumbnailUrl` are presigned GETs valid ≤ 300 s (request the list again, or `GET /files/:fileId/url`, for fresh
ones). Errors: `404` file or bus not in this school · `400` (`fileId`) not a `bus_image` upload of this bus ·
`409 INVALID_STATE` upload not completed · `409 CONFLICT` file already attached, or 12 images already
(`details.maxImages`).

### `GET /school/buses/:id/images`
`200` → `[ <BusImage>, … ]` ordered by `sortOrder`.

### `PUT /school/buses/:id/images/order`
```json
{ "imageIds": ["…third…", "…first…", "…second…"] }
```
Must list every image of the bus exactly once (`400` otherwise); sort orders become 0, 1, 2, … `200` → the gallery.

### `PATCH /school/buses/:id/images/:imageId`
`{ "caption": "Side view" }` and/or `{ "sortOrder": 3 }` → `200` the image.

### `DELETE /school/buses/:id/images/:imageId`
Unlinks the image, marks its file `deleted` and removes the stored objects. `200` → `{ "id": "…", "deleted": true }`.

## Staff assignment

### `POST /school/buses/:id/assign-staff`
```json
{
  "primaryDriverId": "0199…", "backupDriverId": null, "conductorId": "0199…",
  "effectiveFrom": "2026-10-18T05:30:00+05:30", "note": "New term roster"
}
```
Each of `primaryDriverId`, `backupDriverId`, `conductorId`, `backupConductorId` is optional (at least one):
* an id **replaces** the open assignment of that role — the previous one is closed at `effectiveFrom` and stays in
  the history (a bus has at most **one open primary driver**; the database enforces it with `one_primary_driver`);
* `null` **unassigns** the role; the id that already holds the role is a no-op (`"action": "unchanged"`);
* a staff member already holding another role on this bus leaves it (`"action": "moved_out"`), so promoting the
  backup driver or swapping two people works in one request.

Rules: drivers only for driver roles and conductors only for conductor roles (`400` on the field), staff must be
live and active (`404` / `409 INVALID_STATE`), the same person cannot be given twice (`400`), a retired bus gets no
new assignments (`409 INVALID_STATE`; unassigning still works). `effectiveFrom` defaults to now, cannot be in the
future and cannot be before the start of an assignment it closes (`400`).

`200`:
```json
{
  "success": true,
  "data": {
    "staff": { "primaryDriver": { "assignmentId": "…", "staffId": "…", "fullName": "Ravi Kumar", "phone": "+919845000101", "validFrom": "…" },
               "backupDriver": null, "conductor": { … }, "backupConductor": null },
    "changes": [
      { "role": "primary_driver", "action": "assigned", "staffId": "…", "previousStaffIds": ["…"] },
      { "role": "backup_driver", "action": "unassigned", "staffId": null, "previousStaffIds": ["…"] }
    ],
    "effectiveFrom": "2026-10-18T05:30:00+05:30"
  }
}
```

### `GET /school/buses/:id/assignment-history`
Query: `page`, `limit`, `sort` (`-validFrom` default; `validTo`, `role`, `staffName`, `createdAt`), `role` (comma list),
`staffId`, `current` (`true` open / `false` closed), `format=csv`.
```json
{ "success": true, "data": [
  { "id": "…", "role": "primary_driver", "staffId": "…", "staffName": "Ravi Kumar", "staffType": "driver",
    "validFrom": "2026-09-18T02:00:00.000Z", "validTo": null, "isCurrent": true,
    "createdBy": "…", "createdByName": "Meera Iyer", "createdAt": "…" }
], "meta": { "page": 1, "limit": 20, "total": 5, "totalPages": 1 } }
```
Windows are half-open: `validFrom` inclusive, `validTo` exclusive (`null` = open).

## Documents

Types: `insurance`, `fitness`, `pollution`, `permit`, `rc`, `safety_inspection` (one **current** version per bus each)
and `other` (any number). Upload the scan first (`category=bus_document`, JPEG/PNG/WebP/PDF ≤ 10 MB).

### BusDocument object
```json
{
  "id": "…", "busId": "…", "docType": "insurance", "title": "Comprehensive policy", "issuer": "New India Assurance",
  "docNumber": "POL-77", "startDate": "2026-01-01", "expiryDate": "2026-11-02",
  "expiryStatus": "expiring", "daysToExpiry": 15,
  "file": { "id": "…", "fileName": "policy.pdf", "contentType": "application/pdf", "sizeBytes": 182233, "hasThumbnail": false },
  "verificationStatus": "verified", "verifiedBy": "…", "verifiedByName": "Meera Iyer", "verifiedAt": "…", "verificationNote": null,
  "visibleToParentsStatus": true, "visibleToParentsFile": false,
  "isCurrent": true, "replacedBy": null, "createdAt": "…", "updatedAt": "…"
}
```
`expiryStatus`: `expired` (before today), `expiring` (within 30 days), `valid`, `none` (no expiry date) — computed
against the school-local date. Open the scan with `GET /files/:file.id/url`.

### `GET /school/buses/:id/documents`
Query: `docType` (comma list), `includeHistory` (`true` adds replaced versions). Ordered by type, current first,
newest first. `200` → `[ <BusDocument>, … ]`.

### `POST /school/buses/:id/documents`
```json
{ "docType": "insurance", "title": "Comprehensive policy", "issuer": "New India Assurance", "docNumber": "POL-77",
  "startDate": "2026-01-01", "expiryDate": "2026-12-31", "fileId": "…",
  "visibleToParentsStatus": true, "visibleToParentsFile": false }
```
Only `docType` is required; parents see the validity by default but not the file — and only once the document is
**verified** (a new document starts as `pending`, see [parent visibility](#file-access-and-parent-visibility)).
`201` → BusDocument.
Errors: `409 CONFLICT` a current document of that type exists (`details.documentId` — replace it instead) ·
`400` (`fileId`) not a `bus_document` upload of this bus, or `expiryDate` before `startDate` · `404` file of another
school · `409` file not completed or already attached.

### `PUT /school/bus-documents/:docId` — replace (renewal)
Same fields as create without `docType`. Creates a **new current version** (`201`); the replaced row keeps its data
and file with `isCurrent: false` and `replacedBy` → the new id. `fileId` omitted keeps the previous file, `null`
removes it; visibility flags default to the previous version's; verification starts again at `pending`, so parents
see nothing of the renewal (validity or file) until it is verified — the verdict on the replaced version never
carries over. Replacing a non-current version → `409 INVALID_STATE` (`details.replacedBy`).

### `GET /school/bus-documents/:docId`
`200` → BusDocument plus `versions`: every version linked through `replacedBy` (older and newer), newest first.

### `PATCH /school/bus-documents/:docId` — corrections
`title`, `issuer`, `docNumber`, `startDate`, `expiryDate` (at least one) on the same version (no new history row).

### `PATCH /school/bus-documents/:docId/visibility`
`{ "visibleToParentsStatus": true, "visibleToParentsFile": true }` (either or both). What parents finally see also
depends on the school settings and on the document's verification (see [parent visibility](#file-access-and-parent-visibility)).

### `PATCH /school/bus-documents/:docId/verify`
`{ "status": "verified" | "rejected" | "pending", "note": "…" }` — `note` is required for `rejected`; `pending`
clears `verifiedBy`/`verifiedAt`. Only `verified` documents reach parents; `rejected` or `pending` takes the document
(and its file) out of the parent view at once.

### `DELETE /school/bus-documents/:docId`
Soft delete (the file is kept for audit). `200` → `{ "id": "…", "deleted": true }`.

## File access and parent visibility

The buses module registers file hooks for `bus_image` and `bus_document` (`GET /files/:id/url`):

| Principal | `bus_image` | `bus_document` |
|---|---|---|
| school_admin | every file of the school | every file of the school |
| driver / conductor | images of a live bus they are assigned to now | files of **current** documents of such a bus (bus papers on the road) |
| parent (`X-School-Id`) | images of their child's bus while `parent_visibility.bus.images` is on | current, **verified** document with `visibleToParentsFile` **and**, for insurance/fitness, `parent_visibility.bus.insurance_file` / `fitness_file` (never for `pending`/`rejected` documents or replaced versions, even with every flag on) |

The parent view of a bus (for the parent module's `GET /parent/children/:studentId/bus`) is built by
`parentBusView(req, tx, busId)` from `modules/buses/index.ts`, inside the parent's tenant context:
`registrationNo` only with `bus.plate`, `capacity` only with `bus.capacity`, images only with `bus.images`, documents
only when their validity (`visibleToParentsStatus` + `insurance_status`/`fitness_status` for those types) or file is
visible; it returns `null` for a bus that is not one of the parent's children's buses (RLS).

```json
{ "id": "…", "code": "R1", "displayName": "Route 1 Bus", "vehicleType": "bus", "makeModel": "Tata Starbus Ultra",
  "color": "Yellow", "capacity": null, "registrationNo": "KA01AB1201",
  "images": [{ "fileId": "…", "caption": "Front view", "url": "https://…signed…", "thumbnailUrl": "https://…signed…" }],
  "documents": [{ "docType": "insurance", "title": "Comprehensive policy", "expiryDate": "2026-11-02", "expiryStatus": "expiring", "fileId": null }] }
```

**Only current, verified documents reach parents.** A document that is `pending` or `rejected` — a new one, a
renewal waiting for verification, a reset verification — and every replaced version are left out of `documents`
entirely and their files are refused (the parent document has no verification field, so an unverified document is
never shown as "valid until …"). `expiryDate`/`expiryStatus` (and `fileId`, when allowed) always describe a verified
document. Admin previews of "what parents see" must apply the same rule: in `GET /school/buses/:id` documents, only
`isCurrent` + `verificationStatus: "verified"` ones count; the others are hidden from parents until verified.

## Demo data

Seed `30_buses` (`npm run seed`): for every demo school present, buses `R1`–`R6` with state plates (`KA01…`, `RJ14…`,
`TS09…`, `KL07…`), 4 documents each (insurance, fitness, pollution, permit — two expired and two expiring within 30
days per school, relative to the run date) and the school's drivers/conductors as primary driver/conductor of the
first active buses. Idempotent; no images are seeded.
