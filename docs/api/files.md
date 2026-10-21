# Files API

Contract §2 (Files), blueprint §12. Base `/api/v1`. Source: `backend/src/modules/files/`.

* Private bucket only (Linode Object Storage, shared → every key starts with `S3_KEY_PREFIX`). Keys:
  `whereismybus/schools/{school_id}/{category}/{entity_id}/{uuid}.{ext}` — never returned to clients.
* Mobile apps upload with a **presigned PUT**, then call `complete`. The web admin uploads **through the
  API** (multipart), so the shared bucket needs no CORS change.
* Downloads are always **presigned GETs valid 60–300 s**, issued after authorization.
* Content is validated by magic bytes (the declared type is never trusted), size and SHA-256.
  Shareable images (logos, bus/staff/student photos, documents, bills) are re-encoded **without
  EXIF/GPS**; odometer photos are kept **byte-for-byte** as evidence. Images get a WebP thumbnail.

## Categories

| Category | Entity types (first = default) | Upload roles | Types / max size |
|---|---|---|---|
| `school_logo` | `school` (entityId optional = own school) | school_admin | JPEG, PNG, WebP · 5 MB |
| `bus_image` | `bus` | school_admin | JPEG, PNG, WebP · 5 MB |
| `bus_document` | `bus` | school_admin | JPEG, PNG, WebP, PDF · 10 MB |
| `staff_photo` / `staff_document` | `staff` | school_admin | photo 5 MB / document 10 MB |
| `student_photo` | `student` | school_admin | JPEG, PNG, WebP · 5 MB |
| `odometer` | `trip`, `bus` | driver, conductor (assigned to that bus/trip), school_admin | JPEG, PNG, WebP, HEIC · 8 MB |
| `fuel_bill` / `maintenance_invoice` | `bus`, `fuel_log` / `bus`, `maintenance_log` | school_admin | 10 MB |
| `import` | `import` (optional) | school_admin | CSV, XLSX · 5 MB |
| `report` | — | generated server-side only | — |

The entity must exist in the caller's school (another school's id → `404`). Modules add rules with
`registerFileHooks(category, { authorizeUpload, authorizeRead, parentRead })`.

## `POST /files/upload-url` (mobile)

Roles: school_admin, driver, conductor. Optional `Idempotency-Key`.

```json
{
  "category": "odometer",
  "entityType": "trip",
  "entityId": "01a1…",
  "contentType": "image/jpeg",
  "sizeBytes": 482113,
  "fileName": "odometer-start.jpg",
  "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "metadata": { "capturedAt": "2026-10-19T07:29:58.000+05:30", "latitude": 12.9337, "longitude": 77.6227, "accuracyM": 8, "source": "camera" }
}
```
`201`:
```json
{
  "success": true,
  "data": {
    "file": { "id": "01a1…", "category": "odometer", "entityType": "trip", "entityId": "01a1…", "contentType": "image/jpeg", "sizeBytes": 482113,
              "sha256": null, "fileName": "odometer-start.jpg", "status": "pending", "hasThumbnail": false,
              "metadata": { "capture": { "capturedAt": "…", "latitude": 12.9337, "longitude": 77.6227, "accuracyM": 8, "source": "camera" } },
              "uploadedBy": "…", "createdAt": "…" },
    "upload": { "url": "https://…signed…", "method": "PUT", "headers": { "Content-Type": "image/jpeg" }, "expiresAt": "2026-10-19T02:05:00.000Z" }
  }
}
```
Then `PUT` the bytes to `upload.url` with exactly `upload.headers` (and the declared length) within 5 minutes.
The URL targets a private **staging** object that is never served: `complete` validates it, writes the
validated bytes to a new server-generated key and deletes the staging object, so replaying the URL after
`complete` cannot change the file (the local driver answers `409 INVALID_STATE` once the file is no longer
pending). Staging objects of uploads that are never completed are deleted by the hourly
`files-staging-cleanup` job once they are older than 24 hours (keys ending in `.part` under
`<S3_KEY_PREFIX>schools/`). Bucket-side alternative for operators: an S3 lifecycle rule on the
`<S3_KEY_PREFIX>schools/` prefix cannot filter by suffix, so either tag staging uploads and expire the tag
after 1 day, or keep this job (the portable default; it works on the shared Linode bucket without bucket
policy changes).
Errors: `403` category not allowed for the role / staff not assigned, `404` entity not in this school,
`415` content type not allowed for the category, `413` size above the category limit, `400` bad entity type.

## `POST /files/:id/complete`

```json
{ "sha256": "9f86d0…" }      // optional; the value given at upload-url is used otherwise
```
Verifies the object exists, sniffs the magic bytes, checks size and checksum, strips EXIF/creates the
thumbnail → `200` with the file (`status: "uploaded"`, `sha256`, `hasThumbnail`, `metadata.width/height`).
Idempotent once uploaded. Before the PUT: `409 INVALID_STATE`. Invalid content (`415`), size or checksum
mismatch (`400`) mark the file `rejected` and delete the object; request a new URL.
Only the uploader or a school admin can complete.

## `POST /files/upload` (web, multipart)

Roles: school_admin, driver, conductor. Optional `Idempotency-Key`.

```
curl -X POST /api/v1/files/upload -H "Authorization: Bearer …" \
  -F category=bus_image -F entityId=01a1… -F "file=@bus-front.jpg;type=image/jpeg"
```
Optional field `metadata` (JSON string, same shape as above). `201` with the file
(`status: "uploaded"`, `metadata.exifStripped: true` for re-encoded images).

## `GET /files/:id/url`

Query: `variant=original|thumbnail` (default original), `ttl=60..300` (default 120), `disposition=inline|attachment`.
Parents send `X-School-Id`.

```json
{ "success": true, "data": { "url": "https://…signed…", "expiresAt": "2026-10-19T02:02:00.000Z", "contentType": "image/jpeg", "fileName": "bus-front.jpg", "variant": "original" } }
```

Who may read (`404` otherwise — existence is never revealed):

| Principal | Files |
|---|---|
| school_admin | every uploaded file of the school |
| driver / conductor | files they uploaded, the school logo, plus grants from module hooks |
| parent | only what a category hook grants after applying the school's parent visibility (school logo built in; bus/staff hooks come from those modules); the `files` parent RLS policy is the backstop |
| super_admin | none (no school context) |

## Local storage driver (development and tests)

With `STORAGE_DRIVER=local`, signed URLs point at `PUT /api/v1/files/local/upload?token=…` and
`GET /api/v1/files/local/download?token=…` (HMAC-signed, short-lived tokens; disabled with S3).
